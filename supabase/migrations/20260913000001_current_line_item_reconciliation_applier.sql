-- Step 17H.4B0D4H1B2 — the atomic persistence layer for the pure Model B+
-- planner frozen in H1B1/H1B1.1 (lib/current-line-item-reconciliation-plan.ts's
-- planCurrentLineItemReconciliation). This migration adds ONLY the RPC and
-- its narrow TypeScript wrapper (lib/current-line-item-reconciliation-
-- applier.ts) — nothing in the application calls it yet. execute/route.ts's
-- unconditional line_items INSERT is UNCHANGED; billing_hold is untouched;
-- the old lib/line-items-reconciliation.ts helper is untouched. Wiring any
-- of those is explicitly later, separately-authorized work (H1B3+).
--
-- Written but NOT applied this session, and NOT invoked against any real
-- database this session (live or otherwise) — same discipline every
-- migration in this project has followed, stated explicitly here because
-- this migration is unusually mutation-heavy (it is, itself, the first
-- thing in this whole line-item-reconciliation sequence that ever performs
-- a real UPDATE/INSERT against line_items).
--
-- Step 17H.4B0D4H1B2.1 — amended in place (not layered with a second
-- fix-up migration, same convention this project already uses for an
-- unapplied migration — e.g. 20260912000001_billing_hold.sql's own
-- H1A.1 amendment — versus amending-by-layering once something is truly
-- live): the row-locking query originally combined `array_agg(id)` with
-- `FOR UPDATE` in one SELECT, which PostgreSQL rejects ("FOR UPDATE is not
-- allowed with aggregate functions") — this would have failed on every
-- real invocation. Never applied to any database, so never actually
-- exercised — caught by review before it could matter, not after. Fixed
-- by separating the lock from the aggregation into two statements against
-- the identical WHERE clause; see the corrected block below for the full
-- reasoning. No other behavior in this migration changed by this
-- amendment — the RPC's parameter list, validation semantics, mutation
-- semantics, and result shape are all byte-for-byte unchanged.
--
-- ─────────────────────────────────────────────────────────────────────────
-- Division of responsibility (why this function does NOT re-derive
-- commercial reconciliation logic): the planner has ALREADY removed every
-- unsafe mutation from a blocked family before this function ever sees the
-- plan — see current-line-item-reconciliation-plan.ts's own header and its
-- H1B1.1 blocked-family doctrine. `blockers` is deliberately NOT a
-- parameter of this function at all: it is an orchestration/diagnostic
-- concern (H1B3 will read blockers directly off the SAME plan object to
-- decide whether to set jobs.billing_hold — a decision this function has no
-- business making), never a persistence concern. This function's entire
-- job is: (1) confirm the database still matches the exact snapshot the
-- planner reasoned about, (2) if it does, apply EXACTLY the already-safe
-- updates/inserts/supersedes arrays the planner computed — nothing more,
-- nothing re-derived, nothing re-decided.
--
-- ─────────────────────────────────────────────────────────────────────────
-- Concurrency model — TWO distinct mechanisms doing TWO distinct jobs, not
-- one mechanism wearing two hats:
--
-- (1) A per-job advisory transaction lock (pg_advisory_xact_lock) serializes
--     this RPC against ITSELF for the same job — two concurrent
--     Model-B+-applier calls for the same job_id never interleave. The lock
--     key is salted with a feature-specific string ('current_line_item_
--     reconciliation|' || job_id), not the bare job_id the existing
--     reserve_credit_balance/rolling-band/usage-period functions hash —
--     those are a DIFFERENT feature's per-job lock, and reusing their bare
--     job_id hash would create unrelated, unnecessary contention between
--     credit reservation and line-item reconciliation for the same job
--     (mirrors operational_input_period_values' own documented reasoning:
--     "scoped... not per-job like the credit ledger's own lock — a
--     concurrent [unrelated operation] on the same job is unrelated and
--     must not be serialized behind this one" — same principle, applied at
--     the feature-namespace level here rather than the sub-resource level).
--
-- (2) `SELECT ... FOR UPDATE` over the COMPLETE current row set (§5 of the
--     spec this migration implements) is what actually protects against
--     the real cross-feature race: app/api/jobs/[id]/line-items/route.ts's
--     PATCH handler (the reviewer correction endpoint) updates line_items
--     directly, with NO advisory lock and NO participation in this
--     protocol at all — a plain `.update().eq('id',...)` from application
--     code, which Postgres itself turns into an implicit row-level lock for
--     the duration of that UPDATE's own transaction. FOR UPDATE here
--     acquires the IDENTICAL kind of lock on the same rows, so the two
--     paths correctly serialize against EACH OTHER even though neither
--     participates in the other's advisory-lock protocol:
--       - If the reviewer's PATCH commits FIRST: this RPC's FOR UPDATE
--         blocks until that PATCH's transaction ends, then acquires the
--         lock and reads the ALREADY-CHANGED row. The snapshot-equality
--         check below then correctly fails (current_row_changed) — this
--         RPC returns stale_plan, mutates nothing, and the reviewer's
--         correction is never overwritten.
--       - If this RPC's FOR UPDATE acquires FIRST: the reviewer's PATCH
--         blocks (Postgres's own implicit UPDATE lock wait) until this
--         RPC's transaction commits or rolls back, then proceeds against
--         whatever row state this RPC left behind — never lost, never
--         silently clobbered, just ordered.
--     No advisory lock could achieve this on its own — the PATCH route
--     doesn't take one, and this migration deliberately does not require
--     the PATCH route to be rewritten just to make this RPC safe. FOR
--     UPDATE is the load-bearing protection; the advisory lock only adds
--     serialization between concurrent callers of THIS function.
--
-- Known, explicitly-NOT-solved-by-this-function gap (§35 of the spec): a
-- concurrent, NON-cooperating brand-new INSERT into line_items for this
-- job (e.g. a second execute/route.ts re-execution running at the same
-- time) is NOT prevented by FOR UPDATE — FOR UPDATE can only lock rows
-- that already exist at lock time, never a table-level "no new rows for
-- this job_id" guarantee. This RPC becomes genuinely production-
-- authoritative only once H1B3/H1B4 remove or serialize every remaining
-- direct line_items INSERT path (currently: execute/route.ts's own
-- unconditional insert). This migration does not attempt to close that
-- gap — see the report for the explicit acknowledgment.
create function apply_current_line_item_reconciliation(
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

  -- Allowlist for UPDATE `changes` keys — byte-for-byte the set
  -- computeSameRowFieldChanges/computeIdentityPromotionOnly in
  -- lib/current-line-item-reconciliation-plan.ts can ever populate
  -- (re-audited against that file's real source before freezing this
  -- list, not assumed from the task spec alone): the five ordinary
  -- reviewer-correctable fields, source_section (system-owned provenance,
  -- always safe to refresh on a clean SAME pair), and the two identity
  -- fields (legacy-null -> modern-id promotion only). confidence_score is
  -- deliberately ABSENT — the planner never proposes it (see that file's
  -- own comment: "deliberately ALWAYS preserved, never refreshed").
  v_allowed_update_keys text[] := array[
    'product_name', 'unit_price', 'quantity', 'billing_period', 'total_amount',
    'source_section', 'fee_id', 'tier_id'
  ];
  -- Forbidden on an INSERT row regardless of value — presence alone means
  -- a caller is attempting to control identity/lifecycle state that must
  -- always be server-assigned. buildLineItems() (the only real producer of
  -- insert rows) never emits any of these — their presence in a real
  -- payload can only be a bug or tampering, never a legitimate plan.
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
  -- ── §4 — job-scoped advisory transaction lock ─────────────────────────
  -- Serializes this RPC against itself for the same job only; see the
  -- header comment above for why a feature-salted key, not the bare
  -- job_id other functions in this codebase already hash.
  perform pg_advisory_xact_lock(hashtextextended(
    'current_line_item_reconciliation|' || p_job_id::text, 0
  ));

  -- ── §15 (partial) — coarse payload-shape validation, no DB access yet.
  -- Fails fast on a structurally broken payload before ever touching a
  -- row, exactly like the rest of this function's invalid_plan checks.
  if p_job_id is null
     or p_expected_current_row_ids is null
     or p_expected_current_rows is null or jsonb_typeof(p_expected_current_rows) <> 'array'
     or p_updates is null or jsonb_typeof(p_updates) <> 'array'
     or p_inserts is null or jsonb_typeof(p_inserts) <> 'array'
     or p_supersedes is null or jsonb_typeof(p_supersedes) <> 'array'
  then
    return jsonb_build_object('status', 'invalid_plan', 'reason', 'malformed_payload_shape');
  end if;

  -- ── §7 (payload half) — no duplicate expected IDs. Treated here as
  -- invalid_plan, a deliberate, documented refinement of the spec's literal
  -- text (which nests this under stale_plan/current_set_changed): a
  -- well-formed planner call can never produce a duplicate id in
  -- expectedCurrentRowIds (it is `currentItems.map(i => i.id)` over
  -- distinct-PK rows) — a duplicate here is a payload-construction defect
  -- the caller must fix in its OWN serialization, not something a re-read-
  -- and-replan against the (unchanged) real database could ever resolve,
  -- which is what stale_plan promises the caller. See the report for this
  -- exact reasoning restated.
  select array_agg(distinct x) into v_distinct_expected_ids from unnest(v_expected_ids) as x;
  if coalesce(array_length(v_expected_ids, 1), 0) <> coalesce(array_length(v_distinct_expected_ids, 1), 0) then
    return jsonb_build_object('status', 'invalid_plan', 'reason', 'duplicate_expected_current_row_id');
  end if;

  -- ── §8 — snapshot payload validation (still no DB access: this only
  -- checks p_expected_current_rows against p_expected_current_row_ids,
  -- both caller-supplied). Build a lookup map (id::text -> full snapshot
  -- object) while validating, reused below for identity-promotion checks
  -- and, implicitly, for the snapshot-equality query.
  select count(*), count(distinct elem->>'id')
    into v_snapshot_id_count, v_distinct_snapshot_id_count
    from jsonb_array_elements(p_expected_current_rows) as elem;

  if v_snapshot_id_count <> coalesce(array_length(v_expected_ids, 1), 0) then
    -- Wrong count outright — either extra snapshots, missing snapshots, or
    -- both; the exact-membership check below would also catch this, but
    -- failing fast on cardinality alone avoids a needless full comparison.
    return jsonb_build_object('status', 'invalid_plan', 'reason', 'snapshot_count_mismatch');
  end if;
  if v_snapshot_id_count <> v_distinct_snapshot_id_count then
    return jsonb_build_object('status', 'invalid_plan', 'reason', 'duplicate_snapshot_id');
  end if;

  select jsonb_object_agg(elem->>'id', elem) into v_expected_rows_by_id
    from jsonb_array_elements(p_expected_current_rows) as elem;

  -- Exact membership, both directions: every expected id has a snapshot,
  -- and every snapshot belongs to an expected id (the count-equality check
  -- above plus a one-directional membership check together are sufficient
  -- once counts already match — no need for two separate set-difference
  -- queries).
  if exists (
    select 1 from unnest(v_expected_ids) as x
    where not (v_expected_rows_by_id ? x::text)
  ) then
    return jsonb_build_object('status', 'invalid_plan', 'reason', 'snapshot_missing_for_expected_id');
  end if;

  -- ── §15 — updates: shape, uniqueness, allowlist, non-empty changes,
  -- membership in the expected set. Still no DB access.
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

    -- §17 — identity-promotion validation, checked against the CALLER's
    -- own expected snapshot (equivalent to checking the real DB, since the
    -- snapshot-equality query below — not yet run at this point in the
    -- function, but logically guaranteed before any mutation reaches this
    -- row — proves p_expected_current_rows already equals the live row).
    -- Never A -> B or A -> NULL through this function.
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

    v_update_ids := v_update_ids || v_id;
  end loop;

  if coalesce(array_length(v_update_ids, 1), 0) <> coalesce((select count(distinct x) from unnest(v_update_ids) as x), 0) then
    return jsonb_build_object('status', 'invalid_plan', 'reason', 'duplicate_update_id');
  end if;

  -- ── §15 — supersedes: shape, uniqueness, membership.
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

  -- A row cannot be both updated and superseded in the same plan.
  select array_agg(x) into v_overlap_ids
    from unnest(v_update_ids) as x
    where x = any(v_supersede_ids);
  if coalesce(array_length(v_overlap_ids, 1), 0) > 0 then
    return jsonb_build_object('status', 'invalid_plan', 'reason', 'update_and_supersede_overlap');
  end if;

  -- ── §15/§19/§20/§21/§22 — inserts: required fields, forbidden fields,
  -- semantic-contamination guard. Still no DB access.
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
    -- §22 — no valid buildLineItems() row ever carries both identities
    -- (confirmed by reading lib/line-items.ts directly: tier_id is only
    -- ever set in the overage_tiers loop, fee_id only ever set in the
    -- one_time_fees loop — two disjoint object literals, never merged).
    -- Reject rather than silently pick one if a payload ever violates this.
    if (v_row->>'fee_id') is not null and (v_row->>'tier_id') is not null then
      return jsonb_build_object('status', 'invalid_plan', 'reason', 'insert_fee_id_and_tier_id_both_present');
    end if;
  end loop;

  -- ── §5 — CRITICAL: lock the COMPLETE current row set for this job, not
  -- only the rows this plan happens to touch.
  --
  -- Step 17H.4B0D4H1B2.1 correction — PostgreSQL does not allow FOR UPDATE
  -- in the same statement as an aggregate function ("FOR UPDATE is not
  -- allowed with aggregate functions"); the original H1B2 draft combined
  -- `array_agg(id)` with `FOR UPDATE` in one SELECT, which would have
  -- raised an error on every real invocation — never actually invoked
  -- against a live database, so this was caught before it could matter,
  -- not after. Fixed by separating the LOCK from the AGGREGATION into two
  -- statements against the IDENTICAL WHERE clause (job_id = p_job_id AND
  -- superseded_at IS NULL): the first is a plain, non-aggregate SELECT
  -- ... FOR UPDATE that locks every matching row and nothing else; the
  -- second is an ordinary (non-locking) array_agg read of that SAME
  -- population, safe without its own FOR UPDATE because the first
  -- statement already holds an exclusive row lock on every row it could
  -- possibly read — no concurrent writer can modify, insert into, or
  -- remove-from-scope (via superseded_at) any of these rows between the
  -- two statements within this one transaction. Both statements query
  -- public.line_items directly — never current_line_items or any other
  -- view — so there is no risk of the two steps silently observing two
  -- different filtered populations.
  perform 1
    from public.line_items
    where job_id = p_job_id and superseded_at is null
    for update;

  select array_agg(id order by id) into v_actual_ids
    from public.line_items
    where job_id = p_job_id and superseded_at is null;
  v_actual_ids := coalesce(v_actual_ids, '{}');

  -- ── §7 — full current population validation. actual has no duplicates
  -- by construction (PK); v_expected_ids already proven duplicate-free
  -- above. Plain sorted-array equality is therefore true set equality here.
  if array(select unnest(v_actual_ids) order by 1) <> array(select unnest(v_expected_ids) order by 1) then
    return jsonb_build_object(
      'status', 'stale_plan', 'reason', 'current_set_changed',
      'missing_from_actual', to_jsonb(array(select unnest(v_expected_ids) except select unnest(v_actual_ids))),
      'extra_in_actual', to_jsonb(array(select unnest(v_actual_ids) except select unnest(v_expected_ids)))
    );
  end if;

  -- ── §8-§13 — every-row snapshot equality, typed comparison via
  -- jsonb_to_recordset (never string-compared), IS NOT DISTINCT FROM
  -- throughout so NULL is compared correctly rather than erroring or
  -- always-false. Includes reviewer metadata (§12) and identity (§13) —
  -- not just commercial fields — exactly per the frozen snapshot shape
  -- (§9): created_at excluded (never part of the snapshot), superseded_at
  -- represented structurally by set membership above, never as a field.
  --
  -- §6 (17H.4B0D4H1B2.1) — this join condition (`li.job_id = p_job_id and
  -- li.superseded_at is null`) is byte-for-byte the SAME predicate as the
  -- locking statement immediately above, and every row it can possibly
  -- read is already exclusively locked by this transaction at this point
  -- — this is not a second, independently-filtered population, it is the
  -- identical locked set, read a second time only because a single
  -- statement cannot cheaply serve both the id-list and a typed multi-
  -- column comparison at once. Reads public.line_items directly, never
  -- current_line_items or any other view.
  with expected as (
    select * from jsonb_to_recordset(p_expected_current_rows) as t(
      id uuid, product_name text, unit_price numeric, quantity numeric, billing_period text,
      total_amount numeric, confidence_score numeric, currency text, stripe_price_id text,
      applied_rule text, correction_reason text, source_section text,
      reviewer_corrected_fields text[], reviewer_corrected_fields_complete boolean,
      reviewer_corrected_at timestamptz, fee_id text, tier_id text
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
     or li.tier_id is distinct from e.tier_id;

  if coalesce(array_length(v_mismatched_ids, 1), 0) > 0 then
    return jsonb_build_object('status', 'stale_plan', 'reason', 'current_row_changed', 'affected_ids', to_jsonb(v_mismatched_ids));
  end if;

  -- ── §14/§26 — every validation above has fully succeeded (current-set
  -- equality AND every-row snapshot equality) BEFORE this point; no
  -- mutation has happened yet. Apply in the documented order: UPDATE same
  -- rows, INSERT new rows, SUPERSEDE removed rows. All inside this single
  -- function invocation's implicit transaction — a failure anywhere below
  -- rolls back everything already applied in this call (§27); no
  -- intermediate state becomes visible until commit.

  -- UPDATE — strict allowlist (already validated above), reviewer metadata
  -- and confidence_score/currency/etc. never touched by construction (§18):
  -- they are simply not in the SET list below, not merely "not updated
  -- because changes didn't include them" — protected structurally.
  for v_row in select * from jsonb_array_elements(p_updates) loop
    v_id := (v_row->>'id')::uuid;
    v_changes := v_row->'changes';
    update public.line_items set
      product_name   = case when v_changes ? 'product_name'   then v_changes->>'product_name' else product_name end,
      unit_price     = case when v_changes ? 'unit_price'     then (v_changes->>'unit_price')::numeric else unit_price end,
      quantity       = case when v_changes ? 'quantity'       then (v_changes->>'quantity')::numeric else quantity end,
      billing_period = case when v_changes ? 'billing_period' then v_changes->>'billing_period' else billing_period end,
      total_amount   = case when v_changes ? 'total_amount'   then (v_changes->>'total_amount')::numeric else total_amount end,
      source_section = case when v_changes ? 'source_section' then v_changes->>'source_section' else source_section end,
      fee_id         = case when v_changes ? 'fee_id'         then v_changes->>'fee_id' else fee_id end,
      tier_id        = case when v_changes ? 'tier_id'        then v_changes->>'tier_id' else tier_id end
    where id = v_id and job_id = p_job_id and superseded_at is null;
    v_updated_count := v_updated_count + 1;
  end loop;

  -- INSERT — job_id always server-assigned from p_job_id, never trusted
  -- from the payload (already structurally impossible above — 'job_id' is
  -- a forbidden key). D2 frozen state C (§20) is hardcoded here, never
  -- read from the payload even if present under an ignored key.
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

  -- SUPERSEDE — one shared v_transaction_time for every row in this call
  -- (§23), never physically deleted, no other field touched.
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
  'Atomic Model B+ applier (Step 17H.4B0D4H1B2). Consumes a frozen plan from lib/current-line-item-reconciliation-plan.ts, validates the FULL current line_items population (both membership and every mutable field, including reviewer metadata and identity) against what the planner actually saw, and — only if unchanged — applies updates/inserts/supersedes atomically. Returns {status:"applied",...} | {status:"stale_plan",reason,...} | {status:"invalid_plan",reason}. Not yet called by any application code — see lib/current-line-item-reconciliation-applier.ts for the (currently unused) TypeScript wrapper, and the 17H.4B0D4H1B2 report for why blockers are deliberately not a parameter here.';

-- §25 — current_line_items is unaffected by this migration: no column was
-- added to line_items, so `CREATE OR REPLACE VIEW ... SELECT * FROM
-- line_items WHERE superseded_at IS NULL` needs no update, and its existing
-- WHERE clause already hides any row this function supersedes automatically
-- (superseded_at is set to a non-null value by this function's own UPDATE
-- above, nothing further required). Confirmed, not assumed.

notify pgrst, 'reload schema';
