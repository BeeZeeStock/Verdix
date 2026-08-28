-- Step 17C.2b, item B — lets lib/rolling-band-schedule-reconciliation.ts
-- precisely identify which already-'decision_required' (held) planned_invoices
-- rows were held BY A SPECIFIC rolling-band pricing transition (as opposed
-- to some other, unrelated reason a row might one day be held), so that
-- re-running reconciliation after a transition's decision/effective_rule
-- is resolved can safely recover exactly "rows attributable to this
-- transition" — never a row held for a different reason, and never a row
-- that has since moved on to 'processing'/'sent'/'paid'/'failed'.
--
-- planned_invoices (supabase/migrations/20260727000001_planned_invoices.sql)
-- is an already-applied, long-lived production table — this is a genuine
-- new additive migration, not an edit to a not-yet-applied one (contrast
-- with 20260904000001_rolling_band_pricing_transitions.sql, still
-- unapplied and edited in place per that step's own instruction).
alter table planned_invoices
  add column if not exists rolling_band_hold_transition_id uuid references rolling_band_pricing_transitions(id) on delete set null;

create index if not exists planned_invoices_rolling_band_hold_idx
  on planned_invoices (rolling_band_hold_transition_id)
  where rolling_band_hold_transition_id is not null;
