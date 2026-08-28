// Pulls usage and computes overage for a billing period — the single source of
// truth for "how much overage did this period produce," used by the real
// invoice-scheduler cron (creates real invoices) and the read-only consumption
// summary / billing-test simulator (preview only) alike, so they can never
// silently diverge from each other.
import { supabaseServer } from '@/lib/supabase'
import { computeMetricOverage, describeTieredUsage, enumerateCadenceWindows, findCadenceWindowContaining, isPartialWindow, isBillingWindowClosed, resolveWindowMinimum, clampWindowToContract, type CadenceAnchorMode } from '@/lib/tariff'
import { pullMeterQuantity } from '@/lib/meter-quantity-pull'
import { finalizeClosedPeriodUsageQuantity } from '@/lib/usage-quantity-resolver'
import { resolveQualifiedUnitAggregateQuantitySource } from '@/lib/qualified-unit-aggregation-service'
import { resolveCommercialQuantity, requireReadyCommercialQuantity } from '@/lib/commercial-quantity-source'
import { resolveEffectiveCommercialStateForPeriod } from '@/lib/rolling-band-migration-pull'
import type { ContractTerms, MinimumCommitment, TierCalculationMethod } from '@/lib/types'

// Fail-closed real-billing invariant — thrown by computeOverageForPeriod
// (never caught/converted to zero internally) whenever a real-billing call
// (livePreviewAsOfUnix absent) is about to apply a usage/minimum charge for
// a window that isn't actually closed as of the caller's own explicit
// billingAsOfUnix. Distinct, catchable type (mirrors this codebase's other
// structured billing-precondition errors, e.g. lib/one-time-fee.ts's
// OneTimeFeeCapabilityBlockedError) so a caller can classify this
// precisely rather than treating it as a generic failure — though today
// every real caller simply lets it propagate to its own existing
// fail-closed catch block (e.g. invoice-scheduler's per-row try/catch,
// the same pattern already used for the credit-ledger's capability gate).
export class OpenBillingWindowError extends Error {
  readonly meterKey: string
  readonly windowStart: string
  readonly windowEnd: string
  constructor(meterKey: string, windowStart: Date, windowEnd: Date) {
    // Local-date extraction, never toISOString() — window.start/end are
    // local-midnight Dates (see enumerateCadenceWindows), and toISOString()
    // converts to UTC first, which silently shifts the reported date by a
    // day on a server not running in UTC. Same discipline this codebase
    // already applies elsewhere (e.g. invoice-scheduler's own fmtDate).
    const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    super(`Cannot bill meter '${meterKey}': its usage window (${fmt(windowStart)} – ${fmt(windowEnd)}) is not yet closed as of the billing execution time.`)
    this.name = 'OpenBillingWindowError'
    this.meterKey = meterKey
    this.windowStart = fmt(windowStart)
    this.windowEnd = fmt(windowEnd)
  }
}

type MeterCfg = {
  meter_key: string
  included_units: number
  // The contract's own description of what this meter measures (e.g.
  // "Processed Transaction", "chargeback") — distinct from meter_key
  // (the org's operational identity for the meter, which may be anything).
  // Threaded through to OverageLineItem.contractUnitType so a caller
  // building a credit-ledger component pool can classify this component
  // commercially without ever depending on the arbitrary meter_key — see
  // lib/commercial-component-scope.ts.
  contract_unit_type: string | null
  // Step 17D.1, item H/I — when set, a real (non-preview) closed-window
  // pull for this mapping also finalizes the SAME pulled quantity into
  // resolved_usage_period_snapshots (lib/usage-quantity-resolver.ts's
  // finalizeClosedPeriodUsageQuantity) — one pull, one authoritative
  // record, never a second independent pull just to snapshot.
  semantic_input_key: string | null
  overage_tiers: Array<{
    from_unit?: number | null
    to_unit?: number | null
    rate_per_unit?: number
    minimum_period_amount?: number | null
    minimum_commitment?: MinimumCommitment | null
    reset_anchor?: 'contract_start' | 'calendar' | null
    tier_calculation?: TierCalculationMethod | null
  }>
  billing_cycle: string | null
}
type MeterDef = {
  pull_endpoint_url: string | null
  pull_auth_token: string | null
  pull_param_name: string | null
  mode: 'test' | 'live'
  test_usage_value: number | null
  connector: string | null
  response_metric_key: string | null
}
type PullCfg = { client_usage_url: string; client_read_api_key?: string }

