-- Organization Rulebook — atomic one-draft-per-canonical-slot guarantee
-- (final amendment, concurrency-safety pass).
--
-- Application-level dedup (findOrganizationRulesForSlot +
-- classifyOrganizationPolicySlotOutcome, lib/rulebook/organization-policy-
-- slot.ts) already gives the correct PRODUCT responses (already_covered /
-- existing_draft / draft_conflict / proposed_policy_change / no_existing),
-- but cannot by itself prevent a genuine race: two concurrent confirmed
-- promotions can both read "no existing draft" before either has written
-- anything, and both proceed to insert. The existing exclusion
-- constraints (org_rulebook_no_overlapping_validity /
-- org_rulebook_no_overlapping_scope, added in
-- 20260823000001_organization_rulebook_temporal_validity.sql) do not help
-- here: both are scoped to `status in ('active', 'superseded')` only — a
-- 'draft' row has no effective_from/effective_to validity window and sits
-- entirely outside either constraint's WHERE clause. This migration closes
-- that specific, previously-unprotected gap: at most one DRAFT row per
-- canonical policy slot, database-enforced.
--
-- Why a new slot_key column, not raw match_conditions_json equality
-- (e.g. `(match_conditions_json::text) with =`, the pattern the existing
-- org_rulebook_no_overlapping_scope constraint already uses) — audited
-- before writing this migration, per explicit instruction not to implement
-- blindly:
--   - match_conditions_json is `jsonb`. Postgres's jsonb storage
--     canonicalizes OBJECT key order internally (confirmed empirically
--     while building the dedup pass this migration hardens — a raw
--     JS-side JSON.stringify comparison against a value round-tripped
--     through jsonb did NOT match insertion order), so two conditions
--     with the same field/operator/value but written with different
--     object-literal key order already compare equal once stored. But
--     jsonb does NOT reorder ARRAY elements — two conditions arrays
--     describing the identical semantic scope in a different array order
--     (e.g. [rule_type, application.timing] vs
--     [application.timing, rule_type]) serialize to DIFFERENT text and
--     would NOT collide under raw jsonb::text equality. This is exactly
--     the "documented, pre-existing" limitation the prior migration's own
--     comment on org_rulebook_no_overlapping_scope already calls out.
--   - lib/rulebook/organization-policy-slot.ts's normalizeMatchConditions
--     already solves this in application code (sorts conditions
--     deterministically by field/operator before comparison), and
--     organizationPolicySlotKey is the ONE canonical string identity built
--     from it. Rather than re-deriving an equivalent sort/normalize
--     expression a second time in SQL (which could silently drift from
--     the TypeScript definition of "the same slot" over time, and would
--     make the canonical-slot concept owned by two independent
--     implementations instead of one), this migration adds a column the
--     APPLICATION populates directly from that same function at write
--     time — see lib/rulebook/organization-rules-service.ts's
--     createOrganizationRule/supersedeOrganizationRule. The database only
--     ever compares this already-normalized value for equality; it never
--     computes or interprets it.
--
-- NULLABLE, and deliberately NEVER backfilled for any pre-existing row.
-- Verified before writing this migration: organization_rulebook_rules has
-- exactly ONE row in every environment this has been checked against —
-- the pre-scope-fix "Lynora AB" draft (adff7a2e-48df-4e1c-93cf-
-- 42eab231275d), which must not be mutated as part of this fix (it uses
-- the old, since-corrected match_conditions scope and will be discarded
-- manually after deployment, per explicit instruction). A NULL slot_key
-- can never violate a uniqueness constraint (standard SQL: NULL is never
-- equal to NULL, including to another NULL), so leaving it NULL for that
-- row — literally never writing to this new column for it at all — is
-- sufficient to leave it completely untouched while still fully enforcing
-- the invariant for every row created from this point forward. Every
-- future call to createOrganizationRule/supersedeOrganizationRule always
-- sets slot_key explicitly; there is no code path that leaves it NULL for
-- a NEW row.
alter table organization_rulebook_rules add column if not exists slot_key text;

-- At most one DRAFT per canonical slot, organization-wide. Scoped to
-- status = 'draft' only:
--   - an active/superseded row's own uniqueness-over-time is already
--     covered by the existing org_rulebook_no_overlapping_scope exclusion
--     constraint, which additionally accounts for the effective_from/
--     effective_to validity window — appropriate for status transitions a
--     draft has none of (draft rows always have effective_from/
--     effective_to both null);
--   - a genuinely different scope for the SAME target_field (e.g.
--     survival.carry_forward for rule_type=rebate vs
--     rule_type=service_credit vs rule_type=conditional_credit) has a
--     different slot_key and is therefore entirely unaffected — this
--     index is per-SLOT, never per-target_field; those remain independent,
--     simultaneously-draftable policies, exactly as before this migration;
--   - superseded/disabled history remains valid and unconstrained by this
--     index (status <> 'draft' for those rows) — this migration prevents
--     COMPETING drafts, it does not collapse or touch version history.
create unique index if not exists org_rulebook_one_draft_per_slot
  on organization_rulebook_rules (slot_key)
  where status = 'draft' and slot_key is not null;

