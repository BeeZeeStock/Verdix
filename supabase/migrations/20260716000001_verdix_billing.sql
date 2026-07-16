-- Verdix SaaS billing plans (source of truth, pushed to Stripe by admin)
CREATE TABLE IF NOT EXISTS verdix_plans (
  id                  text        PRIMARY KEY,  -- 'trial' | 'core' | 'pro' | 'enterprise'
  name                text        NOT NULL,
  base_price_eur      numeric     NOT NULL DEFAULT 0,
  sync_limit          int,                       -- NULL = unlimited (enterprise)
  overage_price_eur   numeric,                   -- per excess sync; NULL if not applicable
  pii_addon_available boolean     NOT NULL DEFAULT false,
  stripe_product_id   text,
  stripe_price_id     text,                      -- monthly recurring price
  is_active           boolean     NOT NULL DEFAULT true,
  sort_order          int         NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- One row per org tracking their Verdix SaaS subscription
CREATE TABLE IF NOT EXISTS org_subscriptions (
  org_id                      uuid        PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id                     text        NOT NULL DEFAULT 'trial' REFERENCES verdix_plans(id),
  stripe_customer_id          text,
  stripe_subscription_id      text,
  current_period_start        timestamptz,
  current_period_end          timestamptz,
  syncs_used                  int         NOT NULL DEFAULT 0,
  trial_sync_limit_override   int,               -- NULL = use global verdix_settings value
  pii_addon_enabled           boolean     NOT NULL DEFAULT false,
  pii_addon_enabled_at        timestamptz,
  status                      text        NOT NULL DEFAULT 'active',
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS org_subscriptions_stripe_customer_idx ON org_subscriptions (stripe_customer_id);
CREATE INDEX IF NOT EXISTS org_subscriptions_stripe_sub_idx      ON org_subscriptions (stripe_subscription_id);

-- Audit trail of every agreement sync consumed
CREATE TABLE IF NOT EXISTS sync_events (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_id               uuid        REFERENCES jobs(id) ON DELETE SET NULL,
  event_type           text        NOT NULL, -- 'contract_configure' | 'billing_audit' | 'partner_recon'
  billing_period_start timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sync_events_org_id_idx ON sync_events (org_id);

-- Global Verdix admin settings (key-value store)
CREATE TABLE IF NOT EXISTS verdix_settings (
  key        text        PRIMARY KEY,
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- RLS: all tables accessed via service role only (no direct client access)
ALTER TABLE verdix_plans      ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE verdix_settings   ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_only" ON verdix_plans      FOR ALL USING (true);
CREATE POLICY "service_role_only" ON org_subscriptions FOR ALL USING (true);
CREATE POLICY "service_role_only" ON sync_events       FOR ALL USING (true);
CREATE POLICY "service_role_only" ON verdix_settings   FOR ALL USING (true);

-- Seed plans
INSERT INTO verdix_plans (id, name, base_price_eur, sync_limit, overage_price_eur, pii_addon_available, sort_order)
VALUES
  ('trial',      'Verdix Standard (Trial)', 0,   NULL, NULL, false, 0),
  ('core',       'Verdix Core',             95,  10,   5.00, true,  1),
  ('pro',        'Verdix Pro',              445, 100,  2.50, true,  2),
  ('enterprise', 'Verdix Enterprise',       0,   NULL, NULL, true,  3)
ON CONFLICT (id) DO NOTHING;

-- Seed global settings
INSERT INTO verdix_settings (key, value)
VALUES
  ('trial_sync_limit',    '3'::jsonb),
  ('trial_warn_pct',      '80'::jsonb)
ON CONFLICT (key) DO NOTHING;
