// Step 14 — persistence for BillingExecutionAttempt/Operation/AdminAction.
// Every write here goes through supabaseServer (service-role only — see
// the migration's RLS policies); this module is the sole place that reads
// or writes these three tables, so callers (billing-writer.ts, approve/
// route.ts, authorize-billing-retry) never touch raw table names directly.
import { supabaseServer } from './supabase'
import type { BillingPlanSnapshot } from './billing-execution-plan'
import {
  classifyPriorAttemptForSupersession,
  type BillingExecutionAttempt, type BillingExecutionAttemptStatus,
  type BillingExecutionOperation, type BillingExecutionOperationStatus,
  type BillingOperationRetryCapability, type BillingExecutionAdminActionType,
} from './billing-execution-attempt'

// Item 4 — thrown when an existing, still-in-flight (non-terminal) attempt
// for this job+provider was found with a DIFFERENT billing-plan
// fingerprint than the one just computed. Should not be reachable in the
// normal flow (the APPROVING claim already serializes one attempt at a
// time per job, and the stuck-APPROVING admin recovery path resolves any
// lingering non-terminal attempt before a job can be re-approved) — kept
// as an explicit, typed, fail-closed guard rather than silently creating a
// second attempt the DB's own uniqueness index would reject anyway.
export class BillingPlanChangedWhileAttemptInFlightError extends Error {
  constructor(public readonly existingAttemptId: string) {
    super(`An execution attempt (${existingAttemptId}) is already in flight for a different billing plan — resolve it before starting a new one.`)
  }
}

// Step 14 final amendment, items 1-4 — "a new commercial plan does not
// erase uncertainty about money that may already have been sent under the
// old plan." Thrown when creating attempt N+1 for a CHANGED billing plan
// (a different fingerprint than the latest attempt) would otherwise
// proceed while an EARLIER attempt for this same job+provider still has an
// operation with a genuinely unresolved (outcome_uncertain) financial
// outcome. approve/route.ts surfaces this as 409 unresolved_prior_billing_
// attempt — nothing new was attempted in the request that triggers this
// (the barrier fires before any provider call for the new plan), so the
// job is restored to its real prior state, same as a BillingPreconditionError.
export class UnresolvedPriorBillingAttemptError extends Error {
  constructor(public readonly unresolvedAttemptId: string) {
    super(`A prior billing execution attempt (${unresolvedAttemptId}) has an unresolved operation outcome — it must be reconciled before a new billing plan can be executed for this job.`)
  }
}

// Step 14 final financial-state correction — "a prior execution outcome
// being known does NOT necessarily mean a new billing attempt may replace
// it." Thrown when a prior attempt's operations classify as 'executed'
// (lib/billing-execution-attempt.ts's classifyPriorAttemptForSupersession)
// — every operation succeeded, so the intended financial side effect
// definitely already happened. approve/route.ts catches this specifically
// and RECOVERS the job to COMPLETED from the attempt's own already-known
// results — never creates a new attempt, never replays any provider call.
export class PriorBillingAttemptExecutedError extends Error {
  constructor(public readonly executedAttemptId: string) {
    super(`A prior billing execution attempt (${executedAttemptId}) already succeeded — the financial side effect already happened. The job must be recovered to COMPLETED from that attempt, never re-executed.`)
  }
}

// Step 14 final state-integrity correction — "a prior attempt succeeded"
// and "the current commercial plan matches what was executed" are two
// separate facts. Thrown instead of PriorBillingAttemptExecutedError when
// a prior attempt's operations classify as 'executed' BUT its stored
// billing_plan_fingerprint differs from the fingerprint just computed for
// the job's CURRENT commercial state — e.g. billing succeeded under plan
// A, then the contract/terms were edited, producing plan B. The real
// financial side effect (plan A) remains the authoritative record of what
// was actually billed; it must never be silently presented as covering
// plan B (no auto-recovery to COMPLETED), and plan B must never be
// silently executed either (no new attempt, no provider call). Step 14
// deliberately does not build the correction/reconciliation workflow this
// implies — approve/route.ts surfaces this as a structured, fail-closed
// 409 (billing_already_executed_plan_changed) and stops there.
export class PriorBillingAttemptExecutedPlanChangedError extends Error {
  constructor(
    public readonly executedAttemptId: string,
    public readonly executedFingerprint: string,
    public readonly currentFingerprint: string,
  ) {
    super(`A prior billing execution attempt (${executedAttemptId}) already succeeded under a different billing plan (fingerprint ${executedFingerprint}) than the currently computed plan (fingerprint ${currentFingerprint}). The executed plan remains the authoritative billing record; the current plan cannot be recovered as COMPLETED and cannot be automatically re-executed — this requires an explicit correction/reconciliation workflow, not built in Step 14.`)
  }
}

