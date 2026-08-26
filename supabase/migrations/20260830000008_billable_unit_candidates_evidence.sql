-- Step 16B.2 — Candidate, Evidence, SourceBinding & deterministic evaluator.
-- Builds on 16B.1's rule/provenance/versioning model WITHOUT changing it:
-- no columns added to source_roles or billable_unit_qualification_rules in
-- this migration. Deliberately does NOT implement SourceCoverage,
-- completeness assertions, business-day arithmetic, rejection_deadline
-- calculation, valid-rejection finalization, or terminal candidate
-- decisions — see lib/billable-unit-candidate.ts's own design notes for
-- what's explicitly deferred to 16B.3/16B.4.

-- ── DB ownership consistency chain (pre-commit hardening audit) ──────────
-- source_roles (migration 20260830000007 — already applied, cannot be
-- edited) has no unique constraint covering (id, job_id, org_id). Same
-- reasoning as billable_unit_qualification_rules_pin_target_uidx below:
-- `id` alone is already globally unique, so this is trivially
-- satisfiable; its purpose is purely to give source_bindings a genuine
-- composite FK target, so a binding cannot be created for a source_role
-- belonging to a different job/org than the binding's own — enforced by
-- Postgres, not solely by application code.
alter table source_roles
  add constraint source_roles_pin_target_uidx
  unique (id, job_id, org_id);

-- ── source_bindings ───────────────────────────────────────────────────────
-- Identity + effective dating only — no connector credentials, URLs, auth,
-- retry policy, or pull mechanics (same scope discipline as source_roles
-- itself). One SourceRole -> many historical SourceBindings: a role_key is
-- the STABLE thing rules/evidence reference; a binding is a dated identity
-- of "which concrete source instance" backed that role_key during some
-- interval (e.g. "crm" role_key resolving to "Salesforce sandbox A" through
-- 2026-09-01, then "Salesforce prod" after a migration).
create table if not exists source_bindings (
  id                    uuid primary key default gen_random_uuid(),
  -- No direct single-column FK on source_role_id — the composite FK below
  -- (job_id/org_id included) subsumes it and additionally guarantees the
  -- referenced role genuinely belongs to THIS binding's own job/org.
  source_role_id        uuid not null,
  job_id                uuid not null references jobs(id) on delete cascade,
  org_id                uuid not null references organizations(id) on delete cascade,
  label                 text not null check (char_length(label) > 0),
  effective_from        timestamptz not null,
  effective_to          timestamptz,
  supersedes_binding_id uuid references source_bindings(id) on delete set null,
  -- No 'draft' phase (unlike qualification rules) — a binding is identity +
  -- effective dating, not a reviewer-confirmed commercial decision with
  -- open fields to resolve. It exists in an effective state from creation;
  -- 'superseded' is the only transition, made atomically by
  -- create_source_binding below.
  status                text not null default 'active' check (status in ('active', 'superseded')),
  created_at            timestamptz not null default now(),

  constraint source_bindings_role_ownership_fk
    foreign key (source_role_id, job_id, org_id)
    references source_roles (id, job_id, org_id)
    on delete cascade,

  -- Composite unique target consumed by billable_unit_candidates'
  -- own ownership FK below — same one-guard-closes-two-gaps pattern as
  -- billable_unit_candidates_pinned_rule_fk.
  constraint source_bindings_pin_target_uidx unique (id, job_id, org_id)
);
create index if not exists source_bindings_role_idx on source_bindings (source_role_id);
create index if not exists source_bindings_job_idx on source_bindings (job_id);

-- Prevents overlapping effective periods for the SAME role by construction:
-- at most one 'active' binding per source_role at a time. Combined with
-- create_source_binding always setting the predecessor's effective_to to
-- the successor's effective_from (mirrors
-- activate_qualification_rule_successor's own non-overlap guarantee), no
-- two bindings for one role can ever have overlapping [effective_from,
-- effective_to) ranges.
create unique index if not exists source_bindings_one_active_per_role_idx
  on source_bindings (source_role_id) where status = 'active';

