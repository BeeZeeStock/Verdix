// Step 17H.4B0D4H1B4E8 — pure, display-shaping helpers behind the Billing
// Timeline period card's new summary-first hierarchy (category tiles,
// period-to-invoice sentence, deferred-to-next-invoice section). Every
// function here reads the SAME BillingPeriodWorkspace fields the existing
// "Period execution" detail already reads (lib/billing-period-workspace.ts)
// — no new runtime computation, no new backend state, purely a compaction/
// summarization layer over already-authoritative typed state. Kept in its
// own file so this pass's genuinely new logic is directly unit-testable
// without rendering BillingSummaryCard itself (a large, fetch-driven
// component with no existing render-test precedent in this codebase).
import type { FixedComponentState, UsageComponentState, PerformanceComponentState } from './billing-period-workspace'
import { isLongFormValue } from './value-alignment'

export type TileState = 'ready' | 'neutral' | 'attention'

export interface CategoryTile {
  title: string
  label: string
  sub: string
  state: TileState
}

// Step 17H.4B0D4H1B4E8.1 §6-9/§20 — a period's own measurement window is a
// FACT already available from its real start/end dates (BillingPeriodBounds
// — never a new date calculation, per the task's own instruction). Used to
// refine wording for a component whose backend status alone can't
// distinguish "hasn't opened yet" from "open now" from "closed, not final"
// — the exact three phases lib/billing-period-workspace.ts's own
// derivePeriodExecutionModel conflates into a single contract-level
// `started` boolean (see buildPerformanceTile's own doc for the concrete
// defect this fixes). Presentation-only: never changes which backend
// status value a component actually has.
export type MeasurementPhase = 'not_started' | 'measuring' | 'closed'

export function deriveMeasurementPhase(periodStart: string, periodEnd: string, asOf: Date = new Date()): MeasurementPhase {
  const start = new Date(periodStart + 'T00:00:00')
  const end = new Date(periodEnd + 'T23:59:59')
  if (asOf < start) return 'not_started'
  if (asOf <= end) return 'measuring'
  return 'closed'
}

// Step §5 — the Fixed tile. `amount === 0 && !waived` means no fixed
// component is actually priced for this contract at all (never inferred
// from a label/fixture — FixedComponentState.waived already distinguishes
// "waived to zero" from "never had one"), so the tile is omitted rather
// than showing a misleading "0" figure.
export function buildFixedTile(fixed: FixedComponentState, currency: string, fmt: (n: number, c: string) => string): CategoryTile | null {
  if (fixed.amount === 0 && !fixed.waived) return null
  if (fixed.waived) {
    return { title: 'Fixed charges', label: 'Waived during pilot', sub: 'Otherwise billed at period start', state: 'neutral' }
  }
  if (!fixed.billingTiming.resolved) {
    return { title: 'Fixed charges', label: 'Decision required', sub: 'Invoice timing not yet resolved', state: 'attention' }
  }
  return {
    title: 'Fixed charges',
    label: 'Known fixed',
    sub: `${fmt(fixed.amount, currency)} due at ${fixed.billingTiming.timing === 'bill_at_period_start' ? 'period start' : 'period end'}`,
    state: 'ready',
  }
}

