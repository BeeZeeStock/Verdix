-- Step 17D, item 3 — the smallest explicit organization-level concept
-- needed to replace lib/admin.ts's hard-coded isRemembillTeam() domain
-- check as the long-term authorization model for cross-tenant source
-- management. Audited first (this session): organizations has no existing
-- lifecycle/design-partner/tier concept at all — id, name, slug,
-- allowed_domain, created_by, created_at only. This adds exactly one
-- column, reusing the existing organizations/org_memberships/OrgRole
-- primitives (lib/org.ts) for everything else (who is "admin of the
-- owning org" is already answered by org_memberships.role — nothing new
-- needed there).
--
-- 'design_partner': Verdix platform admins (lib/admin.ts's isAdminEmail)
-- may manage this org's sources for testing/support, in addition to the
-- org's own admins/owners.
-- 'production_customer' (default): Verdix platform admins get NO ordinary
-- cross-tenant source-management access — only the org's own admins/owners
-- do. This is the default for every existing and future org, preserving
-- current behavior for everyone except the orgs explicitly flagged.
--
-- Transitioning design_partner -> production_customer is a single UPDATE
-- of this column — it never touches billing_meters/contract_meter_mappings
-- rows, so it can never require recreating or migrating a customer's
-- meters (item 3's explicit requirement).
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS lifecycle_stage text NOT NULL DEFAULT 'production_customer'
    CHECK (lifecycle_stage IN ('design_partner', 'production_customer'));

CREATE INDEX IF NOT EXISTS organizations_lifecycle_stage_idx ON organizations (lifecycle_stage);

-- CoAccept AB (Remembill) is Verdix's current design partner for the
-- usage-meter connector — confirmed via a one-time read-only audit query
-- this session (organizations.id = 'cd73f7a4-eb45-426e-9f3c-b3c8875a2e11',
-- name 'CoAccept AB'). Flagged explicitly here rather than left to a
-- separate manual step, since this IS the concrete case item 15's meter-
-- ownership migration depends on. Re-verify this id is still correct
-- immediately before applying — it was captured at audit time, not
-- guaranteed current.
UPDATE organizations
  SET lifecycle_stage = 'design_partner'
  WHERE id = 'cd73f7a4-eb45-426e-9f3c-b3c8875a2e11';

NOTIFY pgrst, 'reload schema';
