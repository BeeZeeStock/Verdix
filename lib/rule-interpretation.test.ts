import { describe, it, expect } from 'vitest'
import {
  buildMinimumCommitmentPrompt,
  buildPartialPeriodPrompt,
  buildEscalatorPrompt,
  buildDiscountPrompt,
  buildTierCalculationPrompt,
  buildMinimumCommitmentProposalPrompt,
  buildTierCalculationProposalPrompt,
  buildEscalatorProposalPrompt,
  buildPartialPeriodProposalPrompt,
  buildServiceCreditProposalPrompt,
  validateProposalState,
  parseRuleInterpretationResponse,
  describeMissingFieldQuestions,
  describeWhatWillChange,
  optionsForRuleType,
  deriveSelectedOption,
  optionsForEdit,
  getBaseFeeProrationOptions,
  type MinimumCommitmentContext,
  type PartialPeriodContext,
  type EscalatorContext,
  type DiscountContext,
  type TierCalculationContext,
  type RuleProposal,
} from './rule-interpretation'

const minCommitmentContext: MinimumCommitmentContext = {
  contractUnitType: 'SMS reminder',
  sourceClause: 'The customer pays at least SEK 5,000 per calendar quarter for SMS reminders.',
  currency: 'SEK',
  includedUnits: 500,
  tiers: [
    { tier_label: 'SMS reminders 501–2,000', from_unit: 501, to_unit: 2000, rate_per_unit: 1.1 },
    { tier_label: 'SMS reminders 2,001+', from_unit: 2001, to_unit: null, rate_per_unit: 0.85 },
  ],
  existingMinimumAmount: 5000,
  measurementPeriod: 'quarterly',
}

describe('buildMinimumCommitmentPrompt', () => {
  it('includes the source clause and reviewer input verbatim', () => {
    const reviewerInput = 'Apply SEK 5,000 as the minimum quarterly SMS charge after the 500 included messages. Do not add SEK 5,000 on top of usage.'
    const prompt = buildMinimumCommitmentPrompt(minCommitmentContext, reviewerInput)
    expect(prompt).toContain(minCommitmentContext.sourceClause!)
    expect(prompt).toContain(reviewerInput)
    expect(prompt).toContain('SMS reminder')
    expect(prompt).toContain('500 units')
  })

  it('includes the selected structured option context when provided', () => {
    const prompt = buildMinimumCommitmentPrompt(minCommitmentContext, 'yes please', 'floor_after_allowance')
    expect(prompt).toContain('Minimum charge floor')
  })

  it('omits option context for "other" or when unset', () => {
    const withOther = buildMinimumCommitmentPrompt(minCommitmentContext, 'x', 'other')
    const withNone  = buildMinimumCommitmentPrompt(minCommitmentContext, 'x')
    expect(withOther).not.toContain('reviewer selected')
    expect(withNone).not.toContain('reviewer selected')
  })
})