// Persisted onto planned_invoices.overage_line_items at send time — this is
// what lets the billing timeline show "what usage produced this invoice"
// without re-deriving it from Stripe/Remembill after the fact.
export type OverageLineItem = {
  meter_key: string
  // The contract's own description of what this meter measures (e.g.
  // "Processed Transaction") — see MeterCfg.contract_unit_type. Absent for
  // the legacy client_pull aggregate path (no per-job meter mapping row
  // exists there to source it from). A caller building a credit-ledger
  // component pool resolves this into a CommercialComponentClass (see
  // lib/commercial-component-scope.ts) rather than ever classifying off
  // meter_key itself.
  contractUnitType?: string | null
  total_units: number
  included_units: number
  billable_units: number
  rate_per_unit: number
  amount: number
  currency: string
  description: string
  // Step 17C.1 — 'manual_entry' covers a computed-in-arrears charge whose
  // inputs came from lib/operational-input-binding.ts's manual-entry
  // boundary (a monetary value with no live connector/meter equivalent —
  // e.g. the performance-share fee's paid/total invoice values) rather
  // than either pull mechanism below.
  metric_source: 'meter_pull' | 'client_pull' | 'manual_entry'
  // The actual window this meter was measured over — set whenever the meter
  // has its own measurement cadence, which can differ from the invoice
  // period it's displayed under (e.g. a quarterly-measured metric shown
  // inside a monthly invoice row). Omitted for the legacy client_pull path,
  // which has no per-meter cadence concept.
  windowStart?: string
  windowEnd?: string
  // True when windowEnd is the cadence's natural (not-yet-reached) end date
  // rather than a closed cycle — the figure is "so far", not final.
  windowOpen?: boolean
  // True when the contract wasn't in effect for this window's full span
  // (only possible under calendar cadence anchoring). Any minimum
  // commitment for this window is withheld from billing until a reviewer
  // confirms how it prorates — see isPartialWindow in lib/tariff.ts.
  windowPartial?: boolean
  // True when a confirmed minimum commitment (floor/minimum_spend mode) is
  // what determined the final billed amount, i.e. it exceeded the pure
  // tiered-usage charge — surfaced as a first-class line in the Consumption
  // timeline rather than only appearing inside the description tooltip.
  minimumFloorApplied?: boolean
  minimumFloorAmount?: number
}

