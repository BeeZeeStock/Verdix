// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { BillingReconciliationPanel } from './BillingReconciliationPanel'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function mockFetchOnce(body: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => body }))
}

describe('BillingReconciliationPanel — Step 17H.4B0D4H1B4E2 §24/§25', () => {
  it('none/safe_to_resume/executed_same_plan: renders nothing', async () => {
    for (const kind of ['none', 'safe_to_resume', 'executed_same_plan']) {
      mockFetchOnce({ state: { kind }, correctionAssessment: { kind: 'none' } })
      const { container, unmount } = render(<BillingReconciliationPanel jobId="j1" currency="EUR" />)
      await waitFor(() => expect(container.querySelector('div')).toBeFalsy())
      unmount()
    }
  })

  it('executed_plan_changed + no monetary impact: collapsed by default, neutral wording, no alarming amber heading', async () => {
    mockFetchOnce({
      state: { kind: 'executed_plan_changed', attemptId: 'a1', provider: 'stripe', executedFingerprint: 'x', currentFingerprint: 'y' },
      correctionAssessment: { kind: 'none' },
    })
    render(<BillingReconciliationPanel jobId="j1" currency="EUR" />)
    await waitFor(() => expect(screen.getByText('Structural difference, no detected monetary impact')).toBeInTheDocument())
    // Collapsed: the detailed body text is not yet shown.
    expect(screen.queryByText(/no component-level amount difference was detected/i)).not.toBeInTheDocument()
    expect(screen.queryByText('Billing reconciliation required')).not.toBeInTheDocument()
  })

  it('executed_plan_changed + no monetary impact: expands on click to show the neutral explanation, never implies money is wrong', async () => {
    mockFetchOnce({
      state: { kind: 'executed_plan_changed', attemptId: 'a1', provider: 'stripe', executedFingerprint: 'x', currentFingerprint: 'y' },
      correctionAssessment: { kind: 'none' },
    })
    render(<BillingReconciliationPanel jobId="j1" currency="EUR" />)
    await waitFor(() => expect(screen.getByText('Structural difference, no detected monetary impact')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Structural difference, no detected monetary impact'))
    expect(screen.getByText(/but no component-level amount difference was detected/i)).toBeInTheDocument()
    expect(screen.queryByText('Billing reconciliation required')).not.toBeInTheDocument()
  })

  it('executed_plan_changed + a detected monetary delta: strong warning heading, amount shown', async () => {
    mockFetchOnce({
      state: { kind: 'executed_plan_changed', attemptId: 'a1', provider: 'stripe', executedFingerprint: 'x', currentFingerprint: 'y' },
      correctionAssessment: {
        kind: 'additional_charge_indicated', totalDelta: 100,
        components: [{ componentKey: 'period:1:0', executedAmount: 900, currentAmount: 1000, deltaAmount: 100 }],
      },
    })
    render(<BillingReconciliationPanel jobId="j1" currency="EUR" />)
    await waitFor(() => expect(screen.getByText('Billing reconciliation required')).toBeInTheDocument())
    expect(screen.getByText('Additional charge indicated')).toBeInTheDocument()
  })

  it('operation_outcome_uncertain: strong warning heading, verification actions present', async () => {
    mockFetchOnce({
      state: {
        kind: 'operation_outcome_uncertain', attemptId: 'a1', provider: 'stripe',
        operations: [{ id: 'op1', operationType: 'create_invoice', operationKey: 'k1', status: 'outcome_uncertain', retryCapability: 'idempotent_retry', externalObjectId: null, startedAt: null, idempotencyWindowStillValid: true }],
        uncertainOperationIds: ['op1'],
      },
      correctionAssessment: { kind: 'none' },
    })
    render(<BillingReconciliationPanel jobId="j1" currency="EUR" />)
    await waitFor(() => expect(screen.getByText('Billing reconciliation required')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /verify succeeded/i })).toBeInTheDocument()
  })
})
