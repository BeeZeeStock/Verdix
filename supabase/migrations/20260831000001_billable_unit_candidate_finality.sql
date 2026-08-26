-- Step 16B.3 — Candidate + evidence -> completeness/finality evaluation ->
-- pending | qualified | rejected. Builds on 16B.1 (billable_unit_
-- qualification_rules, migration 20260830000007) and 16B.2 (source_bindings/
-- billable_unit_candidates/candidate_unit_evidence, migration
-- 20260830000008) WITHOUT editing either already-applied migration file —
-- everything below is either a brand-new table or an additive ALTER/
-- CREATE OR REPLACE against 16B.2's tables. Deliberately does NOT connect a
-- terminal decision to billing/usage/scheduler/pricing/Stripe/Remembill —
-- see lib/billable-unit-candidate-finality.ts's own scope note.

-- ── source_coverage ────────────────────────────────────────────────────
-- Historical completeness primitive (lib/source-coverage.ts) — generic and
-- reusable for ANY future terminal-decision domain needing "we watched
-- this window of a source completely," not just candidate-discovery/
-- rejection-source completeness in THIS slice. SourceBinding-scoped (not
-- source_role-scoped), same reasoning as candidate_unit_evidence: a
-- completeness assertion is a property of a concrete pulled instance.
create table if not exists source_coverage (
  id                 uuid primary key default gen_random_uuid(),
  job_id             uuid not null references jobs(id) on delete cascade,
  org_id             uuid not null references organizations(id) on delete cascade,
  -- No direct single-column FK on source_binding_id — the composite FK
  -- below (job_id/org_id included) subsumes it and additionally
  -- guarantees the referenced binding genuinely belongs to THIS coverage
  -- row's own job/org, same DB-ownership-chain pattern as source_bindings/
  -- billable_unit_candidates/candidate_unit_evidence.
  source_binding_id  uuid not null,

  -- 'fact_evidence' added in the contractual-finality hardening pass —
  -- deliberately the SAME closed vocabulary as the other two kinds (see
  -- lib/source-coverage.ts's own comment), not a second subsystem.
  coverage_kind      text not null check (coverage_kind in ('candidate_discovery', 'rejection_source', 'fact_evidence')),
  covered_from       timestamptz not null,
  covered_through    timestamptz not null,
  -- Mandatory discovery-time safety rail (lib/source-coverage.ts's own
  -- design note, anticipated by lib/billable-unit-qualification.ts back in
  -- 16B.1) — a coverage row may only be CONSULTED by an evaluation running
  -- at some asOf when established_at <= asOf, so a coverage row created or
  -- extended later can never leak future completeness knowledge into a
  -- historical replay.
  established_at     timestamptz not null,
  completeness_basis text not null check (completeness_basis in ('connector_high_watermark', 'bounded_lag_policy', 'reviewer_attestation')),
  -- Contractual-finality hardening — coverage can now enable an
  -- IRREVERSIBLE terminal decision, so it must never be anonymous: who/
  -- what established this assertion (e.g. 'connector:crm-sync-job-42',
  -- 'reviewer:alice@example.com'). Not a foreign key — this schema has no
  -- single canonical identity table every completeness_basis could
  -- reference (a connector job has no user row at all); mandatory,
  -- non-empty free text is the smallest generic field that closes the
  -- audit gap without a new subsystem.
  established_by     text not null check (char_length(established_by) > 0),
  metadata           jsonb not null default '{}',
  -- Final hardening pass — a narrow, evidence-like correction lifecycle
  -- (see lib/source-coverage.ts's own comment). The substantive payload
  -- above stays permanently immutable; only these three columns can ever
  -- change, exactly once, via revoke_source_coverage below.
  status             text not null default 'active' check (status in ('active', 'revoked')),
  revoked_at         timestamptz,
  revoked_by         text,
  created_at         timestamptz not null default now(),

  constraint source_coverage_interval_shape check (covered_through > covered_from),

  constraint source_coverage_revocation_shape check (
    (status = 'active'  and revoked_at is null     and revoked_by is null)
    or
    (status = 'revoked' and revoked_at is not null and revoked_by is not null)
  ),

  -- Mirrors candidate_unit_evidence_revocation_not_before_recorded — a
  -- revocation cannot historically predate the assertion becoming known
  -- to Verdix; the asOf model's "established_at <= asOf AND (revoked_at
  -- IS NULL OR revoked_at > asOf)" invariant only holds if revoked_at is
  -- always at-or-after established_at.
  constraint source_coverage_revocation_not_before_established check (
    revoked_at is null or revoked_at >= established_at
  ),

  constraint source_coverage_binding_ownership_fk
    foreign key (source_binding_id, job_id, org_id)
    references source_bindings (id, job_id, org_id)
    on delete cascade
);
create index if not exists source_coverage_binding_kind_idx on source_coverage (source_binding_id, coverage_kind);
create index if not exists source_coverage_job_idx on source_coverage (job_id);

alter table source_coverage enable row level security;
create policy "source_coverage_service_role_only" on source_coverage
  for all to service_role using (true) with check (true);

-- Payload immutable, status a one-way active -> revoked transition only —
-- the SAME discipline as prevent_candidate_unit_evidence_rewrite (16B.2).
-- No UPDATE path in the service layer touches the payload at all
-- (lib/source-coverage-service.ts offers no such function); this trigger
-- is the independent, structural barrier — a mistaken assertion is
-- corrected by revoking it and appending a NEW row, never by rewriting
-- the old interval.
create or replace function prevent_source_coverage_rewrite()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.job_id is distinct from old.job_id
     or new.org_id is distinct from old.org_id
     or new.source_binding_id is distinct from old.source_binding_id
     or new.coverage_kind is distinct from old.coverage_kind
     or new.covered_from is distinct from old.covered_from
     or new.covered_through is distinct from old.covered_through
     or new.completeness_basis is distinct from old.completeness_basis
     or new.established_at is distinct from old.established_at
     or new.established_by is distinct from old.established_by
     or new.metadata is distinct from old.metadata
  then
    raise exception 'source_coverage: substantive fields are immutable once inserted — correct via revoke_source_coverage plus a new, corrected coverage row, never an in-place rewrite (coverage %)', old.id;
  end if;
  if old.status = 'revoked' then
    raise exception 'source_coverage: coverage % is already revoked — revocation is a one-way transition and cannot be repeated or reverted', old.id;
  end if;
  return new;
end;
$$;

create trigger source_coverage_append_only
  before update on source_coverage
  for each row execute function prevent_source_coverage_rewrite();

-- The ONE update path this table has — atomic, re-checks status = 'active'
-- in its own WHERE clause so a concurrent double-revoke matches zero rows
-- rather than clobbering the first revocation's revoked_at/revoked_by.
-- Same idiom as revoke_candidate_evidence (20260830000008).
create or replace function revoke_source_coverage(
  p_coverage_id uuid, p_revoked_at timestamptz, p_revoked_by text
) returns setof source_coverage
language sql
security invoker
set search_path = ''
as $$
  update public.source_coverage
  set status = 'revoked', revoked_at = p_revoked_at, revoked_by = p_revoked_by
  where id = p_coverage_id and status = 'active'
  returning *;
$$;

revoke execute on function revoke_source_coverage(uuid, timestamptz, text) from public;
revoke execute on function revoke_source_coverage(uuid, timestamptz, text) from anon;
revoke execute on function revoke_source_coverage(uuid, timestamptz, text) from authenticated;
grant  execute on function revoke_source_coverage(uuid, timestamptz, text) to service_role;

-- ── billable_unit_candidates — widen the 16B.2-only lifecycle ───────────
-- 16B.2's migration (20260830000008, already applied, not edited here)
-- hard-constrained status/rejection_deadline/decided_at to their 16B.2-only
-- values as a deliberate floor: "even a bug in 16B.2 application code
-- cannot produce a qualified/rejected row." 16B.3 is exactly the slice
-- that widens that floor, additively, via ordinary ALTERs against an
-- already-applied table — never an edit to 20260830000008's file.
alter table billable_unit_candidates drop constraint if exists billable_unit_candidates_rejection_deadline_null_in_16b2;
alter table billable_unit_candidates drop constraint if exists billable_unit_candidates_decided_at_null_in_16b2;
alter table billable_unit_candidates drop constraint if exists billable_unit_candidates_status_check;

alter table billable_unit_candidates
  add constraint billable_unit_candidates_status_check
  check (status in ('pending', 'qualified', 'rejected'));

-- decided_at is populated ATOMICALLY with every terminal transition
-- (never independently) — see finalize_billable_unit_candidate below,
-- the only write path for this column going forward. Unconditional: every
-- terminal decision, whatever path reached it, records WHEN it was
-- decided.
alter table billable_unit_candidates
  add constraint billable_unit_candidates_terminal_decided_at_shape
  check ((status = 'pending' and decided_at is null) or (status <> 'pending' and decided_at is not null));

-- Materiality-aware terminalization (final hardening pass) — rejection_
-- deadline is deliberately NOT required on every terminal row. A
-- definitive criteria failure or a positive dedupe match can reject
-- without the rejection window ever being material to that decision (see
-- lib/billable-unit-candidate-finality.ts's own design note) — forcing a
-- deadline onto that row would misrepresent what the decision actually
-- depended on, which defeats the entire point of this pass. Only the
-- weaker, direction-only invariant is enforced at the DB level: a
-- candidate still 'pending' must never carry a deadline (a deadline is
-- only ever written atomically alongside a terminal transition — see
-- finalize_billable_unit_candidate). Deliberately NOT a stronger,
-- path-aware constraint (e.g. "qualified must have one") — inferring
-- WHICH decision path was taken from column values alone would require
-- exactly the complicated, decision-semantics-duplicating CHECK
-- constraint this pass was told not to build; that guarantee is upheld
-- by the evaluator + service layer instead (see
-- lib/billable-unit-candidate-finality-service.ts).
alter table billable_unit_candidates
  add constraint billable_unit_candidates_pending_rejection_deadline_null
  check (status <> 'pending' or rejection_deadline is null);

-- Terminal immutability (pre-commit hardening discipline carried forward
-- from 16B.1/16B.2: a trigger, not merely "no update path exists" in
-- application code). Deliberately a SEPARATE trigger from 16B.2's
-- billable_unit_candidates_pin_immutable (20260830000008 — not edited
-- here) rather than widening that function: this trigger's job is
-- narrower — once status leaves 'pending', status/decided_at/
-- rejection_deadline may never change again (qualified -> pending,
-- rejected -> pending, and qualified <-> rejected are all blocked) — but
-- the PENDING -> terminal transition itself must still be allowed, which
-- is why the check is gated on OLD.status, not a blanket block.
create or replace function prevent_billable_unit_candidate_terminal_rewrite()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.status <> 'pending' then
    if new.status is distinct from old.status
       or new.decided_at is distinct from old.decided_at
       or new.rejection_deadline is distinct from old.rejection_deadline
    then
      raise exception 'billable_unit_candidates: candidate % already has a terminal decision (status=%) — status/decided_at/rejection_deadline are immutable once terminal; no correction/versioning mechanism exists in this slice', old.id, old.status;
    end if;
  end if;
  return new;
end;
$$;

create trigger billable_unit_candidates_terminal_immutable
  before update on billable_unit_candidates
  for each row execute function prevent_billable_unit_candidate_terminal_rewrite();

-- The ONE atomic transition this slice permits: pending -> qualified |
-- rejected, with decided_at and rejection_deadline BOTH set in the SAME
-- statement (never two separate writes) — decided_at always to a real
-- timestamp, rejection_deadline to whatever the caller passes, including
-- NULL when the selected decision path never depended on it (see
-- lib/billable-unit-candidate-finality-service.ts — this function has no
-- opinion on that, it just persists what it's given). The WHERE
-- status = 'pending' clause makes this naturally idempotent-safe under
-- concurrency — a second concurrent call (or a call against an
-- already-terminal candidate) matches zero rows rather than
-- double-finalizing or erroring, and the terminal-immutability trigger
-- above is the independent backstop even if this WHERE clause were ever
-- bypassed some other way.
create or replace function finalize_billable_unit_candidate(
  p_candidate_id uuid, p_status text, p_decided_at timestamptz, p_rejection_deadline timestamptz
) returns setof billable_unit_candidates
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_status not in ('qualified', 'rejected') then
    raise exception 'finalize_billable_unit_candidate: p_status must be ''qualified'' or ''rejected'', got %', p_status;
  end if;
  return query
  update public.billable_unit_candidates
  set status = p_status, decided_at = p_decided_at, rejection_deadline = p_rejection_deadline
  where id = p_candidate_id and status = 'pending'
  returning *;
end;
$$;

revoke execute on function finalize_billable_unit_candidate(uuid, text, timestamptz, timestamptz) from public;
revoke execute on function finalize_billable_unit_candidate(uuid, text, timestamptz, timestamptz) from anon;
revoke execute on function finalize_billable_unit_candidate(uuid, text, timestamptz, timestamptz) from authenticated;
grant  execute on function finalize_billable_unit_candidate(uuid, text, timestamptz, timestamptz) to service_role;

-- ── billable_unit_qualification_rules — contractual-finality hardening ──
-- 16B.1's migration (20260830000007, already applied, not edited here)
-- has no columns for the two new rule-configuration fields this pass
-- introduces. Ordinary additive ALTERs, same idiom as
-- billable_unit_qualification_rules_pin_target_uidx above (20260830000008).
alter table billable_unit_qualification_rules
  add column if not exists business_day_end_local_time jsonb not null default '{"value":null,"state":"decision_required","provenance":null}'::jsonb;

alter table billable_unit_qualification_rules
  add column if not exists fact_evidence_source_roles jsonb not null default '{}'::jsonb;

-- Widens confirm_qualification_rule_field (20260830000007 — already
-- applied, cannot be edited in place) to accept the new independent
-- 'business_day_end_local_time' column, via CREATE OR REPLACE FUNCTION —
-- the same ordinary, idiomatic widening already used for
-- set_qualification_rule_contact_role_field in 20260830000008. Every
-- existing branch is byte-for-byte unchanged; only one elsif is added.
create or replace function confirm_qualification_rule_field(
  p_rule_id uuid, p_column text, p_value jsonb
) returns setof billable_unit_qualification_rules
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_column = 'criteria' then
    return query update public.billable_unit_qualification_rules
      set criteria = p_value, revision = revision + 1, updated_at = now()
      where id = p_rule_id and status = 'draft'
      returning *;
  elsif p_column = 'dedupe_rule' then
    return query update public.billable_unit_qualification_rules
      set dedupe_rule = p_value, revision = revision + 1, updated_at = now()
      where id = p_rule_id and status = 'draft'
      returning *;
  elsif p_column = 'rejection_rule' then
    return query update public.billable_unit_qualification_rules
      set rejection_rule = p_value, revision = revision + 1, updated_at = now()
      where id = p_rule_id and status = 'draft'
      returning *;
  elsif p_column = 'rejection_window' then
    return query update public.billable_unit_qualification_rules
      set rejection_window = p_value, revision = revision + 1, updated_at = now()
      where id = p_rule_id and status = 'draft'
      returning *;
  elsif p_column = 'deadline_convention' then
    return query update public.billable_unit_qualification_rules
      set deadline_convention = p_value, revision = revision + 1, updated_at = now()
      where id = p_rule_id and status = 'draft'
      returning *;
  elsif p_column = 'business_day_end_local_time' then
    return query update public.billable_unit_qualification_rules
      set business_day_end_local_time = p_value, revision = revision + 1, updated_at = now()
      where id = p_rule_id and status = 'draft'
      returning *;
  elsif p_column = 'attribution_basis' then
    return query update public.billable_unit_qualification_rules
      set attribution_basis = p_value, revision = revision + 1, updated_at = now()
      where id = p_rule_id and status = 'draft'
      returning *;
  else
    raise exception 'confirm_qualification_rule_field: unrecognized column %', p_column;
  end if;
end;
$$;

revoke execute on function confirm_qualification_rule_field(uuid, text, jsonb) from public;
revoke execute on function confirm_qualification_rule_field(uuid, text, jsonb) from anon;
revoke execute on function confirm_qualification_rule_field(uuid, text, jsonb) from authenticated;
grant  execute on function confirm_qualification_rule_field(uuid, text, jsonb) to service_role;

-- New sibling to set_qualification_rule_evidence_precedence_key
-- (20260830000007), same generic per-key jsonb_set pattern, targeting the
-- new fact_evidence_source_roles column instead.
create or replace function set_qualification_rule_fact_evidence_source_roles_key(
  p_rule_id uuid, p_key text, p_value jsonb
) returns setof billable_unit_qualification_rules
language sql
security invoker
set search_path = ''
as $$
  update public.billable_unit_qualification_rules
  set fact_evidence_source_roles = jsonb_set(coalesce(fact_evidence_source_roles, '{}'::jsonb), array[p_key], p_value, true),
      revision = revision + 1,
      updated_at = now()
  where id = p_rule_id and status = 'draft'
  returning *;
$$;

revoke execute on function set_qualification_rule_fact_evidence_source_roles_key(uuid, text, jsonb) from public;
revoke execute on function set_qualification_rule_fact_evidence_source_roles_key(uuid, text, jsonb) from anon;
revoke execute on function set_qualification_rule_fact_evidence_source_roles_key(uuid, text, jsonb) from authenticated;
grant  execute on function set_qualification_rule_fact_evidence_source_roles_key(uuid, text, jsonb) to service_role;
