import { describe, it, expect } from 'vitest'
import {
  buildFixedTile, buildUsageTile, buildPerformanceTile, buildDeferredItems, deriveMeasurementPhase,
  describeUsageComponentState, describePerformanceComponentState, buildComponentDetailRows,
} from './billing-period-card-summary'
import type { FixedComponentState, UsageComponentState, PerformanceComponentState } from './billing-period-workspace'

const fmt = (n: number, c: string) => `${c} ${n.toFixed(2)}`

describe('buildFixedTile — Step 17H.4B0D4H1B4E8 §5', () => {
  it('a waived fee leads with WHY, never a bare zero', () => {
    const fixed: FixedComponentState = { amount: 0, currency: 'SEK', waived: true, billingTiming: { resolved: true, timing: 'bill_at_period_start' } }
    const tile = buildFixedTile(fixed, 'SEK', fmt)
    expect(tile).toEqual({ title: 'Fixed charges', label: 'Waived during pilot', sub: 'Otherwise billed at period start', state: 'neutral' })
  })

  it('a known, resolved fixed fee shows the amount and when it bills', () => {
    const fixed: FixedComponentState = { amount: 2000, currency: 'EUR', waived: false, billingTiming: { resolved: true, timing: 'bill_at_period_start' } }
    const tile = buildFixedTile(fixed, 'EUR', fmt)
    expect(tile).toEqual({ title: 'Fixed charges', label: 'Known fixed', sub: 'EUR 2000.00 due at period start', state: 'ready' })
  })

  it('an unresolved billing-timing decision is a genuine attention state, not a silently-known amount', () => {
    const fixed: FixedComponentState = { amount: 2000, currency: 'EUR', waived: false, billingTiming: { resolved: false, timing: null } }
    const tile = buildFixedTile(fixed, 'EUR', fmt)
    expect(tile?.state).toBe('attention')
    expect(tile?.label).toBe('Decision required')
  })

  it('no fixed component at all (amount 0, not waived) — tile omitted, never a misleading zero', () => {
    const fixed: FixedComponentState = { amount: 0, currency: 'EUR', waived: false, billingTiming: { resolved: true, timing: 'bill_at_period_start' } }
    expect(buildFixedTile(fixed, 'EUR', fmt)).toBeNull()
  })
})

describe('buildUsageTile — Step 17H.4B0D4H1B4E8 §6', () => {
  const usage = (status: UsageComponentState['status'], key = 'a'): UsageComponentState => ({ key, label: key, semanticInputKey: null, sourceName: null, status })

  it('no usage components — tile omitted (never a forced tile)', () => {
    expect(buildUsageTile([])).toBeNull()
  })

  it('a single measured item reads "1 measured item", singular', () => {
    const tile = buildUsageTile([usage('computed')])
    expect(tile?.label).toBe('1 measured item')
    expect(tile?.state).toBe('ready')
    expect(tile?.sub).toBe('Finalised')
  })

  it('multiple items read the plural count', () => {
    const tile = buildUsageTile([usage('computed', 'a'), usage('computed', 'b'), usage('computed', 'c')])
    expect(tile?.label).toBe('3 measured items')
  })

  it('an unconfigured source is a genuine attention state, never hidden behind a generic neutral wording', () => {
    const tile = buildUsageTile([usage('awaiting_source')])
    expect(tile?.state).toBe('attention')
    expect(tile?.sub).toBe('Awaiting source')
  })

  it('awaiting period close reads distinctly from a blocker (no phase supplied — pre-17H.4B0D4H1B4E8.1 fallback wording)', () => {
    const tile = buildUsageTile([usage('awaiting_period')])
    expect(tile?.state).toBe('neutral')
    expect(tile?.sub).toBe('Awaiting period close')
  })

  it('Step 17H.4B0D4H1B4E8.1 §6/§7 — before the window opens, the label/sub never overclaim that measurement is underway', () => {
    const tile = buildUsageTile([usage('awaiting_period')], 'not_started', '1 Feb 2027')
    expect(tile?.label).toBe('1 usage item')
    expect(tile?.sub).toBe('Measurement starts 1 Feb 2027')
    expect(tile?.state).toBe('neutral')
  })

  it('not_started phase without a formatted date still avoids the misleading "Awaiting period close" wording', () => {
    const tile = buildUsageTile([usage('awaiting_period')], 'not_started')
    expect(tile?.sub).toBe('Not started')
  })

  it('closed phase (window ended, not yet final) reads as awaiting finalisation, not "period close" again', () => {
    const tile = buildUsageTile([usage('pending_usage')], 'closed')
    expect(tile?.sub).toBe('Awaiting finalisation')
  })
})

