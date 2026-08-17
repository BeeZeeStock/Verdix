// Pure logic for the in-panel AI-assisted rule-interpretation flow — builds
// the prompts sent to Claude and validates/parses its structured response.
// Zero React, zero supabaseServer import (same discipline as lib/tariff.ts),
// so this is directly unit-testable and shared between the interpret-rule
// API route and the review-panel UI (describeWhatWillChange in particular
// must never diverge between what the API reports and what the UI shows).

export type RuleType = 'minimum_commitment' | 'escalator' | 'partial_period' | 'discount' | 'tier_calculation' | 'service_credit' | 'rule_interaction'

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

// A function, not a static array — "Full quarterly minimum applies" must
// reflect the metric's actual cadence (monthly/quarterly/annual), never
// hardcode "quarterly" for a monthly or annual rule. cadenceNoun defaults to
// 'period' when the caller doesn't have a specific cadence to hand (e.g. a
// generic/no-context call site), which reads correctly on its own.
export function getPartialPeriodOptions(cadenceLabel: string = 'period'): StructuredOption[] {
  return [
    { id: 'full', label: `Full ${cadenceLabel} minimum applies`, description: 'Charge the full minimum even for a partial period.' },
    { id: 'prorate_days', label: 'Prorate by days', description: 'Reduce the minimum in proportion to the days actually covered.' },
    { id: 'prorate_months', label: 'Prorate by months', description: 'Reduce the minimum in proportion to the months actually covered.' },
    { id: 'none', label: 'No minimum for partial period', description: "Waive the minimum entirely for a period the contract wasn't in effect for the whole of." },
    { id: 'other', label: 'Other / describe treatment', description: 'Tell Verdix how this should work in your own words.' },
  ]
}

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

// What the credit's percentage/amount is actually computed FROM — the
// central ambiguity for any conditional credit clause (SLA/rebate/
// promotional/earned/usage/capped), same "resolve the basis explicitly,
// never assume" principle as DISCOUNT_OPTIONS' tier_method.
export const SERVICE_CREDIT_OPTIONS: StructuredOption[] = [
  { id: 'pct_of_period_fee', label: '% of that period’s recurring fee', description: 'The credit is a percentage of the subscription/platform fee actually charged for the affected period.' },
  { id: 'pct_of_affected_component', label: '% of a specific component', description: 'The credit is a percentage of one named component (e.g. only the usage charge), not the whole invoice.' },
  { id: 'flat_amount', label: 'Flat amount', description: 'The credit is a fixed currency amount, not a percentage.' },
  { id: 'usage_units', label: 'Usage units', description: 'The credit is expressed in usage units (e.g. free requests), not currency.' },
  { id: 'other', label: 'Other / describe treatment', description: 'Tell Verdix how this should work in your own words.' },
]

// What the two overlapping rules should actually do about the fee component
// they both reference — deliberately narrower than a full re-derivation of
// either rule, since the interaction review only ever resolves the ordering
// question, not the rules themselves (those are each confirmed separately).
export const RULE_INTERACTION_OPTIONS: StructuredOption[] = [
  { id: 'pre_other_rule_basis', label: 'Use the fee before the other rule applies', description: 'Compute this rule off the standard/undiscounted fee, ignoring the other rule’s effect for this purpose.' },
  { id: 'post_other_rule_basis', label: 'Use the fee after the other rule applies', description: 'Compute this rule off the fee as already reduced/increased by the other rule.' },
  { id: 'independent_no_overlap', label: 'No real overlap', description: 'The two rules don’t actually share a basis once examined — both apply independently, unchanged.' },
  { id: 'other', label: 'Other / describe treatment', description: 'Tell Verdix how this should work in your own words.' },
]