describe('buildPartialPeriodPrompt', () => {
  const context: PartialPeriodContext = {
    contractUnitType: 'SMS reminder',
    sourceClause: '§4.2 defines the minimum by calendar quarter.',
    currency: 'SEK',
    contractStartDate: '2026-08-11',
    contractEndDate: '2027-08-10',
    measurementPeriod: 'quarterly',
    minimumAmount: 5000,
  }
  it('includes contract dates, source clause, and reviewer input', () => {
    const prompt = buildPartialPeriodPrompt(context, 'Prorate by days for the first quarter')
    expect(prompt).toContain('2026-08-11')
    expect(prompt).toContain('2027-08-10')
    expect(prompt).toContain(context.sourceClause!)
    expect(prompt).toContain('Prorate by days for the first quarter')
  })

  it('asserts calendar-boundary resetting as a given fact for a plain metric minimum (subjectNoun unset)', () => {
    const prompt = buildPartialPeriodPrompt(context, 'Prorate by days')
    expect(prompt).toMatch(/resets on calendar boundaries stated in the contract/)
  })

  it('base/recurring fee (subjectNoun set): treats the calendar-vs-contract-anniversary anchor as the open question, never asserts calendar as given', () => {
    const feeContext: PartialPeriodContext = { ...context, subjectNoun: 'recurring fee' }
    const prompt = buildPartialPeriodPrompt(feeContext, 'Bill by contract month')
    expect(prompt).not.toMatch(/resets on calendar boundaries stated in the contract/)
    expect(prompt).toMatch(/does not state whether that cadence resets on fixed calendar boundaries or on the contract's own start-date anniversary/)
    expect(prompt).toContain('"reset_anchor": "contract_start" | "calendar"')
  })
})

describe('buildEscalatorPrompt', () => {
  const context: EscalatorContext = {
    sourceClause: 'CPI change + 2 percentage points, maximum 6% per 12-month period.',
    description: 'Annual CPI escalator',
    capPct: 6,
    effectiveDate: '2027-08-11',
    appliesFromYear: null,
  }
  it('includes the cap and source clause, never fabricates a rate', () => {
    const prompt = buildEscalatorPrompt(context, 'Apply CPI + 2pp capped at 6% annually')
    expect(prompt).toContain(context.sourceClause!)
    expect(prompt).toContain('6%')
    expect(prompt).toContain('Never invent a cap percentage')
  })
})

describe('parseRuleInterpretationResponse', () => {
  it('returns a proposal when every required field is present', () => {
    const raw = JSON.stringify({
      mode: 'floor', amount: 5000, period: 'quarterly',
      included_allowance_interaction: 'after_allowance', prorate_partial_periods: 'unclear',
      calculation_summary: 'max(tiered usage charge, 5000)',
    })
    const result = parseRuleInterpretationResponse('minimum_commitment', raw)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.proposal.mode).toBe('floor')
      expect(result.proposal.amount).toBe(5000)
    }
  })

  it('reports missing required fields instead of fabricating them', () => {
    const raw = JSON.stringify({ mode: 'floor' }) // amount + included_allowance_interaction missing
    const result = parseRuleInterpretationResponse('minimum_commitment', raw)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.missingFields).toContain('amount')
      expect(result.missingFields).toContain('included_allowance_interaction')
      expect(result.missingFields).not.toContain('mode')
    }
  })

  it('treats malformed JSON as fully missing rather than throwing', () => {
    const result = parseRuleInterpretationResponse('escalator', 'not json at all')
    expect(result.ok).toBe(false)
  })

  it('treats a response with no JSON object at all as fully missing', () => {
    const result = parseRuleInterpretationResponse('partial_period', 'I cannot determine this.')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.missingFields).toEqual(['prorate_partial_periods'])
  })

  it('escalator: treatment "not_applied" alone is a complete proposal — never demands index/frequency for a rule that is not running', () => {
    const raw = JSON.stringify({ treatment: 'not_applied', index: null, frequency: null, effective_date: null, cap_pct: null, calculation_method: null })
    const result = parseRuleInterpretationResponse('escalator', raw)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.proposal.treatment).toBe('not_applied')
  })

  it('escalator: treatment "applies" without index/frequency/calculation_method reports those as missing', () => {
    const raw = JSON.stringify({ treatment: 'applies' })
    const result = parseRuleInterpretationResponse('escalator', raw)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.missingFields).toContain('index')
      expect(result.missingFields).toContain('frequency')
      expect(result.missingFields).toContain('calculation_method')
    }
  })

  it('escalator: missing treatment entirely is reported as missing, never defaulted to "applies"', () => {
    const raw = JSON.stringify({ index: 'CPI', frequency: 'annual', calculation_method: 'CPI + 2pp' })
    const result = parseRuleInterpretationResponse('escalator', raw)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.missingFields).toContain('treatment')
  })

  it('base_fee_proration: reset_anchor alone is a complete proposal when contract_start — prorate_partial_periods is moot once no partial period can occur', () => {
    const raw = JSON.stringify({ reset_anchor: 'contract_start', calculation_summary: 'Full fee every contract month.' })
    const result = parseRuleInterpretationResponse('base_fee_proration', raw)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.proposal.reset_anchor).toBe('contract_start')
  })

  it('base_fee_proration: reset_anchor "calendar" without prorate_partial_periods reports it as missing', () => {
    const raw = JSON.stringify({ reset_anchor: 'calendar', calculation_summary: 'Depends on proration.' })
    const result = parseRuleInterpretationResponse('base_fee_proration', raw)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.missingFields).toContain('prorate_partial_periods')
  })

  it('base_fee_proration: missing reset_anchor entirely is reported as missing, never defaulted to calendar', () => {
    const raw = JSON.stringify({ prorate_partial_periods: false })
    const result = parseRuleInterpretationResponse('base_fee_proration', raw)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.missingFields).toContain('reset_anchor')
  })
})

describe('deriveSelectedOption', () => {
  it('maps a floor + after_allowance minimum commitment back to floor_after_allowance', () => {
    expect(deriveSelectedOption('minimum_commitment', { mode: 'floor', included_allowance_interaction: 'after_allowance' })).toBe('floor_after_allowance')
  })
  it('maps an additive minimum commitment back to additive', () => {
    expect(deriveSelectedOption('minimum_commitment', { mode: 'additive' })).toBe('additive')
  })
  it('maps escalator treatment "not_applied" back to the not_applied option, never a CPI/fixed guess', () => {
    expect(deriveSelectedOption('escalator', { treatment: 'not_applied', index: null })).toBe('not_applied')
  })
  it('falls back to "other" for an interpretation that does not cleanly match a structured option', () => {
    expect(deriveSelectedOption('minimum_commitment', { mode: 'prepaid_commitment' })).toBe('other')
  })
  it('returns null when there is no approved interpretation to derive from', () => {
    expect(deriveSelectedOption('minimum_commitment', null)).toBeNull()
  })
  it('maps reset_anchor: contract_start back to the contract_month option for base_fee_proration, regardless of prorate_partial_periods', () => {
    expect(deriveSelectedOption('base_fee_proration', { reset_anchor: 'contract_start', prorate_partial_periods: false })).toBe('contract_month')
  })
  it('maps reset_anchor: calendar + prorate false back to calendar_full for recurring_fee_proration', () => {
    expect(deriveSelectedOption('recurring_fee_proration', { reset_anchor: 'calendar', prorate_partial_periods: false })).toBe('calendar_full')
  })
  it('maps reset_anchor: calendar + prorate true + days back to calendar_prorate_days', () => {
    expect(deriveSelectedOption('base_fee_proration', { reset_anchor: 'calendar', prorate_partial_periods: true, proration_method: 'days' })).toBe('calendar_prorate_days')
  })
})

