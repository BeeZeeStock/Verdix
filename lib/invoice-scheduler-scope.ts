/**
 * Manual/test scoping for the invoice-scheduler cron
 * (app/api/admin/invoice-scheduler/route.ts). Normal Vercel Cron
 * invocations never send a scope parameter and always get the existing
 * whole-platform sweep, completely unaffected by anything below.
 *
 * A scope parameter (planned_invoice_id or job_id) narrows a single run to
 * exactly that row/job — the deterministic way to test or manually re-run
 * one row without a whole-platform sweep picking up every other due row at
 * the same time. Deliberately gated behind its OWN secret
 * (SCHEDULER_SCOPE_SECRET), separate from — and required IN ADDITION TO —
 * normal cron auth (lib/cron-auth.ts's CRON_SECRET): possessing the real
 * cron secret must never be enough, by itself, to narrow what a request
 * against the production endpoint processes. This is what makes it
 * impossible for an unauthenticated caller to use the scope mechanism, and
 * impossible for a production cron invocation (which never has this
 * second secret) to accidentally inherit a test filter.
 *
 * Org-level scoping is deliberately never offered here: a single org can
 * have multiple independently-due rows, so "this org only" is not a
 * sufficiently deterministic test scope. planned_invoice_id (a single row)
 * is the strongest, preferred scope; job_id (all of one job's due rows) is
 * the next-strongest. The two are mutually exclusive.
 *
 * Every failure path below returns `ok: false` — there is no branch that
 * responds to an invalid/unauthorized/malformed scope request by silently
 * substituting `{ kind: 'unscoped' }`. A typo in the scope secret, or a
 * malformed identifier, must reject the request outright (zero scheduler
 * processing), never fall back to processing every due row platform-wide.
 */
export type SchedulerScope =
  | { kind: 'unscoped' }
  | { kind: 'planned_invoice_id'; plannedInvoiceId: string }
  | { kind: 'job_id'; jobId: string }

export type SchedulerScopeResolution =
  | { ok: true; scope: SchedulerScope }
  // status distinguishes malformed/ambiguous REQUEST SHAPE (400 — wrong
  // regardless of who's asking) from a failed/missing AUTHORIZATION check
  // (403 — the request shape was fine, the caller just isn't allowed to
  // use it). Validation always runs before the secret check, so a
  // malformed id is rejected the same way whether or not the caller also
  // happens to hold a valid/invalid scope secret.
  | { ok: false; status: 400 | 403; error: string }

// planned_invoices.id and jobs.id are both `uuid primary key default
// gen_random_uuid()` (supabase/migrations/20260727000001_planned_invoices.sql,
// 20260626000000_verdix.sql) — any value that isn't a syntactically valid
// UUID cannot possibly identify a real row, and is rejected outright rather
// than handed to Supabase to silently return zero rows for.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isValidUuid(value: string): boolean {
  return UUID_RE.test(value)
}

export function resolveSchedulerScope(params: {
  plannedInvoiceIdParam: string | null
  jobIdParam: string | null
  scopeSecretHeader: string | null
  configuredScopeSecret: string | undefined
}): SchedulerScopeResolution {
  const { plannedInvoiceIdParam, jobIdParam, scopeSecretHeader, configuredScopeSecret } = params

  // Presence is `!== null`, not truthiness — `?planned_invoice_id=` (an
  // explicitly-supplied empty value) must be treated as a malformed scope
  // request below, not silently coerced into "no scope supplied".
  const hasPlannedInvoiceId = plannedInvoiceIdParam !== null
  const hasJobId = jobIdParam !== null

  // No scope parameter at all — the normal cron path. Never gated behind
  // the scope secret; a real Vercel Cron invocation never sends one and
  // must always retain full whole-platform behavior regardless of whether
  // SCHEDULER_SCOPE_SECRET is even configured.
  if (!hasPlannedInvoiceId && !hasJobId) {
    return { ok: true, scope: { kind: 'unscoped' } }
  }

  if (hasPlannedInvoiceId && hasJobId) {
    return { ok: false, status: 400, error: 'planned_invoice_id and job_id are mutually exclusive scope parameters' }
  }

  const paramName = hasPlannedInvoiceId ? 'planned_invoice_id' : 'job_id'
  const paramValue = (hasPlannedInvoiceId ? plannedInvoiceIdParam : jobIdParam) as string

  // Validate shape before ever checking authorization — a malformed
  // identifier is a bad request regardless of whether the caller also
  // supplies a correct/incorrect/missing scope secret; it must never reach
  // a query.
  if (!isValidUuid(paramValue)) {
    return { ok: false, status: 400, error: `${paramName} must be a valid UUID` }
  }

  // A scope was explicitly requested and is well-formed — this is now the
  // manual/test path. Fails closed on any misconfiguration or mismatch:
  // never silently falls back to an unscoped whole-platform sweep, and
  // never silently ignores an unauthorized scope request and runs anyway.
  if (!configuredScopeSecret) {
    return { ok: false, status: 403, error: 'Scope parameter supplied but SCHEDULER_SCOPE_SECRET is not configured' }
  }
  if (!scopeSecretHeader || scopeSecretHeader !== configuredScopeSecret) {
    return { ok: false, status: 403, error: 'Invalid or missing scheduler scope secret' }
  }

  return hasPlannedInvoiceId
    ? { ok: true, scope: { kind: 'planned_invoice_id', plannedInvoiceId: paramValue } }
    : { ok: true, scope: { kind: 'job_id', jobId: paramValue } }
}
