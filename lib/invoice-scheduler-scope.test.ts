import { describe, it, expect } from 'vitest'
import { resolveSchedulerScope } from './invoice-scheduler-scope'

const SECRET = 'test-scope-secret-abc123'
const VALID_PLANNED_INVOICE_ID = '11111111-1111-4111-8111-111111111111'
const VALID_JOB_ID = '22222222-2222-4222-8222-222222222222'

describe('resolveSchedulerScope', () => {
  // Test F: unscoped real cron → retains whole-platform behavior.
  it('F: no scope parameter → unscoped, regardless of whether a scope secret is configured or sent', () => {
    expect(resolveSchedulerScope({
      plannedInvoiceIdParam: null, jobIdParam: null,
      scopeSecretHeader: null, configuredScopeSecret: SECRET,
    })).toEqual({ ok: true, scope: { kind: 'unscoped' } })

    // Even an unrelated/garbage header present is irrelevant when no scope
    // parameter was requested — the real Vercel Cron invocation must never
    // be affected by this mechanism at all.
    expect(resolveSchedulerScope({
      plannedInvoiceIdParam: null, jobIdParam: null,
      scopeSecretHeader: 'something-irrelevant', configuredScopeSecret: SECRET,
    })).toEqual({ ok: true, scope: { kind: 'unscoped' } })
  })

  it('F: no scope parameter → unscoped even when SCHEDULER_SCOPE_SECRET is entirely unconfigured', () => {
    expect(resolveSchedulerScope({
      plannedInvoiceIdParam: null, jobIdParam: null,
      scopeSecretHeader: null, configuredScopeSecret: undefined,
    })).toEqual({ ok: true, scope: { kind: 'unscoped' } })
  })

  // Test E: manual planned_invoice_id scope → processes exactly that row.
  it('E: valid planned_invoice_id + correct scope secret → scoped to that row', () => {
    expect(resolveSchedulerScope({
      plannedInvoiceIdParam: VALID_PLANNED_INVOICE_ID, jobIdParam: null,
      scopeSecretHeader: SECRET, configuredScopeSecret: SECRET,
    })).toEqual({ ok: true, scope: { kind: 'planned_invoice_id', plannedInvoiceId: VALID_PLANNED_INVOICE_ID } })
  })

  it('E: valid job_id + correct scope secret → scoped to that job', () => {
    expect(resolveSchedulerScope({
      plannedInvoiceIdParam: null, jobIdParam: VALID_JOB_ID,
      scopeSecretHeader: SECRET, configuredScopeSecret: SECRET,
    })).toEqual({ ok: true, scope: { kind: 'job_id', jobId: VALID_JOB_ID } })
  })

  // Both job_id + planned_invoice_id → rejected (400), even with a
  // correct secret — ambiguity is a request-shape problem, not an auth one.
  it('both planned_invoice_id and job_id supplied → 400, rejected regardless of a correct secret', () => {
    const result = resolveSchedulerScope({
      plannedInvoiceIdParam: VALID_PLANNED_INVOICE_ID, jobIdParam: VALID_JOB_ID,
      scopeSecretHeader: SECRET, configuredScopeSecret: SECRET,
    })
    expect(result).toEqual({ ok: false, status: 400, error: 'planned_invoice_id and job_id are mutually exclusive scope parameters' })
  })

  // Malformed scope id → rejected (400), never queried, never falls back
  // to unscoped — even with a correct secret.
  describe('malformed scope identifiers', () => {
    const malformedValues = [
      'not-a-uuid',
      '11111111-1111-1111-1111-11111111111X', // invalid hex char
      '11111111-1111-1111-1111-1111111111',   // too short
      '',                                       // explicitly-supplied empty value
      "11111111-1111-1111-1111-111111111111'; drop table planned_invoices;--",
    ]
    for (const bad of malformedValues) {
      it(`rejects malformed planned_invoice_id=${JSON.stringify(bad)} as 400, even with a correct secret`, () => {
        const result = resolveSchedulerScope({
          plannedInvoiceIdParam: bad, jobIdParam: null,
          scopeSecretHeader: SECRET, configuredScopeSecret: SECRET,
        })
        expect(result.ok).toBe(false)
        expect(result).toMatchObject({ status: 400 })
      })

      it(`rejects malformed job_id=${JSON.stringify(bad)} as 400, even with a correct secret`, () => {
        const result = resolveSchedulerScope({
          plannedInvoiceIdParam: null, jobIdParam: bad,
          scopeSecretHeader: SECRET, configuredScopeSecret: SECRET,
        })
        expect(result.ok).toBe(false)
        expect(result).toMatchObject({ status: 400 })
      })
    }

    it('rejects a malformed id even with NO secret configured at all — validation runs before auth', () => {
      const result = resolveSchedulerScope({
        plannedInvoiceIdParam: 'not-a-uuid', jobIdParam: null,
        scopeSecretHeader: null, configuredScopeSecret: undefined,
      })
      expect(result).toEqual({ ok: false, status: 400, error: 'planned_invoice_id must be a valid UUID' })
    })

    it('accepts an uppercase-hex UUID (case-insensitive)', () => {
      const result = resolveSchedulerScope({
        plannedInvoiceIdParam: VALID_PLANNED_INVOICE_ID.toUpperCase(), jobIdParam: null,
        scopeSecretHeader: SECRET, configuredScopeSecret: SECRET,
      })
      expect(result.ok).toBe(true)
    })
  })

  // Test G / Section 3: scope cannot bypass cron authorization, and every
  // auth-failure path is a hard 403 reject — never a silent fallback to
  // unscoped.
  describe('missing/invalid scope secret — always 403, zero fallback to unscoped', () => {
    it('scope + missing SCHEDULER_SCOPE_SECRET (unconfigured) → 403 rejected', () => {
      const result = resolveSchedulerScope({
        plannedInvoiceIdParam: VALID_PLANNED_INVOICE_ID, jobIdParam: null,
        scopeSecretHeader: 'anything', configuredScopeSecret: undefined,
      })
      expect(result).toEqual({ ok: false, status: 403, error: 'Scope parameter supplied but SCHEDULER_SCOPE_SECRET is not configured' })
    })

    it('scope + no secret header sent at all → 403 rejected, never treated as unscoped', () => {
      const result = resolveSchedulerScope({
        plannedInvoiceIdParam: VALID_PLANNED_INVOICE_ID, jobIdParam: null,
        scopeSecretHeader: null, configuredScopeSecret: SECRET,
      })
      expect(result).toEqual({ ok: false, status: 403, error: 'Invalid or missing scheduler scope secret' })
    })

    it('scope + wrong secret header → 403 rejected', () => {
      const result = resolveSchedulerScope({
        plannedInvoiceIdParam: VALID_PLANNED_INVOICE_ID, jobIdParam: null,
        scopeSecretHeader: 'wrong-secret', configuredScopeSecret: SECRET,
      })
      expect(result).toEqual({ ok: false, status: 403, error: 'Invalid or missing scheduler scope secret' })
    })

    it('scope + empty-string secret header is rejected, not treated as a valid match against an empty configured value', () => {
      const result = resolveSchedulerScope({
        plannedInvoiceIdParam: VALID_PLANNED_INVOICE_ID, jobIdParam: null,
        scopeSecretHeader: '', configuredScopeSecret: SECRET,
      })
      expect(result.ok).toBe(false)
      expect(result).toMatchObject({ status: 403 })
    })
  })

  // Explicit, exhaustive proof that no failure path ever converts a scoped
  // request into an unscoped one — every `ok: false` branch is enumerated
  // and none of them carry `scope: { kind: 'unscoped' }` (in fact none
  // carry a `scope` field at all).
  it('no failure path ever resolves to an unscoped/global scope', () => {
    const failureCases: Parameters<typeof resolveSchedulerScope>[0][] = [
      { plannedInvoiceIdParam: VALID_PLANNED_INVOICE_ID, jobIdParam: VALID_JOB_ID, scopeSecretHeader: SECRET, configuredScopeSecret: SECRET },
      { plannedInvoiceIdParam: 'garbage', jobIdParam: null, scopeSecretHeader: SECRET, configuredScopeSecret: SECRET },
      { plannedInvoiceIdParam: VALID_PLANNED_INVOICE_ID, jobIdParam: null, scopeSecretHeader: null, configuredScopeSecret: undefined },
      { plannedInvoiceIdParam: VALID_PLANNED_INVOICE_ID, jobIdParam: null, scopeSecretHeader: null, configuredScopeSecret: SECRET },
      { plannedInvoiceIdParam: VALID_PLANNED_INVOICE_ID, jobIdParam: null, scopeSecretHeader: 'wrong', configuredScopeSecret: SECRET },
    ]
    for (const input of failureCases) {
      const result = resolveSchedulerScope(input)
      expect(result.ok).toBe(false)
      expect(result).not.toHaveProperty('scope')
    }
  })

  // Required truth table from the release-safety amendment, confirmed
  // end-to-end through this function:
  //   no scope params + valid CRON_SECRET            → normal global cron
  //   scope param + SCHEDULER_SCOPE_SECRET absent     → reject, zero processing
  //   scope param + wrong scope secret                → reject, zero processing
  //   scope param + correct scope secret (+ valid CRON_SECRET, checked
  //     separately/earlier in the route) → scoped processing only
  // CRON_SECRET itself is deliberately out of scope for this function — it
  // is checked by isAuthorizedCronRequest() BEFORE resolveSchedulerScope is
  // ever called in app/api/admin/invoice-scheduler/route.ts (the route
  // returns 403 and never reaches scope resolution at all on a bad/missing
  // CRON_SECRET), so a caller lacking it can never reach any branch of this
  // function regardless of what scope parameters or scope secret it sends.
  it('truth table: all four required outcomes', () => {
    expect(resolveSchedulerScope({
      plannedInvoiceIdParam: null, jobIdParam: null, scopeSecretHeader: null, configuredScopeSecret: SECRET,
    })).toEqual({ ok: true, scope: { kind: 'unscoped' } })

    expect(resolveSchedulerScope({
      plannedInvoiceIdParam: VALID_PLANNED_INVOICE_ID, jobIdParam: null, scopeSecretHeader: null, configuredScopeSecret: undefined,
    }).ok).toBe(false)

    expect(resolveSchedulerScope({
      plannedInvoiceIdParam: VALID_PLANNED_INVOICE_ID, jobIdParam: null, scopeSecretHeader: 'wrong', configuredScopeSecret: SECRET,
    }).ok).toBe(false)

    expect(resolveSchedulerScope({
      plannedInvoiceIdParam: VALID_PLANNED_INVOICE_ID, jobIdParam: null, scopeSecretHeader: SECRET, configuredScopeSecret: SECRET,
    })).toEqual({ ok: true, scope: { kind: 'planned_invoice_id', plannedInvoiceId: VALID_PLANNED_INVOICE_ID } })
  })
})

