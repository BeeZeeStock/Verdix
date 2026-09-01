// Step 17H.4B0D4H1B4E3.3 — re-extraction authority preservation.
//
// Root cause (Finding #2, first observed in the E3 fresh-extraction
// acceptance pass): execute/route.ts's re-extraction pipeline persists
// fresh AI output as a blind overwrite of contract_terms. Fresh AI
// extraction is EVIDENCE about the contract; a previously confirmed
// reviewer decision is AUTHORITATIVE operational state. This module is the
// merge layer between them for the specific fields that have no other
// preservation mechanism today: base_fee_proration (job-level),
// fixed_fee_billing_timing (job-level), variable_invoice_timing (per
// additional_recurring_fee), and discount identity (discount_rule_id +
// .interpretation).
//
// Doctrine, established by precedent already in lib/rule-id-stability.ts's
// preserveTierCalculationReviewState (read before writing this — same
// reasoning applies here, not re-derived):
//   - The persisted contract_terms JSONB alone can never distinguish
//     "the extractor itself concluded requires_confirmation=false" from "a
//     reviewer explicitly confirmed this via confirm-rule" — only a
//     corroborating CURRENT commercial_rule_interpretations row (is_current
//     = true) proves the latter. Every row in that table represents a real
//     confirm-rule action by a human, regardless of decision_provenance
//     ('reviewer_policy' vs 'contract_derived' — that distinguishes WHETHER
//     the confirmed answer required independent judgment or matched
//     explicit contract text, never WHETHER a human confirmed it at all).
//   - Semantic equivalence, never byte equivalence (§11): a fresh
//     extraction that is silent (its own value resolves to the family's
//     'unclear'/ambiguous state) or reaches the SAME concrete value as the
//     confirmed decision is treated as unchanged — the confirmed decision
//     is restored, requires_confirmation stays false. A fresh extraction
//     that reaches a DIFFERENT concrete value is a genuine conflict —
//     neither side is silently preferred; the row re-enters review with
//     both pieces of evidence visible (the old confirmed value stays
//     queryable via commercial_rule_interpretations; the new one is
//     preserved in confirmation_reason for the reviewer to see immediately,
//     never discarded to make room for the other).
//   - System-owned evidence (source_clause, confidence — 17H.4B0D4H1B1's
//     own D2 doctrine, "human-owned value -> preserve, system-owned
//     evidence -> may refresh") is always taken from the FRESH extraction
//     when present, even on a clean restore — freezing evidence forever
//     would make the audit trail describe an increasingly stale source
//     pointer.
import type { Discount, PeriodProrationRule, FixedFeeBillingTimingRule, AdditionalRecurringFee } from './types'

// The minimal shape read from a CURRENT (is_current = true)
// commercial_rule_interpretations row. approved_interpretation is the raw
// client-submitted decision confirm-rule persisted at confirmation time —
// authoritative for the specific decision field this module reads from it,
// never trusted for fields it doesn't explicitly carry (those fall back to
// fresh extraction, per the system-owned-evidence rule above).
export interface CurrentRuleAuditRow {
  contract_unit_type: string | null
  approved_interpretation: unknown
}

function findCurrentAuditRow(rows: CurrentRuleAuditRow[], contractUnitType: string | null): CurrentRuleAuditRow | null {
  const matches = rows.filter(r => r.contract_unit_type === contractUnitType)
  // 0 -> nothing to merge; >1 (a data-integrity anomaly — is_current should
  // be unique per (rule_type, contract_unit_type) by confirm-rule's own
  // "demote priorCurrent" step) -> ambiguous, never pick a winner. Mirrors
  // the cardinality doctrine every other identity bridge in this codebase
  // already follows (preserveTierIdentity, preserveOneTimeFeeIdentity).
  return matches.length === 1 ? matches[0] : null
}

// Step 17H.4B0D4H1B4E3.4.1, generalized 17H.4B0D4H1B4E3.4.2 — the ONE
// shared synthetic-key construction for every per-recurring-fee reviewer
// decision (variable_invoice_timing, recurring_fee_proration), mirroring
// the discount:{id}/credit:{id}/interaction:{key} convention
// commercial_rule_interpretations.contract_unit_type already uses for
// non-singular rules. Both confirm-rule/route.ts (writing the audit row)
// and this module's per-fee merge functions (reading it back) call this
// SAME function, so the key format can never drift between the two sides.
export function recurringFeeDecisionKey(recurringFeeId: string | null | undefined): string | null {
  return recurringFeeId ? `recurring_fee:${recurringFeeId}` : null
}

