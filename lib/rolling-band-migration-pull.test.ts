import { describe, it, expect } from 'vitest'
import {
  resolveNextContractPeriodStart, resolveNextRenewalTermStart, resolveEffectiveCommercialState,
  compileTransitionEffectiveRule, resolveEffectiveDateFromRule,
  resolveEffectiveContractedVolume, compileVolumeTransitionRule, resolveVolumeRuleVersionAsOf,
  type PersistedVolumeTransitionRuleVersion,
} from './rolling-band-migration-pull'
import type { ContractTerms, FixedFeeBand } from './types'

describe('resolveNextContractPeriodStart — Step 17C.2', () => {
  it('no contract_start_date known -> null (Decision Required, never guessed)', () => {
    expect(resolveNextContractPeriodStart({ contractStartDate: null, cadence: 'monthly', after: new Date(2027, 0, 15) })).toBeNull()
  })

  it('monthly cadence: the instant right after a period starts -> that same period\'s start (not "next calendar month")', () => {
    const result = resolveNextContractPeriodStart({ contractStartDate: '2026-10-01', cadence: 'monthly', after: new Date(2026, 9, 15) })
    expect(result).toEqual(new Date(2026, 10, 1))
  })

  it('monthly cadence: notice confirmed mid-December -> next period starts January 1', () => {
    const result = resolveNextContractPeriodStart({ contractStartDate: '2026-10-01', cadence: 'monthly', after: new Date(2026, 11, 20) })
    expect(result).toEqual(new Date(2027, 0, 1))
  })

  it('quarterly cadence uses 3-month steps, not monthly ones', () => {
    const result = resolveNextContractPeriodStart({ contractStartDate: '2027-01-01', cadence: 'quarterly', after: new Date(2027, 3, 15) })
    // Periods: Jan1, Apr1, Jul1... after=Apr15 -> next period starts Jul1
    expect(result).toEqual(new Date(2027, 6, 1))
  })

  it('after is exactly a period boundary -> resolves to the NEXT boundary, not the one just reached', () => {
    const result = resolveNextContractPeriodStart({ contractStartDate: '2026-10-01', cadence: 'monthly', after: new Date(2027, 0, 1) })
    expect(result).toEqual(new Date(2027, 1, 1))
  })

  it('after is before the contract even started -> resolves to the contract start itself', () => {
    const result = resolveNextContractPeriodStart({ contractStartDate: '2027-06-01', cadence: 'monthly', after: new Date(2027, 0, 1) })
    expect(result).toEqual(new Date(2027, 5, 1))
  })
})

describe('resolveNextRenewalTermStart — Step 17C.2a, item 1', () => {
  it('no contract_start_date -> null', () => {
    expect(resolveNextRenewalTermStart({ contractStartDate: null, contractTermMonths: 12, renewalTermMonths: null, after: new Date(2027, 0, 1) })).toBeNull()
  })

  it('no contract_term_months -> null, never assumes one', () => {
    expect(resolveNextRenewalTermStart({ contractStartDate: '2026-10-01', contractTermMonths: null, renewalTermMonths: null, after: new Date(2027, 0, 1) })).toBeNull()
  })

  it('before the first term boundary -> resolves to the first term boundary (contract_start + contract_term_months)', () => {
    const result = resolveNextRenewalTermStart({ contractStartDate: '2026-10-01', contractTermMonths: 12, renewalTermMonths: 12, after: new Date(2027, 0, 1) })
    expect(result).toEqual(new Date(2027, 9, 1)) // 2026-10-01 + 12 months
  })

  it('after the first term, no distinct renewal length stated -> keeps stepping by the ORIGINAL term length', () => {
    const result = resolveNextRenewalTermStart({ contractStartDate: '2026-10-01', contractTermMonths: 12, renewalTermMonths: null, after: new Date(2027, 10, 1) })
    expect(result).toEqual(new Date(2028, 9, 1)) // 2027-10-01 + 12 months
  })

  it('after the first term, a DIFFERENT renewal_term_months is used for subsequent boundaries', () => {
    // 12-month initial term, 6-month renewals thereafter.
    const result = resolveNextRenewalTermStart({ contractStartDate: '2026-10-01', contractTermMonths: 12, renewalTermMonths: 6, after: new Date(2027, 10, 1) })
    expect(result).toEqual(new Date(2028, 3, 1)) // 2027-10-01 + 6 months
  })
})

