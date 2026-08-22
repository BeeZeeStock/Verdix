// Step 15 — billing reconciliation and correction-assessment lifecycle.
//
// Built entirely on Step 14's immutable execution ledger. No new mutable
// "reconciliation status" is persisted anywhere — every state here is
// DERIVED, on every read, from billing_execution_attempts/operations (via
// the same classifyPriorAttemptForSupersession/canSafelyRetryBillingOperation/
// fingerprint-reconstruction doctrine getOrCreateAttempt's own barrier
// uses — never reimplemented) plus a freshly recomputed "current intended
// billing plan". This is why reconciliation state survives a page reload
// without needing to persist anything new: re-deriving from the same
// immutable inputs always produces the same answer.
//
// Two independent questions, kept genuinely separate (item 4):
//   - BillingReconciliationState  — what does the execution ledger say
//                                    happened, and is there anything an
//                                    admin needs to resolve before this
//                                    job can safely proceed?
//   - BillingCorrectionAssessment — when an attempt executed under a
//                                    DIFFERENT plan than the one Verdix
//                                    currently believes should be billed,
//                                    what, structurally, is the financial
//                                    delta? An assessment only — it never
//                                    authorizes or performs a correction
//                                    (item 17).

import { supabaseServer } from './supabase'
import type { ContractTerms } from './types'
import { resolveVatTreatment } from './vat'
import { getCustomerVatConfig } from './vat-service'
import type { OperationalEventEvidence } from './operational-event-evidence'
import {
  buildBillingPlanSnapshot, fingerprintBillingPlan, planComponentKey, excludePriorSnapshotFromAlreadySent,
  type BillingPlanSnapshot,
} from './billing-execution-plan'
import {
  classifyPriorAttemptForSupersession, canSafelyRetryBillingOperation,
  type BillingExecutionAttempt, type BillingExecutionOperation, type BillingExecutionOperationStatus,
  type BillingOperationRetryCapability,
} from './billing-execution-attempt'
import { getAttemptsForJob, getAttemptOperations } from './billing-execution-store'
import { computeBillingSchedule, type LineItemInput } from './billing-writer'

// ── Part 1 — pure state model ───────────────────────────────────────────

export interface BillingReconciliationOperationView {
  id: string
  operationType: string
  operationKey: string
  status: BillingExecutionOperationStatus
  retryCapability: BillingOperationRetryCapability
  externalObjectId: string | null
  startedAt: string | null
  // Only meaningful for an outcome_uncertain, idempotent_retry operation —
  // null otherwise (nothing to gate). Reuses canSafelyRetryBillingOperation
  // directly rather than re-deriving the time-boundary rule.
  idempotencyWindowStillValid: boolean | null
}

export type BillingReconciliationState =
  | { kind: 'none' }
  // Latest attempt (if any) is safe_to_supersede — nothing blocks the
  // ordinary Step 14 retry/approve path. Named distinctly from 'none' so
  // the UI can say "previous push failed cleanly" rather than presenting
  // a job that has genuinely never been pushed identically to one that
  // failed with zero side effects.
  | { kind: 'safe_to_resume'; attemptId: string; provider: BillingExecutionAttempt['provider'] }
  | {
      kind: 'operation_outcome_uncertain'
      attemptId: string
      provider: BillingExecutionAttempt['provider']
      operations: BillingReconciliationOperationView[]
      uncertainOperationIds: string[]
    }
  | {
      kind: 'partially_executed'
      attemptId: string
      provider: BillingExecutionAttempt['provider']
      operations: BillingReconciliationOperationView[]
    }
  | { kind: 'executed_same_plan'; attemptId: string; provider: BillingExecutionAttempt['provider'] }
  | {
      kind: 'executed_plan_changed'
      attemptId: string
      provider: BillingExecutionAttempt['provider']
      executedFingerprint: string
      currentFingerprint: string
    }

