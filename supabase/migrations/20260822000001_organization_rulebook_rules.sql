-- Private Organization Rulebook (Step 5A) — tenant-scoped default/policy
-- storage. SHADOW MODE ONLY: nothing in production reads this table yet
-- (see lib/rulebook/organization-rules.ts's own module comment). This
-- migration only adds storage + RLS; it does not wire anything into
-- billing, readiness, or extraction.
--
-- Core safety rules this schema exists to support (enforced primarily by
-- application code in lib/rulebook/organization-rules*.ts — the database
-- itself only enforces the one property cheap and unconditional enough to
-- belong here, see the CHECK constraint below):
--   - belongs to exactly one organization, never visible to another;
--   - never promoted into the Verdix Global Rulebook (a separate,
--     code-defined registry — lib/rulebook/rules.ts — this table has no
--     relationship to it at all, and nothing here writes to it);
--   - applies only where the relevant contract field is silent/unresolved
--     (contract_derived/reviewer_policy always outrank organization_
--     rulebook — enforced both by the matcher, which excludes an
--     already-resolved target_field from matching at all, and
--     independently by lib/rulebook/resolution.ts's resolveFieldAuthority
--     precedence);
--   - cannot be created automatically — every row requires an explicit
--     created_by, and 'active' status requires an explicit approved_by,
--     regardless of source_kind (including verdix_pattern_suggestion).
create table if not exists organization_rulebook_rules (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references organizations(id) on delete cascade,

  name                  text not null,
  description           text,

  -- Dotted-path addressing into the allowlisted normalized commercial
  -- vocabulary (lib/rulebook/organization-rules.ts's
  -- ORGANIZATION_RULEBOOK_ALLOWLISTED_FIELDS) — validated in application
  -- code before every insert/update, not by a DB enum, since that
  -- vocabulary is expected to grow over time. Left as unconstrained text
  -- at the database layer deliberately: nothing in this schema ever
  -- EXECUTES this value (no eval, no dynamic SQL, no stored procedure
  -- reads it) — it is inert data, read back into TypeScript and matched
  -- there via a plain allowlisted-path lookup.
  target_field          text not null,
  value_json            jsonb not null,
  -- Array of { field, operator, value? }. Same allowlist/validation
  -- discipline as target_field; operator is restricted to a small,
  -- intentionally minimal set ('eq' | 'in' | 'exists') in application code
  -- (lib/rulebook/organization-rules.ts's validateOrganizationRuleShape).
  match_conditions_json jsonb not null default '[]',

  status                text not null default 'draft'
                          check (status in ('draft', 'active', 'disabled', 'superseded')),

  -- Editing an active rule creates a NEW row (version + 1, supersedes_
  -- rule_id pointing at the prior row, prior row's status flipped to
  -- 'superseded') rather than mutating history in place — see
  -- lib/rulebook/organization-rules-service.ts's supersedeOrganizationRule.
  version               integer not null default 1,
  supersedes_rule_id    uuid references organization_rulebook_rules(id) on delete set null,

  -- Descriptive only — NEVER a source of resolution authority. Once a
  -- rule is active, its resolution authority is 'organization_rulebook'
  -- regardless of source_kind (Step 5A item 9). A verdix_pattern_suggestion
  -- that hasn't been explicitly approved stays 'draft' (see the CHECK
  -- constraint below) and never produces a resolution candidate.
  source_kind           text not null default 'manual'
                          check (source_kind in ('manual', 'reviewer_promotion', 'verdix_pattern_suggestion')),

  created_by            text not null,
  approved_by           text,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  effective_from        timestamptz,

  -- No rule is ever active without an explicit approver — the one safety
  -- property enforced at the database layer, not just in application code,
  -- because it's cheap, unconditional, and the single most important
  -- guarantee this table needs (item 9/10: no automatic learning, no
  -- self-activating suggestion). A caller attempting to insert or update a
  -- row to status = 'active' with approved_by null fails the constraint
  -- outright, regardless of which application code path tried it.
  constraint org_rulebook_active_requires_approval check (
    status <> 'active' or approved_by is not null
  )
);

create index if not exists org_rulebook_rules_org_status_field_idx
  on organization_rulebook_rules (organization_id, status, target_field);
create index if not exists org_rulebook_rules_supersedes_idx
  on organization_rulebook_rules (supersedes_rule_id);

alter table organization_rulebook_rules enable row level security;
-- Same discipline as every other table in this schema (see
-- 20260819000003_rls_lockdown.sql, 20260821000001_credit_ledger.sql): this
-- app never issues per-user Supabase Auth sessions to the browser, so a
-- `to service_role` policy with no anon/authenticated policy at all is the
-- correct, complete database-layer tenant-isolation boundary — Postgres
-- default-denies every operation for anon/authenticated once only this
-- policy exists. Real per-organization scoping (Org A can never read/write
-- Org B's rows) is enforced in application code — every query in
-- lib/rulebook/organization-rules-service.ts is filtered by a trusted
-- organization_id, never a client-supplied one — the exact same model
-- requireOrg()/supabaseServer already use for every other tenant-scoped
-- table in this codebase. Verified by lib/organization-rulebook-rls.test.ts.
create policy "org_rulebook_rules_service_role_only" on organization_rulebook_rules
  for all to service_role using (true) with check (true);
revoke all on organization_rulebook_rules from anon, authenticated;
