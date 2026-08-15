// Pure logic for the in-panel AI-assisted rule-interpretation flow — builds
// the prompts sent to Claude and validates/parses its structured response.
// Zero React, zero supabaseServer import (same discipline as lib/tariff.ts),
// so this is directly unit-testable and shared between the interpret-rule
// API route and the review-panel UI (describeWhatWillChange in particular
// must never diverge between what the API reports and what the UI shows).

export type RuleType = 'minimum_commitment' | 'escalator' | 'partial_period'

export type StructuredOption = {
  id: string
  label: string
  description: string
}

// Structured choices come first, free text is always available alongside
// them (not gated behind "Other") — per the explicit product direction that
// free text alone shouldn't be the only path to resolving an ambiguity.
export const MINIMUM_COMMITMENT_OPTIONS: StructuredOption[] = [
  { id: 'floor_after_allowance', label: 'Minimum charge floor', description: 'Apply the included allowance first, then charge the greater of the calculated usage charge or the minimum.' },
  { id: 'floor_before_allowance', label: 'Minimum applies before allowance', description: 'The minimum covers all usage, including units that would otherwise be included free.' },
  { id: 'additive', label: 'Additive fee', description: 'Charge the minimum in addition to the calculated usage charge, regardless of amount.' },
  { id: 'other', label: 'Other / describe treatment', description: 'Tell Verdix how this should work in your own words.' },
]

export const PARTIAL_PERIOD_OPTIONS: StructuredOption[] = [
  { id: 'full', label: 'Full quarterly minimum applies', description: 'Charge the full minimum even for a partial period.' },
  { id: 'prorate_days', label: 'Prorate by days', description: 'Reduce the minimum in proportion to the days actually covered.' },
  { id: 'prorate_months', label: 'Prorate by months', description: 'Reduce the minimum in proportion to the months actually covered.' },
  { id: 'none', label: 'No minimum for partial period', description: "Waive the minimum entirely for a period the contract wasn't in effect for the whole of." },
  { id: 'other', label: 'Other / describe treatment', description: 'Tell Verdix how this should work in your own words.' },
]

export const ESCALATOR_OPTIONS: StructuredOption[] = [
  { id: 'cpi_capped', label: 'CPI-linked, capped', description: 'Annual increase tracks CPI, capped at a maximum percentage.' },
  { id: 'cpi_uncapped', label: 'CPI-linked, uncapped', description: 'Annual increase tracks CPI with no maximum.' },
  { id: 'fixed_pct', label: 'Fixed percentage', description: 'A stated fixed percentage increase, not index-linked.' },
  { id: 'other', label: 'Other / describe treatment', description: 'Tell Verdix how this should work in your own words.' },
]

export function optionsForRuleType(ruleType: RuleType): StructuredOption[] {
  switch (ruleType) {
    case 'minimum_commitment': return MINIMUM_COMMITMENT_OPTIONS
    case 'partial_period': return PARTIAL_PERIOD_OPTIONS
    case 'escalator': return ESCALATOR_OPTIONS
  }
}

export type MinimumCommitmentContext = {
  contractUnitType: string
  sourceClause: string | null
  currency: string
  includedUnits: number
  tiers: Array<{ tier_label: string; from_unit: number | null; to_unit: number | null; rate_per_unit: number }>
  existingMinimumAmount: number | null
  measurementPeriod: string | null
}

export type PartialPeriodContext = {
  contractUnitType: string
  sourceClause: string | null
  currency: string
  contractStartDate: string | null
  contractEndDate: string | null
  measurementPeriod: string | null
  minimumAmount: number | null
}

export type EscalatorContext = {
  sourceClause: string | null
  description: string
  capPct: number | null
  effectiveDate: string | null
  appliesFromYear: number | null
}

function optionContext(ruleType: RuleType, selectedOption?: string): string {
  if (!selectedOption || selectedOption === 'other') return ''
  const opt = optionsForRuleType(ruleType).find(o => o.id === selectedOption)
  if (!opt) return ''
  return `\nThe reviewer selected the structured option "${opt.label}": ${opt.description}`
}

