// Step 17D (hardened 17D.1) — the one generic resolver every commercial-
// rule consumer (overage, a per-unit additional_recurring_fee, the
// rolling volume-band migration) calls for "what is the quantity of
// semantic fact X for job J, period [start,end)" — deliberately ignorant
// of WHO is asking. Source resolution (this file) is fully separated from
// pricing (lib/tariff.ts, lib/rolling-band-transition.ts, the per-unit-fee
// execution) — this file never computes a rate, a tier, or an amount.
//
// Two independent source families, matching the architectural doctrine
// (item 1): a CONFIRMED contract_meter_mappings row (by semantic_input_key,
// not the raw contract_unit_type string) wins first — the real API-backed
// meter path, reusing lib/meter-quantity-pull.ts's exact dispatch (test /
// remembill / generic pull_endpoint_url), never a Remembill-specific
// branch here. If no confirmed meter mapping exists, a manual
// usage_period_values entry (Step 17D, item 13 — NOT
// operational_input_period_values, which stays reserved for operational
// KPIs per item 14) is the fallback.
//
// `mode` governs replay/caching semantics, not which source family is
// tried:
//   'live'                   — always pulls/reads fresh, NEVER reads or
//                               writes resolved_usage_period_snapshots.
//                               What the Consumption screen's live preview
//                               and real overage/per-unit-fee invoicing
//                               both use (item 1A/J: independent fresh
//                               pulls, never durable on their own).
//   'closed_period_read'     — for a CLOSED billing period. Reads the
//                               pinned snapshot if one has already been
//                               finalized (deterministic replay); if none
//                               exists yet, falls through to a fresh
//                               ('live'-equivalent) read WITHOUT writing
//                               anything — safe to call speculatively, any
//                               number of times, from any route (a GET
//                               preview, a repeated cron tick before the
//                               real close event) without ever becoming
//                               the thing that pins history. This is what
//                               the rolling-band migration's 3-window
//                               average uses (item 12/I) — it only ever
//                               READS, never finalizes.
//   'closed_period_finalize' — the ONLY mode allowed to write
//                               resolved_usage_period_snapshots. Reads the
//                               existing pinned snapshot if one already
//                               exists and returns it UNCHANGED (item H:
//                               "later source changes must not silently
//                               rewrite prior billing history" — finalize
//                               is idempotent, never a second pin); if
//                               none exists, pulls/reads fresh and
//                               persists that exact result as the
//                               authoritative closed-period measurement.
//                               Reserved for the real billing-close
//                               execution path (invoice-scheduler), which
//                               reuses the SAME fresh pull it already made
//                               to calculate the invoice — never a second,
//                               independent pull. See
//                               finalizeClosedPeriodUsageQuantity below,
//                               called directly by lib/usage-pull.ts /
//                               lib/per-unit-fee-pull.ts's own real-
//                               billing branches so the persisted snapshot
//                               is provably the SAME number the invoice
//                               was actually computed from.
import { supabaseServer } from '@/lib/supabase'
import { pullMeterQuantity, type MeterDefForPull } from '@/lib/meter-quantity-pull'
import { resolveRecognizedOperationalInputKey } from '@/lib/operational-input-canonicalization'

export type UsageQuantityResolutionMode = 'live' | 'closed_period_read' | 'closed_period_finalize'

export type ResolvedUsageQuantity =
  | { ready: true; quantity: number; source: 'meter'; meterKey: string }
  | { ready: true; quantity: number; source: 'manual' }
  | { ready: false; reason: string }

