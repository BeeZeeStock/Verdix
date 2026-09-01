// Step 17H.4B0D4H1B3 — the shared billing_hold transition policy for every
// caller of the Model B+ reconciliation orchestration (execute's own
// re-execution generation, reconcile-line-items, confirm-rule). Pure
// computation lives here (computeReconciliationHoldTransition) — no
// Supabase import, directly unit-testable — separated from the I/O wrapper
// (applyReconciliationHoldTransition) that actually invokes the
// replace_billing_hold_if_unchanged RPC. Deliberately NOT part of
// lib/current-line-item-reconciliation-orchestration.ts: that module's own
// scope (17H.4B0D4H1B3 §13) is explicitly "does not own billing_hold" —
// this module is the separate, caller-invoked concern that decides WHAT
// the hold should become, given a reconciliation outcome and where the
// hold started; callers decide WHETHER to invoke it at all (e.g.
// reconcile-line-items/confirm-rule skip it entirely for a never-approved
// job, and reject outright before ever reaching it when the current hold
// reason is 'reexecution' — an active execute owns reconciliation then).
import type { SupabaseClient } from '@supabase/supabase-js'
import type { BillingHold } from './billing-hold'
import type { ReconciliationOrchestrationResult } from './current-line-item-reconciliation-orchestration'

// The four starting-hold shapes a reconciliation caller can legitimately
// be in when it decides to run this transition. 'malformed' is
// deliberately NOT a member here — every caller must reject a malformed
// hold BEFORE ever reaching this function (fail-closed, same doctrine as
// begin_job_reexecution's own SQL-side check), never pass it through.
export type ReconciliationHoldStartingKind =
  | 'clear'
  | 'reexecution'
  | 'schedule_rebuild_required'
  | 'reconciliation_blocked'

// A single, safely-representable diagnostic entry — never a raw error
// message or exception detail (17H.4B0D4H1B3 §16's "non-sensitive
// diagnostic details where safely representable"). Real planner blockers
// (ReconciliationBlocker[]) are also safely representable as-is (family/
// reason/affected ids — no free text from a customer document), so they
// pass straight into the hold's own `blockers` field unmodified.
export type ReconciliationBlockerDiagnosticEntry =
  | { type: 'stale_plan'; reason: 'current_set_changed' | 'current_row_changed' }
  | { type: 'invalid_plan'; reason: string }
  | { type: 'applier_error' }

// Builds the exact diagnostic array to embed in a reconciliation_blocked
// hold's `blockers` field from an orchestration outcome — real planner
// blockers when the applier actually ran (status 'applied' with
// blockers.length>0), a single synthetic entry for every other non-clean
// outcome. Never includes outcome.errorMessage's raw text — logged
// server-side by the caller instead, never persisted into a hold every
// billing-gate read can see.
export function buildReconciliationBlockerDiagnostic(
  outcome: ReconciliationOrchestrationResult,
): Array<ReconciliationBlockerDiagnosticEntry | ReconciliationOrchestrationResult['blockers'][number]> {
  if (outcome.status === 'applied') return outcome.blockers
  if (outcome.status === 'stale_plan') return [{ type: 'stale_plan', reason: outcome.staleReason ?? 'current_set_changed' }]
  if (outcome.status === 'invalid_plan') return [{ type: 'invalid_plan', reason: outcome.invalidReason ?? 'unknown' }]
  return [{ type: 'applier_error' }]
}

export function isReconciliationOutcomeClean(outcome: ReconciliationOrchestrationResult): boolean {
  return outcome.status === 'applied' && outcome.blockers.length === 0
}

export interface ReconciliationHoldTransitionResult {
  nextHold: BillingHold | null
  changeNeeded: boolean
}

