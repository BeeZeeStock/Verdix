-- Flexible billing infrastructure
-- billing_meters: platform meter definitions
-- contract_meter_mappings: extracted unit_types → confirmed meter keys (per job)
-- org_billing_config: live billing config per org (from plan or confirmed agreement)
-- usage_ledger: timestamped usage events (period-aware source of truth)
-- verdix_plans: gains billing_cycles + stripe_cycle_prices
-- org_subscriptions: gains billing_cycle

-- ── 1. Platform meter definitions ─────────────────────────────────────────────
-- org_id NULL = Verdix-owned meters available to all.
-- 3PP SaaS clients register their own meters with their org_id.
CREATE TABLE IF NOT EXISTS billing_meters (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid        REFERENCES organizations(id) ON DELETE CASCADE,
  meter_key    text        NOT NULL,
  display_name text        NOT NULL,
  unit_label   text        NOT NULL,
  description  text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS billing_meters_org_key_idx
  ON billing_meters (COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid), meter_key);
CREATE INDEX IF NOT EXISTS billing_meters_org_idx ON billing_meters (org_id);

-- ── 2. Contract extraction → meter mapping (per job) ──────────────────────────
-- Each unique unit_type from overage_tiers gets one row here.
-- Auto-mapped on extraction; human confirms before approve is enabled.
CREATE TABLE IF NOT EXISTS contract_meter_mappings (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id             uuid        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  contract_unit_type text        NOT NULL,  -- raw string from overage_tiers[].unit_type
  meter_key          text        NOT NULL,  -- resolved billing_meters.meter_key
  confidence         numeric,               -- 0–1 auto-map confidence score
  confirmed          boolean     NOT NULL DEFAULT false,
  confirmed_by       text,
  confirmed_at       timestamptz,
  included_units     bigint,                -- effective free allowance (from_unit - 1 of first tier)
  overage_tiers      jsonb       NOT NULL DEFAULT '[]',  -- [{from_unit,to_unit,rate_per_unit}]
  billing_cycle      text        NOT NULL DEFAULT 'monthly',
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, contract_unit_type)
);

CREATE INDEX IF NOT EXISTS contract_meter_mappings_job_idx ON contract_meter_mappings (job_id);

-- ── 3. Active billing config per org ──────────────────────────────────────────
-- Single source of truth that the billing engine reads at invoice time.
-- source='plan': written at self-service checkout from verdix_plans
-- source='agreement': written from confirmed contract_meter_mappings on approve
CREATE TABLE IF NOT EXISTS org_billing_config (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  meter_key      text        NOT NULL,
  included_units bigint      NOT NULL DEFAULT 0,
  overage_tiers  jsonb       NOT NULL DEFAULT '[]',
  billing_cycle  text        NOT NULL DEFAULT 'monthly',
  cycle_start    date,
  source         text        NOT NULL DEFAULT 'plan',  -- 'plan' | 'agreement'
  job_id         uuid        REFERENCES jobs(id) ON DELETE SET NULL,
  active         boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, meter_key)
);

CREATE INDEX IF NOT EXISTS org_billing_config_org_idx ON org_billing_config (org_id);