describe('compileTransitionEffectiveRule / resolveEffectiveDateFromRule — Step 17C.2a, item 1', () => {
  const terms: Pick<ContractTerms, 'contract_start_date' | 'billing_frequency' | 'contract_term_months' | 'renewal_term_months'> = {
    contract_start_date: '2026-10-01', billing_frequency: 'monthly', contract_term_months: 12, renewal_term_months: 12,
  }

  it('a structured pick compiles into a reviewer_policy rule, never contract_derived', () => {
    const rule = compileTransitionEffectiveRule({ kind: 'next_billing_period' })
    expect(rule).toEqual({ kind: 'next_billing_period', specific_date: null, provenance: 'reviewer_policy', source_clause: null })
  })

  it('next_billing_period resolves via the same cadence machinery as resolveNextContractPeriodStart', () => {
    const rule = compileTransitionEffectiveRule({ kind: 'next_billing_period' })
    const date = resolveEffectiveDateFromRule({ rule, terms, after: new Date(2026, 11, 20) })
    expect(date).toEqual(new Date(2027, 0, 1))
  })

  it('next_renewal_term resolves via resolveNextRenewalTermStart', () => {
    const rule = compileTransitionEffectiveRule({ kind: 'next_renewal_term' })
    const date = resolveEffectiveDateFromRule({ rule, terms, after: new Date(2027, 0, 1) })
    expect(date).toEqual(new Date(2027, 9, 1))
  })

  it('next_renewal_term with no known contract_term_months -> null, Decision Required', () => {
    const rule = compileTransitionEffectiveRule({ kind: 'next_renewal_term' })
    const date = resolveEffectiveDateFromRule({ rule, terms: { ...terms, contract_term_months: null }, after: new Date(2027, 0, 1) })
    expect(date).toBeNull()
  })

  it('specific_date resolves to exactly that date, regardless of cadence', () => {
    const rule = compileTransitionEffectiveRule({ kind: 'specific_date', specific_date: '2027-03-15' })
    const date = resolveEffectiveDateFromRule({ rule, terms, after: new Date(2027, 0, 1) })
    expect(date).toEqual(new Date(2027, 2, 15))
  })

  it('specific_date with no date given -> null (should not normally happen given the compiler, but the resolver still fails closed)', () => {
    const rule = compileTransitionEffectiveRule({ kind: 'next_billing_period' }) // wrong kind on purpose
    const forcedBadRule = { ...rule, kind: 'specific_date' as const, specific_date: null }
    const date = resolveEffectiveDateFromRule({ rule: forcedBadRule, terms, after: new Date(2027, 0, 1) })
    expect(date).toBeNull()
  })
})