// Step §6/§7 — the Usage tile: a COUNT-level summary, never a per-component
// listing (that stays in Calculation basis & sources). The tile's state
// and sub-label reflect the single worst-case status across all usage
// components — a blocker anywhere in the category is a blocker for the
// category's own at-a-glance read.
//
// `phase`/`measurementStartLabel` are optional (the caller passes them only
// when it has real period dates to hand, e.g. the Billing Timeline period
// card, which always does) so existing callers/tests that only pass
// `usage` keep their prior, still-correct behavior unchanged. When
// supplied, they fix the reported defect: before the measurement window
// has genuinely opened, this used to say "measured items / Awaiting period
// close" — overclaiming that measurement is already underway. "usage
// items / Measurement starts {date}" is the honest, period-specific fact.
export function buildUsageTile(usage: UsageComponentState[], phase?: MeasurementPhase, measurementStartLabel?: string): CategoryTile | null {
  if (usage.length === 0) return null
  const plural = usage.length === 1 ? '' : 's'
  if (usage.some(u => u.status === 'awaiting_source')) {
    return { title: 'Usage', label: `${usage.length} measured item${plural}`, sub: 'Awaiting source', state: 'attention' }
  }
  if (usage.every(u => u.status === 'computed')) {
    return { title: 'Usage', label: `${usage.length} measured item${plural}`, sub: 'Finalised', state: 'ready' }
  }
  if (phase === 'not_started') {
    return {
      title: 'Usage',
      label: `${usage.length} usage item${plural}`,
      sub: measurementStartLabel ? `Measurement starts ${measurementStartLabel}` : 'Not started',
      state: 'neutral',
    }
  }
  if (phase === 'closed') {
    return { title: 'Usage', label: `${usage.length} measured item${plural}`, sub: 'Awaiting finalisation', state: 'neutral' }
  }
  if (usage.some(u => u.status === 'awaiting_period') && !phase) {
    // No period-timing info supplied at all — fall back to the original,
    // pre-17H.4B0D4H1B4E8.1 wording rather than guessing a phase.
    return { title: 'Usage', label: `${usage.length} measured item${plural}`, sub: 'Awaiting period close', state: 'neutral' }
  }
  // live_not_final / pending_usage, mixed with some already-computed, or
  // phase === 'measuring' — genuinely "not yet final," a neutral (not
  // attention) state, since nothing here is actually blocked, only not
  // yet closed.
  return { title: 'Usage', label: `${usage.length} measured item${plural}`, sub: 'Finalised at period close', state: 'neutral' }
}

// Step §7/§12/§13 — the Performance tile. Never collapses a genuine
// blocker ('pending_operational_inputs') into the same generic wording as
// a merely-not-yet-started or already-final state.
//
// Root cause of the reported "Awaiting first billing period" defect
// (traced, not guessed — see lib/billing-period-workspace.ts's
// derivePeriodExecutionModel): `not_started`/`pending_operational_inputs`
// are chosen from a single CONTRACT-level `started = hasContractStarted
// (contract_start_date)` boolean, computed once and reused identically for
// EVERY period on the timeline — it has no idea whether THIS SPECIFIC
// period's own window has been reached yet. So a period several cycles
// after the contract's real start can still say "Awaiting first billing
// period" (technically true about the CONTRACT the day this logic last
// changed state, but reads as if THIS period were the first one), and a
// period whose contract-level gate has already passed can say "Awaiting
// input" even though its own window hasn't opened. Fixed the same way as
// the usage tile: `phase` (derived independently from THIS period's own
// real dates) refines the wording without touching which backend status
// value is used or when.
export function buildPerformanceTile(performance: PerformanceComponentState[], phase?: MeasurementPhase, measurementStartLabel?: string): CategoryTile | null {
  if (performance.length === 0) return null
  if (performance.every(p => p.status === 'waived')) {
    return { title: 'Performance', label: 'Waived this period', sub: 'No performance charge applies', state: 'neutral' }
  }
  if (performance.every(p => p.status === 'computed' || p.status === 'waived')) {
    return { title: 'Performance', label: 'Finalised', sub: 'Calculated for this period', state: 'ready' }
  }
  const notStartedByBackend = performance.every(p => p.status === 'not_started')
  const hasPendingInputs = performance.some(p => p.status === 'pending_operational_inputs')
  if (phase === 'not_started' && (notStartedByBackend || hasPendingInputs)) {
    return {
      title: 'Performance',
      label: 'Not started',
      sub: measurementStartLabel ? `Measurement starts ${measurementStartLabel}` : 'Not yet started',
      state: 'neutral',
    }
  }
  if (notStartedByBackend) {
    return { title: 'Performance', label: 'Not yet started', sub: 'Awaiting first billing period', state: 'neutral' }
  }
  if (hasPendingInputs) {
    return { title: 'Performance', label: 'Awaiting input', sub: 'Calculated after period close', state: 'attention' }
  }
  return { title: 'Performance', label: 'Ready for calculation', sub: 'Calculated after period close', state: 'neutral' }
}

