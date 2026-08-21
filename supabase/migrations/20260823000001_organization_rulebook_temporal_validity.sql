-- Organization Rulebook — temporal validity (Step 5B.5, hardened per review).
--
-- Adds effective_to and lineage_id so a superseded rule remains
-- historically resolvable for an asOf that falls within its real validity
-- window (previously, matchOrganizationRules excluded any status !=
-- 'active' row unconditionally, so a policy that was correct on 1 April
-- became unreproducible the moment it was superseded in July). Also adds
-- TWO database-level guarantees — not just application-code sequencing —
-- that no two rows can ever represent conflicting authoritative state for
-- the same policy slot at the same asOf: one scoped to a single
-- administrative lineage, one scoped to the semantic policy slot itself
-- (organization + target_field + match_conditions) regardless of lineage.
--
-- Historical eligibility (lib/rulebook/organization-rules.ts's
-- matchOrganizationRules, extended, not duplicated):
--   effective_from <= asOf AND (effective_to IS NULL OR asOf < effective_to)
-- Inclusive lower bound, exclusive upper bound — so at exactly the
-- cutover instant T, the retiring rule (effective_to = T) is no longer
-- eligible and the new rule (effective_from = T) already is. No ambiguous
-- double-match at T.

alter table organization_rulebook_rules add column if not exists effective_to timestamptz;

-- lineage_id groups every version of the "same logical rule" together —
-- the original rule and everything that transitively supersedes it.
-- Distinct from id (this specific row/version) and from
-- supersedes_rule_id (only the IMMEDIATELY prior version). This is one of
-- the two scopes the no-overlap constraints below check within, and is
-- generally useful for a future "show this rule's full history" query.
alter table organization_rulebook_rules add column if not exists lineage_id uuid;

-- ── Defensive backfill (Step 5B.5 review item 4) ────────────────────────
--
-- Pre-flight check 1: refuse to proceed if any row's supersedes_rule_id
-- points at a row in a DIFFERENT organization — this would otherwise let
-- the recursive backfill below silently assign a lineage_id that spans
-- two organizations. This table is empty in every environment this
-- migration has been reviewed against, so this is expected to be a no-op
-- everywhere it's applied; it exists so a genuinely corrupt future state
-- fails the migration loudly, with the exact offending row identified,
-- rather than silently producing a cross-tenant lineage.
do $$
declare
  v_bad_row record;
begin
  select r.id as row_id, r.organization_id as row_org, r.supersedes_rule_id as predecessor_id, p.organization_id as predecessor_org
    into v_bad_row
    from organization_rulebook_rules r
    join organization_rulebook_rules p on p.id = r.supersedes_rule_id
    where r.organization_id <> p.organization_id
    limit 1;
  if found then
    raise exception 'organization_rulebook_rules: row % (organization %) has supersedes_rule_id % which belongs to a DIFFERENT organization (%) — refusing to backfill lineage_id over cross-organization data; fix this row manually, then re-run this migration', v_bad_row.row_id, v_bad_row.row_org, v_bad_row.predecessor_id, v_bad_row.predecessor_org;
  end if;
end $$;

-- Backfill: walk supersedes_rule_id chains back to each root (a row with
-- no supersedes_rule_id) and assign that root's id as lineage_id for
-- every row in the chain. Deterministic by construction: supersedes_
-- rule_id is a single (not multi-valued) predecessor pointer, so the
-- reachable rows form a forest — each connected, acyclic component has
-- exactly one root and therefore exactly one lineage_id outcome. A row
-- involved in a broken reference (dangling supersedes_rule_id) or a cycle
-- (no root reachable at all) is simply never matched by this CTE and is
-- caught — by name — in the diagnostic check immediately below, rather
-- than silently left with a misleading lineage_id.
with recursive lineage as (
  select id, id as root_id from organization_rulebook_rules where supersedes_rule_id is null
  union all
  select r.id, l.root_id from organization_rulebook_rules r join lineage l on r.supersedes_rule_id = l.id
)
update organization_rulebook_rules r set lineage_id = l.root_id
from lineage l where r.id = l.id and r.lineage_id is null;

-- Pre-flight check 2: name exactly which rows the backfill above could not
-- reach (broken supersedes_rule_id reference, or a cycle with no root) —
-- a clear, actionable exception instead of the generic "column contains
-- null values" error the subsequent NOT NULL constraint would otherwise
-- produce.
do $$
declare
  v_missing_count integer;
  v_missing_ids text;
