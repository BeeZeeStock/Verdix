-- Service credits (SLA/availability credits, rebates, promotional credits,
-- earned/usage credits) become a first-class commercial-rule array on
-- contract_terms, stored the same way discounts/escalators/overage_tiers
-- already are — one jsonb column per array, not nested inside another
-- column's blob.
alter table contract_terms add column if not exists service_credits jsonb not null default '[]';

-- Documentation refresh only (rule_type is free-text, no check constraint,
-- so this is a no-op beyond keeping the comment accurate as new rule types
-- are added — see lib/rule-interpretation.ts's RuleType union for the
-- authoritative list).
comment on column commercial_rule_interpretations.rule_type is
  '''minimum_commitment'' | ''escalator'' | ''partial_period'' | ''discount'' | ''tier_calculation'' | ''service_credit'' | ''rule_interaction'' | ''meter_mapping''';

notify pgrst, 'reload schema';