export function optionsForRuleType(ruleType: RuleType, cadenceLabel?: string): StructuredOption[] {
  switch (ruleType) {
    case 'minimum_commitment': return MINIMUM_COMMITMENT_OPTIONS
    case 'partial_period': return getPartialPeriodOptions(cadenceLabel)
    case 'escalator': return ESCALATOR_OPTIONS
    case 'discount': return DISCOUNT_OPTIONS
    case 'tier_calculation': return TIER_CALCULATION_OPTIONS
    case 'service_credit': return SERVICE_CREDIT_OPTIONS
    case 'rule_interaction': return RULE_INTERACTION_OPTIONS
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
  if (ruleType === 'service_credit') {
    if (approved.credit_basis === 'pct_of_period_fee') return 'pct_of_period_fee'
    if (approved.credit_basis === 'pct_of_affected_component') return 'pct_of_affected_component'
    if (approved.credit_basis === 'flat_amount') return 'flat_amount'
    if (approved.credit_basis === 'usage_units') return 'usage_units'
    return 'other'
  }
  if (ruleType === 'rule_interaction') {
    if (approved.resolution === 'pre_other_rule_basis') return 'pre_other_rule_basis'
    if (approved.resolution === 'post_other_rule_basis') return 'post_other_rule_basis'
    if (approved.resolution === 'independent_no_overlap') return 'independent_no_overlap'
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
export function optionsForEdit(ruleType: RuleType, currentInterpretation: Record<string, unknown> | null, cadenceLabel?: string): StructuredOption[] {
  const base = optionsForRuleType(ruleType, cadenceLabel)
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

export type ServiceCreditContext = {
  sourceClause: string | null
  description: string
  creditType: string
  statedPct: number | null
  statedAmount: number | null
  currency: string
}

export type RuleInteractionContext = {
  creditDescription: string
  creditBasisComponent: string | null
  otherRuleType: 'discount' | 'escalator'
  otherRuleDescription: string
  overlapReason: string
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
  "index_name": "<the index exactly as named in the contract, e.g. 'HICP' — never generalize a named index to 'CPI'>",
  "frequency": "annual" | "monthly" | "quarterly" | null,
  "effective_date": "<ISO date or null>",
  "cap_pct": <number or null>,
  "calculation_method": "<plain-English formula, or null>",
  "discretion": "automatic" | "requires_renewal_approval" | "not_exercised",
  "renewal_triggered": <true|false>
}

Rules:
- If the reviewer's instruction says to ignore, disregard, exclude, or not apply the escalation clause, set "treatment": "not_applied" and set index/index_name/frequency/calculation_method to null — do NOT invent placeholder values or try to describe the exclusion inside calculation_method.
- Otherwise set "treatment": "applies" and fill index/index_name/frequency/calculation_method with what the reviewer actually stated.
- index_name must preserve the contract's own term (e.g. "HICP", "RPI") verbatim — never substitute "CPI" for a different named index. index is a separate, coarser internal classification field; set it to "other" for any named index that isn't literally "CPI".
- discretion: "automatic" only if the reviewer's instruction (or the source clause) states the increase applies without a separate decision each time. "requires_renewal_approval" if the clause uses discretionary language ("may be increased") or the reviewer says it needs approval at renewal. "not_exercised" if the reviewer is explicitly declining to apply a discretionary clause for now.
- renewal_triggered: true only when the increase is tied to renewal specifically (e.g. "on renewal, the fee may be increased by...") rather than an ordinary annual escalator recurring during the original term.
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

export function buildServiceCreditPrompt(
  context: ServiceCreditContext,
  reviewerInput: string,
  selectedOption?: string,
): string {
  return `A SaaS contract has a service-credit clause (SLA/availability credit, rebate, promotional credit, earned/usage credit) whose calculation basis a human reviewer is resolving — specifically WHAT the stated percentage/amount is computed FROM, and how it settles.

Source clause / description: ${context.sourceClause ?? context.description}
Extraction's own classification: ${context.creditType}
Stated value: ${context.statedPct != null ? `${context.statedPct}%` : context.statedAmount != null ? `${context.statedAmount} ${context.currency}` : 'not captured as a single value'}
${optionContext('service_credit', selectedOption)}
Reviewer's instruction: "${reviewerInput}"

Translate the reviewer's instruction into a structured JSON object with EXACTLY these fields:
{
  "trigger_type": "sla_breach" | "usage_threshold" | "promotional" | "earned_milestone" | "other",
  "trigger_description": "<plain-English condition that triggers the credit>",
  "credit_basis": "pct_of_period_fee" | "pct_of_affected_component" | "flat_amount" | "usage_units",
  "basis_component": "<what the value is computed from, e.g. 'subscription_fee', 'invoice_total', or a named component>",
  "credit_value": <number>,
  "cap_amount": <number or null>,
  "cap_pct": <number or null>,
  "settlement_period": "monthly" | "quarterly" | "semi-annual" | "annual" | "per_incident" | null,
  "cash_redeemable": true | false,
  "calculation_summary": "<one-sentence plain-English description of the resulting calculation>"
}

Rules:
- basis_component is the central ambiguity — if the reviewer's instruction doesn't specify what the percentage is computed from, omit basis_component and credit_basis rather than guessing (e.g. do not assume it's computed on the standard/undiscounted fee if the reviewer didn't say so).
- cash_redeemable defaults to false unless the reviewer's instruction or the source clause explicitly says the customer may request a cash refund rather than a credit against future invoices.
- Never invent a percentage, amount, or cap the reviewer didn't state or that wasn't already in the extracted data above.
- Respond with ONLY the JSON object, no other text.`
}

export function buildRuleInteractionPrompt(
  context: RuleInteractionContext,
  reviewerInput: string,
  selectedOption?: string,
): string {
  return `A SaaS contract has two commercial rules that both appear to reference the same fee component, and a human reviewer is resolving how they interact.

Service credit: ${context.creditDescription}${context.creditBasisComponent ? ` (basis: ${context.creditBasisComponent})` : ''}
Other rule (${context.otherRuleType}): ${context.otherRuleDescription}
Why these were flagged together: ${context.overlapReason}
${optionContext('rule_interaction', selectedOption)}
Reviewer's instruction: "${reviewerInput}"

Translate the reviewer's instruction into a structured JSON object with EXACTLY these fields:
{
  "resolution": "pre_other_rule_basis" | "post_other_rule_basis" | "independent_no_overlap" | "other",
  "note": "<one-sentence plain-English statement of the resolved basis, written to stand alone on the service credit's own record>"
}

Rules:
- Use ONLY what the reviewer's instruction actually says. Never invent a resolution the reviewer didn't state.
- If the reviewer's instruction doesn't clearly pick one of the three structured resolutions, set resolution to "other" and capture their actual instruction in note.
- Respond with ONLY the JSON object, no other text.`
}

const REQUIRED_FIELDS: Record<RuleType, string[]> = {
  minimum_commitment: ['mode', 'amount', 'included_allowance_interaction'],
  partial_period: ['prorate_partial_periods'],
  escalator: ['treatment'],
  discount: ['discount_type', 'discount_basis', 'applies_to'],
  tier_calculation: ['method', 'calculation_summary'],
  service_credit: ['trigger_type', 'credit_basis', 'basis_component'],
  rule_interaction: ['resolution', 'note'],
}

// Only a tiered/volume discount needs its tier structure spelled out — a
// flat discount has nothing to evaluate a band on, so asking for tier_method
// there would force a meaningless answer onto a rule that doesn't have one.
const DISCOUNT_TIERED_FIELDS = ['tier_method', 'tiers']

// Once treatment is known, 'applies' additionally requires these — a
// reviewer who explicitly excluded the clause shouldn't be asked to also
// invent an index/frequency for a rule that isn't running. discretion is
// required so a discretionary ("may be increased") clause can never fall
// through to the calculation engine's 'automatic' default by omission.
const ESCALATOR_APPLIES_FIELDS = ['index', 'frequency', 'calculation_method', 'discretion']

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
    // index_name is only meaningful when there's an index to name — a
    // fixed-percentage escalator has nothing to call "HICP"/"CPI".
    if (parsed.index !== 'fixed_pct' && parsed.index_name == null) missing.push('index_name')
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
  index_name: 'What is the index actually called in the contract (e.g. HICP, RPI, CPI)?',
  frequency: 'How often does the escalation apply — annually, quarterly, monthly?',
  calculation_method: 'What is the exact formula or method used to calculate the increase?',
  discretion: 'Does this increase apply automatically, or does it require approval each time (e.g. at renewal)?',
  discount_type: 'Is this a flat discount, a tiered/volume discount, or something else (component-specific, a time-limited ramp)?',
  discount_basis: 'Is the discount a percentage off or a flat amount off?',
  applies_to: 'What does this discount actually reduce — the usage charge, the base fee, or a specific component?',
  tier_method: 'Should each tier apply only to the units within it (graduated/staircase), or does reaching a threshold apply one rate to all units (volume)?',
  tiers: 'What are the tier boundaries and their discount values?',
  method: 'Should each tier apply only to the units within it (graduated/staircase), does reaching a threshold apply one rate to all units (volume), or does each band charge a flat fee (block)?',
  calculation_summary: 'What is the resulting calculation, in plain English?',
  trigger_type: 'What kind of credit is this — an SLA/availability credit, a rebate, a promotional credit, or something else?',
  credit_basis: 'What is the credit a percentage or amount OF — a period fee, a specific component, a flat amount, or usage units?',
  basis_component: 'Which specific fee or component is the credit calculated from?',
  resolution: 'Should the fee be computed before or after the other rule applies, or do these two rules not actually overlap?',
  note: 'How should this be described on the service credit’s own record?',
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
  const items: Array<{ component: string; change: string }> = ruleType === 'rule_interaction'
    ? []
    : [{ component: 'Commercial Terms', change: 'Add confirmed rule to the Commercial Terms view' }]
  // Whether this rule type feeds the shared contract-value model
  // (lib/contract-value.ts) — every rule that can change fixed fees or
  // minimum-commitment totals must show these two surfaces, per the "no
  // screen reports a different committed contract value than another"
  // requirement; a reviewer approving a change should see everywhere it
  // could move a number, not just the billing-execution surfaces.
  const affectsContractValue = ruleType === 'minimum_commitment' || ruleType === 'partial_period' || ruleType === 'discount' || ruleType === 'service_credit'
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
  } else if (ruleType === 'service_credit') {
    items.push(
      { component: 'Billing Configuration', change: 'Add the confirmed service credit and its calculation basis' },
      { component: 'Billing Engine', change: 'Apply the confirmed credit against qualifying invoices' },
      { component: 'Billing Schedule', change: 'Reflect the credit on the next qualifying settlement period' },
    )
  } else if (ruleType === 'rule_interaction') {
    items.push(
      { component: 'Commercial Terms', change: "Record the resolved basis on the service credit's own interpretation" },
      { component: 'Billing Engine', change: 'Use the resolved basis when calculating the credit against overlapping periods' },
    )
  } else {
    items.push(
      { component: 'Billing Configuration', change: "Update the escalator's calculation method" },
      { component: 'Billing Engine', change: 'Apply the confirmed escalation formula to future periods' },
      { component: 'Billing Schedule', change: 'Reflect the new rate from its effective date' },
    )
  }
  if (affectsContractValue) {
    items.push(
      { component: 'Contract Value', change: 'Recompute committed/projected contract value from the confirmed rule' },
      { component: 'Graphical View', change: 'Reflect the confirmed rule in the Graphical View scenario model' },
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

// ══════════════════════════════════════════════════════════════════════════
// The "propose" pipeline — Verdix interprets FIRST, the human confirms.
//
// Everything above this line answers "translate what the reviewer already
// told you into structured JSON" — it never runs until a reviewer has typed
// something or picked an option. The functions below answer a genuinely
// different question, asked BEFORE any reviewer input exists: "given only
// the source clause and the surrounding contract, what does Verdix itself
// think this rule should be, how confident is that, and why?" The two
// pipelines share the same structured-field vocabulary per rule type (a
// proposal's `proposed_interpretation` has the exact same shape as what
// buildXPrompt above would have produced) so confirm-rule never needs to
// know which pipeline produced the interpretation it's persisting.
// ══════════════════════════════════════════════════════════════════════════

export type ProposalState = 'clear_from_source' | 'verdix_recommends' | 'decision_required'

export type RuleProposal = {
  state: ProposalState
  // Null ONLY when state is 'decision_required' and nothing defensible
  // exists to pre-select — never null for the other two states.
  proposed_interpretation: Record<string, unknown> | null
  // Source-specific — must quote or closely paraphrase the actual clause,
  // never generic boilerplate. See validateProposalState, which enforces
  // this rather than trusting the model's own claim.
  reasoning: string
  calculation_preview?: Array<{ label: string; value: string }>
}

function proposalSchemaBlock(fields: string): string {
  return `Respond with a structured JSON object with EXACTLY these fields:
{
  "state": "clear_from_source" | "verdix_recommends" | "decision_required",
  "proposed_interpretation": ${fields} | null,
  "reasoning": "<one to three sentences, quoting or closely paraphrasing the actual source clause — never generic AI boilerplate like 'this is ambiguous'>",
  "calculation_preview": [{"label": "<short label>", "value": "<plain-English value or formula>"}] | omit if not usefully computable yet
}

State rules — this is the most important part of your response:
- "clear_from_source": the contract language is explicit enough that a competent reviewer would reach the same conclusion without needing to guess. proposed_interpretation must be fully populated. reasoning MUST quote or closely paraphrase the specific words that make it explicit.
- "verdix_recommends": the contract isn't perfectly explicit, but there is a commercially defensible reading (e.g. the contract calls something a "minimum charge" rather than an "additional fee", which supports reading it as a floor). proposed_interpretation must still be fully populated — this is a recommendation, not a fact, but it IS a specific, structured recommendation. reasoning must explain the specific textual basis for the recommendation.
- "decision_required": the contract is genuinely silent on the deciding question. Set proposed_interpretation to null — do NOT pre-select anything, do NOT guess, do NOT default to the "usual" answer. reasoning must explain specifically what the contract fails to state.
- When in doubt between "verdix_recommends" and "decision_required": if you cannot point to ANY textual basis (however indirect) for a specific answer, use "decision_required". A recommendation with no textual basis is worse than an honest gap.
- Never claim "clear_from_source" for a question the contract doesn't directly address — that state means "explicit", not "the common default".`
}

export type MinimumCommitmentProposalContext = MinimumCommitmentContext
export function buildMinimumCommitmentProposalPrompt(context: MinimumCommitmentProposalContext): string {
  const tierLines = context.tiers
    .map(t => `- ${t.tier_label}: ${t.from_unit ?? 1}–${t.to_unit ?? '∞'} @ ${t.rate_per_unit} ${context.currency}/unit`)
    .join('\n')
  return `A SaaS contract has a minimum-commitment clause for the "${context.contractUnitType}" metric. Before any human reviewer has said anything, determine Verdix's own best interpretation of how this minimum should be charged.

Source clause: ${context.sourceClause ?? '(not captured)'}
Included allowance: ${context.includedUnits} units
Stated minimum: ${context.existingMinimumAmount != null ? `${context.existingMinimumAmount} ${context.currency}` : 'unknown'} per ${context.measurementPeriod ?? 'period'}
Pricing tiers:
${tierLines || '(none)'}

${proposalSchemaBlock('{"mode": "floor"|"additive"|"minimum_spend"|"prepaid_commitment"|"minimum_quantity", "amount": <number>, "period": "monthly"|"quarterly"|"semi-annual"|"annual"|null, "included_allowance_interaction": "before_allowance"|"after_allowance", "prorate_partial_periods": true|false|"unclear", "calculation_summary": "<one sentence>"}')}

Specific guidance: a clause calling the amount a "minimum charge"/"minimum processing charge"/"floor" (rather than an "additional fee") supports "verdix_recommends" with mode "floor". Whether the minimum applies before or after an included allowance is frequently NOT stated even when both exist — if genuinely unstated, set included_allowance_interaction to "unclear" and lean the overall state toward "decision_required" or "verdix_recommends" depending on whether the mode itself is clear.`
}

export type PartialPeriodProposalContext = PartialPeriodContext
export function buildPartialPeriodProposalPrompt(context: PartialPeriodProposalContext): string {
  return `A SaaS contract runs from ${context.contractStartDate ?? 'unknown'} to ${context.contractEndDate ?? 'unknown'}. The "${context.contractUnitType}" metric's minimum commitment resets on calendar boundaries, creating a partial first and/or final period. Before any human reviewer has said anything, determine Verdix's own best interpretation of how the ${context.minimumAmount != null ? `${context.minimumAmount} ${context.currency}` : ''} minimum should apply to a period the contract wasn't in effect for the whole of.

Source clause: ${context.sourceClause ?? '(not captured)'}

${proposalSchemaBlock('{"prorate_partial_periods": true|false, "proration_method": "days"|"months"|"none"|null, "calculation_summary": "<one sentence>"}')}

Specific guidance: partial-period/proration treatment is very rarely stated explicitly in a contract that only states a flat per-period minimum. Unless the source clause says something explicit about partial periods (e.g. "prorated for any partial month"), you MUST use "decision_required" with proposed_interpretation null — do not default to proration or to full-charge as a "reasonable assumption". This is the single most important rule in this prompt: silence on partial-period treatment is silence, not evidence for either answer.`
}

export type EscalatorProposalContext = EscalatorContext
export function buildEscalatorProposalPrompt(context: EscalatorProposalContext): string {
  return `A SaaS contract has a price escalation clause. Before any human reviewer has said anything, determine Verdix's own best interpretation of how it should be treated.

Source clause: ${context.sourceClause ?? context.description}
Stated cap: ${context.capPct != null ? `${context.capPct}%` : 'none stated'}
Effective date: ${context.effectiveDate ?? context.appliesFromYear ?? 'unknown'}

${proposalSchemaBlock('{"treatment": "applies"|"not_applied", "index": "CPI"|"fixed_pct"|"other"|null, "index_name": "<exact index name from the contract, e.g. HICP — or null>", "frequency": "annual"|"monthly"|"quarterly"|null, "effective_date": "<ISO date or null>", "cap_pct": <number or null>, "calculation_method": "<plain-English formula>", "discretion": "automatic"|"requires_renewal_approval"|"not_exercised", "renewal_triggered": true|false}')}

Specific guidance, in order of what's usually resolvable:
- index/index_name/cap_pct/frequency/renewal_triggered are usually explicit in the clause itself — resolve these as "clear_from_source" whenever the wording states them directly. NEVER normalize a named index like "HICP" to "CPI" — index_name must preserve the contract's own term verbatim.
- renewal_triggered: true only when the clause ties the increase to renewal specifically ("on renewal, the fee may be increased by...") rather than an ordinary automatic annual step during the original term.
- discretion is the one field that is often genuinely uncertain even when everything else is clear: mandatory language ("shall be increased", "will increase") supports discretion "automatic". Discretionary language ("may be increased", "is entitled to increase") means the clause permits an increase but does not itself decide whether it happens — this supports "verdix_recommends" with discretion "requires_renewal_approval" (require a reviewer decision at each renewal) rather than "decision_required", since "may" is itself a textual basis for recommending approval-gating, not silence. Explain this reasoning specifically when it applies.`
}

export type DiscountProposalContext = DiscountContext
export function buildDiscountProposalPrompt(context: DiscountProposalContext): string {
  return `A SaaS contract has a discount clause. Before any human reviewer has said anything, determine Verdix's own best interpretation of its structure.

Source clause / description: ${context.sourceClause ?? context.description}
Extraction's own classification: ${context.extractedType ?? 'unknown'}
Extracted flat value: ${context.existingPct != null ? `${context.existingPct}%` : context.existingAmount != null ? `${context.existingAmount} ${context.currency}` : 'none (may be tiered)'}
Applies to (as extracted): ${context.appliesTo ?? 'unknown'}

${proposalSchemaBlock('{"discount_type": "flat_percentage"|"flat_amount"|"tiered_discount"|"volume_discount"|"component_specific"|"time_ramp"|"custom", "discount_basis": "percentage"|"amount", "tier_method": "graduated"|"volume"|"block"|"custom"|null, "tiers": [{"from_unit": <number|null>, "to_unit": <number|null>, "value": <number>}]|null, "applies_to": "<what this reduces>", "application_order": "<plain-English ordering>", "reset_period": "monthly"|"quarterly"|"semi-annual"|"annual"|"contract_term"|"cumulative"|"custom"|null, "worked_example": "<concrete numeric walkthrough>"}')}

Specific guidance: a flat introductory/time-limited discount with explicit percentage, start condition, and duration (e.g. "25% off the platform subscription for the first 3 months") is "clear_from_source" — every field is stated. A discount whose duration is stated only as a month-count with no explicit anchor to contract start vs. first invoice is still "clear_from_source" if that's the contract's only reasonable reading (anchor to contract/service commencement, not "next invoice after commencement" — do not invent a delayed start the contract doesn't state). Reserve "decision_required" for genuinely unstated tier mechanics on a tiered/volume discount.`
}

export type TierCalculationProposalContext = TierCalculationContext
export function buildTierCalculationProposalPrompt(context: TierCalculationProposalContext): string {
  const tierLines = context.tiers
    .map(t => `- ${t.tier_label}: ${t.from_unit ?? 1}–${t.to_unit ?? '∞'} @ ${t.rate_per_unit} ${context.currency}/unit`)
    .join('\n')
  return `A SaaS contract has a multi-tier price table for the "${context.contractUnitType}" metric. Before any human reviewer has said anything, determine Verdix's own best interpretation of how it's calculated (graduated vs. volume vs. block).

Source clause: ${context.sourceClause ?? '(not captured)'}
Pricing tiers:
${tierLines || '(none)'}

${proposalSchemaBlock('{"method": "graduated"|"volume"|"block"|"custom", "calculation_summary": "<one sentence>", "worked_example": "<numeric walkthrough spanning at least two tiers>"}')}

Specific guidance: language like "for the first X units... for units above X..." or "each band applies only to requests falling within that band" is explicit graduated/staircase language — "clear_from_source" with method "graduated". Language like "once volume exceeds X, all units are billed at..." is explicit volume language — "clear_from_source" with method "volume". A bare rate table with tier boundaries and per-unit rates but NO language describing which mechanism applies is genuinely ambiguous — graduated is the more common convention but is NEVER a safe default; use "decision_required" unless the wording actually says which mechanism applies.`
}

export type ServiceCreditProposalContext = ServiceCreditContext
export function buildServiceCreditProposalPrompt(context: ServiceCreditProposalContext): string {
  return `A SaaS contract has a service-credit clause. Before any human reviewer has said anything, determine Verdix's own best interpretation of its calculation basis.

Source clause / description: ${context.sourceClause ?? context.description}
Extraction's own classification: ${context.creditType}
Stated value: ${context.statedPct != null ? `${context.statedPct}%` : context.statedAmount != null ? `${context.statedAmount} ${context.currency}` : 'not captured as a single value'}

${proposalSchemaBlock('{"trigger_type": "sla_breach"|"usage_threshold"|"promotional"|"earned_milestone"|"other", "trigger_description": "<plain-English condition>", "credit_basis": "pct_of_period_fee"|"pct_of_affected_component"|"flat_amount"|"usage_units", "basis_component": "<what the value is computed from>", "credit_value": <number>, "cap_amount": <number or null>, "cap_pct": <number or null>, "settlement_period": "monthly"|"quarterly"|"semi-annual"|"annual"|"per_incident"|null, "cash_redeemable": true|false, "calculation_summary": "<one sentence>"}')}

Specific guidance: the trigger condition, credit value, cap, and settlement timing are usually stated explicitly — resolve these as "clear_from_source" when the wording is direct. basis_component (WHAT the percentage/amount is computed from — e.g. "the affected month's subscription fee") is the field most often left genuinely ambiguous, especially when another rule (like an introductory discount) could change what "the fee" means for a given period — if the clause doesn't specify and no other context resolves it, use "decision_required" for basis_component specifically rather than assuming the standard/undiscounted fee.`
}

export type RuleInteractionProposalContext = RuleInteractionContext
export function buildRuleInteractionProposalPrompt(context: RuleInteractionProposalContext): string {
  return `A SaaS contract has two commercial rules that both appear to reference the same fee component. Before any human reviewer has said anything, determine Verdix's own best interpretation of how they interact.

Service credit: ${context.creditDescription}${context.creditBasisComponent ? ` (its own stated basis: ${context.creditBasisComponent})` : ' (basis not yet resolved)'}
Other rule (${context.otherRuleType}): ${context.otherRuleDescription}
Why these were flagged together: ${context.overlapReason}

${proposalSchemaBlock('{"resolution": "pre_other_rule_basis"|"post_other_rule_basis"|"independent_no_overlap"|"other", "note": "<one-sentence plain-English statement of the resolved basis>"}')}

Specific guidance: this is rarely explicit — most contracts that define a service credit as "X% of that period's fee" do not separately address what happens when a different clause (like an introductory discount) has already changed what "that period's fee" is. Only use "clear_from_source" or "verdix_recommends" if the contract's wording gives an actual textual basis for one reading over the other (e.g. the credit clause says "the standard fee" or "the fee then in effect", which does distinguish pre- vs post-discount). Absent any such wording, use "decision_required" — do not default to either reading as the "obvious" one, since reasonable contracts do both.`
}

// Downgrades an over-confident proposal toward more caution — never
// upgrades. Mirrors the flagAmbiguous*/NOT_APPLIED_LANGUAGE safety-net
// pattern already used elsewhere in this pipeline: the model's own stated
// confidence is never trusted as the final word, a deterministic check runs
// after every response.
export function validateProposalState(proposal: RuleProposal, sourceClauseAvailable: boolean): RuleProposal {
  const { reasoning } = proposal
  let { state, proposed_interpretation } = proposal

  // A "decision_required" claim that still ships a fully-populated
  // proposed_interpretation is internally contradictory — the model may have
  // meant to flag genuine uncertainty about one field while still proposing
  // the rest; treat that as decision_required won, since "nothing
  // pre-selected" is the safer failure mode than silently trusting a
  // proposal the model itself called undecidable.
  if (state === 'decision_required' && proposed_interpretation != null) {
    proposed_interpretation = null
  }

  // "clear_from_source" requires an actual clause to point to, and requires
  // the reasoning to look like it's quoting/paraphrasing something specific
  // rather than asserting confidence with no textual anchor. A short or
  // missing reasoning string can't possibly be a real quote — downgrade
  // rather than trust a bare assertion.
  if (state === 'clear_from_source') {
    const reasoningLooksSourced = reasoning.trim().length >= 20
    if (!sourceClauseAvailable || !reasoningLooksSourced) {
      state = 'verdix_recommends'
    }
  }

  // A "verdix_recommends"/"clear_from_source" state with no actual proposal
  // to show is also contradictory in the other direction — nothing to
  // recommend means there's nothing safely pre-selectable, which is what
  // decision_required means by definition.
  if (state !== 'decision_required' && proposed_interpretation == null) {
    state = 'decision_required'
  }

  return { state, proposed_interpretation, reasoning }
}
