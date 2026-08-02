-- Split Stripe IDs into test/live columns so sandbox and live environments
-- don't overwrite each other when pushing plans.

ALTER TABLE verdix_plans
  ADD COLUMN IF NOT EXISTS stripe_product_id_test text,
  ADD COLUMN IF NOT EXISTS stripe_product_id_live text,
  ADD COLUMN IF NOT EXISTS stripe_price_id_test   text,
  ADD COLUMN IF NOT EXISTS stripe_price_id_live   text,
  ADD COLUMN IF NOT EXISTS stripe_cycle_prices_test jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS stripe_cycle_prices_live jsonb DEFAULT '{}'::jsonb;

-- Treat all existing Stripe IDs as coming from the test environment
UPDATE verdix_plans SET
  stripe_product_id_test   = stripe_product_id,
  stripe_price_id_test     = stripe_price_id,
  stripe_cycle_prices_test = COALESCE(stripe_cycle_prices, '{}'::jsonb)
WHERE stripe_product_id IS NOT NULL
   OR stripe_price_id   IS NOT NULL;
