-- Step 17H.4B0D3A — schema-only foundation for the future Model B+
-- line-item reconciliation (17H.4B0C's design). Establishes currentness
-- state and a security-hardened read view. Does NOT change any
-- application read path, supersede any existing row, or repair any
-- duplicate — see the 17H.4B0D3A report for the full rationale and the
-- exact consumer-migration plan (D3B), which this migration deliberately
-- does not perform.
--
-- Sequenced after 20260908000001_line_item_reviewer_correction_metadata.sql
-- (that migration's reviewer_corrected_fields/reviewer_corrected_fields_
-- complete/reviewer_corrected_at columns are unchanged/frozen here).
--
-- Written but NOT applied this session — same discipline every migration
-- in this project has followed; verified by reading this file only.

alter table line_items
  -- NULL     = row participates in current commercial configuration.
  --            Every EXISTING row (including every existing duplicate) and
  --            every newly inserted row starts here — this migration
  --            contains no UPDATE statement, so no existing row is ever
  --            touched. This pass establishes infrastructure only; it does
  --            not claim existing data is clean.
  -- non-NULL = row is retained for traceability/history (it may still be
  --            referenced by a real planned_invoices.line_item_id) but is
  --            no longer part of current commercial configuration. Nothing
  --            sets this value yet anywhere in the application — that is
  --            the eventual reconciliation pass's job, not this migration's.
  add column if not exists superseded_at timestamptz null;

comment on column line_items.superseded_at is
  'NULL = current commercial configuration. Non-NULL = superseded by reconciliation, retained only for planned_invoices.line_item_id traceability/history. Never backfilled by migration — existing rows, including existing duplicates, remain NULL (current) until an explicit future reconciliation pass supersedes them.';

-- No index added in this pass. line_items already has an index on job_id
-- (20260626000000_verdix.sql), and every realistic query shape is
-- "this job's current rows" — at this table's expected per-job cardinality
-- (a handful to a few dozen rows), adding a partial index on
-- (job_id) where superseded_at is null before any real query pattern
-- exercises it would be premature optimization for a column nothing yet
-- reads by. Revisit once D3B's consumer migration is live and real query
-- plans can be inspected.

-- ─────────────────────────────────────────────────────────────────────────
-- current_line_items — the future default read surface for current
-- commercial configuration. NOT wired into any application read path by
-- this migration: the running application currently queries a database
-- where this migration has not been applied, and switching a live query to
-- a relation that does not exist yet would be a runtime failure, not a
-- safe rollout. D3B switches consumers once this schema is confirmed
-- present in the deployed environment.
--
-- security_invoker = true is the deliberate, load-bearing security choice
-- here: it makes every query THROUGH this view evaluate line_items' OWN
-- RLS policy as the CALLING role, not the view's owner. Without it, a
-- Postgres view runs, by default, with the privileges of whoever created
-- it — meaning if SELECT on this view were ever accidentally granted to
-- anon/authenticated, they could see every row across every org's job,
-- entirely bypassing the exact lockdown 20260819000003_rls_lockdown.sql
-- deliberately applied to the base table. With security_invoker, this view
-- can never grant more access than the caller already has on line_items
-- itself — a grants mistake fails safe instead of becoming a data leak.
-- Requires Postgres 15+; standard on current Supabase, but the actual
-- deployed Postgres version should be confirmed before this migration is
-- applied, not assumed.
create view current_line_items
  with (security_invoker = true)
  as select * from line_items where superseded_at is null;

-- Belt-and-suspenders alongside security_invoker, mirroring line_items' own
-- lockdown exactly rather than relying on security_invoker alone — a newly
-- created view can pick up default PUBLIC privileges in some Postgres
-- configurations; revoke explicitly rather than assume it inherited none.
-- The application's real access-control boundary remains requireOrg() in
-- server-side route handlers, unchanged by this migration — this grant
-- structure exists to keep the database-layer boundary consistent with
-- that, exactly as it already is for line_items itself.
revoke all on current_line_items from public, anon, authenticated;
grant select on current_line_items to service_role;

comment on view current_line_items is
  'Current commercial line-item configuration (superseded_at IS NULL). Historical/admin/reconciliation code that genuinely needs superseded rows too must continue querying line_items directly — see the 17H.4B0D3A report''s consumer matrix. Any future migration adding a column to line_items must also CREATE OR REPLACE this view, since SELECT * is fixed at view-definition time in Postgres, not dynamic — a new base-table column will not appear here automatically.';
