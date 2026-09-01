// Step 17H.3D2 (extended 17H.4A) — pure logic behind the tier-rate/
// escalator-% raw-value correction, extracted out of
// app/(dashboard)/configure/[id]/page.tsx so it has direct unit-test
// coverage (that page has no render-test harness). Commercial BoM's
// correction UI calls these — the network calls themselves (PATCH
// /terms, PATCH /line-items) stay in page.tsx, since they need the live
// `id`/fetch environment; everything that can be pure — array mutation,
// tier/line-item association, input parsing, result-to-message mapping —
// lives here instead.
//
// Generic over the minimal shape each mutation actually touches, rather
// than importing lib/types.ts's OverageTier/PriceEscalator — page.tsx
// defines its own local structural Tier/Escalator types throughout (an
// established, pre-existing convention on this page, not introduced
// here) that are close to but not structurally identical to the
// lib/types.ts versions (e.g. tier_label is optional on the page-local
// type, required in lib/types.ts). Constraining to the one field each
// mutation actually touches lets either shape satisfy these functions
// without a type mismatch or a duplicated function.

// Step 17H.4B0D1.1 fix — imported from lib/line-item-markers.ts (a
// zero-dependency module), NEVER from './line-items' directly: this file is
// imported by app/(dashboard)/configure/[id]/page.tsx, a Client Component,
// and lib/line-items.ts transitively imports lib/billing-writer.ts, which
// eagerly constructs a service-role Supabase client from a server-only
// secret. Importing isRecurringBaseFeeLineItem from './line-items' here
// once pulled that whole chain into the browser bundle, throwing
// "supabaseKey is required." at runtime — a real, live crash, not a
// hypothetical one.
import { isRecurringBaseFeeLineItem } from './line-item-markers'

// Replaces ONLY the entry at idx, preserving every other tier and every
// other field on the targeted tier unchanged — byte-for-byte the same
// mutation the pre-existing saveTierRate always performed.
export function computeUpdatedOverageTiers<T extends { rate_per_unit?: number }>(tiers: T[], idx: number, rate: number): T[] {
  return tiers.map((t, i) => i === idx ? { ...t, rate_per_unit: rate } : t)
}

// Same shape for escalators — no line_items counterpart exists for this
// one (see resolveTierLineItemAssociation's own doc for why tiers need
// one and escalators, per the 17H.3D2 audit, do not have an equivalent
// reliable bridge at all).
export function computeUpdatedEscalators<T extends { escalator_pct?: number | null }>(escalators: T[], idx: number, pct: number): T[] {
  return escalators.map((e, i) => i === idx ? { ...e, escalator_pct: pct } : e)
}

// Step 17H.4B0D4B1G — canonical, bidirectional, ID-first tier <-> line-item
// association. Replaces the two former temporary label-only bridges (a
// pre-tier_id resolveTierIndexForLineItem/resolveTierLineItemAssociation)
// with two resolvers that both check tier_id FIRST and fall back to the
// SAME normalized-label matching only when no ID evidence exists — never
// the reverse. tier_id is generated upstream (lib/contract-extractor.ts's
// assignTierIds) and preserved across re-extraction (lib/rule-id-
// stability.ts's preserveTierIdentity, lib/line-items.ts's buildLineItems
// projection) — see 17H.4B0D4B1A/B0B/B1E for the full identity chain this
// resolver finally consumes.
//
// FORWARD (line item -> authoritative contract_terms tier) and REVERSE
// (authoritative tier -> current line_items) are two genuinely different
// questions, each with its own resolver, because until Model B+ owns a
// transactional, deduplicated line_items set, EITHER side can independently
// be duplicated, missing, or still legacy — a forward match alone never
// proves the current OPERATIONAL row set agrees. persistTierRateCorrection
// below runs both, then checks the two results name the SAME physical row,
// before writing anything.
//
// Result model (shared shape, both directions): 'missing' (no evidence at
// all) is kept structurally distinct from 'integrity_conflict' (evidence
// was found and it DISAGREED) — collapsing them would hide a real data
// problem behind an ordinary "we don't know" message. 'ambiguous' covers
// multiple EQUALLY plausible candidates with no contradiction between them.
// match_mode records which axis actually decided the match — diagnostic
// only, never itself a safety condition.
export type TierMatchMode = 'tier_id' | 'legacy_label'

