-- Stage-B crash recovery for stranded `processing` planned_invoices rows.
--
-- Prior gap (confirmed by direct audit, not assumed): neither the
-- 'scheduled' nor the 'parked' candidate queries in
-- app/api/admin/invoice-scheduler/route.ts ever select status='processing'
-- rows. A worker that claims a row (scheduled/parked -> processing) and
-- then crashes/times out before reaching the final 'sent' or 'failed'
-- write leaves that row permanently un-selectable by any existing
-- automated path — billing-writer.ts's stale-row cleanup only runs on an
-- explicit manual re-push, and the Remembill webhook's own
-- processing->sent reconciliation only fires once a real provider invoice
-- already exists. This affects ordinary scheduled rows and the new
-- event-gated one-time-fee claim path identically — fixed once, at the
-- Stage-B row-lifecycle layer, not per row-type.
--
-- Three new columns on planned_invoices:
--   processing_started_at  — set atomically in the SAME UPDATE that
--     performs a scheduled->processing or parked->processing transition
--     (never derived from the generic updated_at, which unrelated writes —
--     e.g. a VAT override — could otherwise bump, silently resetting the
--     lease's start time without execution having actually restarted).
--   processing_attempt_count — incremented atomically by
--     reclaim_stale_processing_row on every reclaim; caps how many times a
--     row can be automatically reclaimed before it's left for manual
--     review instead of retried forever.
--   execution_payload — the durable, immutable commercial instruction
--     (computed overage/credit line items + VAT figures) captured ONCE,
--     immediately after computation and BEFORE any provider call. A
--     reclaimed row with a non-null payload reuses it verbatim rather than
--     recomputing — closing the "meter data / credit balance / org policy
--     / contract / evidence / clock changed between attempts" drift risk
--     the recovery design must not reintroduce.
alter table planned_invoices add column if not exists processing_started_at timestamptz;
alter table planned_invoices add column if not exists processing_attempt_count integer not null default 0;
alter table planned_invoices add column if not exists execution_payload jsonb;

comment on column planned_invoices.processing_started_at is
  'When THIS execution lease began — set atomically by the claim/reclaim that transitioned the row into processing. Never inferred from updated_at.';
comment on column planned_invoices.processing_attempt_count is
  'Number of times this row has been claimed/reclaimed into processing. Capped by reclaim_stale_processing_row to avoid an indefinite auto-retry loop on a row that fails deterministically every time.';
comment on column planned_invoices.execution_payload is
  'The durable commercial instruction (overage/credit line items, VAT figures) computed once, before any provider call. A reclaimed stale-processing row with a non-null payload here MUST reuse it verbatim, never recompute.';

-- ── claim_parked_event_fee — revised to also set processing_started_at ───
-- Not yet applied to any database (introduced in the immediately prior,
-- still-unreviewed pass of this same feature), so revised in place rather
-- than layered with a second fix-up migration — same convention already
-- used elsewhere in this session (e.g. the OpenBillingWindowError
-- toISOString fix). Evidence-locking/atomic-amount-persistence behavior is
-- otherwise byte-for-byte unchanged from the previously approved version.
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
  v_evidence_id uuid;
  v_updated int;
begin
  select id, job_id, status, invoice_type, fee_id
    into v_row
    from public.planned_invoices
    where id = p_planned_invoice_id
    for update;

  if not found then
    return false;
  end if;

  if v_row.status <> 'parked'
     or v_row.invoice_type <> 'one_time'
     or v_row.fee_id is distinct from p_fee_id
  then
    return false;
  end if;

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

  -- Now ALSO stamps processing_started_at/processing_attempt_count in the
  -- same atomic write — this is the moment the execution lease begins.
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

-- ── reclaim_stale_processing_row — the atomic lease-refresh for recovery ─
--
-- Deliberately NOT a distributed lock and NOT pg_advisory_xact_lock — a
-- plain conditional UPDATE keyed on a column the UPDATE itself changes
-- (processing_started_at) is already safe under Postgres's own
-- EvalPlanQual re-check behavior for concurrently-updated rows (the same
-- mechanism that already makes the ordinary scheduled->processing
-- transition's plain UPDATE...WHERE status='scheduled' safe against two
-- racing workers, with no dedicated lock of any kind): a second worker's
-- UPDATE for the same row blocks on the row lock until the first commits,
-- then re-evaluates its own WHERE clause against the ALREADY-REFRESHED
-- processing_started_at — which is no longer <= p_stale_cutoff — and
-- matches zero rows. Implemented as a small function (rather than an ad
-- hoc client-side conditional update) only so processing_attempt_count can
-- be incremented with real SQL arithmetic (processing_attempt_count + 1)
-- inside the same atomic statement, instead of a separate, individually
-- non-atomic read-then-write from application code.
--
-- p_max_attempts: once processing_attempt_count would exceed this, the
-- function refuses to reclaim (returns false) even though the row is
-- genuinely stale — a row that fails this many independent, temporally-
-- spread reclaim cycles (each at least p_stale_cutoff's own interval
-- apart) is very unlikely to be a transient timeout.
--
-- Revised — exhaustion must be VISIBLE, not just "not reclaimed". A row
-- that would otherwise be left in 'processing' forever falls through
-- app/api/jobs/[id]/billing-summary/route.ts's own status mapping straight
-- to the generic 'draft' display (confirmed by audit — 'draft' is that
-- mapping's fallback for anything not paid/failed/open/sent), making it
-- indistinguishable from an ordinary not-yet-due row, with no error shown
-- anywhere. Rather than a boolean, this function now returns one of three
-- text outcomes, decided atomically under the SAME row lock so exhaustion
-- can never race with a concurrent reclaim attempt:
--   'reclaimed'  — lease refreshed (processing_started_at/attempt_count).
--   'exhausted'  — attempt cap already reached; the row is transitioned
--     directly to status='failed' with a real error_message, in the SAME
--     atomic statement — reusing the EXISTING failed-row review path
--     (BillingSummaryCard already renders error_message for
--     status='failed') rather than inventing a new lifecycle state.
--   'not_stale'  — no longer eligible (already reclaimed by another
--     worker, or a legitimate execution is still within its lease) — row
--     left completely untouched.
create or replace function reclaim_stale_processing_row(
  p_planned_invoice_id uuid,
  p_stale_cutoff timestamptz,
  p_max_attempts integer
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
begin
  select id, status, processing_started_at, processing_attempt_count
    into v_row
    from public.planned_invoices
    where id = p_planned_invoice_id
    for update;

  if not found
     or v_row.status <> 'processing'
     or v_row.processing_started_at is null
     or v_row.processing_started_at > p_stale_cutoff
  then
    return 'not_stale';
  end if;

  if v_row.processing_attempt_count >= p_max_attempts then
    update public.planned_invoices
      set status = 'failed',
          error_message = format(
            'Stage-B recovery attempt limit reached (%s attempts, first claimed %s) — stuck in processing without completing. Requires manual reconciliation before retry.',
            v_row.processing_attempt_count, v_row.processing_started_at
          )
      where id = p_planned_invoice_id;
    return 'exhausted';
  end if;

  update public.planned_invoices
    set processing_started_at = now(),
        processing_attempt_count = processing_attempt_count + 1
    where id = p_planned_invoice_id;

  return 'reclaimed';
end;
$$;

alter function reclaim_stale_processing_row(uuid, timestamptz, integer) owner to postgres;

revoke execute on function reclaim_stale_processing_row(uuid, timestamptz, integer) from public;
revoke execute on function reclaim_stale_processing_row(uuid, timestamptz, integer) from anon;
revoke execute on function reclaim_stale_processing_row(uuid, timestamptz, integer) from authenticated;
grant  execute on function reclaim_stale_processing_row(uuid, timestamptz, integer) to service_role;
