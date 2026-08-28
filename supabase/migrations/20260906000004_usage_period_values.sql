-- Step 17D, item 13 — a real manual-usage-value model, distinct from
-- lib/operational-input-binding.ts's operational_input_period_values
-- (Step 17C.1a). Audited first (this session): the only existing
-- "manual" value on the meter side is billing_meters.mode='test' +
-- test_usage_value — a single admin-typed number PER METER (not per job,
-- not per period, no finality, explicitly documented in the architecture
-- audit as a simulation aid, never intended as production manual usage.
-- No real per-job/per-period manual usage-value model exists today.
--
-- Deliberately a SEPARATE table from operational_input_period_values, not
-- a shared one (item 13/14's explicit instruction) — usage facts
-- (issued_payment_request_count, completed_payment_count, ...) and
-- operational KPIs (paid_invoice_value, milestone_approved, ...) are two
-- different product surfaces (Usage metric vs Operational KPI in the
-- review UX) with different semantics (a usage fact is always a plain
-- count with no currency; see lib/usage-quantity-resolver.ts) even though
-- the append/revoke/finality DISCIPLINE below is intentionally identical
-- to that table's — same proven pattern, not a proven table.
create table if not exists usage_period_values (
  id              uuid primary key default gen_random_uuid(),
  job_id          uuid not null references jobs(id) on delete cascade,
  org_id          uuid not null references organizations(id) on delete cascade,
  semantic_input_key text not null,
  period_start    date not null,
  period_end      date not null,

  quantity        numeric not null,

  recorded_at     timestamptz not null default now(),
  recorded_by     text not null check (char_length(recorded_by) > 0),

  -- null = draft, exactly like operational_input_period_values —
  -- lib/usage-quantity-resolver.ts only ever resolves a finalized row for
  -- a real commercial-rule calculation.
  finalized_at    timestamptz,

  status          text not null default 'active' check (status in ('active', 'revoked')),
  revoked_at      timestamptz,
  revoked_by      text,

  created_at      timestamptz not null default now(),

  constraint usage_period_values_period_valid check (period_end >= period_start),
  constraint usage_period_values_quantity_nonnegative check (quantity >= 0),
  constraint usage_period_values_revocation_shape check (
    (status = 'active'  and revoked_at is null     and revoked_by is null)
    or
    (status = 'revoked' and revoked_at is not null and revoked_by is not null)
  ),
  constraint usage_period_values_revocation_not_before_recorded check (
    revoked_at is null or revoked_at >= recorded_at
  ),
  constraint usage_period_values_finalized_not_before_recorded check (
    finalized_at is null or finalized_at >= recorded_at
  )
);

create unique index if not exists usage_period_values_active_uidx
  on usage_period_values (job_id, semantic_input_key, period_start, period_end)
  where status = 'active';

create index if not exists usage_period_values_job_idx
  on usage_period_values (job_id, semantic_input_key);

alter table usage_period_values enable row level security;
create policy "service_role_only" on usage_period_values
  for all to service_role using (true) with check (true);
revoke all on usage_period_values from anon, authenticated;

create or replace function prevent_usage_period_value_rewrite()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.job_id is distinct from old.job_id
     or new.org_id is distinct from old.org_id
     or new.semantic_input_key is distinct from old.semantic_input_key
     or new.period_start is distinct from old.period_start
     or new.period_end is distinct from old.period_end
     or new.quantity is distinct from old.quantity
     or new.recorded_at is distinct from old.recorded_at
     or new.recorded_by is distinct from old.recorded_by
     or new.finalized_at is distinct from old.finalized_at
  then
    raise exception 'usage_period_values: substantive fields are append-only and immutable once inserted — correct via a new row plus revocation of this one (row %)', old.id;
  end if;
  if old.status = 'revoked' then
    raise exception 'usage_period_values: row % is already revoked — revocation is a one-way transition', old.id;
  end if;
  return new;
end;
$$;

create trigger usage_period_values_append_only
  before update on usage_period_values
  for each row execute function prevent_usage_period_value_rewrite();

-- Same atomic lock -> revoke-if-present -> insert -> return shape as
-- replace_operational_input_period_value (20260903000001), applied to
-- this separate table.
create or replace function replace_usage_period_value(
  p_job_id uuid, p_org_id uuid, p_semantic_input_key text, p_period_start date, p_period_end date,
  p_quantity numeric, p_recorded_by text, p_is_final boolean
) returns usage_period_values
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_existing_id uuid;
  v_new_row public.usage_period_values;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    p_job_id::text || '|' || p_semantic_input_key || '|' || p_period_start::text || '|' || p_period_end::text, 1
  ));

  select id into v_existing_id
  from public.usage_period_values
  where job_id = p_job_id and semantic_input_key = p_semantic_input_key
    and period_start = p_period_start and period_end = p_period_end
    and status = 'active';

  if v_existing_id is not null then
    update public.usage_period_values
    set status = 'revoked', revoked_at = v_now, revoked_by = p_recorded_by
    where id = v_existing_id;
  end if;

  insert into public.usage_period_values (
    job_id, org_id, semantic_input_key, period_start, period_end, quantity,
    recorded_at, recorded_by, finalized_at
  ) values (
    p_job_id, p_org_id, p_semantic_input_key, p_period_start, p_period_end, p_quantity,
    v_now, p_recorded_by, case when p_is_final then v_now else null end
  )
  returning * into v_new_row;

  return v_new_row;
end;
$$;

revoke execute on function replace_usage_period_value(uuid, uuid, text, date, date, numeric, text, boolean) from public;
revoke execute on function replace_usage_period_value(uuid, uuid, text, date, date, numeric, text, boolean) from anon;
revoke execute on function replace_usage_period_value(uuid, uuid, text, date, date, numeric, text, boolean) from authenticated;
grant  execute on function replace_usage_period_value(uuid, uuid, text, date, date, numeric, text, boolean) to service_role;

NOTIFY pgrst, 'reload schema';