// Shared by every per-recurring-fee merge function below (currently
// variable_invoice_timing, recurring_fee_proration): resolves which
// CurrentRuleAuditRow, if any, applies to one fresh fee — recurring_fee_id
// FIRST (via recurringFeeDecisionKey, unambiguous by construction once an
// id exists), falling back to the fee_label key ONLY when the fee has no
// id yet AND that label is unique within this fresh batch (§9/§10 — a
// shared label with no id to disambiguate must never let one fee's
// decision leak onto another).
function resolveRecurringFeeAudit(
  fee: { fee_label: string; recurring_fee_id?: string },
  currentAuditRows: CurrentRuleAuditRow[],
  freshLabelCounts: Map<string, number>,
): CurrentRuleAuditRow | null {
  const idKey = recurringFeeDecisionKey(fee.recurring_fee_id)
  const idAudit = idKey ? findCurrentAuditRow(currentAuditRows, idKey) : null
  if (idAudit) return idAudit
  const labelIsUniqueThisBatch = (freshLabelCounts.get(fee.fee_label) ?? 0) === 1
  return labelIsUniqueThisBatch ? findCurrentAuditRow(currentAuditRows, fee.fee_label) : null
}

function countByFeeLabel(fees: Array<{ fee_label: string }>): Map<string, number> {
  const counts = new Map<string, number>()
  for (const fee of fees) counts.set(fee.fee_label, (counts.get(fee.fee_label) ?? 0) + 1)
  return counts
}

// ─────────────────────────────────────────────────────────────────────────
// base_fee_proration — job-level (contract_unit_type is always null in the
// audit table for this rule_type).
export function mergeBaseFeeProrationDecision(
  freshRule: PeriodProrationRule | null | undefined,
  currentAuditRows: CurrentRuleAuditRow[],
): PeriodProrationRule | null | undefined {
  if (!freshRule) return freshRule
  const audit = findCurrentAuditRow(currentAuditRows, null)
  if (!audit) return freshRule // nothing confirmed yet — fresh extraction is the only evidence, use it as-is

  const approved = audit.approved_interpretation as { prorate_partial_periods?: PeriodProrationRule['prorate_partial_periods']; reset_anchor?: PeriodProrationRule['reset_anchor']; source_clause?: string | null } | null
  const confirmedValue = approved?.prorate_partial_periods
  if (confirmedValue === undefined) return freshRule // audit row exists but doesn't carry this field — nothing to restore

  const freshIsUnclear = freshRule.prorate_partial_periods === 'unclear'
  const freshMatchesConfirmed = freshRule.prorate_partial_periods === confirmedValue

  if (freshIsUnclear || freshMatchesConfirmed) {
    return {
      ...freshRule,
      prorate_partial_periods: confirmedValue,
      reset_anchor: approved?.reset_anchor ?? freshRule.reset_anchor,
      requires_confirmation: false,
      confirmation_reason: null,
    }
  }

  // Fresh evidence resolves to a DIFFERENT concrete value than what was
  // confirmed — a genuine conflict (§10). Never silently keep the old
  // decision, never silently adopt the new one: re-enter review with both
  // pieces of evidence visible. The prior confirmed value remains
  // permanently queryable via commercial_rule_interpretations regardless.
  return {
    ...freshRule,
    requires_confirmation: true,
    confirmation_reason: `Previously confirmed as "${String(confirmedValue)}", but re-extraction now reads this contract as "${String(freshRule.prorate_partial_periods)}". Re-confirm to resolve the conflict.`,
  }
}

// ─────────────────────────────────────────────────────────────────────────
// fixed_fee_billing_timing — job-level, identical shape/doctrine to
// base_fee_proration above, just one field ('timing') instead of two.
export function mergeFixedFeeBillingTimingDecision(
  freshRule: FixedFeeBillingTimingRule | null | undefined,
  currentAuditRows: CurrentRuleAuditRow[],
): FixedFeeBillingTimingRule | null | undefined {
  return applyTimingMerge(freshRule, findCurrentAuditRow(currentAuditRows, null))
}