export type TierAssociationResult<T> =
  | { status: 'matched'; tier: T; index: number; match_mode: TierMatchMode }
  | { status: 'missing' }
  | { status: 'ambiguous'; candidates: T[] }
  | { status: 'integrity_conflict'; candidates: T[]; reason: string }

export type TierLineItemAssociation<T> =
  | { status: 'matched'; item: T; match_mode: TierMatchMode }
  | { status: 'missing' }
  | { status: 'ambiguous'; candidates: T[] }
  | { status: 'integrity_conflict'; candidates: T[]; reason: string }

// Same normalization this bridge has always used — kept unchanged: strip a
// trailing "— included in base fee"/"— overage" suffix (case-insensitive),
// trim, lowercase. No fuzzy matching, no broader punctuation handling. Once
// tier_id evidence exists this is strictly a fallback, never primary
// identity.
function normalizeTierLabelForReverseMatch(label: string): string {
  return label.replace(/\s*—\s*(included in base fee|overage)\s*$/i, '').trim().toLowerCase()
}

// FORWARD — given the line item currently being edited (its own tier_id, if
// it has one, plus its product_name as the transitional label fallback),
// find the ONE authoritative contract_terms.overage_tiers[] entry it
// corresponds to.
//
// Priority, exhaustively:
//  1. target.tierId set, exactly one authoritative tier shares it -> matched
//     via 'tier_id' — UNLESS a second, DIFFERENT tier also normalizes to
//     the same label as target.productName AND carries no tier_id of its
//     own (the shadow-candidate check below): that specific combination
//     means the authoritative array itself may contain a stale/duplicate
//     representation of this exact tier, so a positive ID match alone is
//     not enough — ambiguous, not matched. A DIFFERENT tier with its OWN
//     real, different tier_id sharing the label is not this risk (that
//     tier is already fully disambiguated by its own identity) and never
//     blocks the match — display-label collisions must not override
//     positive identity once both sides of the collision are themselves
//     unambiguously identified.
//  2. target.tierId set, no authoritative tier shares it, exactly one
//     normalized-label candidate exists -> integrity_conflict, regardless
//     of whether that candidate's own tier_id is null or a different real
//     value. A line item that already carries real identity evidence but
//     finds no corresponding authoritative record — only an unrelated
//     label match — is never treated as routine legacy fallback: nothing
//     in this pipeline (assignTierIds, preserveTierIdentity) ever
//     regresses an assigned tier_id back to null or reassigns it, so this
//     state can only reflect a genuine anomaly upstream, not an ordinary
//     lifecycle lag.
//  3. target.tierId set, no id match, multiple/zero label candidates ->
//     ambiguous / missing, same as the label-only cases below.
//  4. target.tierId null (legacy line item, no identity evidence at all) ->
//     the existing normalized cardinality-aware label bridge, behavior
//     UNCHANGED from before this pass: unique -> matched ('legacy_label'),
//     regardless of whether that tier itself already has a tier_id (an
//     ordinary "authoritative side modernized, this line item hasn't been
//     regenerated yet" state — nothing about it is contradictory, since
//     the line item makes no identity claim of its own to conflict with);
//     multiple -> ambiguous; none -> missing.
export function resolveTierForLineItem<T extends { tier_id?: string | null; tier_label?: string | null }>(
  target: { tierId: string | null; productName: string },
  tiers: T[],
): TierAssociationResult<T> {
  const indexed = tiers.map((tier, index) => ({ tier, index }))
  const targetLabel = normalizeTierLabelForReverseMatch(target.productName)
  const labelMatches = indexed.filter(
    ({ tier }) => tier.tier_label != null && normalizeTierLabelForReverseMatch(tier.tier_label) === targetLabel,
  )

  if (target.tierId) {
    const idMatches = indexed.filter(({ tier }) => tier.tier_id === target.tierId)
    if (idMatches.length > 1) return { status: 'ambiguous', candidates: idMatches.map(m => m.tier) }
    if (idMatches.length === 1) {
      const matched = idMatches[0]
      const shadowUnidentifiedSameLabel = labelMatches.some(
        ({ tier, index }) => index !== matched.index && (tier.tier_id ?? null) === null,
      )
      if (shadowUnidentifiedSameLabel) {
        return {
          status: 'ambiguous',
          candidates: [matched.tier, ...labelMatches.filter(m => m.index !== matched.index).map(m => m.tier)],
        }
      }
      return { status: 'matched', tier: matched.tier, index: matched.index, match_mode: 'tier_id' }
    }
    if (labelMatches.length === 0) return { status: 'missing' }
    if (labelMatches.length > 1) return { status: 'ambiguous', candidates: labelMatches.map(m => m.tier) }
    const only = labelMatches[0]
    return {
      status: 'integrity_conflict',
      candidates: [only.tier],
      reason: only.tier.tier_id
        ? 'This billing line item has a different tier identity than the contract tier matching its label.'
        : 'This billing line item has an identified tier, but the matching contract tier currently has no identity.',
    }
  }

  if (labelMatches.length === 0) return { status: 'missing' }
  if (labelMatches.length > 1) return { status: 'ambiguous', candidates: labelMatches.map(m => m.tier) }
  const only = labelMatches[0]
  return { status: 'matched', tier: only.tier, index: only.index, match_mode: 'legacy_label' }
}

