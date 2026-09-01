-- Step 17H.4B0D2 — the minimum durable metadata future non-destructive
-- line_items reconciliation (17H.4B0C's Model B+) needs to distinguish a
-- field a reviewer deliberately corrected from one that's merely
-- extraction/system-derived, WITHOUT relying on confidence_score (already
-- proven ambiguous — it's set to 1 on a plain confirm-as-is with no value
-- change, on a genuine unit_price correction, and on a product_name
-- correction alike, per the 17H.4B0C audit) or the dead
-- correction_reason/applied_rule columns (never written by any code path).
--
-- Written but NOT applied this session — verified by reading this file
-- only, same discipline every migration in this project has followed.

alter table line_items
  -- NULL   = legacy row, correction history for EVERY field is unknown.
  --          Verdix cannot safely conclude any field is un-corrected.
  -- '{}'   = tracking is active for this row (reviewer_corrected_fields_
  --          complete tells you whether that means "every field's status
  --          is genuinely known" or "only the fields listed here are
  --          known — others may still have unknown pre-tracking history").
  -- ['unit_price', ...] = these named fields are known reviewer-authored
  --          and must be preserved by future reconciliation; membership is
  --          additive-only (see the PATCH route's own merge logic) and
  --          drawn from lib/line-items.ts's REVIEWER_CORRECTABLE_LINE_ITEM_
  --          FIELDS allowlist.
  add column if not exists reviewer_corrected_fields text[] null,
  -- true  = this row was inserted under tracking from creation (buildLine
  --         Items' own NEW_ROW_CORRECTION_TRACKING default) — the absence
  --         of a field from reviewer_corrected_fields is authoritative:
  --         it genuinely has never been reviewer-corrected.
  -- false = either a legacy row that predates tracking (reviewer_
  --         corrected_fields still NULL), or a legacy row that has since
  --         received its FIRST post-migration correction (reviewer_
  --         corrected_fields now populated for that field only) — in
  --         BOTH cases, a field's absence from the array does NOT prove
  --         it was never corrected; its pre-tracking history remains
  --         genuinely unknown and must never be asserted.
  add column if not exists reviewer_corrected_fields_complete boolean not null default false,
  -- Timestamp of the most recently successful reviewer correction to any
  -- tracked field on this row — NOT a full audit history (no old/new
  -- value, no actor, no per-field timestamps; that is explicitly out of
  -- scope for this pass, see the 17H.4B0D2 report's own item 25). NULL
  -- whenever reviewer_corrected_fields is NULL or empty.
  add column if not exists reviewer_corrected_at timestamptz null;

comment on column line_items.reviewer_corrected_fields is
  'NULL = legacy, correction history unknown for every field. [] = tracked, no known corrections. [''unit_price'',...] = these fields are known reviewer-authored (additive-only). Never inferred/backfilled for existing rows — see reviewer_corrected_fields_complete for whether absence from this array is authoritative.';

comment on column line_items.reviewer_corrected_fields_complete is
  'true only for a row inserted under tracking from creation (buildLineItems). false for every legacy row, including one that has since received a real post-migration correction — a field''s absence from reviewer_corrected_fields is NOT proof it was never corrected when this is false.';

comment on column line_items.reviewer_corrected_at is
  'Timestamp of the most recent successful reviewer correction to a tracked field. Not a full audit trail — no old/new value, no actor, no per-field history.';

-- Deliberately NOT backfilled to '{}'/true for existing rows — see the
-- column comments above and the 17H.4B0D2 report's item 3/20/21. Existing
-- rows keep reviewer_corrected_fields = NULL, reviewer_corrected_fields_
-- complete = false (the column DEFAULT already gives every pre-existing
-- row this value on ADD COLUMN) until they receive a real correction
-- through the new metadata-aware write path.
