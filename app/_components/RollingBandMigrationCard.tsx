'use client'

// Step 17H.4B0D4H1B4E2.3 §5/18 — extracted verbatim from page.tsx (where it
// was previously a local, non-exported function) so it can also be mounted
// from Billing Timeline (BillingSummaryCard.tsx, a different file) as the
// cross-period "Rolling-band evaluation" runtime section, not just from the
// review drawer inside page.tsx. Pure runtime-state presentation — the
// contractual RULE (measurement window, trigger, effect, source) was
// already moved to Commercial Logic & Billing Setup in a prior pass
// (lib/commercial-components.ts's buildFixedComponent) and must not be
// restated here. This pass also removed a second, previously-missed
// duplication of that same rule text (source-clause quote + "Evaluated
// from the last N periods..." sentence) that had survived inside this
// card's own expanded-details panel.
import { useState, useCallback, useEffect } from 'react'
import { hasContractStarted } from '@/lib/performance-share-timing'
import { SourceClauseLink, type SourceLocator } from './SourceClauseLink'

function humanizeKey(k: string) {
  return k.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())
}

// Step 17C.2 — mirrors lib/types.ts's own RollingBandMigrationConfig; kept
// as a local structural type here rather than importing, matching this
// codebase's existing convention for extraction-shaped types.
export type RollingBandMigrationConfig = {
  aggregate: {
    input_key: string
    window_count: number
    window_unit: 'billing_period'
    operation: 'mean'
    require_complete_windows: true
  }
  trigger_comparator: 'greater_than'
  compared_to: 'contracted_volume'
  notice_required: boolean
}

// Step 17E.3, item 3 — a friendly, GENERIC (never Remembill-specific — this
// is the SAME 17C.2 mechanism type any future contract with a rolling-band
// migration would also use) title for the two mechanism `kind` strings
// this codebase's extraction actually produces (see
// lib/commercial-mechanism-compiler.ts / the Remembill fixture). Falls back
// to a plain humanization for any other kind, never asserting a business
// name this function doesn't actually know.
const ROLLING_MECHANISM_TITLES: Record<string, string> = {
  rolling_volume_band_migration: 'Rolling volume-band migration',
  rolling_volume_pricing_transition: 'Rolling volume-band migration',
}
export function humanizeMechanismKind(kind: string): string {
  return ROLLING_MECHANISM_TITLES[kind] ?? humanizeKey(kind)
}

// Step 17C.2, item 13 — replaces the old "Unsupported" card for a mechanism
// that now has a real rolling_band_migration config: shows live
// monitoring/trigger/lifecycle status instead. Details (rolling average
// trace, band comparison, notice/effective-date state) stay collapsed by
// default. Never auto-activates anything — the only mutating actions
// exposed are confirming that advance notice was given and resolving the
// effective-timing/contracted-volume decisions.
type RollingBandEvaluation =
  | { status: 'not_ready' | 'invalid'; reason: string }
  | { status: 'no_transition'; rollingAverage: number; contractedVolume: number }
  | { status: 'transition_triggered_not_executable'; rollingAverage: number; contractedVolume: number; fromBand: { from_unit: number; to_unit: number | null; monthly_fee: number | null }; proposedBand: { from_unit: number; to_unit: number | null; monthly_fee: number | null } | null; reason: string }
  | { status: 'transition_triggered'; rollingAverage: number; contractedVolume: number; fromBand: { from_unit: number; to_unit: number | null; monthly_fee: number | null }; toBand: { from_unit: number; to_unit: number | null; monthly_fee: number | null } }
type RollingBandTransitionRow = {
  id: string
  trigger_metric: string
  trigger_value: number
  from_band: { from_unit: number; to_unit: number | null; monthly_fee: number | null }
  to_band: { from_unit: number; to_unit: number | null; monthly_fee: number | null }
  notice_required: boolean
  notice_status: 'pending' | 'confirmed' | null
  notice_confirmed_at: string | null
  effective_rule: { kind: 'next_billing_period' | 'next_renewal_term' | 'specific_date'; specific_date?: string | null; provenance: string } | null
  effective_from: string | null
  volume_transition_rule: { kind: 'band_upper_bound' | 'rolling_average' | 'specific_volume' | 'unchanged'; value?: number | null; provenance: string } | null
  status: 'pending_notice' | 'decision_required' | 'pending_effective_date' | 'pricing_required'
  lifecycle_status: 'pending_notice' | 'decision_required' | 'pending_effective_date' | 'pricing_required' | 'active'
}

