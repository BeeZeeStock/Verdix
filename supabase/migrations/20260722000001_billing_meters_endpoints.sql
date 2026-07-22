-- Add per-meter pull endpoint configuration to billing_meters.
--
-- pull_endpoint_url  — URL Verdix calls at billing time for this meter's usage
-- pull_auth_token    — Bearer token sent in Authorization header (write-once, never returned to browser)
-- pull_param_name    — Query parameter name used for the billing dimension key (default: billing_parameter)
--
-- Verdix's own sync meter will have pull_endpoint_url set to /api/internal/usage
-- by the admin through the /admin/meters GUI — same flow as any 3PP SaaS company.

ALTER TABLE billing_meters
  ADD COLUMN IF NOT EXISTS pull_endpoint_url TEXT,
  ADD COLUMN IF NOT EXISTS pull_auth_token   TEXT,
  ADD COLUMN IF NOT EXISTS pull_param_name   TEXT NOT NULL DEFAULT 'billing_parameter';

NOTIFY pgrst, 'reload schema';
