-- Infrastructure API hit counter for Verdix internal billing
ALTER TABLE public.org_subscriptions
  ADD COLUMN IF NOT EXISTS infrastructure_api_hits bigint NOT NULL DEFAULT 0;

-- Atomic per-hit increment (avoids read-then-write race conditions at API scale)
-- Called from POST /api/usage/record on each 3PP request.
CREATE OR REPLACE FUNCTION increment_infra_hits(org_id_param uuid)
RETURNS void AS $$
BEGIN
  UPDATE public.org_subscriptions
  SET infrastructure_api_hits = infrastructure_api_hits + 1
  WHERE org_id = org_id_param;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Safe atomic deduction at billing time: subtract exactly what was billed so
-- hits that arrive during the webhook processing window are never lost.
CREATE OR REPLACE FUNCTION deduct_infra_hits(org_id_param uuid, deduct_amount bigint)
RETURNS void AS $$
BEGIN
  UPDATE public.org_subscriptions
  SET infrastructure_api_hits = GREATEST(0, infrastructure_api_hits - deduct_amount)
  WHERE org_id = org_id_param;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Org-level on-demand pull config (client_usage_url + client_read_api_key).
-- Stored as JSONB so the backend can mask the key exactly like Stripe credentials —
-- returning config_keys (field names) to the client but never the values.
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS pull_config jsonb;

-- Default infrastructure price per API hit (EUR). Can be overridden by admin via
-- the verdix_settings K/V store without a schema change.
INSERT INTO verdix_settings (key, value)
VALUES ('infra_hit_price_eur', '0.001'::jsonb)
ON CONFLICT (key) DO NOTHING;
