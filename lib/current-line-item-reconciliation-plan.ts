// Step 17H.4B0D4H1B1 — the pure Model B+ planning layer for CURRENT
// line_items reconciliation. Compares a job's CURRENT line_items against a
// FRESH buildLineItems(terms, currency) output and produces a deterministic
// plan: which current rows to update in place (SAME), which fresh rows are
// safe to insert (NEW), which current rows are safe to supersede (REMOVED —
// never physically delete), and which rows/families cannot be safely
// resolved (blockers, UNKNOWN).
//
// Deliberately NOT an expansion of lib/line-items-reconciliation.ts's
// existing planLineItemReconciliation — that function's own narrow,
// pre-Model-B+ lifecycle model (exactly two deterministic staleness
// predicates: an unresolved base-fee-proration placeholder once resolved,
// and a legacy percentage_of_basis row) remains intact, untouched, and
// still the sole authority for its own two callers (confirm-rule,
// POST /api/jobs/[id]/reconcile-line-items) until a later pass migrates
// them. This module reuses those exact two predicates (cited, not
// re-derived) as one input to a much broader family-set doctrine, and is
// designed to eventually SUBSUME planLineItemReconciliation, not sit
// alongside it as a second, competing authority forever.
//
// Zero Supabase imports, zero fetch, zero clock-dependent logic, zero
// random IDs, zero persistence side effects — this module only ever reads
// its arguments and returns a plan. The future atomic applier (H1B2) owns
// everything DB-facing: advisory lock, full current-set reload, snapshot
// equality, stale_plan detection, the actual mutation transaction. This
// module does not know jobs.billing_hold exists.
import { isRecurringBaseFeeLineItem } from './line-item-markers'
import { resolveTierForLineItem } from './tier-escalator-correction'
import { resolveOneTimeLineItemAssociation } from './one-time-line-item-resolution'
import { resolveRecurringFeeLineItemAssociation } from './recurring-fee-line-item-resolution'
import type { OverageTier, AdditionalRecurringFee } from './types'

export type LineItemFamily =
  | 'base_fee_proration'
  | 'recurring_base_fee'
  | 'additional_recurring_fixed'
  | 'additional_recurring_variable'
  | 'tier'
  | 'one_time'
  | 'escalator'
  | 'unknown'

// The full persisted shape the planner needs per current row — every
// mutable/planner-sensitive field line_items actually has (see
// 17H.4B0D4H0.2/.3's own field audit), used both for classification/
// pairing AND as the stale-plan snapshot the future applier will validate
// against. created_at is deliberately excluded (contributes no stale-plan
// protection value — H0.2's own conclusion); superseded_at is represented
// by set membership (the planner only ever receives CURRENT rows) rather
// than as a field, since a superseded row is never a planner input at all.
export interface CurrentLineItemRow {
  id: string
  product_name: string
  quantity: number
  unit_price: number
  billing_period: string
  total_amount: number
  confidence_score: number
  currency: string
  stripe_price_id: string | null
  applied_rule: string | null
  correction_reason: string | null
  source_section: string | null
  reviewer_corrected_fields: string[] | null
  reviewer_corrected_fields_complete: boolean
  reviewer_corrected_at: string | null
  fee_id: string | null
  tier_id: string | null
  recurring_fee_id: string | null
}

// The minimal shape a FRESH buildLineItems() row must satisfy for the
// planner to reason about it — generic (not a rigid interface) so callers
// pass the REAL buildLineItems output verbatim, extra fields and all;
// those extra fields flow straight through into a proposed `inserts` row
// untouched.
export interface FreshLineItemLike {
  product_name: string
  quantity: number
  unit_price: number
  billing_period: string
  total_amount: number
  confidence_score: number
  source_section?: string | null
  fee_id?: string | null
  tier_id?: string | null
  recurring_fee_id?: string | null
}

// Only the contract_terms slices the classifier/resolvers actually need —
// never the whole ContractTerms shape, so a caller can pass a narrowed
// object without reconstructing one.
export interface ReconciliationTermsContext {
  overage_tiers?: Array<{ tier_id?: string | null; tier_label: OverageTier['tier_label'] }> | null
  additional_recurring_fees?: Pick<AdditionalRecurringFee, 'fee_label' | 'metric_name' | 'rate_per_unit' | 'percentage_of_basis' | 'recurring_fee_id'>[] | null
  base_fee_proration?: { requires_confirmation?: boolean } | null
}

export type ReviewerCorrectableField = 'product_name' | 'unit_price' | 'quantity' | 'billing_period' | 'total_amount'

// Step 17H.4B0D4H1B1 — the exact same set lib/line-items.ts's
// REVIEWER_CORRECTABLE_LINE_ITEM_FIELDS already defines, duplicated here
// (not imported) because that file transitively imports lib/billing-writer
// -> lib/supabase (server-only, eager service-role client construction —
// the identical client-bundle-poisoning risk 17H.4B0D1.1 fixed once
// already this session). This planner must stay importable from any
// context (including, eventually, a client bundle) without pulling that
// chain in — same reasoning lib/line-item-markers.ts was extracted for.
const RECONCILIATION_REVIEWER_CORRECTABLE_FIELDS: readonly ReviewerCorrectableField[] = [
  'product_name', 'unit_price', 'quantity', 'billing_period', 'total_amount',
]

export interface ReconciliationBlocker {
  family: LineItemFamily
  reason: 'ambiguous' | 'integrity_conflict' | 'unknown_identity' | 'residual_identity_drift'
  affectedCurrentIds: string[]
  affectedFreshIndexes?: number[]
}

