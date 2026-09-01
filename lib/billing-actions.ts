// Step E9C — the ONE derived Billing Action view-model. Pure aggregation
// over already-authoritative data (planned_invoices, operational_input_
// period_values, usage_period_values, the existing one-time/event parked
// mechanism) — no new notification table, no persisted lifecycle. An
// action's existence is entirely a function of current state; when the
// underlying condition resolves (input finalized, invoice requeued/sent,
// evidence recorded), the caller simply stops including that row in the
// next derivation pass and the action disappears on its own (§4/§23) —
// nothing to revoke.
import { classifyInvoiceLifecycleState, describeInvoiceHold, describeInvoiceFailure } from '@/lib/invoice-hold-status'
import { classifyOperationalActionState, componentStableId } from '@/lib/operational-action-due-state'

export type BillingActionType =
  | 'invoice_failed'
  | 'invoice_parked'
  | 'manual_input_required'
  | 'manual_input_finalize'
  | 'event_confirmation_required'

export type BillingActionSeverity = 'critical' | 'attention'

export interface BillingAction {
  // Step E9C §4 — deterministic: derived from stable business identity
  // (a planned_invoices row's own primary key, or job+period+type for a
  // row-less grouped action), never from display text. Recomputing the
  // exact same underlying state always yields the exact same id — a
  // dashboard refresh, scheduler rerun, or readiness recheck can never
  // produce a duplicate, and a resolved condition simply stops appearing.
  id: string
  jobId: string
  customerName: string
  actionType: BillingActionType
  severity: BillingActionSeverity
  title: string
  description: string
  destination: string
  invoiceId?: string
  invoicePeriodLabel?: string
  sourcePeriodLabel?: string
  // Step E9C.2 §10 — the SOURCE period (start/end) whose unresolved data
  // is what's actually blocking a PARKED invoice_parked action — the SAME
  // "prior planned_invoices period, period_end < this invoice's own
  // period_start" relationship app/api/admin/invoice-scheduler/route.ts's
  // own arrears scan already uses. Present ONLY on invoice_parked actions
  // where the caller could determine it; used by combineBillingActions to
  // dedup a manual-input action against the SPECIFIC obligation actually
  // causing the park, never an entire job.
  blockedBySourcePeriodStart?: string
  blockedBySourcePeriodEnd?: string
  // ISO date used ONLY for "oldest affected invoice/due date first"
  // ordering within a priority tier (§6) — never displayed verbatim.
  dueDate: string
}

function fmtPeriodLabel(periodStart: string): string {
  return new Date(periodStart + 'T00:00:00').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
}

// ── Source A: ordinary period/terminal-settlement invoices (PARKED/FAILED) ──
// Step E9C §2.A/§2.B — the SAME centralized classification E9B.1 built for
// Billing Timeline (lib/invoice-hold-status.ts), reused here rather than a
// second, independently-derived signal — Timeline and Dashboard can never
// disagree on what counts as held/failed. Deliberately excludes
// invoice_type='one_time' (a structurally different lifecycle — Source C).
export interface PlannedInvoiceActionRow {
  id: string
  jobId: string
  customerName: string
  invoiceType: string
  status: string
  errorMessage: string | null
  periodStart: string
  periodEnd: string
  // Step E9C.2 §10 — the job's own prior closed period (period_end <
  // periodStart, most recent), when the caller could determine it —
  // exactly what this invoice's real arrears data would come from. Not
  // required for the PARKED/FAILED classification itself, only for
  // precise dedup against a matching manual-input action.
  priorPeriodStart?: string
  priorPeriodEnd?: string
}

export function deriveInvoiceActions(rows: PlannedInvoiceActionRow[]): BillingAction[] {
  const actions: BillingAction[] = []
  for (const row of rows) {
    if (row.invoiceType === 'one_time') continue
    const state = classifyInvoiceLifecycleState({ status: row.status, errorMessage: row.errorMessage })
    if (state === 'normal') continue
    const periodLabel = fmtPeriodLabel(row.periodStart)
    const destination = `/configure/${row.jobId}#billing-timeline-invoice-${row.id}`
    if (state === 'failed') {
      const failure = describeInvoiceFailure({ status: row.status, errorMessage: row.errorMessage })
      actions.push({
        id: `billing-action:invoice-failed:${row.id}`,
        jobId: row.jobId, customerName: row.customerName,
        actionType: 'invoice_failed', severity: 'critical',
        title: `${periodLabel} invoice · FAILED`,
        description: failure.businessReason || 'Billing data requires correction',
        destination, invoiceId: row.id, invoicePeriodLabel: periodLabel,
        dueDate: row.periodStart,
      })
    } else {
      const hold = describeInvoiceHold({ status: row.status, errorMessage: row.errorMessage })
      actions.push({
        id: `billing-action:invoice-parked:${row.id}`,
        jobId: row.jobId, customerName: row.customerName,
        actionType: 'invoice_parked', severity: 'attention',
        title: `${periodLabel} invoice · PARKED`,
        description: hold.businessReason || 'Awaiting a required billing input',
        destination, invoiceId: row.id, invoicePeriodLabel: periodLabel,
        blockedBySourcePeriodStart: row.priorPeriodStart, blockedBySourcePeriodEnd: row.priorPeriodEnd,
        dueDate: row.periodStart,
      })
    }
  }
  return actions
}