describe('resolveEffectiveCommercialState — Step 17C.2a item 3 / 17C.2b item A / 17C.2c (pure logic only, not wired to the live billing engine)', () => {
  const contractedBand: FixedFeeBand = { from_unit: 1501, to_unit: 5000, monthly_fee: 2000 }
  const toBand: FixedFeeBand = { from_unit: 5001, to_unit: 15000, monthly_fee: 5000 }
  const laterToBand: FixedFeeBand = { from_unit: 15001, to_unit: 150000, monthly_fee: 12000 }
  const openEndedToBand: FixedFeeBand = { from_unit: 150001, to_unit: null, monthly_fee: null }
  const contractedVolume = 5000
  const triggerValue = 8000 // the rolling average that selected band 5,001-15,000, per the task's own worked example

  it('no active transitions -> resolves to the contracted band/volume, provenance contract_derived, no transition_id, volume_provenance contract_derived', () => {
    const result = resolveEffectiveCommercialState({ contractedBand, contractedVolume, activeTransitions: [] })
    expect(result).toEqual({ effective_band: contractedBand, effective_contracted_volume: 5000, volume_provenance: 'contract_derived', effective_monthly_fee: 2000, transition_id: null, provenance: 'contract_derived' })
  })

  it('Step 17C.2c required regression — an ACTIVE transition with volume treatment UNRESOLVED: base fee still resolves (€5,000), but effective_contracted_volume is null and volume_provenance is "unresolved" — never silently 5,000 or 15,000', () => {
    const result = resolveEffectiveCommercialState({
      contractedBand, contractedVolume,
      activeTransitions: [{ id: 'tx-1', toBand, effectiveFrom: '2027-07-01', triggerValue, volumeTransitionRule: null }],
    })
    expect(result.provenance).toBe('transition_active')
    expect(result.effective_monthly_fee).toBe(5000) // base fee is executable regardless
    expect(result.effective_band).toEqual(toBand)
    expect(result.effective_contracted_volume).toBeNull()
    expect(result.volume_provenance).toBe('unresolved')
  })

  it('Step 17C.2c required regression — band_upper_bound -> contracted volume = 15,000 (the band\'s own upper limit)', () => {
    const result = resolveEffectiveCommercialState({
      contractedBand, contractedVolume,
      activeTransitions: [{ id: 'tx-1', toBand, effectiveFrom: '2027-07-01', triggerValue, volumeTransitionRule: { kind: 'band_upper_bound', provenance: 'reviewer_policy' } }],
    })
    expect(result.effective_contracted_volume).toBe(15000)
    expect(result.volume_provenance).toBe('reviewer_policy')
  })

  it('Step 17C.2c required regression — rolling_average -> contracted volume = 8,000 (the SAME trigger_value the transition was detected from, no new number)', () => {
    const result = resolveEffectiveCommercialState({
      contractedBand, contractedVolume,
      activeTransitions: [{ id: 'tx-1', toBand, effectiveFrom: '2027-07-01', triggerValue, volumeTransitionRule: { kind: 'rolling_average', provenance: 'reviewer_policy' } }],
    })
    expect(result.effective_contracted_volume).toBe(8000)
  })

  it('Step 17C.2c required regression — specific_volume = 10,000 -> contracted volume = 10,000', () => {
    const result = resolveEffectiveCommercialState({
      contractedBand, contractedVolume,
      activeTransitions: [{ id: 'tx-1', toBand, effectiveFrom: '2027-07-01', triggerValue, volumeTransitionRule: { kind: 'specific_volume', value: 10000, provenance: 'reviewer_policy' } }],
    })
    expect(result.effective_contracted_volume).toBe(10000)
  })

  it('Step 17C.2c required regression — unchanged -> contracted volume = 5,000 (the ORIGINAL committed volume, even though the price moved)', () => {
    const result = resolveEffectiveCommercialState({
      contractedBand, contractedVolume,
      activeTransitions: [{ id: 'tx-1', toBand, effectiveFrom: '2027-07-01', triggerValue, volumeTransitionRule: { kind: 'unchanged', provenance: 'reviewer_policy' } }],
    })
    expect(result.effective_contracted_volume).toBe(5000)
  })

  it('multiple active transitions (a sequential contract history) -> the LATEST effective_from always supersedes, including its own independent volume rule', () => {
    const result = resolveEffectiveCommercialState({
      contractedBand, contractedVolume,
      activeTransitions: [
        { id: 'tx-1', toBand, effectiveFrom: '2027-07-01', triggerValue, volumeTransitionRule: { kind: 'band_upper_bound', provenance: 'reviewer_policy' } },
        { id: 'tx-2', toBand: laterToBand, effectiveFrom: '2028-01-01', triggerValue: 30000, volumeTransitionRule: { kind: 'band_upper_bound', provenance: 'reviewer_policy' } },
      ],
    })
    expect(result.effective_band).toEqual(laterToBand)
    expect(result.effective_contracted_volume).toBe(150000)
    expect(result.effective_monthly_fee).toBe(12000)
    expect(result.transition_id).toBe('tx-2')
  })

  it('order of the input array does not matter — always the latest effective_from wins', () => {
    const result = resolveEffectiveCommercialState({
      contractedBand, contractedVolume,
      activeTransitions: [
        { id: 'tx-2', toBand: laterToBand, effectiveFrom: '2028-01-01', triggerValue: 30000, volumeTransitionRule: null },
        { id: 'tx-1', toBand, effectiveFrom: '2027-07-01', triggerValue, volumeTransitionRule: null },
      ],
    })
    expect(result.transition_id).toBe('tx-2')
  })

  it('band_upper_bound against an open-ended top band (to_unit: null) -> effective_contracted_volume is null, never a fabricated "unlimited", even though the rule itself IS resolved', () => {
    const result = resolveEffectiveCommercialState({
      contractedBand, contractedVolume,
      activeTransitions: [{ id: 'tx-1', toBand: openEndedToBand, effectiveFrom: '2027-07-01', triggerValue, volumeTransitionRule: { kind: 'band_upper_bound', provenance: 'reviewer_policy' } }],
    })
    expect(result.effective_contracted_volume).toBeNull()
    expect(result.volume_provenance).toBe('reviewer_policy') // the RULE resolved; the band just structurally has no cap
  })

  it('no contracted band/volume known and no active transitions -> null band, null volume, null fee, still contract_derived', () => {
    const result = resolveEffectiveCommercialState({ contractedBand: null, contractedVolume: null, activeTransitions: [] })
    expect(result).toEqual({ effective_band: null, effective_contracted_volume: null, volume_provenance: 'contract_derived', effective_monthly_fee: null, transition_id: null, provenance: 'contract_derived' })
  })
})

