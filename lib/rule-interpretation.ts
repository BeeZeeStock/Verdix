// Pure logic for the in-panel AI-assisted rule-interpretation flow — builds
// the prompts sent to Claude and validates/parses its structured response.
// Zero React, zero supabaseServer import (same discipline as lib/tariff.ts),
// so this is directly unit-testable and shared between the interpret-rule
// API route and the review-panel UI (describeWhatWillChange in particular
// must never diverge between what the API reports and what the UI shows).

export type RuleType = 'minimum_commitment' | 'escalator' | 'partial_period' | 'discount' | 'tier_calculation'

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
  { id: 'not_applied', label: 'Do not apply escalation', description: 'Exclude the escalation clause entirely — no price increase.' },
  { id: 'other', label: 'Other / describe treatment', description: 'Tell Verdix how this should work in your own words.' },
]

// "Before/after usage tiers" only answers where a discount applies — it
// can't distinguish a staircase (each band applies only to units inside it)
// from a volume/all-units schedule (crossing a threshold re-rates every
// unit), and those two produce materially different invoice totals for the
// exact same rate table. tier_method is asked as its own question for
// precisely that reason — see lib/types.ts's DiscountInterpretation comment.
export const DISCOUNT_OPTIONS: StructuredOption[] = [
  { id: 'graduated', label: 'Graduated / staircase', description: 'Each tier applies only to units within that band.' },
  { id: 'volume', label: 'Volume / all-units', description: 'Total volume determines one rate/discount applied to all units.' },
  { id: 'block', label: 'Block-based', description: 'Reaching a band produces a fixed benefit or charge for that block.' },
  { id: 'other', label: 'Other / describe treatment', description: 'Tell Verdix how this should work in your own words.' },
]

// Same distinction as DISCOUNT_OPTIONS, applied to pricing tiers — the
// ambiguity is identical whether the tier table sets a price, a discount, or
// an overage rate, so it is asked the same way and never given a different
// implicit default depending on which one it happens to be.
export const TIER_CALCULATION_OPTIONS: StructuredOption[] = [
  { id: 'graduated', label: 'Graduated / staircase', description: 'Each tier applies only to units within that band.' },
  { id: 'volume', label: 'Volume / all-units', description: 'Total volume determines one rate applied to all billable units.' },
  { id: 'block', label: 'Block-based', description: 'Reaching a band charges a flat fee for that block, not a per-unit rate.' },
  { id: 'other', label: 'Other / describe treatment', description: 'Tell Verdix how this should work in your own words.' },
]

export function optionsForRuleType(ruleType: RuleType): StructuredOption[] {
  switch (ruleType) {
    case 'minimum_commitment': return MINIMUM_COMMITMENT_OPTIONS
    case 'partial_period': return PARTIAL_PERIOD_OPTIONS
    case 'escalator': return ESCALATOR_OPTIONS
    case 'discount': return DISCOUNT_OPTIONS
    case 'tier_calculation': return TIER_CALCULATION_OPTIONS
  }
}

// Reverse-maps a previously approved interpretation back to the structured
// option that produces it — used both to pre-select "Edit interpretation"'s
// form and to phrase edit-mode options relative to the current state (see
// optionsForEdit below). Best-effort only; a rule approved from free text
// alone that doesn't cleanly match a structured choice falls back to
// 'other' rather than guessing which option the reviewer "really meant".
export function deriveSelectedOption(ruleType: RuleType, approved: Record<string, unknown> | null | undefined): string | null {
  if (!approved) return null
  if (ruleType === 'minimum_commitment') {
    if (approved.mode === 'additive') return 'additive'
    if (approved.mode === 'floor' && approved.included_allowance_interaction === 'before_allowance') return 'floor_before_allowance'
    if (approved.mode === 'floor' && approved.included_allowance_interaction === 'after_allowance') return 'floor_after_allowance'
    return 'other'
  }
  if (ruleType === 'escalator') {
    if (approved.treatment === 'not_applied') return 'not_applied'
    if (approved.index === 'CPI' && approved.cap_pct != null) return 'cpi_capped'
    if (approved.index === 'CPI') return 'cpi_uncapped'
    if (approved.index === 'fixed_pct') return 'fixed_pct'
    return 'other'
  }
  if (ruleType === 'partial_period') {
    if (approved.prorate_partial_periods === false) return 'full'
    if (approved.prorate_partial_periods === true && approved.proration_method === 'days') return 'prorate_days'
    if (approved.prorate_partial_periods === true && approved.proration_method === 'months') return 'prorate_months'
    return 'other'
  }
  if (ruleType === 'discount') {
    if (approved.tier_method === 'graduated') return 'graduated'
    if (approved.tier_method === 'volume') return 'volume'
    if (approved.tier_method === 'block') return 'block'
    return 'other'
  }
  if (ruleType === 'tier_calculation') {
    if (approved.method === 'graduated') return 'graduated'
    if (approved.method === 'volume') return 'volume'
    if (approved.method === 'block') return 'block'
    return 'other'
  }
  return null
}