// Step 14 final financial-state correction, item 5 — thrown when a prior
// attempt's operations classify as 'partially_executed': a genuine mix of
// succeeded and failed operations, meaning real external objects already
// exist but the attempt did not fully accomplish its send. The outcome is
// completely KNOWN, but that alone is not "safe to supersede" — a fresh
// attempt would either duplicate the succeeded part or have no way to
// finish the rest. Step 14 deliberately does not build the credit/rebill/
// amendment machinery that would let this resolve automatically (item 9)
// — this blocks and requires manual recovery.
export class PriorBillingAttemptPartiallyExecutedError extends Error {
  constructor(public readonly partiallyExecutedAttemptId: string) {
    super(`A prior billing execution attempt (${partiallyExecutedAttemptId}) partially succeeded — some financial side effects already occurred and some did not. This cannot be safely superseded by a new attempt; manual recovery is required.`)
  }
}

type Row = Record<string, unknown>

function toAttempt(row: Row): BillingExecutionAttempt {
  return {
    id: row.id as string, organizationId: row.org_id as string, jobId: row.job_id as string,
    provider: row.provider as BillingExecutionAttempt['provider'], attemptNumber: row.attempt_number as number,
    billingPlanFingerprint: row.billing_plan_fingerprint as string, billingPlanSnapshot: row.billing_plan_snapshot,
    status: row.status as BillingExecutionAttemptStatus,
    createdAt: row.created_at as string, startedAt: row.started_at as string | null, completedAt: row.completed_at as string | null,
    retryOfAttemptId: row.retry_of_attempt_id as string | null,
  }
}

function toOperation(row: Row): BillingExecutionOperation {
  return {
    id: row.id as string, attemptId: row.attempt_id as string, operationKey: row.operation_key as string,
    operationType: row.operation_type as string, idempotencyKey: row.idempotency_key as string | null,
    status: row.status as BillingExecutionOperationStatus, externalObjectId: row.external_object_id as string | null,
    requestFingerprint: row.request_fingerprint as string, retryCapability: row.retry_capability as BillingOperationRetryCapability,
    errorClass: row.error_class as string | null, startedAt: row.started_at as string | null, completedAt: row.completed_at as string | null,
  }
}

/**
 * Item 11/12 — the ONE entry point that decides "resume the existing
 * in-flight attempt" vs "start attempt N+1". Two concurrent callers racing
 * this for the same (jobId, provider) converge on one row: the second
 * insert loses to the partial unique index (billing_execution_attempts_
 * one_active_uidx) and this function catches that and re-reads instead of
 * surfacing a raw constraint violation.
 */
