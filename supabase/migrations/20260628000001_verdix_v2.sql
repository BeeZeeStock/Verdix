-- v2: richer contract extraction fields + section source refs

alter table contract_terms
  add column if not exists customer_address    text,
  add column if not exists billing_contact     text,
  add column if not exists vendor_address      text,
  add column if not exists payment_terms_text  text,
  add column if not exists field_sources       jsonb not null default '{}';

alter table line_items
  add column if not exists source_section text;