export async function computeOverageForPeriod(params: {
  orgId: string
  jobId: string
  terms: ContractTerms
  customerId: string
  periodStartUnix: number
  periodEndUnix: number
  currency: string
  // Required, always — the single explicit temporal reference point this
  // computation is evaluated against, for BOTH real billing and preview.
  // Never read from Date.now()/new Date() internally: the caller (the
  // scheduler run, a correction request, a preview request) captures its
  // own "now" exactly once and passes it in, so the same inputs always
  // reproduce the same result regardless of when this function happens to
  // execute — the same discipline Step 14's billing-plan snapshot/
  // fingerprint already requires of its own `now`. When livePreviewAsOfUnix
  // is also supplied (preview mode), THAT value governs which open window
  // gets surfaced, unchanged from before; billingAsOfUnix is what real
  // billing's own closure check (below) is measured against.
  billingAsOfUnix: number
  // Real billing (invoice-scheduler) must skip meters still in test mode —
  // never invoice off an unfinished meter. Read-only previews (consumption
  // summary) create no invoice and no side effect, so they should still show
  // live data for a test-mode meter — that's the whole point of testing it.
  ignoreTestModeGate?: boolean
  // Real invoices should only ever contain billable line items — a meter
  // pulled fine but produced $0 overage (usage within the included
  // allowance) has nothing to invoice, so invoice-scheduler must keep
  // skipping it. The read-only preview wants the opposite: showing "we
  // pulled 19, 500 included, 0 billable" is exactly how you confirm the
  // pull actually worked, especially when every meter is under its
  // allowance. This never changes what real billing computes or charges —
  // only whether $0 results are included in the returned list.
  includeZeroUsage?: boolean
  // Read-only preview only: a meter whose cadence is longer than the scan
  // range (a quarterly-measured metric previewed inside a monthly
  // Consumption-card row) has no fully-closed window to show yet — correct
  // for billing, but it means "usage so far this quarter" never appears
  // until the quarter closes. Set this to also surface the meter's
  // currently-open window (clipped to this timestamp) as a live-so-far
  // preview. Never set by invoice-scheduler — real billing must only ever
  // charge for windows that have actually closed.
  livePreviewAsOfUnix?: number
}): Promise<OverageLineItem[]> {
  const { orgId, jobId, terms, customerId, periodStartUnix, periodEndUnix, currency, billingAsOfUnix, ignoreTestModeGate, includeZeroUsage, livePreviewAsOfUnix } = params
  const billingAsOf = new Date(billingAsOfUnix * 1000)
  // Real billing only — preview is explicitly allowed to inspect an open
  // window (that's the entire point of livePreviewAsOfUnix), so this gate
  // is scoped to its absence, never applied when previewing.
  const isRealBilling = livePreviewAsOfUnix == null
  const items: OverageLineItem[] = []

  // Primary source: this job's own confirmed agreement-specific tiers.
  // org_billing_config is deliberately NOT used here — it's a single shared
  // row per (org, meter_key), so whichever agreement was confirmed most
  // recently silently overwrites it for every other job at the same org.
  // contract_meter_mappings is the one place tiers/included_units are kept
  // genuinely per-agreement.
  const { data: meterConfigs } = await supabaseServer
    .from('contract_meter_mappings')
    .select('meter_key, included_units, overage_tiers, billing_cycle, contract_unit_type, semantic_input_key')
    .eq('job_id', jobId)
    .eq('confirmed', true)

  if (meterConfigs && meterConfigs.length > 0) {
    const scanStart  = new Date(periodStartUnix * 1000)
    const scanEnd    = new Date(periodEndUnix   * 1000)
    // Windows are anchored to the contract's start date so a quarterly meter
    // always resets on the same day-of-cycle the contract began, not on
    // whatever date this particular scan range happens to start — unless the
    // contract explicitly states calendar-boundary cadence (reset_anchor
    // below), in which case windows instead reset on fixed calendar dates
    // regardless of when the contract itself began.
    const anchorDate = terms.contract_start_date
      ? new Date(terms.contract_start_date + 'T00:00:00')
      : scanStart
    const contractEndDate = terms.contract_end_date ? new Date(terms.contract_end_date + 'T00:00:00') : null

    for (const cfg of meterConfigs as MeterCfg[]) {
      // reset_anchor is stored per-tier (duplicated across a metric's tiers
      // by extraction) — only switch to calendar cadence when the contract
      // text was explicit about it; never inferred.
      const cadenceAnchor: CadenceAnchorMode =
        cfg.overage_tiers?.some(t => t.reset_anchor === 'calendar') ? 'calendar' : 'contract_start'

      // Step 17D.1, item A — billing_meters.org_id is the sole ownership
      // column (no more org_id IS NULL platform-catalog fallback — every
      // real business meter now has a real owning org). Step 17D.2, item A
      // — is_platform_meter=false stated explicitly too: a customer
      // contract's overage/per-unit execution must never resolve against a
      // genuine Verdix system meter.
      const { data: meterDef } = await supabaseServer
        .from('billing_meters')
        .select('pull_endpoint_url, pull_auth_token, pull_param_name, mode, test_usage_value, connector, response_metric_key')
        .eq('org_id', orgId)
        .eq('meter_key', cfg.meter_key)
        .eq('is_platform_meter', false)
        .maybeSingle()

      const def = meterDef as MeterDef | null

      // A meter measures on its own cadence (billing_cycle — derived from
      // the contract's stated measurement_period for this metric, which can
      // legitimately differ from the deal's overall billing_frequency) —
      // e.g. a metric measured half-yearly inside a contract invoiced
      // monthly. Enumerate every fully-closed window of THIS meter's
      // cadence within the scan range. The common case (meter cadence ==
      // invoice cadence) yields exactly one window spanning the whole scan
      // range, so this is a superset of the old single-period behavior, not
      // a divergent path for it.
      // start/end stay the TRUE, unclamped cadence boundaries — resolveWindowMinimum
      // (below) needs them unclamped to correctly compute its own day-proration
      // overlap math, and isPartialWindow's detection depends on comparing
      // them against the contract's real start/end. measureStart/measureEnd
      // are the SEPARATE bounds usage may actually be pulled/counted over:
      // [max(window.start, contract_start), min(window.end, contract_end)].
      // Without this second pair, a calendar-anchored metric's final closed
      // window (e.g. Aug 2028 for a contract ending 2028-08-16) queried the
      // connector for the FULL calendar month (1–31 Aug), both counting
      // post-termination usage toward the calculated fee and displaying a
      // wrong "31 Aug" boundary on the timeline. Only applies to closed
      // windows — the isOpen live-preview window below clips to "today" for
      // its own, separate reason and keeps its own true, uncapped displayEnd.
      const windows: Array<{ start: Date; end: Date; measureStart: Date; measureEnd: Date; displayEnd: Date; isOpen?: boolean; isPartial?: boolean }> =
        enumerateCadenceWindows(anchorDate, cfg.billing_cycle, scanStart, scanEnd, cadenceAnchor)
          .map(w => {
            const { start: measureStart, end: measureEnd } = clampWindowToContract(w, anchorDate, contractEndDate)
            return { ...w, measureStart, measureEnd, displayEnd: measureEnd, isPartial: isPartialWindow(w, anchorDate, contractEndDate) }
          })

      // Live preview: also surface the currently-open window (not yet
      // closed) so usage-so-far is visible before it actually closes. Marked
      // isOpen so its minimum_period_amount floor doesn't apply below — that
      // guarantee is for the full period, not whatever's accrued on day one.
      // The window queried/pulled is clipped to today (end) — querying the
      // full future-reaching cadence window would ask connectors like
      // Remembill's sandbox for a range it doesn't cap at "today", returning
      // fabricated future usage. displayEnd keeps the *true, uncapped*
      // window end so the UI can still show "this meter measures quarterly,
      // Aug 11 – Nov 10" instead of a misleading same-day range.
      if (livePreviewAsOfUnix != null) {
        const asOf = new Date(livePreviewAsOfUnix * 1000)
        const openWindow = findCadenceWindowContaining(anchorDate, cfg.billing_cycle, asOf, cadenceAnchor)
        const alreadyCovered = windows.some(w => w.start.getTime() === openWindow.start.getTime())
        if (!alreadyCovered && openWindow.start <= asOf) {
          const openEnd = asOf < openWindow.end ? asOf : openWindow.end
          const openMeasureStart = clampWindowToContract(openWindow, anchorDate, contractEndDate).start
          windows.push({
            start: openWindow.start,
            end: openEnd,
            measureStart: openMeasureStart,
            measureEnd: openEnd,
            displayEnd: openWindow.end,
            isOpen: true,
            isPartial: isPartialWindow(openWindow, anchorDate, contractEndDate),
          })
        }
      }

      for (const window of windows) {
        // Fail-closed real-billing invariant — independent of, and in
        // addition to, invoice-scheduler's own prior-period selection
        // (which today already only ever passes a closed window). Checked
        // FIRST, before pulling any usage or computing any charge, so a
        // future bug anywhere upstream that hands this function an
        // actually-open window can never produce a usage/minimum charge —
        // it throws instead of silently returning zero and letting the
        // caller treat this period as settled. Never applied in preview
        // mode (isRealBilling false) — preview is explicitly allowed to
        // inspect an open window via the isOpen branch above.
        if (isRealBilling && !isBillingWindowClosed(window, billingAsOf)) {
          throw new OpenBillingWindowError(cfg.meter_key, window.start, window.end)
        }
        // Actual usage query uses measureStart/measureEnd (clamped to the
        // contract's real start/end), never the true unclamped cadence
        // start/end — see the comment on the windows construction above.
        const windowEndUnix = Math.floor(window.measureEnd.getTime() / 1000) + 86_399 // 23:59:59 on the end date

        // Test mode swaps the input source to the admin's last-simulated
        // reading instead of the real endpoint — that's the whole point of
        // testing it. Real billing (invoice-scheduler) still refuses to
        // invoice off a test-mode meter at all, regardless of this value.
        //
        // Step 17D, item 11 — the test/remembill/generic-endpoint dispatch
        // itself now lives in lib/meter-quantity-pull.ts's
        // pullMeterQuantity, shared with lib/usage-quantity-resolver.ts,
        // rather than only existing inline here. Behavior unchanged: same
        // order, same fallback, same continue-with-a-log-line-never-throw
        // discipline. periodEnd passed below is the ALREADY window-end-of-
        // day-adjusted instant (windowEndUnix above) — Remembill's own
        // connector only reads the calendar-date portion (unaffected by
        // time-of-day), and the generic pull_endpoint_url branch needs
        // exactly this adjusted value as its own period_end query param,
        // matching this code's pre-extraction behavior exactly.
        let totalUnits: number
        if (def?.connector === 'qualified_unit_aggregate') {
          // Step 16B.4 — a Verdix-owned, contractually-qualified quantity
          // (lib/qualified-unit-aggregation.ts) is a legitimate commercial
          // quantity source in its own right, not a fake external meter —
          // this is what actually solves "No suitable meter found" for a
          // metric like an SQM that has no real external usage endpoint.
          // cfg.meter_key IS the billable_unit_candidates.unit_type this
          // meter measures — no separate mapping column, and no domain
          // vocabulary (SQM/meeting/OS-2026-09) appears anywhere in this
          // file; it only ever sees whatever meter_key the caller's own
          // contract_meter_mappings row names. window.measureStart/
          // measureEnd (already clamped to the contract's own start/end,
          // exactly like every other branch here) become the aggregate's
          // billing period — window.measureEnd is a CALENDAR-DAY start
          // (see windowEndUnix's own +86_399 adjustment above), so +1 day
          // gives the correct exclusive half-open upper bound.
          const periodEnd = new Date(window.measureEnd.getTime() + 86_400_000)
          const source = await resolveQualifiedUnitAggregateQuantitySource({
            jobId, orgId, unitType: cfg.meter_key,
            periodStart: window.measureStart.toISOString(), periodEnd: periodEnd.toISOString(),
            asOf: billingAsOf.toISOString(),
          })
          const resolved = resolveCommercialQuantity(source)
          if (isRealBilling) {
            // Fail closed — never substitutes 0, a known-so-far count, or a
            // previous period's quantity. Thrown, not caught here, exactly
            // like OpenBillingWindowError above: the caller's own existing
            // fail-closed handling is what's expected to hold/fail this row.
            totalUnits = requireReadyCommercialQuantity(resolved)
          } else {
            if (!resolved.ready) {
              console.warn(`[usage-pull] qualified-unit aggregate for meter '${cfg.meter_key}' org ${orgId} not ready: ${resolved.reason}`)
              continue
            }
            totalUnits = resolved.quantity
          }
        } else {
          const pulled = await pullMeterQuantity({
            orgId, meterKey: cfg.meter_key, def, customerId,
            periodStart: window.measureStart,
            periodEnd: new Date(windowEndUnix * 1000),
            ignoreTestModeGate,
          })
          if (pulled.status === 'skip') {
            console.warn(`[usage-pull] ${pulled.reason}`)
            continue
          }
          totalUnits = pulled.totalUnits

          // Step 17D.1, item H/I — real (non-preview) billing for a
          // genuinely closed window (guaranteed by the isRealBilling throw
          // check above) finalizes the EXACT quantity just pulled as the
          // authoritative closed-period measurement — one pull, reused for
          // both the invoice and the durable snapshot, never a second
          // independent pull. Idempotent (finalizeClosedPeriodUsageQuantity
          // never overwrites an existing pin). Best-effort: awaited so the
          // snapshot is durable before this function returns, but any
          // internal failure is caught and logged here, never allowed to
          // fail the real invoice this loop iteration is building. Never
          // runs for a live preview (isRealBilling false) or a meter with
          // no declared semantic_input_key.
          if (isRealBilling && cfg.semantic_input_key) {
            await finalizeClosedPeriodUsageQuantity({
              jobId, orgId, semanticInputKey: cfg.semantic_input_key,
              periodStart: window.measureStart, periodEnd: new Date(windowEndUnix * 1000),
              quantity: totalUnits, source: 'meter', meterKey: cfg.meter_key,
            }).catch(err => console.error(`[usage-pull] failed to finalize closed-period snapshot for meter '${cfg.meter_key}' org ${orgId}:`, err))
          }
        }
        if (totalUnits <= 0 && !includeZeroUsage) continue

        const tiers = (cfg.overage_tiers ?? []).map((t, i) => ({
          tier_label:    `Tier ${i + 1}`,
          from_unit:     t.from_unit ?? null,
          to_unit:       t.to_unit   ?? null,
          rate_per_unit: t.rate_per_unit ?? 0,
          unit_type:     cfg.meter_key,
          minimum_period_amount: t.minimum_period_amount ?? null,
          minimum_commitment: t.minimum_commitment ?? null,
          tier_calculation: t.tier_calculation ?? null,
        }))
        // Step 17C.2b item A, revised 17C.2c — a rolling-band pricing
        // transition, once active as of this WINDOW's own start (mirroring
        // the fixed-fee reconciler's identical "periodStart >= effectiveFrom"
        // rule for consistency between the two "which state governs this
        // period" decisions), MAY raise the volume covered before overage
        // applies — but only when the transition's own typed
        // volume_transition_rule has actually been resolved (item A of
        // 17C.2c: a pricing band's upper bound is never automatically the
        // new included volume). Matched via contract_unit_type (what this
        // meter measures, per MeterCfg's own doc) against the mechanism's
        // aggregate.input_key, never meter_key (an arbitrary, org-side
        // connector identifier with no reason to equal it).
        //
        // Three distinct outcomes:
        //   no active transition yet       -> cfg.included_units, untouched
        //                                      (pre-17C.2 behavior, exactly).
        //   active + volume rule resolved  -> the resolver's own
        //                                      effective_contracted_volume
        //                                      (band_upper_bound/rolling_average/
        //                                      specific_volume/unchanged).
        //   active + volume rule UNRESOLVED -> HELD: this meter/window is
        //                                      skipped entirely (no line
        //                                      item, no charge) rather than
        //                                      silently keeping the old
        //                                      volume or guessing the new
        //                                      band's capacity. The base
        //                                      platform fee is completely
        //                                      unaffected by this hold —
        //                                      only this meter's overage is.
        //
        // Historical windows are unaffected either way: a window whose
        // START predates the transition's effective_from resolves back to
        // provenance 'contract_derived' (no transition active yet), via the
        // SAME asOf-gated resolver every other "which state governs this
        // period" decision in this codebase uses.
        let includedUnits = cfg.included_units ?? 0
        const rollingBandMechanism = (terms.unsupported_commercial_mechanisms ?? []).find(
          m => m.execution_status === 'executable' && m.rolling_band_migration && cfg.contract_unit_type === m.rolling_band_migration.aggregate.input_key,
        )
        if (rollingBandMechanism) {
          // asOf stays period-anchored (was this window covered by the
          // pricing transition itself); volumeRuleAsOf is the REAL billing
          // execution instant — a reviewer's volume-treatment decision has
          // no calendar tie to the period being billed, and arrears
          // billing means billingAsOf is always later than window.start
          // (see resolveEffectiveCommercialStateForPeriod's own header for
          // the real-Postgres-discovered defect this fixes).
          const effectiveState = await resolveEffectiveCommercialStateForPeriod({ jobId, terms, asOf: window.start, volumeRuleAsOf: billingAsOf })
          if (effectiveState.provenance === 'transition_active') {
            if (effectiveState.effective_contracted_volume == null) {
              console.warn(`[usage-pull] meter '${cfg.meter_key}' org ${orgId} job ${jobId}: an active rolling-band transition has no resolved contracted-volume treatment — holding this window's overage (Decision Required) rather than guessing`)
              continue
            }
            includedUnits = effectiveState.effective_contracted_volume
          }
        }
        // A minimum commitment guarantees a full cadence period's worth of
        // payment — never applied to a window that hasn't closed (isOpen).
        // For a window the contract wasn't in effect for the whole of
        // (isPartial, calendar-anchored only), the applicable amount is
        // resolved through the SAME confirmed prorate_partial_periods
        // treatment real billing already uses for this exact question
        // (lib/tariff.ts's resolveWindowMinimum) — full, prorated by days,
        // or (while genuinely unconfirmed) withheld entirely. This used to
        // unconditionally withhold the minimum for every partial window
        // regardless of what a reviewer had actually confirmed; that was
        // never wrong for an unresolved treatment, but silently ignored a
        // reviewer's explicit "bill in full"/"prorate by days" decision
        // once one existed. Usage-based charges still bill either way;
        // only the minimum-floor/additive/etc. amount is affected.
        let applyMinimum = !window.isOpen && !window.isPartial
        let minimumTiers = tiers
        if (!window.isOpen && window.isPartial) {
          const activeMc = tiers.find(t => t.minimum_commitment && !t.minimum_commitment.requires_confirmation)?.minimum_commitment
          if (activeMc) {
            const wm = resolveWindowMinimum(
              { start: window.start, end: window.end },
              anchorDate, contractEndDate ?? window.end, cadenceAnchor,
              activeMc,
            )
            if (!wm.requiresConfirmation && wm.amount != null) {
              applyMinimum = true
              minimumTiers = tiers.map(t => t.minimum_commitment === activeMc
                ? { ...t, minimum_commitment: { ...activeMc, amount: wm.amount! } }
                : t)
            }
          }
        }
        const overageResult = tiers.length > 0 ? computeMetricOverage(totalUnits, minimumTiers, includedUnits, applyMinimum) : null
        // A metric whose tier method (graduated/volume/block) isn't
        // confirmed can't be invoiced off — the same rate table produces
        // different totals under different methods, so there's no safe
        // provisional amount to bill for real. Skip the metric entirely
        // rather than guess; it stays visible as "needs interpretation" in
        // the Review panel until a reviewer confirms it.
        if (overageResult?.requiresConfirmation) continue
        const overageEur = overageResult?.amount ?? 0
        if (overageEur <= 0 && !includeZeroUsage) continue

        // Whether a confirmed minimum commitment is what determined the
        // final billed amount — compared against the pure tiered-usage
        // charge with no floor/additive/etc. applied, so the Consumption
        // timeline can show "Minimum floor applies: X" as a first-class
        // line instead of it being buried in the description tooltip only.
        const rawUsageCharge = tiers.length > 0 ? computeMetricOverage(totalUnits, tiers, includedUnits, false).amount : 0
        // Derived from minimumTiers (not tiers) so a prorated partial-window
        // floor is reported at its actual, prorated amount rather than the
        // contract's full, unprorated figure.
        const activeCommitment = minimumTiers.find(t => t.minimum_commitment && !t.minimum_commitment.requires_confirmation)?.minimum_commitment
        const minimumFloorApplied = applyMinimum && overageEur !== rawUsageCharge
          && (activeCommitment ? (activeCommitment.mode === 'floor' || activeCommitment.mode === 'minimum_spend') : true)
        const minimumFloorAmount = minimumFloorApplied
          ? (activeCommitment?.amount ?? tiers.reduce((max, t) => Math.max(max, t.minimum_period_amount ?? 0), 0))
          : undefined

        // Show this meter's own measurement window whenever it doesn't
        // exactly match the invoice period it's displayed under — either
        // because several windows of a shorter cadence land on one invoice
        // (multiple monthly windows inside a quarterly arrears row — each
        // needs its own dates to stay legible), or because a single window
        // of a *longer* cadence than the invoice period is being previewed
        // mid-cycle (a quarterly meter shown inside a monthly Consumption
        // row) — without this, that row silently looked like it was
        // measuring the same (wrong) monthly window as everything else.
        const fmtRange = (s: Date, e: Date) =>
          `${s.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${e.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
        // window.start/end are built via the local `new Date(y, m, d)`
        // constructor (lib/tariff.ts) — toISOString() converts to UTC
        // first, which would silently shift this a day off on any server
        // not running in UTC. Use the date's own local calendar fields.
        const dateOnly = (d: Date) => {
          const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0')
          return `${y}-${m}-${day}`
        }
        const matchesScanRange = dateOnly(window.measureStart) === dateOnly(scanStart) && dateOnly(window.displayEnd) === dateOnly(scanEnd)
        const windowSuffix = !matchesScanRange
          ? ` (${fmtRange(window.measureStart, window.displayEnd)})`
          : ''
        const overageDesc = describeTieredUsage(cfg.meter_key, totalUnits, tiers, includedUnits, applyMinimum, overageResult?.method ?? 'graduated') + windowSuffix
        items.push({
          meter_key: cfg.meter_key, contractUnitType: cfg.contract_unit_type ?? null,
          total_units: totalUnits, included_units: includedUnits,
          billable_units: Math.max(0, totalUnits - includedUnits), rate_per_unit: tiers[0]?.rate_per_unit ?? 0,
          amount: Math.round(overageEur * 100) / 100, currency: currency.toUpperCase(),
          description: overageDesc, metric_source: 'meter_pull',
          windowStart: dateOnly(window.measureStart),
          windowEnd:   dateOnly(window.displayEnd),
          windowOpen:  window.isOpen ?? false,
          windowPartial: window.isPartial ?? false,
          minimumFloorApplied: minimumFloorApplied || undefined,
          minimumFloorAmount,
        })
      }
    }
    return items
  }

  // Legacy org-level pull config fallback (no confirmed per-job mapping)
  const { data: orgData } = await supabaseServer
    .from('organizations')
    .select('pull_config')
    .eq('id', orgId)
    .maybeSingle()
  const pc = (orgData?.pull_config ?? {}) as Partial<PullCfg>
  if (!pc.client_usage_url) return items

  const pullUrl = new URL(pc.client_usage_url)
  pullUrl.searchParams.set('customer_id',  customerId)
  pullUrl.searchParams.set('period_start', String(periodStartUnix))
  pullUrl.searchParams.set('period_end',   String(periodEndUnix))

  const pullHeaders: Record<string, string> = {}
  if (pc.client_read_api_key) pullHeaders['Authorization'] = `Bearer ${pc.client_read_api_key}`

  const pullRes = await fetch(pullUrl.toString(), { headers: pullHeaders })
  if (!pullRes.ok) {
    console.error(`[usage-pull] legacy pull failed (${pullRes.status}) for job ${jobId}`)
    return items
  }

  const usageData      = await pullRes.json() as { total_billable_units?: number | string }
  const aggregateUnits = Number(usageData.total_billable_units ?? 0)
  const includedUnits  = terms.included_units ?? 0
  if (aggregateUnits <= 0) return items

  const legacyResult = computeMetricOverage(aggregateUnits, terms.overage_tiers ?? [], includedUnits)
  if (legacyResult.requiresConfirmation) return items
  const overageAmount = Math.round(legacyResult.amount * 100) / 100
  if (overageAmount <= 0) return items

  const overageDesc = describeTieredUsage('Usage', aggregateUnits, terms.overage_tiers ?? [], includedUnits, true, legacyResult.method)
  items.push({
    meter_key: 'usage', total_units: aggregateUnits, included_units: includedUnits,
    billable_units: Math.max(0, aggregateUnits - includedUnits), rate_per_unit: terms.overage_tiers?.[0]?.rate_per_unit ?? 0,
    amount: overageAmount, currency: currency.toUpperCase(),
    description: overageDesc, metric_source: 'client_pull',
  })
  return items
}
