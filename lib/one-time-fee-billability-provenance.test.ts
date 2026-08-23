import { describe, it, expect } from 'vitest'
import { isEffectiveDateFixedDateGrounded, deriveOneTimeFeeBillabilityProvenance } from './one-time-fee-billability-provenance'

const LAUNCH_FEE_CLAUSE = 'Customer will pay a one-time launch fee of SEK 20,000, billable on the Effective Date.'

describe('deriveOneTimeFeeBillabilityProvenance — Contract B acceptance case', () => {
  it('mints contract_derived for the exact Contract B launch-fee clause', () => {
    const fee = { source_clause: LAUNCH_FEE_CLAUSE }
    const condition = { kind: 'fixed_date' as const, date: '2026-10-01' }
    expect(deriveOneTimeFeeBillabilityProvenance(fee, condition, '2026-10-01')).toBe('contract_derived')
    expect(isEffectiveDateFixedDateGrounded(fee, condition, '2026-10-01')).toBe(true)
  })
})

describe('isEffectiveDateFixedDateGrounded — required regression cases', () => {
  it('source says Effective Date + condition date equals contract_start_date -> contract_derived', () => {
    expect(isEffectiveDateFixedDateGrounded(
      { source_clause: LAUNCH_FEE_CLAUSE },
      { kind: 'fixed_date', date: '2026-10-01' },
      '2026-10-01',
    )).toBe(true)
  })

  it('source says Effective Date + condition date differs from contract_start_date -> null', () => {
    expect(isEffectiveDateFixedDateGrounded(
      { source_clause: LAUNCH_FEE_CLAUSE },
      { kind: 'fixed_date', date: '2026-10-02' },
      '2026-10-01',
    )).toBe(false)
  })

  it('source says a literal date only (no Effective Date/commencement language) -> null in this pass', () => {
    expect(isEffectiveDateFixedDateGrounded(
      { source_clause: 'Customer will pay a one-time launch fee of SEK 20,000 on 1 October 2026.' },
      { kind: 'fixed_date', date: '2026-10-01' },
      '2026-10-01',
    )).toBe(false)
  })

  it('source says Customer Acceptance -> null in this pass (event kind is never groundable here)', () => {
    expect(isEffectiveDateFixedDateGrounded(
      { source_clause: 'Customer will pay a one-time integration fee of SEK 90,000, billable only upon Customer Acceptance.' },
      { kind: 'event', event_type: 'customer_acceptance' },
      '2026-10-01',
    )).toBe(false)
  })

  it('source says signing/execution -> null in this pass (event kind is never groundable here)', () => {
    expect(isEffectiveDateFixedDateGrounded(
      { source_clause: 'Customer will pay a one-time setup fee of SEK 10,000, billable upon execution of this Agreement.' },
      { kind: 'event', event_type: 'contract_signature' },
      '2026-10-01',
    )).toBe(false)
  })

  it('source silent on timing -> null', () => {
    expect(isEffectiveDateFixedDateGrounded(
      { source_clause: 'Customer will pay a one-time launch fee of SEK 20,000.' },
      { kind: 'fixed_date', date: '2026-10-01' },
      '2026-10-01',
    )).toBe(false)
  })

  it('source has Effective Date plus a competing alternative trigger -> null', () => {
    expect(isEffectiveDateFixedDateGrounded(
      { source_clause: 'Customer will pay a one-time launch fee of SEK 20,000, billable on the Effective Date or upon Customer Acceptance.' },
      { kind: 'fixed_date', date: '2026-10-01' },
      '2026-10-01',
    )).toBe(false)
  })

  it('missing contract_start_date -> null', () => {
    expect(isEffectiveDateFixedDateGrounded(
      { source_clause: LAUNCH_FEE_CLAUSE },
      { kind: 'fixed_date', date: '2026-10-01' },
      null,
    )).toBe(false)
    expect(isEffectiveDateFixedDateGrounded(
      { source_clause: LAUNCH_FEE_CLAUSE },
      { kind: 'fixed_date', date: '2026-10-01' },
      undefined,
    )).toBe(false)
  })

  it('malformed condition/date -> null', () => {
    expect(isEffectiveDateFixedDateGrounded({ source_clause: LAUNCH_FEE_CLAUSE }, null, '2026-10-01')).toBe(false)
    expect(isEffectiveDateFixedDateGrounded(
      { source_clause: LAUNCH_FEE_CLAUSE }, { kind: 'fixed_date', date: 'not-a-date' }, '2026-10-01',
    )).toBe(false)
    expect(isEffectiveDateFixedDateGrounded(
      { source_clause: LAUNCH_FEE_CLAUSE }, { kind: 'fixed_date', date: '2026-10-01' }, 'not-a-date',
    )).toBe(false)
    expect(isEffectiveDateFixedDateGrounded(
      { source_clause: LAUNCH_FEE_CLAUSE }, { kind: 'immediate' }, '2026-10-01',
    )).toBe(false)
  })

  it('no source_clause at all -> null', () => {
    expect(isEffectiveDateFixedDateGrounded(
      { source_clause: null }, { kind: 'fixed_date', date: '2026-10-01' }, '2026-10-01',
    )).toBe(false)
    expect(isEffectiveDateFixedDateGrounded(
      {}, { kind: 'fixed_date', date: '2026-10-01' }, '2026-10-01',
    )).toBe(false)
  })

  it('a generic bare "start" does not count as an Effective Date anchor', () => {
    expect(isEffectiveDateFixedDateGrounded(
      { source_clause: 'Customer will pay a one-time launch fee of SEK 20,000 at the start.' },
      { kind: 'fixed_date', date: '2026-10-01' },
      '2026-10-01',
    )).toBe(false)
  })

  it('commencement-phrased anchors also ground', () => {
    expect(isEffectiveDateFixedDateGrounded(
      { source_clause: 'Customer will pay a one-time launch fee of SEK 20,000, due at contract commencement.' },
      { kind: 'fixed_date', date: '2026-10-01' },
      '2026-10-01',
    )).toBe(true)
  })
})
