-- Corrective fix for reserve_credit_balance (20260821000001_credit_ledger.sql),
-- found via the integration test run against the real database after the
-- first six migrations were applied.
--
-- Two separate defects, confirmed empirically:
--
-- 1. As a `security definer` function, its internal queries run as the
--    FUNCTION'S OWNER, not as the `service_role` the caller authenticated
--    as — the RLS policy on credit_ledger_entries only grants `to
--    service_role`, so if the owner isn't a role that bypasses RLS
--    (`postgres`, which Supabase's platform guarantees has BYPASSRLS), the
--    function's own reads of the table return zero rows regardless of what
--    actually exists. Fixed by explicitly setting ownership to `postgres`
--    rather than relying on whichever role happened to run the original
--    CREATE FUNCTION.
--
-- 2. `returns credit_ledger_entries` (a single composite), combined with
--    `return null;` for the zero-amount no-op case, does NOT serialize as
--    JSON null over PostgREST — Postgres represents "a null value of a row
--    type" as a row with every FIELD null, which PostgREST then returns as
--    `{"id": null, "job_id": null, ...}`, not `null`. Callers checking
--    `if (!data)` never see the no-op signaled correctly. Fixed by changing
--    to `returns setof credit_ledger_entries`: the no-op case now yields
--    zero rows (`[]`), which is unambiguous. Application code (lib/credit-
--    ledger-service.ts) and tests are updated to read `data?.[0]` instead
--    of `data` directly.
--
-- CREATE OR REPLACE cannot change a function's return type, so this drops
-- and recreates it — the DROP also clears the previous grants, which are
-- re-issued identically below.
drop function if exists reserve_credit_balance(uuid, text, uuid, date, bigint, text, jsonb, boolean, text, uuid);

create function reserve_credit_balance(
  p_job_id uuid,
  p_credit_rule_id text,
  p_planned_invoice_id uuid,
  p_period_start date,
  p_requested_amount_minor bigint,
  p_currency text,
  p_details jsonb,
  p_is_one_time boolean,
  p_source_clause text,
  p_commercial_rule_interpretation_id uuid
) returns setof credit_ledger_entries
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_existing public.credit_ledger_entries;
  v_available bigint;
  v_applied bigint;
begin
  select org_id into v_org_id from public.jobs where id = p_job_id;
  if v_org_id is null then
    raise exception 'reserve_credit_balance: job % not found', p_job_id;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_job_id::text, 0));

  select * into v_existing from public.credit_ledger_entries
    where job_id = p_job_id and credit_rule_id = p_credit_rule_id
      and planned_invoice_id = p_planned_invoice_id and entry_type = 'application';

  if found and v_existing.status = 'applied' then
    return next v_existing;
    return;
  end if;

  select coalesce(sum(amount_minor) filter (where entry_type = 'earn' and window_end < p_period_start), 0)
       - coalesce(sum(amount_minor) filter (
           where entry_type = 'application' and status in ('reserved','applied')
             and id <> coalesce(v_existing.id, '00000000-0000-0000-0000-000000000000'::uuid)
         ), 0)
    into v_available
    from public.credit_ledger_entries
    where job_id = p_job_id and credit_rule_id = p_credit_rule_id;

  v_applied := greatest(0, least(coalesce(v_available, 0), p_requested_amount_minor));

  if v_applied = 0 then
    return; -- yields zero rows — the unambiguous no-op signal
  end if;

  if found then
    return query
      update public.credit_ledger_entries
        set status = 'reserved', amount_minor = v_applied, currency = p_currency, details = p_details,
            is_one_time = p_is_one_time, source_clause = p_source_clause,
            commercial_rule_interpretation_id = p_commercial_rule_interpretation_id,
            updated_at = now()
        where id = v_existing.id
        returning *;
    return;
  end if;

  return query
    insert into public.credit_ledger_entries
      (job_id, org_id, credit_rule_id, entry_type, status, planned_invoice_id, amount_minor, currency,
       window_start, window_end, details, is_one_time, source_clause, commercial_rule_interpretation_id)
      values
      (p_job_id, v_org_id, p_credit_rule_id, 'application', 'reserved', p_planned_invoice_id, v_applied, p_currency,
       p_period_start, p_period_start, p_details, p_is_one_time, p_source_clause, p_commercial_rule_interpretation_id)
      returning *;
end;
$$;

alter function reserve_credit_balance(uuid, text, uuid, date, bigint, text, jsonb, boolean, text, uuid) owner to postgres;

revoke execute on function reserve_credit_balance(uuid, text, uuid, date, bigint, text, jsonb, boolean, text, uuid) from public;
revoke execute on function reserve_credit_balance(uuid, text, uuid, date, bigint, text, jsonb, boolean, text, uuid) from anon;
revoke execute on function reserve_credit_balance(uuid, text, uuid, date, bigint, text, jsonb, boolean, text, uuid) from authenticated;
grant  execute on function reserve_credit_balance(uuid, text, uuid, date, bigint, text, jsonb, boolean, text, uuid) to service_role;