export interface DeferredItem {
  key: string
  label: string
  sub: string
  // Step 17H.4B0D4H1B4E8.1 §9/§10 — the destination invoice/period is
  // declared ONCE, in the section heading (all current deferred items
  // share one destination — buildDeferredItems takes a single
  // destinationLabel, never a per-item one, because no per-item
  // destination data exists yet). Each item's own `timingText` states
  // only ITS calculation timing, never repeats "→ {destination}" — that
  // was the reported "repetitive and slightly contradictory" pattern.
  timingText: string
  // Step E9 §14/§18 — the SAME state vocabulary the calculation-basis
  // table already uses (describeUsageComponentState/
  // describePerformanceComponentState below) — reused, never re-derived,
  // so this item reads identically regardless of which section renders
  // it (the source period's own Deferred list, or a later destination
  // invoice's incoming-obligation preview — see buildComponentDetailRows'
  // own doc and BillingSummaryCard's Invoice Projection rendering).
  state: ComponentRowState
  // Real computed amount — present ONLY once state.state === 'ready'
  // (status genuinely 'computed'). An item still in progress must never
  // carry a monetary value here: zero is an economic result, never an
  // "unknown/not yet calculable" placeholder (§6).
  amount?: number | null
  kind: 'usage' | 'performance'
}

// Step §19-22, revised E9 §14/§18/§23 — items belonging to a LATER invoice
// than the one Invoice Projection for the SOURCE period represents. The
// destination itself is rendered by the caller, once, in the section
// heading — this function only decides WHICH items carry forward and
// their own state/timing, never a destination string. Step E9 — a
// genuinely computed/final item is no longer excluded: the prior
// exclusion ("it already belongs on this invoice") was the exact root
// cause of the reported bug — once usage/performance reaches its final,
// calculated state, it must keep appearing (now as "Final"/"ready",
// carrying its real amount) until it is actually shown on its real
// destination invoice, never silently vanish in between. Called with
// EXACTLY the same usage/performance arrays for both call sites (the
// source period's own Deferred section, and the destination invoice's
// incoming-obligation preview) — one shared computation, never two
// independently-derived lists that could drift apart.
export function buildDeferredItems(params: {
  usage: UsageComponentState[]
  performance: PerformanceComponentState[]
  phase?: MeasurementPhase
  measurementStartLabel?: string
}): DeferredItem[] {
  const items: DeferredItem[] = []
  for (const u of params.usage) {
    if (u.status === 'awaiting_source') continue
    const state = describeUsageComponentState(u.status, params.phase)
    const sub = u.status === 'computed'
      ? 'Measured this period'
      : params.phase === 'not_started' && params.measurementStartLabel
        ? `Measurement starts ${params.measurementStartLabel}`
        : params.phase === 'not_started' ? 'Not started' : 'Measured this period'
    items.push({
      key: `usage:${u.key}`, label: u.label, sub,
      timingText: u.status === 'computed' ? 'Ready' : 'Calculated after period close',
      state, amount: u.status === 'computed' ? (u.amount ?? 0) : null, kind: 'usage',
    })
  }
  for (const p of params.performance) {
    if (p.status === 'waived' || p.status === 'not_started') continue
    const state = describePerformanceComponentState(p.status, params.phase)
    items.push({
      // Step E9B — prefers the fee's stable recurring_fee_id (when the
      // contract extraction assigned one) over feeLabel, which is mutable
      // display text that can collide or drift across a re-extraction —
      // audited per E9's own flagged concern. Falls back to feeLabel only
      // for older data with no id, preserving today's exact key for it.
      key: `performance:${p.recurringFeeId ?? p.feeLabel}`,
      label: p.feeLabel,
      sub: 'Performance / outcome charge',
      // Provisional: only bills once required operational inputs actually
      // arrive — never the same unconditional "Calculated after period
      // close" a usage measurement (which WILL close regardless of input
      // availability) correctly gets.
      timingText: p.status === 'computed' ? 'Ready' : 'Awaiting input',
      state, amount: p.status === 'computed' ? (p.amount ?? 0) : null, kind: 'performance',
    })
  }
  return items
}

// Step E8.2 §5 — the ONE state classification shared by the category tiles
// AND the expanded detail table's STATE column, so they can never disagree
// (the reported "tile: Not started / table: Awaiting input" contradiction).
// Both a usage and a performance component reduce to the same small state
// vocabulary; kept as one function (rather than two near-identical ones)
// so there is exactly one place "what counts as attention vs neutral vs
// ready" is decided.
export type ComponentRowState = { label: string; state: TileState }

