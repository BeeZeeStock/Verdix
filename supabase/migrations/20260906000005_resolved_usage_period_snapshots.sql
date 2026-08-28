-- Step 17D, item 12 — the smallest meter-specific closed-period
-- measurement snapshot needed for rolling-migration replay determinism.
--
-- Inspected first (this session): neither planned_invoices nor any other
-- existing table preserves a queryable, per-(job, semantic fact, period)
-- raw quantity with source identity — planned_invoices.overage_line_items
-- is a JSONB blob of the computed OUTCOME (amounts), written once at
-- real-invoice time, with no stable per-period "the meter read N for
-- window [start,end)" fact a second, independent consumer (the rolling
-- migration's own 3-window average) could look up. That gap is real — see
-- the architecture audit's §4/§12 findings — so this is new, not reused.
--
-- Deliberately NOT operational_input_period_values (item 12's explicit
-- instruction: "Do not route usage meters through
-- operational_input_period_values merely to achieve replay") — a
-- separate, usage-specific, WRITE-ONCE snapshot instead. No revoke/
-- finality columns: a closed period's pulled quantity is pinned the FIRST
-- time it's resolved for a closed-period commercial decision (the rolling
-- migration's own window average) and never rewritten after — this is a
-- cache-with-permanence for replay stability, not a correctable ledger
-- (a genuine correction is an explicit, rare admin action outside this
-- step's scope, not a routine revoke/re-enter flow like
-- operational_input_period_values').
--
-- Never written by the Consumption screen's live preview or by real
-- overage/per-unit-fee invoicing (item 1A/11: those keep making
-- independent fresh pulls every time, unaffected by this table's
-- existence) — only by lib/usage-quantity-resolver.ts's
-- resolveUsageQuantityForPeriod() when explicitly called in
-- 'closed_period_snapshot' mode.
create table if not exists resolved_usage_period_snapshots (
  id                 uuid primary key default gen_random_uuid(),
  job_id             uuid not null references jobs(id) on delete cascade,
  org_id             uuid not null references organizations(id) on delete cascade,
  semantic_input_key text not null,
  period_start       date not null,
  period_end         date not null,

  quantity           numeric not null,
  -- 'meter' | 'manual' — which branch of the resolver produced this
  -- quantity, preserved for audit even though the value itself is what
  -- downstream calculation actually consumes.
  source             text not null check (source in ('meter', 'manual')),
  meter_key          text,

  resolved_at        timestamptz not null default now(),

  constraint resolved_usage_period_snapshots_period_valid check (period_end >= period_start),
  constraint resolved_usage_period_snapshots_quantity_nonnegative check (quantity >= 0),
  constraint resolved_usage_period_snapshots_meter_key_shape check (
    (source = 'meter' and meter_key is not null) or (source = 'manual' and meter_key is null)
  )
);

-- One pinned snapshot per (job, semantic fact, period) — ever. The
-- resolver's own INSERT is ON CONFLICT DO NOTHING (first-resolution-wins);
-- this index is what makes that safe under concurrency too.
create unique index if not exists resolved_usage_period_snapshots_uidx
  on resolved_usage_period_snapshots (job_id, semantic_input_key, period_start, period_end);

create index if not exists resolved_usage_period_snapshots_job_idx
  on resolved_usage_period_snapshots (job_id, semantic_input_key);

alter table resolved_usage_period_snapshots enable row level security;
create policy "service_role_only" on resolved_usage_period_snapshots
  for all to service_role using (true) with check (true);
revoke all on resolved_usage_period_snapshots from anon, authenticated;

NOTIFY pgrst, 'reload schema';
