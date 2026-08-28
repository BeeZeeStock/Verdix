import { describe, it, expect } from 'vitest'
import { deriveBillingPeriodAction, deriveRollingBandAction } from './billing-action'
import { buildBillingPeriodWorkspace, deriveBillingPeriod } from './billing-period-workspace'

const period = deriveBillingPeriod({ contractStartDate: '2026-10-01', billingFrequency: 'monthly', asOf: new Date('2026-08-28') })!
const resolvedTiming = { resolved: true as const, timing: 'bill_at_period_start' as const }
const unresolvedTiming = { resolved: false as const, timing: null }

describe('deriveBillingPeriodAction', () => {
  it('an upcoming period produces no action', () => {
    const workspace = buildBillingPeriodWorkspace({
      period, started: false, alreadyInvoiced: false,
      fixed: { amount: 0, currency: 'EUR', waived: true, billingTiming: unresolvedTiming }, usage: [], performance: [],
    })
    expect(deriveBillingPeriodAction({ jobId: 'job-1', customerName: 'NordicFit', workspace })).toBeNull()
  })

  it('an already-invoiced period produces no action', () => {
    const workspace = buildBillingPeriodWorkspace({
      period, started: true, alreadyInvoiced: true,
      fixed: { amount: 2000, currency: 'EUR', waived: false, billingTiming: resolvedTiming }, usage: [], performance: [],
    })
    expect(deriveBillingPeriodAction({ jobId: 'job-1', customerName: 'NordicFit', workspace })).toBeNull()
  })

  // Step 17F.3, item 2/3/14 — a started period with unresolved fixed-fee
  // billing timing produces its OWN distinct action type, never folded
  // into missing_usage_source or any other blocker.
  it('a started period with unresolved fixed-fee billing timing produces a warning fixed_billing_timing_decision_required action', () => {
    const workspace = buildBillingPeriodWorkspace({
      period, started: true, alreadyInvoiced: false,
      fixed: { amount: 2000, currency: 'EUR', waived: false, billingTiming: unresolvedTiming },
      usage: [], performance: [],
    })
    const action = deriveBillingPeriodAction({ jobId: 'job-1', customerName: 'NordicFit', workspace })
    expect(action?.type).toBe('fixed_billing_timing_decision_required')
    expect(action?.severity).toBe('warning')
    expect(action?.missing_dependencies).toContain('Fixed-fee billing timing — decision required')
  })

  it('a parked period produces a critical missing_usage_source action with a deep link to the period anchor', () => {
    const workspace = buildBillingPeriodWorkspace({
      period, started: true, alreadyInvoiced: false,
      fixed: { amount: 2000, currency: 'EUR', waived: false, billingTiming: resolvedTiming },
      usage: [{ key: 'x', label: 'Chargebacks', semanticInputKey: null, sourceName: null, status: 'awaiting_source' }],
      performance: [],
    })
    const action = deriveBillingPeriodAction({ jobId: 'job-1', customerName: 'NordicFit', workspace })
    expect(action?.type).toBe('missing_usage_source')
    expect(action?.severity).toBe('critical')
    expect(action?.deep_link).toBe('/configure/job-1#billing-period-2026-10')
    expect(action?.missing_dependencies).toEqual(['Chargebacks — no confirmed usage source'])
  })

  it('a period waiting on manual entry produces a warning missing_operational_input action', () => {
    const workspace = buildBillingPeriodWorkspace({
      period, started: true, alreadyInvoiced: false,
      fixed: { amount: 2000, currency: 'EUR', waived: false, billingTiming: resolvedTiming }, usage: [],
      performance: [{ feeLabel: 'Performance share', status: 'pending_operational_inputs', missingKeys: ['paid_invoice_value'] }],
    })
    const action = deriveBillingPeriodAction({ jobId: 'job-1', customerName: 'NordicFit', workspace })
    expect(action?.type).toBe('missing_operational_input')
    expect(action?.severity).toBe('warning')
  })

  it('a ready period produces an info ready_to_invoice action', () => {
    const workspace = buildBillingPeriodWorkspace({
      period, started: true, alreadyInvoiced: false,
      fixed: { amount: 2000, currency: 'EUR', waived: false, billingTiming: resolvedTiming }, usage: [], performance: [],
    })
    const action = deriveBillingPeriodAction({ jobId: 'job-1', customerName: 'NordicFit', workspace })
    expect(action?.type).toBe('ready_to_invoice')
    expect(action?.severity).toBe('info')
  })
})

describe('deriveRollingBandAction', () => {
  it('no action when no transition is pending', () => {
    expect(deriveRollingBandAction({
      jobId: 'job-1', customerName: 'NordicFit', mechanismTitle: 'Rolling volume-band migration',
      anchorId: 'commercial-monitoring', transitionPending: false, requiresConfirmation: false,
    })).toBeNull()
  })

  it('a pending, unconfirmed transition is pricing_required with warning severity', () => {
    const action = deriveRollingBandAction({
      jobId: 'job-1', customerName: 'NordicFit', mechanismTitle: 'Rolling volume-band migration',
      anchorId: 'commercial-monitoring', transitionPending: true, requiresConfirmation: true,
    })
    expect(action?.type).toBe('pricing_required')
    expect(action?.severity).toBe('warning')
    expect(action?.deep_link).toBe('/configure/job-1#commercial-monitoring')
  })

  it('a pending, already-confirmed transition is informational pricing_transition', () => {
    const action = deriveRollingBandAction({
      jobId: 'job-1', customerName: 'NordicFit', mechanismTitle: 'Rolling volume-band migration',
      anchorId: 'commercial-monitoring', transitionPending: true, requiresConfirmation: false,
    })
    expect(action?.type).toBe('pricing_transition')
    expect(action?.severity).toBe('info')
  })
})