export function buildMinimumCommitmentPrompt(
  context: MinimumCommitmentContext,
  reviewerInput: string,
  selectedOption?: string,
): string {
  const tierLines = context.tiers
    .map(t => `- ${t.tier_label}: ${t.from_unit ?? 1}–${t.to_unit ?? '∞'} @ ${t.rate_per_unit} ${context.currency}/unit`)
    .join('\n')
  return `A SaaS contract has an ambiguous minimum-commitment clause for the "${context.contractUnitType}" metric that a human reviewer is resolving.

Source clause: ${context.sourceClause ?? '(not captured)'}
Included allowance: ${context.includedUnits} units
Existing stated minimum: ${context.existingMinimumAmount != null ? `${context.existingMinimumAmount} ${context.currency}` : 'unknown'} per ${context.measurementPeriod ?? 'period'}
Pricing tiers:
${tierLines || '(none)'}
${optionContext('minimum_commitment', selectedOption)}
Reviewer's instruction: "${reviewerInput}"

Translate the reviewer's instruction into a structured JSON object with EXACTLY these fields:
{
  "mode": "floor" | "additive" | "minimum_spend" | "prepaid_commitment" | "minimum_quantity",
  "amount": <number>,
  "period": "monthly" | "quarterly" | "semi-annual" | "annual" | null,
  "included_allowance_interaction": "before_allowance" | "after_allowance",
  "prorate_partial_periods": true | false | "unclear",
  "calculation_summary": "<one-sentence plain-English description of the resulting calculation, e.g. 'max(tiered usage charge, 5000)'>"
}

Rules:
- Use ONLY what the reviewer's instruction and the source clause actually say. Never invent a value the reviewer didn't provide or imply.
- If the reviewer's instruction doesn't specify a required field clearly enough to be confident, omit that field entirely rather than guessing — do not fabricate a default.
- Respond with ONLY the JSON object, no other text.`
}

export function buildPartialPeriodPrompt(
  context: PartialPeriodContext,
  reviewerInput: string,
  selectedOption?: string,
): string {
  return `A SaaS contract runs from ${context.contractStartDate ?? 'unknown'} to ${context.contractEndDate ?? 'unknown'}, but the "${context.contractUnitType}" metric's minimum commitment resets on calendar-quarter boundaries stated in the contract, creating a partial first and/or final quarter. A human reviewer is resolving how the ${context.minimumAmount != null ? `${context.minimumAmount} ${context.currency}` : ''} minimum should apply to a period the contract wasn't in effect for the whole of.

Source clause: ${context.sourceClause ?? '(not captured)'}
${optionContext('partial_period', selectedOption)}
Reviewer's instruction: "${reviewerInput}"

Translate the reviewer's instruction into a structured JSON object with EXACTLY these fields:
{
  "prorate_partial_periods": true | false,
  "proration_method": "days" | "months" | "none" | null,
  "calculation_summary": "<one-sentence plain-English description>"
}

Rules:
- Use ONLY what the reviewer's instruction and the source clause actually say. Never invent a proration method the reviewer didn't specify.
- If unclear, omit the field rather than guessing.
- Respond with ONLY the JSON object, no other text.`
}

export function buildEscalatorPrompt(
  context: EscalatorContext,
  reviewerInput: string,
  selectedOption?: string,
): string {
  return `A SaaS contract has a price escalation clause whose exact calculation needs a human reviewer's interpretation.

Source clause: ${context.sourceClause ?? context.description}
Existing cap: ${context.capPct != null ? `${context.capPct}%` : 'none stated'}
Effective date: ${context.effectiveDate ?? context.appliesFromYear ?? 'unknown'}
${optionContext('escalator', selectedOption)}
Reviewer's instruction: "${reviewerInput}"

Translate the reviewer's instruction into a structured JSON object with EXACTLY these fields:
{
  "index": "CPI" | "fixed_pct" | "other",
  "frequency": "annual" | "monthly" | "quarterly",
  "effective_date": "<ISO date or null>",
  "cap_pct": <number or null>,
  "calculation_method": "<plain-English formula>"
}

Rules:
- Never invent a cap percentage or rate the reviewer didn't state — use null and describe it as uncapped/unknown in calculation_method instead.
- Respond with ONLY the JSON object, no other text.`
}