// REVERSE — given the authoritative tier persistTierRateCorrection just
// forward-resolved, find the ONE current, structurally-eligible line item
// that represents it. "Structurally eligible" reuses classifyTierCorrection
// Target's own family exclusions (never one_time, never the recurring-base-
// fee marker family, never a non-zero-quantity row) so a corrupt/stray
// tier_id on a row from an unrelated family can never be considered here —
// classification always runs first conceptually; association only ever
// narrows within that same eligible candidate set.
//
// Priority mirrors resolveTierForLineItem, with ONE deliberate asymmetry:
// here the AUTHORITATIVE side may legitimately be modern (has a tier_id)
// while the CURRENT line item hasn't been regenerated yet (still legacy,
// tier_id null) — this is the ordinary, expected lag between contract_terms
// being re-extracted and the next execute regenerating line_items, not
// evidence of corruption, so it resolves as a safe legacy-label fallback
// match rather than a conflict. The reverse of that — a real, DIFFERENT
// tier_id on the matching line item — is still always integrity_conflict,
// exactly like the forward direction.
export function resolveTierLineItemAssociation<
  T extends { id: string; product_name: string; billing_period: string; quantity: number; tier_id?: string | null },
>(
  target: { tierId: string | null; tierLabel: string | null },
  items: T[],
): TierLineItemAssociation<T> {
  const eligible = items.filter(
    item => item.billing_period !== 'one_time' && !isRecurringBaseFeeLineItem(item.product_name) && item.quantity === 0,
  )
  const targetLabel = target.tierLabel ? normalizeTierLabelForReverseMatch(target.tierLabel) : null
  const labelMatches = targetLabel
    ? eligible.filter(item => normalizeTierLabelForReverseMatch(item.product_name) === targetLabel)
    : []

  if (target.tierId) {
    const idMatches = eligible.filter(item => item.tier_id === target.tierId)
    if (idMatches.length > 1) return { status: 'ambiguous', candidates: idMatches }
    if (idMatches.length === 1) {
      const matched = idMatches[0]
      const shadowUnidentifiedSameLabel = labelMatches.some(
        item => item.id !== matched.id && (item.tier_id ?? null) === null,
      )
      if (shadowUnidentifiedSameLabel) {
        return { status: 'ambiguous', candidates: [matched, ...labelMatches.filter(i => i.id !== matched.id)] }
      }
      return { status: 'matched', item: matched, match_mode: 'tier_id' }
    }
    if (labelMatches.length === 0) return { status: 'missing' }
    if (labelMatches.length > 1) return { status: 'ambiguous', candidates: labelMatches }
    const only = labelMatches[0]
    if (only.tier_id) {
      return {
        status: 'integrity_conflict',
        candidates: [only],
        reason: 'A billing line item with a different tier identity matches this contract tier by label.',
      }
    }
    // Expected transitional state — see this function's own doc comment.
    return { status: 'matched', item: only, match_mode: 'legacy_label' }
  }

  if (labelMatches.length === 0) return { status: 'missing' }
  if (labelMatches.length > 1) return { status: 'ambiguous', candidates: labelMatches }
  const only = labelMatches[0]
  if (only.tier_id) {
    return {
      status: 'integrity_conflict',
      candidates: [only],
      reason: 'This billing line item has an identified tier, but the matching contract tier currently has no identity.',
    }
  }
  return { status: 'matched', item: only, match_mode: 'legacy_label' }
}

