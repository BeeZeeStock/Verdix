-- Terminal settlement — POST-DEPLOY DATA BACKFILL (contract phase). Must
-- only be applied AFTER supabase/migrations/
-- 20260830000001_terminal_settlement_schema.sql has been applied AND the
-- application code that understands invoice_type='terminal_settlement' is
-- fully deployed and the only code serving invoice-scheduler cron
-- invocations — see that migration's own header for exactly why this
-- ordering is required (new code needs the columns to exist to write a
-- fresh job's own terminal_settlement row; old code must never observe a
-- real terminal_settlement row existing, since its due-row query has no
-- invoice_type filter and no branch for this type).
--
-- One-time backfill, point 11 — Contract B (and any other job approved
-- before this feature shipped) already has its full 12-period schedule
-- with no way to receive a terminal_settlement row short of re-approval,
-- which app/api/jobs/[id]/approve/route.ts explicitly refuses for a
-- COMPLETED job. This block finds every job with a real 'period' schedule
-- and no terminal_settlement row yet, and inserts EXACTLY ONE — using the
-- same eligibility gate (isTerminalSettlementNeeded: real overage_tiers or
-- service_credits) lib/terminal-settlement.ts applies at push time, so a
-- pure flat-fee contract never gets a pointless row here either. Never
-- touches any existing row (insert-only); the unique index from the schema
-- migration is the backstop against ever creating a second one, even under
-- a concurrent migration re-run. Idempotent — safe to re-run: the WHERE
-- NOT EXISTS guard and the unique index both independently prevent a
-- second insert for any job that already has a terminal_settlement row.
do $$
declare
  r record;
  matched_terminal_settlement_period_start date;
  matched_terminal_settlement_period_end date;
  needs_settlement boolean;
begin
  for r in
    select pi.job_id, max(pi.period_end) as last_period_end
    from planned_invoices pi
    where pi.invoice_type = 'period'
      and not exists (
        select 1 from planned_invoices ts
        where ts.job_id = pi.job_id and ts.invoice_type = 'terminal_settlement'
      )
    group by pi.job_id
  loop
    -- The exact row matching that last period_end — gives both bounds
    -- together rather than assuming period_start can be re-derived.
    select period_start, period_end
      into matched_terminal_settlement_period_start, matched_terminal_settlement_period_end
    from planned_invoices
    where job_id = r.job_id and invoice_type = 'period' and period_end = r.last_period_end
    limit 1;

    select coalesce(jsonb_array_length(ct.overage_tiers), 0) > 0
        or coalesce(jsonb_array_length(ct.service_credits), 0) > 0
      into needs_settlement
    from contract_terms ct
    where ct.job_id = r.job_id;

    if coalesce(needs_settlement, false) then
      insert into planned_invoices (
        job_id, org_id, year_num, period_start, period_end, base_amount, currency, fee_label,
        invoice_type, status, stripe_invoice_id, stripe_invoice_url, sent_at,
        settlement_period_start, settlement_period_end
      )
      select
        r.job_id, j.org_id, null, (matched_terminal_settlement_period_end + 1)::date, (matched_terminal_settlement_period_end + 1)::date,
        0, coalesce(ct.currency, 'EUR'), null,
        'terminal_settlement', 'scheduled', null, null, null,
        matched_terminal_settlement_period_start, matched_terminal_settlement_period_end
      from jobs j
      left join contract_terms ct on ct.job_id = j.id
      where j.id = r.job_id
      on conflict do nothing; -- backstop only; the WHERE NOT EXISTS above already prevents this in practice
    else
      raise notice 'planned_invoices backfill: job_id=% has no overage_tiers/service_credits — no terminal_settlement row needed', r.job_id;
    end if;
  end loop;
end $$;
