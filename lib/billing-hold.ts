// Step 17H.4B0D4H1A — the canonical type/parser/gate for jobs.billing_hold,
// the durable server-side signal that commercial configuration is
// temporarily unsafe for NEW billing activity (Model B+ safety
// foundation). Proven necessary, not assumed: execute_status cannot serve
// this role — PENDING_HUMAN_REVIEW is already an approvable state today
// (app/api/jobs/[id]/approve/route.ts's own claimForApproval tries it
// FIRST), and nothing about execute_status is checked by the scheduler,
// rebuild-schedule, manual-invoice, or parked-invoices at all
// (17H.4B0D4H0.2's audit). billing_hold is independent of execute_status
// by design, checked explicitly by every billing-adjacent mutation path.
//
// This module is pure — no Supabase import, no side effects — so every
// consumer (API routes, the scheduler's claim RPC call sites) shares
// exactly one parsing/gating implementation, and it is directly unit-
// testable without a database.
export type BillingHoldReason = 'reexecution' | 'reconciliation_blocked' | 'schedule_rebuild_required'

const VALID_BILLING_HOLD_REASONS = new Set<BillingHoldReason>([
  'reexecution', 'reconciliation_blocked', 'schedule_rebuild_required',
])

export interface BillingHold {
  reason: BillingHoldReason
  started_at?: string
  blockers?: unknown[]
}

// Three states, not two — 'malformed' is deliberately distinct from
// 'held': a non-null jobs.billing_hold value that doesn't parse into a
// recognized reason is NEVER treated as "billing safe" (a bug that
// produces garbage JSON must never silently disable this entire safety
// mechanism) — it is treated as MORE restrictive than any known reason,
// blocking every gated operation including the two that would otherwise
// be hold-resolving (approve/rebuild-schedule), since there is no way to
// know which resolving action is even appropriate for state we can't read.
export type ParsedBillingHold =
  | { status: 'clear' }
  | { status: 'held'; hold: BillingHold }
  | { status: 'malformed' }

export function parseBillingHold(raw: unknown): ParsedBillingHold {
  if (raw === null || raw === undefined) return { status: 'clear' }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { status: 'malformed' }
  const obj = raw as Record<string, unknown>
  const reason = obj.reason
  if (typeof reason !== 'string' || !VALID_BILLING_HOLD_REASONS.has(reason as BillingHoldReason)) {
    return { status: 'malformed' }
  }
  return {
    status: 'held',
    hold: {
      reason: reason as BillingHoldReason,
      started_at: typeof obj.started_at === 'string' ? obj.started_at : undefined,
      blockers: Array.isArray(obj.blockers) ? obj.blockers : undefined,
    },
  }
}

// The three operation classes every gated route/RPC call site reduces to.
// 'monetary_action' covers manual-invoice creation, parked-invoice
// trigger/revert, and the scheduler's own claim (enforced separately, at
// the DB layer, by claim_scheduled_invoice/claim_parked_event_fee's own
// jobs-row FOR SHARE check — this TypeScript gate exists for the
// API-route paths, not the scheduler, which never goes through this
// function).
export type BillingGatedOperation = 'monetary_action' | 'approve' | 'rebuild_schedule'

export type BillingGateResult =
  | { allowed: true }
  | { allowed: false; reason: string }

export function describeBillingHoldReason(reason: BillingHoldReason): string {
  switch (reason) {
    case 'reexecution':
      return 'This contract is currently being re-executed. Billing actions are temporarily unavailable until it completes.'
    case 'reconciliation_blocked':
      return 'Fresh commercial terms could not be safely reconciled with the current billing configuration. Resolve the outstanding review before billing can proceed.'
    case 'schedule_rebuild_required':
      return 'Commercial terms were updated and the billing schedule must be rebuilt before new billing actions can proceed.'
  }
}

const MALFORMED_HOLD_MESSAGE = 'Billing configuration hold could not be read safely. Refusing this action until it is resolved.'

// The single shared gate every route calls — never a bespoke per-route
// boolean check. Frozen behavior (17H.4B0D4H1A §3, carried forward
// verbatim from the design audits):
//   hold clear                                -> every operation allowed
//   reason=reexecution / reconciliation_blocked -> every operation rejected
//   reason=schedule_rebuild_required          -> monetary_action rejected;
//                                                 approve/rebuild_schedule
//                                                 allowed (these ARE the
//                                                 hold-resolving operations)
//   malformed non-null hold                   -> every operation rejected,
//                                                 including approve/
//                                                 rebuild_schedule (no
//                                                 exception — see
//                                                 ParsedBillingHold's own
//                                                 comment)
export function evaluateBillingGate(rawHold: unknown, operation: BillingGatedOperation): BillingGateResult {
  const parsed = parseBillingHold(rawHold)
  if (parsed.status === 'clear') return { allowed: true }
  if (parsed.status === 'malformed') return { allowed: false, reason: MALFORMED_HOLD_MESSAGE }

  const { reason } = parsed.hold
  if (operation !== 'monetary_action' && reason === 'schedule_rebuild_required') {
    return { allowed: true }
  }
  return { allowed: false, reason: describeBillingHoldReason(reason) }
}

// Used by approve/rebuild-schedule ONLY, after their own configureBilling
// call has already succeeded — never called speculatively before the
// resolving action completes. Returns true only when the hold that was
// active at the START of the request was specifically
// 'schedule_rebuild_required' (the exact state this action resolves) —
// clearing any other reason, or a hold that was already NULL (nothing to
// clear), is never this function's job.
export function shouldClearBillingHoldAfterSuccess(rawHoldAtRequestStart: unknown): boolean {
  const parsed = parseBillingHold(rawHoldAtRequestStart)
  return parsed.status === 'held' && parsed.hold.reason === 'schedule_rebuild_required'
}