// ─────────────────────────────────────────────────────────────────────────
// variable_invoice_timing — per additional_recurring_fee. Step
// 17H.4B0D4H1B4E3.4.1 — now recurring_fee_id-FIRST (confirm-rule/route.ts's
// own auditUnitKey computation stores 'recurring_fee:{id}' once the target
// fee has one, mirroring the discount:{id}/credit:{id} synthetic-key
// convention), with the ORIGINAL fee_label lookup surviving only as the
// transitional bridge for a decision confirmed before recurring_fee_id
// existed. Before this change, wording drift alone (the exact live case
// E3.4 fixed for LINE-ITEM identity) could still ORPHAN the reviewer's
// confirmed timing decision here, since this merge was still purely
// label-keyed — inconsistent with E3.3's own authoritative-decision-
// preservation doctrine. §10 — the label fallback is skipped entirely
// (never applied) whenever more than one fresh fee shares the exact same
// fee_label in this batch: with no id to disambiguate them, a shared label
// could otherwise let one fee's confirmed decision leak onto an unrelated
// fee it merely happens to display the same text as this generation.
export function mergeVariableInvoiceTimingForFees(
  freshFees: AdditionalRecurringFee[],
  currentAuditRows: CurrentRuleAuditRow[],
): AdditionalRecurringFee[] {
  const labelCounts = countByFeeLabel(freshFees)
  return freshFees.map(fee => ({
    ...fee,
    variable_invoice_timing: applyTimingMerge(fee.variable_invoice_timing, resolveRecurringFeeAudit(fee, currentAuditRows, labelCounts)),
  }))
}

// ─────────────────────────────────────────────────────────────────────────
// recurring_fee_proration — per additional_recurring_fee, the SAME
// recurring_fee_id-first / fee_label-legacy-bridge doctrine as
// mergeVariableInvoiceTimingForFees immediately above (17H.4B0D4H1B4E3.4.2
// — this rule type used the identical fee_label-only addressing
// variable_invoice_timing had before E3.4.1, with the identical wording-
// drift exposure and, until this pass, NO merge/preservation across
// re-extraction AT ALL — additional_recurring_fees[].proration was
// blindly overwritten by every re-extraction regardless of addressing
// key). PeriodProrationRule has two decision fields (prorate_partial_
// periods, reset_anchor) — same shape base_fee_proration uses at the
// job level (lib/contract-terms-merge.ts's mergeBaseFeeProrationDecision),
// but this is a deliberately separate function (not shared code) since it
// operates per-fee via resolveRecurringFeeAudit, mirroring this
// codebase's own convention of one dedicated function per family rather
// than one generalized rule engine.
export function mergeRecurringFeeProrationForFees(
  freshFees: AdditionalRecurringFee[],
  currentAuditRows: CurrentRuleAuditRow[],
): AdditionalRecurringFee[] {
  const labelCounts = countByFeeLabel(freshFees)
  return freshFees.map(fee => ({
    ...fee,
    proration: applyProrationMerge(fee.proration, resolveRecurringFeeAudit(fee, currentAuditRows, labelCounts)),
  }))
}

function applyProrationMerge(
  freshRule: PeriodProrationRule | null | undefined,
  audit: CurrentRuleAuditRow | null,
): PeriodProrationRule | null | undefined {
  if (!freshRule) return freshRule
  if (!audit) return freshRule

  const approved = audit.approved_interpretation as { prorate_partial_periods?: PeriodProrationRule['prorate_partial_periods']; reset_anchor?: PeriodProrationRule['reset_anchor']; source_clause?: string | null } | null
  const confirmedValue = approved?.prorate_partial_periods
  if (confirmedValue === undefined) return freshRule

  const freshIsUnclear = freshRule.prorate_partial_periods === 'unclear'
  const freshMatchesConfirmed = freshRule.prorate_partial_periods === confirmedValue

  if (freshIsUnclear || freshMatchesConfirmed) {
    return {
      ...freshRule,
      prorate_partial_periods: confirmedValue,
      reset_anchor: approved?.reset_anchor ?? freshRule.reset_anchor,
      requires_confirmation: false,
      confirmation_reason: null,
    }
  }

  return {
    ...freshRule,
    requires_confirmation: true,
    confirmation_reason: `Previously confirmed as "${String(confirmedValue)}", but re-extraction now reads this contract as "${String(freshRule.prorate_partial_periods)}". Re-confirm to resolve the conflict.`,
  }
}