/**
 * Item 3 — the ONE canonical resolver. Pure: no I/O, no ambient Date.now()
 * (asOf is always passed in). Scans `attempts` newest-first exactly the
 * way getOrCreateAttempt's own barrier does (lib/billing-execution-
 * store.ts) — reusing classifyPriorAttemptForSupersession directly rather
 * than re-deriving the same judgment a second way. In every state
 * currently reachable through that barrier, at most the LATEST attempt is
 * ever non-safe_to_supersede (the barrier never lets a new attempt exist
 * while an older one is still unresolved/executed/partially executed) —
 * but this function does not assume that as a shortcut; it performs the
 * identical scan, so it stays correct even if that invariant ever changes.
 */
export function deriveBillingReconciliationState(params: {
  attempts: BillingExecutionAttempt[] // non-cancelled, newest-first (see getAttemptsForJob)
  operationsByAttemptId: Map<string, BillingExecutionOperation[]>
  recomputeFingerprintExcludingPriorSnapshot: (priorSnapshot: BillingPlanSnapshot) => string
  asOf: Date
}): BillingReconciliationState {
  const { attempts, operationsByAttemptId, recomputeFingerprintExcludingPriorSnapshot, asOf } = params

  if (attempts.length === 0) return { kind: 'none' }

  for (const attempt of attempts) {
    const operations = operationsByAttemptId.get(attempt.id) ?? []
    const classification = classifyPriorAttemptForSupersession(operations.map(o => o.status))

    if (classification === 'safe_to_supersede') continue // keep scanning older attempts

    const toView = (op: BillingExecutionOperation): BillingReconciliationOperationView => ({
      id: op.id, operationType: op.operationType, operationKey: op.operationKey, status: op.status,
      retryCapability: op.retryCapability, externalObjectId: op.externalObjectId, startedAt: op.startedAt,
      idempotencyWindowStillValid: op.status === 'outcome_uncertain'
        ? canSafelyRetryBillingOperation(op, asOf)
        : null,
    })

    if (classification === 'unresolved') {
      return {
        kind: 'operation_outcome_uncertain',
        attemptId: attempt.id, provider: attempt.provider,
        operations: operations.map(toView),
        uncertainOperationIds: operations.filter(o => o.status === 'outcome_uncertain').map(o => o.id),
      }
    }

    if (classification === 'partially_executed') {
      return { kind: 'partially_executed', attemptId: attempt.id, provider: attempt.provider, operations: operations.map(toView) }
    }

    // classification === 'executed'
    const comparableFingerprint = recomputeFingerprintExcludingPriorSnapshot(attempt.billingPlanSnapshot as BillingPlanSnapshot)
    if (comparableFingerprint === attempt.billingPlanFingerprint) {
      return { kind: 'executed_same_plan', attemptId: attempt.id, provider: attempt.provider }
    }
    return {
      kind: 'executed_plan_changed', attemptId: attempt.id, provider: attempt.provider,
      executedFingerprint: attempt.billingPlanFingerprint, currentFingerprint: comparableFingerprint,
    }
  }

  // Every attempt scanned was safe_to_supersede — reference the most
  // recent one so the UI can still say "last attempt failed cleanly".
  return { kind: 'safe_to_resume', attemptId: attempts[0].id, provider: attempts[0].provider }
}

// ── Part 2 — server-derived available actions (item 21) ────────────────

export interface BillingReconciliationCapabilities {
  canVerifySucceeded: boolean
  canVerifyNotExecuted: boolean
  canAuthorizeResume: boolean
  correctionRequired: boolean
  noAutomaticAction: boolean
}

