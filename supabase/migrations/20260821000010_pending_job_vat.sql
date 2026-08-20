-- customer_vat_config is keyed by (org_id, billing_customer_id) — but the
-- billing_customer_id doesn't exist until a job is actually approved
-- (configureBilling creates the customer as part of that same call). A
-- reviewer needs to set VAT treatment BEFORE approving (so approval can
-- fail closed on it, per the "surface VAT in the approval workflow, block
-- push if unconfigured" requirement), which means it has to be staged
-- somewhere job-scoped first. Approval promotes this into the real
-- customer_vat_config row once billing_customer_id is known — see
-- app/api/jobs/[id]/approve/route.ts.
alter table jobs
  add column if not exists pending_vat_mode     text default 'not_configured' check (pending_vat_mode in ('rate', 'zero_rated', 'not_configured')),
  add column if not exists pending_vat_rate_pct numeric check (pending_vat_rate_pct is null or (pending_vat_rate_pct >= 0 and pending_vat_rate_pct <= 100));
