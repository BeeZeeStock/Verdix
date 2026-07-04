-- Organizations table
CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Org memberships with RBAC
CREATE TABLE IF NOT EXISTS org_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_email text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')) DEFAULT 'member',
  status text NOT NULL CHECK (status IN ('active', 'invited')) DEFAULT 'active',
  invited_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(org_id, user_email)
);

CREATE INDEX IF NOT EXISTS org_memberships_user_email_idx ON org_memberships (user_email);
CREATE INDEX IF NOT EXISTS org_memberships_org_id_idx ON org_memberships (org_id);

-- Add org_id to jobs table
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id);
CREATE INDEX IF NOT EXISTS jobs_org_id_idx ON jobs (org_id);
