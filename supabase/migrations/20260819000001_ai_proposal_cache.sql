-- Caches propose-rule's AI output (and meter-mappings' AI-match output) per
-- job so reopening the Review panel doesn't re-call Claude for a rule whose
-- underlying source data hasn't changed since last time. Keyed by an
-- addressing string identical to commercial_rule_interpretations'
-- contract_unit_type convention (e.g. 'minimum_commitment:AI processing',
-- 'discount:ab12cd34', 'meter_match:AI processing'), each entry storing the
-- exact input fingerprint the proposal was computed from — a cache hit
-- requires an EXACT match, so any real change to the contract data
-- (a correction, a re-extraction) invalidates itself automatically without
-- needing an explicit invalidation step.
alter table contract_terms add column if not exists ai_proposal_cache jsonb not null default '{}';

notify pgrst, 'reload schema';
