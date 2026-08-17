-- Feature flag gating public self-service signup, /api/signup, and the
-- lib/org.ts auto-org-creation fallback. Stored as a JSON string ("true"/
-- "false", quoted) to match the existing live_checkout_active convention —
-- app/api/admin/billing/route.ts's generic setting-upsert PUT sends a JS
-- string through supabase-js, which the jsonb column stores quoted; reads
-- compare with `=== 'true'`, not a JSON boolean.
INSERT INTO verdix_settings (key, value)
VALUES ('self_service_signup_enabled', '"true"'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Membership-level "disabled" state, distinct from deleting the row or
-- leaving it "invited" — lets a platform admin revoke a specific user's
-- access to a specific org without touching their other org memberships.
ALTER TABLE org_memberships DROP CONSTRAINT IF EXISTS org_memberships_status_check;
ALTER TABLE org_memberships ADD CONSTRAINT org_memberships_status_check
  CHECK (status IN ('active', 'invited', 'disabled'));

-- Lets the admin invite/resend UI show "last sent" and re-sending is just
-- another provisionAndInviteUser() call rather than needing a separate
-- invitations table.
ALTER TABLE org_memberships ADD COLUMN IF NOT EXISTS invite_last_sent_at timestamptz;

-- Provenance for admin-provisioned orgs — not required by any read path,
-- purely for admin-UI visibility.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS created_by text;
