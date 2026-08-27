-- Step 17C.1a — reworked before first application (was still unapplied):
-- the smallest real persistence boundary for a MONETARY operational input
-- (e.g. paid_invoice_value, total_invoice_value_of_issued_requests) that
-- has no countable-usage-meter equivalent and no live connector to pull it
-- from. contract_meter_mappings' manual_value_configured column is only
-- ever a boolean INTENT flag with nowhere to persist the actual entered
-- number; this table is that missing persistence layer.
--
-- Append/revoke discipline — same pattern as candidate_unit_evidence
-- (supabase/migrations/20260830000008_billable_unit_candidates_evidence.sql)
-- and operational_event_evidence (20260824000001), NOT the original
-- single-mutable-row-per-period design: a financial fact used to calculate
-- a real economic obligation must be historically REPLAYABLE. Correcting a
-- FINALIZED value means revoking the old row (status/revoked_at/revoked_by)
-- and inserting a NEW row with the corrected value — this table has no
-- UPDATE path for value/currency/finalized_at at all, only for the three
-- revocation columns (see revoke_operational_input_period_value below), so
-- a corrected fact can never silently overwrite what an earlier asOf
-- replay already saw.
--
-- finalized_at is separate from recorded_at: a row with finalized_at null
-- is a DRAFT (never used in a real calculation — "Only final values may
-- execute billing"); "Mark final" always inserts a NEW row (recorded_at =
-- now, finalized_at = now), revoking any prior active draft for the same
-- (job_id, input_key, period) — finalizing is never an in-place mutation
-- of the draft row, keeping every row's substantive fields immutable from
-- the moment of insert, with no special-cased "still mutable pre-finalize"
-- exception to reason about.
create table if not exists operational_input_period_values (
  id           uuid primary key default gen_random_uuid(),
  job_id       uuid not null references jobs(id) on delete cascade,
  org_id       uuid not null references organizations(id) on delete cascade,
  input_key    text not null,
  period_start date not null,
  period_end   date not null,

  value        numeric not null,
  currency     text,

  recorded_at  timestamptz not null default now(),
  recorded_by  text not null check (char_length(recorded_by) > 0),

  -- null = draft. Set once, at insert time, on a row that's already final
  -- from the moment it exists — never mutated afterward (see the
  -- append-only trigger below).
  finalized_at timestamptz,

  status       text not null default 'active' check (status in ('active', 'revoked')),
  revoked_at   timestamptz,
  revoked_by   text,

  created_at   timestamptz not null default now(),

  constraint operational_input_period_values_period_valid check (period_end >= period_start),
  constraint operational_input_period_values_value_nonnegative check (value >= 0),

  constraint operational_input_period_values_revocation_shape check (
    (status = 'active'  and revoked_at is null     and revoked_by is null)
    or
    (status = 'revoked' and revoked_at is not null and revoked_by is not null)
  ),

  -- A revocation cannot historically predate the value becoming known to
  -- Verdix — the asOf model's whole "recorded_at <= asOf AND (revoked_at
  -- IS NULL OR revoked_at > asOf)" invariant only makes sense if
  -- revoked_at is always at-or-after recorded_at; without this, a caller
  -- could construct a revocation that retroactively erases a value from a
  -- window where it was legitimately the known fact.
  constraint operational_input_period_values_revocation_not_before_recorded check (
    revoked_at is null or revoked_at >= recorded_at
  ),
  constraint operational_input_period_values_finalized_not_before_recorded check (
    finalized_at is null or finalized_at >= recorded_at
  )
);

