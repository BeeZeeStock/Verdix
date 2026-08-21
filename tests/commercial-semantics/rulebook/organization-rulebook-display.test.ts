// Organization Rulebook — display formatting (Step 5D). Pure tests for
// lib/rulebook/organization-rulebook-display.ts — no database, no React.
import { describe, it, expect } from 'vitest'
import {
  describeTargetField, describeTreatment, describeMatchCondition, describeMatchConditions,
  describeEffectivePeriod, describeSourceKind, groupForDisplay,
} from '@/lib/rulebook/organization-rulebook-display'

describe('describeTargetField / describeTreatment — never raw JSON as primary text (item 1)', () => {
  it('survival.carry_forward has a specific, human label', () => {
    expect(describeTargetField('survival.carry_forward')).toBe('Unused-balance carry-forward')
  })
  it('treatment reads as a plain sentence, keyed by the target field', () => {
    expect(describeTreatment('survival.carry_forward', true)).toBe('Carry forward until fully used')
    expect(describeTreatment('survival.carry_forward', false)).toBe('Does not carry forward past the period earned')
  })
  it('an unrecognized field falls back to a readable version of the dotted path, never blank', () => {
    expect(describeTargetField('some.unknown.field')).toBeTruthy()
    expect(describeTargetField('some.unknown.field')).not.toContain('undefined')
  })
})

describe('describeMatchCondition — "Applies when" (item 4/5)', () => {
  it('rule_type + application.timing render as the exact example in the spec', () => {
    const conditions = describeMatchConditions([
      { field: 'rule_type', operator: 'eq', value: 'service_credit' },
      { field: 'application.timing', operator: 'eq', value: 'next_invoice' },
    ])
    expect(conditions).toEqual(['Rule type = Service Credit', 'Application timing = Next invoice'])
  })
  it('an "in" condition lists its values', () => {
    expect(describeMatchCondition({ field: 'rule_type', operator: 'in', value: ['service_credit', 'rebate'] })).toBe('Rule type in [Service Credit, Rebate]')
  })
  it('an "exists" condition needs no value rendering', () => {
    expect(describeMatchCondition({ field: 'rule_type', operator: 'exists' })).toBe('Rule type is set')
  })
})

describe('describeEffectivePeriod', () => {
  it('a rule with no effective_from yet reads "Not yet effective"', () => {
    expect(describeEffectivePeriod(null, null)).toBe('Not yet effective')
  })
  it('an open-ended active rule shows only the start', () => {
    expect(describeEffectivePeriod('2026-01-01T00:00:00.000Z', null)).toMatch(/^From /)
  })
  it('a superseded rule shows both bounds', () => {
    expect(describeEffectivePeriod('2026-01-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')).toContain('–')
  })
})

describe('describeSourceKind — item 10 (where a policy came from)', () => {
  it('manual -> "Created manually"', () => expect(describeSourceKind('manual')).toBe('Created manually'))
  it('reviewer_promotion -> "Promoted from reviewer decision"', () => expect(describeSourceKind('reviewer_promotion')).toBe('Promoted from reviewer decision'))
  it('verdix_pattern_suggestion -> "Suggested by Verdix" (label exists even though Step 5D never produces this source_kind)', () => {
    expect(describeSourceKind('verdix_pattern_suggestion')).toBe('Suggested by Verdix')
  })
})

describe('groupForDisplay — the five management-page buckets (item 1)', () => {
  const AS_OF = new Date('2026-08-22T12:00:00.000Z')

  it('active, already-in-effect (effectiveFrom in the past) -> "active"', () => {
    expect(groupForDisplay({ status: 'active', effectiveFrom: '2026-01-01T00:00:00.000Z' }, AS_OF)).toBe('active')
  })
  it('active, effectiveFrom null (immediate, no explicit date) -> "active"', () => {
    expect(groupForDisplay({ status: 'active', effectiveFrom: null }, AS_OF)).toBe('active')
  })
  it('active, but effectiveFrom is in the FUTURE -> "future", not "active" (same DB status, different display bucket)', () => {
    expect(groupForDisplay({ status: 'active', effectiveFrom: '2027-01-01T00:00:00.000Z' }, AS_OF)).toBe('future')
  })
  it('draft -> "draft"', () => expect(groupForDisplay({ status: 'draft', effectiveFrom: null }, AS_OF)).toBe('draft'))
  it('superseded -> "superseded"', () => expect(groupForDisplay({ status: 'superseded', effectiveFrom: '2026-01-01T00:00:00.000Z' }, AS_OF)).toBe('superseded'))
  it('disabled -> "disabled"', () => expect(groupForDisplay({ status: 'disabled', effectiveFrom: null }, AS_OF)).toBe('disabled'))
})