-- ── Close the NULL-slot_key bypass (review finding, same pass) ──────────
--
-- The partial index above is scoped `... AND slot_key IS NOT NULL`, which
-- is required so the pre-existing Lynora legacy draft (slot_key left NULL,
-- deliberately never backfilled — see above) does not itself violate the
-- new constraint. But that same predicate means the index, on its own,
-- does nothing to stop a FUTURE draft row from also being inserted with a
-- NULL slot_key — any number of such rows could coexist and would never
-- collide, silently bypassing the one-draft-per-slot guarantee this
-- migration exists to add. A CHECK constraint cannot express this (it
-- would apply retroactively to the legacy row too, which must be left
-- alone), so this is a trigger: the invariant it enforces is "a NEW draft,
-- or a row newly TRANSITIONING into draft status, must carry a non-null
-- slot_key" — never "every draft row must have one", which is exactly the
-- distinction that protects the legacy row while closing the bypass for
-- everything else.
--
-- Ownership stays where it already was: this trigger only ever COMPARES
-- slot_key, never computes it — normalizeMatchConditions +
-- organizationPolicySlotKey (lib/rulebook/organization-policy-slot.ts)
-- remain the single canonical definition, unchanged by this addition.
--
-- Same function also enforces slot_key as immutable identity once
-- assigned (a second, independent invariant, folded into the one trigger
-- since both fire on the same insert/update of status/slot_key and both
-- are narrow, single-column checks in the same spirit as the existing
-- org_rulebook_enforce_same_org_lineage_trigger above): once a row has a
-- non-null slot_key, no future UPDATE may change it to a different value
-- (null or otherwise) — a rule version's canonical policy slot is fixed
-- at creation and never mutates in place. This does NOT constrain the
-- legacy row (old.slot_key IS NULL there), consistent with "leave it
-- alone until discarded through the supported UI"; normal lifecycle
-- transitions (draft -> active via activate_organization_rule_
-- supersession, draft -> disabled via discardDraftOrganizationRule,
-- active -> superseded) never touch slot_key at all, so none of them are
-- affected by this check either.
--
-- Third invariant (final safeguard) — a legacy NULL-slot draft may be
-- DISCARDED through the normal UI (draft -> disabled, deliberately left
-- unguarded, so the pre-migration Lynora row can still be cleaned up) but
-- must never become ACTIVE: activation is what makes a row authoritative
-- for real contract matching, and an authoritative rule with no canonical
-- slot identity is exactly the state this whole migration exists to make
-- impossible. Any row — legacy or newly created — reaching status =
-- 'active' with a null slot_key is rejected, whether via a direct INSERT
-- (createOrganizationRule permits inserting already-active) or an UPDATE
-- (activate_organization_rule_supersession's transition). A canonical row
-- (non-null slot_key, required by the two checks above at every point
-- before this) activates exactly as before — this only closes the one
-- path a NULL-slot row could otherwise take to become authoritative.
create or replace function org_rulebook_enforce_slot_key_invariants() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'draft' and new.slot_key is null then
      raise exception 'organization_rulebook_rules: a newly-inserted draft row must have a non-null slot_key (organization %, target_field %) — only pre-migration legacy rows may have a null slot_key while in draft status', new.organization_id, new.target_field;
    end if;
    if new.status = 'active' and new.slot_key is null then
      raise exception 'organization_rulebook_rules: a row inserted directly as active must have a non-null slot_key (organization %, target_field %) — a NULL-slot row may never become authoritative', new.organization_id, new.target_field;
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    -- A row transitioning INTO draft status (from any other status) must
    -- also carry a slot_key — the same requirement as a brand-new INSERT,
    -- just reached via UPDATE instead.
    if new.status = 'draft' and old.status is distinct from 'draft' and new.slot_key is null then
      raise exception 'organization_rulebook_rules: row % transitioning into draft status must have a non-null slot_key', new.id;
    end if;

    -- A row reaching (or remaining) active status must carry a slot_key —
    -- this is what makes "legacy NULL-slot draft -> active: rejected"
    -- true, while "legacy NULL-slot draft -> disabled: allowed" stays
    -- untouched (no check at all fires for that transition).
    if new.status = 'active' and new.slot_key is null then
      raise exception 'organization_rulebook_rules: row % cannot become active with a null slot_key — a legacy NULL-slot draft may be discarded but never activated', new.id;
    end if;

    -- Immutable identity: a non-null slot_key can never change once set.
    if old.slot_key is not null and new.slot_key is distinct from old.slot_key then
      raise exception 'organization_rulebook_rules: slot_key is immutable once assigned (row %, existing %, attempted %)', new.id, old.slot_key, new.slot_key;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists org_rulebook_enforce_slot_key_invariants_trigger on organization_rulebook_rules;
create trigger org_rulebook_enforce_slot_key_invariants_trigger
  before insert or update of status, slot_key on organization_rulebook_rules
  for each row execute function org_rulebook_enforce_slot_key_invariants();
