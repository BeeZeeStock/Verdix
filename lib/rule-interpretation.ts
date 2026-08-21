// Pure logic for the in-panel AI-assisted rule-interpretation flow — builds
// the prompts sent to Claude and validates/parses its structured response.
// Zero React, zero supabaseServer import (same discipline as lib/tariff.ts),
// so this is directly unit-testable and shared between the interpret-rule
// API route and the review-panel UI (describeWhatWillChange in particular
// must never diverge between what the API reports and what the UI shows).

import { cadenceNoun, contractMonthLabel } from './cadence-labels'

export type RuleType = 'minimum_commitment' | 'escalator' | 'partial_period' | 'discount' | 'tier_calculation' | 'service_credit' | 'rule_interaction' | 'base_fee_proration' | 'recurring_fee_proration'

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

// base_fee_proration / recurring_fee_proration ask a genuinely different
// first question than getPartialPeriodOptions above: a metric's minimum
// commitment is measured over a window the contract already ties to the
// calendar (e.g. "for each calendar month"), so only proration TREATMENT is
// open. A recurring fee billed "monthly in advance" with no anchor language
// at all has not even settled whether its periods run on calendar
// boundaries or the contract's own start-date anniversary — assuming
// calendar and only asking about proration silently forecloses the
// anniversary reading, which may be the more natural one for a fee that
// resets "monthly" starting from a specific signing/go-live date. When the
// contract starts mid-month, contractPeriodLabel names that anniversary
// window concretely (e.g. "17th–16th") so the option reads as a real,
// specific choice rather than an abstract "contract month".
export function getBaseFeeProrationOptions(cadenceLabel: string = 'period', contractPeriodLabel?: string | null): StructuredOption[] {
  const options: StructuredOption[] = []
  if (contractPeriodLabel) {
    options.push({
      id: 'contract_month',
      label: `Full fee per contract ${cadenceLabel} (${contractPeriodLabel})`,
      description: `Billing periods follow the contract's own start-date anniversary, not the calendar — every ${cadenceLabel} is a full ${cadenceLabel} by definition, so no partial-period question ever arises.`,
    })
  }
  options.push(
    { id: 'calendar_full', label: `Full fee each calendar ${cadenceLabel}`, description: `Billing resets on calendar ${cadenceLabel} boundaries; a partial first or final ${cadenceLabel} is still charged in full.` },
    { id: 'calendar_prorate_days', label: 'Prorate by days on calendar boundaries', description: `Billing resets on calendar ${cadenceLabel} boundaries; a partial ${cadenceLabel} is reduced in proportion to the days actually covered.` },
  )
  // Prorating by months only means something when the cadence itself is
  // coarser than a month (e.g. an annual fee prorated across the months of
  // a partial year) — for a monthly cadence the period IS a month, so
  // "prorate by months" is a degenerate, redundant choice next to
  // calendar_prorate_days and would just clutter the monthly case.
  if (cadenceLabel !== 'month') {
    options.push({ id: 'calendar_prorate_months', label: 'Prorate by months on calendar boundaries', description: `Billing resets on calendar ${cadenceLabel} boundaries; a partial ${cadenceLabel} is reduced in proportion to the months actually covered.` })
  }
  options.push({ id: 'other', label: 'Other / describe treatment', description: 'Tell Verdix how this should work in your own words.' })
  return options
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
  // Distinct from flat_amount: a single stated rate applied per occurrence
  // of a named qualifying unit (e.g. "SEK 5,500 per complete hour of excess
  // unavailability"), not one lump-sum figure. Labeling this "Flat amount"
  // was actively misleading — the clause already states the monetary basis
  // and the per-unit multiplier explicitly, so there's no real ambiguity to
  // resolve here at all when this is what the source says.
  { id: 'fixed_amount_per_unit', label: 'Fixed amount per qualifying unit', description: 'The credit is a stated currency amount multiplied by however many qualifying units occurred (e.g. per excess hour, per incident) — not one single lump sum.' },
  { id: 'flat_amount', label: 'Flat amount', description: 'The credit is a single fixed currency amount, not a percentage and not multiplied by a unit count.' },
  { id: 'usage_units', label: 'Usage units', description: 'The credit is expressed in usage units (e.g. free requests), not currency.' },
  { id: 'other', label: 'Other / describe treatment', description: 'Tell Verdix how this should work in your own words.' },
]

