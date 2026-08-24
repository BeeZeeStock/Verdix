-- Contract B final pre-commit fix — closes a real TOCTOU race in the
-- event-gated parked one-time-fee lifecycle (Part A).
--
-- Prior sequence (app/api/admin/invoice-scheduler/route.ts): load parked
-- row -> load canonical fee -> load active evidence -> evaluate
-- eligible=true in application code -> conditional UPDATE parked ->
-- processing keyed only on status='parked'. Evidence could be revoked in
-- the window between the eligibility read and that UPDATE, and the stale
-- "eligible=true" result would still be trusted — the UPDATE's own
-- WHERE clause never re-checked evidence at all, only status.
--
-- This function makes the FINAL authorization to execute a single atomic
-- DB operation: it re-verifies row state AND evidence itself, inside one
-- transaction, immediately before performing the parked -> processing
-- transition — so there is no gap between "decided eligible" and "began
-- execution" for evidence to change in. It is the sole authorization,
-- deliberately not a second opinion alongside the application's own
-- pre-check.
--
-- Responsibility split (kept deliberately narrow — this function does not,
-- and must not, interpret contract meaning):
--   Application (lib/parked-one-time-fee-eligibility.ts) resolves: fee
--   identity (fee_id), billability_condition.kind = 'event', the required
--   event_type, and the canonical amount — then passes only the minimal
--   immutable facts needed for the claim: planned_invoice_id, fee_id,
--   event_type, executionAsOf, and the already-resolved canonical amount.
--   It also serves as a cheap pre-filter/diagnostic (skip
--   obviously-ineligible candidates without an RPC round trip), but its
--   result is NEVER trusted as authorization on its own.
--   SQL (this function) validates CURRENT row/evidence STATE only —
--   status, invoice_type, fee_id match, and evidence
--   active/subject/event_type/occurred_at — and performs the state
--   transition (including persisting the caller-supplied amount)
--   atomically with that validation. It never looks at
--   contract_terms/one_time_fees at all, and never computes the amount
--   itself.
--
-- Concurrency, TWO separate locks, one per race this closes:
--   1. planned_invoices row: `select ... for update` — a plain per-row
--      lock is sufficient (unlike reserve_credit_balance in
--      20260821000001_credit_ledger.sql, which needs pg_advisory_xact_lock
--      because it aggregates across MULTIPLE rows for one job+credit) —
--      this claim only ever touches the ONE row identified by
--      p_planned_invoice_id. Closes the "two scheduler workers claim the
--      same row" race: a concurrent second caller blocks until the first
--      transaction ends, then re-reads the row (by then already
--      'processing' if the first succeeded) and correctly fails the
--      status predicate.
--   2. the qualifying operational_event_evidence row itself: `select ...
--      for share` — closes a SEPARATE, narrower race this migration was
--      revised to fix: the planned_invoice lock alone does not stop the
--      MATCHING EVIDENCE ROW from being revoked concurrently, in the
--      window after this function reads it as active but before this
--      function's transaction commits. FOR SHARE is the correct, minimal
--      lock mode — verified against the ACTUAL revocation implementation
--      (app/api/jobs/[id]/operational-events/revoke/route.ts): revoke is
--      a plain `UPDATE operational_event_evidence SET status='revoked',
--      ... WHERE id = ... AND status = 'active'` that never touches
--      job_id/subject_id/event_type (the columns the partial unique index
--      covers), so Postgres internally acquires a FOR NO KEY UPDATE lock
--      for it — and FOR NO KEY UPDATE conflicts with FOR SHARE (per
--      Postgres's row-lock conflict table), so a concurrent revoke
--      genuinely blocks on this function's FOR SHARE hold. (The only
--      DELETE against this table anywhere in the codebase is test-cleanup
--      code in lib/operational-event-evidence-rls.test.ts, never a real
--      application code path — FOR SHARE would not need to be strengthened
--      for that, since a DELETE also requires the equivalent of FOR NO KEY
--      UPDATE and conflicts with FOR SHARE identically.) This gives the
--      exact enforceable boundary requested: revoke committed before this
--      SELECT ... FOR SHARE runs -> the row's status is already 'revoked'
--      -> WHERE clause excludes it -> claim false. Revoke attempted while
--      this function holds the FOR SHARE lock -> revoke's UPDATE blocks
--      until this transaction commits or rolls back -> if this claim
--      commits, the revoke proceeds only AFTER execution has formally
--      begun (exactly the intended semantics — not aborted, per explicit
--      instruction not to build distributed locking between evidence and
--      Stripe). If this function instead blocks WAITING for an
--      in-flight revoke's own FOR NO KEY UPDATE to release first, Postgres
--      re-checks this SELECT's WHERE clause against the post-commit row
--      once unblocked (standard READ COMMITTED locking-read semantics) —
--      so a revoke that commits WHILE this function was waiting on it is
--      still correctly seen and excludes the row, never silently missed.
--   The existing per-row provider idempotency key
--   (app/api/admin/invoice-scheduler/route.ts's Stripe/Remembill calls)
--   remains the independent, additional layer of protection, unchanged.
--
-- Boundary this establishes: a successful atomic claim IS the defined
-- start of execution. Evidence revoked before the claim (in either the
-- "already committed" or "blocks-then-wins" sense above) -> claim returns
-- false -> row stays parked, zero provider mutation. Evidence revoked
-- after a successful claim (the revoke's UPDATE was blocked and only
-- proceeds once this transaction commits) -> execution has already begun
-- (the row is no longer 'parked') -> not aborted; this function is never
-- called again to "undo" a claim, by design.
--
-- Predicate coverage (SQL invariants; see lib/parked-one-time-fee-
-- eligibility.test.ts's race-shape test for the equivalent application-
-- layer proof — this repo has no DB-integration-test harness for RPC
-- semantics/row-lock concurrency, same gap already disclosed for
-- reserve_credit_balance/lib/usage-pull.test.ts, so these are documented
-- here rather than independently exercised against a live database):
--   no evidence                -> no row found by the locking select    -> false
--   revoked evidence           -> status <> 'active' excluded           -> false
--   wrong fee_id (evidence)    -> subject_id <> p_fee_id                -> false
--   wrong event_type           -> event_type <> p_event_type            -> false
--   future occurred_at         -> occurred_at > p_execution_as_of       -> false
--   inactive evidence          -> (same as revoked) status <> 'active'  -> false
--   row already processing     -> v_row.status <> 'parked'              -> false
--   row already sent           -> v_row.status <> 'parked'              -> false
--   null fee_id on the row     -> fee_id IS DISTINCT FROM p_fee_id      -> false
--   non-event parked row       -> never assigned a fee_id at insert
--                                  time (lib/billing-writer.ts) -> same
--                                  as null fee_id above                 -> false
--   row not found               -> not found after the planned_invoice
--                                   lock select                         -> false
--   concurrent revoke racing
--   the evidence lock            -> see the FOR SHARE discussion above  -> false
--                                    (if it commits first) or execution
--                                    already begun (if the claim wins)
drop function if exists claim_parked_event_fee(uuid, text, text, timestamptz);

create function claim_parked_event_fee(
  p_planned_invoice_id uuid,
  p_fee_id text,
  p_event_type text,
  p_execution_as_of timestamptz,
  p_amount numeric
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_evidence_id uuid;
  v_updated int;
begin
  -- Lock 1 — the planned_invoice row.
  select id, job_id, status, invoice_type, fee_id
    into v_row
    from public.planned_invoices
    where id = p_planned_invoice_id
    for update;

  if not found then
    return false;
  end if;

  -- Row-state predicates.
  if v_row.status <> 'parked'
     or v_row.invoice_type <> 'one_time'
     or v_row.fee_id is distinct from p_fee_id
  then
    return false;
  end if;

  -- Lock 2 — the qualifying evidence row itself, evaluated fresh, inside
  -- the SAME transaction that holds the planned_invoice lock: active,
  -- correct subject (fee_id) + event_type, not revoked, not future-dated
  -- relative to the caller's own execution timestamp. FOR SHARE (see the
  -- header comment for why this is the correct, verified-conflicting lock
  -- mode) — held until this transaction ends, so a concurrent revoke
  -- cannot slip in between this check and the transition below.
  -- Deterministic selection (occurred_at desc, id asc) mirrors
  -- lib/operational-event-evidence.ts's resolveOperationalEventEvidence
  -- "most recent occurrence wins" convention — defensive only, since the
  -- partial unique index on (job_id, subject_id, event_type) WHERE
  -- status='active' means more than one qualifying active row should
  -- never actually coexist.
  select id into v_evidence_id
    from public.operational_event_evidence
    where job_id = v_row.job_id
      and subject_id = p_fee_id
      and event_type = p_event_type
      and status = 'active'
      and occurred_at <= p_execution_as_of
    order by occurred_at desc, id asc
    limit 1
    for share;

  if not found then
    return false;
  end if;

  -- Every predicate held, and the evidence row is locked against
  -- concurrent revocation for the remainder of this transaction — this
  -- UPDATE is the atomic claim itself, persisting BOTH the state
  -- transition and the caller-resolved canonical amount together, so the
  -- persisted row can never end up disagreeing with the monetary
  -- instruction actually authorized. currency is left untouched — already
  -- canonical on the row, out of scope here.
  update public.planned_invoices
    set status = 'processing', base_amount = p_amount
    where id = p_planned_invoice_id and status = 'parked';
  get diagnostics v_updated = row_count;

  return v_updated > 0;
end;
$$;

alter function claim_parked_event_fee(uuid, text, text, timestamptz, numeric) owner to postgres;

revoke execute on function claim_parked_event_fee(uuid, text, text, timestamptz, numeric) from public;
revoke execute on function claim_parked_event_fee(uuid, text, text, timestamptz, numeric) from anon;
revoke execute on function claim_parked_event_fee(uuid, text, text, timestamptz, numeric) from authenticated;
grant  execute on function claim_parked_event_fee(uuid, text, text, timestamptz, numeric) to service_role;
