-- v3: one_time_fees structured extraction field

alter table contract_terms
  add column if not exists one_time_fees jsonb not null default '[]';
