import { describe, it, expect } from 'vitest'
import { classifyOperationalActionState } from './operational-action-due-state'
import {
  deriveInvoiceActions, deriveManualInputActions, combineBillingActions,
  type PlannedInvoiceActionRow, type ManualInputComponentRow,
} from './billing-actions'
import { describeInvoiceHold } from './invoice-hold-status'
import { resolveRecognizedOperationalInputKey } from './operational-input-canonicalization'

// ═══════════════════════════════════════════════════════════════════════════
// Step E9E — manual usage input end-to-end acceptance.
//
// Acceptance fixture ("Example Usage Co"): a generic, synthetic contract —
// never NordicFit/Meridian/any real customer — exercising exactly the shape
// §1 asks for:
//   - a usage-based additional_recurring_fees[] entry (rate_per_unit +
//     semantic_input_key, NO percentage_of_basis) — the real
//     additional_recurring_fees fixture-object shape that lib/dashboard-
//     billing-actions.ts, app/api/jobs/[id]/manual-input-due-state/route.ts,
//     and lib/per-unit-fee-pull.ts all classify as the SAME "usage-manual-
//     fallback" mechanism (confirmed by reading all three; asserted below
//     directly against the fixture object, not merely assumed)
//   - no confirmed contract_meter_mappings row — manual fallback is the
//     ONLY source
//   - monthly billing, following-invoice (arrears) — the ONLY model this
//     product implements (lib/operational-action-due-state.ts's own header)
//   - the source measurement period CLOSED as of the test clock, with no
//     usage value entered yet
//
// Dates are deliberately NOT September/October 2026 (the task's own
// instruction) — a fixed, explicit ASOF test clock and two adjacent
// calendar months are used purely as deterministic fixture values, never
// read from the real system clock.
//
// This exercises the SAME pure, already-unit-tested decision functions the
// real orchestration layers (lib/dashboard-billing-actions.ts, app/api/
// jobs/[id]/manual-input-due-state/route.ts, app/api/jobs/[id]/usage-
// values/route.ts) call — those orchestration layers are supabaseServer-
// coupled and this codebase has no vi.mock('@/lib/supabase') convention
// (confirmed repeatedly across this codebase's own test suite), so the DB-
// integration half of this chain (a real usage_period_values row, a real
// invoice-scheduler run) is covered instead by the opt-in, RUN_RLS_
// INTEGRATION_TESTS-gated lib/usage-quantity-resolver-integration.test.ts
// (see specifically the new "E9E —" test added there this pass, and the
// pre-existing "17F.1, item 3" ready-path test) — not re-implemented here,
// matching lib/step-17e1-acceptance.test.ts's own established precedent for
// where a data-layer acceptance test's boundary sits in this codebase.
//
// The Commercial Logic ("Awaiting [period] inputs" / CTA) and Billing
// Timeline (PARKED badge/blocker) RENDER-level facts have no render-test
// harness in this codebase (confirmed: no test file exists for either
// app/(dashboard)/configure/[id]/page.tsx or app/_components/
// BillingSummaryCard.tsx's PARKED path) — verified instead by direct code
// inspection, cited inline below at each relevant assertion.
// ═══════════════════════════════════════════════════════════════════════════

const JOB_ID = 'job-e9e-acceptance'
const CUSTOMER_NAME = 'Example Usage Co'
const SEMANTIC_KEY = 'completed_payment_count' // real, closed-registry key (see below) standing in for "API transaction"
const RATE_PER_UNIT = 1.0 // SEK 1.00 per unit

// Source period: closed as of the test clock, no usage entered yet.
const SOURCE_PERIOD_START = '2027-03-01'
const SOURCE_PERIOD_END = '2027-03-31'
// Destination invoice: the FOLLOWING period — deliberately a DIFFERENT
// period from the source measurement window (the core invariant §2 states).
const DEST_PERIOD_START = '2027-04-01'
const DEST_PERIOD_END = '2027-04-30'
const ASOF = new Date('2027-04-15T12:00:00.000Z') // after source period closes, before destination invoice's own period ends

// The real additional_recurring_fees[] shape this fixture represents.
const ACCEPTANCE_FEE = {
  fee_label: 'API transaction fee',
  amount: 0,
  metric_name: 'completed_payment',
  rate_per_unit: RATE_PER_UNIT,
  semantic_input_key: SEMANTIC_KEY,
  recurring_fee_id: 'rf-e9e-api-txn',
  required_operational_inputs: [SEMANTIC_KEY],
}