describe('optionsForEdit', () => {
  it('labels the option matching the current interpretation "Keep as..." and every other "Change to..."', () => {
    const options = optionsForEdit('minimum_commitment', { mode: 'floor', included_allowance_interaction: 'after_allowance' })
    const current = options.find(o => o.id === 'floor_after_allowance')!
    const other = options.find(o => o.id === 'additive')!
    expect(current.label).toMatch(/^Keep as /)
    expect(other.label).toMatch(/^Change to /)
  })

  it('leaves the "other" escape hatch label untouched regardless of current interpretation', () => {
    const options = optionsForEdit('minimum_commitment', { mode: 'floor', included_allowance_interaction: 'after_allowance' })
    const otherOption = options.find(o => o.id === 'other')!
    expect(otherOption.label).toBe('Other / describe treatment')
  })

  it('falls back to plain (unprefixed-current) option set when there is no current interpretation yet', () => {
    const options = optionsForEdit('escalator', null)
    expect(options.every(o => o.id === 'other' || o.label.startsWith('Change to'))).toBe(true)
  })
})

describe('describeMissingFieldQuestions', () => {
  it('maps each missing field to a specific human question, not a generic message', () => {
    const questions = describeMissingFieldQuestions(['included_allowance_interaction', 'amount'])
    expect(questions[0]).toMatch(/before or after the included allowance/)
    expect(questions[1]).toMatch(/minimum amount/)
  })
})

describe('describeWhatWillChange', () => {
  it('lists Commercial Terms, Billing Configuration, Billing Engine, Billing Schedule, Contract Value, and Graphical View for a minimum commitment', () => {
    const items = describeWhatWillChange('minimum_commitment', 'SMS reminder')
    const components = items.map(i => i.component)
    expect(components).toEqual(['Commercial Terms', 'Billing Configuration', 'Billing Engine', 'Billing Schedule', 'Contract Value', 'Graphical View'])
  })

  it('adds a Usage Source dependency warning when the meter mapping is unconfirmed', () => {
    const items = describeWhatWillChange('minimum_commitment', 'SMS reminder', { meterMappingConfirmed: false })
    expect(items.some(i => i.component === 'Usage Source')).toBe(true)
  })

  it('omits the dependency warning once the meter mapping is confirmed', () => {
    const items = describeWhatWillChange('minimum_commitment', 'SMS reminder', { meterMappingConfirmed: true })
    expect(items.some(i => i.component === 'Usage Source')).toBe(false)
  })

  it('describes escalator-specific changes for the escalator rule type', () => {
    const items = describeWhatWillChange('escalator', null)
    expect(items.some(i => i.change.includes('escalation formula'))).toBe(true)
  })
})

describe('optionsForRuleType', () => {
  it('always includes an "Other / describe treatment" escape hatch alongside structured choices', () => {
    for (const ruleType of ['minimum_commitment', 'partial_period', 'escalator', 'discount', 'tier_calculation'] as const) {
      const options = optionsForRuleType(ruleType)
      expect(options.length).toBeGreaterThan(1) // structured choices exist, not free-text-only
      expect(options.some(o => o.id === 'other')).toBe(true)
    }
  })
})

describe('getBaseFeeProrationOptions', () => {
  it('omits the contract-month option when no contractPeriodLabel is given (contract starts on day 1 — no distinct framing exists)', () => {
    const options = getBaseFeeProrationOptions('month', null)
    expect(options.some(o => o.id === 'contract_month')).toBe(false)
    expect(options.some(o => o.id === 'calendar_full')).toBe(true)
  })

  it('offers "full fee per contract month" as its own first-class option, distinct from every calendar-boundary variant, when a contractPeriodLabel is known', () => {
    const options = getBaseFeeProrationOptions('month', '17th–16th')
    const contractMonth = options.find(o => o.id === 'contract_month')
    expect(contractMonth).toBeDefined()
    expect(contractMonth!.label).toContain('17th–16th')
    // A real choice among peers, not a variant of "prorate or bill full" —
    // calendar_full/prorate_days/prorate_months all still exist alongside it.
    expect(options.some(o => o.id === 'calendar_full')).toBe(true)
    expect(options.some(o => o.id === 'calendar_prorate_days')).toBe(true)
    expect(options.some(o => o.id === 'calendar_prorate_months')).toBe(true)
    expect(options.some(o => o.id === 'other')).toBe(true)
  })
})

describe('buildTierCalculationPrompt', () => {
  const context: TierCalculationContext = {
    contractUnitType: 'API call',
    sourceClause: 'Units 1–100: SEK 10/unit; 101–200: SEK 8/unit',
    currency: 'SEK',
    tiers: [
      { tier_label: 'Tier 1', from_unit: 1, to_unit: 100, rate_per_unit: 10 },
      { tier_label: 'Tier 2', from_unit: 101, to_unit: 200, rate_per_unit: 8 },
    ],
  }
  it('includes the source clause, tier table, and reviewer input', () => {
    const prompt = buildTierCalculationPrompt(context, 'This is graduated — each band only covers units inside it')
    expect(prompt).toContain(context.sourceClause!)
    expect(prompt).toContain('This is graduated')
    expect(prompt).toContain('API call')
    expect(prompt).toContain('"method"')
    expect(prompt).toContain('"worked_example"')
  })

  it('never defaults method to graduated — explicitly instructs the model not to assume it', () => {
    const prompt = buildTierCalculationPrompt(context, 'not sure')
    expect(prompt).toMatch(/never default to "graduated"/i)
  })

  it('includes the selected structured option context when provided', () => {
    const prompt = buildTierCalculationPrompt(context, 'yes', 'volume')
    expect(prompt).toContain('Volume / all-units')
  })
})