export interface ReconciliationUpdate {
  id: string
  changes: Partial<Record<ReviewerCorrectableField | 'confidence_score' | 'source_section' | 'fee_id' | 'tier_id' | 'recurring_fee_id', unknown>>
  family: LineItemFamily
  reason: 'same'
}

export interface ReconciliationInsert<F extends FreshLineItemLike> {
  row: F
  family: LineItemFamily
  reason: 'new'
}

export interface ReconciliationSupersede {
  id: string
  family: LineItemFamily
  reason: 'removed' | 'legacy_stale'
}

export type ExpectedCurrentRowSnapshot = CurrentLineItemRow

export interface CurrentLineItemReconciliationPlan<F extends FreshLineItemLike> {
  expectedCurrentRows: ExpectedCurrentRowSnapshot[]
  expectedCurrentRowIds: string[]
  updates: ReconciliationUpdate[]
  inserts: ReconciliationInsert<F>[]
  supersedes: ReconciliationSupersede[]
  blockers: ReconciliationBlocker[]
}

// ─────────────────────────────────────────────────────────────────────────
// Family classification — pure structural facts only, mirroring
// classifyTierCorrectionTarget's own exclusion order (never invoked
// directly: that function is oriented around a single mutation target and
// an idx-addressed routing result, not bulk classification — a simpler
// parallel classifier is more appropriate here, per instruction) and the
// live-data classifier already validated in 17H.4B0D4H0's own dry-run
// audit (179/16/12/357 reproduced exactly against real data).
const BASE_FEE_PRORATION_PLACEHOLDER = 'Recurring base fee — partial-period treatment unresolved'

function isVariableRateFee(fee: Pick<AdditionalRecurringFee, 'metric_name' | 'rate_per_unit'>): boolean {
  // Byte-for-byte the same predicate lib/line-items.ts's buildLineItems
  // uses for isVariableRate — duplicated, not re-derived, same reasoning
  // as RECONCILIATION_REVIEWER_CORRECTABLE_FIELDS above.
  return !!fee.metric_name && typeof fee.rate_per_unit === 'number' && fee.rate_per_unit > 0
}

function classifyLineItemFamily(
  row: { product_name: string; billing_period: string; quantity: number; tier_id?: string | null; recurring_fee_id?: string | null },
  terms: ReconciliationTermsContext,
): LineItemFamily {
  // Step 17H.4B0D4H1B1.1 — reordered to match the frozen classification
  // precedence exactly (classifyTierCorrectionTarget's own established
  // order: billing_period==='one_time' is checked BEFORE any base-fee
  // marker check, not after). In live data these checks are structurally
  // disjoint (no real row's product_name is a base-fee marker AND has
  // billing_period='one_time'), so this reordering changes no live
  // behavior — it is defense-in-depth against corrupted/adversarial data,
  // verified by dedicated regression tests. The base_fee_proration check
  // MUST still precede the general isRecurringBaseFeeLineItem check
  // (unchanged from before): the proration placeholder string is one of
  // isRecurringBaseFeeLineItem's own matched strings, so checking the
  // general marker first would swallow the placeholder into the generic
  // 'recurring_base_fee' family instead of its own distinct family.
  if (row.billing_period === 'one_time') return 'one_time'
  if (row.product_name === BASE_FEE_PRORATION_PLACEHOLDER) return 'base_fee_proration'
  if (isRecurringBaseFeeLineItem(row.product_name)) return 'recurring_base_fee'
  if (row.billing_period === 'annual' && row.quantity === 1 && row.product_name.startsWith('Price escalator')) return 'escalator'

  // Step 17H.4B0D4H1B4E3.4 — decisive, checked BEFORE any label-based
  // fallback (same precedence tier_id's own decisive check below uses):
  // a non-null recurring_fee_id proves this row originated from a specific
  // additional_recurring_fees[] mechanism at SOME point, regardless of
  // whatever AI wording its own product_name currently carries. Classifies
  // by looking up that mechanism BY ID (never by label), so a row's
  // classification survives its own family's own display label drifting
  // again on a LATER re-extraction — the exact robustness tier_id/fee_id
  // already have via billing_period/tier_id structural facts, extended
  // here since additional_recurring_fixed/variable have no such structural
  // marker of their own. If the id no longer resolves in fresh terms (the
  // mechanism was removed from the contract), falls through to the
  // label-based checks below as a defensive fallback — never invents a
  // family a vanished id can't prove.
  if (row.recurring_fee_id) {
    const matchedFee = (terms.additional_recurring_fees ?? []).find(f => f.recurring_fee_id === row.recurring_fee_id)
    if (matchedFee) return isVariableRateFee(matchedFee) ? 'additional_recurring_variable' : 'additional_recurring_fixed'
  }

  if (row.quantity === 0) {
    // Never classify tier from quantity alone (17H.4B0D1.1's own audited
    // collision — an additional-recurring variable-rate fee also emits
    // quantity:0).
    //
    // A non-null tier_id is decisive evidence on its own, checked BEFORE
    // consulting fresh terms: tier_id is only ever set by buildLineItems'
    // own tier-emitting loop (never the additional-recurring loop), so its
    // mere presence proves this row originated as a tier band at SOME
    // point — including a tier that has since been REMOVED from the
    // latest (fresh) terms entirely, which resolveTierForLineItem against
    // CURRENT fresh terms could never see (a removed tier's current row
    // must still classify as 'tier' so it can correctly become a residual
    // REMOVED candidate, not silently fall through to 'unknown' and be
    // left permanently unaddressed).
    if (row.tier_id) return 'tier'

    // Legacy row (tier_id null) — the canonical, already-hardened
    // ID-first tier resolver is the actual distinguishing evidence here:
    // 'matched'/'ambiguous'/'integrity_conflict' are ALL still
    // structurally a tier-family row (an identity problem WITHIN the
    // family is not a mis-classification INTO a different family) — only
    // 'missing' means this row has no tier evidence at all.
    const tiers = (terms.overage_tiers ?? []).map(t => ({ tier_id: t.tier_id ?? null, tier_label: t.tier_label }))
    const tierAssociation = resolveTierForLineItem({ tierId: null, productName: row.product_name }, tiers)
    if (tierAssociation.status !== 'missing') return 'tier'

    const variableLabels = new Set(
      (terms.additional_recurring_fees ?? []).filter(isVariableRateFee).map(f => f.fee_label),
    )
    if (variableLabels.has(row.product_name)) return 'additional_recurring_variable'
    return 'unknown'
  }

  const fixedLabels = new Set((terms.additional_recurring_fees ?? []).map(f => f.fee_label))
  if (fixedLabels.has(row.product_name)) return 'additional_recurring_fixed'
  return 'unknown'
}

