-- Step 16B.1 — Billable Unit Qualification: rule persistence + SourceRole
-- identity vocabulary. Foundational only: no candidates, no evidence, no
-- source bindings, no coverage, no business-day arithmetic, no meter
-- integration in this migration — see lib/billable-unit-qualification.ts's
-- own "deferred design notes" for what's explicitly out of scope.

-- ── source_roles ────────────────────────────────────────────────────────
-- Identity vocabulary only — no connector config, no auth, no endpoints.
-- A job-scoped, OPEN vocabulary (not a global enum): the first real
-- fixture (OS-2026-09) already needs seven roles (crm, enrichment,
-- calendar, conferencing, portal, public_materials, reviewer_attestation).
-- Registering a new role_key is a data operation, never a code change.
-- SourceBinding (the operational/connector identity a role resolves to)
-- is explicitly deferred to 16B.2 — this table exists so rules can
-- reference a stable role_key now without a dangling foreign key later.
create table if not exists source_roles (
  id         uuid primary key default gen_random_uuid(),
  job_id     uuid not null references jobs(id) on delete cascade,
  org_id     uuid not null references organizations(id) on delete cascade,
  role_key   text not null check (role_key ~ '^[a-z][a-z0-9_]{1,63}$'),
  created_at timestamptz not null default now(),
  unique (job_id, role_key)
);
create index if not exists source_roles_job_idx on source_roles (job_id);

alter table source_roles enable row level security;
-- Explicitly role-scoped to service_role only, same convention as every
-- other tenant-scoped table in this schema (e.g.
-- 20260822000001_organization_rulebook_rules.sql) — this app never issues
-- per-user Supabase Auth sessions, so requireOrg()'s application-layer
-- org-scoping is the real isolation boundary; RLS here exists to keep the
-- anon/authenticated keys (both shipped to the browser) from reaching this
-- table at all.
create policy "source_roles_service_role_only" on source_roles
  for all to service_role using (true) with check (true);

