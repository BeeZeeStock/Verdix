// Step 17C.1 (hardened in 17C.1a) — the smallest generic boundary for
// sourcing a MONETARY operational input the countable-usage-meter
// machinery (lib/meter-mapping-status.ts, contract_meter_mappings) cannot
// represent. Deliberately NOT a live connector/pull subsystem —
// investigation confirmed no monetary-value pull mechanism exists anywhere
// in this codebase today. This module stays pure (types + resolution
// logic); the actual persistence is the append/revoke-versioned
// operational_input_period_values table (supabase/migrations/
// 20260903000001_operational_input_period_values.sql) + app/api/jobs/[id]/
// operational-input-values/route.ts, mirroring the established
// lib/discount-component-targeting.ts / lib/committed-fixed-fee-
// resolver.ts split (pure lib/ logic + a thin route for the DB-touching
// concern).
//
// A `source: 'manual'` entry (a reviewer/operator types in the real EUR
// figure once a period closes) is the ONLY source kind implemented today.
// OperationalInputBinding's own shape stays open to a future 'api'
// (read-only endpoint) or 'connector' source through the SAME typed
// interface — a future addition of a literal to the `source` union, never
// a parallel binding concept — since nothing about resolveInputValueAsOf/
// buildOperationalInputMap below assumes HOW a row was produced.
export interface OperationalInputBinding {
  input_key: string
  source: 'manual'
  value_type: 'monetary' | 'countable'
}

// One row as returned by operational_input_period_values — append/revoke
// versioned, never mutated after insert (see the migration's own header
// for the full rationale). A row with finalized_at === null is a DRAFT —
// visible for review, never eligible to feed a real calculation.
export interface OperationalInputPeriodValueRow {
  id: string
  input_key: string
  period_start: string
  period_end: string
  value: number
  currency?: string | null
  recorded_at: string
  finalized_at: string | null
  status: 'active' | 'revoked'
  revoked_at: string | null
}

// The historical resolver: "what was the FINALIZED value known for this
// (input_key, period) as of instant T" — same invariant as
// lib/billable-unit-candidate.ts's isEvidenceActiveAsOf (recorded_at <=
// asOf AND (revoked_at IS NULL OR revoked_at > asOf)), plus TWO explicit
// finality checks, both required (Step 17C.1b, item B):
//   finalized_at IS NOT NULL   — a draft is never usable in a calculation
//                                at ANY asOf.
//   finalized_at <= asOf       — a value finalized AFTER T must be
//                                invisible to a replay asOf T, even though
//                                (by construction, since "mark final"
//                                always inserts a fresh row — see the
//                                migration) recorded_at and finalized_at
//                                are equal for any row this resolver ever
//                                returns. Checked explicitly, not left
//                                implicit in the recorded_at check below,
//                                so the invariant reads correctly on its
//                                own and stays correct even if a future
//                                change ever let finalized_at diverge from
//                                recorded_at.
//
// At most one row should ever satisfy this for a given (input_key,
// period) — the DB's own partial unique index enforces at most one ACTIVE
// row at a time, and revocation is what lets a later, corrected row become
// the new active one without violating that index.
export function resolveInputRowAsOf(
  rows: OperationalInputPeriodValueRow[],
  inputKey: string,
  periodStart: string,
  periodEnd: string,
  asOf: string,
): OperationalInputPeriodValueRow | null {
  const asOfMs = new Date(asOf).getTime()
  return rows.find(row => {
    if (row.input_key !== inputKey || row.period_start !== periodStart || row.period_end !== periodEnd) return false
    if (row.finalized_at == null) return false
    const finalizedAtMs = new Date(row.finalized_at).getTime()
    if (finalizedAtMs > asOfMs) return false
    const recordedAtMs = new Date(row.recorded_at).getTime()
    if (recordedAtMs > asOfMs) return false
    if (row.revoked_at == null) return true
    return new Date(row.revoked_at).getTime() > asOfMs
  }) ?? null
}

export function resolveInputValueAsOf(
  rows: OperationalInputPeriodValueRow[],
  inputKey: string,
  periodStart: string,
  periodEnd: string,
  asOf: string,
): number | null {
  return resolveInputRowAsOf(rows, inputKey, periodStart, periodEnd, asOf)?.value ?? null
}

// Shapes already-fetched DB rows for ONE period into the plain
// Record<string, number|null> the calculation engine (lib/derived-metric.ts
// onward) consumes — never itself queries the database. asOf defaults to
// "now" (a live calculation always wants the current, latest finalized
// fact) but a caller replaying a historical period passes the real
// as-of instant explicitly.
export function buildOperationalInputMap(
  rows: OperationalInputPeriodValueRow[],
  periodStart: string,
  periodEnd: string,
  asOf: string = new Date().toISOString(),
): Record<string, number | null> {
  const inputKeys = new Set(rows.map(r => r.input_key))
  const map: Record<string, number | null> = {}
  for (const key of inputKeys) {
    map[key] = resolveInputValueAsOf(rows, key, periodStart, periodEnd, asOf)
  }
  return map
}

// Step 17C.1a/b, item 4/B — a MONETARY input's own stored currency must be
// present AND match the obligation's configured currency, or the
// calculation fails closed rather than silently mixing currencies or
// treating an untagged figure as if its currency were self-evident. A
// COUNTABLE input is never checked here at all — currency: null is its
// normal, correct, expected shape (a count has no currency), never a
// defect — callers must only pass MONETARY input keys (e.g. via
// lib/operational-data-inputs.ts's isMonetaryOperationalInput) into
// inputKeys; this function has no way to tell a countable key from a
// monetary one on its own and does not try to.
//
// Two distinct problems are reported, both fail-closed the same way at
// the call site (the caller treats either as a reason to hold/invalid the
// calculation, never to proceed):
//   'missing'  — a resolved (active, finalized, asOf-visible) row exists
//                for this monetary input, but its own currency field was
//                never set.
//   'mismatch' — the row's currency is set, but disagrees with the
//                obligation's own configured currency.
// A row that doesn't resolve at all (missing input, still a draft, not
// yet recorded as of asOf, etc.) is NOT a currency problem — that's the
// ordinary "missing input" not_ready case handled upstream, so this
// function is silent for that key rather than reporting a currency issue
// that isn't the real cause.
export function findMonetaryCurrencyProblem(
  rows: OperationalInputPeriodValueRow[],
  monetaryInputKeys: string[],
  periodStart: string,
  periodEnd: string,
  asOf: string,
  expectedCurrency: string,
): { input_key: string; problem: 'missing' | 'mismatch'; rowCurrency: string | null } | null {
  for (const key of monetaryInputKeys) {
    const row = resolveInputRowAsOf(rows, key, periodStart, periodEnd, asOf)
    if (!row) continue
    if (!row.currency) return { input_key: key, problem: 'missing', rowCurrency: null }
    if (row.currency.toUpperCase() !== expectedCurrency.toUpperCase()) {
      return { input_key: key, problem: 'mismatch', rowCurrency: row.currency }
    }
  }
  return null
}

// item 13's UI readiness signal — "has anyone even started supplying this
// input" (any row at all, any period, draft or final, active or revoked)
// vs. "the mechanism exists but nothing has ever been entered." Distinct
// from per-period readiness (buildOperationalInputMap above) — this is a
// persistent, job-level fact suitable for a static review-card badge, not
// a per-calculation gate.
export function hasAnyBindingActivity(rows: OperationalInputPeriodValueRow[], inputKeys: string[]): boolean {
  return inputKeys.every(key => rows.some(r => r.input_key === key))
}