describe('tier_calculation validation', () => {
  it('requires method and calculation_summary, never lets a partial response through', () => {
    const raw = JSON.stringify({ method: 'graduated' })
    const result = parseRuleInterpretationResponse('tier_calculation', raw)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.missingFields).toContain('calculation_summary')
  })

  it('accepts a fully specified proposal', () => {
    const raw = JSON.stringify({
      method: 'volume', calculation_summary: 'Whole quantity billed at the tier it falls into',
      worked_example: 'At 150 units: 150 * 8 = 1,200',
    })
    const result = parseRuleInterpretationResponse('tier_calculation', raw)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.proposal.method).toBe('volume')
  })
})

describe('deriveSelectedOption / optionsForEdit for tier_calculation', () => {
  it('maps method back to the matching structured option', () => {
    expect(deriveSelectedOption('tier_calculation', { method: 'graduated' })).toBe('graduated')
    expect(deriveSelectedOption('tier_calculation', { method: 'volume' })).toBe('volume')
    expect(deriveSelectedOption('tier_calculation', { method: 'block' })).toBe('block')
    expect(deriveSelectedOption('tier_calculation', { method: 'custom' })).toBe('other')
  })

  it('labels the current method "Keep as..." in edit mode', () => {
    const options = optionsForEdit('tier_calculation', { method: 'graduated' })
    const current = options.find(o => o.id === 'graduated')!
    const other = options.find(o => o.id === 'volume')!
    expect(current.label).toMatch(/^Keep as /)
    expect(other.label).toMatch(/^Change to /)
  })
})

describe('describeWhatWillChange for tier_calculation', () => {
  it('describes the graduated/volume/block propagation to the Billing Engine', () => {
    const items = describeWhatWillChange('tier_calculation', 'API call')
    expect(items.some(i => i.component === 'Billing Engine' && i.change.includes('graduated/volume/block'))).toBe(true)
  })
})

describe('buildDiscountPrompt', () => {
  const context: DiscountContext = {
    sourceClause: 'Units 1–100: SEK 10/unit; 101–200: SEK 8/unit; 201+: SEK 6/unit',
    description: 'Volume discount schedule',
    currency: 'SEK',
    existingPct: null,
    existingAmount: null,
    extractedType: 'volume',
    appliesTo: 'SMS reminder usage',
  }
  it('includes the source clause, reviewer input, and both tier_method and tiers in the required schema', () => {
    const prompt = buildDiscountPrompt(context, 'This is a staircase — each band only applies to units inside it')
    expect(prompt).toContain(context.sourceClause!)
    expect(prompt).toContain('This is a staircase')
    expect(prompt).toContain('"tier_method"')
    expect(prompt).toContain('"tiers"')
    expect(prompt).toContain('"worked_example"')
  })

  it('never defaults tier_method to graduated — explicitly instructs the model not to assume it', () => {
    const prompt = buildDiscountPrompt(context, 'not sure how the tiers work')
    expect(prompt).toMatch(/never default to "graduated"/i)
  })

  it('includes the selected structured option context when provided', () => {
    const prompt = buildDiscountPrompt(context, 'yes', 'volume')
    expect(prompt).toContain('Volume / all-units')
  })
})

describe('discount validation — graduated vs volume ambiguity is never silently resolved', () => {
  it('a flat discount does not require tier_method/tiers', () => {
    const raw = JSON.stringify({
      discount_type: 'flat_percentage', discount_basis: 'percentage', applies_to: 'usage charge',
      tier_method: null, tiers: null,
    })
    const result = parseRuleInterpretationResponse('discount', raw)
    expect(result.ok).toBe(true)
  })

  it('a tiered_discount without tier_method and tiers is reported as missing, never assumed graduated', () => {
    const raw = JSON.stringify({ discount_type: 'tiered_discount', discount_basis: 'percentage', applies_to: 'usage charge' })
    const result = parseRuleInterpretationResponse('discount', raw)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.missingFields).toContain('tier_method')
      expect(result.missingFields).toContain('tiers')
    }
  })

  it('a volume_discount without tier_method and tiers is reported as missing', () => {
    const raw = JSON.stringify({ discount_type: 'volume_discount', discount_basis: 'percentage', applies_to: 'usage charge' })
    const result = parseRuleInterpretationResponse('discount', raw)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.missingFields).toContain('tier_method')
  })

  it('a fully specified tiered discount with graduated tier_method is accepted', () => {
    const raw = JSON.stringify({
      discount_type: 'tiered_discount', discount_basis: 'percentage', applies_to: 'usage charge',
      tier_method: 'graduated',
      tiers: [{ from_unit: 1, to_unit: 100, value: 0 }, { from_unit: 101, to_unit: 200, value: 10 }, { from_unit: 201, to_unit: null, value: 20 }],
      worked_example: 'At 150 units: first 100 at 0%, next 50 at 10% off.',
    })
    const result = parseRuleInterpretationResponse('discount', raw)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.proposal.tier_method).toBe('graduated')
  })
})

