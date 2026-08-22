// Step 14 — durable execution identity that survives HTTP retries and
// process crashes. An HTTP request and a financial execution are different
// identities on purpose (item 11/12): two Approve requests racing the same
// job must converge on ONE BillingExecutionAttempt, not create two.

// Item 13/14 — a deterministic, local, pre-any-external-call validation
// failure (missing API key, unsupported currency, missing required field).
// Thrown BEFORE an execution attempt even exists, so the caller (approve/
// route.ts) can restore the job to its real prior state — the same
// no-ambiguity path as the fresh-evidence-check failure — instead of
// landing in the same FAILED state used for a genuinely uncertain
// provider outcome. Never thrown once a provider call has been attempted.
export class BillingPreconditionError extends Error {}

export type BillingExecutionAttemptStatus =
  | 'created'
  | 'executing'
  | 'succeeded'
  | 'failed_safe'
  | 'outcome_uncertain'
  | 'cancelled'

export interface BillingExecutionAttempt {
  id: string
  organizationId: string
  jobId: string
  provider: 'stripe' | 'remembill' | 'chargebee'
  attemptNumber: number
  billingPlanFingerprint: string
  status: BillingExecutionAttemptStatus
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  retryOfAttemptId: string | null
}

export type BillingExecutionOperationStatus =
  | 'pending'
  | 'started'
  | 'succeeded'
  | 'failed_safe'
  | 'outcome_uncertain'

// Item 9 — the operation itself declares its capability, rather than
// scattering provider-specific retry assumptions through routes.
//   idempotent_retry            — the provider's OWN mechanism (a real,
//                                 confirmed request-idempotency key)
//                                 guarantees a same-key retry converges on
//                                 the original result. Confirmed for
//                                 Stripe's SDK-level idempotencyKey (see
//                                 STEP14 doc's live test-mode proof).
//   reconcilable                — Verdix cannot prove the provider itself
//                                 dedupes a retry, but has its OWN reliable
//                                 local check (e.g. "does jobs.
//                                 billing_customer_id already hold a
//                                 value") that lets a retry safely detect
//                                 "already done" before acting again.
//   manual_verification_required — neither of the above holds. A human
//                                 must look at the real provider state
//                                 before Verdix may proceed. Never silently
//                                 upgraded to a stronger capability just
//                                 because a key happens to be sent.
export type BillingOperationRetryCapability =
  | 'idempotent_retry'
  | 'reconcilable'
  | 'manual_verification_required'

export interface BillingExecutionOperation {
  id: string
  attemptId: string
  operationKey: string
  operationType: string
  idempotencyKey: string | null
  status: BillingExecutionOperationStatus
  externalObjectId: string | null
  requestFingerprint: string
  retryCapability: BillingOperationRetryCapability
  errorClass: string | null
  startedAt: string | null
  completedAt: string | null
}

export type BillingExecutionAdminActionType =
  | 'retry_authorized'
  | 'operation_verified_succeeded'
  | 'operation_verified_not_executed'
  | 'attempt_abandoned'

export interface BillingExecutionAdminAction {
  id: string
  attemptId: string
  operationId: string | null
  action: BillingExecutionAdminActionType
  actorEmail: string
  externalObjectId: string | null
  createdAt: string
}

// Item 6 — derived deterministically from immutable execution identity
// only. Never Date.now(), never a random value, never an HTTP-request id —
// a retry of the same operation always reuses the same key, by
// construction (same inputs -> same string, no state involved at all).
// `verdix:<attempt-id>:<provider>:<operation-type>[:<component-key>]`,
// ASCII-safe by construction (attempt ids are UUIDs, operation types are
// fixed identifiers, component keys are the same [a-z0-9:_-] shape
// billing-writer.ts's existing safeHeaderValue already sanitizes for header
// use at the call site).
export function deriveIdempotencyKey(
  attemptId: string,
  provider: 'stripe' | 'remembill' | 'chargebee',
  operationType: string,
  componentKey?: string,
): string {
  return componentKey
    ? `verdix:${attemptId}:${provider}:${operationType}:${componentKey}`
    : `verdix:${attemptId}:${provider}:${operationType}`
}