// Structured options, reworded relative to what's currently approved — the
// option matching today's interpretation reads "Keep as X" instead of just
// restating X as if it were a fresh, unbiased choice, and every other
// option reads "Change to Y" so the reviewer is choosing a *change*, not
// re-answering the original ambiguity from scratch. Same underlying option
// set per rule type (still not hardcoded globally — it already varies by
// rule type, current interpretation, and, via the label text itself, the
// source clause context shown alongside it in the drawer).
export function optionsForEdit(ruleType: RuleType, currentInterpretation: Record<string, unknown> | null): StructuredOption[] {
  const base = optionsForRuleType(ruleType)
  const currentOptionId = deriveSelectedOption(ruleType, currentInterpretation)
  return base.map(opt => {
    if (opt.id === 'other') return opt
    const lowerLabel = opt.label.charAt(0).toLowerCase() + opt.label.slice(1)
    return opt.id === currentOptionId
      ? { ...opt, label: `Keep as ${lowerLabel}` }
      : { ...opt, label: `Change to ${lowerLabel}` }
  })
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

export type DiscountContext = {
  sourceClause: string | null
  description: string
  currency: string
  existingPct: number | null
  existingAmount: number | null
  extractedType: string | null
  appliesTo: string | null
}

export type TierCalculationContext = {
  contractUnitType: string
  sourceClause: string | null
  currency: string
  tiers: Array<{ tier_label: string; from_unit: number | null; to_unit: number | null; rate_per_unit: number }>
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
  return `A SaaS contract has a price escalation clause whose treatment needs a human reviewer's interpretation.

Source clause: ${context.sourceClause ?? context.description}
Existing cap: ${context.capPct != null ? `${context.capPct}%` : 'none stated'}
Effective date: ${context.effectiveDate ?? context.appliesFromYear ?? 'unknown'}
${optionContext('escalator', selectedOption)}
Reviewer's instruction: "${reviewerInput}"

Translate the reviewer's instruction into a structured JSON object with EXACTLY these fields:
{
  "treatment": "applies" | "not_applied",
  "index": "CPI" | "fixed_pct" | "other" | null,
  "frequency": "annual" | "monthly" | "quarterly" | null,
  "effective_date": "<ISO date or null>",
  "cap_pct": <number or null>,
  "calculation_method": "<plain-English formula, or null>"
}

Rules:
- If the reviewer's instruction says to ignore, disregard, exclude, or not apply the escalation clause, set "treatment": "not_applied" and set index/frequency/calculation_method to null — do NOT invent placeholder values or try to describe the exclusion inside calculation_method.
- Otherwise set "treatment": "applies" and fill index/frequency/calculation_method with what the reviewer actually stated.
- Never invent a cap percentage or rate the reviewer didn't state — use null and describe it as uncapped/unknown in calculation_method instead.
- Respond with ONLY the JSON object, no other text.`
}

export function buildDiscountPrompt(
  context: DiscountContext,
  reviewerInput: string,
  selectedOption?: string,
): string {
  return `A SaaS contract has a discount clause whose structure needs a human reviewer's interpretation — specifically WHAT kind of discount this is and, if it has tiers or a volume threshold, HOW those tiers are actually evaluated (a staircase where each band only covers the units inside it is financially different from a volume schedule where crossing a threshold re-rates every unit, even for the identical rate table).

Source clause / description: ${context.sourceClause ?? context.description}
Extraction's own classification: ${context.extractedType ?? 'unknown'}
Extracted flat value: ${context.existingPct != null ? `${context.existingPct}%` : context.existingAmount != null ? `${context.existingAmount} ${context.currency}` : 'none (may be tiered and not yet captured as a single value)'}
Applies to (as extracted): ${context.appliesTo ?? 'unknown'}
${optionContext('discount', selectedOption)}
Reviewer's instruction: "${reviewerInput}"

Translate the reviewer's instruction into a structured JSON object with EXACTLY these fields:
{
  "discount_type": "flat_percentage" | "flat_amount" | "tiered_discount" | "volume_discount" | "component_specific" | "time_ramp" | "custom",
  "discount_basis": "percentage" | "amount",
  "tier_method": "graduated" | "volume" | "block" | "custom" | null,
  "tiers": [{"from_unit": <number|null>, "to_unit": <number|null>, "value": <number>}] | null,
  "applies_to": "<what this discount reduces, e.g. usage charge, base fee, or a named component>",
  "application_order": "<plain-English ordering relative to other pricing rules, e.g. 'after usage pricing'>",
  "reset_period": "monthly" | "quarterly" | "semi-annual" | "annual" | "contract_term" | "cumulative" | "custom" | null,
  "worked_example": "<a concrete numeric walkthrough at a sample quantity, e.g. 'At 150 units: first 100 at standard rate, next 50 at 10% off, using the graduated method the reviewer selected.'>"
}

Rules:
- discount_type "tiered_discount" or "volume_discount" requires tier_method and tiers to be filled in; a flat discount (flat_percentage/flat_amount) should set tier_method and tiers to null — do not invent tiers for a discount the reviewer described as flat.
- tier_method must reflect what the reviewer actually said (or the structured option they selected) — never default to "graduated" just because that's the more common case. If genuinely unclear whether it's graduated, volume, or block, omit tier_method entirely rather than guessing.
- worked_example must use the actual tiers/rate the reviewer stated (or, if no concrete numbers are available, describe the mechanism in concrete illustrative terms without inventing a specific contract quantity).
- Never invent a percentage, amount, or tier boundary the reviewer didn't state or that wasn't already in the extracted data above.
- Respond with ONLY the JSON object, no other text.`
}

export function buildTierCalculationPrompt(
  context: TierCalculationContext,
  reviewerInput: string,
  selectedOption?: string,
): string {
  const tierLines = context.tiers
    .map(t => `- ${t.tier_label}: ${t.from_unit ?? 1}–${t.to_unit ?? '∞'} @ ${t.rate_per_unit} ${context.currency}/unit`)
    .join('\n')
  return `A SaaS contract has a multi-tier price table for the "${context.contractUnitType}" metric whose calculation method (graduated vs. volume vs. block) a human reviewer is resolving. A rate table alone doesn't say how it's evaluated once usage spans more than one band — graduated (each band applies only to its own units) and volume (the whole quantity is re-rated once a threshold is reached) can produce materially different totals from the identical table.

Source clause: ${context.sourceClause ?? '(not captured)'}
Pricing tiers:
${tierLines || '(none)'}
${optionContext('tier_calculation', selectedOption)}
Reviewer's instruction: "${reviewerInput}"

Translate the reviewer's instruction into a structured JSON object with EXACTLY these fields:
{
  "method": "graduated" | "volume" | "block" | "custom",
  "calculation_summary": "<one-sentence plain-English description of the resulting calculation>",
  "worked_example": "<a concrete numeric walkthrough using the actual tier rates above, at a sample quantity spanning at least two tiers>"
}

Rules:
- method must reflect what the reviewer actually said (or the structured option they selected) — never default to "graduated" just because it's the more familiar convention.
- worked_example must use the actual tier boundaries/rates shown above, not invented numbers.
- Use ONLY what the reviewer's instruction and the source clause actually say. Never invent a value the reviewer didn't provide or imply.
- Respond with ONLY the JSON object, no other text.`
}

const REQUIRED_FIELDS: Record<RuleType, string[]> = {
  minimum_commitment: ['mode', 'amount', 'included_allowance_interaction'],
  partial_period: ['prorate_partial_periods'],
  escalator: ['treatment'],
  discount: ['discount_type', 'discount_basis', 'applies_to'],
  tier_calculation: ['method', 'calculation_summary'],
}

// Only a tiered/volume discount needs its tier structure spelled out — a
// flat discount has nothing to evaluate a band on, so asking for tier_method
// there would force a meaningless answer onto a rule that doesn't have one.
const DISCOUNT_TIERED_FIELDS = ['tier_method', 'tiers']

// Once treatment is known, 'applies' additionally requires these — a
// reviewer who explicitly excluded the clause shouldn't be asked to also
// invent an index/frequency for a rule that isn't running.
const ESCALATOR_APPLIES_FIELDS = ['index', 'frequency', 'calculation_method']

export type ParsedRuleResponse =
  | { ok: true; proposal: Record<string, unknown> }
  | { ok: false; missingFields: string[] }

// A live bug this caught: the model can respond with treatment:'applies'
// while calculation_method itself describes disregarding/excluding the
// clause — internally contradictory, and nothing about REQUIRED_FIELDS'
// presence-only check would notice. Scans for language that only makes
// sense if the clause is NOT running; if found alongside treatment:'applies',
// the response is rejected as if treatment were missing entirely, forcing
// the reviewer to clarify rather than silently confirming a contradiction.
const NOT_APPLIED_LANGUAGE = /\b(disregard|do not apply|does not apply|excluded?|unresolved|not been established|left undefined|leaving .* undefined)\b/i

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
  if (ruleType === 'escalator' && parsed.treatment === 'applies') {
    missing.push(...ESCALATOR_APPLIES_FIELDS.filter(f => parsed[f] == null))
    const calcMethod = typeof parsed.calculation_method === 'string' ? parsed.calculation_method : ''
    if (calcMethod && NOT_APPLIED_LANGUAGE.test(calcMethod) && !missing.includes('treatment')) {
      missing.push('treatment')
    }
  }
  if (ruleType === 'discount' && (parsed.discount_type === 'tiered_discount' || parsed.discount_type === 'volume_discount')) {
    missing.push(...DISCOUNT_TIERED_FIELDS.filter(f => parsed[f] == null))
  }
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
  treatment: 'Should this escalation clause actually apply, or should it be excluded entirely?',
  index: 'Is this escalator tied to an index (like CPI) or a fixed percentage?',
  frequency: 'How often does the escalation apply — annually, quarterly, monthly?',
  calculation_method: 'What is the exact formula or method used to calculate the increase?',
  discount_type: 'Is this a flat discount, a tiered/volume discount, or something else (component-specific, a time-limited ramp)?',
  discount_basis: 'Is the discount a percentage off or a flat amount off?',
  applies_to: 'What does this discount actually reduce — the usage charge, the base fee, or a specific component?',
  tier_method: 'Should each tier apply only to the units within it (graduated/staircase), or does reaching a threshold apply one rate to all units (volume)?',
  tiers: 'What are the tier boundaries and their discount values?',
  method: 'Should each tier apply only to the units within it (graduated/staircase), does reaching a threshold apply one rate to all units (volume), or does each band charge a flat fee (block)?',
  calculation_summary: 'What is the resulting calculation, in plain English?',
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
  } else if (ruleType === 'discount') {
    items.push(
      { component: 'Billing Configuration', change: 'Update the discount rule and its tier structure' },
      { component: 'Billing Engine', change: 'Apply the confirmed tier method (graduated/volume/block) when calculating the discount' },
      { component: 'Billing Schedule', change: 'Reflect the confirmed discount in upcoming invoices' },
    )
  } else if (ruleType === 'tier_calculation') {
    items.push(
      { component: 'Billing Configuration', change: `Set the confirmed calculation method on the ${contractUnitType ?? 'metric'} price table` },
      { component: 'Billing Engine', change: 'Apply the confirmed graduated/volume/block method when calculating usage charges' },
      { component: 'Billing Schedule', change: 'Reflect the confirmed calculation in upcoming usage periods' },
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
