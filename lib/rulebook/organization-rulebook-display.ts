// Organization Rulebook — shared, pure display formatting (Step 5D). No
// database, no React — safe to import from both a server route and a
// 'use client' component. Centralizes "how do we describe a structured
// rule to a human" so the management page (Settings -> Organization
// Rulebook), the promotion preview, and the contract review's "View
// policy" panel never drift into three different phrasings for the same
// underlying data. Never renders raw JSON as the primary text — see each
// function's own docstring for what it produces instead.
import type { MatchCondition } from './organization-rules'

export function humanizeSnakeCase(value: string): string {
  return value.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

// The ONLY target field Step 5D's UI needs to describe — Verdix Global
// defaults and other allowlisted-for-matching fields stay shadow-only (see
// organization-rulebook-production.ts's PRODUCTION_ORGANIZATION_RULEBOOK_
// ALLOWLIST) and are not surfaced through the promotion flow, though the
// management page may still list a rule targeting one of them (created
// directly, outside Step 5D's promotion path) — falls back to a readable
// version of the raw dotted path for anything else, never a blank label.
export function describeTargetField(field: string): string {
  if (field === 'survival.carry_forward') return 'Unused-balance carry-forward'
  if (field === 'survival.one_time') return 'Repeatability (one-time vs. recurring)'
  if (field === 'application.timing') return 'Application timing'
  if (field === 'application.eligible_component_keys') return 'Eligible components'
  if (field === 'cash_redeemable') return 'Cash redeemability'
  return humanizeSnakeCase(field.replace(/\./g, ' — '))
}

// The human-readable TREATMENT a rule's value represents — deliberately
// keyed off target_field, since the same raw boolean means something
// different depending on what it targets (mirrors describeSurvivalResolution
// in app/(dashboard)/configure/[id]/page.tsx for the one field both already
// describe, so the two surfaces never say it differently).
export function describeTreatment(targetField: string, value: unknown): string {
  if (targetField === 'survival.carry_forward') {
    return value === true ? 'Carry forward until fully used'
      : value === false ? 'Does not carry forward past the period earned'
      : String(value)
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function describeMatchFieldLabel(field: string): string {
  if (field === 'rule_type') return 'Rule type'
  if (field === 'application.timing') return 'Application timing'
  if (field === 'application.eligible_component_keys') return 'Eligible components'
  if (field === 'survival.carry_forward') return 'Carry-forward treatment'
  if (field === 'survival.one_time') return 'Repeatability'
  if (field === 'cash_redeemable') return 'Cash redeemability'
  return humanizeSnakeCase(field.replace(/\./g, ' — '))
}

function describeMatchValue(field: string, value: unknown): string {
  // rule_type values are the same vocabulary contract_terms.service_
  // credits[].credit_type uses (service_credit/rebate/conditional_credit/
  // other) — humanized the same way describeTargetField's own fallback does.
  if (typeof value === 'string') {
    if (field === 'application.timing' && value === 'next_invoice') return 'Next invoice'
    return humanizeSnakeCase(value)
  }
  if (Array.isArray(value)) return value.map(v => humanizeSnakeCase(String(v))).join(', ')
  return String(value)
}

// One line per condition, e.g. "Rule type = Service Credit" — the "Applies
// when" block in the promotion preview (item 5) and the management page's
// scope column. Structured conditions remain the source of truth (never a
// natural-language rule stored for AI interpretation, per item 4) — this
// is purely a read-only rendering of them.
export function describeMatchCondition(condition: MatchCondition): string {
  const fieldLabel = describeMatchFieldLabel(condition.field)
  if (condition.operator === 'exists') return `${fieldLabel} is set`
  if (condition.operator === 'in') return `${fieldLabel} in [${describeMatchValue(condition.field, condition.value)}]`
  return `${fieldLabel} = ${describeMatchValue(condition.field, condition.value)}`
}

export function describeMatchConditions(conditions: MatchCondition[]): string[] {
  return conditions.map(describeMatchCondition)
}

// Effective-period phrasing shared by the management page and the "View
// policy" panel — a plain, unambiguous human sentence rather than raw ISO
// timestamps as the primary reading (a details disclosure may still show
// them for auditability, per item 1).
export function describeEffectivePeriod(effectiveFrom: string | null, effectiveTo: string | null): string {
  const from = effectiveFrom ? new Date(effectiveFrom).toLocaleDateString() : null
  const to = effectiveTo ? new Date(effectiveTo).toLocaleDateString() : null
  if (from && to) return `${from} – ${to}`
  if (from) return `From ${from}`
  if (to) return `Until ${to}`
  return 'Not yet effective'
}

export function describeSourceKind(sourceKind: string): string {
  if (sourceKind === 'manual') return 'Created manually'
  if (sourceKind === 'reviewer_promotion') return 'Promoted from reviewer decision'
  if (sourceKind === 'verdix_pattern_suggestion') return 'Suggested by Verdix'
  return humanizeSnakeCase(sourceKind)
}

// Item 1's five display groups. 'active' rows are further split into
// "Active" (already in effect: effective_from is null or <= asOf) and
// "Future" (effective_from is set and in the future) — the database
// status is 'active' for both, but a reviewer needs to see "this doesn't
// apply yet" distinctly from "this is resolving contracts right now".
export type RulebookDisplayGroup = 'active' | 'future' | 'draft' | 'superseded' | 'disabled'

export function groupForDisplay(
  rule: { status: string; effectiveFrom: string | null },
  asOf: Date = new Date(),
): RulebookDisplayGroup {
  if (rule.status === 'active') {
    if (rule.effectiveFrom && new Date(rule.effectiveFrom) > asOf) return 'future'
    return 'active'
  }
  if (rule.status === 'draft') return 'draft'
  if (rule.status === 'superseded') return 'superseded'
  return 'disabled'
}