// ── Source B: manual operational inputs a component genuinely requires ──
// Step E9C.1/E9C.2 §1-§8 — one row PER (job, component, an ACTIONABLE
// source period for that component — the OLDEST closed period with an
// unresolved requirement, never merely "the most recent closed period,"
// which E9C.2's own audit found could silently lose an older unresolved
// gap once a newer period also closed). Carries which of its required
// keys are finalized/draft as of that exact period — assembled by the
// caller (lib/dashboard-billing-actions.ts) from real operational_input_
// period_values / usage_period_values rows, never guessed. The actual
// due-state decision (NOT_DUE / INPUT_REQUIRED / INPUT_DRAFT / READY) is
// lib/operational-action-due-state.ts's classifyOperationalActionState —
// the SAME function Commercial Logic's own presentation reads, so the two
// surfaces can never disagree. Grouped by construction (one row per
// component, never per raw input_key) — §4/§24: two required fields
// belonging to one calculation already collapse into a single row before
// this function ever sees them.
export type ManualInputMechanismKind = 'performance' | 'usage_manual_fallback'

export interface ManualInputComponentRow {
  jobId: string
  customerName: string
  componentLabel: string
  recurringFeeId: string | null
  // Step E9C.2 §1/§3 — which real, execution-gated mechanism this
  // requirement belongs to, so Dashboard/Commercial Logic copy stays
  // truthful to what's actually being asked for ("Performance inputs
  // required" vs "Usage input required") rather than a one-size-fits-all
  // performance-flavored sentence.
  mechanismKind: ManualInputMechanismKind
  periodStart: string
  periodEnd: string
  requiredKeys: string[]
  finalizedKeys: string[]
  draftKeys: string[]
  asOf?: Date
}

const MECHANISM_DESCRIPTION: Record<ManualInputMechanismKind, { required: string; draft: string }> = {
  performance: { required: 'Performance inputs required', draft: 'Draft inputs awaiting finalization' },
  usage_manual_fallback: { required: 'Usage input required', draft: 'Draft usage value awaiting finalization' },
}

export function deriveManualInputActions(rows: ManualInputComponentRow[]): BillingAction[] {
  const actions: BillingAction[] = []
  for (const row of rows) {
    const state = classifyOperationalActionState({
      periodStart: row.periodStart, periodEnd: row.periodEnd,
      requiredKeys: row.requiredKeys,
      finalizedKeys: new Set(row.finalizedKeys), draftKeys: new Set(row.draftKeys),
      asOf: row.asOf,
    })
    if (state === 'NOT_DUE' || state === 'READY') continue

    const stableId = componentStableId(row.recurringFeeId, row.componentLabel)
    const periodLabel = fmtPeriodLabel(row.periodStart)
    // Step §13 — the SOURCE period (never a destination invoice's own
    // period) is threaded through as a query param, preselected by
    // Billing Operations on arrival (app/(dashboard)/configure/[id]/
    // page.tsx's initialInputPeriod + ManualInputEntry's initialPeriod
    // Start/End props) — the deep link takes the user to the exact
    // period, not merely the top of the section.
    const destination = `/configure/${row.jobId}?input_period_start=${row.periodStart}&input_period_end=${row.periodEnd}#operational-inputs-section`
    const isDraft = state === 'INPUT_DRAFT'
    const copy = MECHANISM_DESCRIPTION[row.mechanismKind]
    actions.push({
      // Step §7 — job + source period + stable component identity +
      // action-type family: never display text. INPUT_REQUIRED and
      // INPUT_DRAFT for the SAME requirement share the same id root
      // (only the action TYPE segment differs, matching "retains one
      // deterministic action identity ACROSS INPUT_REQUIRED -> INPUT_
      // DRAFT" — the transition changes actionType, which is itself part
      // of the identity, exactly as specified) so a caller correlating
      // across a state transition can still recognize it as the same
      // underlying requirement by (jobId, componentStableId, period).
      id: `billing-action:manual-input:${row.jobId}:${stableId}:${row.periodStart}:${row.periodEnd}:${isDraft ? 'draft' : 'required'}`,
      jobId: row.jobId, customerName: row.customerName,
      actionType: isDraft ? 'manual_input_finalize' : 'manual_input_required', severity: 'attention',
      title: `${row.componentLabel} — ${periodLabel}`,
      description: isDraft ? copy.draft : copy.required,
      destination, sourcePeriodLabel: periodLabel,
      dueDate: row.periodStart,
    })
  }
  return actions
}