function dateOnly(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Exported so lib/usage-pull.ts's real (non-preview) overage execution and
// lib/per-unit-fee-pull.ts's real invoicing can pin the EXACT quantity
// they already pulled/used to compute a real charge, without this
// resolver making a second, independent pull of its own — "invoice close
// -> fresh source pull -> calculate invoice -> persist authoritative
// closed-period usage measurement" (item H), using ONE pull, not two.
// Idempotent: an existing snapshot is never overwritten (returns it
// unchanged) — a later source change can never silently rewrite prior
// billing history.
export async function finalizeClosedPeriodUsageQuantity(params: {
  jobId: string
  orgId: string
  semanticInputKey: string
  periodStart: Date
  periodEnd: Date
  quantity: number
  source: 'meter' | 'manual'
  meterKey?: string | null
}): Promise<void> {
  const canonicalKey = resolveRecognizedOperationalInputKey(params.semanticInputKey)
  if (!canonicalKey) return // nothing recognized to pin — callers already
  // gated on a successful resolution before reaching this point in
  // practice; this is a defensive no-op, never a throw, since finalizing
  // a snapshot must never be what blocks a real invoice from completing.

  const { data: existing } = await supabaseServer
    .from('resolved_usage_period_snapshots')
    .select('id')
    .eq('job_id', params.jobId)
    .eq('semantic_input_key', canonicalKey)
    .eq('period_start', dateOnly(params.periodStart))
    .eq('period_end', dateOnly(params.periodEnd))
    .maybeSingle()
  if (existing) return // already finalized — never rewritten (item H)

  await supabaseServer.from('resolved_usage_period_snapshots').insert({
    job_id: params.jobId, org_id: params.orgId, semantic_input_key: canonicalKey,
    period_start: dateOnly(params.periodStart), period_end: dateOnly(params.periodEnd),
    quantity: params.quantity, source: params.source, meter_key: params.meterKey ?? null,
  })
  // Race-tolerant: if a concurrent finalize call for the identical period
  // won first, this insert hits the table's own unique index and errors —
  // deliberately unhandled/ignored here, since the reader above (or the
  // next call to this function) converges on whichever row won, and both
  // callers were finalizing the SAME real billing run's own pulled value
  // in the first place, not two different numbers racing to matter.
}

export async function resolveUsageQuantityForPeriod(params: {
  jobId: string
  orgId: string
  semanticInputKey: string
  periodStart: Date
  periodEnd: Date
  asOf: Date
  mode: UsageQuantityResolutionMode
}): Promise<ResolvedUsageQuantity> {
  const { jobId, orgId, semanticInputKey, periodStart, periodEnd, mode } = params

  // Canonicalize the requested key the same way the compiler does (Step
  // 17C.3c) — a caller may pass either the exact canonical spelling or a
  // registered alias; an unrecognized key fails closed here too, never
  // silently proceeding against an un-vetted identity.
  const canonicalKey = resolveRecognizedOperationalInputKey(semanticInputKey)
  if (!canonicalKey) {
    return { ready: false, reason: `'${semanticInputKey}' is not a recognized semantic input key` }
  }

  const periodStartDate = dateOnly(periodStart)
  const periodEndDate = dateOnly(periodEnd)

  if (mode === 'closed_period_read' || mode === 'closed_period_finalize') {
    const { data: pinned } = await supabaseServer
      .from('resolved_usage_period_snapshots')
      .select('quantity, source, meter_key')
      .eq('job_id', jobId)
      .eq('semantic_input_key', canonicalKey)
      .eq('period_start', periodStartDate)
      .eq('period_end', periodEndDate)
      .maybeSingle()

    if (pinned) {
      return pinned.source === 'meter'
        ? { ready: true, quantity: Number(pinned.quantity), source: 'meter', meterKey: pinned.meter_key as string }
        : { ready: true, quantity: Number(pinned.quantity), source: 'manual' }
    }
    // No pin yet — 'closed_period_read' falls through to a fresh read
    // below WITHOUT ever writing (item H: a read/preview request must
    // never be what creates the durable snapshot). 'closed_period_finalize'
    // also falls through to the SAME fresh read, but persists it at the
    // end — this is the only path allowed to do so.
  }

  // ── Try the confirmed meter mapping first ──────────────────────────────
  const { data: mapping } = await supabaseServer
    .from('contract_meter_mappings')
    .select('meter_key')
    .eq('job_id', jobId)
    .eq('semantic_input_key', canonicalKey)
    .eq('confirmed', true)
    .maybeSingle()

  if (mapping?.meter_key) {
    const [{ data: meterDef }, { data: job }] = await Promise.all([
      supabaseServer
        .from('billing_meters')
        .select('pull_endpoint_url, pull_auth_token, pull_param_name, mode, test_usage_value, connector, response_metric_key')
        // Step 17D.1, item A — org_id (the sole ownership column) scopes
        // this lookup; no more org_id IS NULL platform-catalog fallback.
        // Step 17D.2, item A — is_platform_meter=false stated explicitly:
        // a customer contract's usage resolution must never resolve
        // against a genuine Verdix system meter.
        .eq('org_id', orgId)
        .eq('meter_key', mapping.meter_key)
        .eq('is_platform_meter', false)
        .maybeSingle(),
      supabaseServer.from('jobs').select('billing_customer_id').eq('id', jobId).maybeSingle(),
    ])

    const customerId = job?.billing_customer_id
    if (!customerId) {
      return { ready: false, reason: `job ${jobId} has no billing_customer_id — cannot pull meter '${mapping.meter_key}'` }
    }

    const pulled = await pullMeterQuantity({
      orgId,
      meterKey: mapping.meter_key,
      def: meterDef as MeterDefForPull | null,
      customerId,
      periodStart,
      periodEnd,
      // Step 17D rollout — real-Postgres testing exposed a genuine defect
      // here: this was `mode !== 'live'`, which made 'live' the ONLY
      // gated mode. Two problems with that. First, it broke the
      // Consumption screen's own live preview for a per-unit fee: the
      // EXISTING overage preview (lib/usage-pull.ts's real caller,
      // app/api/jobs/[id]/consumption-summary/route.ts) already passes
      // ignoreTestModeGate: true for live preview specifically so a
      // customer testing their meter setup can see numbers before going
      // live — 'live' mode here needs the exact same permissiveness for
      // parity, not the opposite. Second and more seriously: it left
      // 'closed_period_finalize' — the ONLY mode that produces a real,
      // durably-billed invoice amount (per-unit-fee real execution, and
      // the rolling-migration-only finalize trigger) — permissive of
      // test-mode meters, contradicting the invariant every other real-
      // billing path in this codebase enforces ("real billing... still
      // refuses to invoice off a test-mode meter at all, regardless of
      // this value" — lib/meter-quantity-pull.ts's own doc for this exact
      // parameter). A customer's simulated test_usage_value could have
      // produced a REAL charged invoice line. Corrected: only
      // 'closed_period_finalize' gates on test mode now — 'live' and
      // 'closed_period_read' are both non-committing reads (preview,
      // rolling-migration monitoring) and may see test-mode data;
      // 'closed_period_finalize' may not, matching computeOverageForPeriod's
      // real (non-preview) callers, which never pass ignoreTestModeGate
      // at all.
      ignoreTestModeGate: mode !== 'closed_period_finalize',
    })

    if (pulled.status === 'ok') {
      if (mode === 'closed_period_finalize') {
        await finalizeClosedPeriodUsageQuantity({
          jobId, orgId, semanticInputKey: canonicalKey, periodStart, periodEnd,
          quantity: pulled.totalUnits, source: 'meter', meterKey: mapping.meter_key,
        })
      }
      return { ready: true, quantity: pulled.totalUnits, source: 'meter', meterKey: mapping.meter_key }
    }
    // A confirmed meter mapping exists but the pull itself failed/was
    // skipped (test mode, no endpoint, connector error) — fail closed
    // rather than silently falling through to manual, which could mask a
    // real connector problem behind an unrelated stale manual figure.
    return { ready: false, reason: pulled.reason }
  }

  // ── No confirmed meter mapping — fall back to manual usage entry ───────
  const { data: manualRows } = await supabaseServer
    .from('usage_period_values')
    .select('quantity, status, finalized_at, revoked_at, recorded_at')
    .eq('job_id', jobId)
    .eq('semantic_input_key', canonicalKey)
    .eq('period_start', periodStartDate)
    .eq('period_end', periodEndDate)

  const asOfMs = params.asOf.getTime()
  const active = (manualRows ?? []).find(r => {
    if (r.finalized_at == null) return false
    if (new Date(r.finalized_at).getTime() > asOfMs) return false
    if (new Date(r.recorded_at).getTime() > asOfMs) return false
    if (r.revoked_at == null) return true
    return new Date(r.revoked_at).getTime() > asOfMs
  })

  if (active) {
    if (mode === 'closed_period_finalize') {
      await finalizeClosedPeriodUsageQuantity({
        jobId, orgId, semanticInputKey: canonicalKey, periodStart, periodEnd,
        quantity: Number(active.quantity), source: 'manual',
      })
    }
    return { ready: true, quantity: Number(active.quantity), source: 'manual' }
  }

  return { ready: false, reason: `no confirmed meter mapping or finalized manual usage value for '${canonicalKey}' in [${periodStartDate}, ${periodEndDate}]` }
}