export function describeUsageComponentState(status: UsageComponentState['status'], phase?: MeasurementPhase): ComponentRowState {
  if (status === 'awaiting_source') return { label: 'Awaiting source', state: 'attention' }
  if (status === 'computed') return { label: 'Final', state: 'ready' }
  if (phase === 'not_started') return { label: 'Not started', state: 'neutral' }
  if (phase === 'closed') return { label: 'Awaiting finalisation', state: 'neutral' }
  return { label: 'Measuring', state: 'neutral' }
}

export function describePerformanceComponentState(status: PerformanceComponentState['status'], phase?: MeasurementPhase): ComponentRowState {
  if (status === 'waived') return { label: 'Waived', state: 'neutral' }
  if (status === 'computed') return { label: 'Final', state: 'ready' }
  // Step E8.2 §5/§8 — the same contract-level-vs-period-level fix as the
  // tile builder: when this period's own window genuinely has not opened
  // yet, neither "not_started" nor "pending_operational_inputs" (both of
  // which the backend can return for the same not-actually-reached period
  // — see buildPerformanceTile's own doc) may read as an active blocker.
  if (phase === 'not_started') return { label: 'Not started', state: 'neutral' }
  if (status === 'not_started') return { label: 'Not started', state: 'neutral' }
  if (status === 'pending_operational_inputs') return { label: 'Awaiting input', state: 'attention' }
  return { label: 'Pending', state: 'neutral' }
}

export interface ComponentDetailRow {
  key: string
  component: string
  basis: string
  sourceType: string | null
  sourceLabel: string | null
  // Step E8.3 §1 — the configured meter's OWN display name/key, distinct
  // from sourceLabel's business-metric identity above. Muted secondary
  // detail only — never the row's primary text, and never hidden merely
  // because it looks unlike the business metric (a real mismatch must
  // stay visible, not be suppressed).
  sourceDetail?: string | null
  // Step E8.3.1 §5 — a contract clause that exists as EVIDENCE/CONTEXT for
  // this row, kept structurally separate from sourceLabel (the actual
  // provenance claim). A caller may offer this as clearly-subordinate
  // detail (e.g. a "Contract context" link) — never merged into
  // sourceLabel, which would imply the clause itself is what determined
  // the row's basis when the real determinant was something else (a
  // reviewer decision, for instance).
  contextClause?: string | null
  state: ComponentRowState
}

// Step E8.3 §1 — generic humanizer, shared by every "turn a snake_case
// identifier into readable words" call site below (never a fixture-
// specific string match).
function humanizeKey(s: string): string {
  return s.trim().replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())
}

