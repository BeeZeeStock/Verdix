-- Issued-invoice cancellation/correction — deliberately separate from the
-- contractual credit ledger (credit_ledger_entries, 20260821000001). That
-- table tracks earned commercial credits/rebates BEFORE an invoice is
-- issued ("SEK 16,500 SLA credit earned"); this table tracks reversing an
-- ALREADY-ISSUED invoice via Remembill's POST /invoices/{id}/credit
-- ("Invoice #1001 was wrong after issuance"). Different state, different
-- evidence, different audit history — never merged.
--
-- Once a Remembill invoice is issued/sent, it is treated as immutable.
-- Cancellation: issued invoice -> full credit invoice.
-- Correction:   issued invoice -> full credit invoice -> (only once that
--   credit succeeds) a freshly-calculated replacement invoice using the
--   CURRENT approved billing instruction. The credit itself always reverses
--   the ORIGINAL invoice's actual issued figures (frozen below), never a
--   rerun of today's calculation — see original_net_amount etc.
create table if not exists invoice_corrections (
  id                          uuid        primary key default gen_random_uuid(),
  org_id                      uuid        not null references organizations(id) on delete cascade,
  job_id                      uuid        not null references jobs(id) on delete cascade,
  original_planned_invoice_id uuid        not null references planned_invoices(id) on delete cascade,
  action                      text        not null check (action in ('cancellation', 'correction')),
  reason                      text,
  requested_by                text,
  requested_at                timestamptz not null default now(),

  -- Frozen snapshot of what was ACTUALLY issued, copied from the original
  -- planned_invoices row at request time — the credit call always reverses
  -- these numbers, even if VAT config or the contract has since changed.
  original_currency           text        not null,
  original_net_amount         numeric,
  original_vat_amount         numeric,
  original_gross_amount       numeric,
  original_vat_mode           text,
  original_vat_rate_pct       numeric,
  original_platform_invoice_id text       not null,

  credit_status               text        not null default 'pending' check (credit_status in ('pending', 'succeeded', 'failed')),
  credit_platform_invoice_id  text,
  credit_idempotency_key      text        not null,
  credit_requested_at         timestamptz,
  credit_completed_at         timestamptz,
  credit_error_message        text,

  -- Correction only — 'not_applicable' for a plain cancellation. Never
  -- transitions to 'pending' until credit_status = 'succeeded'.
  replacement_status              text    not null default 'not_applicable' check (replacement_status in ('not_applicable', 'pending', 'succeeded', 'failed')),
  replacement_planned_invoice_id  uuid    references planned_invoices(id) on delete set null,
  replacement_platform_invoice_id text,
  replacement_error_message       text,

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  -- One correction/cancellation ATTEMPT-SET per (invoice, action) — a retry
  -- must find and reuse this same row rather than create a second one, so
  -- neither a duplicate credit nor a duplicate replacement can ever be created.
  unique (original_planned_invoice_id, action)
);

create index if not exists invoice_corrections_job_idx on invoice_corrections (job_id);
create index if not exists invoice_corrections_org_idx on invoice_corrections (org_id);

-- Additive markers on the original row — never mutates its financial
-- fields (base_amount, overage_line_items, vat_amount, etc.), only records
-- that a correction/cancellation was applied.
alter table planned_invoices
  add column if not exists corrected_at timestamptz,
  add column if not exists correction_id uuid references invoice_corrections(id) on delete set null;

alter table invoice_corrections enable row level security;
create policy "invoice_corrections_service_role_only" on invoice_corrections
  for all to service_role using (true) with check (true);