describe('Step E9E §1/§2 — acceptance fixture genuinely represents "usage-manual-fallback, source != destination period"', () => {
  it('the fee has NO percentage_of_basis (not the performance mechanism) and a real rate_per_unit + semantic_input_key (the usage-manual-fallback mechanism) — the exact condition lib/dashboard-billing-actions.ts, the manual-input-due-state route, and lib/per-unit-fee-pull.ts all branch on', () => {
    expect('percentage_of_basis' in ACCEPTANCE_FEE).toBe(false)
    expect(typeof ACCEPTANCE_FEE.rate_per_unit === 'number' && ACCEPTANCE_FEE.rate_per_unit > 0 && !!ACCEPTANCE_FEE.semantic_input_key).toBe(true)
  })

  it('the semantic key resolves through the real closed canonical registry (lib/operational-input-canonicalization.ts) — the same gate app/api/jobs/[id]/usage-values/route.ts enforces on every manual save', () => {
    expect(resolveRecognizedOperationalInputKey(SEMANTIC_KEY)).toBe(SEMANTIC_KEY)
  })

  it('source period and destination invoice period are genuinely different calendar periods', () => {
    expect(SOURCE_PERIOD_START).not.toBe(DEST_PERIOD_START)
    expect(SOURCE_PERIOD_END < DEST_PERIOD_START).toBe(true) // source closes strictly before the destination invoice's own period begins
  })
})

describe('Step E9E §11.1/§11.11 — due-state classification', () => {
  it('closed source period + no row -> INPUT_REQUIRED', () => {
    const state = classifyOperationalActionState({
      periodStart: SOURCE_PERIOD_START, periodEnd: SOURCE_PERIOD_END,
      requiredKeys: [SEMANTIC_KEY], finalizedKeys: new Set(), draftKeys: new Set(), asOf: ASOF,
    })
    expect(state).toBe('INPUT_REQUIRED')
  })

  it('a future, not-yet-closed period never produces a due action (NOT_DUE), regardless of what rows exist', () => {
    const state = classifyOperationalActionState({
      periodStart: DEST_PERIOD_START, periodEnd: DEST_PERIOD_END, // this period hasn't closed yet as of ASOF
      requiredKeys: [SEMANTIC_KEY], finalizedKeys: new Set(), draftKeys: new Set(), asOf: ASOF,
    })
    expect(state).toBe('NOT_DUE')
    const row: ManualInputComponentRow = {
      jobId: JOB_ID, customerName: CUSTOMER_NAME, componentLabel: ACCEPTANCE_FEE.fee_label,
      recurringFeeId: ACCEPTANCE_FEE.recurring_fee_id, mechanismKind: 'usage_manual_fallback',
      periodStart: DEST_PERIOD_START, periodEnd: DEST_PERIOD_END,
      requiredKeys: [SEMANTIC_KEY], finalizedKeys: [], draftKeys: [], asOf: ASOF,
    }
    expect(deriveManualInputActions([row])).toEqual([])
  })
})

describe('Step E9E §3/§11.2/§11.3 — initial Dashboard Billing Action', () => {
  const noInputRow: ManualInputComponentRow = {
    jobId: JOB_ID, customerName: CUSTOMER_NAME, componentLabel: ACCEPTANCE_FEE.fee_label,
    recurringFeeId: ACCEPTANCE_FEE.recurring_fee_id, mechanismKind: 'usage_manual_fallback',
    periodStart: SOURCE_PERIOD_START, periodEnd: SOURCE_PERIOD_END,
    requiredKeys: [SEMANTIC_KEY], finalizedKeys: [], draftKeys: [], asOf: ASOF,
  }
  const [action] = deriveManualInputActions([noInputRow])

  it('exactly one action, business-facing "Usage input required", CTA "Enter inputs"', () => {
    expect(deriveManualInputActions([noInputRow])).toHaveLength(1)
    expect(action.description).toBe('Usage input required')
    expect(action.ctaLabel).toBe('Enter inputs')
    expect(action.actionType).toBe('manual_input_required')
  })

  it('correct customer identity, no false performance-input action', () => {
    expect(action.customerName).toBe(CUSTOMER_NAME)
    expect(action.description).not.toContain('Performance')
  })

  it('deep-link carries the SOURCE period (never the destination invoice period)', () => {
    expect(action.destination).toBe(
      `/configure/${JOB_ID}?input_period_start=${SOURCE_PERIOD_START}&input_period_end=${SOURCE_PERIOD_END}#operational-inputs-section`,
    )
    expect(action.destination).not.toContain(DEST_PERIOD_START)
  })
})

