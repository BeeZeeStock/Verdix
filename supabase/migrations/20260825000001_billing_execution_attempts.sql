-- Step 14 — immutable billing execution attempts and provider-safe
-- idempotency. A durable execution identity that survives HTTP retries and
-- process crashes: an HTTP request and a financial execution are different
-- identities (item 11) — two Approve requests racing the same job must
-- converge on ONE attempt, never two.

create table if not exists billing_execution_attempts (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null references organizations(id) on delete cascade,
  job_id                    uuid not null references jobs(id) on delete cascade,
  provider                  text not null check (provider in ('stripe', 'remembill', 'chargebee')),
  attempt_number            integer not null,
  billing_plan_fingerprint  text not null,
  -- The deterministic snapshot the fingerprint was computed from (item 3) —
  -- never raw contract clauses/prompts/model reasoning/free-text notes,
  -- only the same amount/currency/component/tax/due-date facts already
  -- necessarily sent to the billing platform itself.
  billing_plan_snapshot     jsonb not null,
  status                    text not null default 'created'
                            check (status in ('created', 'executing', 'succeeded', 'failed_safe', 'outcome_uncertain', 'cancelled')),
  created_at                timestamptz not null default now(),
  started_at                timestamptz,
  completed_at              timestamptz,
  retry_of_attempt_id       uuid references billing_execution_attempts(id),
  constraint billing_execution_attempts_number_positive check (attempt_number >= 1)
);

-- Item 11 — at most one ACTIVE (non-terminal) execution attempt per
-- (job, provider), regardless of fingerprint — the smallest invariant
-- strictly stronger than "per fingerprint", since only one billing
-- attempt should ever be genuinely in flight for a given job+provider at
-- a time (the APPROVING claim already serializes at the job level; this
-- is the belt-and-braces DB-level guarantee for the execution layer
-- itself, never relying on process memory).
create unique index if not exists billing_execution_attempts_one_active_uidx
  on billing_execution_attempts (job_id, provider)
  where status in ('created', 'executing');

create index if not exists billing_execution_attempts_job_idx on billing_execution_attempts (job_id, provider, created_at desc);
create index if not exists billing_execution_attempts_org_idx on billing_execution_attempts (org_id);

-- Item 19 — identity fields are immutable once a row exists at all (not
-- merely once "executing" — the smallest, simplest rule that still
-- satisfies "once executing, immutable", since nothing legitimate ever
-- needs to change these after creation regardless of status). Status and
-- the three timestamp fields are state, not identity, and remain mutable.
create or replace function billing_execution_attempts_enforce_identity_immutability()
returns trigger language plpgsql as $$
begin
  if new.org_id is distinct from old.org_id
    or new.job_id is distinct from old.job_id
    or new.provider is distinct from old.provider
    or new.attempt_number is distinct from old.attempt_number
    or new.billing_plan_fingerprint is distinct from old.billing_plan_fingerprint
    or new.billing_plan_snapshot is distinct from old.billing_plan_snapshot
    or new.retry_of_attempt_id is distinct from old.retry_of_attempt_id
  then
    raise exception 'billing_execution_attempts: identity fields are immutable once created (id=%)', old.id;
  end if;
  return new;
end;
$$;

drop trigger if exists billing_execution_attempts_immutability on billing_execution_attempts;
create trigger billing_execution_attempts_immutability
  before update on billing_execution_attempts
  for each row execute function billing_execution_attempts_enforce_identity_immutability();

alter table billing_execution_attempts enable row level security;
create policy "billing_execution_attempts_service_role_only" on billing_execution_attempts
  for all to service_role using (true) with check (true);


create table if not exists billing_execution_operations (
  id                    uuid primary key default gen_random_uuid(),
  attempt_id            uuid not null references billing_execution_attempts(id) on delete cascade,
  operation_key         text not null,
  operation_type        text not null,
  idempotency_key       text,
  status                text not null default 'pending'
                        check (status in ('pending', 'started', 'succeeded', 'failed_safe', 'outcome_uncertain')),
  external_object_id    text,
  request_fingerprint   text not null,
  retry_capability      text not null check (retry_capability in ('idempotent_retry', 'reconcilable', 'manual_verification_required')),
  -- Normalized error class/code only (item 15) — never a raw provider
  -- error dump, which could carry secrets or customer PII.
  error_class           text,
  started_at            timestamptz,
  completed_at          timestamptz,
  created_at            timestamptz not null default now(),
  unique (attempt_id, operation_key)
);