// The frozen transition matrix (17H.4B0D4H1B3 §17/§18/§27/§29), one pure
// function shared by every caller:
//   schedule_rebuild_required -> NEVER touched, regardless of outcome —
//     reconciliation may run "if appropriate" from this state, but only
//     the explicit rebuild-schedule/approve actions may resolve it.
//   clear (previously-approved job, hold currently NULL) -> stays clear
//     only if the outcome is genuinely clean (zero mutations implied by
//     zero blockers is NOT checked here — mutation-count is a caller
//     concern for the 'clear' case specifically, see reconcile-line-items'
//     own call site); any non-clean outcome -> a fresh schedule_rebuild_
//     required (never reconciliation_blocked — a NULL-starting hold is
//     never promoted straight to "blocked," only "needs a schedule
//     rebuild," per explicit instruction).
//   reexecution -> clean: schedule_rebuild_required (when
//     hasExistingBillingSchedule — an existing schedule really may now be
//     stale) OR NULL (when it doesn't — there is no schedule to protect,
//     Step 17H.4B0D4H1B3.4), carrying the SAME started_at forward in the
//     schedule_rebuild_required case (generation identity, so a stale
//     concurrent operation can never mistake the new hold for its own).
//     Not clean: reconciliation_blocked REGARDLESS of hasExistingBilling
//     Schedule — an unresolved reconciliation problem must block first
//     approval exactly as it blocks a schedule rebuild; same started_at
//     carried forward, blockers attached.
//   reconciliation_blocked -> clean: promoted to a FRESH schedule_rebuild_
//     required (this generation's blocking issue is resolved, a new
//     generation identity is appropriate). Not clean: stays reconciliation_
//     blocked, with the LATEST blockers diagnostic (the underlying issue
//     may have changed even though it's still blocked).
export function computeReconciliationHoldTransition(params: {
  startingKind: ReconciliationHoldStartingKind
  currentHold: BillingHold | null
  outcomeClean: boolean
  // Step 17H.4B0D4H1B3.4 — required, not optional: forces every call site
  // to make an explicit decision rather than silently defaulting. Only
  // the 'reexecution' branch's CLEAN case reads it — a job with no
  // existing billing schedule has nothing for a clean outcome to make
  // stale, so it resolves to NULL instead of schedule_rebuild_required.
  // billing_customer_id IS NOT NULL is the underlying fact — see
  // lib/configuration-mutation-claim.ts's own header for why this is
  // deliberately NOT the same concept as "should ownership/reconciliation
  // safety apply at all" (it no longer is, since H1B3.4).
  hasExistingBillingSchedule: boolean
  blockerDiagnostic: unknown[]
  now: string
}): ReconciliationHoldTransitionResult {
  const { startingKind, currentHold, outcomeClean, hasExistingBillingSchedule, blockerDiagnostic, now } = params

  if (startingKind === 'schedule_rebuild_required') {
    return { nextHold: currentHold, changeNeeded: false }
  }

  if (startingKind === 'clear') {
    if (outcomeClean) return { nextHold: null, changeNeeded: false }
    return { nextHold: { reason: 'schedule_rebuild_required', started_at: now }, changeNeeded: true }
  }

  if (startingKind === 'reexecution') {
    if (outcomeClean) {
      if (!hasExistingBillingSchedule) {
        return { nextHold: null, changeNeeded: true }
      }
      return { nextHold: { reason: 'schedule_rebuild_required', started_at: currentHold?.started_at ?? now }, changeNeeded: true }
    }
    return {
      nextHold: { reason: 'reconciliation_blocked', started_at: currentHold?.started_at ?? now, blockers: blockerDiagnostic },
      changeNeeded: true,
    }
  }

  // reconciliation_blocked
  if (outcomeClean) {
    return { nextHold: { reason: 'schedule_rebuild_required', started_at: now }, changeNeeded: true }
  }
  return {
    nextHold: { reason: 'reconciliation_blocked', started_at: currentHold?.started_at ?? now, blockers: blockerDiagnostic },
    changeNeeded: true,
  }
}

export interface ApplyHoldTransitionResult {
  applied: boolean
  nextHold: BillingHold | null
}

// The I/O wrapper — never called when computeReconciliationHoldTransition
// returned changeNeeded:false (the caller checks that first; this
// function does not re-check it, to keep it a thin, honest wrapper around
// the RPC rather than duplicating the decision). A CAS miss (applied:false)
// means a newer hold event happened concurrently — the caller must log
// and surface a conflict, never treat it as this transition having
// silently succeeded.
export async function applyReconciliationHoldTransition(
  supabase: SupabaseClient,
  jobId: string,
  expectedHold: BillingHold | null,
  nextHold: BillingHold | null,
): Promise<ApplyHoldTransitionResult> {
  const { data, error } = await supabase.rpc('replace_billing_hold_if_unchanged', {
    p_job_id: jobId, p_expected_hold: expectedHold, p_next_hold: nextHold,
  })
  if (error) {
    console.error(`[reconciliation-hold-transition] replace_billing_hold_if_unchanged failed for job ${jobId}:`, error)
    return { applied: false, nextHold }
  }
  return { applied: !!data, nextHold }
}

// ─────────────────────────────────────────────────────────────────────────
// Step 17H.4B0D4H1B3.1, revised 17H.4B0D4H1B3.4 — the post-mutation
// transition for the claim-first pattern: confirm-rule, reconcile-line-
// items, terms/semantic-key/fixed-fee-timing routes ALWAYS acquire a
// temporary 'reexecution' hold via begin_job_configuration_mutation
// BEFORE running any mutation (lib/configuration-mutation-claim.ts) — for
// EVERY AUTO_CONFIGURE job now, not only ones with an existing billing
// schedule (H1B3.4) — so the hold actually present at transition time is
// always that temporary hold. This wraps computeReconciliationHoldTransition's
// own 'reexecution' branch and adds exactly ONE additional case unique to
// this claim-first pattern: restoring cleanly back to the ORIGINAL
// pre-claim hold when it was NULL and truly nothing happened —
// reconcile-line-items' own explicit "preserves current product
// convenience" requirement. confirm-rule/terms/backfills do NOT set
// allowRestoreToNullWhenUnmutated — they always materially change
// contract_terms by the time reconciliation even runs, so "clean" there
// correctly always promotes (schedule_rebuild_required or NULL, per
// hasExistingBillingSchedule), matching execute's own behavior exactly.
//
// No longer early-returns for a never-approved job (the H1B3.1 version
// did: `if (!claim.previouslyApproved) return {nextHold:null,
// changeNeeded:false}`) — that was only ever correct because a never-
// approved claim used to establish NO hold at all, so there was nothing
// to transition. Since H1B3.4 every AUTO_CONFIGURE claim is real, this
// function must always compute a genuine transition; hasExistingBilling
// Schedule (threaded through to computeReconciliationHoldTransition) is
// what now carries the "is there an existing schedule to protect" fact
// instead.
export interface PostMutationHoldTransitionParams {
  claim: { previousBillingHold: BillingHold | null; newBillingHold: BillingHold | null; hasExistingBillingSchedule: boolean }
  outcome: ReconciliationOrchestrationResult
  allowRestoreToNullWhenUnmutated: boolean
  now: string
}

