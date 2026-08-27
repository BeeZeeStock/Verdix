-- Step 17B0.2, item 1/2/3/5 — same bug class as
-- 20260821000011_base_fee_proration_column.sql, found again on the same
-- fresh Remembill re-extraction: crm_id, customer_email,
-- customer_org_number, renewal_notice_months, renewal_term_months,
-- base_fee_bands, base_fee_committed_volume,
-- unsupported_commercial_mechanisms, and credit_application_priority were
-- all added to lib/types.ts's ContractTerms interface (across several
-- "Step 17A"/"17B0" phases) but never actually migrated onto
-- contract_terms. execute/route.ts's upsert deliberately picks columns
-- explicitly (its own comment: "pick only known schema columns explicitly
-- so any novel LLM-extracted field doesn't break the write") — so these
-- fields were silently excluded from the write entirely rather than
-- erroring, and only ever survived inside the raw_extraction JSONB
-- safety-net column, which the frontend never reads directly. A correctly
-- extracted customer_org_number/renewal_notice_months/
-- unsupported_commercial_mechanisms could reach the merged in-memory
-- ContractTerms object, pass every unit test operating on that object
-- (see lib/step-17b0.test.ts / lib/step-17b0-1.test.ts, none of which
-- touch the database), and still never appear anywhere in the live
-- product — the exact gap between "extraction/merge is correct" and "the
-- database round-trip preserves it" that unit tests on the pure JS object
-- alone cannot catch.
alter table contract_terms
  add column if not exists crm_id text,
  add column if not exists customer_email text,
  add column if not exists customer_org_number text,
  add column if not exists renewal_notice_months integer,
  add column if not exists renewal_term_months integer,
  add column if not exists base_fee_bands jsonb,
  add column if not exists base_fee_committed_volume numeric,
  add column if not exists unsupported_commercial_mechanisms jsonb not null default '[]',
  add column if not exists credit_application_priority jsonb;
