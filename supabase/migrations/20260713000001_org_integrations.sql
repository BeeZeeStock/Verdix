-- Integration credentials per org (billing platforms + CRM systems)
CREATE TABLE IF NOT EXISTS org_integrations (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connector_type text        NOT NULL CHECK (connector_type IN ('billing', 'crm')),
  connector_name text        NOT NULL,
  config         jsonb       NOT NULL DEFAULT '{}',
  is_active      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, connector_name)
);

CREATE INDEX IF NOT EXISTS org_integrations_org_id_idx ON org_integrations (org_id);

-- RLS: members can read their org's integrations (but not the config values — handled at app layer)
ALTER TABLE org_integrations ENABLE ROW LEVEL SECURITY;

-- Policy: users can see integrations for orgs they belong to
CREATE POLICY "org members can read integrations"
  ON org_integrations FOR SELECT
  USING (
    org_id IN (
      SELECT org_id FROM org_memberships WHERE user_email = current_user
    )
  );