// ─────────────────────────────────────────────────────────────────────────
// Strong-identity family pairing (tier, one-time) — ID-first, bijective,
// reusing the exact canonical resolvers (never a second independent
// label matcher). Each resolver call answers "does THIS current row have
// a safe match among ALL fresh candidates" using the full fresh set every
// time (never a shrinking "remaining" set, which would hide a genuine
// duplicate-consumption conflict) — bijectivity is verified afterward by
// checking whether more than one current row resolved to the SAME fresh
// index, which the per-target resolver cannot see on its own.
interface StrongFamilyPairing<C, F> {
  same: Array<{ current: C; fresh: F; freshIndex: number }>
  residualCurrent: C[]
  residualFresh: Array<{ item: F; index: number }>
  blocked: boolean
  blockedCurrentIds: string[]
}

function pairTierFamily<C extends { id: string; product_name: string; tier_id: string | null }, F extends FreshLineItemLike>(
  current: C[], fresh: F[],
): StrongFamilyPairing<C, F> {
  const tiers = fresh.map(f => ({ tier_id: f.tier_id ?? null, tier_label: f.product_name }))
  const perCurrentResult = current.map(row => ({
    row,
    result: resolveTierForLineItem({ tierId: row.tier_id, productName: row.product_name }, tiers),
  }))

  const blockedCurrentIds: string[] = []
  const matchedIndexToCurrentIds = new Map<number, string[]>()
  const missingCurrent: C[] = []

  for (const { row, result } of perCurrentResult) {
    if (result.status === 'ambiguous' || result.status === 'integrity_conflict') {
      blockedCurrentIds.push(row.id)
      continue
    }
    if (result.status === 'missing') {
      missingCurrent.push(row)
      continue
    }
    // matched — find its index in `fresh` by identity (tiers[] and fresh[]
    // share index positions by construction above).
    const idx = tiers.indexOf(result.tier)
    const group = matchedIndexToCurrentIds.get(idx) ?? []
    group.push(row.id)
    matchedIndexToCurrentIds.set(idx, group)
  }

  // Bijectivity check — a fresh index claimed by more than one current row
  // is a real conflict the per-target resolver cannot see on its own.
  const same: StrongFamilyPairing<C, F>['same'] = []
  const nonBijectiveFreshIndexes = new Set<number>()
  for (const [idx, currentIds] of matchedIndexToCurrentIds) {
    if (currentIds.length > 1) {
      nonBijectiveFreshIndexes.add(idx)
      blockedCurrentIds.push(...currentIds)
    }
  }
  for (const { row, result } of perCurrentResult) {
    if (result.status !== 'matched') continue
    const idx = tiers.indexOf(result.tier)
    if (nonBijectiveFreshIndexes.has(idx)) continue
    same.push({ current: row, fresh: fresh[idx], freshIndex: idx })
  }

  const claimedFreshIndexes = new Set(same.map(p => p.freshIndex))
  const residualFresh = fresh
    .map((item, index) => ({ item, index }))
    .filter(({ index }) => !claimedFreshIndexes.has(index) && !nonBijectiveFreshIndexes.has(index))

  return {
    same,
    residualCurrent: missingCurrent,
    residualFresh,
    blocked: blockedCurrentIds.length > 0,
    blockedCurrentIds: Array.from(new Set(blockedCurrentIds)),
  }
}

