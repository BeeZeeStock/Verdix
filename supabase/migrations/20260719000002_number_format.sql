-- Add number_format to contract_terms to track whether the contract uses
-- dot (US/UK/Nordic) or comma (Continental European) as the decimal separator.
-- This is used to correctly display placeholder examples in the review panel.
ALTER TABLE contract_terms
  ADD COLUMN IF NOT EXISTS number_format TEXT DEFAULT 'dot' CHECK (number_format IN ('dot', 'comma'));