export async function getOrCreateAttempt(params: {
  orgId: string; jobId: string; provider: 'stripe' | 'remembill' | 'chargebee'
  fingerprint: string; snapshot: BillingPlanSnapshot
  // Step 14 final state-integrity correction — `fingerprint` above is
  // "what's due RIGHT NOW", which excludes anything planned_invoices
  // already has marked sent — including whatever a prior, now-fully-
  // succeeded attempt just sent as a direct result of succeeding. So a
  // freshly computed `fingerprint` will almost always differ from an
  // EXECUTED prior attempt's own stored fingerprint purely because that
  // attempt's own success drained the queue, NOT because the underlying
  // commercial data changed. Comparing them directly (as every OTHER
  // fingerprint comparison in this function correctly does, since nothing
  // else here can have altered alreadySentKeys) would misclassify every
  // ordinary crash-before-COMPLETED recovery as a changed plan. This
  // callback — supplied by the caller, which alone has the terms/
  // lineItems/evidence/vat/computeBillingSchedule needed — reconstructs
  // the counterfactual: "what would the plan fingerprint as, right now,
  // if this SPECIFIC prior attempt's own already-sent lines were treated
  // as still pending." Only ever invoked for a prior attempt classified
  // 'executed' below; every other classification's prior attempt never
  // advanced alreadySentKeys, so the top-level `fingerprint` is already a
  // correct, direct comparison for those.
  recomputeFingerprintExcludingPriorSnapshot: (priorSnapshot: BillingPlanSnapshot) => string
}): Promise<BillingExecutionAttempt> {
  const { orgId, jobId, provider, fingerprint, snapshot, recomputeFingerprintExcludingPriorSnapshot } = params

  const { data: existing } = await supabaseServer
    .from('billing_execution_attempts')
    .select('*').eq('job_id', jobId).eq('provider', provider)
    .in('status', ['created', 'executing']).maybeSingle()

  if (existing) {
    if (existing.billing_plan_fingerprint !== fingerprint) {
      throw new BillingPlanChangedWhileAttemptInFlightError(existing.id as string)
    }
    return toAttempt(existing)
  }

  // All non-active attempts for this job+provider, most recent first —
  // used for both the item 16 case A/B resume check below AND the item
  // 1-4 unresolved-attempt barrier.
  const { data: allPrior } = await supabaseServer
    .from('billing_execution_attempts')
    .select('*').eq('job_id', jobId).eq('provider', provider)
    .order('attempt_number', { ascending: false })
  const latest = allPrior?.[0] ?? null

  // Item 16 case A/B — the MOST RECENT attempt for this job+provider may be
  // a prior failed_safe/outcome_uncertain attempt an admin has just
  // explicitly authorized a retry for (approve/route.ts's claim boundary
  // only reaches this code path from a FAILED job via that explicit
  // authorization — see authorize-billing-retry/route.ts). Reusing its id
  // — rather than creating attempt_number+1 — is what makes idempotency
  // keys (item 6, derived FROM the attempt id) stay stable across the
  // retry: a fresh attempt would mean fresh keys for every operation,
  // including ones that already genuinely succeeded, defeating the entire
  // mechanism. Only reused when the fingerprint STILL matches (item 22 —
  // a changed billing plan must never resume an old attempt; falls
  // through to the barrier/fresh-attempt path below when it doesn't). This
  // path is intentionally NOT gated by the barrier below: continuing the
  // SAME financial execution (same attempt, same operations, same keys)
  // is exactly what the barrier exists to keep possible — the actual
  // per-operation safety of resuming an outcome_uncertain operation is
  // decided at the operation level (runTrackedOperation's own
  // canSafelyRetryBillingOperation check), not here.
  if (latest && (latest.status === 'failed_safe' || latest.status === 'outcome_uncertain') && latest.billing_plan_fingerprint === fingerprint) {
    await supabaseServer.from('billing_execution_attempts').update({ status: 'executing' }).eq('id', latest.id)
    return toAttempt({ ...latest, status: 'executing' })
  }

  // Step 14 final financial-state correction (items 1-8) — reaching this
  // point means either there is no prior attempt at all, or the
  // fingerprint has changed (a new/different billing plan). Before
  // creating a genuinely NEW attempt_number, every PRIOR attempt for this
  // job+provider — not just the latest — must be SAFE TO SUPERSEDE, not
  // merely "resolved". A resolved (non-uncertain) prior attempt is not
  // automatically safe to replace: 'succeeded' means the financial side
  // effect definitely happened (must recover the JOB from it, never
  // create a new attempt); a genuine mix of succeeded/failed operations
  // means real external objects already exist (blocks, needs manual
  // recovery — Step 14 does not build credit/rebill machinery). Only an
  // attempt where NO operation ever succeeded (or one with no operations
  // at all) is genuinely safe to supersede. Always checked directly
  // against the CURRENT operation rows (never the attempt's own
  // possibly-stale cached status field) — reconcile-billing-operation
  // recomputes that field when reconciliation completes an attempt, but
  // this check does not rely on that being current. 'cancelled' is
  // trivially skipped (by definition only ever set after verification that
  // execution did not occur — see item 2's own "where such an action is
  // supported" caveat; no route currently sets it).
  for (const prior of allPrior ?? []) {
    if (prior.status === 'cancelled') continue
    const { data: priorOps } = await supabaseServer
      .from('billing_execution_operations').select('status')
      .eq('attempt_id', prior.id)
    const classification = classifyPriorAttemptForSupersession((priorOps ?? []).map(o => o.status as BillingExecutionOperationStatus))
    if (classification === 'unresolved') throw new UnresolvedPriorBillingAttemptError(prior.id as string)
    if (classification === 'executed') {
      // Do NOT compare prior.billing_plan_fingerprint to the top-level
      // `fingerprint` directly — see this function's own param doc.
      // `fingerprint` already reflects THIS attempt's own sends as
      // "already sent", so it would almost never equal the prior
      // attempt's stored value even when nothing commercial changed.
      // Reconstruct the counterfactual instead: same current commercial
      // data, but with this specific prior attempt's own lines excluded
      // from "already sent" (i.e. as if it hadn't sent them yet).
      const comparableFingerprint = recomputeFingerprintExcludingPriorSnapshot(prior.billing_plan_snapshot as BillingPlanSnapshot)
      // Same reconstructed fingerprint -> the underlying commercial data
      // is unchanged since this attempt executed; this is the ordinary
      // crash-before-COMPLETED case (approve/route.ts recovers the job to
      // COMPLETED from this attempt's own results). Different -> the
      // executed plan and the current plan are two different things;
      // recovering to COMPLETED would silently misrepresent the new plan
      // as billed, and creating a new attempt would risk double-billing.
      if (comparableFingerprint === (prior.billing_plan_fingerprint as string)) {
        throw new PriorBillingAttemptExecutedError(prior.id as string)
      }
      throw new PriorBillingAttemptExecutedPlanChangedError(prior.id as string, prior.billing_plan_fingerprint as string, comparableFingerprint)
    }
    if (classification === 'partially_executed') throw new PriorBillingAttemptPartiallyExecutedError(prior.id as string)
    // 'safe_to_supersede' — continue checking the remaining prior attempts.
  }

  const nextAttemptNumber = ((latest?.attempt_number as number | undefined) ?? 0) + 1

  const { data: created, error } = await supabaseServer
    .from('billing_execution_attempts')
    .insert({
      org_id: orgId, job_id: jobId, provider, attempt_number: nextAttemptNumber,
      billing_plan_fingerprint: fingerprint, billing_plan_snapshot: snapshot, status: 'created',
    })
    .select('*').single()

  if (error) {
    // Lost the race against a concurrent caller — re-read and treat as resume.
    const { data: winner } = await supabaseServer
      .from('billing_execution_attempts')
      .select('*').eq('job_id', jobId).eq('provider', provider)
      .in('status', ['created', 'executing']).maybeSingle()
    if (winner) {
      if (winner.billing_plan_fingerprint !== fingerprint) {
        throw new BillingPlanChangedWhileAttemptInFlightError(winner.id as string)
      }
      return toAttempt(winner)
    }
    throw new Error(`Failed to create billing execution attempt: ${error.message}`)
  }
  return toAttempt(created)
}