export function deriveReconciliationCapabilities(state: BillingReconciliationState): BillingReconciliationCapabilities {
  const none: BillingReconciliationCapabilities = {
    canVerifySucceeded: false, canVerifyNotExecuted: false, canAuthorizeResume: false,
    correctionRequired: false, noAutomaticAction: false,
  }
  switch (state.kind) {
    case 'none':
      return { ...none, noAutomaticAction: true }
    case 'safe_to_resume':
      return { ...none, canAuthorizeResume: true }
    case 'operation_outcome_uncertain':
      // Reconciliation (verify succeeded / not executed) is only offered
      // when there is a genuinely outcome_uncertain operation to resolve.
      // A defensive 'unresolved' classification with no outcome_uncertain
      // operation at all (only pending/started — see the resolver's own
      // comment) has nothing an admin can verify yet.
      return { ...none, canVerifySucceeded: state.uncertainOperationIds.length > 0, canVerifyNotExecuted: state.uncertainOperationIds.length > 0 }
    case 'partially_executed':
      // Item 16 — conservative by design: no automatic action, and no
      // correction assessment is computed for a partial outcome either
      // (the DAG does not prove the remaining state is deterministic).
      return { ...none, noAutomaticAction: true }
    case 'executed_same_plan':
      // Nothing for an admin to do — the next Approve/page load recovers
      // the job automatically (item 9: never ask for unnecessary work).
      return { ...none, noAutomaticAction: true }
    case 'executed_plan_changed':
      return { ...none, correctionRequired: true }
  }
}

// ── Part 3 — correction assessment (items 5, 7, 8) ──────────────────────

export interface BillingCorrectionComponentDelta {
  componentKey: string
  executedAmount: number
  currentAmount: number
  deltaAmount: number // currentAmount - executedAmount, rounded to 2dp
}

export type BillingCorrectionAssessment =
  | { kind: 'none' }
  | { kind: 'additional_charge_indicated'; totalDelta: number; components: BillingCorrectionComponentDelta[] }
  | { kind: 'credit_indicated'; totalDelta: number; components: BillingCorrectionComponentDelta[] }
  | { kind: 'mixed_adjustment_indicated'; netDelta: number; components: BillingCorrectionComponentDelta[] }
  | { kind: 'manual_assessment_required'; reasons: string[] }

/**
 * Item 5/7/8 — a deterministic comparison between what an EXECUTED attempt
 * actually sent and what Verdix currently believes should be billed for
 * the SAME set of components (the counterfactual snapshot — see item 6's
 * comment on why a raw "current plan" snapshot cannot be compared
 * directly: it excludes whatever was already sent, which would make every
 * executed component look "removed"). Matches lines ONLY by their stable
 * componentKey (item 8) — never by description/label/array position — and
 * refuses (manual_assessment_required) rather than guesses whenever a
 * component can't be safely compared: present in only one snapshot, or
 * with a changed VAT treatment. This is an ASSESSMENT ONLY — it never
 * creates an invoice, credit note, or provider mutation (item 17).
 */
export function assessBillingCorrection(params: {
  executedSnapshot: BillingPlanSnapshot
  currentCounterfactualSnapshot: BillingPlanSnapshot
}): BillingCorrectionAssessment {
  const { executedSnapshot, currentCounterfactualSnapshot } = params
  const reasons: string[] = []

  if (executedSnapshot.provider !== currentCounterfactualSnapshot.provider) {
    reasons.push(`Provider changed since execution (executed: ${executedSnapshot.provider}, current: ${currentCounterfactualSnapshot.provider}).`)
  }
  if (executedSnapshot.customerIdentityKey !== currentCounterfactualSnapshot.customerIdentityKey) {
    reasons.push('Customer identity (name/org number) changed since execution — financial rows cannot be safely compared.')
  }
  if (executedSnapshot.currency !== currentCounterfactualSnapshot.currency) {
    reasons.push(`Currency changed since execution (executed: ${executedSnapshot.currency}, current: ${currentCounterfactualSnapshot.currency}).`)
  }
  if (reasons.length > 0) return { kind: 'manual_assessment_required', reasons }

  const executedByKey = new Map(executedSnapshot.lines.map(l => [l.componentKey, l]))
  const currentByKey = new Map(currentCounterfactualSnapshot.lines.map(l => [l.componentKey, l]))
  const allKeys = new Set([...executedByKey.keys(), ...currentByKey.keys()])

  const components: BillingCorrectionComponentDelta[] = []
  for (const key of allKeys) {
    const executedLine = executedByKey.get(key) ?? null
    const currentLine = currentByKey.get(key) ?? null
    // Item 8 — a component present in only one snapshot cannot be safely
    // mapped to a delta (it may be a genuine addition/removal, or it may
    // be a structural re-indexing artifact from a changed contract term
    // length). Never guessed either way.
    if (!executedLine || !currentLine) {
      reasons.push(`Component "${key}" exists in only one of the executed/current plans — cannot be safely compared.`)
      continue
    }
    if (executedLine.vatMode !== currentLine.vatMode || executedLine.vatRatePct !== currentLine.vatRatePct) {
      reasons.push(`Component "${key}": VAT treatment changed since execution — cannot be safely converted to a monetary delta.`)
      continue
    }
    const delta = Math.round((currentLine.amount - executedLine.amount) * 100) / 100
    if (delta === 0) continue
    components.push({ componentKey: key, executedAmount: executedLine.amount, currentAmount: currentLine.amount, deltaAmount: delta })
  }
  if (reasons.length > 0) return { kind: 'manual_assessment_required', reasons }
  if (components.length === 0) return { kind: 'none' }

  const netDelta = Math.round(components.reduce((sum, c) => sum + c.deltaAmount, 0) * 100) / 100
  const hasPositive = components.some(c => c.deltaAmount > 0)
  const hasNegative = components.some(c => c.deltaAmount < 0)
  if (hasPositive && hasNegative) return { kind: 'mixed_adjustment_indicated', netDelta, components }
  if (hasPositive) return { kind: 'additional_charge_indicated', totalDelta: netDelta, components }
  return { kind: 'credit_indicated', totalDelta: netDelta, components }
}

