-- planned_invoices.fee_id — the sole structural discriminator the invoice
-- scheduler uses to distinguish an auto-executable, event-gated parked
-- one-time fee (Step 13's OneTimeFee.fee_id, billability_condition.kind =
-- 'event') from an ordinary quantity x rate manual-trigger parked fee
-- (human-driven exclusively via POST /api/jobs/[id]/parked-invoices).
-- Deliberately NEVER populated for the latter, and NEVER matched by
-- fee_label/description at runtime — see lib/billing-writer.ts (the only
-- writer of this column) and app/api/admin/invoice-scheduler/route.ts (the
-- only reader that treats it as eligibility-relevant).
alter table planned_invoices add column if not exists fee_id text;

comment on column planned_invoices.fee_id is
  'Stable contract_terms.one_time_fees[].fee_id this row was generated from. Populated only for event-gated one-time fees (billability_condition.kind = ''event''); NULL for period rows and for legacy manual_trigger one-time fees, which are never scheduler-auto-executable. The sole discriminator app/api/admin/invoice-scheduler/route.ts uses to find freshly-eligible parked event-gated fees — never inferred from fee_label.';

-- One-time backfill for rows created before this column existed. Matches a
-- currently-parked one_time row back to its contract's one_time_fees[] ONLY
-- when: (a) the job's current contract_terms row has exactly one fee whose
-- fee_label matches the row's fee_label, AND (b) that fee is genuinely
-- event-gated (billability_condition.kind = 'event') AND (c) that fee has a
-- real fee_id. Ambiguous matches (zero or more than one candidate) are left
-- NULL and logged via NOTICE — they simply remain outside the new
-- auto-execution path (unaffected, same as before this migration), never
-- guessed at.
do $$
declare
  r record;
  match_count int;
  matched_fee_id text;
begin
  for r in
    select pi.id, pi.job_id, pi.fee_label
    from planned_invoices pi
    where pi.invoice_type = 'one_time'
      and pi.status = 'parked'
      and pi.fee_id is null
      and pi.fee_label is not null
  loop
    select count(*), max(fee->>'fee_id')
      into match_count, matched_fee_id
    from contract_terms ct
    cross join lateral jsonb_array_elements(coalesce(ct.one_time_fees, '[]'::jsonb)) as fee
    where ct.job_id = r.job_id
      and fee->>'fee_label' = r.fee_label
      and fee->>'fee_id' is not null
      and fee->'billability_condition'->>'kind' = 'event';

    if match_count = 1 then
      update planned_invoices set fee_id = matched_fee_id where id = r.id;
    else
      raise notice 'planned_invoices.id=% (job_id=%, fee_label=%) left fee_id NULL — % candidate match(es)', r.id, r.job_id, r.fee_label, match_count;
    end if;
  end loop;
end $$;
