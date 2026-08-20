-- Distinguishes a confirmed rule interpretation that the CONTRACT itself
-- stated ('contract_derived') from one that required a reviewer's own
-- judgment in the absence of clear contract language ('reviewer_policy') —
-- e.g. a partial-period proration treatment is always the latter, by
-- definition, since the whole point of surfacing it is that the contract
-- doesn't say. Also persists the AI's own proposal state at confirmation
-- time (previously only lived transiently in contract_terms.ai_proposal_cache
-- and was discarded the moment a rule was confirmed) so the audit trail can
-- reconstruct whether a confirmed rule was "explicit in the contract" or
-- "AI's best guess with no textual anchor" after the fact.
alter table commercial_rule_interpretations
  add column if not exists decision_provenance text not null default 'contract_derived'
    check (decision_provenance in ('reviewer_policy', 'contract_derived')),
  add column if not exists ai_proposal_state jsonb;
