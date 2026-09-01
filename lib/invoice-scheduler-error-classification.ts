// Step E9B.1 §9/§10/§11 — the PURE decision logic behind app/api/admin/
// invoice-scheduler/route.ts's per-row catch block, extracted so the
// retryable-hold vs. terminal-failure classification is directly unit-
// tested (no supabaseServer/Stripe/Remembill coupling — this codebase has
// no mocking convention for any of those, confirmed by grep). The route's
// own catch block calls this function directly and acts on its result —
// the DB update and results.push are thin, mechanical actions on this
// decision, not independent logic.
import { QuantitySourceNotReadyError } from '@/lib/commercial-quantity-source'

export interface SchedulerCatchOutcome {
  /** 'scheduled' — reverts the claimed row so the NEXT scheduler run (or a
   *  targeted readiness recheck, lib/invoice-readiness-recheck.ts)
   *  naturally re-selects and retries it; 'failed' is TERMINAL — the
   *  scheduler's own selection query only ever matches status='scheduled',
   *  so a 'failed' row is never automatically reconsidered. */
  status: 'scheduled' | 'failed'
  errorMessage: string
  held: boolean
}

export function classifySchedulerCatchOutcome(err: unknown): SchedulerCatchOutcome {
  if (err instanceof QuantitySourceNotReadyError) {
    return { status: 'scheduled', errorMessage: `Held: ${err.message}`, held: true }
  }
  const errorMessage = err instanceof Error ? err.message : String(err)
  return { status: 'failed', errorMessage, held: false }
}