begin
  select count(*), string_agg(id::text, ', ') into v_missing_count, v_missing_ids
    from organization_rulebook_rules where lineage_id is null;
  if v_missing_count > 0 then
    raise exception 'organization_rulebook_rules: % row(s) could not be assigned a lineage_id — a broken supersedes_rule_id reference or a cycle with no reachable root (ids: %); fix these rows manually, then re-run this migration', v_missing_count, v_missing_ids;
  end if;
end $$;

alter table organization_rulebook_rules alter column lineage_id set not null;

-- Ongoing integrity for every FUTURE write (not just this one-time
-- backfill): a row's supersedes_rule_id, if set, must reference a row in
-- the SAME organization. Enforced as a trigger (not a CHECK constraint —
-- Postgres CHECK constraints cannot reference other rows) so a direct
-- insert/update bypassing organization-rules-service.ts entirely (which
-- already can't produce this today, since supersedeOrganizationRule's
-- lookup of the predecessor is itself organization-scoped) is still
-- rejected at the database layer, not merely by application-code
-- discipline.
create or replace function org_rulebook_enforce_same_org_lineage() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.supersedes_rule_id is not null then
    if not exists (
      select 1 from public.organization_rulebook_rules
      where id = new.supersedes_rule_id and organization_id = new.organization_id
    ) then
      raise exception 'organization_rulebook_rules: supersedes_rule_id % must belong to the same organization_id (%) as the row referencing it', new.supersedes_rule_id, new.organization_id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists org_rulebook_enforce_same_org_lineage_trigger on organization_rulebook_rules;
create trigger org_rulebook_enforce_same_org_lineage_trigger
  before insert or update of supersedes_rule_id, organization_id on organization_rulebook_rules
  for each row execute function org_rulebook_enforce_same_org_lineage();

-- ── No-overlap guarantees (Step 5B.5 review item 1) ─────────────────────
--
-- btree_gist is required so the `=` equality operator class can
-- participate in a GiST exclusion constraint alongside the range-overlap
-- operator.
create extension if not exists btree_gist;

-- Constraint A — no two rows in the SAME administrative lineage may have
-- overlapping [effective_from, effective_to) validity windows while
-- active/superseded. Protects a single rule's own version history, even
-- in the rare case a later version's target_field/match_conditions were
-- edited away from the predecessor's (supersedeOrganizationRule permits
-- this — a pre-existing Step 5A looseness, not changed here).
alter table organization_rulebook_rules
  add constraint org_rulebook_no_overlapping_validity
  exclude using gist (
    lineage_id with =,
    tstzrange(effective_from, effective_to, '[)') with &&
  ) where (status in ('active', 'superseded'));

-- Constraint B — no two rows describing the exact same organization-
-- policy SLOT (organization_id + target_field + match_conditions_json)
-- may have overlapping validity windows, REGARDLESS of lineage_id. This
-- is what makes it impossible for two INDEPENDENTLY created lineages to
-- both become authoritative for the identical semantic scope at the same
-- asOf — lineage_id alone cannot catch that, since by definition two
-- independent lineages have different lineage_ids. This is the
-- database-level answer to: "Org A, Lineage X (service_credit/
-- carry_forward=true, Jan–Dec) and Lineage Y (service_credit/
-- carry_forward=false, Mar–Sep) must not both be authoritative."
--
-- match_conditions_json is compared as text, not as jsonb directly —
-- jsonb is not among btree_gist's supported equality types, and text
-- equality over jsonb's canonical output is a safe, simple substitute.
-- Documented limitation (deliberately the SMALLEST safeguard that closes
-- the reviewed failure mode, not a general-purpose canonicalizer): jsonb
-- normalizes OBJECT key order but not ARRAY element order, so two rules
-- whose match_conditions arrays are semantically identical but written in
-- a different order will NOT be caught by this constraint. Rule creation
-- (validateOrganizationRuleShape and any future authoring UI) is expected
-- to write conditions in a consistent order for the same semantic scope;
-- canonicalizing/sorting the array is not implemented here since it was
-- not required to close the specific scenario under review.
alter table organization_rulebook_rules
  add constraint org_rulebook_no_overlapping_scope
  exclude using gist (
    organization_id with =,
    target_field with =,
    (match_conditions_json::text) with =,
    tstzrange(effective_from, effective_to, '[)') with &&
  ) where (status in ('active', 'superseded'));

