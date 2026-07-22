-- Flexible metric ledger: replaces the pair of hardcoded columns
-- (syncs_used, infrastructure_api_hits) with a single JSONB map keyed by
-- metric type. Adding a new billing dimension requires zero schema changes —
-- just POST a new metric_type to /api/usage/record.
--
-- syncs_used is kept in the table (set to 0) for a safe rollback window.
-- It will be dropped in a follow-up migration once the ledger is confirmed stable.

-- ── 1. Ledger column on org_subscriptions ─────────────────────────────────────
ALTER TABLE public.org_subscriptions
  ADD COLUMN IF NOT EXISTS usage_counters jsonb NOT NULL DEFAULT '{}';

-- Seed from existing syncs_used so no billing history is lost
UPDATE public.org_subscriptions
  SET usage_counters = jsonb_build_object('sync', COALESCE(syncs_used, 0))
  WHERE usage_counters = '{}';

-- ── 2. Per-metric pricing config on verdix_plans ───────────────────────────────
-- Shape: { "api_call": { "included": 0, "overage_price_eur": 0.001 } }
-- The canonical "sync" metric continues to use sync_limit / overage_price_eur
-- columns so the existing admin UI needs no changes.
ALTER TABLE public.verdix_plans
  ADD COLUMN IF NOT EXISTS metric_config jsonb NOT NULL DEFAULT '{}';

-- ── 3. Atomic increment for any metric type ───────────────────────────────────
CREATE OR REPLACE FUNCTION increment_usage_counter(
  org_id_param uuid,
  metric_type  text,
  amount       bigint DEFAULT 1
)
RETURNS void AS $$
BEGIN
  UPDATE public.org_subscriptions
  SET usage_counters = jsonb_set(
    COALESCE(usage_counters, '{}'),
    ARRAY[metric_type],
    to_jsonb(COALESCE((usage_counters ->> metric_type)::bigint, 0) + amount)
  )
  WHERE org_id = org_id_param;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── 4. Atomic safe deduction for any metric type ──────────────────────────────
-- Floors at 0 so concurrent hits arriving during the billing window are never
-- lost to a race condition.
CREATE OR REPLACE FUNCTION deduct_usage_counter(
  org_id_param uuid,
  metric_type  text,
  amount       bigint
)
RETURNS void AS $$
BEGIN
  UPDATE public.org_subscriptions
  SET usage_counters = jsonb_set(
    COALESCE(usage_counters, '{}'),
    ARRAY[metric_type],
    to_jsonb(GREATEST(0, COALESCE((usage_counters ->> metric_type)::bigint, 0) - amount))
  )
  WHERE org_id = org_id_param;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── 5. Remove single-purpose functions superseded by the generic ledger ────────
DROP FUNCTION IF EXISTS increment_infra_hits(uuid);
DROP FUNCTION IF EXISTS deduct_infra_hits(uuid, bigint);

-- ── 6. Schema cache reload ────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