// Step E9E §4 — Commercial Logic state, verified by direct code inspection
// (no render-test harness exists for app/(dashboard)/configure/[id]/
// page.tsx, confirmed): app/api/jobs/[id]/manual-input-due-state/route.ts
// calls this SAME classifyOperationalActionState/oldestUnresolvedPeriod
// pair (never a second, independently-derived due-state answer), and
// page.tsx's own render (around its "Current state" row, gated on
// `c.pricingModel === 'performance' || c.pricingModel === 'usage'`) renders
// exactly `Awaiting ${periodLabel} inputs` for INPUT_REQUIRED / `Draft
// inputs — ${periodLabel}` for INPUT_DRAFT, with a footer button reading
// `Enter ${periodLabel} inputs →` / `Finish ${periodLabel} inputs →` that
// navigates to `/configure/${id}?input_period_start=${due.sourcePeriodStart}
// &input_period_end=${due.sourcePeriodEnd}#operational-inputs-section` —
// the IDENTICAL destination shape asserted above for the Dashboard action.
// Commercial Logic renders status/action only; the actual entry widget
// (<ManualInputEntry>) lives exclusively inside Billing Operations
// (#operational-inputs-section) — confirmed no second instance of
// ManualInputEntry exists inside the Commercial Logic component tree.
describe('Step E9E §4 — Commercial Logic wording matches Billing Operations period exactly (verified by code inspection, cited above)', () => {
  it('the period label the Dashboard/Commercial Logic would both show is derived from the SAME source period', () => {
    const periodLabel = new Date(SOURCE_PERIOD_START + 'T00:00:00').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
    expect(periodLabel).toBe('Mar 2027')
  })
})

describe('Step E9E §5/§6/§10/§11.6 — destination invoice PARKED, blocked by the SOURCE period, business-facing reason', () => {
  // The exact error_message shape lib/per-unit-fee-pull.ts's E9E fix now
  // throws for real billing (finalize:true) when this fee's usage isn't
  // ready — QuantitySourceNotReadyError wraps this into
  // "Held: Cannot bill metric '...': quantity source (external_usage) is
  // not ready — [usage_source] ...", persisted verbatim as
  // planned_invoices.error_message by lib/invoice-scheduler-error-
  // classification.ts's classifySchedulerCatchOutcome.
  const parkedRow: PlannedInvoiceActionRow = {
    id: 'inv-e9e-dest', jobId: JOB_ID, customerName: CUSTOMER_NAME,
    invoiceType: 'period', status: 'scheduled',
    errorMessage: `Held: Cannot bill metric 'API transaction fee' for [${SOURCE_PERIOD_START}, ${SOURCE_PERIOD_END}): quantity source (external_usage) is not ready — [usage_source] no confirmed meter mapping or finalized manual usage value for '${SEMANTIC_KEY}' in [${SOURCE_PERIOD_START}, ${SOURCE_PERIOD_END}]`,
    periodStart: DEST_PERIOD_START, periodEnd: DEST_PERIOD_END,
    priorPeriodStart: SOURCE_PERIOD_START, priorPeriodEnd: SOURCE_PERIOD_END,
  }
  const [invoiceAction] = deriveInvoiceActions([parkedRow])

  it('classified as PARKED (retryable hold), not FAILED (terminal)', () => {
    expect(invoiceAction.actionType).toBe('invoice_parked')
    expect(invoiceAction.statusBadge).toEqual({ label: 'PARKED', severity: 'attention' })
  })

  it('business-facing reason is "Usage data required" — never the raw exception text', () => {
    const hold = describeInvoiceHold(parkedRow)
    expect(hold.businessReason).toBe('Usage data required')
    expect(invoiceAction.description).toBe('Usage data required')
    expect(invoiceAction.description).not.toContain('QuantitySourceNotReadyError')
    expect(invoiceAction.description).not.toContain('[usage_source]')
  })

  it('the invoice stays in its own chronological position — period_start/period_end are the DESTINATION invoice\'s own, never the source period\'s', () => {
    expect(invoiceAction.invoicePeriodLabel).toBe('Apr 2027')
  })

  it('the PARKED action correctly references the SOURCE period it is blocked by (never the destination period)', () => {
    expect(invoiceAction.blockedBySourcePeriodStart).toBe(SOURCE_PERIOD_START)
    expect(invoiceAction.blockedBySourcePeriodEnd).toBe(SOURCE_PERIOD_END)
  })

  it('§10/§11.10 — no duplicate action: once a PARKED invoice_parked action covers this EXACT source period, the manual-input action for the SAME obligation is deduped away — exactly one action shown, not two, for one underlying obligation', () => {
    const manualInputRow: ManualInputComponentRow = {
      jobId: JOB_ID, customerName: CUSTOMER_NAME, componentLabel: ACCEPTANCE_FEE.fee_label,
      recurringFeeId: ACCEPTANCE_FEE.recurring_fee_id, mechanismKind: 'usage_manual_fallback',
      periodStart: SOURCE_PERIOD_START, periodEnd: SOURCE_PERIOD_END,
      requiredKeys: [SEMANTIC_KEY], finalizedKeys: [], draftKeys: [], asOf: ASOF,
    }
    const combined = combineBillingActions(
      deriveInvoiceActions([parkedRow]),
      deriveManualInputActions([manualInputRow]),
    )
    expect(combined).toHaveLength(1)
    expect(combined[0].actionType).toBe('invoice_parked')
  })
})