// Step E8.2 §3/§4 — builds the compact COMPONENT / BASIS / SOURCE / STATE
// table replacing the old always-expanded "Fixed charges" / "Consumption /
// usage" / "Performance / outcome" prose blocks. `fmtRange` is the
// caller's own period-range formatter (e.g. "1-31 Oct") — kept as an
// injected callback rather than duplicating date-range formatting already
// established elsewhere in the calling component.
export function buildComponentDetailRows(params: {
  fixed: FixedComponentState
  usage: UsageComponentState[]
  performance: PerformanceComponentState[]
  currency: string
  periodRangeLabel: string
  phase?: MeasurementPhase
  fmt: (n: number, c: string) => string
  // Step E8.2 §4 — the static source configuration (e.g. usageSourceCards'
  // own sourceType), consulted ONLY as a fallback for a usage component
  // with no reading yet (metricSource null) — the same fallback the prior
  // "Consumption / usage" block already used, preserved here so a
  // manual-source component that hasn't been read yet still shows MANUAL
  // INPUT rather than defaulting to API METER.
  manualSourceKeys?: Set<string>
}): ComponentDetailRow[] {
  const rows: ComponentDetailRow[] = []
  if (params.fixed.amount > 0 || params.fixed.waived) {
    const basis = !params.fixed.billingTiming.resolved
      ? 'Timing not yet resolved'
      : params.fixed.billingTiming.timing === 'bill_at_period_start'
        ? 'Invoiced in advance, at period start'
        : 'Invoiced in arrears, at period end'
    const clause = params.fixed.sourceClause?.trim() || null
    // Step E8.3.1 §3/§6 — the Source column shows a COMPACT reference
    // (e.g. "Main agreement §4.1"), never a dumped full-sentence excerpt.
    // isLongFormValue (lib/value-alignment.ts) is the SAME structural
    // predicate already used elsewhere in this codebase to distinguish a
    // short label from prose — reused here, not re-implemented.
    const isCompactClause = clause !== null && !isLongFormValue(clause)
    // Step E8.3.1 §1/§2 — provenance, not "any contract text that happens
    // to exist nearby". fixed_fee_billing_timing can ONLY ever become
    // resolved through an explicit reviewer decision (there is no AI-
    // proposal pipeline for it — see confirm-rule/route.ts's own
    // decisionProvenance derivation, which hardcodes 'reviewer_policy' for
    // this exact rule type) — this mirrors the SAME established convention
    // Commercial Logic & Billing Setup already uses for this identical
    // fact (page.tsx's isTimingFact). A resolved timing is therefore
    // REVIEWER CONFIRMED provenance, never presented as though a nearby
    // contract clause itself established it — that clause (if any) is
    // still real evidence, just kept as separate, clearly-subordinate
    // "contract context" (contextClause below), never folded into the
    // provenance claim itself.
    const sourceType = !params.fixed.billingTiming.resolved
      ? (isCompactClause ? 'CONTRACT CLAUSE' : 'CONTRACT')
      : 'REVIEWER CONFIRMED'
    const sourceLabel = !params.fixed.billingTiming.resolved
      ? (isCompactClause ? clause : 'Contract source')
      : 'Confirmed configuration'
    rows.push({
      key: 'fixed',
      component: 'Platform fee',
      basis,
      sourceType,
      sourceLabel,
      // Never duplicated when sourceLabel already IS the clause verbatim
      // (the unresolved + compact-reference case) — only offered as
      // additional context when it says something sourceLabel doesn't.
      contextClause: clause && clause !== sourceLabel ? clause : null,
      state: !params.fixed.billingTiming.resolved
        ? { label: 'Decision required', state: 'attention' }
        : params.fixed.waived
          ? { label: 'Waived', state: 'neutral' }
          : { label: 'Known', state: 'ready' },
    })
  }
  for (const u of params.usage) {
    // Step E8.3 §1 — source hierarchy: contract measure / business metric
    // (semanticInputKey, canonical and always contract/system-derived) is
    // the PRIMARY source line; the configured meter's own display name/key
    // (sourceName — whatever an org actually named or left unnamed in
    // Settings → Meters) is muted SECONDARY technical detail, never hidden
    // even when it looks unrelated to the business metric (a real
    // mismatch must stay visible, not be suppressed).
    const rawSource = u.sourceName ?? null
    const fallbackLabel = rawSource && /^[a-z0-9]+(_[a-z0-9]+)+$/i.test(rawSource.trim())
      ? humanizeKey(rawSource)
      : rawSource
    const businessMetricLabel = u.semanticInputKey ? humanizeKey(u.semanticInputKey) : null
    const sourceLabel = businessMetricLabel ?? fallbackLabel ?? 'Not yet confirmed'
    const sourceDetail = rawSource && rawSource !== sourceLabel ? rawSource : null
    const isManual = u.metricSource === 'manual_entry'
      || (!u.metricSource && !!u.semanticInputKey && !!params.manualSourceKeys?.has(u.semanticInputKey))
    rows.push({
      key: `usage:${u.key}`,
      component: u.label,
      basis: `Measured ${params.periodRangeLabel}`,
      sourceType: isManual ? 'MANUAL INPUT' : 'API METER',
      sourceLabel,
      sourceDetail,
      state: describeUsageComponentState(u.status, params.phase),
    })
  }
  for (const p of params.performance) {
    const blocked = p.status === 'pending_operational_inputs' || p.status === 'not_started'
    rows.push({
      key: `performance:${p.recurringFeeId ?? p.feeLabel}`,
      component: p.feeLabel,
      basis: p.numeratorKey && p.denominatorKey
        ? [p.numeratorKey, p.denominatorKey].map(humanizeKey).join(' ÷ ')
        : 'Performance / outcome measure',
      sourceType: blocked ? 'MANUAL INPUT' : p.status === 'waived' ? 'CONTRACT' : 'DERIVED',
      // Step E8.3 §2 — the same "never an empty-looking source heading"
      // rule applied to performance rows: DERIVED/CONTRACT never render
      // with nothing beneath them either.
      sourceLabel: blocked ? 'Manual operational inputs' : p.status === 'waived' ? 'Waived per contract terms' : 'Derived from measured inputs',
      state: describePerformanceComponentState(p.status, params.phase),
    })
  }
  return rows
}
