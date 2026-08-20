-- VAT is currently unconditionally zero-rated on every invoice Verdix
-- issues on a customer's behalf (Remembill rows hardcode vat: 0; Stripe
-- invoices pass no tax_rates at all — see the investigation reported before
-- this migration was written). This introduces an explicit, reviewer/user
-- -controlled VAT treatment: never inferred from supplier country,
-- currency, or customer location — genuinely just a stored configuration
-- value, same discipline as the rest of this billing pipeline's
-- "never silently decide, always require an explicit confirmed value"
-- convention.
--
-- Two levels, invoice-level always wins when set:
--   1. customer_vat_config — one default per (org, billing_customer_id),
--      set once and reused across every invoice for that customer.
--   2. planned_invoices.vat_* — the resolved treatment actually applied to
--      THIS invoice (copied from the customer default unless explicitly
--      overridden), persisted at send time alongside overage_line_items/
--      credit_line_items (same lifecycle — these fields are blank until
--      the invoice-scheduler actually computes and sends this period).
--
-- vat_mode intentionally has three states, not a bare percentage:
--   'rate'          — a specific percentage applies (vat_rate_pct set)
--   'zero_rated'    — explicitly 0%, a stated decision, not "unset"
--   'not_configured'— genuinely unresolved; invoicing must fail closed
create table if not exists customer_vat_config (
  id                  uuid        primary key default gen_random_uuid(),
  org_id              uuid        not null references organizations(id) on delete cascade,
  billing_customer_id text        not null,
  vat_mode            text        not null default 'not_configured' check (vat_mode in ('rate', 'zero_rated', 'not_configured')),
  vat_rate_pct        numeric     check (vat_rate_pct is null or (vat_rate_pct >= 0 and vat_rate_pct <= 100)),
  constraint customer_vat_config_rate_shape check (
    (vat_mode = 'rate' and vat_rate_pct is not null) or
    (vat_mode <> 'rate' and vat_rate_pct is null)
  ),
  updated_by          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (org_id, billing_customer_id)
);

alter table planned_invoices
  add column if not exists vat_mode          text    not null default 'not_configured' check (vat_mode in ('rate', 'zero_rated', 'not_configured')),
  add column if not exists vat_rate_pct      numeric check (vat_rate_pct is null or (vat_rate_pct >= 0 and vat_rate_pct <= 100)),
  -- 'customer_default' — copied from customer_vat_config at send time.
  -- 'override'         — explicitly set for this one invoice, recorded in
  --                      the audit trail (commercial_rule_interpretations
  --                      is for contract-derived rules; this is an
  --                      operational billing input, so it gets its own
  --                      lightweight override record — see
  --                      planned_invoice_vat_overrides below).
  add column if not exists vat_source        text    check (vat_source in ('customer_default', 'override')),
  add column if not exists net_amount        numeric,
  add column if not exists vat_amount        numeric,
  add column if not exists gross_amount      numeric,
  -- Set after comparing Verdix's own expected gross against whatever total
  -- the billing platform actually returns for the created invoice —
  -- 'not_checked' (platform doesn't return a comparable total), 'matched',
  -- or 'mismatch' (surfaced, never silently ignored).
  add column if not exists vat_reconciliation_status text not null default 'not_checked' check (vat_reconciliation_status in ('not_checked', 'matched', 'mismatch'));

comment on column planned_invoices.net_amount is 'base_amount + overage_total + credit_total at send time — the VAT-exclusive amount VAT is calculated on.';
comment on column planned_invoices.vat_amount is 'net_amount * vat_rate_pct / 100, or 0 when vat_mode is zero_rated.';
comment on column planned_invoices.gross_amount is 'net_amount + vat_amount — Verdix''s own expected total, compared against the billing platform''s returned total.';

-- One-off override for a single invoice, distinct from the customer's
-- standing default — kept as its own small audit record (who overrode it,
-- when, from what to what) rather than silently mutating
-- customer_vat_config or planned_invoices.vat_* with no trace.
create table if not exists planned_invoice_vat_overrides (
  id                  uuid        primary key default gen_random_uuid(),
  planned_invoice_id  uuid        not null references planned_invoices(id) on delete cascade,
  org_id              uuid        not null references organizations(id) on delete cascade,
  vat_mode            text        not null check (vat_mode in ('rate', 'zero_rated', 'not_configured')),
  vat_rate_pct        numeric     check (vat_rate_pct is null or (vat_rate_pct >= 0 and vat_rate_pct <= 100)),
  reason              text,
  set_by              text,
  created_at          timestamptz not null default now(),
  unique (planned_invoice_id)
);

create index if not exists customer_vat_config_org_customer_idx on customer_vat_config (org_id, billing_customer_id);
create index if not exists planned_invoice_vat_overrides_invoice_idx on planned_invoice_vat_overrides (planned_invoice_id);

alter table customer_vat_config enable row level security;
alter table planned_invoice_vat_overrides enable row level security;

create policy "customer_vat_config_service_role_only" on customer_vat_config
  for all to service_role using (true) with check (true);
create policy "planned_invoice_vat_overrides_service_role_only" on planned_invoice_vat_overrides
  for all to service_role using (true) with check (true);
