import { describe, it, expect } from 'vitest'
import {
  buildMinimumCommitmentPrompt,
  buildPartialPeriodPrompt,
  buildEscalatorPrompt,
  buildDiscountPrompt,
  buildTierCalculationPrompt,
  parseRuleInterpretationResponse,
  describeMissingFieldQuestions,
  describeWhatWillChange,
  optionsForRuleType,
  deriveSelectedOption,
  optionsForEdit,
  type MinimumCommitmentContext,
  type PartialPeriodContext,
  type EscalatorContext,
  type DiscountContext,
  type TierCalculationContext,
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
  it('lists Commercial Terms, Billing Configuration, Billing Engine, and Billing Schedule for a minimum commitment', () => {
    const items = describeWhatWillChange('minimum_commitment', 'SMS reminder')
    const components = items.map(i => i.component)
    expect(components).toEqual(['Commercial Terms', 'Billing Configuration', 'Billing Engine', 'Billing Schedule'])
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
