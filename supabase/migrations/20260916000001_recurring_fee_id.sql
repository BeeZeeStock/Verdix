-- Step 17H.4B0D4H1B4E3.4 — stable commercial-mechanism identity for the
-- additional_recurring_fixed/additional_recurring_variable line-item
-- families, closing a real, live-reproduced gap: the identical NordicFit
-- PDF, re-extracted, labeled the same clause "Success fee per completed
-- payment" on one pass and "Per-completed payment success fee" on another
-- — pure AI wording non-determinism, contract completely unchanged. Both
-- families previously had product_name as their ONLY identity (weak-family
-- doctrine, lib/current-line-item-reconciliation-plan.ts's pairWeakFamily),
-- so this wording drift alone produced billing_hold: reconciliation_blocked
-- with no resolving action.
--
-- Mirrors line_items.fee_id/tier_id's own migrations exactly
-- (20260910000001/20260911000001): a stable, application-assigned text id
-- (contract_terms.additional_recurring_fees[].recurring_fee_id, assigned by
-- lib/contract-extractor.ts's assignRecurringFeeIds, restored across
-- re-extraction by lib/rule-id-stability.ts's preserveRecurringFeeIdentity
-- via a typed structural fingerprint — semantic_input_key/billing_frequency/
-- derived-metric shape, never product_name), projected onto line_items by
-- lib/line-items.ts's buildLineItems, consumed by lib/current-line-item-
-- reconciliation-plan.ts's new pairRecurringFeeFamily (ID-first, exactly
-- like pairOneTimeFamily). Deliberately a SEPARATE column from fee_id/
-- tier_id — not a repurposing of either (17H.4B0D4H1B4E3.4 §17): those
-- remain domain-specific to one-time fees and tiers.
--
-- Written but NOT applied this session — same discipline every migration in
-- this project has followed; verified by reading this file only.

alter table line_items add column if not exists recurring_fee_id text;

comment on column line_items.recurring_fee_id is
  'Stable contract_terms.additional_recurring_fees[].recurring_fee_id this additional_recurring_fixed/variable line item corresponds to. NULL for every other row, and for a row whose identity could not be safely established. Never inferred from product_name/fee_label once populated — this is what tolerates AI wording drift across re-extraction (17H.4B0D4H1B4E3.4).';

-- No backfill in this migration — same reasoning as the tier_id migration
-- (20260911000001): a live-data audit was not re-run for this specific
-- pass, and no upstream contract_terms.additional_recurring_fees[] entry
-- carries a non-null recurring_fee_id until a real re-extraction populates
-- it (assignRecurringFeeIds runs at extraction time, not retroactively on
-- existing rows). A backfill block here would run and find zero eligible
-- candidates in every environment until then — dead code, not omitted by
-- oversight. Existing line_items rows correctly remain NULL and are
-- reconciled via pairRecurringFeeFamily's own label-bridge fallback on
-- their first post-migration re-extraction (identity PROMOTION, per
-- 17H.4B0D4H1B4E3.4 §20 — the same legacy-null -> modern-id path fee_id/
-- tier_id already established), not a mass backfill.

-- No uniqueness constraint on (job_id, recurring_fee_id) — same reasoning
-- as fee_id/tier_id's own migrations: execute/route.ts's line-item mutation
-- path is Model B+'s atomic applier (not a raw INSERT) by this point in the
-- project, but no other migration in this sequence introduced this
-- constraint for fee_id/tier_id either, and this migration does not
-- introduce a new precedent unilaterally.

-- ─────────────────────────────────────────────────────────────────────────
-- current_line_items must be recreated to expose recurring_fee_id — same
-- CREATE OR REPLACE VIEW reasoning as every prior line_items-column
-- migration in this sequence (fee_id, tier_id): the new column lands after
-- every pre-existing column in `SELECT *`'s own order, so the replacement
-- reproduces every existing output column unchanged and only appends the
-- new one, preserving the view's OID and every existing grant.
create or replace view current_line_items
  with (security_invoker = true)
  as select * from line_items where superseded_at is null;

revoke all on current_line_items from public, anon, authenticated;
grant select on current_line_items to service_role;

comment on view current_line_items is
  'Current commercial line-item configuration (superseded_at IS NULL), now including recurring_fee_id, tier_id and fee_id. Historical/admin/reconciliation code that genuinely needs superseded rows too must continue querying line_items directly. Any future migration adding a column to line_items must also CREATE OR REPLACE this view, since SELECT * is fixed at view-definition time in Postgres, not dynamic.';