export async function markAttemptExecuting(attemptId: string): Promise<void> {
  await supabaseServer.from('billing_execution_attempts')
    .update({ status: 'executing', started_at: new Date().toISOString() })
    .eq('id', attemptId).eq('status', 'created')
}

export async function markAttemptStatus(attemptId: string, status: BillingExecutionAttemptStatus): Promise<void> {
  const terminal = status === 'succeeded' || status === 'failed_safe' || status === 'outcome_uncertain' || status === 'cancelled'
  await supabaseServer.from('billing_execution_attempts')
    .update({ status, ...(terminal ? { completed_at: new Date().toISOString() } : {}) })
    .eq('id', attemptId)
}

/**
 * Item 10/20 — idempotent operation-row creation: if this exact
 * (attempt, operationKey) already has a row (a resume after a crash, or a
 * retry within the same attempt), return the EXISTING row untouched rather
 * than inserting a duplicate or overwriting its recorded identity — the
 * unique(attempt_id, operation_key) constraint is the authoritative
 * enforcement; this function's own SELECT-then-INSERT is just the
 * ergonomic path to the same guarantee.
 */
export async function getOrCreateOperation(params: {
  attemptId: string; operationKey: string; operationType: string
  idempotencyKey: string | null; requestFingerprint: string; retryCapability: BillingOperationRetryCapability
}): Promise<BillingExecutionOperation> {
  const { attemptId, operationKey, operationType, idempotencyKey, requestFingerprint, retryCapability } = params
  const { data: existing } = await supabaseServer
    .from('billing_execution_operations').select('*')
    .eq('attempt_id', attemptId).eq('operation_key', operationKey).maybeSingle()
  if (existing) return toOperation(existing)

  const { data: created, error } = await supabaseServer
    .from('billing_execution_operations')
    .insert({
      attempt_id: attemptId, operation_key: operationKey, operation_type: operationType,
      idempotency_key: idempotencyKey, request_fingerprint: requestFingerprint,
      retry_capability: retryCapability, status: 'pending',
    })
    .select('*').single()
  if (error) {
    const { data: winner } = await supabaseServer
      .from('billing_execution_operations').select('*')
      .eq('attempt_id', attemptId).eq('operation_key', operationKey).maybeSingle()
    if (winner) return toOperation(winner)
    throw new Error(`Failed to create billing execution operation: ${error.message}`)
  }
  return toOperation(created)
}