// Item 20 — operation identity for the (attempt, operation-key) pair. Two
// operations with the same key inside the SAME attempt are the same
// operation (resume, not a new one); the same key across two DIFFERENT
// attempts is deliberately a different operation (attempts are immutable
// once executing — see item 4).
export function operationKeyFor(operationType: string, componentKey?: string): string {
  return componentKey ? `${operationType}:${componentKey}` : operationType
}

// Item 14 — conservative, two-bucket classification for any side-effecting
// HTTP call whose only observable outcomes are "a definitive HTTP response
// came back" or "something else went wrong before a definitive response
// arrived". A definitive HTTP error response (the provider synchronously,
// actively rejected the request) is the ONLY case treated as failed_safe —
// standard REST semantics: a 4xx/5xx response body means the request was
// received and rejected, not partially applied. Anything else (the fetch
// itself threw — DNS failure, connection reset, timeout, abort) is
// outcome_uncertain by default, per the amendment's own rule: "if Verdix
// cannot prove no side effect occurred: outcome_uncertain".
export function classifyFetchOutcome(params: {
  requestThrew: boolean
  receivedResponse: boolean
}): 'failed_safe' | 'outcome_uncertain' {
  if (params.receivedResponse && !params.requestThrew) return 'failed_safe'
  return 'outcome_uncertain'
}

// Item 7 — Stripe SDK error classes are the actual, documented signal for
// this. An ALLOWLIST of known "Stripe definitely, synchronously rejected
// this before creating anything" types, not a denylist of known-ambiguous
// ones — per item 14's own rule ("if Verdix cannot prove no side effect
// occurred: outcome_uncertain"), an error type this function doesn't
// recognize at all (including a future Stripe SDK error class this code
// predates) must default to the SAFER outcome_uncertain bucket, never to
// failed_safe. StripeConnectionError ("the SDK can't connect to Stripe, OR
// it does not get a response within the timeout allotted" — both
// sub-cases genuinely ambiguous from here) and StripeAPIError (Stripe's
// own 5xx — an internal Stripe error does not prove nothing was committed
// before it occurred) are both explicitly uncertain, not just "not on the
// safe list", for the same reason.
const DEFINITIVE_SYNCHRONOUS_REJECTION_TYPES = new Set([
  'StripeInvalidRequestError',
  'StripeCardError',
  'StripeAuthenticationError',
  'StripePermissionError',
  'StripeRateLimitError',
  'StripeIdempotencyError',
])
export function classifyStripeFailure(err: unknown): 'failed_safe' | 'outcome_uncertain' {
  const name = (err as { type?: string } | null)?.type
  if (typeof name === 'string' && DEFINITIVE_SYNCHRONOUS_REJECTION_TYPES.has(name)) return 'failed_safe'
  return 'outcome_uncertain'
}

// Step 14 final amendment, items 5-9 — a stable idempotency key is only a
// safety guarantee while the PROVIDER still remembers it. Stripe documents
// idempotency keys are retained for approximately 24 hours; this constant
// is deliberately 23 (a 1-hour buffer, not Stripe's exact documented
// figure) — clock skew between Verdix and Stripe, and the fact that this
// is only ever checked at discrete retry moments rather than continuously,
// both argue against cutting it exactly at the provider's own boundary.
// Not currently overridable per-org/per-call — a single, conservative,
// documented constant, changed only if Stripe's own documented retention
// changes.
export const STRIPE_IDEMPOTENCY_KEY_RETENTION_HOURS = 23