-- ─────────────────────────────────────────────────────────────────────────
-- apply_current_line_item_reconciliation (20260913000001, already LIVE —
-- confirmed against the TEST database this session) extended via CREATE OR
-- REPLACE FUNCTION with the IDENTICAL 6-parameter signature (no parameter
-- added or removed, so this is a true in-place replacement, not a new
-- overload) to allow recurring_fee_id through its UPDATE allowlist,
-- identity-promotion validation, snapshot-equality comparison, and INSERT
-- columns — the exact same treatment fee_id/tier_id already received when
-- their own columns landed, mechanically extended, nothing else in this
-- function's validation/concurrency/mutation-ordering logic touched.
create or replace function apply_current_line_item_reconciliation(
  p_job_id uuid,
  p_expected_current_row_ids uuid[],
  p_expected_current_rows jsonb,
  p_updates jsonb,
  p_inserts jsonb,
  p_supersedes jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transaction_time timestamptz := clock_timestamp();

  v_allowed_update_keys text[] := array[
    'product_name', 'unit_price', 'quantity', 'billing_period', 'total_amount',
    'source_section', 'fee_id', 'tier_id', 'recurring_fee_id'
  ];
  v_forbidden_insert_keys text[] := array['id', 'job_id', 'created_at', 'superseded_at'];

  v_expected_ids uuid[] := coalesce(p_expected_current_row_ids, '{}');
  v_distinct_expected_ids uuid[];
  v_actual_ids uuid[];

  v_expected_rows_by_id jsonb;
  v_snapshot_id_count int;
  v_distinct_snapshot_id_count int;

  v_mismatched_ids uuid[];

  v_update_ids uuid[] := '{}';
  v_supersede_ids uuid[] := '{}';
  v_overlap_ids uuid[];

  v_row jsonb;
  v_changes jsonb;
  v_id uuid;
  v_key text;
  v_expected_snapshot jsonb;

  v_updated_count int := 0;
  v_inserted_count int := 0;
  v_superseded_count int := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    'current_line_item_reconciliation|' || p_job_id::text, 0
  ));

  if p_job_id is null
     or p_expected_current_row_ids is null
     or p_expected_current_rows is null or jsonb_typeof(p_expected_current_rows) <> 'array'
     or p_updates is null or jsonb_typeof(p_updates) <> 'array'
     or p_inserts is null or jsonb_typeof(p_inserts) <> 'array'
     or p_supersedes is null or jsonb_typeof(p_supersedes) <> 'array'
  then
    return jsonb_build_object('status', 'invalid_plan', 'reason', 'malformed_payload_shape');
  end if;

  select array_agg(distinct x) into v_distinct_expected_ids from unnest(v_expected_ids) as x;
  if coalesce(array_length(v_expected_ids, 1), 0) <> coalesce(array_length(v_distinct_expected_ids, 1), 0) then
    return jsonb_build_object('status', 'invalid_plan', 'reason', 'duplicate_expected_current_row_id');
  end if;

  select count(*), count(distinct elem->>'id')
    into v_snapshot_id_count, v_distinct_snapshot_id_count
    from jsonb_array_elements(p_expected_current_rows) as elem;

  if v_snapshot_id_count <> coalesce(array_length(v_expected_ids, 1), 0) then
    return jsonb_build_object('status', 'invalid_plan', 'reason', 'snapshot_count_mismatch');
  end if;
  if v_snapshot_id_count <> v_distinct_snapshot_id_count then
    return jsonb_build_object('status', 'invalid_plan', 'reason', 'duplicate_snapshot_id');
  end if;

  select jsonb_object_agg(elem->>'id', elem) into v_expected_rows_by_id
    from jsonb_array_elements(p_expected_current_rows) as elem;

  if exists (
    select 1 from unnest(v_expected_ids) as x
    where not (v_expected_rows_by_id ? x::text)
  ) then
    return jsonb_build_object('status', 'invalid_plan', 'reason', 'snapshot_missing_for_expected_id');
  end if;

  for v_row in select * from jsonb_array_elements(p_updates) loop
    if not (v_row ? 'id') or not (v_row ? 'changes') then
      return jsonb_build_object('status', 'invalid_plan', 'reason', 'update_missing_id_or_changes');
    end if;
    begin
      v_id := (v_row->>'id')::uuid;
    exception when others then
      return jsonb_build_object('status', 'invalid_plan', 'reason', 'update_id_not_uuid');
    end;
    if not (v_expected_rows_by_id ? v_id::text) then
      return jsonb_build_object('status', 'invalid_plan', 'reason', 'update_id_outside_expected_set');
    end if;
    v_changes := v_row->'changes';
    if jsonb_typeof(v_changes) <> 'object' or v_changes = '{}'::jsonb then
      return jsonb_build_object('status', 'invalid_plan', 'reason', 'update_changes_empty_or_malformed');
    end if;
    for v_key in select jsonb_object_keys(v_changes) loop
      if not (v_key = any(v_allowed_update_keys)) then
        return jsonb_build_object('status', 'invalid_plan', 'reason', 'update_changes_forbidden_key: ' || v_key);
      end if;
    end loop;

    v_expected_snapshot := v_expected_rows_by_id->v_id::text;
    if v_changes ? 'fee_id' then
      if (v_expected_snapshot->>'fee_id') is not null or (v_changes->>'fee_id') is null then
        return jsonb_build_object('status', 'invalid_plan', 'reason', 'fee_id_promotion_violates_null_to_nonnull');
      end if;
    end if;
    if v_changes ? 'tier_id' then
      if (v_expected_snapshot->>'tier_id') is not null or (v_changes->>'tier_id') is null then
        return jsonb_build_object('status', 'invalid_plan', 'reason', 'tier_id_promotion_violates_null_to_nonnull');
      end if;
    end if;
    -- New identity-promotion guard, mirroring fee_id/tier_id exactly:
    -- recurring_fee_id may only ever go null -> non-null through this
    -- function, never A -> B or A -> NULL.
    if v_changes ? 'recurring_fee_id' then
      if (v_expected_snapshot->>'recurring_fee_id') is not null or (v_changes->>'recurring_fee_id') is null then
        return jsonb_build_object('status', 'invalid_plan', 'reason', 'recurring_fee_id_promotion_violates_null_to_nonnull');
      end if;
    end if;

    v_update_ids := v_update_ids || v_id;
  end loop;

  if coalesce(array_length(v_update_ids, 1), 0) <> coalesce((select count(distinct x) from unnest(v_update_ids) as x), 0) then
    return jsonb_build_object('status', 'invalid_plan', 'reason', 'duplicate_update_id');
  end if;

  for v_row in select * from jsonb_array_elements(p_supersedes) loop
    if not (v_row ? 'id') then
      return jsonb_build_object('status', 'invalid_plan', 'reason', 'supersede_missing_id');
    end if;
    begin
      v_id := (v_row->>'id')::uuid;
    exception when others then
      return jsonb_build_object('status', 'invalid_plan', 'reason', 'supersede_id_not_uuid');
    end;
    if not (v_expected_rows_by_id ? v_id::text) then
      return jsonb_build_object('status', 'invalid_plan', 'reason', 'supersede_id_outside_expected_set');
    end if;
    v_supersede_ids := v_supersede_ids || v_id;
  end loop;

  if coalesce(array_length(v_supersede_ids, 1), 0) <> coalesce((select count(distinct x) from unnest(v_supersede_ids) as x), 0) then
    return jsonb_build_object('status', 'invalid_plan', 'reason', 'duplicate_supersede_id');
  end if;

  select array_agg(x) into v_overlap_ids
    from unnest(v_update_ids) as x
    where x = any(v_supersede_ids);
  if coalesce(array_length(v_overlap_ids, 1), 0) > 0 then
    return jsonb_build_object('status', 'invalid_plan', 'reason', 'update_and_supersede_overlap');
  end if;

  for v_row in select * from jsonb_array_elements(p_inserts) loop
    foreach v_key in array v_forbidden_insert_keys loop
      if v_row ? v_key then
        return jsonb_build_object('status', 'invalid_plan', 'reason', 'insert_forbidden_key: ' || v_key);
      end if;
    end loop;
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
    -- Same disjointness guard, extended: recurring_fee_id is a THIRD,
    -- mutually exclusive identity — confirmed by reading lib/line-items.ts
    -- directly, tier_id/fee_id/recurring_fee_id are each set in their own
    -- disjoint loop, never merged onto one row.
    if (v_row->>'recurring_fee_id') is not null and ((v_row->>'fee_id') is not null or (v_row->>'tier_id') is not null) then
      return jsonb_build_object('status', 'invalid_plan', 'reason', 'insert_recurring_fee_id_and_other_identity_both_present');
    end if;
  end loop;

  perform 1
    from public.line_items
    where job_id = p_job_id and superseded_at is null
    for update;

  select array_agg(id order by id) into v_actual_ids
    from public.line_items
    where job_id = p_job_id and superseded_at is null;
  v_actual_ids := coalesce(v_actual_ids, '{}');

  if array(select unnest(v_actual_ids) order by 1) <> array(select unnest(v_expected_ids) order by 1) then
    return jsonb_build_object(
      'status', 'stale_plan', 'reason', 'current_set_changed',
      'missing_from_actual', to_jsonb(array(select unnest(v_expected_ids) except select unnest(v_actual_ids))),
      'extra_in_actual', to_jsonb(array(select unnest(v_actual_ids) except select unnest(v_expected_ids)))
    );
  end if;

  with expected as (
    select * from jsonb_to_recordset(p_expected_current_rows) as t(
      id uuid, product_name text, unit_price numeric, quantity numeric, billing_period text,
      total_amount numeric, confidence_score numeric, currency text, stripe_price_id text,
      applied_rule text, correction_reason text, source_section text,
      reviewer_corrected_fields text[], reviewer_corrected_fields_complete boolean,
      reviewer_corrected_at timestamptz, fee_id text, tier_id text, recurring_fee_id text
    )
  )
  select array_agg(e.id) into v_mismatched_ids
  from expected e
  join public.line_items li on li.id = e.id and li.job_id = p_job_id and li.superseded_at is null
  where li.product_name is distinct from e.product_name
     or li.unit_price is distinct from e.unit_price
     or li.quantity is distinct from e.quantity
     or li.billing_period is distinct from e.billing_period
     or li.total_amount is distinct from e.total_amount
     or li.confidence_score is distinct from e.confidence_score
     or li.currency is distinct from e.currency
     or li.stripe_price_id is distinct from e.stripe_price_id
     or li.applied_rule is distinct from e.applied_rule
     or li.correction_reason is distinct from e.correction_reason
     or li.source_section is distinct from e.source_section
     or li.reviewer_corrected_fields is distinct from e.reviewer_corrected_fields
     or li.reviewer_corrected_fields_complete is distinct from e.reviewer_corrected_fields_complete
     or li.reviewer_corrected_at is distinct from e.reviewer_corrected_at
     or li.fee_id is distinct from e.fee_id
     or li.tier_id is distinct from e.tier_id
     or li.recurring_fee_id is distinct from e.recurring_fee_id;

  if coalesce(array_length(v_mismatched_ids, 1), 0) > 0 then
    return jsonb_build_object('status', 'stale_plan', 'reason', 'current_row_changed', 'affected_ids', to_jsonb(v_mismatched_ids));
  end if;

  for v_row in select * from jsonb_array_elements(p_updates) loop
    v_id := (v_row->>'id')::uuid;
    v_changes := v_row->'changes';
    update public.line_items set
      product_name      = case when v_changes ? 'product_name'      then v_changes->>'product_name' else product_name end,
      unit_price         = case when v_changes ? 'unit_price'        then (v_changes->>'unit_price')::numeric else unit_price end,
      quantity           = case when v_changes ? 'quantity'          then (v_changes->>'quantity')::numeric else quantity end,
      billing_period     = case when v_changes ? 'billing_period'    then v_changes->>'billing_period' else billing_period end,
      total_amount       = case when v_changes ? 'total_amount'      then (v_changes->>'total_amount')::numeric else total_amount end,
      source_section     = case when v_changes ? 'source_section'    then v_changes->>'source_section' else source_section end,
      fee_id             = case when v_changes ? 'fee_id'            then v_changes->>'fee_id' else fee_id end,
      tier_id            = case when v_changes ? 'tier_id'           then v_changes->>'tier_id' else tier_id end,
      recurring_fee_id   = case when v_changes ? 'recurring_fee_id'  then v_changes->>'recurring_fee_id' else recurring_fee_id end
    where id = v_id and job_id = p_job_id and superseded_at is null;
    v_updated_count := v_updated_count + 1;
  end loop;

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

  for v_row in select * from jsonb_array_elements(p_supersedes) loop
    v_id := (v_row->>'id')::uuid;
    update public.line_items
      set superseded_at = v_transaction_time
      where id = v_id and job_id = p_job_id and superseded_at is null;
    v_superseded_count := v_superseded_count + 1;
  end loop;

  return jsonb_build_object(
    'status', 'applied',
    'updated_count', v_updated_count,
    'inserted_count', v_inserted_count,
    'superseded_count', v_superseded_count
  );
