// Step E9B.1 §9 — the PURE decision logic behind lib/usage-pull.ts's
// manual-fallback/meter-not-ready branch, extracted so it can be tested
// directly without the surrounding supabaseServer coupling (this codebase
// has no existing vi.mock('@/lib/supabase') convention — confirmed by
// grep — so extraction, not a new mocking pattern, is the safer path).
// usage-pull.ts calls this function directly and acts on its result; this
// is not a parallel re-implementation that could drift from the real
// behavior.
import type { ResolvedUsageQuantity } from '@/lib/usage-quantity-resolver'

export type UsageSourceOutcome =
  | { ready: true; quantity: number }
  // blocking:true -> real billing must throw QuantitySourceNotReadyError
  // (a required obligation must never be silently omitted from a real
  // invoice). blocking:false -> a live/preview caller skips silently,
  // exactly the pre-E9B behavior for that case, unchanged.
  | { ready: false; blocking: boolean; reason: string }

// Overloaded so a call site passing `manualResolved: null` literally (no
// fallback was even attempted — a real meter_key was configured, its pull
// simply wasn't ready) gets a return type TypeScript can narrow to the
// blocked-only shape, exactly mirroring what's structurally true at that
// call site — never `ready: true` when there's nothing to be ready from.
export function classifyUsageSourceOutcome(params: {
  pullReason: string
  manualResolved: null
  isRealBilling: boolean
}): { ready: false; blocking: boolean; reason: string }
export function classifyUsageSourceOutcome(params: {
  pullReason: string
  manualResolved: ResolvedUsageQuantity
  isRealBilling: boolean
}): UsageSourceOutcome
export function classifyUsageSourceOutcome(params: {
  pullReason: string
  manualResolved: ResolvedUsageQuantity | null
  isRealBilling: boolean
}): UsageSourceOutcome {
  if (params.manualResolved) {
    if (params.manualResolved.ready) {
      return { ready: true, quantity: params.manualResolved.quantity }
    }
    return {
      ready: false,
      blocking: params.isRealBilling,
      reason: `[usage_source] ${params.pullReason}; manual fallback also not ready: ${params.manualResolved.reason}`,
    }
  }
  return { ready: false, blocking: params.isRealBilling, reason: `[usage_source] ${params.pullReason}` }
}