describe('resolveEffectiveContractedVolume — Step 17C.2c pure helper', () => {
  const toBand: FixedFeeBand = { from_unit: 5001, to_unit: 15000, monthly_fee: 5000 }
  const triggerValue = 8000

  it('null rule -> unresolved, null value', () => {
    expect(resolveEffectiveContractedVolume({ rule: null, toBand, triggerValue, originalContractedVolume: 5000 }))
      .toEqual({ value: null, provenance: 'unresolved' })
  })

  it('band_upper_bound reads toBand.to_unit, carries the rule\'s own provenance', () => {
    expect(resolveEffectiveContractedVolume({
      rule: { kind: 'band_upper_bound', provenance: 'contract_derived' }, toBand, triggerValue, originalContractedVolume: 5000,
    })).toEqual({ value: 15000, provenance: 'contract_derived' })
  })

  it('rolling_average reads triggerValue (ceiled — a no-op here since 8000 is already whole), never a freshly recomputed number', () => {
    expect(resolveEffectiveContractedVolume({
      rule: { kind: 'rolling_average', provenance: 'reviewer_policy' }, toBand, triggerValue, originalContractedVolume: 5000,
    })).toEqual({ value: 8000, provenance: 'reviewer_policy' })
  })

  it('Step 17C.2d, item 2 required regression — fractional average 5000.333... -> rolling_average ceils to 5001, never a fractional contracted-volume threshold', () => {
    expect(resolveEffectiveContractedVolume({
      rule: { kind: 'rolling_average', provenance: 'reviewer_policy' }, toBand, triggerValue: 5000.3333333, originalContractedVolume: 5000,
    })).toEqual({ value: 5001, provenance: 'reviewer_policy' })
  })

  it('rounds UP even for a tiny fraction — never truncates/rounds down', () => {
    expect(resolveEffectiveContractedVolume({
      rule: { kind: 'rolling_average', provenance: 'reviewer_policy' }, toBand, triggerValue: 8000.001, originalContractedVolume: 5000,
    }).value).toBe(8001)
  })

  it('specific_volume reads the rule\'s own stored value', () => {
    expect(resolveEffectiveContractedVolume({
      rule: { kind: 'specific_volume', value: 10000, provenance: 'reviewer_policy' }, toBand, triggerValue, originalContractedVolume: 5000,
    })).toEqual({ value: 10000, provenance: 'reviewer_policy' })
  })

  it('specific_volume with no value stored (malformed) -> null, never a silent zero/guess', () => {
    expect(resolveEffectiveContractedVolume({
      rule: { kind: 'specific_volume', provenance: 'reviewer_policy' }, toBand, triggerValue, originalContractedVolume: 5000,
    })).toEqual({ value: null, provenance: 'reviewer_policy' })
  })

  it('unchanged reads the ORIGINAL contracted volume, not anything from the transition itself', () => {
    expect(resolveEffectiveContractedVolume({
      rule: { kind: 'unchanged', provenance: 'reviewer_policy' }, toBand, triggerValue, originalContractedVolume: 5000,
    })).toEqual({ value: 5000, provenance: 'reviewer_policy' })
  })
})

