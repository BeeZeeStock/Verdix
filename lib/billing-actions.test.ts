import { describe, it, expect } from 'vitest'
import {
  deriveInvoiceActions, deriveManualInputActions, deriveEventActions, combineBillingActions,
  type PlannedInvoiceActionRow, type ManualInputComponentRow, type EventActionRow,
} from './billing-actions'

const ASOF = new Date('2026-09-15T12:00:00.000Z')

describe('deriveInvoiceActions', () => {
  const held: PlannedInvoiceActionRow = {
    id: 'inv-1', jobId: 'job-1', customerName: 'Acme', invoiceType: 'period',
    status: 'scheduled', errorMessage: 'Held: [performance_input] missing required input',
    periodStart: '2026-11-01', periodEnd: '2026-11-30',
  }

  it('a held period invoice produces exactly one invoice_parked action', () => {
    const actions = deriveInvoiceActions([held])
    expect(actions).toHaveLength(1)
    expect(actions[0].actionType).toBe('invoice_parked')
    expect(actions[0].severity).toBe('attention')
    expect(actions[0].description).toBe('Performance inputs required')
  })

  it('a failed invoice produces exactly one invoice_failed (critical) action', () => {
    const failed: PlannedInvoiceActionRow = {
      ...held, id: 'inv-2', status: 'failed',
      errorMessage: "'Performance share' currency problem for job x: [currency_mismatch] mismatch",
    }
    const actions = deriveInvoiceActions([failed])
    expect(actions).toHaveLength(1)
    expect(actions[0].actionType).toBe('invoice_failed')
    expect(actions[0].severity).toBe('critical')
  })

  it('a paid/sent/open historical invoice never produces an action — no actionable retry (§26)', () => {
    for (const status of ['paid', 'sent', 'open']) {
      const row: PlannedInvoiceActionRow = { ...held, id: `inv-${status}`, status, errorMessage: null }
      expect(deriveInvoiceActions([row])).toHaveLength(0)
    }
  })

  it('an ordinary not-yet-due scheduled row (no error_message) never produces an action', () => {
    const row: PlannedInvoiceActionRow = { ...held, status: 'scheduled', errorMessage: null }
    expect(deriveInvoiceActions([row])).toHaveLength(0)
  })

  it('a one-time invoice is never included — that lifecycle is Source C (event actions), never duplicated here (§21)', () => {
    const row: PlannedInvoiceActionRow = { ...held, invoiceType: 'one_time', status: 'parked' }
    expect(deriveInvoiceActions([row])).toHaveLength(0)
  })

  it('deriving twice from the identical row set produces IDENTICAL ids — no duplication across repeated scheduler/derivation runs (§4)', () => {
    const first = deriveInvoiceActions([held])
    const second = deriveInvoiceActions([held])
    expect(first[0].id).toBe(second[0].id)
  })

  it('a terminal_settlement invoice is treated the same as an ordinary period invoice (both go through the same fail-closed scheduler path)', () => {
    const row: PlannedInvoiceActionRow = { ...held, invoiceType: 'terminal_settlement' }
    expect(deriveInvoiceActions([row])).toHaveLength(1)
  })
})