create index if not exists billing_execution_operations_attempt_idx on billing_execution_operations (attempt_id);

-- Item 20 — an operation's identity (which attempt, which key/type,
-- its idempotency key, and the fingerprint of the request it represents,
-- and its declared retry capability) never changes once inserted. Only
-- status, external_object_id, error_class, and the two timestamps are
-- state — and external_object_id/error_class are further restricted below
-- to a one-way null -> value transition (an append-only fact, never
-- silently rewritten).
create or replace function billing_execution_operations_enforce_identity_immutability()
returns trigger language plpgsql as $$
begin
  if new.attempt_id is distinct from old.attempt_id
    or new.operation_key is distinct from old.operation_key
    or new.operation_type is distinct from old.operation_type
    or new.idempotency_key is distinct from old.idempotency_key
    or new.request_fingerprint is distinct from old.request_fingerprint
    or new.retry_capability is distinct from old.retry_capability
  then
    raise exception 'billing_execution_operations: identity fields are immutable once created (id=%)', old.id;
  end if;
  if old.external_object_id is not null and new.external_object_id is distinct from old.external_object_id then
    raise exception 'billing_execution_operations: external_object_id cannot be changed once recorded (id=%)', old.id;
  end if;
  if old.error_class is not null and new.error_class is distinct from old.error_class then
    raise exception 'billing_execution_operations: error_class cannot be changed once recorded (id=%)', old.id;
  end if;
  return new;
end;
$$;

drop trigger if exists billing_execution_operations_immutability on billing_execution_operations;
create trigger billing_execution_operations_immutability
  before update on billing_execution_operations
  for each row execute function billing_execution_operations_enforce_identity_immutability();

alter table billing_execution_operations enable row level security;
create policy "billing_execution_operations_service_role_only" on billing_execution_operations
  for all to service_role using (true) with check (true);


-- Item 24 — immutable administrative execution actions (retry
-- authorization, operation reconciliation, attempt abandonment). The RLS
-- policy below grants INSERT and SELECT to service_role only, never
-- UPDATE/DELETE — but that alone is NOT sufficient enforcement: confirmed
-- live that service_role bypasses row level security entirely in this
-- project (Supabase's standard default), so RLS policies never apply to it
-- regardless of what is/isn't granted. The real, working enforcement is
-- 20260825000002_billing_execution_admin_actions_append_only.sql's
-- trigger, which rejects every UPDATE unconditionally for every role —
-- triggers fire at the executor level regardless of RLS. DELETE is
-- deliberately left to the normal job-cascade path (see
-- 20260825000003_billing_execution_admin_actions_allow_cascade_delete.sql
-- for why an unconditional DELETE block was also tried and reverted —
-- mutation, not whole-record deletion via an already-existing job-delete
-- feature, is the real risk this guards against).
create table if not exists billing_execution_admin_actions (
  id                  uuid primary key default gen_random_uuid(),
  attempt_id          uuid not null references billing_execution_attempts(id) on delete cascade,
  operation_id        uuid references billing_execution_operations(id) on delete cascade,
  action              text not null check (action in ('retry_authorized', 'operation_verified_succeeded', 'operation_verified_not_executed', 'attempt_abandoned')),
  actor_email         text not null,
  external_object_id  text,
  created_at          timestamptz not null default now()
);

create index if not exists billing_execution_admin_actions_attempt_idx on billing_execution_admin_actions (attempt_id);

alter table billing_execution_admin_actions enable row level security;
create policy "billing_execution_admin_actions_service_role_insert_select" on billing_execution_admin_actions
  for select to service_role using (true);
create policy "billing_execution_admin_actions_service_role_insert" on billing_execution_admin_actions
  for insert to service_role with check (true);
-- Deliberately no update/delete policy for ANY role, including
-- service_role — append-only by construction, not just by convention.
