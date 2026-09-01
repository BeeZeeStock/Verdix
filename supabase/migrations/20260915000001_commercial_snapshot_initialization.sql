-- Step 17H.4B0D4H1B4E3.1 — Initial Commercial Snapshot Bootstrap.
--
-- Root cause being fixed: execute/route.ts unconditionally ran the Model B+
-- reconciliation orchestration (lib/current-line-item-reconciliation-plan.ts
-- + lib/current-line-item-reconciliation-orchestration.ts) even on a job's
-- very FIRST extraction, when current_line_items is genuinely empty. The
-- planner's weak-identity-family doctrine (recurring_base_fee, escalator,
-- additional_recurring_fixed, additional_recurring_variable) treats ANY
-- one-sided residual — including "every fresh item, because nothing existed
-- to reconcile against yet" — as unknown_identity, which
-- computeReconciliationHoldTransition then always turns into
-- billing_hold: reconciliation_blocked, a hold with NO resolving action
-- anywhere in the product (evaluateBillingGate rejects every operation,
-- approve included). This is a real, reproducible deadlock for any fresh
-- contract containing a weak-identity fee (a plain recurring base fee, a
-- flat per-unit usage fee) — proven live against a real extraction in the
-- E3 acceptance pass (jobs c5383ef1-b423-4f99-8dbe-f7faee00ea54,
-- 56f744c4-1722-4a99-a019-bde29164f72c).
--
-- Fix: distinguish INITIAL COMMERCIAL SNAPSHOT (no prior authoritative
-- snapshot exists — weak identity is not itself a blocker, there is nothing
-- to reconcile against) from RECONCILIATION (a prior snapshot exists — the
-- full frozen Model B+ doctrine above applies unchanged). This migration
-- adds the durable, permanent marker that distinguishes the two
-- (commercial_snapshot_initialized_at) and a dedicated, minimal RPC that
-- performs the initial write. It does NOT modify
-- apply_current_line_item_reconciliation (20260913000001) or
-- begin_job_reexecution/replace_billing_hold_if_unchanged (20260914000001)
-- at all — every existing Model B+ code path, and every existing test
-- against it, is untouched by this file.
--
-- Why a marker column, not an inferred signal (17H.4B0D4H1B4E3.1 §4):
-- current_line_items being empty is genuinely ambiguous — it is the
-- observable state for a real first extraction, but ALSO for a job whose
-- earlier initialization attempt crashed after clearing rows some other
-- way, or (hypothetically) a job whose entire current set was later
-- superseded down to zero through ordinary reconciliation. execute_status,
-- the mere existence of a contract_terms row, and billing_customer_id are
-- each ambiguous for the same reason (any of them can be true after a
-- partial failure, or answer a related-but-different question — see this
-- migration's own header comment on establish_initial_commercial_snapshot
-- below). A dedicated, permanent, one-way marker is the smallest thing that
-- is unambiguous by construction: once set, it is never cleared by any code
-- path in this migration or any other, so a later empty current-row read
-- can never be mistaken for "never initialized" again.
--
-- Written but NOT applied this session — same discipline every migration in
-- this project has followed; verified post-application via the service-role
-- client, per this repository's own established pattern.

alter table jobs
  add column if not exists commercial_snapshot_initialized_at timestamptz null;

comment on column jobs.commercial_snapshot_initialized_at is
  'Set exactly once, by establish_initial_commercial_snapshot(), the moment this job''s FIRST authoritative current_line_items population is durably written. NULL forever means "no initial commercial snapshot has ever been established" — this is the sole authority initialization eligibility is decided against (17H.4B0D4H1B4E3.1 §4/§5), never current_line_items emptiness, execute_status, contract_terms existence, or billing_customer_id (each independently ambiguous). Never cleared once set — a later empty current_line_items read (e.g. every row eventually superseded through ordinary reconciliation) must never re-open initialization mode for this job (§16/§17).';