// ── Part 4 — read-only gathering (I/O), the sole non-pure part ─────────

export interface BillingReconciliationResult {
  state: BillingReconciliationState
  capabilities: BillingReconciliationCapabilities
  correctionAssessment: BillingCorrectionAssessment
}

/**
 * Item 19's data source. Read-only throughout — no writes, no
 * planned_invoices cleanup (unlike billing-writer.ts's configureStripe/
 * configureRememhill, which mutate as part of a real push). Mirrors their
 * "gather the current billing plan" setup independently rather than
 * refactoring the already-shipped execution path to share it — Step 15's
 * own instruction is "do not change commercial semantics or calculations",
 * and this stays strictly read-only.
 *
 * Provider is derived from the job's own execution-attempt HISTORY (the
 * most recent attempt's own `provider` column), never from
 * `jobs.billing_platform` — that column is only ever written on a
 * SUCCESSFUL Approve (see approve/route.ts), so a job that failed before
 * ever completing can have real attempt history on a specific provider
 * while `jobs.billing_platform` is still null. A prior version of
 * authorize-billing-retry defaulted to `?? 'stripe'` in that situation,
 * silently inspecting the wrong provider's (empty) attempt history for a
 * job actually pushed to Remembill — fixed alongside this module (see
 * authorize-billing-retry/route.ts).
 */