alter table source_bindings enable row level security;
create policy "source_bindings_service_role_only" on source_bindings
  for all to service_role using (true) with check (true);

-- SourceBinding is part of historical commercial evidence — once created,
-- WHICH operational source (role, job, org) it identifies, and WHEN it
-- became effective, must never be silently rewritable by a direct
-- service-role UPDATE (the same "trigger, not merely 'no update path
-- exists'" discipline as billable_unit_candidates/candidate_unit_evidence
-- below). `label` is deliberately EXEMPTED — it is pure display metadata
-- (a human-readable name like "Salesforce sandbox A"); no evidence
-- resolution, asOf replay, or audit correctness anywhere in this schema
-- ever reads it, only `id`/`source_role_id`/`job_id`/`org_id`/
-- `effective_from`/`supersedes_binding_id` do, so relabeling a binding
-- cannot retroactively change what it historically means. `status`/
-- `effective_to` are also left open — those are exactly the two columns
-- create_source_binding's own supersession UPDATE touches.
create or replace function prevent_source_binding_history_rewrite()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.source_role_id is distinct from old.source_role_id
     or new.job_id is distinct from old.job_id
     or new.org_id is distinct from old.org_id
     or new.effective_from is distinct from old.effective_from
     or new.supersedes_binding_id is distinct from old.supersedes_binding_id
  then
    raise exception 'source_bindings: source_role_id, job_id, org_id, effective_from, and supersedes_binding_id are immutable once created — a direct rewrite would silently change which operational source historically produced evidence (binding %)', old.id;
  end if;
  return new;
end;
$$;

create trigger source_bindings_history_immutable
  before update on source_bindings
  for each row execute function prevent_source_binding_history_rewrite();

-- Smallest safe replacement/supersession service needed to prevent
-- overlapping effective periods — collapses what 16B.1 split into two
-- steps (createDraft + activate) into ONE atomic call, since a binding has
-- no draft/review phase: either this is the first binding for a role (no
-- predecessor to touch), or it supersedes the role's current active
-- binding (predecessor locked, closed at exactly the successor's
-- effective_from, successor inserted active) — both paths happen inside
-- one transaction, so a caller can never observe a role with zero active
-- bindings mid-transition, and two concurrent supersession attempts for
-- the same role serialize on the predecessor's row lock exactly like
-- activate_qualification_rule_successor.
create or replace function create_source_binding(
  p_source_role_id uuid, p_job_id uuid, p_org_id uuid, p_label text, p_effective_from timestamptz
) returns setof source_bindings
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_predecessor_id uuid;
  v_predecessor_effective_from timestamptz;
  v_role_job_id uuid;
begin
  -- job_id is looked up from the referenced role, never trusted from a
  -- caller-supplied parameter alone — a mismatch between p_job_id and the
  -- role's real job is rejected rather than silently creating a
  -- cross-job binding.
  select job_id into v_role_job_id from public.source_roles where id = p_source_role_id;
  if v_role_job_id is null then
    raise exception 'create_source_binding: source_role % not found', p_source_role_id;
  end if;
  if v_role_job_id <> p_job_id then
    raise exception 'create_source_binding: source_role % belongs to job %, not %', p_source_role_id, v_role_job_id, p_job_id;
  end if;

  select id, effective_from into v_predecessor_id, v_predecessor_effective_from
  from public.source_bindings
  where source_role_id = p_source_role_id and status = 'active'
  for update;

  if found then
    if p_effective_from <= v_predecessor_effective_from then
      raise exception 'create_source_binding: new binding effective_from (%) must be strictly after the current active binding''s effective_from (%) — retroactive rebinding is not supported', p_effective_from, v_predecessor_effective_from;
    end if;
    update public.source_bindings
    set status = 'superseded', effective_to = p_effective_from
    where id = v_predecessor_id;
  end if;

  return query
  insert into public.source_bindings (source_role_id, job_id, org_id, label, effective_from, supersedes_binding_id, status)
  values (p_source_role_id, p_job_id, p_org_id, p_label, p_effective_from, v_predecessor_id, 'active')
  returning *;