describe('compileVolumeTransitionRule — Step 17C.2c reviewer-facing structured picks (never free-text)', () => {
  it('band_upper_bound/rolling_average/unchanged compile with value: null, provenance reviewer_policy', () => {
    expect(compileVolumeTransitionRule({ kind: 'band_upper_bound' })).toEqual({ kind: 'band_upper_bound', value: null, provenance: 'reviewer_policy', source_clause: null })
    expect(compileVolumeTransitionRule({ kind: 'rolling_average' })).toEqual({ kind: 'rolling_average', value: null, provenance: 'reviewer_policy', source_clause: null })
    expect(compileVolumeTransitionRule({ kind: 'unchanged' })).toEqual({ kind: 'unchanged', value: null, provenance: 'reviewer_policy', source_clause: null })
  })

  it('specific_volume carries the reviewer-entered numeric value', () => {
    expect(compileVolumeTransitionRule({ kind: 'specific_volume', value: 10000 })).toEqual({ kind: 'specific_volume', value: 10000, provenance: 'reviewer_policy', source_clause: null })
  })
})

describe('resolveVolumeRuleVersionAsOf — Step 17C.2d, item 1 (pure historical-replay logic)', () => {
  const ruleA: PersistedVolumeTransitionRuleVersion = {
    id: 'v1', transition_id: 'tx-1',
    rule: { kind: 'band_upper_bound', value: null, provenance: 'reviewer_policy', source_clause: null },
    resolved_at: '2027-01-05T00:00:00Z', superseded_at: '2027-03-10T00:00:00Z',
  }
  const ruleB: PersistedVolumeTransitionRuleVersion = {
    id: 'v2', transition_id: 'tx-1',
    rule: { kind: 'specific_volume', value: 10000, provenance: 'reviewer_policy', source_clause: null },
    resolved_at: '2027-03-10T00:00:00Z', superseded_at: null,
  }
  const versions = [ruleA, ruleB]

  it('required regression — Jan asOf (before rule B was ever resolved) -> rule A (band_upper_bound)', () => {
    const resolved = resolveVolumeRuleVersionAsOf(versions, 'tx-1', new Date('2027-01-20T00:00:00Z'))
    expect(resolved).toEqual(ruleA.rule)
  })

  it('required regression — current/future asOf (after rule B superseded rule A) -> rule B (specific_volume=10,000)', () => {
    const resolved = resolveVolumeRuleVersionAsOf(versions, 'tx-1', new Date('2027-06-01T00:00:00Z'))
    expect(resolved).toEqual(ruleB.rule)
  })

  it('required regression — resolving rule B later never changes what the EARLIER Jan asOf replay resolves to', () => {
    // Same query, same versions array (rule B already exists/superseded rule A) — Jan still resolves to A.
    const janResolved = resolveVolumeRuleVersionAsOf(versions, 'tx-1', new Date('2027-01-20T00:00:00Z'))
    expect(janResolved).toEqual(ruleA.rule)
    expect(janResolved).not.toEqual(ruleB.rule)
  })

  it('before ANY version was resolved -> null (Decision Required), never a guess', () => {
    expect(resolveVolumeRuleVersionAsOf(versions, 'tx-1', new Date('2026-12-01T00:00:00Z'))).toBeNull()
  })

  it('exact boundary instants: asOf === resolved_at includes that version; asOf === superseded_at excludes it (belongs to the NEXT version)', () => {
    expect(resolveVolumeRuleVersionAsOf(versions, 'tx-1', new Date('2027-01-05T00:00:00Z'))).toEqual(ruleA.rule)
    expect(resolveVolumeRuleVersionAsOf(versions, 'tx-1', new Date('2027-03-10T00:00:00Z'))).toEqual(ruleB.rule)
  })

  it('a different transition_id never matches -> null', () => {
    expect(resolveVolumeRuleVersionAsOf(versions, 'tx-other', new Date('2027-06-01T00:00:00Z'))).toBeNull()
  })
})