-- Ownership (job_id -> org_id) is verified at the APPLICATION layer
-- (app/api/jobs/[id]/operational-input-values/route.ts's requireOrg() +
-- job lookup scoped to org_id) — same boundary philosophy as every other
-- table in this schema (RLS is not the enforcement boundary, requireOrg()
-- is; see supabase/migrations/20260819000003_rls_lockdown.sql's own header).
-- No composite (job_id, org_id) FK here: the jobs table has no unique
-- constraint on that pair to reference.

-- At most one ACTIVE row per (job, input_key, period) at a time — a
-- partial unique index, not a plain unique constraint, so a revoked row
-- never blocks a corrected re-insert for the same period.
create unique index if not exists operational_input_period_values_active_uidx
  on operational_input_period_values (job_id, input_key, period_start, period_end)
  where status = 'active';

create index if not exists operational_input_period_values_job_idx
  on operational_input_period_values (job_id, input_key);

-- Same lockdown convention as every table 20260819000003_rls_lockdown.sql
-- covers — service_role only, anon/authenticated structurally denied (no
-- `to` clause on a policy applies to PUBLIC, which is exactly the
-- vulnerability class that migration fixed).
alter table operational_input_period_values enable row level security;
create policy "service_role_only" on operational_input_period_values
  for all to service_role using (true) with check (true);
revoke all on operational_input_period_values from anon, authenticated;

-- Truly append-only, not append-only "by convention." Blocks any UPDATE
-- that touches the substantive/identity columns — a correction (or a
-- draft->final transition) must be a NEW row (append) plus a revocation of
-- the old one, never a rewrite. Also blocks re-revoking an already-revoked
-- row (defense in depth alongside revoke_operational_input_period_value's
-- own WHERE status = 'active' clause). The ONLY update this trigger
-- allows is the intended active -> revoked transition performed by that
-- function.
create or replace function prevent_operational_input_period_value_rewrite()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.job_id is distinct from old.job_id
     or new.org_id is distinct from old.org_id
     or new.input_key is distinct from old.input_key
     or new.period_start is distinct from old.period_start
     or new.period_end is distinct from old.period_end
     or new.value is distinct from old.value
     or new.currency is distinct from old.currency
     or new.recorded_at is distinct from old.recorded_at
     or new.recorded_by is distinct from old.recorded_by
     or new.finalized_at is distinct from old.finalized_at
  then
    raise exception 'operational_input_period_values: substantive fields (job_id, org_id, input_key, period_start, period_end, value, currency, recorded_at, recorded_by, finalized_at) are append-only and immutable once inserted — correct via a new row plus revocation of this one, never an in-place rewrite (row %)', old.id;
  end if;
  if old.status = 'revoked' then
    raise exception 'operational_input_period_values: row % is already revoked — revocation is a one-way transition and cannot be repeated or reverted', old.id;
  end if;
  return new;
end;
$$;

create trigger operational_input_period_values_append_only
  before update on operational_input_period_values
  for each row execute function prevent_operational_input_period_value_rewrite();

-- Narrowly scoped, service-role-only atomic revocation — the ONLY UPDATE
-- path this table has. The WHERE clause re-checks status = 'active' at the
-- moment of write, so a concurrent double-revoke matches zero rows and the
-- caller observes that rather than clobbering the first revocation.
create or replace function revoke_operational_input_period_value(
  p_value_id uuid, p_revoked_at timestamptz, p_revoked_by text
) returns setof operational_input_period_values
language sql
security invoker
set search_path = ''
as $$
  update public.operational_input_period_values
  set status = 'revoked', revoked_at = p_revoked_at, revoked_by = p_revoked_by
  where id = p_value_id and status = 'active'
  returning *;
$$;

revoke execute on function revoke_operational_input_period_value(uuid, timestamptz, text) from public;
revoke execute on function revoke_operational_input_period_value(uuid, timestamptz, text) from anon;
revoke execute on function revoke_operational_input_period_value(uuid, timestamptz, text) from authenticated;
grant  execute on function revoke_operational_input_period_value(uuid, timestamptz, text) to service_role;

-- Step 17C.1b, item A — the route previously did "find active row -> RPC
-- revoke -> plain insert" as two separate service-role calls. Two
-- concurrent "Save draft"/"Mark final" submissions for the SAME
-- (job, input_key, period) could both read "no active row yet" (or both
-- read the SAME active row) before either had revoked/inserted anything,
-- then both insert — the second insert would either violate the partial
-- unique index (a benign failure) or, in a narrower interleaving, leave
-- the table in a state where the "revoke" half completed but the "insert"
-- half of one caller's own replacement never did (a genuinely lost write,
-- indistinguishable from data loss to the caller). This single atomic
-- function is now the ONLY way the application ever performs a
-- draft/final save — lock, revoke-if-present, insert, return, all inside
-- one transaction, exactly like the credit ledger's own
-- reserve_credit_balance (supabase/migrations/20260821000001_credit_ledger.sql)
-- uses pg_advisory_xact_lock for the identical class of "read balance,
-- decide, write" race.
create or replace function replace_operational_input_period_value(
  p_job_id uuid, p_org_id uuid, p_input_key text, p_period_start date, p_period_end date,
  p_value numeric, p_currency text, p_recorded_by text, p_is_final boolean
) returns operational_input_period_values
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_existing_id uuid;
  v_new_row public.operational_input_period_values;
begin
  -- Scoped per (job, input_key, period) — not per-job like the credit
  -- ledger's own lock — a concurrent save for a DIFFERENT input_key or
  -- period on the same job is unrelated and must not be serialized behind
  -- this one. hashtextextended's own seed argument (0) matches the
  -- existing reserve_credit_balance convention.
  perform pg_advisory_xact_lock(hashtextextended(
    p_job_id::text || '|' || p_input_key || '|' || p_period_start::text || '|' || p_period_end::text, 0
  ));

  select id into v_existing_id
  from public.operational_input_period_values
  where job_id = p_job_id and input_key = p_input_key
    and period_start = p_period_start and period_end = p_period_end
    and status = 'active';

  if v_existing_id is not null then
    update public.operational_input_period_values
    set status = 'revoked', revoked_at = v_now, revoked_by = p_recorded_by
    where id = v_existing_id;
  end if;

  insert into public.operational_input_period_values (
    job_id, org_id, input_key, period_start, period_end, value, currency,
    recorded_at, recorded_by, finalized_at
  ) values (
    p_job_id, p_org_id, p_input_key, p_period_start, p_period_end, p_value, p_currency,
    v_now, p_recorded_by, case when p_is_final then v_now else null end
  )
  returning * into v_new_row;

  return v_new_row;
end;
$$;

revoke execute on function replace_operational_input_period_value(uuid, uuid, text, date, date, numeric, text, text, boolean) from public;
revoke execute on function replace_operational_input_period_value(uuid, uuid, text, date, date, numeric, text, text, boolean) from anon;
revoke execute on function replace_operational_input_period_value(uuid, uuid, text, date, date, numeric, text, text, boolean) from authenticated;
grant  execute on function replace_operational_input_period_value(uuid, uuid, text, date, date, numeric, text, text, boolean) to service_role;