-- ─────────────────────────────────────────────────────────────────────────
-- establish_initial_commercial_snapshot — the ONE write path for a job's
-- first-ever current commercial line-item population. Deliberately a new,
-- separate function rather than an added mode on
-- apply_current_line_item_reconciliation: initialization has no current
-- rows to compare a caller's expected snapshot against (there is nothing to
-- reconcile), so the bulk of that function's logic (update handling,
-- supersede handling, full-population CAS comparison) simply does not apply
-- here — reusing it would mean passing empty updates/supersedes/expected-
-- rows through machinery built for a different problem. This keeps
-- apply_current_line_item_reconciliation, and every one of its existing
-- callers/tests, completely untouched (Model B+ stays frozen, per §16).
--
-- Concurrency-safe by construction, matching the SAME advisory-lock
-- convention apply_current_line_item_reconciliation already uses (same key
-- format, 'current_line_item_reconciliation|' || job_id) — this is
-- deliberate: it means a concurrent NORMAL reconciliation attempt for the
-- same job (e.g. confirm-rule racing this initialization) is also
-- serialized against it, not just concurrent initialization attempts
-- against each other. Two concurrent calls to THIS function for the same
-- job: both block on the same lock; the first to acquire it re-checks (a)
-- the marker is still NULL and (b) line_items is still genuinely empty,
-- both under the lock, then inserts and sets the marker before releasing;
-- the second, once it acquires the lock, observes the marker is no longer
-- NULL and returns already_initialized without writing anything — never a
-- duplicate initial snapshot (§13).
--
-- Crash safety (§12): if this function's transaction fails or is
-- interrupted at ANY point — before the insert, mid-insert, or between the
-- insert and the marker UPDATE — the whole transaction rolls back as one
-- unit (this is a single plpgsql function body, hence a single implicit
-- transaction; Postgres guarantees all-or-nothing). There is no
-- intermediate state where line_items were inserted but the marker wasn't
-- set, or vice versa — a retry after any such failure always observes
-- EITHER "nothing happened" (marker NULL, no rows — eligible again) OR
-- "fully committed" (marker set, rows present — already_initialized, falls
-- through to normal Model B+). This is what makes "prove uninitialized +
-- prove expected state + write initial rows + mark initialized" one
-- logically atomic operation (§11) without needing any application-level
-- two-phase bookkeeping.
create or replace function establish_initial_commercial_snapshot(
  p_job_id uuid,
  p_inserts jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_marker timestamptz;
  v_any_line_item_exists boolean;
  v_row jsonb;
  v_now timestamptz := now();
  v_inserted_count int := 0;
  v_fee_ids text[] := '{}';
  v_tier_ids text[] := '{}';
  v_distinct_fee_ids text[];
  v_distinct_tier_ids text[];
begin
  if p_job_id is null then
    return jsonb_build_object('status', 'invalid_plan', 'reason', 'missing_job_id');
  end if;
  if p_inserts is null or jsonb_typeof(p_inserts) <> 'array' then
    return jsonb_build_object('status', 'invalid_plan', 'reason', 'inserts_not_array');
  end if;

  -- ── §7 (payload half) — intrinsic self-consistency of the fresh batch
  -- itself, before any DB access: shape/required-field validation
  -- (mirrors apply_current_line_item_reconciliation's own insert-branch
  -- validation exactly, 20260913000001 lines ~311-348) plus a check that
  -- one insert batch, all pairs, are still ordinary. duplicate.
  for v_row in select * from jsonb_array_elements(p_inserts) loop
    if v_row ? 'id' or v_row ? 'job_id' or v_row ? 'created_at' or v_row ? 'superseded_at' then
      return jsonb_build_object('status', 'invalid_plan', 'reason', 'insert_forbidden_key');
    end if;
    if not (v_row ? 'product_name') or jsonb_typeof(v_row->'product_name') <> 'string' then
      return jsonb_build_object('status', 'invalid_plan', 'reason', 'insert_missing_product_name');
    end if;
    if not (v_row ? 'quantity') or jsonb_typeof(v_row->'quantity') <> 'number' then
      return jsonb_build_object('status', 'invalid_plan', 'reason', 'insert_missing_quantity');
    end if;
    if not (v_row ? 'unit_price') or jsonb_typeof(v_row->'unit_price') <> 'number' then
      return jsonb_build_object('status', 'invalid_plan', 'reason', 'insert_missing_unit_price');
    end if;
    if not (v_row ? 'billing_period') or jsonb_typeof(v_row->'billing_period') <> 'string' then
      return jsonb_build_object('status', 'invalid_plan', 'reason', 'insert_missing_billing_period');
    end if;
    if not (v_row ? 'total_amount') or jsonb_typeof(v_row->'total_amount') <> 'number' then
      return jsonb_build_object('status', 'invalid_plan', 'reason', 'insert_missing_total_amount');
    end if;
    if not (v_row ? 'currency') or jsonb_typeof(v_row->'currency') <> 'string' then
      return jsonb_build_object('status', 'invalid_plan', 'reason', 'insert_missing_currency');
    end if;
    if not (v_row ? 'confidence_score') or jsonb_typeof(v_row->'confidence_score') <> 'number' then
      return jsonb_build_object('status', 'invalid_plan', 'reason', 'insert_missing_confidence_score');
    end if;
    if (v_row->>'fee_id') is not null and (v_row->>'tier_id') is not null then
      return jsonb_build_object('status', 'invalid_plan', 'reason', 'insert_fee_id_and_tier_id_both_present');
    end if;
    if (v_row->>'fee_id') is not null then
      v_fee_ids := array_append(v_fee_ids, v_row->>'fee_id');
    end if;
    if (v_row->>'tier_id') is not null then
      v_tier_ids := array_append(v_tier_ids, v_row->>'tier_id');
    end if;
  end loop;

  -- Duplicate stable identity WITHIN one initial batch is a genuine
  -- structural-identity defect (§7 — "malformed structural identity"),
  -- never silently accepted just because there is no prior state to
  -- collide with yet.
  select array_agg(distinct x) into v_distinct_fee_ids from unnest(v_fee_ids) as x;
  if coalesce(array_length(v_fee_ids, 1), 0) <> coalesce(array_length(v_distinct_fee_ids, 1), 0) then
    return jsonb_build_object('status', 'invalid_plan', 'reason', 'duplicate_fee_id_in_initial_batch');
  end if;
  select array_agg(distinct x) into v_distinct_tier_ids from unnest(v_tier_ids) as x;
  if coalesce(array_length(v_tier_ids, 1), 0) <> coalesce(array_length(v_distinct_tier_ids, 1), 0) then
    return jsonb_build_object('status', 'invalid_plan', 'reason', 'duplicate_tier_id_in_initial_batch');
  end if;

  -- Same lock domain as apply_current_line_item_reconciliation (identical
  -- key derivation) — see the function-level comment above for why.
  perform pg_advisory_xact_lock(hashtextextended('current_line_item_reconciliation|' || p_job_id::text, 0));

  select commercial_snapshot_initialized_at into v_marker
    from public.jobs where id = p_job_id for update;
  if not found then
    return jsonb_build_object('status', 'invalid_plan', 'reason', 'job_not_found');
  end if;
  if v_marker is not null then
    return jsonb_build_object('status', 'already_initialized', 'initialized_at', to_jsonb(v_marker));
  end if;

  -- ── §5 — fail closed on contradictory operational evidence. The marker
  -- being NULL only means "never durably completed an initialization";
  -- ANY existing line_items row (current OR superseded — no
  -- superseded_at filter here, deliberately) for this job is proof some
  -- prior write already happened outside this function's own commit
  -- (a legacy/pre-marker job, or a genuinely ambiguous partial history) —
  -- this function must never insert a second, competing "initial" batch
  -- on top of it. The caller (lib/initial-commercial-snapshot.ts) is
  -- expected to have already checked this and other evidence (planned_
  -- invoices, billing_customer_id) before ever calling this RPC — this
  -- check is the last-line, DB-transactional backstop, not the only one.
  select exists(select 1 from public.line_items where job_id = p_job_id) into v_any_line_item_exists;
  if v_any_line_item_exists then
    return jsonb_build_object('status', 'not_eligible', 'reason', 'existing_line_items_present');
  end if;

  for v_row in select * from jsonb_array_elements(p_inserts) loop
    insert into public.line_items (
      job_id, product_name, quantity, unit_price, billing_period, total_amount,
      currency, confidence_score, source_section, fee_id, tier_id,
      reviewer_corrected_fields, reviewer_corrected_fields_complete, reviewer_corrected_at,
      superseded_at
    ) values (
      p_job_id,
      v_row->>'product_name',
      (v_row->>'quantity')::numeric,
      (v_row->>'unit_price')::numeric,
      v_row->>'billing_period',
      (v_row->>'total_amount')::numeric,
      v_row->>'currency',
      (v_row->>'confidence_score')::numeric,
      v_row->>'source_section',
      v_row->>'fee_id',
      v_row->>'tier_id',
      '{}'::text[], true, null,
      null
    );
    v_inserted_count := v_inserted_count + 1;
  end loop;

  update public.jobs set commercial_snapshot_initialized_at = v_now where id = p_job_id;

  return jsonb_build_object('status', 'applied', 'inserted_count', v_inserted_count, 'initialized_at', to_jsonb(v_now));
end;
$$;

revoke execute on function establish_initial_commercial_snapshot(uuid, jsonb) from public;
revoke execute on function establish_initial_commercial_snapshot(uuid, jsonb) from anon;
revoke execute on function establish_initial_commercial_snapshot(uuid, jsonb) from authenticated;
grant  execute on function establish_initial_commercial_snapshot(uuid, jsonb) to service_role;

comment on function establish_initial_commercial_snapshot(uuid, jsonb) is
  'The one write path for a job''s first-ever current commercial line-item snapshot (17H.4B0D4H1B4E3.1). Atomically: takes the same advisory lock apply_current_line_item_reconciliation uses for this job, re-verifies commercial_snapshot_initialized_at is still NULL and line_items is still genuinely empty (both under the lock), inserts every row in p_inserts with D2 frozen reviewer state, and sets commercial_snapshot_initialized_at — all in one transaction, so a crash or a concurrent second call can never produce a duplicate initial snapshot or a marker/rows mismatch. Returns {status: applied|already_initialized|not_eligible|invalid_plan}. Does not touch or supersede any existing row — an existing_line_items_present result means this job is not a genuine first extraction and the caller must fall back to normal Model B+ reconciliation instead.';