const REQUIRED_FIELDS: Record<RuleType, string[]> = {
  minimum_commitment: ['mode', 'amount', 'included_allowance_interaction'],
  partial_period: ['prorate_partial_periods'],
  escalator: ['index', 'frequency', 'calculation_method'],
}

export type ParsedRuleResponse =
  | { ok: true; proposal: Record<string, unknown> }
  | { ok: false; missingFields: string[] }

// Validates Claude's JSON response has every field this rule type needs to
// be actionable — never lets a partially-fabricated or incomplete object
// through as if it were a complete proposal. A field genuinely absent from
// the model's response (rather than present-but-null) is treated the same
// as "the model wasn't confident enough to state it" — both count as
// missing, never silently defaulted.
export function parseRuleInterpretationResponse(ruleType: RuleType, rawText: string): ParsedRuleResponse {
  const jsonMatch = rawText.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return { ok: false, missingFields: REQUIRED_FIELDS[ruleType] }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>
  } catch {
    return { ok: false, missingFields: REQUIRED_FIELDS[ruleType] }
  }
  const missing = REQUIRED_FIELDS[ruleType].filter(f => parsed[f] == null)
  if (missing.length > 0) return { ok: false, missingFields: missing }
  return { ok: true, proposal: parsed }
}

// Human-readable question for each field the AI couldn't confidently
// resolve — surfaced to the reviewer as "Verdix needs more detail" instead
// of a generic failure, asking for exactly the missing piece.
const MISSING_FIELD_QUESTIONS: Record<string, string> = {
  mode: 'How should the minimum be charged — as a floor, an additional fee, or something else?',
  amount: 'What is the minimum amount?',
  included_allowance_interaction: 'Should the minimum apply before or after the included allowance?',
  prorate_partial_periods: 'Should the minimum be prorated for a partial period, or applied in full?',
  index: 'Is this escalator tied to an index (like CPI) or a fixed percentage?',
  frequency: 'How often does the escalation apply — annually, quarterly, monthly?',
  calculation_method: 'What is the exact formula or method used to calculate the increase?',
}

export function describeMissingFieldQuestions(missingFields: string[]): string[] {
  return missingFields.map(f => MISSING_FIELD_QUESTIONS[f] ?? `What is "${f}"?`)
}

export type DependencyState = { meterMappingConfirmed: boolean; meterKey?: string | null }

// The "What will change" list shown before approval — built once and reused
// by both the API response and the UI so the two can never disagree about
// what's about to happen. This is the trust moment: the reviewer sees every
// downstream component about to change before making the one approval
// decision that changes all of them.
export function describeWhatWillChange(
  ruleType: RuleType,
  contractUnitType: string | null,
  dependency?: DependencyState,
): Array<{ component: string; change: string }> {
  const items: Array<{ component: string; change: string }> = [
    { component: 'Commercial Terms', change: 'Add confirmed rule to the Commercial Terms view' },
  ]
  if (ruleType === 'minimum_commitment' || ruleType === 'partial_period') {
    items.push(
      { component: 'Billing Configuration', change: `Add the confirmed minimum to the ${contractUnitType ?? 'metric'} component` },
      { component: 'Billing Engine', change: 'Apply the confirmed minimum after tier calculation' },
      { component: 'Billing Schedule', change: 'Reflect the confirmed treatment in upcoming usage periods' },
    )
  } else {
    items.push(
      { component: 'Billing Configuration', change: "Update the escalator's calculation method" },
      { component: 'Billing Engine', change: 'Apply the confirmed escalation formula to future periods' },
      { component: 'Billing Schedule', change: 'Reflect the new rate from its effective date' },
    )
  }
  if (dependency && !dependency.meterMappingConfirmed) {
    items.push({
      component: 'Usage Source',
      change: `${contractUnitType ?? 'This metric'}'s usage source must be confirmed before this rule can calculate an invoice amount.`,
    })
  }
  return items
}
