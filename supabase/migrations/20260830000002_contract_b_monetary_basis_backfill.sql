-- Contract B monetary-basis-recognition backfill (2026-08-30, follow-up
-- audit) — a one-time, tightly-scoped data correction for exactly ONE
-- credit on ONE job: Contract B's Annual Rebate (credit_rule_id
-- '4076e59c', job b583f52c-b18b-4620-ab40-52c8d5047d0a). Its source clause
-- explicitly states the rebate basis is "transaction-processing fees
-- actually paid for that Contract Year" — an unambiguous, source-derived
-- payment fact matching the deterministic marker lib/monetary-basis-
-- recognition.ts now formalizes for fresh extractions going forward. This
-- migration exists because that mechanism only runs at extraction/confirm
-- time (app/api/jobs/[id]/confirm-rule/route.ts) — it cannot retroactively
-- apply itself to a credit that was already extracted and approved before
-- the field existed. The permission classifier correctly rejected doing
-- this via an ad hoc production script outside the application's own
-- provenance safeguards (see the prior turn's denial); this migration is
-- the reviewed, auditable, fail-closed replacement for that.
--
-- Scope, explicitly narrow: touches ONLY
-- contract_terms.service_credits[credit_rule_id='4076e59c'].interpretation.
-- monetary_basis_recognition / .monetary_basis_recognition_provenance.
-- Every other field on this credit (application_rule, earn_rule,
-- cash_redeemable, trigger/rate/cap, description, source_clause) and every
-- OTHER credit in the array is left byte-for-byte unchanged. Does NOT
-- touch jobs.execute_status, jobs.billing_platform,
-- jobs.billing_customer_id, planned_invoices, or any execution/attempt
-- table — this is a commercial-interpretation data correction only, not a
-- re-approval or re-execution of anything.
--
-- Fails closed: every guard below must hold or the migration aborts via
-- RAISE EXCEPTION and performs NO update at all — never a partial or
-- best-effort write, never silently skipped. Explicitly re-verifies the
-- two target fields are still absent/null before writing (refuses to
-- overwrite an existing reviewer_policy or contract_derived value), and
-- re-verifies the credit's identity, basis shape, and source clause still
-- match what was true when this migration was written — if a re-
-- extraction, a reviewer edit, or any other change has since altered any
-- of those, this migration is no longer safe to apply blindly and must
-- stop rather than guess.
do $$
declare
  v_job_id constant uuid := 'b583f52c-b18b-4620-ab40-52c8d5047d0a';
  v_credit_rule_id constant text := '4076e59c';
  v_expected_credit_basis constant text := 'pct_of_affected_component';
  v_expected_basis_component constant text := 'transaction-processing fees actually paid for that Contract Year';
  v_terms_id uuid;
  v_service_credits jsonb;
  v_credit jsonb;
  v_new_service_credits jsonb;
begin
  select contract_terms_id into v_terms_id from public.jobs where id = v_job_id;
  if v_terms_id is null then
    raise exception 'Contract B monetary-basis backfill aborted: job % not found, or has no contract_terms_id', v_job_id;
  end if;

  select service_credits into v_service_credits
    from public.contract_terms
    where id = v_terms_id
    for update;
  if v_service_credits is null then
    raise exception 'Contract B monetary-basis backfill aborted: contract_terms % not found, or has no service_credits', v_terms_id;
  end if;

  select elem into v_credit
    from jsonb_array_elements(v_service_credits) as elem
    where elem->>'credit_rule_id' = v_credit_rule_id;
  if v_credit is null then
    raise exception 'Contract B monetary-basis backfill aborted: credit_rule_id % not found in contract_terms %', v_credit_rule_id, v_terms_id;
  end if;

  if v_credit->>'credit_type' is distinct from 'rebate' then
    raise exception 'Contract B monetary-basis backfill aborted: credit % is not credit_type=rebate (found %)', v_credit_rule_id, v_credit->>'credit_type';
  end if;

  if v_credit->'interpretation'->>'credit_basis' is distinct from v_expected_credit_basis then
    raise exception 'Contract B monetary-basis backfill aborted: unexpected credit_basis % (expected %)', v_credit->'interpretation'->>'credit_basis', v_expected_credit_basis;
  end if;

  if v_credit->'interpretation'->>'basis_component' is distinct from v_expected_basis_component then
    raise exception 'Contract B monetary-basis backfill aborted: unexpected basis_component % (expected %)', v_credit->'interpretation'->>'basis_component', v_expected_basis_component;
  end if;

  if position('actually paid' in coalesce(v_credit->>'source_clause', '')) = 0 then
    raise exception 'Contract B monetary-basis backfill aborted: credit % source_clause no longer contains the expected "actually paid" payment fact', v_credit_rule_id;
  end if;

  -- Refuse to overwrite an already-resolved value, whether it's the
  -- 'null'::jsonb literal (an explicit JSON null) or the key simply being
  -- absent — coalesce treats both identically as "not yet set".
  if coalesce(v_credit->'interpretation'->'monetary_basis_recognition', 'null'::jsonb) <> 'null'::jsonb then
    raise exception 'Contract B monetary-basis backfill aborted: monetary_basis_recognition is already set (%) — refusing to overwrite an existing value', v_credit->'interpretation'->>'monetary_basis_recognition';
  end if;

  if coalesce(v_credit->'interpretation'->'monetary_basis_recognition_provenance', 'null'::jsonb) <> 'null'::jsonb then
    raise exception 'Contract B monetary-basis backfill aborted: monetary_basis_recognition_provenance is already set (%) — refusing to overwrite an existing value', v_credit->'interpretation'->>'monetary_basis_recognition_provenance';
  end if;

  -- All guards held — apply the correction to ONLY this one credit's
  -- interpretation. order by ord preserves the array's original element
  -- order exactly; every element other than the targeted credit_rule_id
  -- passes through jsonb_agg unmodified.
  select jsonb_agg(
    case
      when elem->>'credit_rule_id' = v_credit_rule_id then
        jsonb_set(
          jsonb_set(elem, '{interpretation,monetary_basis_recognition}', '"paid"'::jsonb, true),
          '{interpretation,monetary_basis_recognition_provenance}', '"contract_derived"'::jsonb, true
        )
      else elem
    end
    order by ord
  )
  into v_new_service_credits
  from jsonb_array_elements(v_service_credits) with ordinality as t(elem, ord);

  update public.contract_terms
  set service_credits = v_new_service_credits
  where id = v_terms_id;

  raise notice 'Contract B monetary-basis backfill applied: job %, contract_terms %, credit_rule_id % -> monetary_basis_recognition=paid, monetary_basis_recognition_provenance=contract_derived', v_job_id, v_terms_id, v_credit_rule_id;
end $$;
