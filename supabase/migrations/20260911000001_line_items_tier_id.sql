-- Step 17H.4B0D4B1B0A — the second leg of the line-item identity foundation
-- (the first was 20260910000001_line_items_fee_id.sql for one-time fees):
--   contract_terms.overage_tiers[].tier_id  →  line_items.tier_id
--
-- tier_id is generated via crypto.randomUUID() (lib/contract-extractor.ts's
-- assignTierIds) — a FULL UUID, not the truncated 8-char form discount_
-- rule_id/credit_rule_id use — but persisted as `text` everywhere identity
-- of this kind already lives (planned_invoices.fee_id and line_items.fee_id
-- are both `text`; contract_terms.overage_tiers[].tier_id lives inside a
-- JSONB array as a plain string). No native `uuid` column type, and no FK
-- into JSONB (not possible/appropriate) — matched precisely to the fee_id
-- migration's own precedent for consistency.
--
-- Written but NOT applied this session — verified by reading this file and
-- by a read-only live-data audit only (17H.4B0D4B1A.1), same discipline
-- every migration in this project has followed.

alter table line_items add column if not exists tier_id text;

comment on column line_items.tier_id is
  'Stable contract_terms.overage_tiers[].tier_id this tier line item corresponds to. NULL for every non-tier row, and for a tier line item whose identity could not be safely established. Never inferred from product_name/tier_label once populated — this is what will eventually replace that text-only bridge (lib/tier-escalator-correction.ts''s resolveTierIndexForLineItem/classifyTierCorrectionTarget), once application code is updated to propagate and consume it (not in this pass — schema only).';

-- No backfill in this migration — deliberate, not an oversight. A live,
-- read-only audit immediately before this migration was written
-- (17H.4B0D4B1A.1) found 0 of 191 upstream contract_terms.overage_tiers[]
-- currently carry a non-null tier_id — every eligible backfill candidate
-- would be blocked on that single fact, regardless of how well the
-- line-item association itself resolves. Unlike the fee_id migration
-- (where 11 of 52 upstream fees already had real identity, making a
-- backfill immediately useful), a tier_id backfill block here would be
-- provably dead code today — it would run, find zero eligible rows, and
-- do nothing, for every environment this migration is applied to until a
-- real re-extraction populates upstream tier_id values. Historical
-- backfill remains a separate, future concern once real upstream identity
-- exists to backfill from.

-- No uniqueness constraint on (job_id, tier_id), for the identical reason
-- established by the fee_id migration: execute/route.ts still performs an
-- unconditional INSERT of newly-built line_items on every re-execution
-- (the Model B+ reconciliation that will own safe, deterministic
-- re-insertion has not landed yet). A uniqueness constraint now could turn
-- a re-execution's line_items insert into a hard failure AFTER
-- contract_terms has already committed (these two writes are not
-- transactional — contract_terms always commits first) — trading today's
-- silent-duplication risk for a new silent-partial-failure risk, not a net
-- safety improvement. Revisit once reconciliation owns the insert path.

-- No index added. line_items already has an index on job_id, and no query
-- yet filters or joins by tier_id (runtime ID-first tier resolution is not
-- implemented in this pass) — a dedicated (job_id, tier_id) index would be
-- premature optimization for a column nothing yet reads by, at a table
-- whose per-job cardinality is already small. Revisit once the ID-first
-- resolver rewrite lands and real query patterns exist to inspect.

-- ─────────────────────────────────────────────────────────────────────────
-- current_line_items must be recreated to expose tier_id: it was created
-- with `SELECT *`, and Postgres fixes a view's column list at CREATE VIEW
-- time — adding a base-table column does not retroactively appear in an
-- already-created view (the same reasoning documented in
-- 20260910000001_line_items_fee_id.sql). CREATE OR REPLACE VIEW (not
-- DROP + CREATE) is correct and sufficient here for the identical reason
-- it was there: tier_id is a fresh ADD COLUMN on line_items, landing after
-- every pre-existing column in `SELECT *`'s own column order, so the new
-- view definition reproduces every existing output column unchanged and
-- only appends the new one — satisfying Postgres's requirement for
-- CREATE OR REPLACE VIEW to be valid, and preserving the view's OID (so
-- its existing grants survive the statement, unlike DROP + CREATE, which
-- would revoke them).
--
-- security_invoker = true is re-specified explicitly (not left to
-- inference) for the same load-bearing reason documented in both prior
-- view-touching migrations: it makes every query THROUGH this view
-- evaluate line_items' own RLS as the CALLING role, not the view owner's,
-- so a grants mistake on this view can never expose more than the caller
-- already has on the base table.
create or replace view current_line_items
  with (security_invoker = true)
  as select * from line_items where superseded_at is null;

-- Belt-and-suspenders alongside security_invoker, mirroring both prior
-- view migrations exactly rather than relying on CREATE OR REPLACE's own
-- grant-preservation alone.
revoke all on current_line_items from public, anon, authenticated;
grant select on current_line_items to service_role;

comment on view current_line_items is
  'Current commercial line-item configuration (superseded_at IS NULL), now including tier_id and fee_id. Historical/admin/reconciliation code that genuinely needs superseded rows too must continue querying line_items directly. Any future migration adding a column to line_items must also CREATE OR REPLACE this view, since SELECT * is fixed at view-definition time in Postgres, not dynamic.';