// Step 17C.2c — the effective contracted/included volume a resolved
// volume_transition_rule implies, computed CLIENT-SIDE purely for display
// (the real, authoritative computation is lib/rolling-band-migration-
// pull.ts's resolveEffectiveContractedVolume, used server-side by the
// overage engine) — mirrors that function's exact same four-way logic so
// this card never shows a number the server itself wouldn't produce.
function describeVolumeTreatment(
  rule: RollingBandTransitionRow['volume_transition_rule'],
  toBand: { to_unit: number | null },
  triggerValue: number,
  contractedVolume: number | null,
): string {
  if (!rule) return 'Decision required'
  const provenanceSuffix = rule.provenance === 'contract_derived' ? ' (from the contract)' : ' (reviewer confirmed)'
  if (rule.kind === 'band_upper_bound') {
    return toBand.to_unit != null ? `${toBand.to_unit.toLocaleString()} (band upper limit)${provenanceSuffix}` : `Decision required — this band has no upper limit`
  }
  if (rule.kind === 'rolling_average') {
    // Step 17C.2d, item 2 — ceiled to whole units, matching
    // resolveEffectiveContractedVolume's own Math.ceil exactly; the raw
    // (possibly fractional) average stays visible parenthetically — the
    // audit trace this rounding must never lose.
    const ceiled = Math.ceil(triggerValue)
    const rawSuffix = ceiled !== triggerValue ? `, raw average ${triggerValue.toLocaleString(undefined, { maximumFractionDigits: 3 })}` : ''
    return `${ceiled.toLocaleString()} (rolling average, rounded up to whole requests${rawSuffix})${provenanceSuffix}`
  }
  if (rule.kind === 'specific_volume') return rule.value != null ? `${rule.value.toLocaleString()} (specific volume)${provenanceSuffix}` : 'Decision required'
  // unchanged
  return contractedVolume != null ? `${contractedVolume.toLocaleString()} (unchanged)${provenanceSuffix}` : 'Decision required'
}

function fmtBand(band: { from_unit: number; to_unit: number | null; monthly_fee: number | null }, currency?: string): string {
  const range = `${band.from_unit.toLocaleString()}–${band.to_unit != null ? band.to_unit.toLocaleString() : '∞'}`
  const fee = band.monthly_fee != null ? `${currency ?? ''} ${band.monthly_fee.toLocaleString()}/month`.trim() : 'Price required (Offereras)'
  return `${range} → ${fee}`
}

