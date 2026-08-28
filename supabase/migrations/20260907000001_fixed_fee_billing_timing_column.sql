-- Step 17F.3, item 2 — fixed_fee_billing_timing was added to lib/types.ts's
-- ContractTerms interface, the extraction prompt, confirm-rule/route.ts's
-- read+write path, and lib/commercial-rule-status.ts's readiness check —
-- mirrors base_fee_proration's own column exactly (see
-- 20260821000011_base_fee_proration_column.sql, the same shape of gap:
-- a new top-level typed field with no column yet, which would otherwise
-- make every write silently fail with PGRST204 "Could not find the
-- 'fixed_fee_billing_timing' column" and every read silently return
-- undefined).
alter table contract_terms
  add column if not exists fixed_fee_billing_timing jsonb;
