-- Stripe meter provisioning state and computed invoice audit log

-- Which subscription items map to which Stripe Billing Meters, per contract
ALTER TABLE contract_terms
  ADD COLUMN IF NOT EXISTS stripe_metered_items jsonb DEFAULT '[]';
-- Shape: [{ unit_type, meter_id, price_id, subscription_item_id }]

-- Audit log of every invoice computed by the Verdix webhook interceptor
CREATE TABLE IF NOT EXISTS stripe_computed_invoices (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                 uuid REFERENCES jobs(id) ON DELETE CASCADE,
  stripe_invoice_id      text NOT NULL,
  stripe_subscription_id text,
  period_start           timestamptz,
  period_end             timestamptz,
  line_items             jsonb NOT NULL DEFAULT '[]',
  total_amount           numeric,
  currency               text,
  -- DRAFT: injected into Stripe draft, awaiting AP finalization
  -- FINALIZED: AP finalized the Stripe invoice
  -- VOID: invoice was voided
  status                 text NOT NULL DEFAULT 'DRAFT',
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sci_job_id_idx    ON stripe_computed_invoices (job_id);
CREATE INDEX IF NOT EXISTS sci_invoice_idx   ON stripe_computed_invoices (stripe_invoice_id);
CREATE INDEX IF NOT EXISTS sci_status_idx    ON stripe_computed_invoices (status);