// Step 17H.4B0D1.1 — WRITE-safe tier classification, deliberately separate
// from page.tsx's classifyItem (a general-purpose DISPLAY classifier that
// still falls back to label substrings like "tier"/"overage" for rows it
// can't otherwise place — fine for choosing which review card to render,
// never safe for deciding which authoritative table a correction mutates).
//
// Two concepts this function keeps distinct, per doctrine:
//   - Commercial MECHANISM classification (is this row an overage tier at
//     all) — decided here using only structural facts buildLineItems
//     itself always sets (billing_period, the recurring-base-fee family's
//     own deterministic marker strings, quantity), never extracted label
//     text, and never tier_id — a corrupt/stray tier_id on a one-time,
//     base-fee, or non-zero-quantity row must never flip its family.
//   - The tier_label/tier_id <-> product_name IDENTITY BRIDGE (which tier,
//     once we know it IS one) — resolveTierForLineItem above, reused here
//     rather than duplicated.
//
// Audited collision, not assumed away: buildLineItems emits quantity: 0 for
// FOUR row shapes, not one — overage_tiers (the real target), the
// base_fee_proration placeholder (excluded below via the exact marker
// string isRecurringBaseFeeLineItem already checks), a parked one-time fee
// (excluded below via billing_period === 'one_time', true for every
// one-time row regardless of parked state), and — genuinely reachable, not
// hypothetical — a variable-rate additional_recurring_fee (isVariableRate:
// true also forces quantity: 0, with an arbitrary extracted fee_label that
// could contain any words at all, including "tier"/"overage"). quantity
// alone cannot distinguish this fourth case from a real tier; only the
// identity bridge can, by checking whether the row's tier_id/label actually
// resolves to a real overageTiers entry. When it doesn't — genuinely
// uncertain, never guessed either direction.
export type TierCorrectionRouting =
  | { target: 'tier'; idx: number }
  | { target: 'non_tier' }
  // Distinguishes three genuinely different "cannot safely correct this
  // now" causes: no structural evidence this is any kind of tier at all
  // (no_structural_match); structurally quantity-zero and plausibly
  // tier-shaped but the identity bridge can't uniquely place it, no
  // evidence disagreeing (ambiguous_structural_match); and evidence that
  // was found and actively DISAGREED (integrity_conflict) — a materially
  // more alarming state than plain ambiguity, never collapsed into it.
  | { target: 'uncertain'; reason: 'no_structural_match' | 'ambiguous_structural_match' | 'integrity_conflict' }

export function classifyTierCorrectionTarget(
  item: { product_name: string; billing_period: string; quantity: number; tier_id?: string | null },
  overageTiers: Array<{ tier_id?: string | null; tier_label?: string | null }>,
): TierCorrectionRouting {
  if (item.billing_period === 'one_time') return { target: 'non_tier' }
  if (isRecurringBaseFeeLineItem(item.product_name)) return { target: 'non_tier' }
  if (item.quantity !== 0) return { target: 'non_tier' }

  const association = resolveTierForLineItem({ tierId: item.tier_id ?? null, productName: item.product_name }, overageTiers)
  if (association.status === 'matched') return { target: 'tier', idx: association.index }
  if (association.status === 'ambiguous') return { target: 'uncertain', reason: 'ambiguous_structural_match' }
  if (association.status === 'integrity_conflict') return { target: 'uncertain', reason: 'integrity_conflict' }
  return { target: 'uncertain', reason: 'no_structural_match' }
}

// Byte-for-byte the same parsing saveTierRate always used: strips
// everything but digits/./,, then treats the first comma as a decimal
// point (European input support). Negative sign is stripped (never
// negative — existing, preserved semantics, not a new constraint).
// Returns null (not NaN) so callers never need a second isNaN check.
export function parseTierRateInput(raw: string): number | null {
  const rate = parseFloat(raw.replace(/[^0-9.,]/g, '').replace(',', '.'))
  return isNaN(rate) ? null : rate
}

