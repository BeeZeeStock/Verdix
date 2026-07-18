alter table contract_terms
  add column if not exists additional_recurring_fees jsonb not null default '[]';
