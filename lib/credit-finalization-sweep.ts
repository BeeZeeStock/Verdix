// Pure candidate-selection logic for the credit finalization sweep
// (app/api/admin/credit-finalization-sweep/route.ts) — extracted so it's
// independently testable without a database. Answers exactly one question:
// "which (job, credit, window) combinations have a trigger_check saying
// the threshold was met, but no earn row yet?" — using ONLY
// credit_ledger_entries' own existing state, never planned_invoices (this
// is the structural proof that finalization re-evaluation is independent
// of whether a billing period/invoice exists at all).
export interface PendingCreditWindow {
  jobId: string
  creditRuleId: string
  windowStart: string
  windowEnd: string
}

interface EarnedWindowIdentity {
  jobId: string
  creditRuleId: string
  windowStart: string
}

function windowKey(w: { jobId: string; creditRuleId: string; windowStart: string }): string {
  return `${w.jobId}:${w.creditRuleId}:${w.windowStart}`
}

// De-duplicates repeated trigger_check snapshots for the same window (one
// per evaluation_date it was previously checked on) and excludes anything
// that already has a permanent earn row — the same identity
// credit_ledger_earn_window_uidx (job_id, credit_rule_id, window_start)
// enforces at the DB level, so this exclusion can never disagree with what
// the database itself considers "already earned." A repeated sweep call
// with the same inputs always returns the same candidate set — this
// function has no side effects and no ordering dependency.
export function computeSweepCandidates(
  thresholdMetTriggerChecks: PendingCreditWindow[],
  earnedWindows: EarnedWindowIdentity[],
): PendingCreditWindow[] {
  const alreadyEarned = new Set(earnedWindows.map(windowKey))
  const seen = new Set<string>()
  const candidates: PendingCreditWindow[] = []
  for (const row of thresholdMetTriggerChecks) {
    const key = windowKey(row)
    if (alreadyEarned.has(key) || seen.has(key)) continue
    seen.add(key)
    candidates.push(row)
  }
  return candidates
}