/**
 * Item 6 — the ONE place that answers "is it currently safe to replay this
 * operation's provider request using its existing idempotency key". Pure:
 * `asOf` is always passed in by the caller (approve/route.ts, billing-
 * writer.ts, authorize-billing-retry — always `new Date()` at the actual
 * call site) — never ambient `Date.now()` inside this function, so the
 * decision is fully deterministic and testable at any instant.
 *
 * Only `idempotent_retry`-capability operations can ever return true for
 * an `outcome_uncertain` operation — `reconcilable`/
 * `manual_verification_required` are time-independent: no amount of
 * elapsed time makes an unproven local check or an unconfirmed provider
 * guarantee safe to auto-replay. For `idempotent_retry`, the provider's
 * guarantee is itself time-bounded (item 5) — once more than
 * STRIPE_IDEMPOTENCY_KEY_RETENTION_HOURS has elapsed since the request was
 * FIRST attempted (operation.startedAt — see item 9's own reasoning for
 * why this is the correct anchor, never "now", "attempt created", or "last
 * retry"), Verdix can no longer assume the provider still recognizes the
 * key, and this degrades to false — the caller must require manual/
 * provider-side reconciliation instead of blindly replaying the request.
 */
export function canSafelyRetryBillingOperation(
  operation: { status: BillingExecutionOperationStatus; retryCapability: BillingOperationRetryCapability; startedAt: string | null },
  asOf: Date,
): boolean {
  if (operation.status !== 'outcome_uncertain') return true // nothing to gate: pending/started/failed_safe may always be (re)attempted; succeeded is served from cache, never replayed
  if (operation.retryCapability !== 'idempotent_retry') return false
  if (!operation.startedAt) return false // defensive — an operation cannot reach outcome_uncertain without having been started first
  const elapsedMs = asOf.getTime() - new Date(operation.startedAt).getTime()
  const windowMs = STRIPE_IDEMPOTENCY_KEY_RETENTION_HOURS * 60 * 60 * 1000
  return elapsedMs <= windowMs
}

// Step 14 final financial-state correction — "a prior execution outcome
// being known does NOT necessarily mean a new billing attempt may replace
// it." A resolved (non-outcome_uncertain) prior attempt is not
// automatically safe to supersede — resolution and supersession-safety are
// different questions. Classified purely from the prior attempt's own
// operation statuses (never the attempt's own possibly-stale cached
// status field — the barrier that consumes this always re-fetches live
// operation rows):
//   safe_to_supersede   — no operation ever succeeded (every operation is
//                         failed_safe, or there were never any operations
//                         at all) — nothing was created, a fresh attempt
//                         for a changed plan may proceed.
//   executed            — EVERY operation succeeded — the intended
//                         financial side effect definitely happened. A new
//                         attempt must never be created; the correct
//                         recovery is finishing the JOB (-> COMPLETED)
//                         from this attempt's own already-known results,
//                         never re-attempting the provider call.
//   partially_executed  — a genuine MIX: at least one operation succeeded
//                         (a real external object exists) and at least one
//                         did not. The outcome may be fully known and
//                         still not safe to supersede — a fresh attempt
//                         would either duplicate the succeeded part or
//                         have no way to finish the rest. Step 14
//                         deliberately does not build the credit/rebill/
//                         amendment machinery that would be needed to
//                         safely resolve this automatically — it blocks
//                         and requires manual recovery.
//   unresolved          — at least one operation is still outcome_uncertain
//                         (or, defensively, still pending/started on a
//                         terminal attempt, which should not happen) —
//                         unchanged from the original barrier.
export type PriorAttemptSupersessionEligibility = 'safe_to_supersede' | 'executed' | 'partially_executed' | 'unresolved'

export function classifyPriorAttemptForSupersession(
  operationStatuses: BillingExecutionOperationStatus[],
): PriorAttemptSupersessionEligibility {
  if (operationStatuses.length === 0) return 'safe_to_supersede' // no operation ever ran — nothing to supersede
  if (operationStatuses.some(s => s === 'outcome_uncertain' || s === 'pending' || s === 'started')) return 'unresolved'
  const succeededCount = operationStatuses.filter(s => s === 'succeeded').length
  if (succeededCount === 0) return 'safe_to_supersede'
  if (succeededCount === operationStatuses.length) return 'executed'
  return 'partially_executed'
}
