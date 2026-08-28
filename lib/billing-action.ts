// Step 17F, item 12 — a pure, typed representation of "what does this
// contract need a human to do right now," derived from the SAME
// BillingPeriodWorkspace model (lib/billing-period-workspace.ts) the
// contract GUI itself renders — never a second, independently-derived
// state. Deliberately not rendered anywhere yet (no Dashboard UI, no
// notification system — that is the explicitly separate next step); this
// module exists so that step can consume real, already-correct state
// instead of re-deriving it.
import type { BillingPeriodWorkspace } from './billing-period-workspace'

export type BillingActionType =
  | 'fixed_billing_timing_decision_required'
  | 'missing_operational_input'
  | 'missing_usage_source'
  | 'waiting_for_usage'
  | 'ready_to_invoice'
  | 'pricing_transition'
  | 'pricing_required'

export type BillingActionSeverity = 'info' | 'warning' | 'critical'

export interface BillingAction {
  type: BillingActionType
  job_id: string
  customer_name: string
  billing_period: { start: string; end: string; label: string }
  severity: BillingActionSeverity
  title: string
  missing_dependencies: string[]
  target_section: string
  deep_link: string
}

function deepLinkFor(jobId: string, anchorId: string): string {
  return `/configure/${jobId}#${anchorId}`
}

// One action per period-level dependency gap, derived directly from the
// workspace's own readiness/missingDependencies — no separate resolution
// logic. 'upcoming' and 'invoiced' periods never produce an action: there
// is nothing for a human to do about a period that hasn't started, or one
// that's already settled.
export function deriveBillingPeriodAction(params: {
  jobId: string
  customerName: string
  workspace: BillingPeriodWorkspace
}): BillingAction | null {
  const { jobId, customerName, workspace } = params
  const period = { start: workspace.period.start, end: workspace.period.end, label: workspace.period.label }
  const targetSection = workspace.period.anchorId
  const deepLink = deepLinkFor(jobId, targetSection)

  switch (workspace.readiness) {
    case 'upcoming':
    case 'invoiced':
      return null
    case 'fixed_billing_timing_required':
      // Step 17F.3, item 2/3/14 — distinct from every usage/performance
      // blocker below: the fixed component's AMOUNT is already known, but
      // no authoritative invoice DATE can be produced while the contract's
      // own billing timing (start vs. end of period) is unresolved. Never
      // folded into 'missing_usage_source' or any other type — a future
      // Dashboard message needs to say exactly this, not a generic block.
      return {
        type: 'fixed_billing_timing_decision_required', job_id: jobId, customer_name: customerName, billing_period: period,
        severity: 'warning', title: `${customerName} — Fixed-fee billing timing needs confirmation`,
        missing_dependencies: workspace.missingDependencies, target_section: targetSection, deep_link: deepLink,
      }
    case 'parked':
      return {
        type: 'missing_usage_source', job_id: jobId, customer_name: customerName, billing_period: period,
        severity: 'critical', title: `${customerName} — ${period.label}: usage source not configured`,
        missing_dependencies: workspace.missingDependencies, target_section: targetSection, deep_link: deepLink,
      }
    case 'waiting_for_operational_inputs':
      return {
        type: 'missing_operational_input', job_id: jobId, customer_name: customerName, billing_period: period,
        severity: 'warning', title: `${customerName} — ${period.label}: operational inputs needed`,
        missing_dependencies: workspace.missingDependencies, target_section: targetSection, deep_link: deepLink,
      }
    case 'waiting_for_usage':
      return {
        type: 'waiting_for_usage', job_id: jobId, customer_name: customerName, billing_period: period,
        severity: 'info', title: `${customerName} — ${period.label}: waiting on usage measurement`,
        missing_dependencies: workspace.missingDependencies, target_section: targetSection, deep_link: deepLink,
      }
    case 'ready_to_invoice':
      return {
        type: 'ready_to_invoice', job_id: jobId, customer_name: customerName, billing_period: period,
        severity: 'info', title: `${customerName} — ${period.label}: ready to invoice`,
        missing_dependencies: [], target_section: targetSection, deep_link: deepLink,
      }
  }
}

// Item 11 — a rolling volume-band migration transition is a contract/
// pricing-state change, not a per-period invoice dependency, so it's
// derived separately from (never folded into) the period-level action
// above. `pricing_required` covers a mechanism whose transition condition
// has been met but still needs a reviewer decision to apply (mirrors the
// same 'requires_confirmation' discipline used everywhere else in this
// codebase); `pricing_transition` covers one that has already executed
// and is purely informational.
export function deriveRollingBandAction(params: {
  jobId: string
  customerName: string
  mechanismTitle: string
  anchorId: string
  transitionPending: boolean
  requiresConfirmation: boolean
}): BillingAction | null {
  const { jobId, customerName, mechanismTitle, anchorId, transitionPending, requiresConfirmation } = params
  if (!transitionPending) return null
  return {
    type: requiresConfirmation ? 'pricing_required' : 'pricing_transition',
    job_id: jobId, customer_name: customerName,
    billing_period: { start: '', end: '', label: '' },
    severity: requiresConfirmation ? 'warning' : 'info',
    title: requiresConfirmation
      ? `${customerName} — ${mechanismTitle}: pricing transition needs confirmation`
      : `${customerName} — ${mechanismTitle}: pricing tier transitioned`,
    missing_dependencies: [], target_section: anchorId, deep_link: deepLinkFor(jobId, anchorId),
  }
}