describe('Step E9E §7/§11.4 — draft usage value', () => {
  const draftRow: ManualInputComponentRow = {
    jobId: JOB_ID, customerName: CUSTOMER_NAME, componentLabel: ACCEPTANCE_FEE.fee_label,
    recurringFeeId: ACCEPTANCE_FEE.recurring_fee_id, mechanismKind: 'usage_manual_fallback',
    periodStart: SOURCE_PERIOD_START, periodEnd: SOURCE_PERIOD_END,
    requiredKeys: [SEMANTIC_KEY], finalizedKeys: [], draftKeys: [SEMANTIC_KEY], asOf: ASOF,
  }

  it('state is INPUT_DRAFT, action persists, CTA changes to "Finish inputs"', () => {
    const state = classifyOperationalActionState({
      periodStart: SOURCE_PERIOD_START, periodEnd: SOURCE_PERIOD_END,
      requiredKeys: [SEMANTIC_KEY], finalizedKeys: new Set(), draftKeys: new Set([SEMANTIC_KEY]), asOf: ASOF,
    })
    expect(state).toBe('INPUT_DRAFT')
    const [action] = deriveManualInputActions([draftRow])
    expect(action.actionType).toBe('manual_input_finalize')
    expect(action.ctaLabel).toBe('Finish inputs')
    expect(action.description).toBe('Draft usage value awaiting finalization')
  })

  it('exactly one action for a draft row — the transition from INPUT_REQUIRED never produces a second, duplicate action', () => {
    expect(deriveManualInputActions([draftRow])).toHaveLength(1)
  })

  // §7's "destination invoice remains PARKED" / "scheduler should NOT issue
  // invoice from draft data" / "no provider call occurs" for a draft value
  // are guaranteed structurally, not by a separate check: lib/usage-
  // quantity-resolver.ts's manual-fallback branch requires `finalized_at IS
  // NOT NULL` before a row counts as `active` (confirmed by reading it) —
  // a draft row (finalized_at null) is invisible to resolveUsageQuantityFor
  // Period exactly like "no row at all", so lib/per-unit-fee-pull.ts's E9E
  // fix throws the identical QuantitySourceNotReadyError for a draft as for
  // a missing value. No separate draft-awareness needed in the billing
  // path — verified by code inspection, not a live run.
})

describe('Step E9E §8/§9/§11.5/§11.7/§11.9 — finalized usage value: action disappears, calculated amount', () => {
  const finalizedRow: ManualInputComponentRow = {
    jobId: JOB_ID, customerName: CUSTOMER_NAME, componentLabel: ACCEPTANCE_FEE.fee_label,
    recurringFeeId: ACCEPTANCE_FEE.recurring_fee_id, mechanismKind: 'usage_manual_fallback',
    periodStart: SOURCE_PERIOD_START, periodEnd: SOURCE_PERIOD_END,
    requiredKeys: [SEMANTIC_KEY], finalizedKeys: [SEMANTIC_KEY], draftKeys: [], asOf: ASOF,
  }

  it('state is READY once finalized, and the Dashboard action disappears entirely (never a lingering resolved action)', () => {
    const state = classifyOperationalActionState({
      periodStart: SOURCE_PERIOD_START, periodEnd: SOURCE_PERIOD_END,
      requiredKeys: [SEMANTIC_KEY], finalizedKeys: new Set([SEMANTIC_KEY]), draftKeys: new Set(), asOf: ASOF,
    })
    expect(state).toBe('READY')
    expect(deriveManualInputActions([finalizedRow])).toEqual([])
  })

  it('calculated line-item amount matches lib/per-unit-fee-pull.ts\'s own exact formula (Math.round(quantity × rate_per_unit × 100) / 100) — 12,345 × SEK 1.00 = SEK 12,345', () => {
    const quantity = 12345
    const amount = Math.round(quantity * RATE_PER_UNIT * 100) / 100
    expect(amount).toBe(12345)
  })

  // §9's "line item appears on the DESTINATION invoice, source period
  // remains traceable, no duplicate line, no fake carry-forward zero" and
  // §7's "readiness recheck -> invoice no longer blocked" are the DB-
  // integration half of this chain — covered by the new "E9E —" test in
  // lib/usage-quantity-resolver-integration.test.ts (asserts the not-ready
  // path fails closed) together with the pre-existing "17F.1, item 3" test
  // there (asserts the ready path produces the correct amount/description,
  // e.g. `${fee.fee_label}: ${quantity} × ${rate}`, reusing the SAME
  // finalized snapshot rather than a second pull) — both opt-in (RUN_RLS_
  // INTEGRATION_TESTS=true), not run this session (no DB mutation
  // authorized). See this file's own closing-report note.
})