-- ── 4. Usage ledger (timestamped, period-queryable) ────────────────────────────
-- Every usage event written here with a timestamp.
-- occurred_at is the real time; simulated_at overrides it in test simulations.
-- usage_counters on org_subscriptions stays as a fast read cache only.
CREATE TABLE IF NOT EXISTS usage_ledger (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  meter_key    text        NOT NULL,
  quantity     bigint      NOT NULL DEFAULT 1,
  job_id       uuid        REFERENCES jobs(id) ON DELETE SET NULL,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  is_simulated boolean     NOT NULL DEFAULT false,
  simulated_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS usage_ledger_org_meter_period_idx ON usage_ledger (org_id, meter_key, occurred_at);

-- ── 5. Per-cycle pricing on verdix_plans ──────────────────────────────────────
-- billing_cycles: [{cycle:'monthly',price_eur:49},{cycle:'quarterly',price_eur:129},...]
-- stripe_cycle_prices: {monthly:'price_xxx', quarterly:'price_yyy', yearly:'price_zzz'}
ALTER TABLE verdix_plans
  ADD COLUMN IF NOT EXISTS billing_cycles      jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS stripe_cycle_prices jsonb NOT NULL DEFAULT '{}';

-- Seed monthly entry from existing base_price_eur so plans remain consistent
UPDATE verdix_plans
  SET billing_cycles = jsonb_build_array(
    jsonb_build_object('cycle', 'monthly', 'price_eur', base_price_eur)
  )
  WHERE billing_cycles = '[]' AND base_price_eur > 0;

-- ── 6. Billing cycle on org_subscriptions ─────────────────────────────────────
ALTER TABLE org_subscriptions
  ADD COLUMN IF NOT EXISTS billing_cycle text NOT NULL DEFAULT 'monthly';

-- ── 7. RLS (service role only — same pattern as rest of billing tables) ────────
ALTER TABLE billing_meters          ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_meter_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_billing_config      ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_ledger            ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'billing_meters' AND policyname = 'service_role_only') THEN
    CREATE POLICY "service_role_only" ON billing_meters          FOR ALL USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'contract_meter_mappings' AND policyname = 'service_role_only') THEN
    CREATE POLICY "service_role_only" ON contract_meter_mappings FOR ALL USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'org_billing_config' AND policyname = 'service_role_only') THEN
    CREATE POLICY "service_role_only" ON org_billing_config      FOR ALL USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'usage_ledger' AND policyname = 'service_role_only') THEN
    CREATE POLICY "service_role_only" ON usage_ledger            FOR ALL USING (true);
  END IF;
END $$;

-- ── 8. Seed Verdix platform meters ────────────────────────────────────────────
INSERT INTO billing_meters (org_id, meter_key, display_name, unit_label, description)
VALUES
  (NULL, 'sync',     'Agreement Sync', 'sync',      'A complete contract / billing / partner agreement sync run'),
  (NULL, 'api_call', 'API Call',       'call',      'A single API gateway request processed by the platform'),
  (NULL, 'user',     'Active User',    'user seat', 'A billable user seat active within the billing period')
ON CONFLICT DO NOTHING;

-- ── 9. Function: write to usage_ledger alongside usage_counters ───────────────
CREATE OR REPLACE FUNCTION record_usage(
  org_id_param  uuid,
  meter_key_param text,
  amount_param  bigint DEFAULT 1,
  job_id_param  uuid   DEFAULT NULL,
  occurred_at_param timestamptz DEFAULT now()
)
RETURNS void AS $$
BEGIN
  -- Update fast-read counter cache
  UPDATE public.org_subscriptions
    SET usage_counters = jsonb_set(
      COALESCE(usage_counters, '{}'),
      ARRAY[meter_key_param],
      to_jsonb(COALESCE((usage_counters ->> meter_key_param)::bigint, 0) + amount_param)
    )
    WHERE org_id = org_id_param;

  -- Append to audit ledger
  INSERT INTO public.usage_ledger (org_id, meter_key, quantity, job_id, occurred_at)
    VALUES (org_id_param, meter_key_param, amount_param, job_id_param, occurred_at_param);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── 10. Function: sum ledger for a period (used by billing engine + test GUI) ─
CREATE OR REPLACE FUNCTION sum_usage_for_period(
  org_id_param    uuid,
  meter_key_param text,
  period_start    timestamptz,
  period_end      timestamptz,
  include_simulated boolean DEFAULT false
)
RETURNS bigint AS $$
DECLARE
  total bigint;
BEGIN
  SELECT COALESCE(SUM(quantity), 0) INTO total
    FROM public.usage_ledger
    WHERE org_id    = org_id_param
      AND meter_key = meter_key_param
      AND (
        CASE WHEN is_simulated AND simulated_at IS NOT NULL
          THEN simulated_at
          ELSE occurred_at
        END
      ) BETWEEN period_start AND period_end
      AND (include_simulated OR NOT is_simulated);
  RETURN total;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

NOTIFY pgrst, 'reload schema';
