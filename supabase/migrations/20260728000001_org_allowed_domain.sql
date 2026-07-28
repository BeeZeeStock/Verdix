-- Domain auto-join: any user whose email domain matches will be auto-joined as member
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS allowed_domain text;
CREATE INDEX IF NOT EXISTS organizations_allowed_domain_idx ON organizations (allowed_domain);
