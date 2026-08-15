-- Minimum-commitment confirmation tracking on contract_meter_mappings.
-- Mirrors the existing confirmed/confirmed_by/confirmed_at pattern already
-- on this table (§ billing_meters migration), but scoped specifically to
-- the minimum-commitment interpretation (floor/additive/minimum_spend/
-- prepaid_commitment/minimum_quantity) rather than the meter mapping as a
-- whole — a metric mapping can be confirmed while its minimum commitment
-- still awaits a reviewer's interpretation, and vice versa.
ALTER TABLE contract_meter_mappings
  ADD COLUMN IF NOT EXISTS minimum_commitment_mode text,
  ADD COLUMN IF NOT EXISTS minimum_commitment_requires_confirmation boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS minimum_commitment_confirmed_by text,
  ADD COLUMN IF NOT EXISTS minimum_commitment_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS minimum_commitment_note text;

NOTIFY pgrst, 'reload schema';