describe('deriveSelectedOption / optionsForEdit for discount', () => {
  it('maps tier_method back to the matching structured option', () => {
    expect(deriveSelectedOption('discount', { tier_method: 'graduated' })).toBe('graduated')
    expect(deriveSelectedOption('discount', { tier_method: 'volume' })).toBe('volume')
    expect(deriveSelectedOption('discount', { tier_method: 'block' })).toBe('block')
  })

  it('labels the current tier method "Keep as..." in edit mode', () => {
    const options = optionsForEdit('discount', { tier_method: 'graduated' })
    const current = options.find(o => o.id === 'graduated')!
    const other = options.find(o => o.id === 'volume')!
    expect(current.label).toMatch(/^Keep as /)
    expect(other.label).toMatch(/^Change to /)
  })
})

// ══════════════════════════════════════════════════════════════════════════
// The propose pipeline — Verdix interprets first, the human confirms.
// ══════════════════════════════════════════════════════════════════════════

function proposal(overrides: Partial<RuleProposal> = {}): RuleProposal {
  return {
    state: 'clear_from_source',
    proposed_interpretation: { mode: 'floor', amount: 2000 },
    reasoning: 'The contract describes this as a "minimum processing charge" applied as a floor.',
    ...overrides,
  }
}

describe('buildMinimumCommitmentProposalPrompt — scenario: monthly AI processing minimum', () => {
  it('surfaces "minimum charge" framing as textual support for a floor recommendation', () => {
    const prompt = buildMinimumCommitmentProposalPrompt({
      contractUnitType: 'AI processing',
      sourceClause: 'A minimum processing charge of SEK 2,000 per calendar month applies to AI processing usage.',
      currency: 'SEK',
      includedUnits: 100000,
      tiers: [{ tier_label: 'Tier 1', from_unit: 100001, to_unit: null, rate_per_unit: 0.02 }],
      existingMinimumAmount: 2000,
      measurementPeriod: 'monthly',
    })
    expect(prompt).toContain('minimum charge')
    expect(prompt).toContain('AI processing')
    expect(prompt).toMatch(/"state":/)
    expect(prompt).toMatch(/clear_from_source/)
  })

  it('never claims clear_from_source is the only allowed state — decision_required and verdix_recommends are always offered', () => {
    const prompt = buildMinimumCommitmentProposalPrompt({
      contractUnitType: 'AI processing', sourceClause: null, currency: 'SEK', includedUnits: 0, tiers: [], existingMinimumAmount: null, measurementPeriod: null,
    })
    expect(prompt).toContain('verdix_recommends')
    expect(prompt).toContain('decision_required')
  })
})

describe('buildServiceCreditProposalPrompt — application_state split (Growth Credit / Annual Rebate scenario)', () => {
  it('asks for application_state as a field independent of state, with guidance not to let one drag down the other', () => {
    const prompt = buildServiceCreditProposalPrompt({
      sourceClause: 'A Growth Credit of SEK 110,000 is earned upon processing more than 2,000,000 transactions in 3 consecutive calendar months. The credit applies only to future transaction-processing fees and carries forward until consumed.',
      description: 'Growth Credit', creditType: 'earned', statedPct: null, statedAmount: 110_000, currency: 'SEK',
    })
    expect(prompt).toContain('"application_state": "clear_from_source" | "verdix_recommends" | "decision_required"')
    expect(prompt).toContain('"survival_state": "clear_from_source" | "verdix_recommends" | "decision_required"')
    expect(prompt).toMatch(/graded INDEPENDENTLY of "state"/)
    expect(prompt).toMatch(/do not let application_state's or survival_state's uncertainty pull "state" down/i)
  })

  it('instructs decision_required specifically for application_state when eligible_component_keys is unstated, without forcing the same for state', () => {
    const prompt = buildServiceCreditProposalPrompt({
      sourceClause: 'Customer receives a rebate of 5% of transaction-processing fees paid in the prior Contract Year, credited within 45 days.',
      description: 'Annual Rebate', creditType: 'rebate', statedPct: 5, statedAmount: null, currency: 'SEK',
    })
    expect(prompt).toMatch(/set eligible_component_keys to null and grade application_state "decision_required"/)
  })

  // Real-world regression fixture — TEST-PAY-002's actual signed contract,
  // Section 6 (Annual Volume Rebate), verified verbatim against the PDF
  // itself, not extraction output. Extraction had originally captured only
  // the rebate's trigger/basis sentence into source_clause/description and
  // dropped this eligibility sentence entirely, which produced a false
  // "application scope: decision required" for several rounds until the
  // PDF was read directly. Guards against BOTH directions of regression:
  // the full clause (with the exclusion list) must be treated as
  // application-eligibility-bearing, while the shorter clause one test
  // above (basis only, no exclusion list) must still correctly stay
  // decision_required — the exclusion list is precisely what distinguishes
  // "states basis only" from "states basis AND eligibility".
  it('TEST-PAY-002 Section 6 regression: full clause (with the platform/chargeback/other-fees exclusion list) reaches the prompt intact and is treated as eligibility-bearing, not basis-only', () => {
    const SECTION_6_CLAUSE = 'For purposes of this clause, the rebate applies only to transaction-processing fees under Section 3. The rebate does not apply to: platform fees; chargeback fees; other fees or charges.'
    const prompt = buildServiceCreditProposalPrompt({
      sourceClause: SECTION_6_CLAUSE,
      description: 'Annual volume rebate: 5% of transaction-processing fees paid for the Contract Year if more than 2,000,000 Transactions are processed in that year',
      creditType: 'rebate', statedPct: 5, statedAmount: null, currency: 'SEK',
    })
    // The exact clause must reach the AI verbatim — guards against a
    // regression of the sourceClause ?? description bug (which silently
    // discarded whichever field wasn't chosen) or any future truncation.
    expect(prompt).toContain(SECTION_6_CLAUSE)
    // Guidance must distinguish "states basis" from "states basis AND what
    // it may be applied against" — this is the textual signal the exclusion
    // list provides that the shorter clause (tested above) lacks.
    expect(prompt).toMatch(/a clause stating what a credit is computed FROM[\s\S]*does not, by itself, state what it may be applied AGAINST/)
  })

  it('TEST-PAY-002 Section 6 regression: validateProposalState preserves a correctly-graded clear_from_source eligibility read of the real clause, never downgrading or nulling it', () => {
    const result = validateProposalState({
      state: 'clear_from_source',
      application_state: 'clear_from_source',
      survival_state: 'decision_required',
      proposed_interpretation: {
        trigger_type: 'usage_threshold', credit_value: 5,
        application_rule: { eligible_component_keys: ['transaction_processing'], carry_forward: 'unclear', one_time: false },
      },
      reasoning: 'The clause states the rebate applies only to transaction-processing fees under Section 3 and does not apply to platform fees, chargeback fees, or other fees or charges — application scope is explicit, though the contract does not address whether an unapplied balance carries forward.',
    }, true)
    expect(result.application_state).toBe('clear_from_source')
    expect(result.survival_state).toBe('decision_required')
    const appRule = (result.proposed_interpretation as Record<string, unknown>).application_rule as Record<string, unknown>
    expect(appRule.eligible_component_keys).toEqual(['transaction_processing'])
  })
})

