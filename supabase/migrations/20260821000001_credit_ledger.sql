-- Minimal, purpose-built ledger for the three commercial credit/rebate types
-- (rebate, conditional_credit, service_credit) — an append-only earn/apply
-- log, NOT a general accounting/GL system: no accounts, no debit/credit
-- pairs, no cash settlement.
create table if not exists credit_ledger_entries (
  id                     uuid primary key default gen_random_uuid(),
  job_id                 uuid not null references jobs(id) on delete cascade,
  org_id                 uuid not null references organizations(id) on delete cascade,
  credit_rule_id         text not null,
  entry_type             text not null check (entry_type in ('trigger_check','earn','application')),
  window_start           date not null,
  window_end             date not null,
  -- 'trigger_check' rows only — the calendar day this snapshot was computed.
  -- Lets the Annual Rebate's provisional basis be recomputed daily during
  -- its 45-day finalization window without colliding with earlier snapshots.
  evaluation_date        date,
  amount_minor           bigint not null default 0,
  currency               text not null,
  measured_quantity      numeric,
  threshold_met          boolean,
  eligible_charge_amount_minor bigint,
  planned_invoice_id     uuid references planned_invoices(id) on delete set null,
  -- 'application' rows only — reserved -> applied/released lifecycle.
  status                 text check (status in ('reserved','applied','released')),
  -- Vendor invoice/row identifier, once a downstream push actually succeeds
  -- (used to detect "Remembill created it but we never got the response"
  -- on retry, via GET + a deterministic marker in the row description).
  downstream_reference_id text,
  is_one_time            boolean not null default false,
  source_clause          text,
  commercial_rule_interpretation_id uuid references commercial_rule_interpretations(id) on delete set null,
  -- e.g. {"consumed":[{"key":"transaction_processing","amount_minor":4000000}]}
  details                jsonb not null default '{}',
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint credit_ledger_application_shape check (
    entry_type <> 'application' or (planned_invoice_id is not null and status is not null)
  ),
  constraint credit_ledger_trigger_check_shape check (
    entry_type <> 'trigger_check' or evaluation_date is not null
  ),
  constraint credit_ledger_status_scoped_to_application check (
    entry_type = 'application' or status is null
  ),
  constraint credit_ledger_amount_nonnegative check (amount_minor >= 0),
  constraint credit_ledger_eligible_amount_nonnegative check (
    eligible_charge_amount_minor is null or eligible_charge_amount_minor >= 0
  )
);

-- 'earn' — exactly one row per window, ever. A finalized rebate/credit is
-- frozen permanently by this constraint alone: nothing after finalization
-- can ever insert a second earn row for the same window, so a late payment
-- structurally cannot mutate an already-earned amount.
create unique index if not exists credit_ledger_earn_window_uidx on credit_ledger_entries
  (job_id, credit_rule_id, window_start) where entry_type = 'earn';

-- 'trigger_check' — one snapshot per (window, evaluation day); same-day
-- recomputation upserts this row rather than appending a duplicate, a later
-- day's evaluation is a new, distinct audit snapshot (builds the provisional
-- rebate history: 17 Aug -> 45,000 provisional; 26 Aug -> 52,500 provisional;
-- day 45 -> frozen earn row).
create unique index if not exists credit_ledger_trigger_check_uidx on credit_ledger_entries
  (job_id, credit_rule_id, window_start, evaluation_date) where entry_type = 'trigger_check';

-- One-time credit: hard backstop, at most one earn row ever, regardless of
-- which window ends up qualifying.
create unique index if not exists credit_ledger_one_time_uidx on credit_ledger_entries
  (job_id, credit_rule_id) where entry_type = 'earn' and is_one_time;

-- Application: at most one row per (job, credit, invoice) EVER — status
-- transitions happen via UPDATE on this same row (reserved -> applied /
-- released -> reserved again on retry), never a second INSERT. This is what
-- makes recalculation of an already-processed invoice safe: it finds and
-- reuses this row instead of computing (and potentially double-consuming) a
-- fresh amount.
create unique index if not exists credit_ledger_application_uidx on credit_ledger_entries
  (job_id, credit_rule_id, planned_invoice_id) where entry_type = 'application' and planned_invoice_id is not null;