-- ── Atomic activation (hardened per review items 2, 3) ──────────────────
--
-- From this migration forward, the ONLY way a rule transitions to
-- 'active' (see lib/rulebook/organization-rules-service.ts's
-- activateOrganizationRule, which calls this exclusively instead of doing
-- a plain UPDATE). One transaction: retires the immediate predecessor (if
-- any) with effective_to = p_effective_at, THEN activates the new rule
-- with effective_from = p_effective_at — so a partial failure (predecessor
-- no longer active, concurrent supersession already claimed it, either
-- exclusion constraint above would be violated, or the retroactive-
-- activation guard below fires) rolls back BOTH halves. Never leaves a
-- gap (old retired but new not yet active) or an overlap (both
-- simultaneously active). Advisory lock is keyed on organization_id,
-- serializing concurrent activation attempts for the same tenant —
-- mirrors reserve_credit_balance's job-scoped lock pattern
-- (20260821000001_credit_ledger.sql).
--
-- search_path is set to the EMPTY string, not merely 'public, pg_temp' —
-- the narrowest possible configuration: every table reference in this
-- function body is fully schema-qualified (public.organization_rulebook_
-- rules), so nothing needs to resolve unqualified at all. Built-in
-- functions/operators (now(), hashtextextended(), casts, interval
-- arithmetic) still resolve correctly with an empty search_path — they
-- live in pg_catalog, which Postgres always consults first regardless of
-- the configured search_path; only USER-schema objects would be affected
-- by leaving search_path empty, and none are referenced unqualified here.
--
-- Retroactive-activation guard (review item 3, chosen product invariant):
-- effective_at more than a small grace window in the past is rejected
-- outright. An ordinary activation may set effective_at to "now" (subject
-- to normal request latency, hence the grace window — not an exact
-- >= check, which would be flaky under real network conditions) or any
-- FUTURE instant (the temporal matcher correctly keeps using the
-- predecessor until that instant arrives — no special-casing needed,
-- already true of the existing effective_from gating). Genuine backdating
-- (silently rewriting what policy was authoritative during an ALREADY-
-- INVOICED period) is refused; a deliberate, audited correction workflow
-- for that case is explicitly out of scope for Step 5B.5 and does not
-- exist yet. This guard applies only to the SUPERSESSION/activation path —
-- a brand-new rule's own initial effective_from (set directly via
-- createOrganizationRule, never through this function) is unrestricted,
-- since it cannot retroactively change any EXISTING authoritative record —
-- there is nothing being retired.
create or replace function activate_organization_rule_supersession(
  p_organization_id uuid,
  p_new_rule_id uuid,
  p_approved_by text,
  p_effective_at timestamptz
) returns setof organization_rulebook_rules
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_draft public.organization_rulebook_rules;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text, 0));

  if p_effective_at < now() - interval '60 seconds' then
    raise exception 'activate_organization_rule_supersession: effective_at (%) is more than 60 seconds in the past — retroactive activation is not permitted for an ordinary activation; a future or (within a small grace window) present effective_at is required', p_effective_at;
  end if;

  select * into v_draft from public.organization_rulebook_rules
    where id = p_new_rule_id and organization_id = p_organization_id and status = 'draft'
    for update;
  if not found then
    raise exception 'activate_organization_rule_supersession: draft rule % not found in organization %', p_new_rule_id, p_organization_id;
  end if;

  if v_draft.supersedes_rule_id is not null then
    update public.organization_rulebook_rules
      set effective_to = p_effective_at, status = 'superseded', updated_at = now()
      where id = v_draft.supersedes_rule_id and organization_id = p_organization_id and status = 'active';
    if not found then
      raise exception 'activate_organization_rule_supersession: previous rule % is not currently active in organization % — concurrent change or already superseded', v_draft.supersedes_rule_id, p_organization_id;
    end if;
  end if;

  return query
    update public.organization_rulebook_rules
      set status = 'active', approved_by = p_approved_by, effective_from = p_effective_at, updated_at = now()
      where id = p_new_rule_id
      returning *;
end;
$$;

revoke all on function activate_organization_rule_supersession(uuid, uuid, text, timestamptz) from public;
revoke all on function activate_organization_rule_supersession(uuid, uuid, text, timestamptz) from anon;
revoke all on function activate_organization_rule_supersession(uuid, uuid, text, timestamptz) from authenticated;
grant execute on function activate_organization_rule_supersession(uuid, uuid, text, timestamptz) to service_role;