// Byte-for-byte the same parsing saveEscalatorPct always used — no comma
// handling (a genuine, pre-existing validation-parity difference from
// the tier parser, preserved rather than silently unified; see the
// 17H.3D2 report).
export function parseEscalatorPctInput(raw: string): number | null {
  const pct = parseFloat(raw.replace(/[^0-9.]/g, ''))
  return isNaN(pct) ? null : pct
}

// Step 17H.4A — explicit, honest outcome states for a tier-rate
// correction. There is deliberately no generic "success | failure"
// boolean: a correction that updated contract_terms but NOT the
// associated line_items row is neither a clean success nor a clean
// failure — it is its own state (partial_failure) that the UI must
// surface distinctly, never collapsed into "success" (item 13's
// explicit, mandatory requirement).
export type TierCorrectionResult =
  | { status: 'success' }
  // Preflight (item 9) refused to write anything at all — no
  // contract_terms write was attempted.
  | { status: 'missing_association' }
  | { status: 'ambiguous_association'; candidateCount: number }
  // Step 17H.4B0D4B1G — the bidirectional preflight (forward resolve,
  // reverse resolve, same-row check) found EXPLICIT DISAGREEING identity
  // evidence rather than mere absence/ambiguity — e.g. the target line
  // item's own tier_id doesn't match any authoritative tier, or the
  // reverse-resolved authoritative tier's current line item isn't the row
  // actually being edited. Zero writes, same as missing/ambiguous.
  | { status: 'integrity_conflict' }
  // The FIRST write (contract_terms) itself failed or threw — no state
  // changed at all.
  | { status: 'failed' }
  // The first write (contract_terms) succeeded but the second
  // (line_items) did not — the two authoritative representations are
  // now out of sync and the user must be told so explicitly.
  | { status: 'partial_failure' }

export type EscalatorCorrectionResult =
  | { status: 'success' }
  | { status: 'failed' }

// Step 17H.4A, item 16 — one canonical mapping from result to a compact,
// truthful, non-leaking user-facing message (never a raw DB error/stack
// trace). Shared so the tier correction UI never drifts from this
// wording, and so it's independently testable without rendering JSX.
export function describeTierCorrectionError(result: Exclude<TierCorrectionResult, { status: 'success' }>): string {
  switch (result.status) {
    case 'missing_association':
      return 'This tier could not be matched safely to its billing line item.'
    case 'ambiguous_association':
      return 'Multiple billing line items match this tier. The correction was not applied.'
    case 'integrity_conflict':
      return 'The billing item identity conflicts with the current contract tier. Refresh or review the configuration before correcting this rate.'
    case 'failed':
      return 'Could not save the corrected rate. No change was confirmed.'
    case 'partial_failure':
      return 'The correction was only partially applied. Billing configuration needs review.'
  }
}

export function describeEscalatorCorrectionError(): string {
  return 'Could not save the corrected rate. No change was confirmed.'
}