// Step 14 final amendment, item 9 — `started_at` anchors the provider's
// idempotency-retention clock (canSafelyRetryBillingOperation), so it must
// record when the request was FIRST attempted, never when a later retry
// re-enters this function. `isFirstAttempt` (the caller passes
// `op.startedAt === null`, i.e. the value already returned by
// getOrCreateOperation before this call) gates whether started_at is
// written at all — `status` still updates to 'started' every time,
// unconditionally, since that is state, not a timing anchor.
export async function markOperationStarted(operationId: string, isFirstAttempt: boolean): Promise<void> {
  await supabaseServer.from('billing_execution_operations')
    .update({ status: 'started', ...(isFirstAttempt ? { started_at: new Date().toISOString() } : {}) })
    .eq('id', operationId)
}

// Item 10 — persisted immediately after the external side effect succeeds,
// before moving on to the next operation.
export async function markOperationSucceeded(operationId: string, externalObjectId: string | null): Promise<void> {
  await supabaseServer.from('billing_execution_operations')
    .update({ status: 'succeeded', external_object_id: externalObjectId, completed_at: new Date().toISOString() })
    .eq('id', operationId)
}

export async function markOperationFailedSafe(operationId: string, errorClass: string): Promise<void> {
  await supabaseServer.from('billing_execution_operations')
    .update({ status: 'failed_safe', error_class: errorClass, completed_at: new Date().toISOString() })
    .eq('id', operationId)
}

export async function markOperationOutcomeUncertain(operationId: string, errorClass: string): Promise<void> {
  await supabaseServer.from('billing_execution_operations')
    .update({ status: 'outcome_uncertain', error_class: errorClass, completed_at: new Date().toISOString() })
    .eq('id', operationId)
}

// Step 14 final amendment, item 3 — "reconciliation must resolve the old
// attempt, not merely authorize the new one." Called by reconcile-
// billing-operation after it flips one operation away from
// outcome_uncertain. The unresolved-attempt barrier itself scans
// operations directly (never relies on this being current), so this is
// purely for observability/reporting — an attempt should never be left
// showing a stale 'outcome_uncertain' once every one of its operations
// has an individually determinate outcome. 'succeeded' only when every
// operation succeeded; 'failed_safe' when the mix is resolved but at
// least one operation did not (the attempt did not fully accomplish its
// send, but carries no remaining financial uncertainty — a fresh attempt
// may proceed). Left untouched if any operation is still outcome_uncertain.
export async function recomputeAttemptStatusIfFullyResolved(attemptId: string): Promise<void> {
  const { data: ops } = await supabaseServer.from('billing_execution_operations').select('status').eq('attempt_id', attemptId)
  if (!ops || ops.length === 0) return
  if (ops.some(o => o.status === 'outcome_uncertain')) return
  const allSucceeded = ops.every(o => o.status === 'succeeded')
  await supabaseServer.from('billing_execution_attempts')
    .update({ status: allSucceeded ? 'succeeded' : 'failed_safe', completed_at: new Date().toISOString() })
    .eq('id', attemptId)
}

export async function getAttemptOperations(attemptId: string): Promise<BillingExecutionOperation[]> {
  const { data } = await supabaseServer.from('billing_execution_operations').select('*').eq('attempt_id', attemptId).order('created_at', { ascending: true })
  return (data ?? []).map(toOperation)
}

