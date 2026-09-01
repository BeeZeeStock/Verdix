-- Step 17H.4B0D4H1B4E3.5 — real live-reproduced bug: establish_initial_
-- commercial_snapshot (20260915000001) predates recurring_fee_id
-- (introduced later, 20260916000001) and never carried it through its own
-- INSERT — meaning a job's VERY FIRST extraction (which always goes
-- through this RPC, not apply_current_line_item_reconciliation) silently
-- persisted every additional_recurring_fixed/variable row with
-- recurring_fee_id = NULL, even though contract_terms.additional_
-- recurring_fees[] already had one assigned. The gap was invisible in
-- every prior E3.4/.4.1/.4.2 test because those seeded current_line_items
-- directly rather than going through a genuine first extraction — this
-- migration exists because the live full-pipeline acceptance pass
-- (17H.4B0D4H1B4E3.5) actually exercised establish_initial_commercial_
-- snapshot for the first time with recurring_fee_id-bearing fresh items,
-- and caught it immediately (a job's initial line items all showed
-- recurring_fee_id: null despite contract_terms already having real ids —
-- confirmed live, not hypothesized). The SECOND extraction onward already
-- worked correctly (apply_current_line_item_reconciliation's own identity-
-- promotion path silently "fixed" it retroactively one generation late),
-- which is exactly why this was easy to miss without a genuine first-
-- extraction live run.
--
-- CREATE OR REPLACE FUNCTION with the IDENTICAL 2-parameter signature
-- (p_job_id uuid, p_inserts jsonb) — a true in-place replacement, not a
-- new overload. Every other validation/concurrency/atomicity property
-- (advisory lock, marker check, existing-line-items fail-closed check,
-- forbidden-key/required-field validation) is byte-for-byte unchanged;
-- only the intrinsic-batch validation and the INSERT statement gain
-- recurring_fee_id, mirroring exactly how 20260916000001 extended
-- apply_current_line_item_reconciliation for the same column.
--
-- Written but NOT applied this session — verified by reading this file
-- only, same discipline every migration in this project has followed.

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
  v_recurring_fee_ids text[] := '{}';
  v_distinct_fee_ids text[];
  v_distinct_tier_ids text[];
  v_distinct_recurring_fee_ids text[];
begin
  if p_job_id is null then
    return jsonb_build_object('status', 'invalid_plan', 'reason', 'missing_job_id');
  end if;
  if p_inserts is null or jsonb_typeof(p_inserts) <> 'array' then
    return jsonb_build_object('status', 'invalid_plan', 'reason', 'inserts_not_array');
  end if;

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
    -- Same three-way disjointness guard 20260916000001 added to
    -- apply_current_line_item_reconciliation — recurring_fee_id is a
    -- THIRD, mutually exclusive identity, never combined with fee_id/tier_id
    -- on one row (confirmed by reading lib/line-items.ts: each is set in
    -- its own disjoint loop).
    if (v_row->>'recurring_fee_id') is not null and ((v_row->>'fee_id') is not null or (v_row->>'tier_id') is not null) then
      return jsonb_build_object('status', 'invalid_plan', 'reason', 'insert_recurring_fee_id_and_other_identity_both_present');
    end if;
    if (v_row->>'fee_id') is not null then
      v_fee_ids := array_append(v_fee_ids, v_row->>'fee_id');
    end if;
    if (v_row->>'tier_id') is not null then
      v_tier_ids := array_append(v_tier_ids, v_row->>'tier_id');
    end if;
    if (v_row->>'recurring_fee_id') is not null then
      v_recurring_fee_ids := array_append(v_recurring_fee_ids, v_row->>'recurring_fee_id');
    end if;
  end loop;

  select array_agg(distinct x) into v_distinct_fee_ids from unnest(v_fee_ids) as x;
  if coalesce(array_length(v_fee_ids, 1), 0) <> coalesce(array_length(v_distinct_fee_ids, 1), 0) then
    return jsonb_build_object('status', 'invalid_plan', 'reason', 'duplicate_fee_id_in_initial_batch');
  end if;
  select array_agg(distinct x) into v_distinct_tier_ids from unnest(v_tier_ids) as x;
  if coalesce(array_length(v_tier_ids, 1), 0) <> coalesce(array_length(v_distinct_tier_ids, 1), 0) then
    return jsonb_build_object('status', 'invalid_plan', 'reason', 'duplicate_tier_id_in_initial_batch');
  end if;
  select array_agg(distinct x) into v_distinct_recurring_fee_ids from unnest(v_recurring_fee_ids) as x;
  if coalesce(array_length(v_recurring_fee_ids, 1), 0) <> coalesce(array_length(v_distinct_recurring_fee_ids, 1), 0) then
    return jsonb_build_object('status', 'invalid_plan', 'reason', 'duplicate_recurring_fee_id_in_initial_batch');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('current_line_item_reconciliation|' || p_job_id::text, 0));

  select commercial_snapshot_initialized_at into v_marker
    from public.jobs where id = p_job_id for update;
  if not found then
    return jsonb_build_object('status', 'invalid_plan', 'reason', 'job_not_found');
  end if;
  if v_marker is not null then
    return jsonb_build_object('status', 'already_initialized', 'initialized_at', to_jsonb(v_marker));
  end if;

  select exists(select 1 from public.line_items where job_id = p_job_id) into v_any_line_item_exists;
  if v_any_line_item_exists then
    return jsonb_build_object('status', 'not_eligible', 'reason', 'existing_line_items_present');
  end if;

  for v_row in select * from jsonb_array_elements(p_inserts) loop
    insert into public.line_items (
      job_id, product_name, quantity, unit_price, billing_period, total_amount,
      currency, confidence_score, source_section, fee_id, tier_id, recurring_fee_id,
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
      v_row->>'recurring_fee_id',
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
  'The one write path for a job''s first-ever current commercial line-item snapshot (17H.4B0D4H1B4E3.1, extended 17H.4B0D4H1B4E3.5 with recurring_fee_id). Atomically: takes the same advisory lock apply_current_line_item_reconciliation uses for this job, re-verifies commercial_snapshot_initialized_at is still NULL and line_items is still genuinely empty (both under the lock), inserts every row in p_inserts (including recurring_fee_id where present) with D2 frozen reviewer state, and sets commercial_snapshot_initialized_at — all in one transaction.';

notify pgrst, 'reload schema';