// Step 17H.4A, revised 17H.4B0D4B1G — the full tier-rate correction
// operation, moved here (out of page.tsx, which previously kept only the
// pure sub-pieces above and inlined this orchestration itself) specifically
// so the HTTP response-handling/failure semantics has direct, fetch-mockable
// unit-test coverage without needing a browser/render harness. `fetchImpl`
// defaults to the global `fetch`, and tests inject a stub to prove the
// 200/400/500/network-throw outcomes below without touching a real network
// or database.
//
// Global safety rule (item 0): never returns 'success' unless BOTH
// authoritative writes are confirmed via response.ok.
//
// Step 17H.4B0D4B1G — this helper now OWNS the complete bidirectional
// safety preflight; a caller never supplies a precomputed tier index or a
// pre-resolved target row (retiring the last independent write-path label
// matcher, page.tsx's own findTierForItem, from ever deciding what gets
// written). It: (1) forward-resolves targetItem -> the authoritative tier
// via resolveTierForLineItem, (2) reverse-resolves that tier -> the current
// line-item set via resolveTierLineItemAssociation, (3) requires the
// reverse resolution to land on the EXACT SAME row as targetItem. A forward
// match alone is not sufficient: until Model B+ owns a transactional,
// deduplicated line_items set, a duplicate/stale current row could exist
// even when the forward direction resolves cleanly — see this file's
// top-of-section comment. Any disagreement anywhere in this chain returns
// immediately, writing nothing.
export async function persistTierRateCorrection(params: {
  jobId: string
  targetItem: { id: string; product_name: string; billing_period: string; quantity: number; tier_id?: string | null }
  overageTiers: Array<{ tier_id?: string | null; tier_label?: string | null; rate_per_unit?: number }>
  lineItems: Array<{ id: string; product_name: string; billing_period: string; quantity: number; tier_id?: string | null }>
  rate: number
  fetchImpl?: typeof fetch
}): Promise<TierCorrectionResult> {
  const { jobId, targetItem, overageTiers, lineItems, rate, fetchImpl = fetch } = params

  const forward = resolveTierForLineItem(
    { tierId: targetItem.tier_id ?? null, productName: targetItem.product_name },
    overageTiers,
  )
  if (forward.status === 'missing') return { status: 'missing_association' }
  if (forward.status === 'ambiguous') return { status: 'ambiguous_association', candidateCount: forward.candidates.length }
  if (forward.status === 'integrity_conflict') return { status: 'integrity_conflict' }

  const reverse = resolveTierLineItemAssociation(
    { tierId: forward.tier.tier_id ?? null, tierLabel: forward.tier.tier_label ?? null },
    lineItems,
  )
  if (reverse.status === 'missing') return { status: 'missing_association' }
  if (reverse.status === 'ambiguous') return { status: 'ambiguous_association', candidateCount: reverse.candidates.length }
  if (reverse.status === 'integrity_conflict') return { status: 'integrity_conflict' }

  // The two directions must name the exact same physical row — a forward
  // match to a tier whose reverse resolution lands on a DIFFERENT current
  // line item than the one actually being edited means the operational set
  // has drifted from what this edit assumes; never silently correct the
  // reverse-resolved row instead of the one the reviewer is looking at.
  if (reverse.item.id !== targetItem.id) return { status: 'integrity_conflict' }

  const newTiers = computeUpdatedOverageTiers(overageTiers, forward.index, rate)
  let termsRes: Response
  try {
    termsRes = await fetchImpl(`/api/jobs/${jobId}/terms`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overage_tiers: newTiers }),
    })
  } catch {
    return { status: 'failed' }
  }
  if (!termsRes.ok) return { status: 'failed' }

  // contract_terms is now authoritatively updated — from here on, ANY
  // failure is a partial_failure (the two representations have
  // diverged), never a plain 'failed' (which would wrongly imply nothing
  // changed).
  let itemRes: Response
  try {
    itemRes = await fetchImpl(`/api/jobs/${jobId}/line-items`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      // Step 17H.4B0D2 — markReviewerCorrectedFields rides in the SAME
      // request as the value write, never a separate call: this line is
      // only ever reached after preflight passed and the contract_terms
      // write already succeeded, so this one PATCH's own success/failure
      // is exactly what determines 'success' vs 'partial_failure' below —
      // the metadata can never land without the value, or vice versa.
      body: JSON.stringify({
        itemId: targetItem.id,
        fields: { unit_price: rate, confidence_score: 1 },
        markReviewerCorrectedFields: ['unit_price'],
      }),
    })
  } catch {
    return { status: 'partial_failure' }
  }
  if (!itemRes.ok) return { status: 'partial_failure' }

  return { status: 'success' }
}

// Step 17H.4A — same rationale as persistTierRateCorrection above,
// scaled to escalators' single-write shape.
export async function persistEscalatorPctCorrection(params: {
  jobId: string
  escalators: Array<{ escalator_pct?: number | null }>
  idx: number
  pct: number
  fetchImpl?: typeof fetch
}): Promise<EscalatorCorrectionResult> {
  const { jobId, escalators, idx, pct, fetchImpl = fetch } = params
  if (!escalators[idx]) return { status: 'failed' }
  const newEscalators = computeUpdatedEscalators(escalators, idx, pct)
  let res: Response
  try {
    res = await fetchImpl(`/api/jobs/${jobId}/terms`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ escalators: newEscalators }),
    })
  } catch {
    return { status: 'failed' }
  }
  return res.ok ? { status: 'success' } : { status: 'failed' }
}
