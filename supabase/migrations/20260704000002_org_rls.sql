-- Disable RLS on org tables — access is controlled at the app layer via service role key
ALTER TABLE organizations DISABLE ROW LEVEL SECURITY;
ALTER TABLE org_memberships DISABLE ROW LEVEL SECURITY;
