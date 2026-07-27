-- planned_invoices: Verdix-owned billing schedule.
-- At contract push time, every future billing period is written here instead of
-- creating Stripe subscriptions. A daily scheduler picks up due rows and creates
-- complete standalone Stripe invoices (base + overages), then marks them 'sent'.
-- When Stripe reports payment, the row is marked 'paid'.

CREATE TABLE IF NOT EXISTS planned_invoices (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id             UUID        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  org_id             UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Which contract year this period belongs to (1, 2, 3 …). NULL for one-time fees.
  year_num           INTEGER,

  -- Billing period covered by this invoice (inclusive on both ends).
  period_start       DATE        NOT NULL,
  period_end         DATE        NOT NULL,

  -- Committed base amount for this period. Does NOT include overages — those are
  -- computed and added by the scheduler at billing time.
  base_amount        NUMERIC     NOT NULL DEFAULT 0,
  currency           TEXT        NOT NULL DEFAULT 'EUR',

  -- For one-time fees: the fee label shown on the invoice.
  fee_label          TEXT,

  -- 'period'   — recurring billing period (monthly / quarterly / annual)
  -- 'one_time' — one-time fee (setup, onboarding, etc.)
  invoice_type       TEXT        NOT NULL DEFAULT 'period',

  -- Lifecycle: scheduled → processing → sent → paid
  --                                   ↘ failed
  status             TEXT        NOT NULL DEFAULT 'scheduled',

  -- Set once the Stripe invoice has been created and finalized.
  stripe_invoice_id  TEXT,
  stripe_invoice_url TEXT,

  -- Populated on failure so ops can investigate and retry.
  error_message      TEXT,

  sent_at            TIMESTAMPTZ,
  paid_at            TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS planned_invoices_job_id
  ON planned_invoices (job_id);

-- Scheduler query: "give me everything due today that hasn't been sent yet"
CREATE INDEX IF NOT EXISTS planned_invoices_due
  ON planned_invoices (status, period_start);

CREATE INDEX IF NOT EXISTS planned_invoices_org_id
  ON planned_invoices (org_id);

-- Fast lookup when webhook reports payment on a Stripe invoice ID.
CREATE INDEX IF NOT EXISTS planned_invoices_stripe_id
  ON planned_invoices (stripe_invoice_id)
  WHERE stripe_invoice_id IS NOT NULL;

ALTER TABLE planned_invoices ENABLE ROW LEVEL SECURITY;
