import { describe, it, expect } from 'vitest'
import {
  buildMinimumCommitmentPrompt,
  buildPartialPeriodPrompt,
  buildEscalatorPrompt,
  parseRuleInterpretationResponse,
  describeMissingFieldQuestions,
  describeWhatWillChange,
  optionsForRuleType,
  type MinimumCommitmentContext,
  type PartialPeriodContext,
  type EscalatorContext,
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
    for (const ruleType of ['minimum_commitment', 'partial_period', 'escalator'] as const) {
      const options = optionsForRuleType(ruleType)
      expect(options.length).toBeGreaterThan(1) // structured choices exist, not free-text-only
      expect(options.some(o => o.id === 'other')).toBe(true)
    }
  })
})