describe('buildPerformanceTile — Step 17H.4B0D4H1B4E8 §7', () => {
  const perf = (status: PerformanceComponentState['status'], feeLabel = 'Performance share'): PerformanceComponentState => ({ feeLabel, status })

  it('no performance components — tile omitted', () => {
    expect(buildPerformanceTile([])).toBeNull()
  })

  it('pending operational inputs is a genuine blocker (attention), never generic "Awaiting input" applied to an unrelated blocker', () => {
    const tile = buildPerformanceTile([perf('pending_operational_inputs')])
    expect(tile?.state).toBe('attention')
    expect(tile?.label).toBe('Awaiting input')
    expect(tile?.sub).toBe('Calculated after period close')
  })

  it('not yet started reads as neutral, not an attention-worthy blocker', () => {
    const tile = buildPerformanceTile([perf('not_started')])
    expect(tile?.state).toBe('neutral')
    expect(tile?.label).toBe('Not yet started')
  })

  it('fully computed reads ready', () => {
    const tile = buildPerformanceTile([perf('computed')])
    expect(tile?.state).toBe('ready')
  })

  it('waived reads distinctly from computed', () => {
    const tile = buildPerformanceTile([perf('waived')])
    expect(tile?.label).toBe('Waived this period')
  })

  it('Step 17H.4B0D4H1B4E8.1 §12/§13 — the reported root cause: "not_started" is a CONTRACT-level flag reused for every period, so a later period whose own window merely has not opened yet used to say "Awaiting first billing period" as if it were the contract\'s very first cycle. With this period\'s own phase supplied, it now states the period-specific fact instead.', () => {
    const tile = buildPerformanceTile([perf('not_started')], 'not_started', '1 Feb 2027')
    expect(tile?.label).toBe('Not started')
    expect(tile?.sub).toBe('Measurement starts 1 Feb 2027')
    expect(tile?.sub).not.toContain('first billing period')
  })

  it('without period-timing info, the original "Awaiting first billing period" wording is preserved — no behavior change for a caller that has not adopted phase yet', () => {
    const tile = buildPerformanceTile([perf('not_started')])
    expect(tile?.sub).toBe('Awaiting first billing period')
  })

  it('the SAME defect for pending_operational_inputs: a period whose own window has not opened yet must not read as an active "Awaiting input" blocker', () => {
    const tile = buildPerformanceTile([perf('pending_operational_inputs')], 'not_started', '1 Feb 2027')
    expect(tile?.label).toBe('Not started')
    expect(tile?.state).toBe('neutral')
    expect(tile?.sub).toBe('Measurement starts 1 Feb 2027')
  })

  it('once the period is genuinely open/closed (not "not_started"), pending_operational_inputs is a real blocker again', () => {
    const tile = buildPerformanceTile([perf('pending_operational_inputs')], 'closed')
    expect(tile?.label).toBe('Awaiting input')
    expect(tile?.state).toBe('attention')
  })
})

