ALTER TABLE planned_invoices
  ADD COLUMN IF NOT EXISTS credit_line_items JSONB   NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS credit_total       NUMERIC NOT NULL DEFAULT 0;

COMMENT ON COLUMN planned_invoices.credit_line_items IS
  'Credit/rebate adjustments actually applied to this invoice at send time — [{description, amount, credit_rule_id, ...}]. Amounts are negative (reductions). Same pattern as overage_line_items.';
COMMENT ON COLUMN planned_invoices.credit_total IS
  'Sum of credit_line_items[].amount (negative) — denormalized for fast total lookups.';