-- ── billable_unit_qualification_rules ──────────────────────────────────
-- Each FieldDecision<T> (lib/billable-unit-qualification.ts) is stored as
-- a plain JSONB object { value, state, provenance } — no separate
-- provenance columns, so the read/write shape matches the domain type
-- exactly with no projection step. requires_confirmation is deliberately
-- NOT a column here — it is always derived from the field decisions by
-- isQualificationRuleReady, never persisted, so it can never drift from
-- what the decisions actually say.
create table if not exists billable_unit_qualification_rules (
  id               uuid primary key default gen_random_uuid(),
  job_id           uuid not null references jobs(id) on delete cascade,
  org_id           uuid not null references organizations(id) on delete cascade,
  unit_type        text not null,

  fact_schema      jsonb not null default '{}',

  criteria                jsonb not null,
  qualified_contact_role  jsonb not null,
  dedupe_rule             jsonb not null,
  rejection_rule          jsonb not null,
  rejection_window        jsonb not null,
  deadline_convention     jsonb not null,
  attribution_basis       jsonb not null,
  evidence_precedence     jsonb not null default '{}',

  -- field path -> array of VERBATIM quoted clause text, e.g.
  -- {"criteria": ["2.1 \"Target Account\" means...", "2.3 \"Sales
  -- Qualified Meeting\"...", "SCHEDULE 1 ... A prospect is a Target
  -- Account only if..."]}. Deliberately NOT contract_terms.field_sources's
  -- heading-lookup convention (a single section-heading string resolved
  -- later against a re-fetched document) — that mechanism only resolves
  -- at top-level heading granularity and cannot represent "one field,
  -- multiple clauses." Reuses this codebase's much more common
  -- source_clause convention instead (ServiceCredit.source_clause,
  -- OneTimeFee.source_clause, ...): the stored text IS the immutable
  -- source evidence, self-contained, requiring no further resolution
  -- step. Immutable after extraction/authoring —
  -- confirmQualificationRuleField/confirmQualificationRuleFieldAndPersist
  -- never write to this column; a reviewer decision references the
  -- original source, never rewrites it.
  field_sources    jsonb not null default '{}',

  version              integer not null default 1,

  -- Activation TOCTOU hardening — an optimistic-concurrency counter,
  -- distinct from `version` (contractual amendment lineage): `revision`
  -- counts edits to THIS row while it's a draft. Bumped atomically by
  -- every semantic write (confirm_qualification_rule_field,
  -- set_qualification_rule_contact_role_field,
  -- set_qualification_rule_evidence_precedence_key — all below), never
  -- by activation itself. The activation flow reads this value, validates
  -- against it, then passes it back as expected_revision so the atomic
  -- activation RPC can fail closed if the rule changed underneath the
  -- validation that was just performed.
  revision             integer not null default 1,

  supersedes_rule_id   uuid references billable_unit_qualification_rules(id) on delete set null,
  effective_from       timestamptz not null,
  effective_to         timestamptz,
  -- draft -> reviewer resolves fields (readiness derived, never stored)
  -- -> active -> superseded by a later contractual version. A draft may
  -- be completed in place (same row); once active, a genuine change in
  -- contractual meaning creates a new version via supersession rather
  -- than rewriting the active row.
  status               text not null default 'draft' check (status in ('draft', 'active', 'superseded')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists billable_unit_qualification_rules_job_unit_status_idx
  on billable_unit_qualification_rules (job_id, unit_type, status);

-- Pre-commit hardening audit, part D — "no candidate-time rule range
-- should have two applicable active versions." Enforced here, not just in
-- application code, because activateQualificationRule's own readiness
-- check cannot by itself prevent two DIFFERENT draft rules for the same
-- job_id/unit_type both being activated concurrently (each request's
-- readiness check only ever looks at its own rule). A partial unique
-- index makes "at most one active row per (job_id, unit_type)" true
-- regardless of race timing — the second concurrent activation's UPDATE
-- fails the constraint outright rather than silently succeeding.
create unique index if not exists billable_unit_qualification_rules_one_active_per_unit_type_idx
  on billable_unit_qualification_rules (job_id, unit_type) where status = 'active';

-- Guards against two concurrent successor-draft creations off the same
-- active rule both computing `active.version + 1` and inserting two
-- draft rows with the same version number. A plain unique index, not a
-- range-overlap exclusion constraint — overlapping effective_from/
-- effective_to ranges are already prevented by construction
-- (activate_qualification_rule_successor below always sets the
-- predecessor's effective_to to the successor's effective_from exactly)
-- combined with the one-active-per-unit-type index above (only the
-- single active row's range is ever "current" for any given moment) — a
-- full tstzrange exclusion constraint was considered and deliberately
-- not added; not necessary given these two guarantees together, and this
-- table has no scenario yet where more than one non-active row's range
-- could matter.
create unique index if not exists billable_unit_qualification_rules_job_unit_version_idx
  on billable_unit_qualification_rules (job_id, unit_type, version);

alter table billable_unit_qualification_rules enable row level security;
create policy "billable_unit_qualification_rules_service_role_only" on billable_unit_qualification_rules
  for all to service_role using (true) with check (true);

-- ── Atomic per-field confirmation (pre-commit hardening audit, part C;
--    revision bump added in the activation-TOCTOU hardening pass) ──────
-- qualified_contact_role and evidence_precedence are each ONE JSONB
-- column holding MULTIPLE independently-confirmable sub-keys
-- (qualified_contact_role.base/.extensions; evidence_precedence's
-- per-fact keys). A plain application-level "read column, merge one key
-- in JS, write column back" has the exact lost-update shape fixed for
-- contract_terms.ai_proposal_cache in
-- 20260830000006_proposal_cache_atomic_upsert.sql — two concurrent
-- confirmations of two DIFFERENT sub-keys in the SAME column could each
-- read a snapshot before the other's write lands, and the later write
-- would silently revert the earlier one. Fixed the same way: a single
-- atomic UPDATE ... jsonb_set against the row's CURRENT value.
--
-- Every function in this section also does `revision = revision + 1` —
-- an in-database increment against the CURRENT value, not a value
-- computed in JS from a possibly-stale read — so revision is exactly as
-- race-safe as the field content it accompanies. confirm_qualification_
-- rule_field covers the independent top-level columns (criteria,
-- dedupe_rule, rejection_rule, rejection_window, deadline_convention,
-- attribution_basis): even though each owns its whole column (no JSONB
-- merge needed for the field itself), the revision bump still needs to
-- read-and-increment the CURRENT row value atomically, which a plain
-- supabase-js `.update({...})` call cannot express — hence a function
-- for these too, not just the JSONB-merge cases.
--
-- All three additionally re-check status = 'draft' in the WHERE clause
-- itself (not just in the calling TypeScript), so a rule concurrently
-- activated or superseded between the caller's read and this write is
-- never mutated — the UPDATE simply matches zero rows and the caller
-- observes that. security invoker (only ever called by the service-role
-- client, which already bypasses RLS on its own — no elevated privilege
-- needed); structurally scoped to exactly one hardcoded table/column(s)
-- each; locked to service_role only, same convention as
-- set_proposal_cache_entry.
create or replace function confirm_qualification_rule_field(
  p_rule_id uuid, p_column text, p_value jsonb
) returns setof billable_unit_qualification_rules
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- No dynamic SQL / no caller-supplied identifier interpolation — an
  -- explicit branch per allowed column, same discipline as
  -- set_qualification_rule_contact_role_field's `p_field in (...)`
  -- allowlist just applied to a full statement instead of an array
  -- literal, since each branch targets a genuinely different column.
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
  where id = p_rule_id and status = 'draft' and p_field in ('base', 'extensions')
  returning *;
$$;

revoke execute on function set_qualification_rule_contact_role_field(uuid, text, jsonb) from public;
revoke execute on function set_qualification_rule_contact_role_field(uuid, text, jsonb) from anon;
revoke execute on function set_qualification_rule_contact_role_field(uuid, text, jsonb) from authenticated;
grant  execute on function set_qualification_rule_contact_role_field(uuid, text, jsonb) to service_role;

create or replace function set_qualification_rule_evidence_precedence_key(
  p_rule_id uuid, p_key text, p_value jsonb
) returns setof billable_unit_qualification_rules
language sql
security invoker
set search_path = ''
as $$
  update public.billable_unit_qualification_rules
  set evidence_precedence = jsonb_set(coalesce(evidence_precedence, '{}'::jsonb), array[p_key], p_value, true),
      revision = revision + 1,
      updated_at = now()
  where id = p_rule_id and status = 'draft'
  returning *;
$$;

revoke execute on function set_qualification_rule_evidence_precedence_key(uuid, text, jsonb) from public;
revoke execute on function set_qualification_rule_evidence_precedence_key(uuid, text, jsonb) from anon;
revoke execute on function set_qualification_rule_evidence_precedence_key(uuid, text, jsonb) from authenticated;
grant  execute on function set_qualification_rule_evidence_precedence_key(uuid, text, jsonb) to service_role;

-- ── Atomic successor activation (pre-commit hardening audit, part 2) ────
-- Retires a predecessor and promotes its successor as ONE all-or-nothing
-- database transaction. Application code previously did this as two
-- separate writes (create the draft successor, then IMMEDIATELY mark the
-- predecessor superseded) — worse, it did so at DRAFT-CREATION time, not
-- activation time, meaning the predecessor stopped governing the moment
-- someone started drafting an amendment, potentially leaving a job/
-- unit_type with NO active rule for as long as the draft sat unresolved.
-- lib/billable-unit-qualification-service.ts now splits this into
-- createSuccessorDraft (create only — predecessor untouched, keeps
-- governing) and activateQualificationRuleSuccessor (calls this
-- function, only once the successor is actually ready).
--
-- A single plpgsql function body executes inside the calling
-- transaction: if any RAISE EXCEPTION fires (successor not draft,
-- successor has no predecessor, predecessor not found, predecessor not
-- active), Postgres automatically rolls back every effect the function
-- had already made — there is no window where the predecessor could be
-- superseded without a promoted successor, or vice versa.
--
-- `select ... for update` locks the predecessor row before checking its
-- status, so two concurrent calls targeting successors of the SAME
-- predecessor serialize on that lock rather than racing: whichever
-- transaction commits first wins; the second sees the predecessor
-- already 'superseded' and fails with a clear exception instead of
-- silently creating two active versions. Combined with
-- billable_unit_qualification_rules_one_active_per_unit_type_idx (belt
-- and braces — the unique index would also reject a second concurrent
-- activation even if this lock were somehow bypassed).
--
-- Activation-TOCTOU hardening pass — p_expected_revision closes a
-- separate race from the one above: the caller (lib/billable-unit-
-- qualification-service.ts's activateQualificationRuleSuccessor) reads
-- the successor, validates isQualificationRuleReady and every referenced
-- source role against THAT read, then calls this function. Without a
-- revision check, a confirmation landing between that validation and
-- this call (e.g. someone edits evidence_precedence to reference a role
-- that was never registered) would activate a rule DIFFERENT from the
-- one that was actually validated — the validation would be silently
-- stale. Checked here, under the same row lock used for the status
-- check, so it's exactly as race-safe: if the successor's current
-- revision doesn't match what the caller validated, the whole call fails
-- closed rather than activating unseen changes. Activation itself never
-- bumps revision (it doesn't change semantic content, only status).
--
-- Effective-range sanity — a successor's effective_from must be strictly
-- after its predecessor's effective_from; this slice does not support
-- retroactive amendments (a successor "governing" from the same moment
-- as, or earlier than, its predecessor would be an incoherent interval).
-- Checked here as the hard guarantee at the one point a rule actually
-- becomes governing; createSuccessorDraft also checks this at
-- draft-creation time so an invalid draft is rejected immediately rather
-- than only failing much later at activation.
create or replace function activate_qualification_rule_successor(
  p_successor_id uuid, p_expected_revision integer
) returns setof billable_unit_qualification_rules
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_predecessor_id uuid;
  v_successor_status text;
  v_successor_effective_from timestamptz;
  v_successor_revision integer;
  v_predecessor_status text;
  v_predecessor_effective_from timestamptz;
begin
  select supersedes_rule_id, status, effective_from, revision
    into v_predecessor_id, v_successor_status, v_successor_effective_from, v_successor_revision
  from public.billable_unit_qualification_rules
  where id = p_successor_id
  for update;

  if not found then
    raise exception 'activate_qualification_rule_successor: successor % not found', p_successor_id;
  end if;
  if v_predecessor_id is null then
    raise exception 'activate_qualification_rule_successor: rule % has no supersedes_rule_id — use a plain activation for a first-ever rule', p_successor_id;
  end if;
  if v_successor_status <> 'draft' then
    raise exception 'activate_qualification_rule_successor: successor % is not draft (found %)', p_successor_id, v_successor_status;
  end if;
  if v_successor_revision <> p_expected_revision then
    raise exception 'activate_qualification_rule_successor: successor % revision changed concurrently (expected %, found %) — re-validate against the current revision and retry', p_successor_id, p_expected_revision, v_successor_revision;
  end if;

  select status, effective_from into v_predecessor_status, v_predecessor_effective_from
  from public.billable_unit_qualification_rules
  where id = v_predecessor_id
  for update;

  if not found then
    raise exception 'activate_qualification_rule_successor: predecessor % not found', v_predecessor_id;
  end if;
  if v_predecessor_status <> 'active' then
    raise exception 'activate_qualification_rule_successor: predecessor % is not active (found %) — it may already have been superseded by a concurrent request', v_predecessor_id, v_predecessor_status;
  end if;
  if v_successor_effective_from <= v_predecessor_effective_from then
    raise exception 'activate_qualification_rule_successor: successor % effective_from (%) must be strictly after predecessor % effective_from (%) — retroactive amendments are not supported', p_successor_id, v_successor_effective_from, v_predecessor_id, v_predecessor_effective_from;
  end if;

  update public.billable_unit_qualification_rules
  set status = 'superseded', effective_to = v_successor_effective_from, updated_at = now()
  where id = v_predecessor_id;

  return query
  update public.billable_unit_qualification_rules
  set status = 'active', updated_at = now()
  where id = p_successor_id
  returning *;
end;
$$;

revoke execute on function activate_qualification_rule_successor(uuid, integer) from public;
revoke execute on function activate_qualification_rule_successor(uuid, integer) from anon;
revoke execute on function activate_qualification_rule_successor(uuid, integer) from authenticated;
grant  execute on function activate_qualification_rule_successor(uuid, integer) to service_role;