describe('buildDeferredItems — Step 17H.4B0D4H1B4E8.1 §9/§10/§19-22 (no per-row destination — the caller states it once, in the section heading)', () => {
  // Step E9 — REVISED: a computed usage item used to be excluded here on
  // the theory that it "already belongs on this invoice" — but the real
  // arrears relationship (app/api/admin/invoice-scheduler/route.ts) means
  // a computed item from THIS period belongs on the NEXT invoice, not this
  // one; excluding it here was the exact root cause of the reported "item
  // disappears between source period and destination invoice" bug. It now
  // stays present, carrying its real amount and a "ready" state.
  it('a computed usage item still appears here — ready, with its real amount, never silently dropped', () => {
    const usage: UsageComponentState = { key: 'a', label: 'Issued requests', semanticInputKey: null, sourceName: null, status: 'computed', amount: 342.6 }
    const items = buildDeferredItems({ usage: [usage], performance: [] })
    expect(items).toHaveLength(1)
    expect(items[0].state.state).toBe('ready')
    expect(items[0].state.label).toBe('Final')
    expect(items[0].amount).toBe(342.6)
    expect(items[0].kind).toBe('usage')
  })

  it('an awaiting_source usage item is never deferred either — it is blocked, not scheduled for a later invoice', () => {
    const usage: UsageComponentState = { key: 'a', label: 'Issued requests', semanticInputKey: null, sourceName: null, status: 'awaiting_source' }
    expect(buildDeferredItems({ usage: [usage], performance: [] })).toHaveLength(0)
  })

  it('a live/pending usage item is deferred, with a plain calculation-timing text — never a destination baked into the row', () => {
    const usage: UsageComponentState = { key: 'a', label: 'Issued requests', semanticInputKey: null, sourceName: null, status: 'live_not_final' }
    const items = buildDeferredItems({ usage: [usage], performance: [] })
    expect(items).toHaveLength(1)
    expect(items[0].label).toBe('Issued requests')
    expect(items[0].timingText).toBe('Calculated after period close')
    expect(items[0].timingText).not.toContain('→')
  })

  it('before the measurement window opens, sub states the real start date — never "Measured this period" for something that has not begun', () => {
    const usage: UsageComponentState = { key: 'a', label: 'Issued requests', semanticInputKey: null, sourceName: null, status: 'awaiting_period' }
    const items = buildDeferredItems({ usage: [usage], performance: [], phase: 'not_started', measurementStartLabel: '1 Feb 2027' })
    expect(items[0].sub).toBe('Measurement starts 1 Feb 2027')
  })

  it('once the window is open (or has closed), sub reads as an ordinary in-progress measurement', () => {
    const usage: UsageComponentState = { key: 'a', label: 'Issued requests', semanticInputKey: null, sourceName: null, status: 'live_not_final' }
    const items = buildDeferredItems({ usage: [usage], performance: [], phase: 'measuring' })
    expect(items[0].sub).toBe('Measured this period')
  })

  // Step E9 — REVISED: waived stays excluded (nothing to carry forward —
  // there is no charge at all), but a computed performance item, like
  // computed usage above, now stays present as a ready, real-amount row —
  // the same root-cause fix.
  it('a waived performance item is never deferred (nothing to carry forward); a computed one now IS, ready with its real amount', () => {
    const computed: PerformanceComponentState = { feeLabel: 'Performance share', status: 'computed', amount: 475 }
    const waived: PerformanceComponentState = { feeLabel: 'Performance share', status: 'waived' }
    expect(buildDeferredItems({ usage: [], performance: [waived] })).toHaveLength(0)
    const items = buildDeferredItems({ usage: [], performance: [computed] })
    expect(items).toHaveLength(1)
    expect(items[0].state.state).toBe('ready')
    expect(items[0].amount).toBe(475)
    expect(items[0].kind).toBe('performance')
  })

  it('a not_started performance item is never deferred — it has no relationship to a specific future invoice yet', () => {
    const notStarted: PerformanceComponentState = { feeLabel: 'Performance share', status: 'not_started' }
    expect(buildDeferredItems({ usage: [], performance: [notStarted] })).toHaveLength(0)
  })

  it('§22 — a pending-operational-inputs performance item uses PROVISIONAL "Awaiting input" wording, never the guaranteed usage-style timing text', () => {
    const pending: PerformanceComponentState = { feeLabel: 'Performance share', status: 'pending_operational_inputs' }
    const items = buildDeferredItems({ usage: [], performance: [pending] })
    expect(items[0].timingText).toBe('Awaiting input')
    expect(items[0].timingText).not.toBe('Calculated after period close')
  })

  it('nothing deferred at all returns an empty array — the caller omits the section entirely, never a "None" row', () => {
    expect(buildDeferredItems({ usage: [], performance: [] })).toEqual([])
  })

  // Step E9B — audit of the E9-flagged concern: performance:${feeLabel} is
  // a mutable display string, not a stable id. When the contract extraction
  // assigned a real recurring_fee_id, the item's key must use it instead —
  // so two fees that happen to share a label (or a re-extraction that only
  // changed wording) never collide or get silently conflated.
  it('§ E9B — a performance item WITH a stable recurringFeeId keys off the id, not the (mutable) feeLabel', () => {
    const computed: PerformanceComponentState = { feeLabel: 'Performance share', recurringFeeId: 'rf_abc123', status: 'computed', amount: 475 }
    const items = buildDeferredItems({ usage: [], performance: [computed] })
    expect(items[0].key).toBe('performance:rf_abc123')
  })

  it('§ E9B — a performance item with NO recurringFeeId (older data) falls back to feeLabel, preserving the prior key exactly', () => {
    const computed: PerformanceComponentState = { feeLabel: 'Performance share', status: 'computed', amount: 475 }
    const items = buildDeferredItems({ usage: [], performance: [computed] })
    expect(items[0].key).toBe('performance:Performance share')
  })

  it('§ E9B — two performance items sharing a feeLabel but each with a distinct recurringFeeId produce distinct, non-colliding keys', () => {
    const a: PerformanceComponentState = { feeLabel: 'Performance share', recurringFeeId: 'rf_a', status: 'computed', amount: 100 }
    const b: PerformanceComponentState = { feeLabel: 'Performance share', recurringFeeId: 'rf_b', status: 'computed', amount: 200 }
    const items = buildDeferredItems({ usage: [], performance: [a, b] })
    expect(items.map(i => i.key)).toEqual(['performance:rf_a', 'performance:rf_b'])
  })

  // Step E9B.1 §13 — proves the exact arithmetic
  // app/_components/BillingSummaryCard.tsx's displayAmount formula
  // (e.amount + carriedForwardReadyTotal) relies on: summing only
  // state:'ready' items' real amounts, and an unresolved item
  // contributing NOTHING (never a fake zero standing in for "unknown" —
  // it simply isn't part of the sum at all, distinct from a genuine
  // amount of 0).
  it('§ E9B.1 §13 — only ready items sum toward a caller-computed total; an unresolved item contributes nothing (not a fake zero)', () => {
    const readyUsage: UsageComponentState = { key: 'transactions', label: 'Transactions', semanticInputKey: null, sourceName: null, status: 'computed', amount: 500 }
    const blockedUsage: UsageComponentState = { key: 'chargebacks', label: 'Chargebacks', semanticInputKey: null, sourceName: null, status: 'awaiting_source' }
    const readyPerf: PerformanceComponentState = { feeLabel: 'Performance share', status: 'computed', amount: 250 }
    const blockedPerf: PerformanceComponentState = { feeLabel: 'Uptime credit', status: 'pending_operational_inputs' }
    const items = buildDeferredItems({ usage: [readyUsage, blockedUsage], performance: [readyPerf, blockedPerf] })
    const readyTotal = items.filter(i => i.state.state === 'ready').reduce((s, i) => s + (i.amount ?? 0), 0)
    expect(readyTotal).toBe(750) // 500 + 250 — the blocked items excluded entirely, not summed as 0
    const unresolved = items.filter(i => i.state.state !== 'ready')
    expect(unresolved.every(i => i.amount == null)).toBe(true) // never a numeric placeholder
  })

  it('§ E9B.1 §13 — nothing ready at all sums to exactly 0 (a caller adding this to a known base amount is a genuine no-op, not a hidden discrepancy)', () => {
    const blocked: PerformanceComponentState = { feeLabel: 'Performance share', status: 'pending_operational_inputs' }
    const items = buildDeferredItems({ usage: [], performance: [blocked] })
    const readyTotal = items.filter(i => i.state.state === 'ready').reduce((s, i) => s + (i.amount ?? 0), 0)
    expect(readyTotal).toBe(0)
  })
})

