-- Lets planned_invoices carry the real quantity/unit-price breakdown from the
-- approved line_items row that produced it (e.g. "4 connectors @ 45,000"),
-- instead of only a flat base_amount. line_item_id is nullable/SET NULL since
-- a planned_invoices row must survive a line_items row being deleted.

ALTER TABLE planned_invoices
  ADD COLUMN IF NOT EXISTS line_item_id UUID REFERENCES line_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS quantity     NUMERIC(10, 4),
  ADD COLUMN IF NOT EXISTS unit_price   NUMERIC(15, 4);

COMMENT ON COLUMN planned_invoices.line_item_id IS
  'The line_items row this invoice was generated from, if any — lets a human correction to quantity/unit_price be traced back to what was actually invoiced.';
COMMENT ON COLUMN planned_invoices.quantity IS
  'Real quantity for this invoice (e.g. 4 connectors), pulled from the matching line_items row. NULL for rows created before this column existed, or where no per-unit breakdown applies.';
COMMENT ON COLUMN planned_invoices.unit_price IS
  'Real per-unit price paired with quantity. base_amount remains the authoritative total (quantity * unit_price should equal it, but base_amount is what''s actually invoiced).';
