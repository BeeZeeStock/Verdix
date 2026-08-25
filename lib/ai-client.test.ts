import { describe, it, expect } from 'vitest'
import { AI_DOCUMENT_EXTRACTION_TIMEOUT_MS, AI_DOCUMENT_EXTRACTION_MAX_RETRIES } from './ai-client'

// Mirrors app/api/jobs/[id]/detect-pii/route.ts's real
// `export const maxDuration = 200` — not imported directly (importing a
// Next.js route module transitively pulls in supabaseServer/requireOrg
// etc. for no benefit here), so this is the one place that value must be
// kept in sync by hand if the route's maxDuration ever changes. Any drift
// is exactly the kind of mismatch this test exists to catch.
const DETECT_PII_MAX_DURATION_S = 200

// Same reasoning documented in ai-client.ts itself: this test is what
// actually enforces "extraction timeout/attempt configuration cannot
// exceed the outer route timing budget under worst-case timeout
// conditions" — a live incident already proved this can silently
// regress (60s x 3 attempts = 180s worst case fit under the OLD 120s
// budget's failure mode by accident, not by a real margin check).
describe('document-extraction timeout budget', () => {
  it('worst-case aggregate duration (timeout x total attempts) stays safely inside detect-pii\'s maxDuration', () => {
    const totalAttempts = AI_DOCUMENT_EXTRACTION_MAX_RETRIES + 1
    const worstCaseMs = AI_DOCUMENT_EXTRACTION_TIMEOUT_MS * totalAttempts
    const routeBudgetMs = DETECT_PII_MAX_DURATION_S * 1000

    expect(worstCaseMs).toBeLessThan(routeBudgetMs)

    // Not just "less than" — real margin for the route's own surrounding
    // work (PDF download from Storage, local PII detection, DB writes),
    // which is not itself timed by this constant. 20s is a conservative
    // floor given that work has historically taken ~2-3s.
    const marginMs = routeBudgetMs - worstCaseMs
    expect(marginMs).toBeGreaterThanOrEqual(20_000)
  })

  it('uses a single attempt (no retries) — retrying a legitimately-slow non-streaming response at the same timeout would only repeat the identical failure', () => {
    // Confirmed live (2026-08-24): three successive 60s-timeout attempts
    // all failed identically, burning the entire budget for no benefit.
    expect(AI_DOCUMENT_EXTRACTION_MAX_RETRIES).toBe(0)
  })

  it('exact documented budget: 170s x 1 attempt = 170s worst case, >=30s under the 200s route budget', () => {
    expect(AI_DOCUMENT_EXTRACTION_TIMEOUT_MS).toBe(170_000)
    const totalAttempts = AI_DOCUMENT_EXTRACTION_MAX_RETRIES + 1
    expect(AI_DOCUMENT_EXTRACTION_TIMEOUT_MS * totalAttempts).toBe(170_000)
    expect(DETECT_PII_MAX_DURATION_S * 1000 - AI_DOCUMENT_EXTRACTION_TIMEOUT_MS * totalAttempts).toBeGreaterThanOrEqual(30_000)
  })
})