describe('buildTierCalculationProposalPrompt — scenario: graduated pricing explicit in source', () => {
  it('instructs clear_from_source for explicit "each band applies only to requests falling within that band" language', () => {
    const prompt = buildTierCalculationProposalPrompt({
      contractUnitType: 'API request',
      sourceClause: 'Each pricing band applies only to requests falling within that band.',
      currency: 'SEK',
      tiers: [{ tier_label: 'Tier 1', from_unit: 1, to_unit: 1000, rate_per_unit: 1 }],
    })
    expect(prompt).toContain('each band applies only to requests falling within that band')
    expect(prompt).toMatch(/graduated\/staircase language.*clear_from_source/i)
  })

  it('never treats a bare rate table with no mechanism language as a safe default to graduated', () => {
    const prompt = buildTierCalculationProposalPrompt({
      contractUnitType: 'API request', sourceClause: '(no language describing mechanism)', currency: 'SEK',
      tiers: [{ tier_label: 'Tier 1', from_unit: 1, to_unit: 1000, rate_per_unit: 1 }],
    })
    expect(prompt).toMatch(/never a safe default/i)
  })
})

describe('buildEscalatorProposalPrompt — scenario: HICP renewal indexation with discretion', () => {
  it('preserves the literal index name (HICP) and instructs it is never normalized to CPI', () => {
    const prompt = buildEscalatorProposalPrompt({
      sourceClause: 'On renewal, the platform subscription may be increased by the annual change in HICP, subject to a maximum increase of 4%.',
      description: 'HICP renewal indexation',
      capPct: 4,
      effectiveDate: '2027-08-17',
      appliesFromYear: null,
    })
    expect(prompt).toContain('HICP')
    expect(prompt).toMatch(/NEVER normalize a named index like "HICP" to "CPI"/)
  })

  it('treats discretionary "may be increased" language as textual support for requiring renewal approval, not silence', () => {
    const prompt = buildEscalatorProposalPrompt({
      sourceClause: 'may be increased by the annual change in HICP, subject to a maximum increase of 4%.',
      description: 'HICP renewal indexation', capPct: 4, effectiveDate: '2027-08-17', appliesFromYear: null,
    })
    expect(prompt).toMatch(/"may be increased"[\s\S]*requires_renewal_approval/)
    expect(prompt).not.toMatch(/default.*automatic/i)
  })

  it('distinguishes renewal-triggered indexation from an ordinary recurring annual escalator', () => {
    const prompt = buildEscalatorProposalPrompt({
      sourceClause: 'On renewal, the fee may be increased by HICP.', description: 'HICP renewal indexation',
      capPct: 4, effectiveDate: '2027-08-17', appliesFromYear: null,
    })
    expect(prompt).toMatch(/renewal_triggered.*true only when/i)
  })
})

