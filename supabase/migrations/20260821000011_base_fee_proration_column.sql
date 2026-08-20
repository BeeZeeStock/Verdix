-- base_fee_proration was added to lib/types.ts's ContractTerms interface,
-- the extraction prompt, confirm-rule/route.ts's read+write path, and
-- billing-writer.ts's calculation engine (Part 7, this session) — but the
-- column itself was never actually migrated onto contract_terms. Every read
-- silently returned undefined (the column doesn't exist, so PostgREST just
-- omits it from '*'), and confirm-rule's own write
-- (.update({ base_fee_proration: ... })) has been failing outright
-- (PGRST204: "Could not find the 'base_fee_proration' column") since Part 7
-- shipped — discovered only now, re-running the real TEST-PAY-002 PDF,
-- because nothing had reached that code path in production yet (the
-- confidence-gating bug fixed earlier this session meant the review card
-- itself never rendered, so a reviewer could never have clicked "confirm"
-- to trigger this write).
alter table contract_terms
  add column if not exists base_fee_proration jsonb;