describe('deriveMeasurementPhase — Step 17H.4B0D4H1B4E8.1 §6/§20', () => {
  it('before the period start date, the window has not opened', () => {
    expect(deriveMeasurementPhase('2027-02-01', '2027-02-28', new Date('2026-08-15T00:00:00'))).toBe('not_started')
  })

  it('within the period bounds, the window is open', () => {
    expect(deriveMeasurementPhase('2026-08-01', '2026-08-31', new Date('2026-08-15T00:00:00'))).toBe('measuring')
  })

  it('after the period end date, the window is closed', () => {
    expect(deriveMeasurementPhase('2026-08-01', '2026-08-31', new Date('2026-09-05T00:00:00'))).toBe('closed')
  })
})

describe('describeUsageComponentState — Step E8.2 §5 (one shared state vocabulary, tile and table)', () => {
  it('awaiting_source is always an attention blocker, regardless of phase', () => {
    expect(describeUsageComponentState('awaiting_source')).toEqual({ label: 'Awaiting source', state: 'attention' })
    expect(describeUsageComponentState('awaiting_source', 'not_started')).toEqual({ label: 'Awaiting source', state: 'attention' })
  })

  it('a genuinely computed reading is always Final, regardless of phase', () => {
    expect(describeUsageComponentState('computed', 'measuring')).toEqual({ label: 'Final', state: 'ready' })
    expect(describeUsageComponentState('computed', 'closed')).toEqual({ label: 'Final', state: 'ready' })
  })

  it('§7 — before the measurement window opens, an otherwise-open usage component reads Not started, never Measuring', () => {
    expect(describeUsageComponentState('awaiting_period', 'not_started')).toEqual({ label: 'Not started', state: 'neutral' })
    expect(describeUsageComponentState('pending_usage', 'not_started')).toEqual({ label: 'Not started', state: 'neutral' })
  })

  it('a closed window with a non-final reading awaits finalisation, distinct from Not started', () => {
    expect(describeUsageComponentState('pending_usage', 'closed')).toEqual({ label: 'Awaiting finalisation', state: 'neutral' })
  })

  it('an open window with a non-final reading reads Measuring — the same word the tile itself uses', () => {
    expect(describeUsageComponentState('live_not_final', 'measuring')).toEqual({ label: 'Measuring', state: 'neutral' })
  })
})

