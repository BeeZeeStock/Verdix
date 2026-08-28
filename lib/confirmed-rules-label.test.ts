import { describe, it, expect } from 'vitest'
import { deriveConfirmedRulesLabel } from './confirmed-rules-label'

describe('deriveConfirmedRulesLabel — Step 17E.3, item 4', () => {
  it('a single card whose only provenance is reviewer_policy (the real Remembill contract\'s current state) is labeled explicitly', () => {
    expect(deriveConfirmedRulesLabel(1, ['reviewer_policy'])).toBe('1 reviewer policy confirmed')
  })

  it('multiple cards, all reviewer_policy, pluralizes "policies" correctly', () => {
    expect(deriveConfirmedRulesLabel(2, ['reviewer_policy', 'reviewer_policy'])).toBe('2 reviewer policies confirmed')
  })

  it('a mix of reviewer_policy and contract_derived falls back to the generic, accurate "billing rule(s)" wording', () => {
    expect(deriveConfirmedRulesLabel(2, ['reviewer_policy', 'contract_derived'])).toBe('2 billing rules confirmed')
  })

  it('a card set that is entirely contract_derived never claims reviewer involvement', () => {
    expect(deriveConfirmedRulesLabel(1, ['contract_derived'])).toBe('1 billing rule confirmed')
  })

  it('no known provenance values at all (defensive — should not occur in practice) falls back to the generic wording rather than a false claim', () => {
    expect(deriveConfirmedRulesLabel(1, [null, undefined])).toBe('1 billing rule confirmed')
  })
})
