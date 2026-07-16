INSERT INTO verdix_plans (id, name, base_price_eur, sync_limit, overage_price_eur, pii_addon_available, is_active, sort_order)
VALUES ('pii_addon', 'Advanced PII Data Masking', 45, NULL, NULL, false, true, 99)
ON CONFLICT (id) DO NOTHING;
