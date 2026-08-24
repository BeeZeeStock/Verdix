import { describe, it, expect } from 'vitest'
import { isEffectiveDateFixedDateGrounded, isCustomerAcceptanceEventGrounded, deriveOneTimeFeeBillabilityProvenance } from './one-time-fee-billability-provenance'

const LAUNCH_FEE_CLAUSE = 'Customer will pay a one-time launch fee of SEK 20,000, billable on the Effective Date.'
const INTEGRATION_FEE_CLAUSE = 'Customer will pay a one-time integration fee of SEK 90,000, billable only upon Customer Acceptance. '
  + 'Customer Acceptance occurs when Customer signs the production acceptance certificate. '
  + 'Supplier delivery, test completion, or project-manager email does not by itself constitute Customer Acceptance.'
const CUSTOMER_ACCEPTANCE_CONDITION = { kind: 'event' as const, event_type: 'customer_acceptance' as const }

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

describe('deriveOneTimeFeeBillabilityProvenance — Customer Acceptance acceptance case', () => {
  it('mints contract_derived for the exact Contract B integration-fee clause', () => {
    const fee = { source_clause: INTEGRATION_FEE_CLAUSE }
    expect(deriveOneTimeFeeBillabilityProvenance(fee, CUSTOMER_ACCEPTANCE_CONDITION, '2026-10-01')).toBe('contract_derived')
    expect(isCustomerAcceptanceEventGrounded(fee, CUSTOMER_ACCEPTANCE_CONDITION)).toBe(true)
  })
})

describe('isCustomerAcceptanceEventGrounded — required regression cases', () => {
  it('explicit "billable upon Customer Acceptance" + canonical customer_acceptance -> contract_derived', () => {
    expect(isCustomerAcceptanceEventGrounded(
      { source_clause: 'The implementation fee is billable upon Customer Acceptance.' },
      CUSTOMER_ACCEPTANCE_CONDITION,
    )).toBe(true)
  })

  it('explicit "payable after Customer Acceptance" -> contract_derived', () => {
    expect(isCustomerAcceptanceEventGrounded(
      { source_clause: 'The implementation fee is payable after Customer Acceptance.' },
      CUSTOMER_ACCEPTANCE_CONDITION,
    )).toBe(true)
  })

  it('Contract B\'s full source clause, including its negative alternatives sentence -> contract_derived', () => {
    expect(isCustomerAcceptanceEventGrounded(
      { source_clause: INTEGRATION_FEE_CLAUSE },
      CUSTOMER_ACCEPTANCE_CONDITION,
    )).toBe(true)
  })

  it('Customer Acceptance mentioned but not as the billing trigger -> null', () => {
    expect(isCustomerAcceptanceEventGrounded(
      { source_clause: 'The parties acknowledge that Customer Acceptance is an important milestone under this Agreement.' },
      CUSTOMER_ACCEPTANCE_CONDITION,
    )).toBe(false)
  })

  it('generic "subject to acceptance" -> null', () => {
    expect(isCustomerAcceptanceEventGrounded(
      { source_clause: 'The fee is subject to acceptance.' },
      CUSTOMER_ACCEPTANCE_CONDITION,
    )).toBe(false)
  })

  it('generic "after approval" -> null', () => {
    expect(isCustomerAcceptanceEventGrounded(
      { source_clause: 'The fee is payable after approval.' },
      CUSTOMER_ACCEPTANCE_CONDITION,
    )).toBe(false)
  })

  it('canonical event != customer_acceptance -> null, even with explicit billing-trigger text', () => {
    expect(isCustomerAcceptanceEventGrounded(
      { source_clause: 'The fee is billable upon Customer Acceptance.' },
      { kind: 'event', event_type: 'delivery' },
    )).toBe(false)
  })

  it('source says Customer Acceptance but canonical condition says delivery -> null', () => {
    expect(isCustomerAcceptanceEventGrounded(
      { source_clause: 'The fee is billable upon Customer Acceptance, defined as Customer\'s written sign-off.' },
      { kind: 'event', event_type: 'delivery' },
    )).toBe(false)
  })

  it('Customer Acceptance OR delivery as alternative billing triggers -> null', () => {
    expect(isCustomerAcceptanceEventGrounded(
      { source_clause: 'The fee is billable upon Customer Acceptance or production go-live.' },
      CUSTOMER_ACCEPTANCE_CONDITION,
    )).toBe(false)
    expect(isCustomerAcceptanceEventGrounded(
      { source_clause: 'The fee is due upon Customer Acceptance or 30 days after delivery, whichever occurs first.' },
      CUSTOMER_ACCEPTANCE_CONDITION,
    )).toBe(false)
  })

  it('"payable on delivery, subject to Customer Acceptance" -> null (the actual trigger stated is delivery, not Customer Acceptance)', () => {
    expect(isCustomerAcceptanceEventGrounded(
      { source_clause: 'The fee is payable on delivery, subject to Customer Acceptance.' },
      CUSTOMER_ACCEPTANCE_CONDITION,
    )).toBe(false)
  })

  it('a competing trigger stated elsewhere in the same clause (different sentence) -> null', () => {
    expect(isCustomerAcceptanceEventGrounded(
      {
        source_clause: 'The fee is billable upon Customer Acceptance. Alternatively, the fee is payable upon delivery '
          + 'if Customer Acceptance has not occurred within 60 days.',
      },
      CUSTOMER_ACCEPTANCE_CONDITION,
    )).toBe(false)
  })

  it('missing source clause -> null', () => {
    expect(isCustomerAcceptanceEventGrounded({ source_clause: null }, CUSTOMER_ACCEPTANCE_CONDITION)).toBe(false)
    expect(isCustomerAcceptanceEventGrounded({}, CUSTOMER_ACCEPTANCE_CONDITION)).toBe(false)
    expect(isCustomerAcceptanceEventGrounded({ source_clause: '   ' }, CUSTOMER_ACCEPTANCE_CONDITION)).toBe(false)
  })

  // Item 8's critical requirement — negative/exclusionary language about a
  // DIFFERENT event must never be mistaken for a positive competing
  // trigger. This is the exact real Contract B sentence.
  it('a sentence excluding an event from constituting acceptance does NOT trigger false conflict detection', () => {
    expect(isCustomerAcceptanceEventGrounded(
      {
        source_clause: 'The fee is billable upon Customer Acceptance. Supplier delivery, test completion, or '
          + 'project-manager email does not by itself constitute Customer Acceptance.',
      },
      CUSTOMER_ACCEPTANCE_CONDITION,
    )).toBe(true)
  })

  it('malformed/absent condition -> null', () => {
    expect(isCustomerAcceptanceEventGrounded({ source_clause: 'The fee is billable upon Customer Acceptance.' }, null)).toBe(false)
    expect(isCustomerAcceptanceEventGrounded(
      { source_clause: 'The fee is billable upon Customer Acceptance.' }, { kind: 'immediate' },
    )).toBe(false)
    expect(isCustomerAcceptanceEventGrounded(
      { source_clause: 'The fee is billable upon Customer Acceptance.' }, { kind: 'fixed_date', date: '2026-10-01' },
    )).toBe(false)
  })
})
