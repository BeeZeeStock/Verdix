-- Second corrective fix for reserve_credit_balance, found via a live SQL
-- diagnostic run against production after 20260821000005 was applied.
--
-- 20260821000005 fixed two real bugs (null-composite serialization, and
-- defensively pinning function ownership to `postgres`), but the integration
-- tests still failed after that migration. Diagnostic queries proved
-- ownership/RLS was never actually the blocker here: `postgres` owns both
-- the function and the table, has rolbypassrls = true, and the table has
-- relforcerowsecurity = false — table owners bypass RLS by default in
-- Postgres regardless of that flag. So every read inside the function was
-- always seeing real data; the bug is purely in the function's own control
-- flow.
--
-- The actual defect: PL/pgSQL's implicit `FOUND` variable is a single
-- session-wide flag set by the MOST RECENTLY executed SELECT/INSERT/UPDATE/
-- DELETE/PERFORM/FETCH statement — not scoped to whichever statement the
-- reader has in mind. The function does:
--
--   select * into v_existing from ... where entry_type = 'application' ...;
--   if found and v_existing.status = 'applied' then ...           -- (A) correct use of FOUND
--
--   select coalesce(sum(...) filter (...), 0) - coalesce(sum(...) filter (...), 0)
--     into v_available from ...;                                   -- (B) an aggregate with no
--                                                                   --     GROUP BY ALWAYS returns
--                                                                   --     exactly one row, even when
--                                                                   --     zero underlying rows match
--                                                                   --     — so this unconditionally
--                                                                   --     sets FOUND = true here,
--                                                                   --     clobbering (A)'s result.
--   ...
--   if found then                                                  -- (C) always true because of (B),
--     update ... where id = v_existing.id returning *;             --     regardless of whether an
--   end if;                                                        --     existing row was actually
--                                                                   --     found — so a brand-new
--                                                                   --     reservation (v_existing.id
--                                                                   --     is NULL) always takes this
--                                                                   --     branch and UPDATEs against
--                                                                   --     id = NULL, which matches
--                                                                   --     zero rows. `v_applied` was
--                                                                   --     computed correctly and
--                                                                   --     non-zero, but the function
--                                                                   --     still returned no rows.
--
-- Fixed by capturing FOUND into an explicit v_existing_found boolean
-- immediately after the v_existing lookup, before anything else can
-- overwrite it, and branching on that captured value instead of the shared
-- implicit FOUND.
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
  v_existing_found boolean;
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
  v_existing_found := found; -- captured immediately — never read `found` bare again below

  if v_existing_found and v_existing.status = 'applied' then
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

  if v_existing_found then
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