// C (scheduler ignores backfill_review) and D (freshly generated terminal
// rows remain scheduled) are verified by direct code reading, not exercised
// here — there is no DB-mocking harness in this codebase for
// app/api/admin/invoice-scheduler/route.ts's Supabase queries (established
// pattern, see e.g. lib/credit-finalization-sweep.test.ts).
//
// C: every due-row query in the route (the 'scheduled' query, the 'parked'
// one-time-fee query, and the stale-'processing' recovery query) filters on
// an explicit status value — 'scheduled', 'parked', or 'processing'
// respectively. 'backfill_review' matches none of the three, and is not
// unioned in from anywhere else the route reads planned_invoices — so a row
// held at 'backfill_review' is structurally never included in `dueRows` and
// never reaches the processing loop, with no separate exclusion filter
// needed (see the comment directly above the 'scheduled' query in the
// route). Independently, isHeldHistoricalTerminalSettlement
// (lib/terminal-settlement-guard.ts, tested in
// lib/terminal-settlement-guard.test.ts) re-derives the same "don't
// auto-execute" outcome from created_at/period_start alone, so a row is
// held even in the hypothetical case where a migration never set
// 'backfill_review' at all.
//
// D: the live approve path (lib/billing-writer.ts, ~line 684-694) that
// creates a fresh terminal_settlement row for a newly-approved contract is
// completely untouched by this change — it still writes status: 'scheduled'
// unconditionally, exactly as before. Such a row also passes the scheduler
// guard cleanly: its created_at (now, at approval time) is before its
// period_start (a future trigger date, for any contract whose term hasn't
// already fully elapsed before approval — see
// lib/terminal-settlement-guard.ts's documented exception for the one
// legitimate case where that isn't true).
//
// Scope cannot bypass cron authorization (Test G / Section 3, route level):
// isAuthorizedCronRequest(req) is checked first in the route, before
// resolveSchedulerScope is ever invoked — an unauthenticated caller (no/
// wrong CRON_SECRET) gets a 403 immediately and never reaches scope
// resolution, so no value of planned_invoice_id/job_id/scope-secret can
// ever matter without a valid CRON_SECRET already presented.
//
// The scheduler guard also cannot be bypassed by scope (Section 2's
// defense-in-depth, route level): isHeldHistoricalTerminalSettlement is
// applied to scheduledRows immediately after the (possibly scope-filtered)
// Supabase query returns, before dueRows is assembled — so a manually
// scoped request naming a held historical row's own planned_invoice_id
// still has that row filtered out and reported in `results` as held,
// never processed.