end;
$$;

alter function apply_current_line_item_reconciliation(uuid, uuid[], jsonb, jsonb, jsonb, jsonb) owner to postgres;

revoke execute on function apply_current_line_item_reconciliation(uuid, uuid[], jsonb, jsonb, jsonb, jsonb) from public;
revoke execute on function apply_current_line_item_reconciliation(uuid, uuid[], jsonb, jsonb, jsonb, jsonb) from anon;
revoke execute on function apply_current_line_item_reconciliation(uuid, uuid[], jsonb, jsonb, jsonb, jsonb) from authenticated;
grant  execute on function apply_current_line_item_reconciliation(uuid, uuid[], jsonb, jsonb, jsonb, jsonb) to service_role;

comment on function apply_current_line_item_reconciliation(uuid, uuid[], jsonb, jsonb, jsonb, jsonb) is
  'Atomic Model B+ applier (17H.4B0D4H1B2, extended 17H.4B0D4H1B4E3.4 with recurring_fee_id). Consumes a frozen plan from lib/current-line-item-reconciliation-plan.ts, validates the FULL current line_items population against what the planner saw, and — only if unchanged — applies updates/inserts/supersedes atomically. Returns {status:"applied",...} | {status:"stale_plan",reason,...} | {status:"invalid_plan",reason}.';

notify pgrst, 'reload schema';