describe('deriveManualInputActions (Step E9C.1)', () => {
  const base: ManualInputComponentRow = {
    jobId: 'job-1', customerName: 'Acme', componentLabel: 'Performance share', recurringFeeId: 'rf_1',
    mechanismKind: 'performance',
    periodStart: '2026-08-01', periodEnd: '2026-08-31', // closed relative to ASOF
    requiredKeys: ['paid_invoice_value', 'total_invoice_value_of_issued_requests'],
    finalizedKeys: [], draftKeys: [], asOf: ASOF,
  }

  it('§3 — usage_manual_fallback mechanism uses truthful "Usage input required" copy, not performance wording', () => {
    const row: ManualInputComponentRow = { ...base, mechanismKind: 'usage_manual_fallback', requiredKeys: ['api_calls'] }
    const actions = deriveManualInputActions([row])
    expect(actions).toHaveLength(1)
    expect(actions[0].description).toBe('Usage input required')
  })

  it('§3 — a closed period with ZERO value rows at all produces ONE manual_input_required action', () => {
    const actions = deriveManualInputActions([base])
    expect(actions).toHaveLength(1)
    expect(actions[0].actionType).toBe('manual_input_required')
    expect(actions[0].description).toBe('Performance inputs required')
  })

  it('§4 — one of two required fields saved as draft produces ONE manual_input_finalize action, not manual_input_required', () => {
    const row: ManualInputComponentRow = { ...base, draftKeys: ['paid_invoice_value'] }
    const actions = deriveManualInputActions([row])
    expect(actions).toHaveLength(1)
    expect(actions[0].actionType).toBe('manual_input_finalize')
    expect(actions[0].description).toContain('Draft inputs')
  })

  it('§4 — never two Dashboard actions for two raw fields belonging to the SAME calculation (grouped by construction — one row in, at most one action out)', () => {
    const row: ManualInputComponentRow = { ...base, draftKeys: ['paid_invoice_value', 'total_invoice_value_of_issued_requests'] }
    const actions = deriveManualInputActions([row])
    expect(actions).toHaveLength(1)
  })

  it('§5 — a future/not-yet-started period produces NO action', () => {
    const row: ManualInputComponentRow = { ...base, periodStart: '2026-10-01', periodEnd: '2026-10-31' }
    expect(deriveManualInputActions([row])).toHaveLength(0)
  })

  it('§5 — an ACTIVE (still-measuring) period produces NO action even with nothing entered', () => {
    const row: ManualInputComponentRow = { ...base, periodStart: '2026-09-01', periodEnd: '2026-09-30' }
    expect(deriveManualInputActions([row])).toHaveLength(0)
  })

  it('all required fields finalized -> the action disappears', () => {
    const row: ManualInputComponentRow = { ...base, finalizedKeys: ['paid_invoice_value', 'total_invoice_value_of_issued_requests'] }
    expect(deriveManualInputActions([row])).toHaveLength(0)
  })

  it('a waived/non-applicable component (no monetary required keys at all) never produces an action', () => {
    const row: ManualInputComponentRow = { ...base, requiredKeys: [] }
    expect(deriveManualInputActions([row])).toHaveLength(0)
  })

  it('§7 — stable identity: the SAME requirement retains a recognizable id root across INPUT_REQUIRED -> INPUT_DRAFT', () => {
    const required = deriveManualInputActions([base])[0]
    const draftRow: ManualInputComponentRow = { ...base, draftKeys: ['paid_invoice_value'] }
    const draft = deriveManualInputActions([draftRow])[0]
    const rootOf = (id: string) => id.replace(/:(required|draft)$/, '')
    expect(rootOf(required.id)).toBe(rootOf(draft.id))
  })

  it('§9 — keys off recurring_fee_id, not the (mutable) componentLabel, when present', () => {
    const a: ManualInputComponentRow = { ...base, jobId: 'job-a', recurringFeeId: 'rf_a' }
    const b: ManualInputComponentRow = { ...base, jobId: 'job-a', recurringFeeId: 'rf_b' }
    const actions = deriveManualInputActions([a, b])
    expect(new Set(actions.map(x => x.id)).size).toBe(2)
  })

  it('§5 (E9C.2) — SAME display label, DIFFERENT stable IDs, DIFFERENT due states: each resolves independently, no collision', () => {
    // Same componentLabel ("Performance share" — `base`'s own default),
    // but distinct recurring_fee_id AND distinct actual resolution state
    // (one still missing everything, the other fully finalized) — proves
    // the two are never conflated into one action or one state.
    const stillRequired: ManualInputComponentRow = { ...base, recurringFeeId: 'rf_x' }
    const alreadyReady: ManualInputComponentRow = {
      ...base, recurringFeeId: 'rf_y',
      finalizedKeys: ['paid_invoice_value', 'total_invoice_value_of_issued_requests'],
    }
    const actions = deriveManualInputActions([stillRequired, alreadyReady])
    // Only the still-required one produces an action — the ready one
    // correctly produces none, proving its distinct id was actually
    // resolved on its OWN finalizedKeys, not accidentally inheriting the
    // other same-labeled component's unresolved state.
    expect(actions).toHaveLength(1)
    expect(actions[0].id).toContain('rf_x')
    expect(actions[0].id).not.toContain('rf_y')
  })

  it('legacy data with no recurring_fee_id falls back to componentLabel — compatibility fallback preserved (§9)', () => {
    const row: ManualInputComponentRow = { ...base, recurringFeeId: null }
    const actions = deriveManualInputActions([row])
    expect(actions).toHaveLength(1)
    expect(actions[0].id).toContain('Performance share')
  })

  it('§13 — destination encodes the SOURCE period, never a destination invoice period', () => {
    const actions = deriveManualInputActions([base])
    expect(actions[0].destination).toContain('input_period_start=2026-08-01')
    expect(actions[0].destination).toContain('input_period_end=2026-08-31')
    expect(actions[0].sourcePeriodLabel).toBe('Aug 2026')
  })
})