// One-time uses the OPPOSITE calling direction from tier: resolveOneTime
// LineItemAssociation was designed (and is used everywhere else in this
// codebase — resolveParkedOneTimeFeeRowFields/resolveScheduledOneTime
// FeeRowFields) with target = the AUTHORITATIVE fee (feeId/feeLabel from
// contract_terms.one_time_fees), candidates = CURRENT line items. Its
// legacy-target branch ("target.feeId null") specifically means "the
// AUTHORITATIVE fee itself predates identity" and, by design, treats a
// label-matching candidate that DOES carry a real fee_id as
// integrity_conflict, not a safe legacy bridge — the inverse of what a
// current-item-as-target call would need. A FRESH one-time row is exactly
// the authoritative-fee shape this resolver expects (it is generated 1:1
// from contract_terms.one_time_fees, carrying that fee's own fee_id/label
// verbatim) — so fresh rows are the correct "target" here, current rows
// the correct "candidates", never the reverse.
function pairOneTimeFamily<C extends { id: string; product_name: string; billing_period: string; unit_price: number; total_amount: number; quantity: number; fee_id: string | null }, F extends FreshLineItemLike>(
  current: C[], fresh: F[],
): StrongFamilyPairing<C, F> {
  const perFreshResult = fresh.map((freshRow, index) => ({
    index,
    result: resolveOneTimeLineItemAssociation({ feeId: freshRow.fee_id ?? null, feeLabel: freshRow.product_name }, current),
  }))

  const blockedCurrentIds: string[] = []
  const matchedCurrentIdToFreshIndexes = new Map<string, number[]>()
  const missingFreshIndexes: number[] = []

  for (const { index, result } of perFreshResult) {
    if (result.status === 'ambiguous' || result.status === 'integrity_conflict') {
      blockedCurrentIds.push(...result.candidates.map(c => c.id))
      continue
    }
    if (result.status === 'missing') {
      missingFreshIndexes.push(index)
      continue
    }
    const group = matchedCurrentIdToFreshIndexes.get(result.item.id) ?? []
    group.push(index)
    matchedCurrentIdToFreshIndexes.set(result.item.id, group)
  }

  // Bijectivity — a CURRENT row independently claimed by more than one
  // fresh target is a real conflict no single resolver call can see alone.
  const nonBijectiveCurrentIds = new Set<string>()
  for (const [currentId, freshIndexes] of matchedCurrentIdToFreshIndexes) {
    if (freshIndexes.length > 1) {
      nonBijectiveCurrentIds.add(currentId)
      blockedCurrentIds.push(currentId)
    }
  }

  const same: StrongFamilyPairing<C, F>['same'] = []
  const claimedCurrentIds = new Set<string>()
  for (const { index, result } of perFreshResult) {
    if (result.status !== 'matched') continue
    if (nonBijectiveCurrentIds.has(result.item.id)) continue
    same.push({ current: result.item, fresh: fresh[index], freshIndex: index })
    claimedCurrentIds.add(result.item.id)
  }

  const residualCurrent = current.filter(row => !claimedCurrentIds.has(row.id) && !nonBijectiveCurrentIds.has(row.id))
  const residualFresh = missingFreshIndexes.map(index => ({ item: fresh[index], index }))

  return {
    same,
    residualCurrent,
    residualFresh,
    blocked: blockedCurrentIds.length > 0,
    blockedCurrentIds: Array.from(new Set(blockedCurrentIds)),
  }
}

