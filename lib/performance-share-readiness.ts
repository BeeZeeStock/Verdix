// Step E9B.1 §9 — the PURE decision logic behind lib/performance-share-
// pull.ts's currency-mismatch/not_ready/invalid/waived branching,
// extracted so it's directly unit-testable without this codebase's total
// absence of a supabaseServer-mocking convention (confirmed by grep).
// performance-share-pull.ts calls these functions directly and acts on
// their result — not a parallel re-implementation that could drift.
export type PerformanceShareBlockOutcome =
  | { blocked: false }
  // retryable:true -> QuantitySourceNotReadyError (held/scheduled, the
  // daily scheduler or a targeted recheck retries automatically).
  // retryable:false -> a plain Error (status='failed', ops-visible — this
  // data won't self-correct merely by waiting; see performance-share-
  // pull.ts's own throw-site comments for the full rationale).
  | { blocked: true; retryable: boolean; reason: string }

/** A required monetary input's recorded currency is missing or mismatched
 *  against the fee's configured currency — always a non-retryable data
 *  problem (already-entered-but-wrong data, not merely absent data).
 *  Return type is deliberately narrower than PerformanceShareBlockOutcome
 *  (always blocked:true) so a caller never needs an unreachable
 *  blocked:false check on this specific result. */
export function classifyCurrencyProblem(detail: string): { blocked: true; retryable: false; reason: string } {
  return { blocked: true, retryable: false, reason: `[currency_mismatch] ${detail}` }
}

/** computePerformanceShareFee's own result status. 'ready'/'waived' never
 *  block; 'not_ready' (an input genuinely hasn't been finalized yet, or a
 *  structural gate like a partial period) is retryable; 'invalid' (the
 *  function judged the data malformed once entered) is not — the same
 *  "won't self-resolve by waiting" reasoning as a currency mismatch. */
export function classifyPerformanceShareResultStatus(
  status: 'ready' | 'waived' | 'not_ready' | 'invalid',
  reason?: string,
): PerformanceShareBlockOutcome {
  if (status === 'not_ready') return { blocked: true, retryable: true, reason: `[performance_input] ${reason ?? ''}` }
  if (status === 'invalid') return { blocked: true, retryable: false, reason: `[invalid_data] ${reason ?? ''}` }
  return { blocked: false }
}