describe('deriveEventActions', () => {
  const pending: EventActionRow = { id: 'fee-1', jobId: 'job-1', customerName: 'Beta', feeLabel: 'Acceptance fee', satisfied: false, createdAt: '2026-09-01T00:00:00Z' }

  it('an event awaiting attestation produces one action', () => {
    const actions = deriveEventActions([pending])
    expect(actions).toHaveLength(1)
    expect(actions[0].actionType).toBe('event_confirmation_required')
  })

  it('a satisfied event produces NO action', () => {
    const satisfied: EventActionRow = { ...pending, satisfied: true }
    expect(deriveEventActions([satisfied])).toHaveLength(0)
  })
})

describe('combineBillingActions — priority ordering (§6)', () => {
  it('orders FAILED first, then PARKED, then manual-input, then event, regardless of input order', () => {
    const event: EventActionRow = { id: 'e1', jobId: 'j1', customerName: 'C', feeLabel: null, satisfied: false, createdAt: '2026-01-01' }
    const manualInput: ManualInputComponentRow = {
      jobId: 'j2', customerName: 'C2', componentLabel: 'Performance share', recurringFeeId: 'rf_1',
      mechanismKind: 'performance' as const,
      periodStart: '2026-02-01', periodEnd: '2026-02-28', requiredKeys: ['k'], finalizedKeys: [], draftKeys: [], asOf: ASOF,
    }
    const parked: PlannedInvoiceActionRow = { id: 'p1', jobId: 'j3', customerName: 'C3', invoiceType: 'period', status: 'scheduled', errorMessage: 'Held: x', periodStart: '2026-03-01', periodEnd: '2026-03-31' }
    const failed: PlannedInvoiceActionRow = { id: 'f1', jobId: 'j4', customerName: 'C4', invoiceType: 'period', status: 'failed', errorMessage: 'y', periodStart: '2026-04-01', periodEnd: '2026-04-30' }

    const combined = combineBillingActions(
      deriveEventActions([event]),
      deriveManualInputActions([manualInput]),
      deriveInvoiceActions([parked, failed]),
    )
    expect(combined.map(a => a.actionType)).toEqual([
      'invoice_failed', 'invoice_parked', 'manual_input_required', 'event_confirmation_required',
    ])
  })

  it('§12/§15 — a job with BOTH an invoice_parked action and a manual_input_required action for the same job merges into ONE row (the PARKED action), never two', () => {
    const parked: PlannedInvoiceActionRow = {
      id: 'p1', jobId: 'job-x', customerName: 'C', invoiceType: 'period', status: 'scheduled',
      errorMessage: 'Held: [performance_input] missing required input', periodStart: '2026-11-01', periodEnd: '2026-11-30',
    }
    const manualInput: ManualInputComponentRow = {
      jobId: 'job-x', customerName: 'C', componentLabel: 'Performance share', recurringFeeId: 'rf_1',
      mechanismKind: 'performance' as const,
      periodStart: '2026-10-01', periodEnd: '2026-10-31', requiredKeys: ['k'], finalizedKeys: [], draftKeys: [], asOf: ASOF,
    }
    const combined = combineBillingActions(deriveInvoiceActions([parked]), deriveManualInputActions([manualInput]))
    expect(combined).toHaveLength(1)
    expect(combined[0].actionType).toBe('invoice_parked')
  })

  it('§10 (E9C.2) — PRECISE dedup: a PARKED action whose blockedBySourcePeriod matches a manual-input action\'s own period suppresses it', () => {
    const parked: PlannedInvoiceActionRow = {
      id: 'p1', jobId: 'job-z', customerName: 'C', invoiceType: 'period', status: 'scheduled',
      errorMessage: 'Held: [performance_input] missing required input', periodStart: '2026-11-01', periodEnd: '2026-11-30',
      priorPeriodStart: '2026-10-01', priorPeriodEnd: '2026-10-31',
    }
    const matchingManualInput: ManualInputComponentRow = {
      jobId: 'job-z', customerName: 'C', componentLabel: 'Performance share', recurringFeeId: 'rf_1', mechanismKind: 'performance',
      periodStart: '2026-10-01', periodEnd: '2026-10-31', requiredKeys: ['k'], finalizedKeys: [], draftKeys: [], asOf: ASOF,
    }
    const combined = combineBillingActions(deriveInvoiceActions([parked]), deriveManualInputActions([matchingManualInput]))
    expect(combined).toHaveLength(1)
    expect(combined[0].actionType).toBe('invoice_parked')
  })

  it('§10 (E9C.2) — PRECISE dedup does NOT suppress an UNRELATED unresolved period on the same job — the E9C.2 audit\'s core fix', () => {
    const parked: PlannedInvoiceActionRow = {
      id: 'p1', jobId: 'job-z', customerName: 'C', invoiceType: 'period', status: 'scheduled',
      errorMessage: 'Held: [performance_input] missing required input', periodStart: '2026-11-01', periodEnd: '2026-11-30',
      priorPeriodStart: '2026-10-01', priorPeriodEnd: '2026-10-31',
    }
    // A DIFFERENT, older, still-unresolved period for the SAME job —
    // NOT what the parked invoice is blocked by (per its own
    // priorPeriodStart/End) — must remain visible, never silently
    // absorbed into the PARKED row.
    const unrelatedManualInput: ManualInputComponentRow = {
      jobId: 'job-z', customerName: 'C', componentLabel: 'Setup review fee', recurringFeeId: 'rf_2', mechanismKind: 'usage_manual_fallback',
      periodStart: '2026-08-01', periodEnd: '2026-08-31', requiredKeys: ['k2'], finalizedKeys: [], draftKeys: [], asOf: ASOF,
    }
    const combined = combineBillingActions(deriveInvoiceActions([parked]), deriveManualInputActions([unrelatedManualInput]))
    expect(combined).toHaveLength(2)
    expect(combined.map(a => a.actionType).sort()).toEqual(['invoice_parked', 'manual_input_required'])
  })

  it('§12 — a manual_input_required action for a DIFFERENT job (no PARKED invoice there) is never suppressed', () => {
    const parked: PlannedInvoiceActionRow = {
      id: 'p1', jobId: 'job-x', customerName: 'C', invoiceType: 'period', status: 'scheduled',
      errorMessage: 'Held: [performance_input] missing required input', periodStart: '2026-11-01', periodEnd: '2026-11-30',
    }
    const manualInput: ManualInputComponentRow = {
      jobId: 'job-y', customerName: 'C2', componentLabel: 'Performance share', recurringFeeId: 'rf_1',
      mechanismKind: 'performance' as const,
      periodStart: '2026-08-01', periodEnd: '2026-08-31', requiredKeys: ['k'], finalizedKeys: [], draftKeys: [], asOf: ASOF,
    }
    const combined = combineBillingActions(deriveInvoiceActions([parked]), deriveManualInputActions([manualInput]))
    expect(combined).toHaveLength(2)
  })

  it('within the same priority tier, orders oldest due date first', () => {
    const older: PlannedInvoiceActionRow = { id: 'p1', jobId: 'j1', customerName: 'C', invoiceType: 'period', status: 'scheduled', errorMessage: 'Held: x', periodStart: '2026-01-01', periodEnd: '2026-01-31' }
    const newer: PlannedInvoiceActionRow = { id: 'p2', jobId: 'j2', customerName: 'C2', invoiceType: 'period', status: 'scheduled', errorMessage: 'Held: y', periodStart: '2026-06-01', periodEnd: '2026-06-30' }
    const combined = combineBillingActions(deriveInvoiceActions([newer, older]))
    expect(combined.map(a => a.invoiceId)).toEqual(['p1', 'p2'])
  })
})

describe('source vs destination period retained correctly', () => {
  it('an invoice action\'s own dueDate/period is the INVOICE\'s own period, never a source period baked into the description', () => {
    const row: PlannedInvoiceActionRow = {
      id: 'inv-1', jobId: 'job-1', customerName: 'Acme', invoiceType: 'period',
      status: 'scheduled', errorMessage: 'Held: [usage_source] connector timeout',
      periodStart: '2026-11-01', periodEnd: '2026-11-30',
    }
    const [action] = deriveInvoiceActions([row])
    expect(action.dueDate).toBe('2026-11-01')
    expect(action.invoicePeriodLabel).toBe('Nov 2026')
  })
})
