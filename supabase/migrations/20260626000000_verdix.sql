-- Verdix database schema
-- All tables use UUID primary keys; timestamps are UTC

-- Enable UUID extension
create extension if not exists "pgcrypto";

-- ─── Jobs ───────────────────────────────────────────────────────────────────

create table if not exists jobs (
  id                      uuid primary key default gen_random_uuid(),
  name                    text not null,
  module                  text not null check (module in ('BILLING_VERIFICATION', 'AUTO_CONFIGURE', 'PARTNER_RECON')),
  status                  text not null default 'PENDING',
  execute_status          text not null default 'PENDING',
  currency                text not null default 'USD',
  contract_pdf_url        text,
  billing_csv_url         text,
  error_message           text,
  total_leakage           numeric(15, 2),
  findings_count          integer default 0,
  contract_terms_id       uuid,
  billing_platform        text,
  billing_subscription_id text,
  billing_customer_id     text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index on jobs (module, created_at desc);

-- ─── Contract Terms ──────────────────────────────────────────────────────────

create table if not exists contract_terms (
  id                    uuid primary key default gen_random_uuid(),
  job_id                uuid not null references jobs (id) on delete cascade,
  contract_id           text,
  customer_name         text,
  vendor_name           text,
  order_date            date,
  contract_start_date   date,
  contract_end_date     date,
  contract_term_months  integer,
  auto_renews           boolean,
  renewal_notice_days   integer,
  currency              text not null default 'USD',
  base_monthly_fee      numeric(15, 2),
  base_annual_fee       numeric(15, 2),
  billing_frequency     text,
  payment_terms_days    integer,
  included_units        numeric(15, 2),
  included_unit_type    text,
  year_pricing          jsonb,
  escalators            jsonb not null default '[]',
  discounts             jsonb not null default '[]',
  overage_tiers         jsonb not null default '[]',
  extraction_confidence text not null default 'medium',
  extraction_notes      text,
  created_at            timestamptz not null default now()
);

create index on contract_terms (job_id);
create index on contract_terms (customer_name);

-- ─── Line Items (Auto-Configure) ─────────────────────────────────────────────

create table if not exists line_items (
  id               uuid primary key default gen_random_uuid(),
  job_id           uuid not null references jobs (id) on delete cascade,
  product_name     text not null,
  quantity         numeric(10, 4) not null default 1,
  unit_price       numeric(15, 4) not null,
  billing_period   text not null,
  total_amount     numeric(15, 2) not null,
  currency         text not null default 'USD',
  confidence_score numeric(4, 3) not null default 0.9,
  stripe_price_id  text,
  applied_rule     text,
  correction_reason text,
  created_at       timestamptz not null default now()
);

create index on line_items (job_id);

-- ─── Leakage Findings (Billing Verification) ─────────────────────────────────

create table if not exists leakage_findings (
  id                  uuid primary key default gen_random_uuid(),
  job_id              uuid not null references jobs (id) on delete cascade,
  finding_id          text unique not null default gen_random_uuid()::text,
  leakage_type        text not null,
  customer_name       text not null,
  contract_id         text,
  invoice_id          text,
  billing_month       text,
  description         text not null,
  contracted_amount   numeric(15, 2) not null,
  billed_amount       numeric(15, 2) not null,
  leakage_amount      numeric(15, 2) not null,
  evidence            text,
  confidence          text not null default 'MEDIUM',
  priority            text not null default 'MEDIUM',
  status              text not null default 'open',
  fix_note            text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index on leakage_findings (job_id);
create index on leakage_findings (priority, status);

-- ─── Partner Invoices ─────────────────────────────────────────────────────────

create table if not exists partner_invoices (
  id                uuid primary key default gen_random_uuid(),
  job_id            uuid not null references jobs (id) on delete cascade,
  invoice_reference text,
  partner_name      text,
  invoice_date      date,
  invoice_amount    numeric(15, 2),
  currency          text not null default 'EUR',
  status            text not null default 'pending',
  dispute_amount    numeric(15, 2) default 0,
  created_at        timestamptz not null default now()
);

create index on partner_invoices (job_id);

-- ─── Partner Findings ─────────────────────────────────────────────────────────

create table if not exists partner_findings (
  id              uuid primary key default gen_random_uuid(),
  job_id          uuid not null references jobs (id) on delete cascade,
  finding_type    text not null,
  description     text not null,
  agreed_amount   numeric(15, 2) not null,
  billed_amount   numeric(15, 2) not null,
  discrepancy     numeric(15, 2) not null,
  evidence        text,
  status          text not null default 'open',
  created_at      timestamptz not null default now()
);

create index on partner_findings (job_id);

-- ─── Extraction Corrections (Learning Layer) ─────────────────────────────────

create table if not exists extraction_corrections (
  id                uuid primary key default gen_random_uuid(),
  job_id            uuid references jobs (id) on delete set null,
  field_name        text not null,
  extracted_value   text,
  corrected_value   text not null,
  correction_reason text,
  customer_name     text,
  apply_to_future   boolean not null default true,
  created_at        timestamptz not null default now()
);

create index on extraction_corrections (field_name, apply_to_future);
create index on extraction_corrections (customer_name);

-- ─── Design Partner Applications ─────────────────────────────────────────────

create table if not exists design_partner_applications (
  id            uuid primary key default gen_random_uuid(),
  company       text not null,
  contact_name  text not null,
  contact_email text not null unique,
  contact_role  text,
  company_size  text,
  pain_point    text,
  gdpr_consent  boolean not null default false,
  status        text not null default 'new' check (status in ('new', 'contacted', 'approved', 'declined')),
  created_at    timestamptz not null default now()
);

create index on design_partner_applications (status, created_at desc);

-- ─── Updated_at trigger ───────────────────────────────────────────────────────

create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists jobs_updated_at on jobs;
create trigger jobs_updated_at
  before update on jobs
  for each row execute function set_updated_at();

drop trigger if exists leakage_findings_updated_at on leakage_findings;
create trigger leakage_findings_updated_at
  before update on leakage_findings
  for each row execute function set_updated_at();

-- ─── Row Level Security ───────────────────────────────────────────────────────

alter table jobs enable row level security;
alter table contract_terms enable row level security;
alter table line_items enable row level security;
alter table leakage_findings enable row level security;
alter table partner_invoices enable row level security;
alter table partner_findings enable row level security;
alter table extraction_corrections enable row level security;
alter table design_partner_applications enable row level security;

-- Service role bypass (used by server-side Supabase client)
do $$ begin
  create policy "service role bypass" on jobs for all using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "service role bypass" on contract_terms for all using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "service role bypass" on line_items for all using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "service role bypass" on leakage_findings for all using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "service role bypass" on partner_invoices for all using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "service role bypass" on partner_findings for all using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "service role bypass" on extraction_corrections for all using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "service role bypass" on design_partner_applications for all using (true) with check (true);
exception when duplicate_object then null; end $$;