// Step 17H.4B0D4H1B4E3.4 — additional_recurring_fixed/additional_recurring_
// variable, promoted to strong-ID pairing now that recurring_fee_id exists
// (lib/recurring-fee-line-item-resolution.ts). Byte-for-byte the same
// shape as pairOneTimeFamily immediately above (fresh-as-target,
// current-as-candidates — the fresh row IS the authoritative mechanism,
// generated 1:1 from contract_terms.additional_recurring_fees[], carrying
// that fee's own recurring_fee_id/label verbatim) — deliberately a
// SEPARATE function, not a generalization, matching this codebase's own
// established convention of one dedicated pairing function per family.
function pairRecurringFeeFamily<C extends { id: string; product_name: string; billing_period: string; quantity: number; recurring_fee_id: string | null }, F extends FreshLineItemLike>(
  current: C[], fresh: F[],
): StrongFamilyPairing<C, F> {
  const perFreshResult = fresh.map((freshRow, index) => ({
    index,
    result: resolveRecurringFeeLineItemAssociation({ recurringFeeId: freshRow.recurring_fee_id ?? null, feeLabel: freshRow.product_name }, current),
  }))

  const blockedCurrentIds: string[] = []
  const matchedCurrentIdToFreshIndexes = new Map<string, number[]>()
  const missingFreshIndexes: number[] = []

  for (const { index, result } of perFreshResult) {
    if (result.status === 'ambiguous' || result.status === 'integrity_conflict') {
      blockedCurrentIds.push(...result.candidates.map(c => c.id))
      continue
    }
    if (result.status === 'missing') {
      missingFreshIndexes.push(index)
      continue
    }
    const group = matchedCurrentIdToFreshIndexes.get(result.item.id) ?? []
    group.push(index)
    matchedCurrentIdToFreshIndexes.set(result.item.id, group)
  }

  const nonBijectiveCurrentIds = new Set<string>()
  for (const [currentId, freshIndexes] of matchedCurrentIdToFreshIndexes) {
    if (freshIndexes.length > 1) {
      nonBijectiveCurrentIds.add(currentId)
      blockedCurrentIds.push(currentId)
    }
  }

  const same: StrongFamilyPairing<C, F>['same'] = []
  const claimedCurrentIds = new Set<string>()
  for (const { index, result } of perFreshResult) {
    if (result.status !== 'matched') continue
    if (nonBijectiveCurrentIds.has(result.item.id)) continue
    same.push({ current: result.item, fresh: fresh[index], freshIndex: index })
    claimedCurrentIds.add(result.item.id)
  }

  const residualCurrent = current.filter(row => !claimedCurrentIds.has(row.id) && !nonBijectiveCurrentIds.has(row.id))
  const residualFresh = missingFreshIndexes.map(index => ({ item: fresh[index], index }))

  return {
    same,
    residualCurrent,
    residualFresh,
    blocked: blockedCurrentIds.length > 0,
    blockedCurrentIds: Array.from(new Set(blockedCurrentIds)),
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Weak-identity family pairing — recurring_base_fee and escalator, the last
// two families with no semantic ID at all (17H.4B0D4H1B4E3.4 promoted
// additional_recurring_fixed/variable to strong-ID pairing above, via
// pairRecurringFeeFamily). SAME can only ever be established via an EXACT,
// unbroadened product_name match (no suffix stripping — one-time's own
// resolver already established "do not broaden label normalization" as
// doctrine, applied identically here). A label shared by more than one row
// on either side is itself unsafe — never resolved by position.
function pairWeakFamily<C extends { id: string; product_name: string }, F extends FreshLineItemLike>(
  current: C[], fresh: F[],
): StrongFamilyPairing<C, F> {
  const currentByLabel = new Map<string, C[]>()
  for (const row of current) {
    const g = currentByLabel.get(row.product_name)
    if (g) g.push(row); else currentByLabel.set(row.product_name, [row])
  }
  const freshByLabel = new Map<string, Array<{ item: F; index: number }>>()
  fresh.forEach((item, index) => {
    const g = freshByLabel.get(item.product_name)
    if (g) g.push({ item, index }); else freshByLabel.set(item.product_name, [{ item, index }])
  })

  const same: StrongFamilyPairing<C, F>['same'] = []
  const residualCurrent: C[] = []
  const blockedCurrentIds: string[] = []
  const claimedFreshIndexes = new Set<number>()

  for (const [label, currentGroup] of currentByLabel) {
    const freshGroup = freshByLabel.get(label) ?? []
    if (currentGroup.length > 1 || freshGroup.length > 1) {
      // Duplicate label on either side — never resolved by position.
      blockedCurrentIds.push(...currentGroup.map(r => r.id))
      continue
    }
    if (freshGroup.length === 1) {
      same.push({ current: currentGroup[0], fresh: freshGroup[0].item, freshIndex: freshGroup[0].index })
      claimedFreshIndexes.add(freshGroup[0].index)
    } else {
      residualCurrent.push(currentGroup[0])
    }
  }

  const residualFresh = fresh
    .map((item, index) => ({ item, index }))
    .filter(({ item, index }) => !claimedFreshIndexes.has(index) && (currentByLabel.get(item.product_name)?.length ?? 0) !== 1)

  return {
    same, residualCurrent, residualFresh,
    blocked: blockedCurrentIds.length > 0,
    blockedCurrentIds: Array.from(new Set(blockedCurrentIds)),
  }
}

// ─────────────────────────────────────────────────────────────────────────
// D2 reviewer-field merge — the exact conservative doctrine frozen across
// this whole audit sequence. Returns only the fields that should actually
// CHANGE (an empty object means the row is SAME with no proposed changes
// at all — still represented in `updates` for diagnostic completeness).
function computeSameRowFieldChanges<C extends CurrentLineItemRow, F extends FreshLineItemLike>(
  current: C, fresh: F,
): Partial<Record<ReviewerCorrectableField | 'confidence_score' | 'source_section' | 'fee_id' | 'tier_id', unknown>> {
  const changes: Partial<Record<ReviewerCorrectableField | 'confidence_score' | 'source_section' | 'fee_id' | 'tier_id', unknown>> = {}

  for (const field of RECONCILIATION_REVIEWER_CORRECTABLE_FIELDS) {
    const currentValue = current[field]
    const freshValue = fresh[field as keyof F] as unknown
    if (currentValue === freshValue) continue
    if (current.reviewer_corrected_fields_complete) {
      // complete=true: absence from reviewer_corrected_fields is
      // authoritative — a field NOT explicitly reviewer-corrected may be
      // refreshed; one that IS stays untouched.
      const isReviewerOwned = (current.reviewer_corrected_fields ?? []).includes(field)
      if (!isReviewerOwned) changes[field] = freshValue
    }
    // complete=false: absence proves nothing. current !== fresh here (the
    // equality check above already excluded the no-op case) -> always
    // preserve current, never propose the fresh value. No branch needed:
    // simply propose nothing.
  }

  // source_section — system-owned provenance citation, never reviewer-
  // tracked, safe to refresh unconditionally on SAME (17H.4B0D4H1B1 §21).
  if ((current.source_section ?? null) !== (fresh.source_section ?? null)) {
    changes.source_section = fresh.source_section ?? null
  }

  // confidence_score — deliberately ALWAYS preserved, never refreshed.
  // Audited (17H.4B0D4H0.2): confidence_score IS writable via the generic
  // line-items PATCH route's own `allowed` list, but it is NOT tracked by
  // reviewer_corrected_fields/REVIEWER_CORRECTABLE_LINE_ITEM_FIELDS — its
  // ownership after any correction is genuinely unknowable from persisted
  // state. Per this task's own explicit fallback ("if authority is
  // ambiguous: preserve CURRENT in v1"), never propose a change here.

  // stripe_price_id/applied_rule/correction_reason/currency — audited
  // (17H.4B0D4H0.2 field-writer trace): none has any writer anywhere in
  // this codebase after INSERT. No authority doctrine exists for them, and
  // this planner deliberately touches the smallest field set required —
  // never proposed here, on purpose, not merely omitted by oversight.

  return changes
}

// ─────────────────────────────────────────────────────────────────────────
// Main entry point.
export function planCurrentLineItemReconciliation<F extends FreshLineItemLike>(params: {
  currentItems: CurrentLineItemRow[]
  freshItems: F[]
  terms: ReconciliationTermsContext
}): CurrentLineItemReconciliationPlan<F> {
  const { currentItems, freshItems, terms } = params

  // ── Legacy percentage_of_basis pre-pass (17H.4B0D4H1B1 §18) — reuses the
  // exact predicate lib/line-items-reconciliation.ts's planLineItemReconciliation
  // already established as a proven, deterministic legacy-staleness rule:
  // any CURRENT row whose product_name matches a CURRENT percentage_of_basis
  // fee's label is a stale artifact from before buildLineItems started
  // skipping this family entirely — safely REMOVED regardless of whatever
  // family it would otherwise classify into. Extracted BEFORE ordinary
  // family classification runs, so these rows never enter any family's
  // pairing pass at all.
  const percentageOfBasisLabels = new Set(
    (terms.additional_recurring_fees ?? []).filter(f => f.percentage_of_basis).map(f => f.fee_label),
  )
  const legacyPercentageOfBasisIds = new Set(
    currentItems.filter(item => percentageOfBasisLabels.has(item.product_name)).map(item => item.id),
  )

  const remainingCurrent = currentItems.filter(item => !legacyPercentageOfBasisIds.has(item.id))

  // ── Base-fee proration pre-pass (17H.4B0D4H1B1 §17, extended
  // 17H.4B0D4H1B4E3.2) — an unresolved placeholder row that fresh
  // commercial truth now proves resolved (base_fee_proration.requires_
  // confirmation is no longer true) is stale. A placeholder that's STILL
  // unresolved on the fresh side is SAME (handled by the ordinary
  // base_fee_proration family pairing below, a plain exact-label match).
  //
  // E3.2 — reviewer-resolution continuity. isResolvedNow is driven
  // ENTIRELY by terms.base_fee_proration.requires_confirmation, and that
  // field only ever transitions true -> false via a reviewer's own
  // confirm-rule action (confirm-rule/route.ts's buildPeriodProrationRule)
  // — never by extraction guessing, never by a label heuristic. That is
  // exactly the "exact rule/decision being resolved" typed causal evidence
  // 17H.4B0D4H1B4E3.2 §6 describes: this planner already reads the field
  // that IS the proof, so no external "trusted hint" needs to be threaded
  // in from confirm-rule — the evidence and the reconciliation decision
  // live in the same place they always did.
  //
  // Ordinary weak-family doctrine (line ~595 below) would otherwise see
  // the placeholder's retirement and the resolved row's appearance as two
  // unrelated one-sided residuals in TWO DIFFERENT families (the
  // placeholder classifies as 'base_fee_proration'; its resolved
  // replacement classifies as 'recurring_base_fee' — see
  // classifyLineItemFamily) and correctly refuse to infer identity — which
  // is exactly the reconciliation_blocked deadlock the E3.1 live
  // acceptance pass exposed (a genuine reviewer resolution, permanently
  // unable to reach a clean state). Proven ONLY when cardinality is
  // unambiguous: exactly one placeholder row on the current side AND
  // exactly one fresh 'recurring_base_fee' row. Any other shape (zero, or
  // two-or-more fresh rows — e.g. an escalator or discount window created
  // more than one distinct rate segment) is NOT a provable 1:1 continuity
  // and falls back, unchanged, to the original legacy_stale-supersede +
  // ordinary weak-family residual handling below (17H.4B0D4H1B4E3.2 §14 —
  // never guess cardinality; a genuinely ambiguous transformation must
  // still surface as a blocker, not be silently paired).
  const isResolvedNow = !terms.base_fee_proration?.requires_confirmation
  const legacyPlaceholderRows = isResolvedNow
    ? remainingCurrent.filter(item => item.product_name === BASE_FEE_PRORATION_PLACEHOLDER)
    : []
  const freshRecurringBaseFeeRows = isResolvedNow
    ? freshItems
        .map((row, index) => ({ row, index }))
        .filter(({ row }) => classifyLineItemFamily(row, terms) === 'recurring_base_fee')
    : []
  const provenBaseFeeContinuityPair =
    legacyPlaceholderRows.length === 1 && freshRecurringBaseFeeRows.length === 1
      ? { current: legacyPlaceholderRows[0], fresh: freshRecurringBaseFeeRows[0].row, freshIndex: freshRecurringBaseFeeRows[0].index }
      : null

  const legacyResolvedProrationIds = new Set(
    isResolvedNow && !provenBaseFeeContinuityPair
      ? legacyPlaceholderRows.map(item => item.id)
      : [],
  )
  const remainingCurrent2 = remainingCurrent.filter(item =>
    !legacyResolvedProrationIds.has(item.id) && item.id !== provenBaseFeeContinuityPair?.current.id,
  )
  // The proven-continuity fresh row is claimed here, before ordinary
  // family classification ever sees it — it must never ALSO appear as an
  // unpaired 'recurring_base_fee' residual (which would either duplicate
  // the insert or reintroduce the very blocker this pre-pass exists to
  // avoid).
  const freshItemsForFamilyClassification = provenBaseFeeContinuityPair
    ? freshItems.filter((_, index) => index !== provenBaseFeeContinuityPair.freshIndex)
    : freshItems

  // ── Classify remaining current + all fresh rows into families ──────────
  const currentByFamily = new Map<LineItemFamily, CurrentLineItemRow[]>()
  for (const row of remainingCurrent2) {
    const family = classifyLineItemFamily(row, terms)
    const g = currentByFamily.get(family) ?? []
    g.push(row)
    currentByFamily.set(family, g)
  }
  const freshByFamily = new Map<LineItemFamily, F[]>()
  for (const row of freshItemsForFamilyClassification) {
    const family = classifyLineItemFamily(row, terms)
    const g = freshByFamily.get(family) ?? []
    g.push(row)
    freshByFamily.set(family, g)
  }

  const allFamilies: LineItemFamily[] = [
    'base_fee_proration', 'recurring_base_fee', 'additional_recurring_fixed',
    'additional_recurring_variable', 'tier', 'one_time', 'escalator', 'unknown',
  ]

  const updates: ReconciliationUpdate[] = []
  const inserts: ReconciliationInsert<F>[] = []
  const supersedes: ReconciliationSupersede[] = []
  const blockers: ReconciliationBlocker[] = []

  for (const id of legacyPercentageOfBasisIds) supersedes.push({ id, family: 'additional_recurring_fixed', reason: 'legacy_stale' })
  for (const id of legacyResolvedProrationIds) supersedes.push({ id, family: 'base_fee_proration', reason: 'legacy_stale' })

  // E3.2 — the proven continuity pair becomes a SAME-row UPDATE (same
  // physical line_items.id, same reviewer metadata, same currentness),
  // never a supersede+insert pair — "current row + reviewer decision ->
  // updated representation of the same obligation," not "remove old +
  // invent new" (17H.4B0D4H1B4E3.2 §11). Reuses computeSameRowFieldChanges
  // verbatim — the exact same D2 field-ownership doctrine (reviewer-owned
  // fields protected, confidence_score never refreshed, source_section
  // refreshed) any other weak-family SAME pair already gets, unmodified.
  if (provenBaseFeeContinuityPair) {
    const changes = computeSameRowFieldChanges(provenBaseFeeContinuityPair.current, provenBaseFeeContinuityPair.fresh)
    if (Object.keys(changes).length > 0) {
      updates.push({ id: provenBaseFeeContinuityPair.current.id, changes, family: 'recurring_base_fee', reason: 'same' })
    }
  }

  // Step 17H.4B0D4H1B1.1 — the only field changes a blocked family's
  // already-established SAME pairs may still carry: legacy-null -> modern-
  // id semantic promotion, and only that. Strengthens already-proven
  // identity without touching commercial value or population, so it is
  // safe even while the rest of the family is structurally unresolved.
  function computeIdentityPromotionOnly<F2 extends FreshLineItemLike>(
    family: LineItemFamily, current: CurrentLineItemRow, fresh: F2,
  ): Partial<Record<'fee_id' | 'tier_id' | 'recurring_fee_id', unknown>> {
    const promotion: Partial<Record<'fee_id' | 'tier_id' | 'recurring_fee_id', unknown>> = {}
    if (family === 'tier') {
      const freshTierId = fresh.tier_id ?? null
      if (current.tier_id === null && freshTierId !== null) promotion.tier_id = freshTierId
    }
    if (family === 'one_time') {
      const freshFeeId = fresh.fee_id ?? null
      if (current.fee_id === null && freshFeeId !== null) promotion.fee_id = freshFeeId
    }
    // Step 17H.4B0D4H1B4E3.4 — same legacy-null -> modern-id promotion, for
    // a line_items row created before recurring_fee_id existed.
    if (family === 'additional_recurring_fixed' || family === 'additional_recurring_variable') {
      const freshRecurringFeeId = fresh.recurring_fee_id ?? null
      if (current.recurring_fee_id === null && freshRecurringFeeId !== null) promotion.recurring_fee_id = freshRecurringFeeId
    }
    return promotion
  }

  for (const family of allFamilies) {
    const currentRows = currentByFamily.get(family) ?? []
    const freshRows = freshByFamily.get(family) ?? []
    if (currentRows.length === 0 && freshRows.length === 0) continue

    const isStrongIdFamily = family === 'tier' || family === 'one_time' || family === 'additional_recurring_fixed' || family === 'additional_recurring_variable'
    const pairing = family === 'tier'
      ? pairTierFamily(currentRows as Array<CurrentLineItemRow & { tier_id: string | null }>, freshRows)
      : family === 'one_time'
      ? pairOneTimeFamily(currentRows as Array<CurrentLineItemRow & { fee_id: string | null }>, freshRows)
      : family === 'additional_recurring_fixed' || family === 'additional_recurring_variable'
      ? pairRecurringFeeFamily(currentRows as Array<CurrentLineItemRow & { recurring_fee_id: string | null }>, freshRows)
      : pairWeakFamily(currentRows, freshRows)

    // Step 17H.4B0D4H1B1.1 — "blocked" is now determined ENTIRELY BEFORE
    // processing pairing.same — including the residual-drift case, which
    // H1B1 only detected AFTER same-pairs were already merged (a real bug:
    // a strong family with clean SAME pairs but ALSO some residual-drift
    // rows elsewhere in the same family was still giving its clean pairs
    // the FULL ordinary refresh, contradicting §3's own doctrine that an
    // unresolved family suppresses ordinary refresh for its ENTIRE
    // population, not just the specific rows in conflict). Weak families
    // have no residual NEW/REMOVED inference at all (§11), so ANY residual
    // on either side already means unresolved; strong families only
    // become residual-drift-blocked when BOTH sides have residual left
    // (one side empty is the safe NEW/REMOVED case, computed further
    // below, only reachable when this is false).
    // Step 17H.4B0D4H1B4E3.4 — additional_recurring_fixed/variable are
    // "strong" in that a PROVEN recurring_fee_id match is trusted exactly
    // like tier_id/fee_id (§18: ID-first SAME matching). But unlike tier/
    // one_time — whose classification is structurally robust regardless of
    // id (billing_period, tier_id) — these two families' classification
    // still falls back to a label check when no id is present at all (a
    // genuinely legacy, pre-this-migration row). A one-sided residual with
    // NO id evidence on the residual item itself is therefore NOT safely
    // insertable/removable via the ordinary strong-family rule — it could
    // just as easily be the SAME mechanism whose label drifted AGAIN with
    // no id to bridge it, exactly the scenario this whole pass exists to
    // avoid mis-resolving (§19: "NULL <-> NULL -> frozen weak-family
    // doctrine"). In production this exception is inert for fresh
    // residuals — assignRecurringFeeIds unconditionally backfills an id at
    // extraction time, so a genuinely NEW fee always carries one and
    // inserts safely; it only ever engages for id-less legacy data.
    const isRecurringFeeFamily = family === 'additional_recurring_fixed' || family === 'additional_recurring_variable'
    const hasIdlessResidual = isRecurringFeeFamily && (
      pairing.residualFresh.some(r => !(r.item as { recurring_fee_id?: string | null }).recurring_fee_id) ||
      pairing.residualCurrent.some(r => !(r as unknown as { recurring_fee_id?: string | null }).recurring_fee_id)
    )
    const hasResidualBlock = isStrongIdFamily
      ? (pairing.residualCurrent.length > 0 && pairing.residualFresh.length > 0) || hasIdlessResidual
      : (pairing.residualCurrent.length > 0 || pairing.residualFresh.length > 0)
    const familyBlocked = pairing.blocked || hasResidualBlock

    for (const pair of pairing.same) {
      // Blocked family: ONLY semantic-ID promotion may survive (§4) — no
      // ordinary field refresh, no source_section refresh, no reviewer-
      // field refresh. Clean family: the full D2 merge, unchanged from
      // H1B1. Either way, a SAME pairing is a reconciliation FACT, not
      // automatically an UPDATE operation — an empty `changes` object
      // (nothing actually needs to change) is never emitted as an update
      // (§7); the pair is still fully accounted for via
      // expectedCurrentRows/expectedCurrentRowIds regardless.
      const changes: Partial<Record<ReviewerCorrectableField | 'confidence_score' | 'source_section' | 'fee_id' | 'tier_id', unknown>> =
        familyBlocked
          ? computeIdentityPromotionOnly(family, pair.current, pair.fresh)
          : { ...computeSameRowFieldChanges(pair.current, pair.fresh), ...computeIdentityPromotionOnly(family, pair.current, pair.fresh) }
      if (Object.keys(changes).length > 0) {
        updates.push({ id: pair.current.id, changes, family, reason: 'same' })
      }
    }

    // Reported as up to two distinct blocker objects when both apply
    // (e.g. a duplicate-ID conflict AND a separate, unrelated residual-
    // drift pair in the same family) — each names its own precise reason
    // and affected rows, never merged into one vaguer blocker.
    if (pairing.blocked) {
      blockers.push({
        family,
        reason: isStrongIdFamily ? 'ambiguous' : 'unknown_identity',
        affectedCurrentIds: pairing.blockedCurrentIds.slice().sort(),
      })
    }
    if (hasResidualBlock) {
      blockers.push({
        family,
        reason: isStrongIdFamily ? 'residual_identity_drift' : 'unknown_identity',
        affectedCurrentIds: pairing.residualCurrent.map(r => r.id).sort(),
        affectedFreshIndexes: pairing.residualFresh.map(r => r.index).sort((a, b) => a - b),
      })
    }

    if (familyBlocked) {
      // Blocked family — zero structural (insert/supersede) mutations,
      // zero ordinary SAME refresh mutations. Only identity-promotion
      // updates (already pushed above, if any) survive.
      continue
    }

    if (!isStrongIdFamily) continue // weak family, fully clean — nothing further to compute

    // Strong-identity family, not blocked — residual NEW/REMOVED. (Both-
    // sides-residual, the UNKNOWN case, was already handled above via
    // hasResidualBlock, before this point could ever be reached with both
    // non-empty.)
    const residualCurrent = pairing.residualCurrent
    const residualFresh = pairing.residualFresh
    if (residualCurrent.length === 0 && residualFresh.length > 0) {
      for (const { item } of residualFresh) inserts.push({ row: item, family, reason: 'new' })
    } else if (residualFresh.length === 0 && residualCurrent.length > 0) {
      for (const row of residualCurrent) supersedes.push({ id: row.id, family, reason: 'removed' })
    }
  }

  return {
    expectedCurrentRows: currentItems.slice().sort((a, b) => a.id.localeCompare(b.id)),
    expectedCurrentRowIds: currentItems.map(i => i.id).sort(),
    updates: updates.sort((a, b) => a.id.localeCompare(b.id)),
    inserts: inserts.sort((a, b) => (a.family === b.family ? a.row.product_name.localeCompare(b.row.product_name) : a.family.localeCompare(b.family))),
    supersedes: supersedes.sort((a, b) => a.id.localeCompare(b.id)),
    blockers: blockers.sort((a, b) => (a.family === b.family ? a.reason.localeCompare(b.reason) : a.family.localeCompare(b.family))),
  }
}