describe('describePerformanceComponentState — Step E8.2 §5/§8', () => {
  it('waived and computed are always their own final states, regardless of phase', () => {
    expect(describePerformanceComponentState('waived', 'measuring')).toEqual({ label: 'Waived', state: 'neutral' })
    expect(describePerformanceComponentState('computed', 'closed')).toEqual({ label: 'Final', state: 'ready' })
  })

  it('§8 — before the measurement window opens, BOTH not_started and pending_operational_inputs read Not started, never an active "Awaiting input" blocker', () => {
    expect(describePerformanceComponentState('not_started', 'not_started')).toEqual({ label: 'Not started', state: 'neutral' })
    expect(describePerformanceComponentState('pending_operational_inputs', 'not_started')).toEqual({ label: 'Not started', state: 'neutral' })
  })

  it('once the window is open, pending_operational_inputs is a real attention blocker again', () => {
    expect(describePerformanceComponentState('pending_operational_inputs', 'measuring')).toEqual({ label: 'Awaiting input', state: 'attention' })
  })
})

describe('buildComponentDetailRows — Step E8.2 §3/§4/§6, revised by Step E8.3.1', () => {
  const fmt = (n: number, c: string) => `${c} ${n.toFixed(2)}`
  // Step E8.3.1 §1/§2 — a RESOLVED fixed_fee_billing_timing can only ever
  // become resolved through an explicit reviewer decision (no AI-proposal
  // pipeline exists for this rule type — see confirm-rule/route.ts's own
  // decisionProvenance, and page.tsx's identical isTimingFact convention
  // for Commercial Logic's own display of this same fact), so its
  // provenance is deterministically REVIEWER CONFIRMED, never CONTRACT/
  // CONTRACT CLAUSE — regardless of whether a source_clause happens to be
  // present. Renamed from fixedKnown (E8.2/E8.3) since "known" no longer
  // implies "contract-derived" the way it used to before this fix.
  const fixedResolved: FixedComponentState = { amount: 2000, currency: 'EUR', waived: false, billingTiming: { resolved: true, timing: 'bill_at_period_start' } }
  const fixedUnresolved: FixedComponentState = { amount: 2000, currency: 'EUR', waived: false, billingTiming: { resolved: false, timing: null } }

  it('§3 — one row per component, each carrying component/basis/source/state (never a raw dump of separate narrative blocks)', () => {
    const usage: UsageComponentState = { key: 'api_calls', label: 'API calls', semanticInputKey: 'api_calls', sourceName: 'Metering API', status: 'computed', amount: 50 }
    const rows = buildComponentDetailRows({ fixed: fixedResolved, usage: [usage], performance: [], currency: 'EUR', periodRangeLabel: '1-31 Oct', fmt })
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ key: 'fixed', component: 'Platform fee', sourceType: 'REVIEWER CONFIRMED' })
    // Step E8.3 §1 — sourceLabel leads with the contract measure /
    // business metric (semanticInputKey, humanized), never the configured
    // meter's own display name; the meter's name survives as sourceDetail.
    expect(rows[1]).toMatchObject({ key: 'usage:api_calls', component: 'API calls', sourceType: 'API METER', sourceLabel: 'Api calls', sourceDetail: 'Metering API' })
  })

  it('§1/§4 — the raw configured source identity is never the row\'s primary text; the contract measure/business metric leads instead, with the technical identity preserved as muted secondary detail', () => {
    const usage: UsageComponentState = { key: 'issued', label: 'Issued payment requests', semanticInputKey: 'issued_payment_request_count', sourceName: 'e36_test_issued_payment_request_count_60', status: 'live_not_final' }
    const rows = buildComponentDetailRows({ fixed: fixedResolved, usage: [usage], performance: [], currency: 'SEK', periodRangeLabel: '1-31 Oct', fmt })
    const row = rows.find(r => r.key === 'usage:issued')!
    expect(row.sourceLabel).not.toBe('e36_test_issued_payment_request_count_60')
    expect(row.sourceLabel).toBe('Issued payment request count')
    expect(row.sourceDetail).toBe('e36_test_issued_payment_request_count_60')
  })

  it('§2/§3 — a genuinely UNRESOLVED fixed fee with a COMPACT clause reference shows it verbatim under CONTRACT CLAUSE', () => {
    const fixedWithCompactClause: FixedComponentState = { ...fixedUnresolved, sourceClause: 'Main agreement §4.1' }
    const rows = buildComponentDetailRows({ fixed: fixedWithCompactClause, usage: [], performance: [], currency: 'EUR', periodRangeLabel: '1-31 Oct', fmt })
    expect(rows[0]).toMatchObject({ sourceType: 'CONTRACT CLAUSE', sourceLabel: 'Main agreement §4.1' })
  })

  it('§3/§6 — a genuinely UNRESOLVED fixed fee whose clause is a long excerpt (not a compact reference) never dumps that excerpt into the Source column — falls back to CONTRACT, with the full text preserved as context', () => {
    const longExcerpt = 'Fees for the Services are invoiced in arrears within thirty (30) days following the end of each calendar month, unless otherwise agreed in writing by both parties.'
    const fixedWithLongClause: FixedComponentState = { ...fixedUnresolved, sourceClause: longExcerpt }
    const rows = buildComponentDetailRows({ fixed: fixedWithLongClause, usage: [], performance: [], currency: 'EUR', periodRangeLabel: '1-31 Oct', fmt })
    expect(rows[0].sourceType).toBe('CONTRACT')
    expect(rows[0].sourceLabel).toBe('Contract source')
    expect(rows[0].sourceLabel).not.toBe(longExcerpt)
    // Full text remains accessible, just not as the Source column's primary text.
    expect(rows[0].contextClause).toBe(longExcerpt)
  })

  it('§2 — a genuinely UNRESOLVED fixed fee with no extracted clause reference falls back to a truthful compact label, never a fabricated clause number and never an empty value', () => {
    const rows = buildComponentDetailRows({ fixed: fixedUnresolved, usage: [], performance: [], currency: 'EUR', periodRangeLabel: '1-31 Oct', fmt })
    expect(rows[0].sourceType).toBe('CONTRACT')
    expect(rows[0].sourceLabel).toBe('Contract source')
    expect(rows[0].sourceLabel).not.toMatch(/^§/)
    expect(rows[0].contextClause).toBeNull()
  })

  it('§1/§2 — a RESOLVED fixed fee is REVIEWER CONFIRMED even when a (possibly unrelated) clause exists — the clause is never folded into the provenance claim, only kept as separate context', () => {
    const misleadingClause = 'Fees for the Services are invoiced in arrears within thirty (30) days following the end of each calendar month.'
    const fixedResolvedWithClause: FixedComponentState = { ...fixedResolved, sourceClause: misleadingClause }
    const rows = buildComponentDetailRows({ fixed: fixedResolvedWithClause, usage: [], performance: [], currency: 'EUR', periodRangeLabel: '1-31 Oct', fmt })
    expect(rows[0].sourceType).toBe('REVIEWER CONFIRMED')
    expect(rows[0].sourceLabel).toBe('Confirmed configuration')
    expect(rows[0].sourceLabel).not.toBe(misleadingClause)
    expect(rows[0].contextClause).toBe(misleadingClause)
  })

  it('§1/§2 — a RESOLVED fixed fee with no clause at all is REVIEWER CONFIRMED with no dangling context', () => {
    const rows = buildComponentDetailRows({ fixed: fixedResolved, usage: [], performance: [], currency: 'EUR', periodRangeLabel: '1-31 Oct', fmt })
    expect(rows[0].sourceType).toBe('REVIEWER CONFIRMED')
    expect(rows[0].sourceLabel).toBe('Confirmed configuration')
    expect(rows[0].contextClause).toBeNull()
  })

  it('§2 — a computed performance row never renders DERIVED with an empty value beneath it', () => {
    const performance: PerformanceComponentState = { feeLabel: 'Payment success fee', status: 'computed', amount: 475, currency: 'SEK' }
    const rows = buildComponentDetailRows({ fixed: fixedResolved, usage: [], performance: [performance], currency: 'SEK', periodRangeLabel: '1-31 Oct', fmt })
    const row = rows.find(r => r.key === 'performance:Payment success fee')!
    expect(row.sourceType).toBe('DERIVED')
    expect(row.sourceLabel).toBeTruthy()
  })

  it('§1 — with no canonical semantic key at all, the humanized configured source name is the best-available primary label, and the raw form is still offered as secondary detail', () => {
    const usage: UsageComponentState = { key: 'x', label: 'X', semanticInputKey: null, sourceName: 'e36_test_raw_meter_key', status: 'live_not_final' }
    const rows = buildComponentDetailRows({ fixed: fixedResolved, usage: [usage], performance: [], currency: 'SEK', periodRangeLabel: '1-31 Oct', fmt })
    const row = rows.find(r => r.key === 'usage:x')!
    expect(row.sourceLabel).toBe('E36 test raw meter key')
    expect(row.sourceDetail).toBe('e36_test_raw_meter_key')
  })

  it('§6 — the row STATE is derived from the exact same function the tile itself calls, so they cannot disagree', () => {
    const usage: UsageComponentState = { key: 'a', label: 'A', semanticInputKey: null, sourceName: null, status: 'pending_usage' }
    const rows = buildComponentDetailRows({ fixed: fixedResolved, usage: [usage], performance: [], currency: 'EUR', periodRangeLabel: 'this period', phase: 'not_started', fmt })
    const row = rows.find(r => r.key === 'usage:a')!
    expect(row.state).toEqual(describeUsageComponentState('pending_usage', 'not_started'))
    expect(row.state.label).toBe('Not started')
  })

  it('a manual source with no reading yet falls back to the caller-supplied manual-source registry, not a default API METER label', () => {
    const usage: UsageComponentState = { key: 'seats', label: 'Seats', semanticInputKey: 'seats', sourceName: 'Manual entry', status: 'pending_usage' }
    const rows = buildComponentDetailRows({
      fixed: fixedResolved, usage: [usage], performance: [], currency: 'EUR', periodRangeLabel: 'this period', fmt,
      manualSourceKeys: new Set(['seats']),
    })
    expect(rows.find(r => r.key === 'usage:seats')!.sourceType).toBe('MANUAL INPUT')
  })

  it('an unresolved fixed billing-timing decision is a genuine attention row, never silently "Known"', () => {
    const rows = buildComponentDetailRows({ fixed: fixedUnresolved, usage: [], performance: [], currency: 'EUR', periodRangeLabel: 'this period', fmt })
    expect(rows[0].state).toEqual({ label: 'Decision required', state: 'attention' })
  })
})
