-- Distinguishes a true external meter (needs a mapping to a real usage
-- source) from a manual/operational input, a derived/computed value, or
-- persisted commercial state like a credit balance — today every required
-- operational input is treated as one flat "meter" concept regardless of
-- which of these it actually is, which is why a value like "cumulative
-- annual volume" (computed from an already-pulled meter, not its own
-- source) or "credit balance" (tracked by credit_ledger_entries, never
-- meter-mapped) has no way to be represented as anything other than an
-- unmapped meter forever.
alter table billing_meters
  add column if not exists default_classification text not null default 'meter'
    check (default_classification in ('meter', 'meter_or_manual_input', 'derived', 'persisted_balance'));

alter table contract_meter_mappings
  add column if not exists input_classification text not null default 'meter'
    check (input_classification in ('meter', 'meter_or_manual_input', 'derived', 'persisted_balance'));

alter table org_billing_config
  add column if not exists input_classification text not null default 'meter'
    check (input_classification in ('meter', 'meter_or_manual_input', 'derived', 'persisted_balance'));

comment on column billing_meters.default_classification is
  'Seeds contract_meter_mappings.input_classification when a mapping suggestion is first created for this meter.';
comment on column contract_meter_mappings.input_classification is
  'meter = needs a real mapped usage source; meter_or_manual_input = mapped source OR a manual value; derived = computed from other data, never meter-mapped; persisted_balance = tracked by credit_ledger_entries, never meter-mapped. See lib/meter-mapping-status.ts.';
comment on column org_billing_config.input_classification is
  'Carried forward from contract_meter_mappings.input_classification when a confirmed mapping is promoted to live billing config.';
