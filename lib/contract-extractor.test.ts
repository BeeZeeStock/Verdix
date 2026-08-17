import { describe, it, expect } from 'vitest'
import { mergeExtractions, assignServiceCreditRuleIds } from './contract-extractor'
import type { ContractTerms } from './types'

// Minimal partial fixtures — mergeExtractions only reads a handful of
// top-level array fields plus a few scalars for scoreCompleteness/date
// correction, so the rest of the (large) ContractTerms shape is irrelevant
// here. Same as-cast pattern lib/contract-extractor.ts's own JSON.parse
// result uses.
function chunk(overrides: Partial<ContractTerms> = {}): ContractTerms {
  return {
    escalators: [],
    discounts: [],
    service_credits: [],
    overage_tiers: [],
    one_time_fees: [],
    ...overrides,
  } as ContractTerms
}

describe('mergeExtractions — service_credits (scenario: extraction)', () => {
  it('merges service_credits arrays across chunks and dedupes by description', () => {
    const merged = mergeExtractions([
      chunk({ service_credits: [{ description: 'Availability service credit' } as ContractTerms['service_credits'][number]] }),
      chunk({ service_credits: [
        { description: 'Availability service credit' } as ContractTerms['service_credits'][number], // duplicate — same chunk seen from another pass
        { description: 'Promotional credit' } as ContractTerms['service_credits'][number],
      ] }),
    ])
    expect(merged.service_credits.map(c => c.description)).toEqual(['Availability service credit', 'Promotional credit'])
  })

  it('assigns a stable credit_rule_id to every merged service credit', () => {
    const merged = mergeExtractions([
      chunk({ service_credits: [{ description: 'Availability service credit' } as ContractTerms['service_credits'][number]] }),
    ])
    expect(merged.service_credits).toHaveLength(1)
    expect(merged.service_credits[0].credit_rule_id).toBeTruthy()
  })

  it('never populates interpretation at merge time — extraction never marks a credit resolved', () => {
    const merged = mergeExtractions([
      chunk({ service_credits: [{ description: 'Availability service credit' } as ContractTerms['service_credits'][number]] }),
    ])
    expect(merged.service_credits[0].interpretation).toBeUndefined()
  })

  it('handles chunks with no service_credits field at all (predates the field)', () => {
    const merged = mergeExtractions([
      chunk({ service_credits: undefined as unknown as ContractTerms['service_credits'] }),
    ])
    expect(merged.service_credits).toEqual([])
  })
})

describe('assignServiceCreditRuleIds', () => {
  it('backfills an id only for credits missing one, preserving existing ids', () => {
    const result = assignServiceCreditRuleIds([
      { credit_rule_id: 'existing-id', description: 'A' },
      { description: 'B' },
    ])
    expect(result[0].credit_rule_id).toBe('existing-id')
    expect(result[1].credit_rule_id).toBeTruthy()
    expect(result[1].credit_rule_id).not.toBe('existing-id')
  })
})