export async function getLatestAttempt(jobId: string, provider: string): Promise<BillingExecutionAttempt | null> {
  const { data } = await supabaseServer
    .from('billing_execution_attempts').select('*')
    .eq('job_id', jobId).eq('provider', provider)
    .order('attempt_number', { ascending: false }).limit(1).maybeSingle()
  return data ? toAttempt(data) : null
}

export async function getAttemptById(attemptId: string): Promise<BillingExecutionAttempt | null> {
  const { data } = await supabaseServer.from('billing_execution_attempts').select('*').eq('id', attemptId).maybeSingle()
  return data ? toAttempt(data) : null
}

// Item 21 — called from the stuck-APPROVING crash-recovery path (jobs/[id]/
// route.ts's PATCH handler). A process crash mid-approval may have left a
// non-terminal (created/executing) attempt behind with no way to know its
// real outcome — marking it outcome_uncertain (never a silent 'succeeded'
// or 'failed_safe' guess) both reflects that honestly AND frees
// billing_execution_attempts_one_active_uidx so a future, explicitly
// admin-authorized retry can create a new attempt rather than being
// permanently blocked by this one. Returns the ids resolved, for the
// caller's own audit trail.
//
// Step 15 audit finding, fixed here — this previously updated ONLY the
// attempt's own status, leaving any of its operations still 'pending'/
// 'started' (the state a crash mid-call would realistically leave them in)
// untouched. reconcile-billing-operation requires an operation to be
// EXACTLY 'outcome_uncertain' before an admin can resolve it — a stuck
// 'pending'/'started' operation was therefore unreconcilable through any
// UI/API path, a real gap the reconciliation resolver's audit surfaced.
// Fixed by bringing operation-level state into sync with the attempt-level
// judgment at the moment of stuck-recovery, using the same operation-level
// classification (never silently upgraded to 'succeeded'/'failed_safe' —
// only ever the same honest 'outcome_uncertain' the attempt itself gets).
export async function resolveStuckAttemptsForJob(jobId: string): Promise<string[]> {
  const { data: stuck } = await supabaseServer
    .from('billing_execution_attempts').select('id')
    .eq('job_id', jobId).in('status', ['created', 'executing'])
  const ids = (stuck ?? []).map(r => r.id as string)
  for (const attemptId of ids) {
    await supabaseServer.from('billing_execution_attempts')
      .update({ status: 'outcome_uncertain', completed_at: new Date().toISOString() })
      .eq('id', attemptId)
    await supabaseServer.from('billing_execution_operations')
      .update({ status: 'outcome_uncertain', error_class: 'stuck_attempt_crash_recovery', completed_at: new Date().toISOString() })
      .eq('attempt_id', attemptId).in('status', ['pending', 'started'])
  }
  return ids
}

// Step 15 — all non-cancelled attempts for a job+provider, most recent
// first. Reused by the reconciliation resolver so it scans the SAME
// (attempt, provider) history getOrCreateAttempt's own barrier does,
// rather than assuming "only the latest attempt ever matters" as an
// unstated invariant — true today (the barrier never lets a new attempt
// exist alongside an unresolved/executed/partially-executed older one),
// but the resolver stays correct even if that invariant is ever
// loosened, since it performs the identical scan rather than a shortcut.
export async function getAttemptsForJob(jobId: string, provider: string): Promise<BillingExecutionAttempt[]> {
  const { data } = await supabaseServer
    .from('billing_execution_attempts').select('*')
    .eq('job_id', jobId).eq('provider', provider).neq('status', 'cancelled')
    .order('attempt_number', { ascending: false })
  return (data ?? []).map(toAttempt)
}

// Item 24 — append-only, enforced by triggers that reject every UPDATE/
// DELETE unconditionally for every role, including service_role (RLS
// alone is not sufficient — service_role bypasses it entirely; see
// 20260825000002_billing_execution_admin_actions_append_only.sql).
export async function recordAdminAction(params: {
  attemptId: string; operationId?: string | null; action: BillingExecutionAdminActionType
  actorEmail: string; externalObjectId?: string | null
}): Promise<void> {
  await supabaseServer.from('billing_execution_admin_actions').insert({
    attempt_id: params.attemptId, operation_id: params.operationId ?? null, action: params.action,
    actor_email: params.actorEmail, external_object_id: params.externalObjectId ?? null,
  })
}
