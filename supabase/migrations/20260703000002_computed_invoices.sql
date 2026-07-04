-- Rename stripe_computed_invoices → computed_invoices (connector-neutral)
-- Rename Stripe-specific columns → external_* equivalents
-- Add connector, paid_at, validation_result, external_invoice_pdf_url
-- Extend status to cover full invoice lifecycle

ALTER TABLE stripe_computed_invoices RENAME TO computed_invoices;

ALTER TABLE computed_invoices
  RENAME COLUMN stripe_invoice_id      TO external_invoice_id;

ALTER TABLE computed_invoices
  RENAME COLUMN stripe_subscription_id TO external_subscription_id;

-- Which billing connector produced this invoice (stripe, chargebee, …)
ALTER TABLE computed_invoices
  ADD COLUMN IF NOT EXISTS connector TEXT NOT NULL DEFAULT 'stripe';

-- Lifecycle timestamps
ALTER TABLE computed_invoices
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;

-- Output from invoice-validator (array of LeakageFinding-shaped objects)
ALTER TABLE computed_invoices
  ADD COLUMN IF NOT EXISTS validation_result JSONB;

-- URL to the finalized invoice PDF (set once Stripe/connector finalizes)
ALTER TABLE computed_invoices
  ADD COLUMN IF NOT EXISTS external_invoice_pdf_url TEXT;

-- Rename indexes to match new table name
ALTER INDEX sci_job_id_idx   RENAME TO ci_job_id_idx;
ALTER INDEX sci_invoice_idx  RENAME TO ci_external_invoice_idx;
ALTER INDEX sci_status_idx   RENAME TO ci_status_idx;

-- Add index on connector for future multi-connector queries
CREATE INDEX IF NOT EXISTS ci_connector_idx ON computed_invoices (connector);

-- Add index on paid_at for payment reporting queries
CREATE INDEX IF NOT EXISTS ci_paid_at_idx ON computed_invoices (paid_at);

-- Rename stripe_metered_items column in contract_terms → billing_metered_items
ALTER TABLE contract_terms
  RENAME COLUMN stripe_metered_items TO billing_metered_items;

-- Status reference (comment only — stored as TEXT, not enum, for flexibility):
-- DRAFT         : Verdix injected overages into Stripe draft invoice
-- VALIDATED     : Billing check agent passed — no issues found
-- NEEDS_REVIEW  : Billing check agent flagged one or more issues
-- SENT          : Invoice finalized and sent to customer via connector
-- PAID          : Payment confirmed via connector webhook
-- VOID          : Invoice was voided