describe('buildPartialPeriodProposalPrompt — scenario: contract silent on partial-month treatment', () => {
  it('instructs decision_required as the default absent explicit partial-period language', () => {
    const prompt = buildPartialPeriodProposalPrompt({
      contractUnitType: 'AI processing', sourceClause: 'SEK 2,000/month minimum.', currency: 'SEK',
      contractStartDate: '2026-08-17', contractEndDate: '2027-08-16', measurementPeriod: 'monthly', minimumAmount: 2000,
    })
    expect(prompt).toMatch(/you MUST use "decision_required"/)
    expect(prompt).toMatch(/silence on partial-period treatment is silence, not evidence for either answer/i)
  })

  it('base/recurring fee (TEST-PAY-002 scenario): asks about the reset_anchor itself rather than assuming calendar boundaries, and still defaults to decision_required absent explicit anchor language', () => {
    const prompt = buildPartialPeriodProposalPrompt({
      contractUnitType: 'platform subscription fee', sourceClause: null, currency: 'SEK',
      contractStartDate: '2026-08-17', contractEndDate: '2028-08-16', measurementPeriod: 'monthly', minimumAmount: 38_500,
      subjectNoun: 'recurring fee',
    })
    expect(prompt).not.toMatch(/resets on calendar boundaries stated in the contract/)
    expect(prompt).toContain('"reset_anchor": "contract_start"|"calendar"')
    expect(prompt).toMatch(/you MUST use "decision_required"/)
    expect(prompt).toMatch(/silence on the anchor question is silence, not evidence for either answer/i)
  })
})