function applyTimingMerge<R extends { timing: string; source_clause?: string | null; requires_confirmation: boolean; confirmation_reason?: string | null } | null | undefined>(
  freshRule: R,
  audit: CurrentRuleAuditRow | null,
): R {
  if (!freshRule) return freshRule
  if (!audit) return freshRule

  const approved = audit.approved_interpretation as { timing?: string; source_clause?: string | null } | null
  const confirmedValue = approved?.timing
  if (confirmedValue === undefined) return freshRule

  const freshIsUnclear = freshRule.timing === 'unclear'
  const freshMatchesConfirmed = freshRule.timing === confirmedValue

  if (freshIsUnclear || freshMatchesConfirmed) {
    return { ...freshRule, timing: confirmedValue, requires_confirmation: false, confirmation_reason: null } as R
  }

  return {
    ...freshRule,
    requires_confirmation: true,
    confirmation_reason: `Previously confirmed as "${confirmedValue}", but re-extraction now reads this contract as "${freshRule.timing}". Re-confirm to resolve the conflict.`,
  } as R
}

// ─────────────────────────────────────────────────────────────────────────
// Discount identity — replaces raw description-text matching
// (lib/rule-id-stability.ts's preserveStableRuleIds, still used unchanged
// for service_credits, which this pass does not touch) with a typed
// STRUCTURAL fingerprint, mirroring preserveTierIdentity's own doctrine
// exactly: identity is defined by the clause's structural/temporal shape,
// never by mutable presentation text (description) and never by the
// discount's own VALUE (discount_pct/discount_amount — like a tier's
// rate_per_unit, a value correction on re-extraction must not orphan
// identity). description drifting between extractions (LLM wording
// non-determinism, §11's explicit concern — this is the exact failure mode
// that orphaned a real discount's interpretation in the E3 acceptance
// pass) no longer breaks continuity.
function discountFingerprint(d: Pick<Discount, 'discount_type' | 'start_date' | 'end_date' | 'duration_months' | 'duration_days' | 'anchor' | 'billing_periods_count'>): string {
  return [
    d.discount_type,
    d.start_date ?? '',
    d.end_date ?? '',
    d.duration_months ?? '',
    d.duration_days ?? '',
    d.anchor ?? 'explicit_dates',
    d.billing_periods_count ?? '',
  ].join('|')
}

export function preserveDiscountIdentity(existingDiscounts: Discount[], freshDiscounts: Discount[]): Discount[] {
  const groupBy = (items: Discount[]): Map<string, Discount[]> => {
    const groups = new Map<string, Discount[]>()
    for (const item of items) {
      const fp = discountFingerprint(item)
      const g = groups.get(fp)
      if (g) g.push(item)
      else groups.set(fp, [item])
    }
    return groups
  }
  const existingGroups = groupBy(existingDiscounts)
  const freshGroups = groupBy(freshDiscounts)

  const existingIdCounts = new Map<string, number>()
  for (const d of existingDiscounts) {
    if (d.discount_rule_id) existingIdCounts.set(d.discount_rule_id, (existingIdCounts.get(d.discount_rule_id) ?? 0) + 1)
  }

  return freshDiscounts.map(fresh => {
    const fp = discountFingerprint(fresh)
    const existingGroup = existingGroups.get(fp) ?? []
    const freshGroup = freshGroups.get(fp) ?? [fresh]
    // Ambiguous in either direction (0, or >1 sharing the same structural
    // fingerprint) -> never reuse; the discount keeps whatever id it
    // already has (freshly assigned upstream by assignDiscountRuleIds) and
    // no interpretation — correctly re-entering review rather than
    // guessing which old discount it corresponds to.
    if (existingGroup.length !== 1 || freshGroup.length !== 1) return fresh

    const existing = existingGroup[0]
    const canReuseId = !!existing.discount_rule_id && (existingIdCounts.get(existing.discount_rule_id) ?? 0) === 1
    if (!canReuseId) return fresh

    return { ...fresh, discount_rule_id: existing.discount_rule_id, interpretation: existing.interpretation }
  })
}
