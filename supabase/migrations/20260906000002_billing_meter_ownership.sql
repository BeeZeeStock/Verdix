-- Step 17D.1, item A — audited: billing_meters.org_id ALREADY represents
-- "the owning organization for an org-created meter" (org_id IS NULL was
-- used for two DIFFERENT, previously-conflated things — see below). There
-- is no reason to introduce a second ownership column; org_id is the one
-- and only ownership authority. Every BUSINESS meter (a customer's own
-- configured connector to their downstream data source — the 5 Remembill
-- meters, and any future customer-created meter) gets a real, required
-- org_id.
--
-- Escape hatch actually exercised, not a default: 'sync' (and, if ever
-- seeded, 'api_call'/'user' — supabase/migrations/20260721000003_
-- billing_meters.sql) is NOT a business meter in this sense at all — it
-- measures usage of the VERDIX PLATFORM ITSELF (e.g. "how many contract
-- syncs did this customer run"), consumed by lib/billing-engine.ts,
-- lib/credit-ledger-service.ts, and app/api/v1/usage/route.ts to bill
-- EVERY Verdix customer for their OWN use of the product — genuinely,
-- correctly platform-shared by design, never a per-tenant "business
-- meter" a reviewer would pick when mapping a customer's downstream
-- contract (confirmed: it never appears in contract_meter_mappings/
-- overage_tiers shape at all). This is exactly the "separately justified
-- non-business/system meter category" item A anticipates — NOT a
-- reintroduction of the old unconstrained "org_id IS NULL means platform"
-- default: is_platform_meter must be explicitly TRUE for org_id to be
-- null, enforced by a CHECK constraint, not left to convention.
--
-- Step 17D.1, item B — the Verdix organization (used for nothing in this
-- migration now that 'sync' stays platform-shared, but kept documented
-- for any future genuinely Verdix-owned BUSINESS meter) is resolved from
-- real evidence, not guessed among the several similarly-named candidates
-- found during the audit: b911acab-03b1-48fd-8195-e2b2731ed69a
-- ("Lynora AB") has a VERIFIED allowed_domain (lynoraai.com), 60 real
-- jobs (every other "lynoraai"-named candidate has zero), real
-- org_integrations rows (stripe + remembill, active), and a real
-- org_subscriptions row (trial plan). The other ~14 candidates each have
-- exactly one membership, zero jobs, zero integrations, zero
-- subscriptions, all created within the same few seconds on 2026-08-17 —
-- dev/test artifacts, not real organizations. Unambiguous; re-verify
-- immediately before applying in case the data has changed since this
-- audit.
ALTER TABLE billing_meters
  -- Step 17D.1, item D — the canonical fact this meter supplies, reusing
  -- the SAME closed recognized-key/alias registry as operational inputs
  -- (lib/operational-input-canonicalization.ts, Step 17C.3c).
  ADD COLUMN IF NOT EXISTS semantic_input_key text,
  ADD COLUMN IF NOT EXISTS is_platform_meter boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS billing_meters_semantic_input_key_idx ON billing_meters (semantic_input_key);

-- ── Backfill ────────────────────────────────────────────────────────────
-- The 5 connector='remembill' meters -> CoAccept AB. A real business
-- meter, a real owner.
UPDATE billing_meters
  SET org_id = 'cd73f7a4-eb45-426e-9f3c-b3c8875a2e11'  -- CoAccept AB (Remembill)
  WHERE connector = 'remembill' AND org_id IS NULL;

-- Every remaining org_id IS NULL row (today: only 'sync') is a genuine
-- Verdix-platform system meter — explicitly flagged, org_id stays null,
-- enforced by the CHECK constraint below rather than left implicit.
UPDATE billing_meters
  SET is_platform_meter = true
  WHERE org_id IS NULL;

-- Step 17D.1, item A — "After migration there should be no business meter
-- with org_id IS NULL unless there is a separately justified non-
-- business/system meter category." This constraint IS that justification,
-- enforced structurally: org_id may be null ONLY when is_platform_meter is
-- explicitly true. Any future INSERT attempting org_id IS NULL without
-- setting is_platform_meter fails outright, closing the loophole that let
-- this ambiguity exist in the first place.
ALTER TABLE billing_meters
  ADD CONSTRAINT billing_meters_org_id_required_unless_platform_meter
  CHECK (org_id IS NOT NULL OR is_platform_meter = true);

NOTIFY pgrst, 'reload schema';