describe('validateProposalState — safety net, only ever downgrades', () => {
  it('leaves a well-formed clear_from_source proposal untouched when a source clause is available', () => {
    const result = validateProposalState(proposal({ state: 'clear_from_source' }), true)
    expect(result.state).toBe('clear_from_source')
    expect(result.proposed_interpretation).not.toBeNull()
  })

  it('downgrades clear_from_source to verdix_recommends when no source clause is available', () => {
    const result = validateProposalState(proposal({ state: 'clear_from_source' }), false)
    expect(result.state).toBe('verdix_recommends')
  })

  it('downgrades clear_from_source to verdix_recommends when reasoning is too short to be a real quote', () => {
    const result = validateProposalState(proposal({ state: 'clear_from_source', reasoning: 'Clear.' }), true)
    expect(result.state).toBe('verdix_recommends')
  })

  it('nulls out proposed_interpretation when state is decision_required but the model still populated one — nothing pre-selected wins', () => {
    const result = validateProposalState(proposal({ state: 'decision_required', proposed_interpretation: { mode: 'floor', amount: 2000 } }), true)
    expect(result.state).toBe('decision_required')
    expect(result.proposed_interpretation).toBeNull()
  })

  it('forces decision_required when proposed_interpretation is null regardless of the stated state', () => {
    const result = validateProposalState(proposal({ state: 'clear_from_source', proposed_interpretation: null }), true)
    expect(result.state).toBe('decision_required')
  })

  it('never upgrades a decision_required proposal to a more confident state', () => {
    const result = validateProposalState(proposal({ state: 'decision_required', proposed_interpretation: null, reasoning: 'The agreement does not address partial-month treatment.' }), true)
    expect(result.state).toBe('decision_required')
  })

  describe('application_state (service_credit split)', () => {
    it('Growth Credit scenario: state stays clear_from_source and application_state also clear_from_source when both are genuinely explicit — one being open never drags the other down', () => {
      const result = validateProposalState(proposal({
        state: 'clear_from_source',
        application_state: 'clear_from_source',
        proposed_interpretation: { trigger_type: 'usage_threshold', credit_value: 110_000, application_rule: { eligible_component_keys: ['transaction_processing'], carry_forward: true } },
        reasoning: 'The clause states the credit applies only to future transaction-processing fees and carries forward until consumed.',
      }), true)
      expect(result.state).toBe('clear_from_source')
      expect(result.application_state).toBe('clear_from_source')
      expect((result.proposed_interpretation as Record<string, unknown>).application_rule).not.toBeNull()
    })

    it('Annual Rebate scenario: state clear_from_source (trigger/value explicit) while application_state is decision_required (offset target unstated) — keeps application_rule as a flagged object (eligible_component_keys: null), never wipes it to null outright', () => {
      const result = validateProposalState(proposal({
        state: 'clear_from_source',
        application_state: 'decision_required',
        proposed_interpretation: { trigger_type: 'usage_threshold', credit_value: 5, application_rule: { eligible_component_keys: null } },
        reasoning: 'The clause states a 5% rebate of transaction-processing fees paid but never says what future charges it may offset.',
      }), true)
      expect(result.state).toBe('clear_from_source')
      expect(result.application_state).toBe('decision_required')
      expect(result.proposed_interpretation).not.toBeNull()
      expect((result.proposed_interpretation as Record<string, unknown>).trigger_type).toBe('usage_threshold')
      // Critical: application_rule must survive as a real object so
      // confirm-rule's buildCreditApplicationRule computes
      // requires_confirmation: true on it — wiping the whole sub-object to
      // null would instead persist application_rule as an outright null
      // field, invisible to every downstream readiness check (the exact
      // "Confirm & apply silently resolves an unstated policy" bug).
      const appRule = (result.proposed_interpretation as Record<string, unknown>).application_rule as Record<string, unknown>
      expect(appRule).not.toBeNull()
      expect(appRule.eligible_component_keys).toBeNull()
    })

    it('Service Credit scenario: eligibility is explicit ("all") so application_state is clear_from_source, while survival_state is decision_required (carry-forward/expiry unstated) — the two grades diverge on the SAME credit, neither erasing the other\'s resolved sub-field', () => {
      const result = validateProposalState(proposal({
        state: 'clear_from_source',
        application_state: 'clear_from_source',
        survival_state: 'decision_required',
        proposed_interpretation: { trigger_type: 'sla_breach', credit_value: 5_500, cap_amount: 55_000, application_rule: { eligible_component_keys: 'all', carry_forward: 'unclear', one_time: 'unclear' } },
        reasoning: 'The clause states the credit applies against future amounts payable but does not state how long an unused credit survives, or whether it is one-time.',
      }), true)
      const appRule = (result.proposed_interpretation as Record<string, unknown>).application_rule as Record<string, unknown>
      expect(appRule.eligible_component_keys).toBe('all')
      expect(appRule.carry_forward).toBe('unclear')
      expect(result.application_state).toBe('clear_from_source')
      expect(result.survival_state).toBe('decision_required')
    })

    it('corrects the contradiction: application_state claims a confident state but eligible_component_keys is unset — forces decision_required rather than trusting an empty confidence claim', () => {
      const result = validateProposalState(proposal({
        state: 'clear_from_source',
        application_state: 'verdix_recommends',
        proposed_interpretation: { trigger_type: 'usage_threshold', application_rule: { eligible_component_keys: null } },
      }), true)
      expect(result.application_state).toBe('decision_required')
    })

    it('downgrades application_state clear_from_source to verdix_recommends when no source clause is available, independent of state', () => {
      const result = validateProposalState(proposal({
        state: 'clear_from_source', application_state: 'clear_from_source',
        proposed_interpretation: { trigger_type: 'usage_threshold', application_rule: { eligible_component_keys: 'all' } },
      }), false)
      expect(result.application_state).toBe('verdix_recommends')
    })

    it('is undefined for rule types that never asked for it (no regression for the existing single-state cards)', () => {
      const result = validateProposalState(proposal({ state: 'clear_from_source' }), true)
      expect(result.application_state).toBeUndefined()
    })
  })

  describe('survival_state (independent third grade — carry_forward/one_time)', () => {
    it('Growth Credit scenario: carry_forward explicitly true and one_time explicitly true — survival_state clear_from_source, independent of application_state', () => {
      const result = validateProposalState(proposal({
        state: 'clear_from_source',
        application_state: 'clear_from_source',
        survival_state: 'clear_from_source',
        proposed_interpretation: { trigger_type: 'earned_milestone', application_rule: { eligible_component_keys: ['transaction_processing'], carry_forward: true, one_time: true } },
        reasoning: 'The clause states the credit is one-time and carries forward until consumed.',
      }), true)
      expect(result.survival_state).toBe('clear_from_source')
      expect(result.application_state).toBe('clear_from_source')
    })

    it('Annual Rebate scenario: eligibility unstated (application_state decision_required) AND survival unstated (survival_state decision_required) — both open independently, neither derived from the other', () => {
      const result = validateProposalState(proposal({
        state: 'clear_from_source',
        application_state: 'decision_required',
        survival_state: 'decision_required',
        proposed_interpretation: { trigger_type: 'usage_threshold', application_rule: { eligible_component_keys: null, carry_forward: 'unclear', one_time: 'unclear' } },
        reasoning: 'The clause states a 5% rebate but never says what it may offset or how long it survives unused.',
      }), true)
      expect(result.application_state).toBe('decision_required')
      expect(result.survival_state).toBe('decision_required')
    })

    it('corrects the contradiction: survival_state claims a confident state but both carry_forward and one_time are unset/unclear — forces decision_required', () => {
      const result = validateProposalState(proposal({
        state: 'clear_from_source',
        survival_state: 'verdix_recommends',
        proposed_interpretation: { trigger_type: 'usage_threshold', application_rule: { eligible_component_keys: 'all', carry_forward: 'unclear', one_time: 'unclear' } },
      }), true)
      expect(result.survival_state).toBe('decision_required')
    })

    it('does NOT force survival_state decision_required just because eligible_component_keys is null — the two questions stay independent', () => {
      const result = validateProposalState(proposal({
        state: 'clear_from_source',
        application_state: 'decision_required',
        survival_state: 'clear_from_source',
        proposed_interpretation: { trigger_type: 'usage_threshold', application_rule: { eligible_component_keys: null, carry_forward: true, one_time: false } },
        reasoning: 'The clause states the credit carries forward and is not one-time, but never says what it may be applied against.',
      }), true)
      expect(result.application_state).toBe('decision_required')
      expect(result.survival_state).toBe('clear_from_source')
    })

    it('downgrades survival_state clear_from_source to verdix_recommends when no source clause is available, independent of state/application_state', () => {
      const result = validateProposalState(proposal({
        state: 'clear_from_source', survival_state: 'clear_from_source',
        proposed_interpretation: { trigger_type: 'usage_threshold', application_rule: { carry_forward: true } },
      }), false)
      expect(result.survival_state).toBe('verdix_recommends')
    })

    it('is undefined for rule types that never asked for it', () => {
      const result = validateProposalState(proposal({ state: 'clear_from_source' }), true)
      expect(result.survival_state).toBeUndefined()
    })
  })
})
