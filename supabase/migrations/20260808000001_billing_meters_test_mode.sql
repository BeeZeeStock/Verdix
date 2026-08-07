-- Test/live gating for billing_meters. A meter stays in 'test' mode until an
-- admin explicitly flips it live — invoice-scheduler's real cron will not
-- pull from pull_endpoint_url for a meter still in 'test' mode, so a
-- half-configured meter can never accidentally bill a real customer.
-- test_usage_value is the admin-entered simulated reading used by the
-- Billing Test GUI to preview overage math without touching real invoices.

ALTER TABLE billing_meters
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'test' CHECK (mode IN ('test', 'live')),
  ADD COLUMN IF NOT EXISTS test_usage_value NUMERIC,
  ADD COLUMN IF NOT EXISTS test_usage_updated_at TIMESTAMPTZ;