// Independent of SERVICE_CREDIT_OPTIONS above (which resolves what the
// credit's VALUE is computed from) — this resolves what happens to a
// credited-but-unapplied balance, the survival/carry-forward question.
// Each option here must be an actually executable reviewer policy, not a
// theoretical possibility — deliberately excludes a same-period-only
// expiry option (carry_forward: false), since it would directly contradict
// a credit whose own source already establishes it applies against FUTURE
// amounts payable (a clause that eligible for future application but never
// survives past its own earning period is a contradiction, not a real
// policy). Maps directly onto CreditApplicationRule.carry_forward/
// expiry_periods/expiry_date (lib/types.ts):
// 'carry_forward_until_used' → carry_forward: true, expiry_periods: null,
// expiry_date: null; 'next_period_only' → carry_forward: true,
// expiry_periods: 1 (survives exactly one additional period, then
// expires); 'carry_forward_limited' → carry_forward: true with a
// reviewer-specified expiry_periods; 'expire_on_date' → carry_forward:
// true with a reviewer-specified expiry_date; 'other' routes through
// buildCreditSurvivalPrompt for a reviewer-worded treatment this list
// doesn't cover — translated to a PROPOSED structured rule the reviewer
// must still explicitly confirm before it applies (never auto-applied).
export const CREDIT_SURVIVAL_OPTIONS: StructuredOption[] = [
  { id: 'carry_forward_until_used', label: 'Carry forward until fully used', description: 'Any unused balance rolls forward and is applied against future charges until fully consumed, with no fixed expiry.' },
  { id: 'next_period_only', label: 'Apply to the next billing period only; unused remainder then expires', description: 'An unused balance survives exactly one additional billing period, then any remainder is forfeited.' },
  { id: 'carry_forward_limited', label: 'Carry forward for a defined number of billing periods', description: 'Specify how many billing periods an unused balance remains available before it expires.' },
  { id: 'expire_on_date', label: 'Expire on a specified date', description: 'Specify a fixed calendar date after which any remaining unused balance is forfeited.' },
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

export function optionsForRuleType(ruleType: RuleType, cadenceLabel?: string, contractPeriodLabel?: string | null): StructuredOption[] {
  switch (ruleType) {
    case 'minimum_commitment': return MINIMUM_COMMITMENT_OPTIONS
    case 'partial_period': return getPartialPeriodOptions(cadenceLabel)
    // A different question from partial_period, not the same one reused —
    // see getBaseFeeProrationOptions for why: the calendar anchor itself is
    // open here, not just proration treatment.
    case 'base_fee_proration': return getBaseFeeProrationOptions(cadenceLabel, contractPeriodLabel)
    case 'recurring_fee_proration': return getBaseFeeProrationOptions(cadenceLabel, contractPeriodLabel)
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
  if (ruleType === 'base_fee_proration' || ruleType === 'recurring_fee_proration') {
    if (approved.reset_anchor === 'contract_start') return 'contract_month'
    if (approved.reset_anchor === 'calendar' && approved.prorate_partial_periods === false) return 'calendar_full'
    if (approved.reset_anchor === 'calendar' && approved.prorate_partial_periods === true && approved.proration_method === 'days') return 'calendar_prorate_days'
    if (approved.reset_anchor === 'calendar' && approved.prorate_partial_periods === true && approved.proration_method === 'months') return 'calendar_prorate_months'
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
    if (approved.credit_basis === 'fixed_amount_per_unit') return 'fixed_amount_per_unit'
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
  // Lets the same partial-period question ("prorate or bill in full for a
  // partial calendar period?") read naturally whether it's asked about a
  // metric's minimum commitment (the original case) or a base/recurring fee
  // (base_fee_proration / recurring_fee_proration) — the mechanics and
  // options are identical either way, only the noun in the prompt changes.
  // Defaults to 'minimum commitment' so every existing caller is unaffected.
  subjectNoun?: string
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

function optionContext(ruleType: RuleType, selectedOption?: string, cadenceLabel?: string, contractPeriodLabel?: string | null): string {
  if (!selectedOption || selectedOption === 'other') return ''
  const opt = optionsForRuleType(ruleType, cadenceLabel, contractPeriodLabel).find(o => o.id === selectedOption)
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
  "applies_at_zero_usage": true | false | "unclear",
  "calculation_summary": "<one-sentence plain-English description of the resulting calculation, e.g. 'max(tiered usage charge, 5000)'>"
}

Rules:
- Use ONLY what the reviewer's instruction and the source clause actually say. Never invent a value the reviewer didn't provide or imply.
- If the reviewer's instruction doesn't specify a required field clearly enough to be confident, omit that field entirely rather than guessing — do not fabricate a default.
- applies_at_zero_usage (mode 'floor'/'minimum_spend' only): whether the minimum is still owed for a period with genuinely zero usage. Only set true/false if the reviewer's instruction actually addresses this specific scenario; otherwise "unclear" — never assume it follows from the minimum's mere existence.
- Respond with ONLY the JSON object, no other text.`
}

export function buildPartialPeriodPrompt(
  context: PartialPeriodContext,
  reviewerInput: string,
  selectedOption?: string,
): string {
  // A metric's minimum commitment (subjectNoun unset) is measured over a
  // window the contract has already tied to the calendar — only proration
  // TREATMENT is open. A base/recurring fee (subjectNoun set) hasn't even
  // settled that: "billed monthly in advance" with no anchor language
  // leaves open whether periods run on calendar boundaries or the
  // contract's own start-date anniversary. Asserting "resets on calendar
  // boundaries stated in the contract" as a given fact for the fee case
  // would beg the exact question being asked — the two prompts diverge
  // here rather than sharing one premise that's only true for one of them.
  const isFee = !!context.subjectNoun
  const subject = context.subjectNoun ?? 'minimum commitment'
  const ruleType = isFee ? 'base_fee_proration' : 'partial_period'
  if (isFee) {
    const cadenceLabel = cadenceNoun(context.measurementPeriod)
    const contractPeriodLabel = contractMonthLabel(context.contractStartDate)
    return `A SaaS contract runs from ${context.contractStartDate ?? 'unknown'} to ${context.contractEndDate ?? 'unknown'}. The "${context.contractUnitType}" ${subject} of ${context.minimumAmount != null ? `${context.minimumAmount} ${context.currency}` : ''} is billed on a recurring cadence, but the contract does not state whether that cadence resets on fixed calendar boundaries or on the contract's own start-date anniversary — both are plausible readings of ordinary "billed monthly" language. A human reviewer is resolving which anchor applies, and — only if calendar boundaries are chosen — how a resulting partial first/final period should be treated.

Source clause: ${context.sourceClause ?? '(not captured)'}
${optionContext(ruleType, selectedOption, cadenceLabel, contractPeriodLabel)}
Reviewer's instruction: "${reviewerInput}"

Translate the reviewer's instruction into a structured JSON object with EXACTLY these fields:
{
  "reset_anchor": "contract_start" | "calendar",
  "prorate_partial_periods": true | false,
  "proration_method": "days" | "months" | "none" | null,
  "calculation_summary": "<one-sentence plain-English description>"
}

Rules:
- Use ONLY what the reviewer's instruction and the source clause actually say. Never invent a value the reviewer didn't specify.
- reset_anchor "contract_start" means every billing period runs from the contract's own start-date anniversary — no partial period is ever possible under this reading, so prorate_partial_periods should be false and proration_method "none".
- reset_anchor "calendar" means billing periods reset on fixed calendar boundaries (e.g. the 1st of the month), which can produce a partial first/final period — prorate_partial_periods and proration_method then describe how that partial period is treated.
- If the reviewer's instruction doesn't clearly specify a field, omit it entirely rather than guessing.
- Respond with ONLY the JSON object, no other text.`
  }
  return `A SaaS contract runs from ${context.contractStartDate ?? 'unknown'} to ${context.contractEndDate ?? 'unknown'}, but the "${context.contractUnitType}" ${subject} resets on calendar boundaries stated in the contract, creating a partial first and/or final period. A human reviewer is resolving how the ${context.minimumAmount != null ? `${context.minimumAmount} ${context.currency}` : ''} ${subject} should apply to a period the contract wasn't in effect for the whole of.

Source clause: ${context.sourceClause ?? '(not captured)'}
${optionContext(ruleType, selectedOption)}
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
  "credit_basis": "pct_of_period_fee" | "pct_of_affected_component" | "fixed_amount_per_unit" | "flat_amount" | "usage_units",
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
- fixed_amount_per_unit vs flat_amount: use fixed_amount_per_unit when the credit is a stated rate MULTIPLIED by however many qualifying units occurred (e.g. "SEK 5,500 per complete hour of excess unavailability"); use flat_amount only for a single lump-sum figure with no per-unit multiplier. Do not label a per-unit rate "flat" just because the per-unit figure itself is a fixed number.
- cash_redeemable defaults to false unless the reviewer's instruction or the source clause explicitly says the customer may request a cash refund rather than a credit against future invoices.
- Never invent a percentage, amount, or cap the reviewer didn't state or that wasn't already in the extracted data above.
- Respond with ONLY the JSON object, no other text.`
}

export type CreditSurvivalContext = {
  sourceClause: string | null
  description: string
}

// Narrow, single-question translator — deliberately separate from
// buildServiceCreditPrompt above, which resolves trigger/rate/cap/basis, a
// different question entirely. Used only for the "Other / describe
// treatment" choice on a credit's unused-balance survival sub-field, when
// none of CREDIT_SURVIVAL_OPTIONS' four structured choices fit — those four
// are translated client-side with no AI call at all, since they map
// directly onto carry_forward/expiry_periods with no interpretation
// required.
export function buildCreditSurvivalPrompt(context: CreditSurvivalContext, reviewerInput: string): string {
  return `A SaaS contract has a service-credit/rebate clause whose UNUSED-BALANCE SURVIVAL treatment a human reviewer is resolving — specifically what happens to a portion of the credit that is earned/credited but not yet applied against an invoice. This is NOT about what the credit is worth, what triggers it, or what it may be applied against — only how long an unapplied balance remains available.

Source clause / description: ${context.sourceClause ?? context.description}
Reviewer's instruction: "${reviewerInput}"

Translate the reviewer's instruction into a structured JSON object with EXACTLY these fields:
{
  "carry_forward": true | false,
  "expiry_periods": <number of billing periods after which an unused balance expires, or null>,
  "expiry_date": "<ISO date YYYY-MM-DD after which an unused balance expires, or null>",
  "calculation_summary": "<one-sentence plain-English description of the resulting survival treatment>"
}

Rules:
- carry_forward: true means an unused balance persists into future periods (bounded by expiry_periods or expiry_date if the reviewer stated a limit, or indefinitely if both are null); false means it does NOT survive past the period it was earned/credited in.
- Set AT MOST ONE of expiry_periods/expiry_date — a reviewer states a period count OR a specific date, never both. Only set one when the reviewer's instruction states a SPECIFIC number of periods or a SPECIFIC date — never invent a count or date the reviewer didn't state. If they said "carries forward" with no stated limit, set both to null.
- Use ONLY what the reviewer's instruction actually says. Never invent a treatment they didn't describe.
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
  base_fee_proration: ['reset_anchor'],
  recurring_fee_proration: ['reset_anchor'],
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
  // prorate_partial_periods only means something once calendar-boundary
  // billing is established — a contract_start anchor has no partial period
  // to prorate, so requiring the field unconditionally would force the AI
  // to invent a value for a question that doesn't apply under that reading.
  if ((ruleType === 'base_fee_proration' || ruleType === 'recurring_fee_proration') && parsed.reset_anchor === 'calendar' && parsed.prorate_partial_periods == null) {
    missing.push('prorate_partial_periods')
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
  reset_anchor: 'Does this fee reset on fixed calendar boundaries, or on the contract’s own start-date anniversary?',
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
  // service_credit only (see buildServiceCreditProposalPrompt) — grades
  // application_rule.eligible_component_keys specifically (WHAT future
  // charges this credit may reduce), independently of `state`, so a
  // credit's fully-explicit trigger/rate/cap facts are never dragged down
  // to "Verdix recommendation" purely because eligibility is still open,
  // and vice versa. Undefined for every other rule type.
  application_state?: ProposalState
  // service_credit only — grades application_rule.carry_forward/one_time
  // specifically (whether an earned-but-unused credit survives/expires,
  // and whether it can be earned more than once). Deliberately a THIRD,
  // independent grade from both `state` and `application_state`: a clause
  // can state a credit's size (state), state exactly what it may offset
  // (application_state), and still say nothing about how long it survives
  // unused (survival_state) — three genuinely separate questions, none of
  // which should drag the others down. Undefined for every other rule type.
  survival_state?: ProposalState
}

// extraStateFields lets a specific rule type ask for additional,
// independently graded states alongside the main one — added for
// service_credit, where a single holistic classification forced facts that
// are fully explicit (trigger, rate, cap) to be graded down to
// "verdix_recommends" purely because a genuinely separate question
// (eligibility, or survival/expiry) was still open. Every other rule type
// passes an empty array and gets the original single-state schema, unchanged.
function proposalSchemaBlock(fields: string, extraStateFields: Array<{ name: string; label: string }> = []): string {
  const extraStateJson = extraStateFields.map(f => `\n  "${f.name}": "clear_from_source" | "verdix_recommends" | "decision_required",`).join('')
  const extraStateGuidance = extraStateFields.map(f =>
    `\n- "${f.name}" grades ONLY ${f.label}, using the exact same three-state definitions above, but graded INDEPENDENTLY of "state" and of every other extra state field — do not let uncertainty in one drag another down, and do not let clarity in one inflate another. A clause can be fully explicit about its trigger and value while remaining completely silent on ${f.label}, or vice versa.`
  ).join('')
  return `Respond with a structured JSON object with EXACTLY these fields:
{
  "state": "clear_from_source" | "verdix_recommends" | "decision_required",${extraStateJson}
  "proposed_interpretation": ${fields} | null,
  "reasoning": "<one to three sentences, quoting or closely paraphrasing the actual source clause — never generic AI boilerplate like 'this is ambiguous'>",
  "calculation_preview": [{"label": "<short label>", "value": "<plain-English value or formula>"}] | omit if not usefully computable yet
}

State rules — this is the most important part of your response:
- "clear_from_source": the contract language is explicit enough that a competent reviewer would reach the same conclusion without needing to guess. proposed_interpretation must be fully populated. reasoning MUST quote or closely paraphrase the specific words that make it explicit.
- "verdix_recommends": the contract isn't perfectly explicit, but there is a commercially defensible reading (e.g. the contract calls something a "minimum charge" rather than an "additional fee", which supports reading it as a floor). proposed_interpretation must still be fully populated — this is a recommendation, not a fact, but it IS a specific, structured recommendation. reasoning must explain the specific textual basis for the recommendation.
- "decision_required": the contract is genuinely silent on the deciding question. Set proposed_interpretation to null — do NOT pre-select anything, do NOT guess, do NOT default to the "usual" answer. reasoning must explain specifically what the contract fails to state.
- When in doubt between "verdix_recommends" and "decision_required": if you cannot point to ANY textual basis (however indirect) for a specific answer, use "decision_required". A recommendation with no textual basis is worse than an honest gap.
- Never claim "clear_from_source" for a question the contract doesn't directly address — that state means "explicit", not "the common default".${extraStateGuidance}`
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

${proposalSchemaBlock('{"mode": "floor"|"additive"|"minimum_spend"|"prepaid_commitment"|"minimum_quantity", "amount": <number>, "period": "monthly"|"quarterly"|"semi-annual"|"annual"|null, "included_allowance_interaction": "before_allowance"|"after_allowance", "prorate_partial_periods": true|false|"unclear", "applies_at_zero_usage": true|false|"unclear", "calculation_summary": "<one sentence>"}')}

Specific guidance: a clause calling the amount a "minimum charge"/"minimum processing charge"/"floor" (rather than an "additional fee") supports "verdix_recommends" with mode "floor". Whether the minimum applies before or after an included allowance is frequently NOT stated even when both exist — if genuinely unstated, set included_allowance_interaction to "unclear" and lean the overall state toward "decision_required" or "verdix_recommends" depending on whether the mode itself is clear.

applies_at_zero_usage (mode "floor"/"minimum_spend" only): a materially separate question from whether the minimum exists at all — whether it is STILL owed for a period with genuinely zero usage. Contracts are frequently silent on this specific scenario even when the minimum itself is stated clearly. Set true/false only when the source clause actually addresses it; otherwise "unclear". Critically, an "unclear" answer here does NOT by itself force the overall state to "decision_required" — if mode/amount/period are otherwise clear, keep the overall state at "clear_from_source" or "verdix_recommends" and mention the open zero-usage question explicitly in reasoning, so a reviewer can still act on everything that IS resolved. Never silently pick true or false and never let this sub-question disappear from the response.

Critical: this metric may have multiple pricing bands/tiers (see Pricing tiers above), but the minimum is a single METRIC-LEVEL rule — it compares against the TOTAL calculated usage charge across every band combined, never against any one band in isolation. calculation_summary must say so explicitly, e.g. "max(total graduated usage charge across all pricing bands after the included allowance, ${context.existingMinimumAmount ?? 'the minimum'})" — never phrase this as if the minimum were attached to one specific tier or unit range.`
}

export type PartialPeriodProposalContext = PartialPeriodContext
export function buildPartialPeriodProposalPrompt(context: PartialPeriodProposalContext): string {
  // Same divergence as buildPartialPeriodPrompt above: a base/recurring fee
  // has not settled its calendar-vs-contract-anniversary anchor at all, so
  // asserting "resets on calendar boundaries" as a given fact — and never
  // even asking about it in the schema — silently forecloses the
  // contract-start reading and skews any calculation_preview toward
  // calendar-boundary math that may not apply.
  if (context.subjectNoun) {
    const subject = context.subjectNoun
    return `A SaaS contract runs from ${context.contractStartDate ?? 'unknown'} to ${context.contractEndDate ?? 'unknown'}. The "${context.contractUnitType}" ${subject} of ${context.minimumAmount != null ? `${context.minimumAmount} ${context.currency}` : ''} is billed on a recurring cadence, but the contract does not state whether that cadence resets on fixed calendar boundaries or on the contract's own start-date anniversary. Before any human reviewer has said anything, determine Verdix's own best interpretation of which anchor applies, and — only if calendar boundaries — how a resulting partial first/final period should be treated.

Source clause: ${context.sourceClause ?? '(not captured)'}

${proposalSchemaBlock('{"reset_anchor": "contract_start"|"calendar", "prorate_partial_periods": true|false, "proration_method": "days"|"months"|"none"|null, "calculation_summary": "<one sentence>"}')}

Specific guidance: ordinary "billed monthly in advance" language, with no explicit calendar-boundary or anniversary wording, is genuinely silent on this question — neither anchor is the "default". Unless the source clause says something explicit (e.g. "billed on the first of each calendar month" supports calendar; "billed monthly from the effective date" supports contract_start), you MUST use "decision_required" with proposed_interpretation null. This is the single most important rule in this prompt: silence on the anchor question is silence, not evidence for either answer.`
  }
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

Specific guidance: a flat introductory/time-limited discount with explicit percentage, start condition, and duration (e.g. "25% off the platform subscription for the first 3 months") is "clear_from_source" — every field is stated. A discount whose duration is stated only as a month-count with no explicit anchor to contract start vs. first invoice is still "clear_from_source" if that's the contract's only reasonable reading (anchor to contract/service commencement, not "next invoice after commencement" — do not invent a delayed start the contract doesn't state). Reserve "decision_required" for genuinely unstated tier mechanics on a tiered/volume discount.

Critical: an introductory/time-limited discount that reduces a RECURRING fee for a limited number of billing periods (e.g. "25% off for the first 3 months") is NOT a one-time charge, credit, or adjustment — it affects multiple recurring periods, just not all of them. Never describe it using "one-time" language anywhere in reasoning, calculation_summary, or worked_example; use "introductory"/"temporary"/"time-limited" instead. The worked_example should state the net fee for a discounted period and the net fee once the discount ends (e.g. "Periods 1-3: 5,625; period 4 onward: 7,500"), not just the discount percentage.`
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
  return `A SaaS contract has a service-credit/rebate clause. Before any human reviewer has said anything, determine Verdix's own best interpretation of its calculation basis AND when/how it applies.

Source clause: ${context.sourceClause ?? '(not captured)'}
Extraction's own summary/description: ${context.description || '(none)'}
Both of the above come from the SAME extraction pass and may each contain facts the other omits — extraction sometimes captures an application-scope or carry-forward fact (e.g. "applicable against future transaction-processing fees only", "applied against future amounts payable") in the description that isn't repeated in the shorter source clause, or vice versa. Read BOTH before deciding any state — never grade a field "decision_required" solely because one of the two fields is silent on it if the other one isn't.
Extraction's own classification: ${context.creditType}
Stated value: ${context.statedPct != null ? `${context.statedPct}%` : context.statedAmount != null ? `${context.statedAmount} ${context.currency}` : 'not captured as a single value'}

${proposalSchemaBlock(
  '{"trigger_type": "sla_breach"|"usage_threshold"|"promotional"|"earned_milestone"|"other", "trigger_description": "<plain-English condition>", "credit_basis": "pct_of_period_fee"|"pct_of_affected_component"|"fixed_amount_per_unit"|"flat_amount"|"usage_units", "basis_component": "<what the value is computed from>", "credit_value": <number>, "cap_amount": <number or null>, "cap_pct": <number or null>, "settlement_period": "monthly"|"quarterly"|"semi-annual"|"annual"|"per_incident"|null, "cash_redeemable": true|false, "earn_rule": {"trigger_metric_key": "<metric name, e.g. transactions>", "trigger_quantity": <number>, "trigger_comparator": "gt"|"gte", "trigger_window": "calendar_month"|"billing_period"|"contract_year"|"per_incident", "consecutive_windows_required": <number, 1 if the clause does not require a streak>, "window_anchor": "contract_start"|"calendar", "finalization_deadline_days": <number or null>}, "application_rule": {"computed_from_component_keys": [<string>]|null, "eligible_component_keys": [<string>]|"all"|null, "excluded_component_keys": [<string>], "one_time": true|false|"unclear", "carry_forward": true|false|"unclear"}, "calculation_summary": "<one sentence>"}',
  [
    { name: 'application_state', label: 'application_rule.eligible_component_keys ONLY — WHAT future charges this credit may reduce (never carry-forward/expiry, which survival_state covers below, and never the trigger, rate, cap, or settlement timing, which "state" already covers)' },
    { name: 'survival_state', label: 'application_rule.carry_forward and application_rule.one_time ONLY — whether an earned-but-unused credit persists or expires, and whether it can be earned more than once (never eligibility/scope, which application_state covers, and never trigger/rate/cap/settlement timing)' },
  ],
)}

Specific guidance, by field:
- trigger condition, credit value, cap, and settlement timing are usually stated explicitly — resolve these as "clear_from_source" when the wording is direct. These drive "state", never "application_state" or "survival_state".
- basis_component (WHAT the percentage/amount is computed from — e.g. "the affected month's subscription fee") is often genuinely ambiguous, especially when another rule (like an introductory discount) could change what "the fee" means for a given period — if the clause doesn't specify and no other context resolves it, use "decision_required" for basis_component specifically rather than assuming the standard/undiscounted fee.
- credit_basis "fixed_amount_per_unit" vs "flat_amount": use fixed_amount_per_unit whenever the clause states a rate multiplied by however many qualifying units occurred (e.g. "SEK 5,500 for each complete hour of excess unavailability"); this is "clear_from_source" the moment the per-unit rate and qualifying unit are both stated, exactly like any other explicit figure — it is NOT an unresolved basis question just because the rate is per-unit rather than a single sum. Reserve flat_amount for an actual single lump-sum credit with no per-unit multiplier.
- earn_rule.consecutive_windows_required: only set above 1 when the clause explicitly requires a streak across multiple windows (e.g. "in each of 3 consecutive calendar months") — a single-period threshold is 1, never inferred as a streak just because it recurs.
- application_rule.eligible_component_keys is the single most commonly UNSTATED field — a clause can state a credit's SIZE (e.g. "5% of transaction-processing fees paid") without ever stating what future charges that resulting credit may reduce. Do not assume it may offset "all amounts payable" or "the same component it was computed from" unless the contract actually says so. But this is a real, gradeable "clear_from_source" case whenever the clause DOES say so explicitly — e.g. "applied against future amounts payable" is explicit textual grounding for eligible_component_keys "all"; "applicable only against future transaction-processing fees" is explicit grounding for eligible_component_keys ["transaction_processing"]. Only set eligible_component_keys to null and grade application_state "decision_required" when the clause is genuinely silent on what the credit may be applied against — do not confuse silence on eligibility with silence on calculation basis; a clause stating what a credit is computed FROM (e.g. "5% of transaction-processing fees paid") does not, by itself, state what it may be applied AGAINST — those are different questions, and stating only the former leaves eligible_component_keys null.
  A SEPARATE, standalone sentence stating what a credit "applies only to" / "applies to" / "does not apply to" / "excludes" a named set of fee components is a DIFFERENT signal from the basis sentence, even when it names the SAME components the basis was computed from — a clause that has ALREADY unambiguously stated its basis in one sentence (e.g. "a rebate equal to 5% of the transaction-processing fees paid") gains no new information by a second sentence that MERELY repeats the basis a second time, so the more natural reading of that second, independent sentence — especially one phrased as an affirmative "applies to"/negative "does not apply to" scope rule, and especially when an EXCLUSION list follows ("does not apply to: platform fees; chargeback fees; other fees or charges") — is that it is answering the SEPARATE application-eligibility question, not restating basis for emphasis. Treat such a sentence as resolving eligible_component_keys to the named components (clear_from_source), not as leaving it null, UNLESS the contract's own wording or a directly conflicting later clause makes the basis-only reading the more natural one. This determination does not require the literal words "applied"/"against" — ordinary contract drafting uses "applies to"/"does not apply to" interchangeably with "is applied against"/"may not be applied against".
- application_rule.carry_forward / application_rule.one_time drive survival_state, independently of application_state: only set carry_forward true when the clause explicitly states, or unambiguously defines, what happens to an unused/unconsumed balance — that it persists/carries forward until consumed. A clause establishing that a credit applies to FUTURE periods (i.e. not the same period it was earned) is not, by itself, evidence that it survives indefinitely — those are different questions. If unstated, use "unclear", never default to true just because the credit is clearly not same-period-applicable. one_time is true only when the clause says the credit can be earned once — BUT "silent on repeatability" means the clause never addresses whether the SAME earning event recurs, which is different from the trigger condition's own window already being structurally recurring. When the trigger is itself defined over a repeating window the contract names elsewhere as recurring (e.g. "each Contract Year", "any calendar month", "the applicable calendar month", any anniversary-based or monthly/quarterly/annual period) — as opposed to a single named milestone (e.g. "processes more than 300,000 Transactions in each of three consecutive calendar months" describing ONE qualifying event, explicitly marked "one-time") — that recurring-window structure IS textual grounding for one_time: false, not silence requiring "unclear". A rebate whose trigger is evaluated fresh "during a Contract Year" (a term itself defined as "each consecutive 12-month period... or an anniversary") is structurally re-evaluated every Contract Year by the definition's own plural, ongoing framing — grade one_time false and explain the structural basis in reasoning, the same way you would for any other clear_from_source field. Reserve one_time "unclear" for when the trigger's own recurrence is genuinely ambiguous (e.g. a flat milestone with no defined window at all). It is entirely normal — and must be graded as such, not smoothed over — for a clause to state eligibility explicitly (application_state "clear_from_source") while saying nothing at all about survival/expiry (survival_state "decision_required"), or vice versa.
  ABSENCE OF A STATED RULE IS NOT EVIDENCE FOR TRUE OR FALSE, in either direction — this is the single most important discipline for this field, and the one most often gotten wrong. Specifically:
  - The TIMING of when a credit is earned, calculated, settled, or credited (e.g. "credited within 45 days after Contract Year-end", "calculated after the end of the applicable Contract Year") is a statement about WHEN, not about what happens to an unconsumed remainder — it must NEVER be read as implying carry_forward is false ("a deadline means a single, final settlement") or true. A settlement deadline answers a completely different question than survival of an unused balance; do not let the presence of ANY timing language pull carry_forward away from "unclear".
  - Broad application-scope language such as "applied against future amounts payable" or "applies to future periods" establishes WHERE a credit may be applied — it does NOT, by itself, establish HOW LONG it remains available if not immediately consumed. Do not read broad/indefinite-sounding application language as implying indefinite carry_forward = true; that conflates eligibility (already graded separately as application_state) with survival.
  - Only set carry_forward/one_time to a concrete value (and grade survival_state above "decision_required") when the clause contains an actual statement about the unused-balance/repeatability question itself — words to the effect of "carries forward", "expires after N periods", "may be earned only once", "may be earned again in a subsequent period", etc. A plausible-sounding inference chained from an unrelated fact (settlement timing, eligibility breadth, general commercial convention) is not a substitute for this and must not be used to justify anything above "unclear" with "decision_required" survival_state.
  - If the source is genuinely silent, either grade survival_state "decision_required" (proposed_interpretation.application_rule.carry_forward/one_time stay "unclear"), or — only when there is a commercially reasonable default worth suggesting — grade it "verdix_recommends" with your best concrete proposed value. Either way this remains a Verdix-side signal for the reviewer, never something this prompt should present as settled; provenance/whether it can execute is decided entirely downstream of this response, not here.
- Do not let application_state's or survival_state's uncertainty pull "state" down to "verdix_recommends"/"decision_required" when the trigger/value/cap facts are themselves fully explicit, and do not let either pull the other down — grade all three independently, exactly as instructed above.`
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
// A real reasoning sentence always contains at least one real word (a run
// of 3+ letters); a truncated, garbled, or otherwise malformed fragment
// ("g. g.", "", a lone punctuation run) doesn't — regardless of which
// `state` it was attached to, so this check applies unconditionally, not
// just to clear_from_source (which already has its own, separate 20-char/
// sourceClauseAvailable check below, scoped to that one state, and is
// deliberately left alone: a short-but-real reasoning like "Clear." is
// merely unconvincing, not malformed, and should still downgrade to
// verdix_recommends rather than being treated as unusable).
function looksLikeMalformedReasoning(text: string): boolean {
  return !/[a-zA-Z]{3,}/.test(text.trim())
}

export function validateProposalState(proposal: RuleProposal, sourceClauseAvailable: boolean): RuleProposal {
  let { reasoning } = proposal
  let { state, proposed_interpretation, application_state, survival_state } = proposal

  // Never render malformed/trivial reasoning text — downgrade to
  // decision_required with an honest placeholder rather than show a
  // reviewer something like "g. g." as Verdix's stated justification.
  if (looksLikeMalformedReasoning(reasoning)) {
    state = 'decision_required'
    proposed_interpretation = null
    reasoning = 'Verdix could not produce clear reasoning for this proposal — treat as an open reviewer decision.'
  }

  // A "decision_required" claim that still ships a fully-populated
  // proposed_interpretation is internally contradictory — the model may have
  // meant to flag genuine uncertainty about one field while still proposing
  // the rest; treat that as decision_required won, since "nothing
  // pre-selected" is the safer failure mode than silently trusting a
  // proposal the model itself called undecidable. Only clears the WHOLE
  // proposal when the main `state` itself is decision_required — a
  // service_credit whose application_state alone is decision_required still
  // needs its trigger/rate/cap fields (main `state`'s own content), just
  // not its application_rule sub-object (handled below).
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

  // application_state (service_credit only) — same three safety checks as
  // `state` above, applied independently and scoped to application_rule
  // specifically, so grading one aspect down never silently drags the other.
  //
  // Deliberately does NOT null out the whole application_rule sub-object the
  // way `state`/proposed_interpretation does above — "decision_required" for
  // application_state doesn't mean "nothing to show", it means the correct,
  // meaningful value IS eligible_component_keys: null (per
  // buildServiceCreditProposalPrompt's own instruction). Wiping the object
  // entirely used to strip that null down to undefined once it round-tripped
  // through confirm-rule's buildCreditApplicationRule (`if (!source &&
  // !existing) return null`), which persisted application_rule as an outright
  // null field instead of a flagged {eligible_component_keys: null,
  // requires_confirmation: true} object — invisible to every downstream
  // readiness check, exactly the "Confirm & apply silently resolves an
  // unstated policy" failure mode this whole split exists to prevent.
  // Instead, this only CORRECTS a contradiction between the two signals,
  // preserving the sub-object either way.
  if (application_state && proposed_interpretation && typeof proposed_interpretation === 'object') {
    const interp = proposed_interpretation as Record<string, unknown>
    const applicationRule = interp.application_rule as Record<string, unknown> | null | undefined

    if (application_state === 'clear_from_source') {
      const reasoningLooksSourced = reasoning.trim().length >= 20
      if (!sourceClauseAvailable || !reasoningLooksSourced) application_state = 'verdix_recommends'
    }

    // Contradiction: claims a confident state but the model left the one
    // field that actually decides scope unset — force decision_required
    // rather than trust a state with nothing concrete behind it. Only this
    // ONE direction is corrected: application_state can legitimately be
    // "decision_required" while eligible_component_keys is still populated
    // — e.g. Service Credit's eligible_component_keys is explicitly 'all'
    // (future amounts payable) while its carry-forward/expiry duration is
    // separately unstated, which also drives requires_confirmation true via
    // buildCreditApplicationRule's own carry_forward==='unclear' check.
    // Nulling eligible_component_keys just because application_state says
    // decision_required would incorrectly erase a genuinely clear scope.
    const eligibleKeys = applicationRule?.eligible_component_keys
    if (application_state !== 'decision_required' && (!applicationRule || eligibleKeys == null)) {
      application_state = 'decision_required'
    }
  }

  // survival_state (service_credit only) — same independent safety-check
  // pattern as application_state above, scoped to carry_forward/one_time
  // instead of eligible_component_keys. A credit can be "clear_from_source"
  // on eligibility while genuinely silent on survival (or vice versa) — see
  // buildServiceCreditProposalPrompt's guidance — so this must never be
  // derived from application_state, only validated against its own fields.
  if (survival_state && proposed_interpretation && typeof proposed_interpretation === 'object') {
    const interp = proposed_interpretation as Record<string, unknown>
    const applicationRule = interp.application_rule as Record<string, unknown> | null | undefined

    if (survival_state === 'clear_from_source') {
      const reasoningLooksSourced = reasoning.trim().length >= 20
      if (!sourceClauseAvailable || !reasoningLooksSourced) survival_state = 'verdix_recommends'
    }

    // Contradiction: claims a confident survival_state but left both
    // carry_forward and one_time unset/unclear — force decision_required.
    // Only this ONE direction is corrected, mirroring application_state's
    // own asymmetry: survival_state can legitimately be "decision_required"
    // while eligible_component_keys is fully resolved (that's the exact
    // scenario this split exists for), so nothing here touches eligibility.
    const carryForward = applicationRule?.carry_forward
    const oneTime = applicationRule?.one_time
    const survivalResolved = !!applicationRule && (carryForward === true || carryForward === false || oneTime === true || oneTime === false)
    if (survival_state !== 'decision_required' && !survivalResolved) {
      survival_state = 'decision_required'
    }
  }

  return { state, proposed_interpretation, reasoning, application_state, survival_state }
}