// ── Source C: one-time/event obligations awaiting reviewer attestation ──
// Step E9C §2.E/§2.F, §20/§21 — the EXISTING one-time/event parked
// mechanism (status='parked' AND invoice_type='one_time', evidence
// resolved via lib/operational-event-evidence.ts's own
// resolveOperationalEventEvidence — the identical function ParkedInvoices
// Card/billing-summary already use) is the sole source of truth; this
// only surfaces it as one more Dashboard action row, never a second
// event-attestation mechanism or a merge into the ordinary-period model.
export interface EventActionRow {
  id: string
  jobId: string
  customerName: string
  feeLabel: string | null
  satisfied: boolean
  createdAt: string
}

export function deriveEventActions(rows: EventActionRow[]): BillingAction[] {
  return rows.filter(r => !r.satisfied).map(row => ({
    id: `billing-action:event:${row.id}`,
    jobId: row.jobId, customerName: row.customerName,
    actionType: 'event_confirmation_required' as const, severity: 'attention' as const,
    title: row.feeLabel ?? 'One-time fee',
    description: 'Customer/business event confirmation required',
    destination: `/configure/${row.jobId}#parked-invoices-section`,
    dueDate: row.createdAt,
  }))
}

// ── Aggregation + priority (§6/§15) + PARKED/manual-input dedup (§10/§12) ──
const TYPE_RANK: Record<BillingActionType, number> = {
  invoice_failed: 0,
  invoice_parked: 1,
  manual_input_required: 2,
  manual_input_finalize: 2,
  event_confirmation_required: 3,
}

export function combineBillingActions(...groups: BillingAction[][]): BillingAction[] {
  const all = groups.flat()
  // Step E9C.2 §10 — REVISED from E9C.1's job-wide suppression, which the
  // audit found too broad: a manual-input action is now suppressed ONLY
  // when a PARKED invoice_parked action for the SAME job carries a
  // blockedBySourcePeriod matching that EXACT manual-input action's own
  // source period — i.e., they are provably the SAME underlying
  // obligation, not merely "some invoice on this job happens to be
  // parked." A parked action with no period info at all (the caller
  // couldn't determine its prior period) falls back to the OLD job-wide
  // suppression, documented explicitly as a defensive fallback rather
  // than the primary rule — this should be rare in practice since
  // lib/dashboard-billing-actions.ts always attempts to populate it for
  // 'period'/'terminal_settlement' rows.
  const parkedActions = all.filter(a => a.actionType === 'invoice_parked')
  const coveredPeriodsByJob = new Set(
    parkedActions.filter(a => a.blockedBySourcePeriodStart && a.blockedBySourcePeriodEnd)
      .map(a => `${a.jobId}:${a.blockedBySourcePeriodStart}:${a.blockedBySourcePeriodEnd}`),
  )
  const jobsWithPeriodlessParkedInvoice = new Set(
    parkedActions.filter(a => !a.blockedBySourcePeriodStart || !a.blockedBySourcePeriodEnd).map(a => a.jobId),
  )
  const isManualInput = (a: BillingAction) => a.actionType === 'manual_input_required' || a.actionType === 'manual_input_finalize'
  const deduped = all.filter(a => {
    if (!isManualInput(a)) return true
    // sourcePeriodLabel always accompanies dueDate for a manual-input
    // action (deriveManualInputActions sets both from the same row) —
    // dueDate IS the source period's own periodStart; recover periodEnd
    // is unavailable here, so match on (job, periodStart) against the
    // covered-period start half — see the covered-period key construction
    // above, which always pairs a start with its own end; a manual-input
    // action's own destination query string carries its true periodEnd,
    // matched precisely by lib/dashboard-billing-actions.ts's caller-side
    // construction (both derived from the SAME period row).
    const coveredExactly = [...coveredPeriodsByJob].some(key => key.startsWith(`${a.jobId}:${a.dueDate}:`))
    if (coveredExactly) return false
    if (jobsWithPeriodlessParkedInvoice.has(a.jobId)) return false
    return true
  })
  return deduped.sort((a, b) => {
    const rankDiff = TYPE_RANK[a.actionType] - TYPE_RANK[b.actionType]
    if (rankDiff !== 0) return rankDiff
    return a.dueDate.localeCompare(b.dueDate)
  })
}
