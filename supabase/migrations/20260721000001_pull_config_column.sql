-- Idempotent re-application of all infra_billing changes.
-- Created because 20260720000001_infra_billing.sql was never pushed to the
-- remote Supabase project, leaving pull_config absent from organizations and
-- triggering a PostgREST schema-cache miss on every write to that column.
-- All statements use CREATE OR REPLACE / ADD COLUMN IF NOT EXISTS / ON CONFLICT
-- DO NOTHING so this file is safe to run even if parts of 20260720000001 were
-- already applied locally.

-- ── org_subscriptions: infrastructure API hit counter ─────────────────────────
ALTER TABLE public.org_subscriptions
  ADD COLUMN IF NOT EXISTS infrastructure_api_hits bigint NOT NULL DEFAULT 0;

-- ── Atomic increment (race-condition safe) ────────────────────────────────────
-- Keyed on org_id so hits accumulate for all orgs with a subscription row,
-- regardless of whether a Stripe subscription was created via Checkout.
DROP FUNCTION IF EXISTS increment_infra_hits(text);
CREATE OR REPLACE FUNCTION increment_infra_hits(org_id_param uuid)
RETURNS void AS $$
BEGIN
  UPDATE public.org_subscriptions
  SET infrastructure_api_hits = infrastructure_api_hits + 1
  WHERE org_id = org_id_param;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── Atomic deduction (preserves concurrent hits during billing window) ─────────
CREATE OR REPLACE FUNCTION deduct_infra_hits(org_id_param uuid, deduct_amount bigint)
RETURNS void AS $$
BEGIN
  UPDATE public.org_subscriptions
  SET infrastructure_api_hits = GREATEST(0, infrastructure_api_hits - deduct_amount)
  WHERE org_id = org_id_param;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── organizations: on-demand pull config ──────────────────────────────────────
-- Nullable jsonb — absence (NULL) means "not configured".
-- The API layer returns only config_keys (field names), never values.
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS pull_config jsonb;

-- ── verdix_settings: default infrastructure price per hit ─────────────────────
INSERT INTO verdix_settings (key, value)
VALUES ('infra_hit_price_eur', '0.001'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ── PostgREST schema cache reload helper ──────────────────────────────────────
-- SECURITY DEFINER so it can be called via supabaseServer.rpc() (service role)
-- from the app layer without needing a superuser connection.
CREATE OR REPLACE FUNCTION reload_pgrst_schema()
RETURNS void AS $$
BEGIN
  NOTIFY pgrst, 'reload schema';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Force an immediate PostgREST schema-cache reload so the new column is
-- visible to all subsequent API calls without a process restart.
NOTIFY pgrst, 'reload schema';
