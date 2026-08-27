// Step 16B.4, item 6 — the smallest interface letting the existing pricing
// engine (lib/tariff.ts's computeMetricOverage, UNCHANGED by this file)
// consume a finalized quantity without caring whether it came from a
// read-only external usage pull or a Verdix-qualified contractual event.
// Deliberately not a generic connector framework: exactly two kinds exist,
// both closed/typed, and this file adds no new pull mechanics of its own —
// external_usage simply carries a number the caller already resolved via
// lib/usage-pull.ts; qualified_unit_aggregate wraps lib/qualified-unit-
// aggregation.ts's own result.
//
// Item 10 — direction-agnostic on purpose. Nothing here is named
// "CustomerInvoiceSQM," "Receivable," or "Stripe" — this is a commercially
// qualified ECONOMIC quantity, not inherently an invoice line. Whether it
// ends up producing a RECEIVABLE (a customer invoice) or a PAYABLE (a
// partner revenue-share payout) is entirely the direction/output layer's
// concern, deliberately out of scope here and in all of 16B.4.
import type { QualifiedUnitAggregateResult } from './qualified-unit-aggregation'

export type CommercialQuantitySourceKind = 'external_usage' | 'qualified_unit_aggregate'

// A quantity already resolved by the existing meter/usage-pull path (lib/
// usage-pull.ts) — carried through unchanged, never recomputed here.
export interface ExternalUsageQuantitySource {
  kind: 'external_usage'
  metricKey: string
  periodStart: string
  periodEnd: string
  quantity: number
}

// A quantity resolved from 16B.3's terminal candidates via 16B.4's own
// aggregation layer — the aggregate's own readiness is what this source's
// readiness IS, never re-derived or second-guessed here.
export interface QualifiedUnitAggregateQuantitySource {
  kind: 'qualified_unit_aggregate'
  metricKey: string
  periodStart: string
  periodEnd: string
  aggregate: QualifiedUnitAggregateResult
}

export type CommercialQuantitySource = ExternalUsageQuantitySource | QualifiedUnitAggregateQuantitySource

export type ResolvedCommercialQuantity =
  | { ready: true; provenance: CommercialQuantitySourceKind; metricKey: string; periodStart: string; periodEnd: string; quantity: number }
  | { ready: false; provenance: CommercialQuantitySourceKind; metricKey: string; periodStart: string; periodEnd: string; reason: string }

// The one normalization point: after this call, a caller (the existing
// pricing engine) sees only { ready, quantity } — it never learns, and
// never needs to learn, whether the number came from a pulled meter or a
// qualified-unit aggregate.
export function resolveCommercialQuantity(source: CommercialQuantitySource): ResolvedCommercialQuantity {
  const { metricKey, periodStart, periodEnd } = source
  if (source.kind === 'external_usage') {
    return { ready: true, provenance: 'external_usage', metricKey, periodStart, periodEnd, quantity: source.quantity }
  }
  const { readiness, quantity } = source.aggregate
  if (readiness.outcome !== 'ready' || quantity === null) {
    return { ready: false, provenance: 'qualified_unit_aggregate', metricKey, periodStart, periodEnd, reason: readiness.reason }
  }
  return { ready: true, provenance: 'qualified_unit_aggregate', metricKey, periodStart, periodEnd, quantity }
}

// ── Scheduler / execution hold — item 8 ──────────────────────────────────
//
// Same idiom as lib/usage-pull.ts's own OpenBillingWindowError: a distinct,
// catchable error type a caller's existing fail-closed try/catch can
// propagate, never a silently-substituted zero/previous-period/guessed
// number. A future scheduler integration calls requireReadyCommercialQuantity
// immediately before invoking the existing pricing engine; this file does
// not itself modify any scheduler route.
export class QuantitySourceNotReadyError extends Error {
  readonly provenance: CommercialQuantitySourceKind
  readonly metricKey: string
  readonly periodStart: string
  readonly periodEnd: string
  constructor(resolved: Extract<ResolvedCommercialQuantity, { ready: false }>) {
    super(`Cannot bill metric '${resolved.metricKey}' for [${resolved.periodStart}, ${resolved.periodEnd}): quantity source (${resolved.provenance}) is not ready — ${resolved.reason}`)
    this.name = 'QuantitySourceNotReadyError'
    this.provenance = resolved.provenance
    this.metricKey = resolved.metricKey
    this.periodStart = resolved.periodStart
    this.periodEnd = resolved.periodEnd
  }
}

// Throws QuantitySourceNotReadyError rather than returning a sentinel —
// the existing billing flow's own fail-closed catch block is expected to
// treat this exactly like OpenBillingWindowError: hold/fail the job with
// an explicit reason, never substitute zero or a stale count.
export function requireReadyCommercialQuantity(resolved: ResolvedCommercialQuantity): number {
  if (!resolved.ready) throw new QuantitySourceNotReadyError(resolved)
  return resolved.quantity
}