export async function getBillingReconciliationState(jobId: string, orgId: string, asOf: Date): Promise<BillingReconciliationResult> {
  const { data: latestAnyProviderAttempt } = await supabaseServer
    .from('billing_execution_attempts')
    .select('provider')
    .eq('job_id', jobId)
    .order('attempt_number', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!latestAnyProviderAttempt) {
    const state: BillingReconciliationState = { kind: 'none' }
    return { state, capabilities: deriveReconciliationCapabilities(state), correctionAssessment: { kind: 'none' } }
  }
  const provider = latestAnyProviderAttempt.provider as BillingExecutionAttempt['provider']

  const attempts = await getAttemptsForJob(jobId, provider)
  const operationsByAttemptId = new Map<string, BillingExecutionOperation[]>()
  for (const attempt of attempts) {
    operationsByAttemptId.set(attempt.id, await getAttemptOperations(attempt.id))
  }

  const { data: jobRow } = await supabaseServer
    .from('jobs')
    .select('billing_customer_id, contract_terms ( * ), line_items ( * ), pending_vat_mode, pending_vat_rate_pct')
    .eq('id', jobId).eq('org_id', orgId).maybeSingle()
  if (!jobRow) {
    const state: BillingReconciliationState = { kind: 'none' }
    return { state, capabilities: deriveReconciliationCapabilities(state), correctionAssessment: { kind: 'none' } }
  }
  const termsRaw = jobRow.contract_terms as unknown
  const terms = (Array.isArray(termsRaw) ? termsRaw[0] : termsRaw) as ContractTerms | null
  const lineItems = ((jobRow.line_items as LineItemInput[] | null) ?? [])
  const existingCustomerId = jobRow.billing_customer_id as string | null

  const { data: evidenceRows } = await supabaseServer
    .from('operational_event_evidence').select('*').eq('job_id', jobId).eq('status', 'active')
  const evidence: OperationalEventEvidence[] = (evidenceRows ?? []).map(r => ({
    id: r.id, subjectId: r.subject_id, eventType: r.event_type,
    occurredAt: r.occurred_at, source: r.source, recordedAt: r.recorded_at, recordedBy: r.recorded_by, status: r.status,
  }))

  // billing-writer.ts's configureStripe never resolves real VAT treatment
  // into the plan snapshot at all — it fixes `{ mode: 'not_configured' }`
  // unconditionally (Stripe Tax/manual VAT are out of scope there; see its
  // own comment) — so a Stripe attempt's stored snapshot ALWAYS used that
  // placeholder, regardless of what customer_vat_config held even at the
  // moment it was created. Resolving REAL VAT config here for a Stripe job
  // would make the counterfactual/correction comparison see a "VAT
  // treatment changed" mismatch on every single component the moment
  // approve/route.ts's post-push VAT promotion runs — a false positive,
  // not a real commercial change. Mirrored exactly, not reinterpreted.
  let vat: { mode: 'rate' | 'zero_rated' | 'not_configured'; ratePct: number | null }
  if (provider === 'stripe') {
    vat = { mode: 'not_configured', ratePct: null }
  } else if (existingCustomerId) {
    const treatment = await getCustomerVatConfig(orgId, existingCustomerId)
    vat = treatment ? resolveVatTreatment(treatment, null) : { mode: 'not_configured', ratePct: null }
  } else {
    vat = {
      mode: (jobRow.pending_vat_mode as 'rate' | 'zero_rated' | 'not_configured' | null) ?? 'not_configured',
      ratePct: jobRow.pending_vat_mode === 'rate' ? (jobRow.pending_vat_rate_pct as number | null) : null,
    }
  }

  const { data: sentRows } = await supabaseServer
    .from('planned_invoices')
    .select('year_num, period_start, invoice_type, fee_label')
    .eq('job_id', jobId).in('status', ['sent', 'paid'])
  const alreadySentKeys = new Set((sentRows ?? []).map(r => planComponentKey({
    invoice_type: r.invoice_type, year_num: r.year_num, period_start: r.period_start, fee_label: r.fee_label,
  })))

  const now = asOf
  const buildCurrentSnapshot = (excludeKeys: Set<string>): BillingPlanSnapshot => buildBillingPlanSnapshot({
    terms: terms ?? ({} as ContractTerms), lineItems, evidence, alreadySentKeys: excludeKeys, provider, vat, now, computeBillingSchedule,
  })
  const recomputeFingerprintExcludingPriorSnapshot = (priorSnapshot: BillingPlanSnapshot): string =>
    fingerprintBillingPlan(buildCurrentSnapshot(excludePriorSnapshotFromAlreadySent(alreadySentKeys, priorSnapshot)))

  const state = deriveBillingReconciliationState({ attempts, operationsByAttemptId, recomputeFingerprintExcludingPriorSnapshot, asOf })
  const capabilities = deriveReconciliationCapabilities(state)

  let correctionAssessment: BillingCorrectionAssessment = { kind: 'none' }
  if (state.kind === 'executed_plan_changed') {
    const executedAttempt = attempts.find(a => a.id === state.attemptId)!
    const executedSnapshot = executedAttempt.billingPlanSnapshot as BillingPlanSnapshot
    const currentCounterfactualSnapshot = buildCurrentSnapshot(excludePriorSnapshotFromAlreadySent(alreadySentKeys, executedSnapshot))
    correctionAssessment = assessBillingCorrection({ executedSnapshot, currentCounterfactualSnapshot })
  }

  return { state, capabilities, correctionAssessment }
}
