-- Persist the overage breakdown computed at send-time on planned_invoices,
-- instead of it only existing as a description string / metadata on the
-- Stripe/Remembill invoice item. Lets the billing timeline and revenue
-- charts show "what usage produced this invoice" without re-deriving it
-- from the billing platform after the fact.

ALTER TABLE planned_invoices
  ADD COLUMN IF NOT EXISTS overage_line_items JSONB   NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS overage_total       NUMERIC NOT NULL DEFAULT 0;

COMMENT ON COLUMN planned_invoices.overage_line_items IS
  'Array of { meter_key, unit_type, total_units, included_units, rate_per_unit, amount, currency, metric_source } computed by invoice-scheduler at send time. Empty for invoices with no overage, or not yet sent.';
COMMENT ON COLUMN planned_invoices.overage_total IS
  'Sum of overage_line_items[].amount — denormalized for fast total lookups.';