create index if not exists credit_ledger_job_credit_idx on credit_ledger_entries (job_id, credit_rule_id, entry_type);

alter table credit_ledger_entries enable row level security;
-- Explicitly role-scoped. `for all using (true) with check (true)` with no
-- `to` clause applies to PUBLIC (anon + authenticated) — exactly the
-- vulnerability class fixed project-wide in 20260819000003_rls_lockdown.sql.
-- With only this service_role policy present, Postgres default-denies every
-- operation for anon/authenticated — verified by lib/credit-ledger-rls.test.ts.
create policy "credit_ledger_service_role_only" on credit_ledger_entries
  for all to service_role using (true) with check (true);

-- ── Atomic reservation ───────────────────────────────────────────────────
-- The only place genuinely-concurrent-safe balance arithmetic happens.
-- Deliberately minimal (a balance check and a row write, not the
-- eligibility/waterfall/priority logic, which stays in pure TypeScript) —
-- job-scoped advisory lock serializes every reservation attempt for a given
-- job across concurrent invocations (e.g. an overlapping manual retry and
-- the daily cron), which per-planned_invoice_id uniqueness alone cannot do
-- since two different invoices for the same job/credit don't collide on
-- that index.
create or replace function reserve_credit_balance(
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
) returns credit_ledger_entries
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_existing public.credit_ledger_entries;
  v_available bigint;
  v_applied bigint;
  v_result public.credit_ledger_entries;
begin
  -- org_id is looked up from jobs, never trusted from a caller-supplied
  -- parameter — there is no p_org_id argument at all, so a caller cannot
  -- mismatch job_id against an unrelated org_id.
  select org_id into v_org_id from public.jobs where id = p_job_id;
  if v_org_id is null then
    raise exception 'reserve_credit_balance: job % not found', p_job_id;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_job_id::text, 0));

  select * into v_existing from public.credit_ledger_entries
    where job_id = p_job_id and credit_rule_id = p_credit_rule_id
      and planned_invoice_id = p_planned_invoice_id and entry_type = 'application';

  if found and v_existing.status = 'applied' then
    return v_existing;
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

  -- Zero-amount reservations are a no-op, never a row — a released row whose
  -- recomputed amount comes back 0 stays released rather than being
  -- re-reserved at zero, and a fresh request for 0 never creates anything.
  if v_applied = 0 then
    return null;
  end if;

  if found then
    -- Reusing a 'released' row from an earlier failed downstream attempt
    -- (or re-affirming an existing 'reserved' one) — never a second INSERT,
    -- the unique index only allows one application row per (job, credit,
    -- invoice) ever.
    update public.credit_ledger_entries
      set status = 'reserved', amount_minor = v_applied, currency = p_currency, details = p_details,
          is_one_time = p_is_one_time, source_clause = p_source_clause,
          commercial_rule_interpretation_id = p_commercial_rule_interpretation_id,
          updated_at = now()
      where id = v_existing.id
      returning * into v_result;
    return v_result;
  end if;

  insert into public.credit_ledger_entries
    (job_id, org_id, credit_rule_id, entry_type, status, planned_invoice_id, amount_minor, currency,
     window_start, window_end, details, is_one_time, source_clause, commercial_rule_interpretation_id)
    values
    (p_job_id, v_org_id, p_credit_rule_id, 'application', 'reserved', p_planned_invoice_id, v_applied, p_currency,
     p_period_start, p_period_start, p_details, p_is_one_time, p_source_clause, p_commercial_rule_interpretation_id)
    returning * into v_result;
  return v_result;
end;
$$;

-- Locked down independently of the table's own RLS — a security definer
-- function runs with the function owner's privileges regardless of the
-- caller's RLS standing, so table-level RLS alone is not sufficient.
revoke execute on function reserve_credit_balance(uuid, text, uuid, date, bigint, text, jsonb, boolean, text, uuid) from public;
revoke execute on function reserve_credit_balance(uuid, text, uuid, date, bigint, text, jsonb, boolean, text, uuid) from anon;
revoke execute on function reserve_credit_balance(uuid, text, uuid, date, bigint, text, jsonb, boolean, text, uuid) from authenticated;
grant  execute on function reserve_credit_balance(uuid, text, uuid, date, bigint, text, jsonb, boolean, text, uuid) to service_role;
