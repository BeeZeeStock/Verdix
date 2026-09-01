-- Step 17H.4B0D4H1A — Model B+ billing-safety foundation.
--
-- jobs.billing_hold is the durable, server-side-enforced signal that
-- commercial configuration is temporarily unsafe for NEW billing activity —
-- distinct from execute_status, which is proven (17H.4B0D4H0.2's audit)
-- NOT a safe billing gate: PENDING_HUMAN_REVIEW is already an approvable
-- state today (approve/route.ts's own claimForApproval tries it first),
-- and nothing about execute_status is checked by the scheduler, rebuild-
-- schedule, manual-invoice, or parked-invoices at all. This migration adds
-- ONLY the schema and the two claim RPCs; it does NOT wire execute to ever
-- set a hold (that is explicit, later Model B+ execute-integration work) —
-- so in ordinary production behavior, no job ever has a non-null
-- billing_hold after this migration applies, and nothing here changes
-- observable behavior until that later wiring lands.
--
-- Step 17H.4B0D4H1A.1 — amended in place (not layered with a second fix-up
-- migration, the same convention 20260829000001 itself already used) to
-- add clear_billing_hold_if_unchanged, closing a lost-hold race in the two
-- hold-resolving routes (approve, rebuild-schedule): a long-running
-- operation must never blindly clear billing_hold if a NEWER hold (e.g. a
-- future H1B re-execution's own hold-set) replaced the one this operation
-- was authorized under while it was still running. Reconfirmed live,
-- read-only, before amending rather than layering: this migration has not
-- been applied to any shared/remote environment (jobs.billing_hold and
-- claim_scheduled_invoice both confirmed absent from the live schema at
-- the time of this amendment) — amending is safe.
--
-- Written but NOT applied this session — verified by reading this file
-- only, same discipline every migration in this project has followed.

alter table jobs add column if not exists billing_hold jsonb null;

comment on column jobs.billing_hold is
  'NULL = billing unrestricted by this mechanism. Non-NULL = commercial configuration is temporarily unsafe for NEW billing activity — reason in {reexecution, reconciliation_blocked, schedule_rebuild_required} (see lib/billing-hold.ts for the canonical type/parser). Checked server-side by: the scheduled-invoice and parked-event-fee atomic claim RPCs (jobs-row FOR SHARE, see claim_scheduled_invoice/claim_parked_event_fee below), and by approve/rebuild-schedule/manual-invoice/parked-invoices route gates (lib/billing-hold.ts''s canApproveOrRebuild/canPerformMonetaryAction). Never set by this migration — no row is ever non-NULL as a result of applying it. reexecution/reconciliation_blocked always block every gated operation; schedule_rebuild_required blocks new monetary actions but allows approve/rebuild-schedule to proceed as the hold-RESOLVING operation.';

-- ─────────────────────────────────────────────────────────────────────────
-- claim_scheduled_invoice — the new atomic claim for the ordinary
-- 'scheduled' -> 'processing' transition, replacing the plain TypeScript
-- conditional UPDATE previously in app/api/admin/invoice-scheduler/
-- route.ts (`.update({status:'processing',...}).eq('status','scheduled')`).
-- That conditional UPDATE was already safe against two scheduler workers
-- racing each other (Postgres's own row-lock semantics on the WHERE
-- clause) — but had no way to observe jobs.billing_hold atomically with
-- the claim, since it lived in application code with no transaction
-- spanning both tables. This function closes that gap the same way
-- claim_parked_event_fee (20260828000001/20260829000001) already closed
-- the evidence-revocation race for the parked path: make the FULL decision
-- — row eligibility AND hold state — one atomic DB operation.
--
-- Lock ordering (frozen, must match claim_parked_event_fee's own, and any
-- future scheduler claim function must never invert it):
--   1. planned_invoices row — SELECT ... FOR UPDATE.
--   2. jobs row — SELECT billing_hold ... FOR SHARE.
--   3. (claim_parked_event_fee only) the qualifying evidence row — FOR SHARE.
--   4. the state-transition UPDATE itself.
--
-- Why FOR SHARE on the jobs row, not a plain SELECT (this is the one
-- load-bearing correctness detail in this whole migration, worth spelling
-- out in full): a plain, unlocked `SELECT billing_hold FROM jobs WHERE
-- id = ?` only proves the hold was absent AT THE INSTANT of that read.
-- Nothing stops a concurrent `UPDATE jobs SET billing_hold = ...`
-- (execute's own future hold-set write) from committing in the window
-- between that read and this function's own final UPDATE — the read would
-- already be stale by the time it matters, and the final UPDATE's WHERE
-- clause never re-checks the hold. FOR SHARE turns the read into a real
-- row lock, held for the remainder of THIS transaction:
--   - if this claim's FOR SHARE acquires first, execute's later
--     `UPDATE jobs SET billing_hold = ...` (which requires the equivalent
--     of a FOR NO KEY UPDATE lock on that same jobs row) blocks until this
--     transaction commits or rolls back. This claim proceeds to its final
--     UPDATE and commits under the hold state it already observed
--     (NULL) — genuinely correct, not a race: the claim's authoritative
--     decision was made and committed strictly BEFORE the hold could ever
--     exist, so the row is legitimately already in flight by the time the
--     hold is established (mirrors "already-processing rows continue to
--     completion, never rolled back" — this is the same principle one
--     step earlier).
--   - if execute's `UPDATE jobs SET billing_hold = ...` acquires its lock
--     on the jobs row first (whether it already committed, or is still an
--     open transaction), this claim's own FOR SHARE either sees the
--     already-committed non-null hold directly, or blocks until execute's
--     transaction ends and then re-evaluates against the now-committed
--     value — either way, this claim correctly observes the hold and
--     returns false, claiming nothing.
-- No advisory lock, no long-held lock across extraction — the jobs-row
-- lock is acquired and released entirely within this one short function
-- call, exactly like every other lock in this file.
create function claim_scheduled_invoice(
  p_planned_invoice_id uuid
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_hold jsonb;
  v_updated int;
begin
  -- Lock 1 — the planned_invoice row.
  select id, job_id, status
    into v_row
    from public.planned_invoices
    where id = p_planned_invoice_id
    for update;

  if not found or v_row.status <> 'scheduled' then
    return false;
  end if;

  -- Lock 2 — the jobs row, FOR SHARE (see the header comment above for the
  -- exact race this closes). Held until this transaction ends.
  select billing_hold into v_hold
    from public.jobs
    where id = v_row.job_id
    for share;

  if v_hold is not null then
    return false;
  end if;

  -- Every predicate held, and the jobs row is locked against a concurrent
  -- hold-set for the remainder of this transaction — this UPDATE is the
  -- atomic claim itself. processing_attempt_count starts at 1 here,
  -- mirroring claim_parked_event_fee's own convention for a first claim
  -- (reclaim_stale_processing_row is what increments it further on retry).
  update public.planned_invoices
    set status = 'processing', processing_started_at = now(), processing_attempt_count = 1
    where id = p_planned_invoice_id and status = 'scheduled';
  get diagnostics v_updated = row_count;

  return v_updated > 0;
end;
$$;

alter function claim_scheduled_invoice(uuid) owner to postgres;

revoke execute on function claim_scheduled_invoice(uuid) from public;
revoke execute on function claim_scheduled_invoice(uuid) from anon;
revoke execute on function claim_scheduled_invoice(uuid) from authenticated;
grant  execute on function claim_scheduled_invoice(uuid) to service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- claim_parked_event_fee — revised in place (not layered with a second
-- fix-up migration, same convention 20260829000001 itself already used)
-- to become billing_hold-aware. Every existing check (row-state
-- predicates, evidence FOR SHARE re-verification, atomic amount
-- persistence) is byte-for-byte unchanged; the ONLY addition is the
-- jobs-row FOR SHARE hold check, inserted immediately after the planned-
-- invoice row's job_id is known (end of Lock 1) and BEFORE the evidence
-- lock — matching the frozen lock ordering above (planned_invoice -> job
-- -> evidence -> processing). Reusing the exact same FOR SHARE mechanism
-- and reasoning as claim_scheduled_invoice's own header comment — not
-- duplicated here in full, see that function's comment for the complete
-- race analysis.
drop function if exists claim_parked_event_fee(uuid, text, text, timestamptz, numeric);

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
  v_hold jsonb;
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

  -- Lock 2 — the jobs row, FOR SHARE. See claim_scheduled_invoice's own
  -- header comment for the full race this closes; identical mechanism,
  -- applied here before evidence is even consulted, since a held job must
  -- never reach the evidence check at all.
  select billing_hold into v_hold
    from public.jobs
    where id = v_row.job_id
    for share;

  if v_hold is not null then
    return false;
  end if;

  -- Lock 3 — the qualifying evidence row itself, evaluated fresh, inside
  -- the SAME transaction that holds both the planned_invoice and jobs
  -- locks: active, correct subject (fee_id) + event_type, not revoked, not
  -- future-dated relative to the caller's own execution timestamp. FOR
  -- SHARE (unchanged from the original migration's own verified reasoning)
  -- — held until this transaction ends, so a concurrent revoke cannot slip
  -- in between this check and the transition below.
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

  -- Every predicate held, and both the jobs row and the evidence row are
  -- locked against concurrent change for the remainder of this
  -- transaction — this UPDATE is the atomic claim itself, persisting the
  -- state transition, the caller-resolved canonical amount, and the
  -- processing lease start together, unchanged from the prior revision.
  update public.planned_invoices
    set status = 'processing', base_amount = p_amount,
        processing_started_at = now(), processing_attempt_count = 1
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

-- reclaim_stale_processing_row is DELIBERATELY left untouched — no
-- billing_hold check is added there. Doctrine (17H.4B0D4H0.3 §18/§23,
-- §25 of the same report): a row already in 'processing' before a hold
-- was established is already in flight and must be allowed to resume/
-- retry to its natural completion, never rolled back or blocked by a
-- hold that postdates its own claim. reclaim_stale_processing_row's own
-- precondition (`v_row.status <> 'processing'` -> 'not_stale') already
-- structurally prevents it from ever being used to claim NEW
-- ('scheduled'/'parked') work — it can only ever resume an attempt that
-- was already, separately, legitimately authorized by one of the two
-- claim functions above.

-- ─────────────────────────────────────────────────────────────────────────
-- clear_billing_hold_if_unchanged — Step 17H.4B0D4H1A.1. The single
-- compare-and-clear primitive both hold-resolving routes (approve,
-- rebuild-schedule) use to release a billing_hold, replacing the plain
-- blind `UPDATE jobs SET billing_hold = null` H1A originally shipped.
--
-- The race this closes: a long-running rebuild/approve request captures
-- jobs.billing_hold at REQUEST START (its own "the hold I was authorized
-- to resolve"). If, before that request's own configureBilling call
-- finishes, a DIFFERENT process (most notably a future H1B execute
-- re-execution) replaces the hold — e.g. schedule_rebuild_required ->
-- reexecution, because fresh commercial terms now exist and haven't been
-- reconciled yet — the ORIGINAL request must never blindly overwrite that
-- NEWER hold back to null. A blind clear at that point would silently
-- re-open every billing_hold-gated action while genuinely unsafe,
-- unreconciled commercial state exists — exactly the failure mode the
-- whole billing_hold mechanism was built to prevent.
--
-- Deliberately narrow, not a generic "clear whatever" primitive: this
-- function ONLY EVER authorizes clearing a hold whose EXPECTED reason
-- (as supplied by the caller) is 'schedule_rebuild_required' — the one
-- reason approve/rebuild-schedule actually resolve. Callers must never be
-- able to use this to clear a reexecution/reconciliation_blocked hold,
-- even by accident.
--
-- Comparison and clear are ONE atomic DB mutation (`UPDATE ... WHERE
-- billing_hold IS NOT DISTINCT FROM p_expected_hold`), never a separate
-- SELECT-then-compare-then-UPDATE from application code — the latter would
-- simply relocate the exact same lost-update race one layer up. Postgres
-- JSONB equality (via IS NOT DISTINCT FROM, which also correctly handles
-- the "persisted value is itself NULL" case as a non-match rather than an
-- error) is a full structural comparison of the parsed value — key order/
-- whitespace-independent, but every actual key/value (including
-- started_at and the full blockers array) must match exactly. A newer
-- hold sharing the same reason string but a different started_at, or a
-- changed blockers payload, is correctly treated as a DIFFERENT hold
-- generation and is NEVER cleared by a stale caller's expectation of the
-- old one — reason-string-only comparison
-- (`billing_hold->>'reason' = 'schedule_rebuild_required'`) is explicitly
-- insufficient and never used.
create function clear_billing_hold_if_unchanged(
  p_job_id uuid,
  p_expected_hold jsonb
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated int;
begin
  -- Refuse outright unless the CALLER's own expectation is itself a
  -- well-formed, resolvable hold — never trust a null/malformed
  -- expectation into accidentally matching (IS NOT DISTINCT FROM would
  -- otherwise happily match a persisted NULL against an expected NULL,
  -- which must never be treated as "there was a schedule_rebuild_required
  -- hold to resolve").
  if p_expected_hold is null or jsonb_typeof(p_expected_hold) <> 'object' then
    return false;
  end if;
  if (p_expected_hold->>'reason') is distinct from 'schedule_rebuild_required' then
    return false;
  end if;

  -- The single atomic mutation — compare-and-clear, evaluated entirely at
  -- UPDATE time against whatever is CURRENTLY persisted, never a value
  -- read moments earlier in a separate statement.
  update public.jobs
    set billing_hold = null
    where id = p_job_id
      and billing_hold is not distinct from p_expected_hold;
  get diagnostics v_updated = row_count;

  return v_updated > 0;
end;
$$;

alter function clear_billing_hold_if_unchanged(uuid, jsonb) owner to postgres;

revoke execute on function clear_billing_hold_if_unchanged(uuid, jsonb) from public;
revoke execute on function clear_billing_hold_if_unchanged(uuid, jsonb) from anon;
revoke execute on function clear_billing_hold_if_unchanged(uuid, jsonb) from authenticated;
grant  execute on function clear_billing_hold_if_unchanged(uuid, jsonb) to service_role;

notify pgrst, 'reload schema';