end;
$$;

revoke execute on function create_source_binding(uuid, uuid, uuid, text, timestamptz) from public;
revoke execute on function create_source_binding(uuid, uuid, uuid, text, timestamptz) from anon;
revoke execute on function create_source_binding(uuid, uuid, uuid, text, timestamptz) from authenticated;
grant  execute on function create_source_binding(uuid, uuid, uuid, text, timestamptz) to service_role;

-- ── Pinned-rule consistency (pre-commit hardening audit) ─────────────────
-- billable_unit_qualification_rules (migration 20260830000007 — already
-- APPLIED to production, so it cannot be edited) has no unique constraint
-- covering (id, job_id, org_id, unit_type, version). Adding one here, in
-- this still-unapplied migration, is an ordinary additive ALTER — `id`
-- alone is already globally unique (it's the primary key), so this wider
-- constraint is trivially satisfiable by every existing/future row; its
-- entire purpose is to give billable_unit_candidates a genuine COMPOSITE
-- foreign key target below, so a pinned candidate cannot reference an
-- (id, version) pair that doesn't really exist, and — in the SAME
-- constraint — cannot reference a rule belonging to a different
-- job/org/unit_type than the candidate's own. Enforced by Postgres
-- itself; TypeScript service-layer validation is not the sole integrity
-- barrier for a permanently-pinned commercial fact.
alter table billable_unit_qualification_rules
  add constraint billable_unit_qualification_rules_pin_target_uidx
  unique (id, job_id, org_id, unit_type, version);

-- 16B.2 pre-commit hardening — widens set_qualification_rule_contact_role_field
-- (migration 20260830000007 — already applied, cannot be edited in place)
-- to also accept 'attestation_fact_key', the new generic per-rule
-- configuration field (lib/billable-unit-qualification.ts's
-- QualifiedContactRoleDecision.attestation_fact_key). CREATE OR REPLACE
-- FUNCTION in a later migration is the ordinary, idiomatic way to widen a
-- function defined by an earlier, already-applied migration — this is
-- not an edit of 20260830000007's file. Everything else about the
-- function (jsonb_set against the CURRENT row value, revision bump,
-- status = 'draft' re-check, security posture) is byte-for-byte
-- unchanged; only the p_field allowlist grows by one literal.
create or replace function set_qualification_rule_contact_role_field(
  p_rule_id uuid, p_field text, p_value jsonb
) returns setof billable_unit_qualification_rules
language sql
security invoker
set search_path = ''
as $$
  update public.billable_unit_qualification_rules
  set qualified_contact_role = jsonb_set(coalesce(qualified_contact_role, '{}'::jsonb), array[p_field], p_value, true),
      revision = revision + 1,
      updated_at = now()
  where id = p_rule_id and status = 'draft' and p_field in ('base', 'extensions', 'attestation_fact_key')
  returning *;
$$;

-- ── billable_unit_candidates ──────────────────────────────────────────────
-- external_identity (id.ts: { source_binding_id, external_id }) is stored
-- as two plain columns rather than one jsonb blob — both need to
-- participate in a real FK (source_binding_id) and a real uniqueness
-- constraint (idempotent candidate creation), neither of which a jsonb
-- column gives you for free; the service layer nests them back into
-- external_identity on read.
--
-- status/rejection_deadline/decided_at are constrained to their 16B.2
-- values at the DATABASE level, not just by omitting a service capable of
-- changing them — the same "derive/constrain, don't trust the caller"
-- discipline as billable_unit_qualification_rules' requires_confirmation
-- (never a stored column, always derived) applied here as a hard floor:
-- even a bug in 16B.2 application code cannot produce a qualified/rejected
-- row or a populated decided_at/rejection_deadline. 16B.3 will ALTER this
-- table (drop and re-add these checks with the wider vocabulary) as part
-- of its own migration — that is expected, not a workaround.
create table if not exists billable_unit_candidates (
  id                          uuid primary key default gen_random_uuid(),
  job_id                      uuid not null references jobs(id) on delete cascade,
  org_id                      uuid not null references organizations(id) on delete cascade,
  unit_type                   text not null,

  -- No direct single-column FK on source_binding_id — the composite FK
  -- below (job_id/org_id included) subsumes it and additionally
  -- guarantees the referenced binding genuinely belongs to THIS
  -- candidate's own job/org.
  source_binding_id           uuid not null,
  external_id                 text not null check (char_length(external_id) > 0),

  booked_at                   timestamptz,
  occurred_at                 timestamptz,
  attribution_at              timestamptz not null,

  -- No direct single-column FK on qualification_rule_id — the composite
  -- FK below (job_id/org_id/unit_type/version included) subsumes it: any
  -- row satisfying the composite constraint necessarily references a
  -- real, existing rule.
  qualification_rule_id       uuid not null,
  qualification_rule_version  integer not null,

  rejection_deadline          timestamptz,
  status                      text not null default 'pending' check (status = 'pending'),
  decided_at                  timestamptz,

  created_at                  timestamptz not null default now(),

  constraint billable_unit_candidates_rejection_deadline_null_in_16b2 check (rejection_deadline is null),
  constraint billable_unit_candidates_decided_at_null_in_16b2 check (decided_at is null),

  -- Stable candidate identity — repeated pulls of the same real-world
  -- event (same binding, same external id) must resolve to the SAME
  -- candidate row, never create a duplicate. job_id is included per the
  -- brief even though it's transitively implied by source_binding_id, so
  -- the constraint reads self-evidently without requiring a join to
  -- reason about job-scoping. See lib/source-bindings.ts for the
  -- external-ID NAMESPACE invariant this constraint depends on: external_id
  -- is only unique WITHIN one source_binding_id's namespace, so a binding
  -- must be superseded only for a genuine re-platform, never for routine
  -- credential/token rotation against the same underlying system.
  constraint billable_unit_candidates_identity_uidx unique (job_id, source_binding_id, external_id),

  -- Composite FK — see the ALTER above. Enforces, at the database level,
  -- that qualification_rule_version cannot drift from the rule's real
  -- version AND that the pinned rule genuinely belongs to this
  -- candidate's own job/org/unit_type — one guard closes both integrity
  -- gaps simultaneously.
  constraint billable_unit_candidates_pinned_rule_fk
    foreign key (qualification_rule_id, job_id, org_id, unit_type, qualification_rule_version)
    references billable_unit_qualification_rules (id, job_id, org_id, unit_type, version)
    on delete restrict,

  -- DB ownership consistency chain, next link: the referenced binding
  -- must genuinely belong to this candidate's own job/org — same pattern
  -- as source_bindings_role_ownership_fk one link up the chain.
  constraint billable_unit_candidates_binding_ownership_fk
    foreign key (source_binding_id, job_id, org_id)
    references source_bindings (id, job_id, org_id)
    on delete restrict,

  -- Composite unique target consumed by candidate_unit_evidence's own
  -- ownership FK below.
  constraint billable_unit_candidates_pin_target_uidx unique (id, job_id, org_id)
);
create index if not exists billable_unit_candidates_job_unit_idx on billable_unit_candidates (job_id, unit_type);
create index if not exists billable_unit_candidates_rule_idx on billable_unit_candidates (qualification_rule_id);

alter table billable_unit_candidates enable row level security;
create policy "billable_unit_candidates_service_role_only" on billable_unit_candidates
  for all to service_role using (true) with check (true);

-- Pre-commit hardening audit — BillableUnitCandidate is a permanent audit
-- anchor: source_binding_id/external_id/booked_at/occurred_at/
-- attribution_at/qualification_rule_id/qualification_rule_version/
-- job_id/org_id/unit_type must never silently change once a candidate
-- exists, and this must not rely solely on "the service layer currently
-- has no update function for these fields" — a narrowly-scoped trigger is
-- the actual barrier. rejection_deadline/status/decided_at are
-- deliberately NOT protected by this trigger — those are the lifecycle
-- fields 16B.3 will be allowed to change (and are separately locked to
-- their 16B.2-only values by the check constraints above, until 16B.3
-- alters those).
create or replace function prevent_billable_unit_candidate_pin_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.job_id is distinct from old.job_id
     or new.org_id is distinct from old.org_id
     or new.unit_type is distinct from old.unit_type
     or new.source_binding_id is distinct from old.source_binding_id
     or new.external_id is distinct from old.external_id
     or new.booked_at is distinct from old.booked_at
     or new.occurred_at is distinct from old.occurred_at
     or new.attribution_at is distinct from old.attribution_at
     or new.qualification_rule_id is distinct from old.qualification_rule_id
     or new.qualification_rule_version is distinct from old.qualification_rule_version
  then
    raise exception 'billable_unit_candidates: identity/pin fields (job_id, org_id, unit_type, source_binding_id, external_id, booked_at, occurred_at, attribution_at, qualification_rule_id, qualification_rule_version) are immutable once created — candidate %', old.id;
  end if;
  return new;
end;
$$;

create trigger billable_unit_candidates_pin_immutable
  before update on billable_unit_candidates
  for each row execute function prevent_billable_unit_candidate_pin_mutation();

-- ── candidate_unit_evidence ───────────────────────────────────────────────
-- facts is validated against the pinned rule's fact_schema in TypeScript
-- BEFORE this insert (lib/billable-unit-candidate.ts's validateEvidenceFacts
-- — undeclared keys/wrong type/invalid enum/malformed timestamp are all
-- rejected there, not by a jsonb schema constraint here) — same split as
-- QualificationCondition validation in 16B.1 (validateQualificationCondition
-- is pure TypeScript, not a check constraint).
--
-- Append/revoke discipline, never in-place mutation: correcting evidence
-- means revoking the old row (status/revoked_at/revoked_by) and inserting
-- a NEW row with the corrected facts — this table has no UPDATE path for
-- `facts` at all, only for the four revocation columns (see
-- revoke_candidate_evidence below), so a corrected fact can never silently
-- overwrite what an earlier asOf replay already saw.
create table if not exists candidate_unit_evidence (
  id                uuid primary key default gen_random_uuid(),
  -- No direct single-column FKs on candidate_id/source_binding_id — the
  -- two composite FKs below (job_id/org_id included) subsume both and
  -- additionally guarantee the referenced candidate/binding genuinely
  -- belong to THIS evidence row's own job/org — completing the DB
  -- ownership chain SourceRole -> SourceBinding -> Candidate -> Evidence.
  candidate_id      uuid not null,
  job_id            uuid not null references jobs(id) on delete cascade,
  org_id            uuid not null references organizations(id) on delete cascade,
  source_binding_id uuid not null,

  facts             jsonb not null default '{}',

  occurred_at       timestamptz not null,
  recorded_at       timestamptz not null,
  recorded_by       text not null check (char_length(recorded_by) > 0),

  status            text not null default 'active' check (status in ('active', 'revoked')),
  revoked_at        timestamptz,
  revoked_by        text,

  created_at        timestamptz not null default now(),

  constraint candidate_unit_evidence_revocation_shape check (
    (status = 'active'  and revoked_at is null     and revoked_by is null)
    or
    (status = 'revoked' and revoked_at is not null and revoked_by is not null)
  ),

  -- A revocation cannot historically predate the evidence becoming known
  -- to Verdix — the asOf model's whole "recorded_at <= asOf AND
  -- (revoked_at IS NULL OR revoked_at > asOf)" invariant only makes sense
  -- if revoked_at is always at-or-after recorded_at; without this, a
  -- caller could construct a revocation that retroactively erases
  -- evidence from an asOf window where it was legitimately visible.
  constraint candidate_unit_evidence_revocation_not_before_recorded check (
    revoked_at is null or revoked_at >= recorded_at
  ),

  constraint candidate_unit_evidence_candidate_ownership_fk
    foreign key (candidate_id, job_id, org_id)
    references billable_unit_candidates (id, job_id, org_id)
    on delete cascade,

  constraint candidate_unit_evidence_binding_ownership_fk
    foreign key (source_binding_id, job_id, org_id)
    references source_bindings (id, job_id, org_id)
    on delete restrict
);
create index if not exists candidate_unit_evidence_candidate_idx on candidate_unit_evidence (candidate_id);
create index if not exists candidate_unit_evidence_binding_idx on candidate_unit_evidence (source_binding_id);

alter table candidate_unit_evidence enable row level security;
create policy "candidate_unit_evidence_service_role_only" on candidate_unit_evidence
  for all to service_role using (true) with check (true);

-- Pre-commit hardening audit — truly append-only, not append-only "by
-- convention." Blocks any UPDATE that touches the substantive/identity
-- columns (candidate_id, job_id, org_id, source_binding_id, facts,
-- occurred_at, recorded_at, recorded_by) — a correction must be a NEW row
-- (append) plus a revocation of the old one, never a rewrite. Also blocks
-- re-revoking an already-revoked row (defense in depth alongside
-- revoke_candidate_evidence's own WHERE status = 'active' clause — even
-- if that RPC's guard were ever weakened, this trigger independently
-- prevents a second revocation from clobbering the first revoked_at/
-- revoked_by, which is exactly what asOf replay depends on staying
-- correct forever). The ONLY update this trigger allows is the intended
-- active -> revoked transition performed by revoke_candidate_evidence.
create or replace function prevent_candidate_unit_evidence_rewrite()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.candidate_id is distinct from old.candidate_id
     or new.job_id is distinct from old.job_id
     or new.org_id is distinct from old.org_id
     or new.source_binding_id is distinct from old.source_binding_id
     or new.facts is distinct from old.facts
     or new.occurred_at is distinct from old.occurred_at
     or new.recorded_at is distinct from old.recorded_at
     or new.recorded_by is distinct from old.recorded_by
  then
    raise exception 'candidate_unit_evidence: substantive fields (candidate_id, job_id, org_id, source_binding_id, facts, occurred_at, recorded_at, recorded_by) are append-only and immutable once inserted — correct via a new evidence row plus revocation of this one, never an in-place rewrite (evidence %)', old.id;
  end if;
  if old.status = 'revoked' then
    raise exception 'candidate_unit_evidence: evidence % is already revoked — revocation is a one-way transition and cannot be repeated or reverted', old.id;
  end if;
  return new;
end;
$$;

create trigger candidate_unit_evidence_append_only
  before update on candidate_unit_evidence
  for each row execute function prevent_candidate_unit_evidence_rewrite();

-- Narrowly scoped, service-role-only atomic revocation — the ONLY UPDATE
-- path this table has. A plain application-level "read row, check status,
-- write revoked_at/revoked_by/status" has the same lost-update/TOCTOU
-- shape fixed everywhere else in this schema for concurrent writes to one
-- row; here the guard also matters semantically, not just for
-- concurrency — revoking an already-revoked row would silently overwrite
-- its original revoked_at/revoked_by, corrupting the asOf history this
-- whole table exists to preserve (see the "historical evidence safety"
-- design note). The WHERE clause re-checks status = 'active' at the
-- moment of write, so a concurrent double-revoke matches zero rows and
-- the caller observes that rather than clobbering the first revocation.
create or replace function revoke_candidate_evidence(
  p_evidence_id uuid, p_revoked_at timestamptz, p_revoked_by text
) returns setof candidate_unit_evidence
language sql
security invoker
set search_path = ''
as $$
  update public.candidate_unit_evidence
  set status = 'revoked', revoked_at = p_revoked_at, revoked_by = p_revoked_by
  where id = p_evidence_id and status = 'active'
  returning *;
$$;

revoke execute on function revoke_candidate_evidence(uuid, timestamptz, text) from public;
revoke execute on function revoke_candidate_evidence(uuid, timestamptz, text) from anon;
revoke execute on function revoke_candidate_evidence(uuid, timestamptz, text) from authenticated;
grant  execute on function revoke_candidate_evidence(uuid, timestamptz, text) to service_role;
