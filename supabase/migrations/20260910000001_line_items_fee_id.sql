-- Step 17H.4B0D4B0A — establishes the missing relation
--   contract_terms.one_time_fees[].fee_id  →  line_items.fee_id
-- (the third leg of the existing chain — planned_invoices.fee_id already
-- exists and already references the same upstream identity, see
-- 20260827000001_planned_invoices_fee_id.sql, whose backfill shape this
-- migration deliberately mirrors).
--
-- fee_id is generated via crypto.randomUUID() (lib/contract-extractor.ts) —
-- a FULL UUID, not the truncated 8-char form discount_rule_id/credit_rule_id
-- use — but persisted as `text` everywhere it already exists
-- (planned_invoices.fee_id is `text`, matched here for consistency; there is
-- no reason to introduce a second representation of the same identity
-- values). Do not assume a native `uuid` column type — proven from the
-- existing precedent, not assumed.
--
-- Written but NOT applied this session — verified by reading this file and
-- by a read-only live-data dry run only, same discipline every migration in
-- this project has followed.

alter table line_items add column if not exists fee_id text;

comment on column line_items.fee_id is
  'Stable contract_terms.one_time_fees[].fee_id this one-time line item corresponds to. NULL for every non-one-time row, and for a one-time row whose identity could not be safely established (see the backfill below and lib/one-time-line-item-resolution.ts''s eventual ID-first resolver). Never inferred from product_name/fee_label once populated — this is what replaces that text-only bridge.';

-- One-time backfill for existing rows, mirroring 20260827000001_planned_
-- invoices_fee_id.sql's own conservative shape. A line item receives fee_id
-- ONLY when the relation is provably 1:1 in BOTH directions within its job:
--   (a) exactly one contract_terms.one_time_fees[] entry has fee_label
--       equal to this row's product_name, AND
--   (b) that fee has a real, non-null fee_id, AND
--   (c) exactly one CURRENT line_items row (billing_period = 'one_time')
--       in this job has that same product_name.
-- Any ambiguity in EITHER direction (zero or multiple candidates) leaves
-- fee_id NULL and is logged via NOTICE — never guessed by amount, array
-- order, or closest-text-match. This is an identity ENRICHMENT operation on
-- rows whose safe association was already provable via the existing exact-
-- label bridge; it is not, and must never be read as, a claim that the
-- historical line_items population is duplicate-free (see the 17H.4B0D4A.1
-- report's own corrected conclusion: exact-identity duplicates are not
-- currently observed, but conceptual duplicates under a changed label
-- cannot be ruled out by this or any prior pass).
--
-- Only ever writes where line_items.fee_id IS NULL — every row currently
-- satisfies this (the column doesn't exist yet), preserved here as an
-- explicit invariant for idempotence should this migration ever need to be
-- re-examined after a future partial run.
do $$
declare
  r record;
  fee_match_count int;
  item_match_count int;
  matched_fee_id text;
begin
  for r in
    select li.id, li.job_id, li.product_name
    from line_items li
    where li.billing_period = 'one_time'
      and li.fee_id is null
  loop
    select count(*), max(fee->>'fee_id')
      into fee_match_count, matched_fee_id
    from contract_terms ct
    cross join lateral jsonb_array_elements(coalesce(ct.one_time_fees, '[]'::jsonb)) as fee
    where ct.job_id = r.job_id
      and fee->>'fee_label' = r.product_name
      and fee->>'fee_id' is not null;

    if fee_match_count <> 1 then
      raise notice 'line_items.id=% (job_id=%, product_name=%) left fee_id NULL — % candidate fee(s) upstream', r.id, r.job_id, r.product_name, fee_match_count;
      continue;
    end if;

    select count(*)
      into item_match_count
    from line_items li2
    where li2.job_id = r.job_id
      and li2.billing_period = 'one_time'
      and li2.product_name = r.product_name;

    if item_match_count <> 1 then
      raise notice 'line_items.id=% (job_id=%, product_name=%) left fee_id NULL — % candidate line_items row(s) share this product_name', r.id, r.job_id, r.product_name, item_match_count;
      continue;
    end if;

    update line_items set fee_id = matched_fee_id where id = r.id and fee_id is null;
  end loop;
end $$;

-- No unique constraint on (job_id, fee_id) in this pass. execute/route.ts
-- still performs an unconditional INSERT on every re-execution today (the
-- Model B+ reconciliation that will own safe, deterministic re-insertion
-- has not landed yet — 17H.4B0D4A). A uniqueness constraint now could turn
-- a re-execution's line_items insert into a hard failure AFTER
-- contract_terms has already committed (17H.4B0D4A report item 2's own
-- finding: these two writes are not transactional, and contract_terms
-- always commits first) — trading today's silent-duplication risk for a
-- new silent-partial-failure risk, not a net safety improvement. Revisit
-- once reconciliation owns the insert path.

-- No index added. Per the same reasoning as 20260909000001's own
-- superseded_at decision: line_items' existing job_id index already makes
-- "this job's rows" trivial at this table's expected per-job cardinality; a
-- dedicated (job_id, fee_id) index would be premature optimization for a
-- column no query yet filters by (the eventual ID-first resolver is not
-- built in this pass — 17H.4B0D4B0A is schema-only, per its own scope).

-- ─────────────────────────────────────────────────────────────────────────
-- current_line_items must be recreated to expose fee_id: it was created
-- with `SELECT *`, and Postgres fixes a view's column list at CREATE VIEW
-- time — adding a base-table column does not retroactively appear in an
-- already-created view. CREATE OR REPLACE VIEW (not DROP + CREATE) is the
-- correct and sufficient tool here: Postgres permits replacing a view's
-- query as long as the new query reproduces every existing output column,
-- in the same names/order/types, and may only ADD new columns at the END
-- of the list. fee_id is a fresh ADD COLUMN on line_items — it lands after
-- every pre-existing column in `SELECT *`'s own column order, satisfying
-- that requirement exactly, so CREATE OR REPLACE VIEW is safe and
-- preserves the view's OID, meaning every existing grant survives this
-- statement unchanged (unlike DROP + CREATE, which would revoke them and
-- require reissuing every grant, and would break anything else that came
-- to depend on this view's identity). The revoke/grant statements below are
-- reissued anyway, defensively, exactly as 20260909000001 already did —
-- cheap insurance, not a claim that CREATE OR REPLACE alone would have been
-- insufficient.
create or replace view current_line_items
  with (security_invoker = true)
  as select * from line_items where superseded_at is null;

revoke all on current_line_items from public, anon, authenticated;
grant select on current_line_items to service_role;

comment on view current_line_items is
  'Current commercial line-item configuration (superseded_at IS NULL), now including fee_id. Historical/admin/reconciliation code that genuinely needs superseded rows too must continue querying line_items directly. Any future migration adding a column to line_items must also CREATE OR REPLACE this view, since SELECT * is fixed at view-definition time in Postgres, not dynamic.';
