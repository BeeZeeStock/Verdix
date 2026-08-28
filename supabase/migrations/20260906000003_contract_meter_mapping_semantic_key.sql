-- Step 17D, item 4 — the mapping layer gains a canonical identity alongside
-- its existing raw contract_unit_type string. contract_unit_type is left
-- completely unchanged (still populated verbatim from
-- overage_tiers[].unit_type, still what the review UI shows as the raw
-- contract wording — "payment request") — semantic_input_key is a NEW,
-- separate column holding the resolved canonical fact this mapping
-- actually feeds (e.g. 'issued_payment_request_count'), resolved via
-- lib/operational-input-canonicalization.ts's existing
-- resolveRecognizedOperationalInputKey (Step 17C.3c) at confirmation time.
-- NULL means either: (a) this mapping predates Step 17D, or (b) the raw
-- contract_unit_type did not resolve to any recognized canonical concept —
-- both cases fall back to today's exact raw meter_key matching behavior,
-- never treated as an error.
ALTER TABLE contract_meter_mappings
  ADD COLUMN IF NOT EXISTS semantic_input_key text;

CREATE INDEX IF NOT EXISTS contract_meter_mappings_semantic_input_key_idx
  ON contract_meter_mappings (semantic_input_key);

-- Step 17D, item 9 — the index a single confirmed mapping's quantity is
-- looked up by from multiple independent commercial rules (overage,
-- per-unit fee, rolling migration) without needing three separate mapping
-- rows for the same underlying fact.
CREATE INDEX IF NOT EXISTS contract_meter_mappings_job_semantic_idx
  ON contract_meter_mappings (job_id, semantic_input_key) WHERE confirmed = true;

NOTIFY pgrst, 'reload schema';