export function RollingBandMigrationCard({
  jobId, mechanismKind, title, sourceClause, config, sections, fieldSourceFallback, onViewSource, currency, contractedVolume, contractStartDate,
}: {
  jobId: string
  mechanismKind: string
  title: string
  sourceClause?: string | null
  config: RollingBandMigrationConfig
  sections?: SourceLocator[] | null
  fieldSourceFallback?: string
  onViewSource?: (section: string) => void
  currency?: string
  contractedVolume?: number | null
  // Step 17E.3, item 3 — see the preStart derivation below.
  contractStartDate?: string | null
}) {
  const [expanded, setExpanded] = useState(false)
  const [data, setData] = useState<{ evaluation: RollingBandEvaluation | null; transition: RollingBandTransitionRow | null } | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [resolvingRule, setResolvingRule] = useState(false)
  const [ruleKind, setRuleKind] = useState<'next_billing_period' | 'next_renewal_term' | 'specific_date'>('next_billing_period')
  const [specificDate, setSpecificDate] = useState('')
  const [resolvingVolumeRule, setResolvingVolumeRule] = useState(false)
  const [volumeRuleKind, setVolumeRuleKind] = useState<'band_upper_bound' | 'rolling_average' | 'unchanged' | 'specific_volume'>('band_upper_bound')
  const [specificVolume, setSpecificVolume] = useState('')

  const load = useCallback(() => {
    fetch(`/api/jobs/${jobId}/rolling-band-transitions`)
      .then(r => r.json())
      .then((res: { evaluations?: Array<{ mechanismKind: string; evaluation: RollingBandEvaluation }>; transitions?: RollingBandTransitionRow[] }) => {
        const evaluation = res.evaluations?.find(e => e.mechanismKind === mechanismKind)?.evaluation ?? null
        const transition = res.transitions?.find(t => t.trigger_metric === config.aggregate.input_key) ?? null
        setData({ evaluation, transition })
      })
      .catch(() => setData({ evaluation: null, transition: null }))
  }, [jobId, mechanismKind, config.aggregate.input_key])

  useEffect(() => { load() }, [load])

  const confirmNotice = async (transitionId: string) => {
    setConfirming(true)
    try {
      const res = await fetch(`/api/jobs/${jobId}/rolling-band-transitions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'confirm_notice', transition_id: transitionId }),
      })
      if (res.ok) load()
    } finally {
      setConfirming(false)
    }
  }

  const resolveEffectiveRule = async (transitionId: string) => {
    if (ruleKind === 'specific_date' && !specificDate) return
    setResolvingRule(true)
    try {
      const res = await fetch(`/api/jobs/${jobId}/rolling-band-transitions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resolve_effective_rule', transition_id: transitionId, kind: ruleKind, specific_date: ruleKind === 'specific_date' ? specificDate : undefined }),
      })
      if (res.ok) load()
    } finally {
      setResolvingRule(false)
    }
  }

  const resolveVolumeRule = async (transitionId: string) => {
    if (volumeRuleKind === 'specific_volume' && !specificVolume) return
    setResolvingVolumeRule(true)
    try {
      const res = await fetch(`/api/jobs/${jobId}/rolling-band-transitions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resolve_volume_rule', transition_id: transitionId, kind: volumeRuleKind, value: volumeRuleKind === 'specific_volume' ? Number(specificVolume) : undefined }),
      })
      if (res.ok) load()
    } finally {
      setResolvingVolumeRule(false)
    }
  }

  const transition = data?.transition ?? null
  const evaluation = data?.evaluation ?? null

  // Step 17H.4B0D4H1B4E2.4 §16 — "Monitoring" (the generic fallback label)
  // reads as active/ongoing evaluation, which is misleading before the
  // contract's first eligible period has even begun — 0 of N periods have
  // been evaluated, so nothing is actually being "monitored" yet. Reuses
  // the EXACT same typed check (hasContractStarted + no transition on
  // record yet) the preStart fact below already computes — never a new,
  // invented backend state, just the same already-derived boolean applied
  // to the badge label too, not just the supplementary line under it.
  const notYetStarted = !transition && !hasContractStarted(contractStartDate)
  const badge = data === null
    ? { label: 'Checking…', color: '#57534E', background: '#F5F5F4' }
    : transition
      ? transition.lifecycle_status === 'active'
        ? { label: 'Active', color: '#15803D', background: '#DCFCE7' }
        : transition.lifecycle_status === 'pricing_required'
          ? { label: 'Price required', color: '#DC2626', background: '#FEE2E2' }
          : transition.lifecycle_status === 'pending_notice'
            ? { label: 'Triggered — Notice required', color: '#B45309', background: '#FEF3C7' }
            : transition.lifecycle_status === 'decision_required'
              ? { label: 'Triggered — Decision required', color: '#DC2626', background: '#FEE2E2' }
              : { label: 'Triggered — Pending effective date', color: '#B45309', background: '#FEF3C7' }
      : evaluation?.status === 'transition_triggered'
        ? { label: 'Triggered', color: '#B45309', background: '#FEF3C7' }
        : evaluation?.status === 'transition_triggered_not_executable'
          ? { label: 'Price required', color: '#DC2626', background: '#FEE2E2' }
          : evaluation?.status === 'invalid'
            ? { label: 'Configuration issue', color: '#DC2626', background: '#FEE2E2' }
            : notYetStarted
              ? { label: 'Not started', color: '#6B7280', background: '#F3F4F6' }
              : { label: 'Monitoring', color: '#57534E', background: '#F5F5F4' }

  const summaryLine = transition
    ? `Average ${transition.trigger_value.toLocaleString(undefined, { maximumFractionDigits: 2 })} · ${fmtBand(transition.from_band, currency)} → ${fmtBand(transition.to_band, currency)}`
    : evaluation && (evaluation.status === 'no_transition' || evaluation.status === 'transition_triggered' || evaluation.status === 'transition_triggered_not_executable')
      ? `Rolling average: ${evaluation.rollingAverage.toLocaleString(undefined, { maximumFractionDigits: 2 })} (contracted volume: ${evaluation.contractedVolume.toLocaleString()})`
      : evaluation?.reason ?? null

  // Step 17E.3, item 3 — pre-start supplementary fact, derived from the
  // SAME contractStartDate check used elsewhere on this page
  // (lib/performance-share-timing.ts's hasContractStarted — never a second
  // date computation) and the mechanism's own typed window_count. Only
  // shown before the contract has started (the one case genuinely known to
  // be "0 of N" — once started, evaluation.reason's own "only X of the
  // required Y periods have closed" wording is already the more precise
  // fact and is not duplicated here).
  const preStart = notYetStarted
    ? `0 of ${config.aggregate.window_count} completed billing periods available`
    : null

  return (
    <div className="rounded-2xl border overflow-hidden" style={{ borderColor: 'rgba(26,61,43,0.12)', background: 'white' }}>
      <div className="px-4 pt-4 pb-3">
        <div className="flex items-center gap-1.5 mb-0.5">
          <i className="ti ti-chart-arrows-vertical text-stone" style={{ fontSize: 12 }} />
          <span className="text-sm font-medium text-ink">{title}</span>
        </div>
        {/* Step 17E.3, item 3 — "Status: <badge>" on its own clearly-
            separated line, fixing the reported "rolling volume band
            migrationMonitoring" concatenation (the title and badge
            previously sat directly adjacent in one flex row with nothing
            but CSS padding between them). */}
        <div className="flex items-center gap-1.5 mb-2 ml-[18px]">
          <span className="text-[11px] text-stone">Status:</span>
          <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full whitespace-nowrap" style={{ color: badge.color, background: badge.background }}>
            {badge.label}
          </span>
        </div>
        {/* Step 17H.4B0D4H1B4E2.2 §12-13 — the contractual RULE (what this
            mechanism is, what input it depends on, the measurement window,
            the source clause) is never restated here; it lives exactly
            once, as the fixed component's own "Volume adjustment"/"Volume
            adjustment source" rows in Commercial Logic & Billing Setup
            (lib/commercial-components.ts's buildFixedComponent). This card
            is runtime STATE only: badge/summaryLine/preStart below
            (periods elapsed, current vs. proposed band, evaluation
            readiness) plus the mutating notice/effective-date/volume-rule
            actions a reviewer still needs to reach. */}
        {summaryLine && <p className="text-[11px] text-stone mb-2">{summaryLine}</p>}
        {preStart && <p className="text-[11px] text-stone/60 mb-2">{preStart}</p>}
        {transition && transition.status !== 'pricing_required' && (
          <p className="text-[11px] mb-2" style={{ color: transition.volume_transition_rule ? '#57534E' : '#DC2626' }}>
            Contracted volume for overage: {describeVolumeTreatment(transition.volume_transition_rule, transition.to_band, transition.trigger_value, contractedVolume ?? null)}
          </p>
        )}
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <button
            onClick={() => setExpanded(e => !e)}
            className="text-[10px] font-medium text-stone hover:text-ink whitespace-nowrap flex-shrink-0"
          >
            {expanded ? 'Hide details' : 'View details'}
          </button>
          <SourceClauseLink sections={sections} section={fieldSourceFallback} onViewSource={onViewSource} hasClauseText={!!sourceClause} />
        </div>
        {expanded && (
          <div className="mt-3 pt-3 space-y-2 border-t" style={{ borderColor: 'rgba(26,61,43,0.08)' }}>
            {transition && transition.status === 'pricing_required' && (
              <>
                <p className="text-[11px] text-stone">Current band: {fmtBand(transition.from_band, currency)}</p>
                <p className="text-[11px] text-stone">Proposed band: {fmtBand(transition.to_band, currency)}</p>
                <p className="text-[11px] text-stone">No numeric price is configured for the proposed band — a real price must be added to base_fee_bands before this can ever activate. No price is ever invented.</p>
              </>
            )}
            {transition && transition.status !== 'pricing_required' && (
              <>
                <p className="text-[11px] text-stone">Current band: {fmtBand(transition.from_band, currency)}</p>
                <p className="text-[11px] text-stone">Proposed band: {fmtBand(transition.to_band, currency)}</p>
                <p className="text-[11px] text-stone">
                  Notice: {transition.notice_required ? (transition.notice_status === 'confirmed' ? `Confirmed ${transition.notice_confirmed_at ? new Date(transition.notice_confirmed_at).toLocaleDateString() : ''}` : 'Required — not yet confirmed') : 'Not required'}
                </p>
                <p className="text-[11px] text-stone">
                  Effective timing: {transition.effective_rule ? `${transition.effective_rule.kind.replace(/_/g, ' ')}${transition.effective_from ? ` — ${transition.effective_from}` : ''} (${transition.effective_rule.provenance === 'contract_derived' ? 'from the contract' : 'reviewer confirmed'})` : 'Not yet resolved — Decision required'}
                </p>
                {transition.lifecycle_status === 'pending_notice' && (
                  <button
                    onClick={() => confirmNotice(transition.id)}
                    disabled={confirming}
                    className="text-[11px] font-medium px-3 py-1.5 rounded-lg mt-1"
                    style={{ background: '#1A3D2B', color: 'white', opacity: confirming ? 0.6 : 1 }}
                  >
                    {confirming ? 'Confirming…' : 'Confirm notice was given'}
                  </button>
                )}
                {(transition.lifecycle_status === 'decision_required' || transition.lifecycle_status === 'pending_effective_date') && (
                  <div className="mt-1 space-y-1.5">
                    <p className="text-[11px] text-stone font-medium">When does this take effect?</p>
                    <select
                      value={ruleKind}
                      onChange={e => setRuleKind(e.target.value as typeof ruleKind)}
                      className="text-[11px] border rounded-lg px-2 py-1"
                      style={{ borderColor: 'rgba(26,61,43,0.15)' }}
                    >
                      <option value="next_billing_period">Next billing period</option>
                      <option value="next_renewal_term">Next renewal/contract term</option>
                      <option value="specific_date">Specific effective date</option>
                    </select>
                    {ruleKind === 'specific_date' && (
                      <input
                        type="date"
                        value={specificDate}
                        onChange={e => setSpecificDate(e.target.value)}
                        className="text-[11px] border rounded-lg px-2 py-1 ml-1"
                        style={{ borderColor: 'rgba(26,61,43,0.15)' }}
                      />
                    )}
                    <button
                      onClick={() => resolveEffectiveRule(transition.id)}
                      disabled={resolvingRule || (ruleKind === 'specific_date' && !specificDate)}
                      className="text-[11px] font-medium px-3 py-1.5 rounded-lg mt-1 block"
                      style={{ background: '#1A3D2B', color: 'white', opacity: resolvingRule ? 0.6 : 1 }}
                    >
                      {resolvingRule ? 'Resolving…' : transition.effective_rule ? 'Update effective timing' : 'Resolve effective timing'}
                    </button>
                  </div>
                )}
                {/* Step 17C.2c — a SEPARATE structured decision from the
                    effective-timing one above: which pricing band applies
                    is never assumed to also answer which contracted/
                    included volume governs future overage. */}
                <div className="mt-2 pt-2 space-y-1.5 border-t" style={{ borderColor: 'rgba(26,61,43,0.06)' }}>
                  <p className="text-[11px] text-stone font-medium">What contracted volume applies after this pricing-band change?</p>
                  <select
                    value={volumeRuleKind}
                    onChange={e => setVolumeRuleKind(e.target.value as typeof volumeRuleKind)}
                    className="text-[11px] border rounded-lg px-2 py-1"
                    style={{ borderColor: 'rgba(26,61,43,0.15)' }}
                  >
                    <option value="band_upper_bound">Use the selected band&apos;s upper limit</option>
                    <option value="rolling_average">Use rolling average, rounded up to whole requests</option>
                    <option value="unchanged">Keep existing contracted volume</option>
                    <option value="specific_volume">Set a specific contracted volume</option>
                  </select>
                  {volumeRuleKind === 'specific_volume' && (
                    <input
                      type="number"
                      value={specificVolume}
                      onChange={e => setSpecificVolume(e.target.value)}
                      placeholder="e.g. 10000"
                      className="text-[11px] border rounded-lg px-2 py-1 ml-1"
                      style={{ borderColor: 'rgba(26,61,43,0.15)', width: 120 }}
                    />
                  )}
                  <button
                    onClick={() => resolveVolumeRule(transition.id)}
                    disabled={resolvingVolumeRule || (volumeRuleKind === 'specific_volume' && !specificVolume)}
                    className="text-[11px] font-medium px-3 py-1.5 rounded-lg mt-1 block"
                    style={{ background: '#1A3D2B', color: 'white', opacity: resolvingVolumeRule ? 0.6 : 1 }}
                  >
                    {resolvingVolumeRule ? 'Resolving…' : transition.volume_transition_rule ? 'Update contracted volume' : 'Resolve contracted volume'}
                  </button>
                </div>
              </>
            )}
            {!transition && evaluation?.status === 'transition_triggered' && (
              <>
                <p className="text-[11px] text-stone">Current band: {fmtBand(evaluation.fromBand, currency)}</p>
                <p className="text-[11px] text-stone">Proposed band: {fmtBand(evaluation.toBand, currency)}</p>
                <p className="text-[11px] text-stone/60">Detected just now — will be recorded on the next scheduled billing run.</p>
              </>
            )}
            {!transition && evaluation?.status === 'transition_triggered_not_executable' && (
              <p className="text-[11px] text-stone">{evaluation.reason}</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