export function computePostMutationHoldTransition(params: PostMutationHoldTransitionParams): ReconciliationHoldTransitionResult {
  const { claim, outcome, allowRestoreToNullWhenUnmutated, now } = params

  const outcomeClean = isReconciliationOutcomeClean(outcome)
  const mutationCount = outcome.status === 'applied' ? outcome.updatedCount + outcome.insertedCount + outcome.supersededCount : 0

  // isReconciliationOutcomeClean is false for stale_plan/invalid_plan/
  // error — an ambiguous RPC-infrastructure failure can therefore never
  // satisfy outcomeClean and never reach this restore-to-null branch,
  // structurally satisfying §18's "do not restore NULL on an ambiguous
  // RPC outcome" without a separate ambiguity check.
  if (allowRestoreToNullWhenUnmutated && claim.previousBillingHold === null && outcomeClean && mutationCount === 0) {
    return { nextHold: null, changeNeeded: true }
  }

  const diagnostic = buildReconciliationBlockerDiagnostic(outcome)
  return computeReconciliationHoldTransition({
    startingKind: 'reexecution', currentHold: claim.newBillingHold, outcomeClean,
    hasExistingBillingSchedule: claim.hasExistingBillingSchedule,
    blockerDiagnostic: diagnostic, now,
  })
}

// ─────────────────────────────────────────────────────────────────────────
// Step 17H.4B0D4H1B3.1 — the reviewer-PATCH-specific transition. Distinct
// from computePostMutationHoldTransition on purpose: a PATCH is a single
// targeted field correction with no planner/blocker outcome to reason
// about (it either succeeds or it doesn't — there is no "blockers" or
// "stale_plan" concept for a direct row UPDATE), so this is a much
// smaller, binary decision, not a wrapper around the reconciliation
// transition matrix at all.
export type ReviewerPatchHoldStartingKind = 'clear' | 'schedule_rebuild_required' | 'reconciliation_blocked'

// Step 17H.4B0D4H1B3.4 — return type widened to BillingHold | null:
// 'clear' + no existing billing schedule now resolves to NULL (there is
// nothing for a clean commercial edit to make stale) rather than always
// promoting to schedule_rebuild_required. 'schedule_rebuild_required' can
// only ever be an observed STARTING kind for a job that already has an
// existing schedule (a never-approved job's clean transitions always land
// on NULL, never schedule_rebuild_required — see computeReconciliation
// HoldTransition's own reexecution branch — so it could never have
// reached schedule_rebuild_required as a prior state in the first place),
// so that branch needs no explicit hasExistingBillingSchedule check of
// its own; same reasoning for 'reconciliation_blocked''s release-as-is
// behavior, which doesn't depend on it either.
export function computeReviewerPatchHoldTransition(params: {
  startingKind: ReviewerPatchHoldStartingKind
  originalHold: BillingHold | null
  hasExistingBillingSchedule: boolean
  now: string
}): BillingHold | null {
  const { startingKind, originalHold, hasExistingBillingSchedule, now } = params
  if (startingKind === 'reconciliation_blocked') {
    // A single targeted field correction does not, on its own, prove the
    // underlying structural reconciliation issue is resolved — only a
    // real reconcile-line-items/confirm-rule pass (the actual planner)
    // can determine that. Released back to its exact prior content,
    // unchanged — never silently downgraded by a bare PATCH.
    return originalHold ?? { reason: 'reconciliation_blocked', started_at: now }
  }
  if (startingKind === 'schedule_rebuild_required') {
    // Already the right state; its own started_at is carried forward
    // rather than minting a new one, since the hold never actually left
    // this state.
    return { reason: 'schedule_rebuild_required', started_at: originalHold?.started_at ?? now }
  }
  // 'clear' -> a real commercial edit just happened. An existing schedule
  // may now be stale: fresh schedule_rebuild_required. No existing
  // schedule: nothing to protect, resolves to NULL instead.
  if (!hasExistingBillingSchedule) return null
  return { reason: 'schedule_rebuild_required', started_at: now }
}
