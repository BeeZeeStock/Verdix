/**
 * GET  /api/jobs/[id]/meter-mappings
 *   Auto-generates meter mapping suggestions from the job's overage_tiers.
 *   Returns existing confirmed mappings if already saved.
 *
 * POST /api/jobs/[id]/meter-mappings
 *   Saves confirmed mappings and writes to org_billing_config on approve.
 *   body: { mappings: [{ contract_unit_type, meter_key, confirmed }] }
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { auth } from '@/lib/auth'
import { isAdminEmail, isRemembillTeam } from '@/lib/admin'
import { getFastAIClient } from '@/lib/ai-client'

// ── Auto-mapping heuristic ────────────────────────────────────────────────────
const METER_RULES: Array<{ patterns: string[]; key: string; confidence: number }> = [
  { patterns: ['sync', 'agreement', 'reconcili', 'contract run', 'billing run'], key: 'sync',     confidence: 0.92 },
  { patterns: ['api', 'call', 'request', 'transaction', 'event', 'webhook'],     key: 'api_call', confidence: 0.88 },
  { patterns: ['user', 'seat', 'license', 'named user', 'active user'],          key: 'user',     confidence: 0.88 },
]

function autoMap(unitType: string): { meter_key: string; confidence: number } {
  const lower = unitType.toLowerCase()
  for (const rule of METER_RULES) {
    if (rule.patterns.some(p => lower.includes(p))) {
      return { meter_key: rule.key, confidence: rule.confidence }
    }
  }
  return { meter_key: 'sync', confidence: 0.25 }
}

// AI-powered meter matching — uses Claude to semantically match a contract unit
// type against the org's actual available meters when rule-based matching yields
// low confidence or the suggested meter doesn't exist.
async function aiMatch(
  unitType: string,
  tiers: Array<{ from_unit: number | null; to_unit: number | null; rate_per_unit: number }>,
  availableMeters: Array<{ meter_key: string; display_name: string; unit_label: string | null }>,
): Promise<{ meter_key: string; confidence: number }> {
  if (availableMeters.length === 0) return { meter_key: 'sync', confidence: 0.1 }

  const meterList = availableMeters.map(m =>
    `- key: "${m.meter_key}", name: "${m.display_name}", unit: "${m.unit_label ?? m.meter_key}"`
  ).join('\n')

  const tierSummary = tiers.length > 0
    ? `Overage tiers: ${tiers.map(t => `${t.from_unit ?? 0}–${t.to_unit ?? '∞'} @ ${t.rate_per_unit}`).join(', ')}`
    : 'No tiers defined'

  try {
    const client = getFastAIClient()
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: `Match this contract usage metric to the best available billing meter.

Contract metric: "${unitType}"
${tierSummary}

Available meters:
${meterList}

Reply with ONLY a JSON object: {"meter_key": "<key>", "confidence": <0.0-1.0>}
Choose the meter whose purpose best matches the contract metric. If none match well, set confidence below 0.4.`,
      }],
    })
    const text = (resp.content[0] as { type: string; text: string }).text.trim()
    const match = text.match(/\{[^}]+\}/)
    if (match) {
      const parsed = JSON.parse(match[0]) as { meter_key?: string; confidence?: number }
      const key = parsed.meter_key ?? availableMeters[0].meter_key
      const conf = typeof parsed.confidence === 'number' ? Math.min(1, Math.max(0, parsed.confidence)) : 0.3
      if (availableMeters.some(m => m.meter_key === key)) return { meter_key: key, confidence: conf }
    }
  } catch {
    // Fall through to default
  }
  return { meter_key: availableMeters[0].meter_key, confidence: 0.2 }
}

// ── Billing cycle normaliser ──────────────────────────────────────────────────
// Vocabulary matches OverageTier['measurement_period'] and
// lib/tariff.ts's enumerateCadenceWindows — 'annual', not 'yearly', and
// semi-annual is checked before the generic "annual" substring match (a
// contract's own "semi-annual" would otherwise wrongly match "annual" first
// and get treated as a full year).
function normaliseCycle(freq: string | null | undefined): string {
  if (!freq) return 'monthly'
  const f = freq.toLowerCase()
  if (f.includes('semi') || f.includes('half'))     return 'semi-annual'
  if (f.includes('annual') || f.includes('year'))   return 'annual'
  if (f.includes('quarter'))                        return 'quarterly'
  return 'monthly'
}

// ── GET ───────────────────────────────────────────────────────────────────────
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id: jobId } = await params

  // Fetch the job's contract_terms (need overage_tiers + billing_frequency)
  const { data: job } = await supabaseServer
    .from('jobs')
    .select('id, org_id, contract_terms ( id, overage_tiers, billing_frequency, included_units, included_unit_type )')
    .eq('id', jobId)
    .eq('org_id', org.orgId)
    .single()

  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  const termsArr  = job.contract_terms as unknown as Array<{
    id?: string
    overage_tiers?: Array<{
      unit_type?: string
      from_unit?: number | null
      to_unit?: number | null
      rate_per_unit?: number
      measurement_period?: string | null
      minimum_period_amount?: number | null
      minimum_commitment?: import('@/lib/types').MinimumCommitment | null
      reset_anchor?: 'contract_start' | 'calendar' | null
    }>
    billing_frequency?: string | null
    included_units?: number | null
    included_unit_type?: string | null
  }>
  const terms = termsArr?.[0] ?? {}

  // Isolated from the query above deliberately — ai_proposal_cache requires
  // a migration (20260819000001_ai_proposal_cache.sql) that may not have
  // run yet in every environment. A missing column here can only ever
  // disable caching, never break usage-mapping suggestions themselves.
  type AiCache = Record<string, { promptFingerprint: string; result: { meter_key: string; confidence: number } }>
  let existingCache: AiCache = {}
  let cacheColumnAvailable = true
  if (termsArr?.[0]?.id) {
    const { data: cacheRow, error: cacheReadError } = await supabaseServer
      .from('contract_terms')
      .select('ai_proposal_cache')
      .eq('id', termsArr[0].id)
      .maybeSingle()
    if (cacheReadError) {
      cacheColumnAvailable = false
      console.warn(`[meter-mappings] ai_proposal_cache column missing — run the pending migration. Falling back without caching.`)
    } else {
      existingCache = (cacheRow?.ai_proposal_cache as AiCache | null) ?? {}
    }
  }

  const overageTiers = terms.overage_tiers ?? []
  // Contract-level fallback — used whenever a metric doesn't separately
  // state its own measurement period.
  const contractBillingCycle = normaliseCycle(terms.billing_frequency)

  // Group tiers by unit_type to build one mapping per unique unit. A
  // metric's measurement_period (when the contract states one) overrides
  // the contract-level cadence for that metric specifically — e.g. a
  // metric measured half-yearly inside an otherwise-monthly contract.
  const unitGroups = new Map<string, Array<{
    from_unit: number | null
    to_unit: number | null
    rate_per_unit: number
    minimum_period_amount: number | null
    minimum_commitment: import('@/lib/types').MinimumCommitment | null
    reset_anchor: 'contract_start' | 'calendar' | null
  }>>()
  const unitCycles = new Map<string, string>()
  for (const t of overageTiers) {
    if (!t.unit_type) continue
    if (!unitGroups.has(t.unit_type)) unitGroups.set(t.unit_type, [])
    unitGroups.get(t.unit_type)!.push({
      from_unit:    t.from_unit ?? null,
      to_unit:      t.to_unit   ?? null,
      rate_per_unit: t.rate_per_unit ?? 0,
      minimum_period_amount: t.minimum_period_amount ?? null,
      minimum_commitment: t.minimum_commitment ?? null,
      reset_anchor: t.reset_anchor ?? null,
    })
    if (t.measurement_period && !unitCycles.has(t.unit_type)) {
      unitCycles.set(t.unit_type, normaliseCycle(t.measurement_period))
    }
  }

  // Fetch any existing DB mappings for this job
  const { data: existing } = await supabaseServer
    .from('contract_meter_mappings')
    .select('*')
    .eq('job_id', jobId)

  const existingMap = new Map((existing ?? []).map((r: Record<string, unknown>) => [r.contract_unit_type as string, r]))

  // Fetch available meters: only this org's registered meters, plus platform
  // meters (org_id IS NULL) for Verdix admins processing their own contracts
  // and for Remembill/CoAccept's team — they own the Remembill-connector
  // meters and need them selectable when mapping their customers' contracts,
  // exactly like Verdix admins need the platform 'sync' meter for their own.
  const session = await auth()
  const email = session?.user?.email ?? ''
  const canSeePlatformMeters = isAdminEmail(email) || isRemembillTeam(email)
  const meterQuery = supabaseServer
    .from('billing_meters')
    .select('meter_key, display_name, unit_label, org_id')
    .order('meter_key')

  const { data: meters } = await (canSeePlatformMeters
    ? meterQuery.or(`org_id.is.null,org_id.eq.${job.org_id}`)
    : meterQuery.eq('org_id', job.org_id))

  // Build suggestions — use AI matching when rule-based result doesn't exist in this org
  const availableMeters = (meters ?? []) as Array<{ meter_key: string; display_name: string; unit_label: string | null }>
  // Accumulates fresh aiMatch() results this request actually computed, so
  // reopening the panel later (same tiers, same available meters) reuses
  // the cached call instead of re-hitting Claude every time — this endpoint
  // is fetched independently by both the Review panel and MeterMappingPanel
  // on every mount, so an uncached aiMatch() was effectively being paid for
  // twice per panel open, for every unconfirmed metric, indefinitely.
  const freshCacheWrites: Record<string, { promptFingerprint: string; result: { meter_key: string; confidence: number } }> = {}
  const suggestions = await Promise.all(
    Array.from(unitGroups.entries()).map(async ([unitType, tiers]) => {
      const db = existingMap.get(unitType)

      const sortedTiersRaw = [...tiers].sort((a, b) => (a.from_unit ?? 0) - (b.from_unit ?? 0))
      // Two ways extraction represents the free allowance: either the tier
      // list starts after a gap (first paid tier's from_unit implies it), or
      // — as our extractor actually does — the free allowance is its own
      // explicit rate_per_unit: 0 tier starting at unit 1. computeMetricOverage
      // subtracts includedUnits from quantity BEFORE walking the tiers, so a
      // zero-rate leading tier must be dropped once its span becomes
      // includedUnits — otherwise its width gets consumed a second time
      // against the already-reduced billable amount, silently doubling the
      // free allowance and undercharging every tier above it.
      const firstTierRaw = sortedTiersRaw[0]
      const firstIsIncludedTier = !!firstTierRaw && firstTierRaw.rate_per_unit === 0 && (firstTierRaw.from_unit ?? 1) <= 1
      const includedUnits = !firstTierRaw
        ? (terms.included_units ?? 0)
        : firstIsIncludedTier
          ? (firstTierRaw.to_unit ?? 0)
          : Math.max(0, (firstTierRaw.from_unit ?? 1) - 1)
      const sortedTiers = firstIsIncludedTier ? sortedTiersRaw.slice(1) : sortedTiersRaw

      let meter_key: string
      let confidence: number

      if (db) {
        meter_key  = db.meter_key  as string
        confidence = db.confidence as number
      } else {
        const auto = autoMap(unitType)
        const ruleMatchExists = availableMeters.some(m => m.meter_key === auto.meter_key)

        if (ruleMatchExists && auto.confidence >= 0.5) {
          // Rule matched and the meter exists in this org — trust it
          meter_key  = auto.meter_key
          confidence = auto.confidence
        } else {
          // Rule match is ambiguous or the meter doesn't exist — use AI,
          // but only if the exact inputs (tiers + which meters exist)
          // haven't already been matched before.
          const cacheKey = `meter_match:${unitType}`
          const fingerprint = JSON.stringify({ tiers: sortedTiers, meterKeys: availableMeters.map(m => m.meter_key) })
          const cached = existingCache[cacheKey]
          if (cached && cached.promptFingerprint === fingerprint) {
            meter_key  = cached.result.meter_key
            confidence = cached.result.confidence
          } else {
            const ai = await aiMatch(unitType, sortedTiers, availableMeters)
            meter_key  = ai.meter_key
            confidence = ai.confidence
            freshCacheWrites[cacheKey] = { promptFingerprint: fingerprint, result: ai }
          }
        }
      }

      // Below this threshold the "match" is really just aiMatch's own
      // last-resort fallback (first available meter, confidence 0.2) or an
      // AI call that itself said it wasn't confident — never pre-select a
      // meter chosen only because it happened to be technically compatible
      // or first in the list. no_match tells the client to show "No
      // suitable meter found" and require an explicit human choice instead
      // of silently defaulting to a semantically wrong meter.
      const no_match = !db && confidence < 0.4

      return {
        contract_unit_type: unitType,
        meter_key: no_match ? '' : meter_key,
        confidence,
        no_match,
        confirmed:      db ? Boolean(db.confirmed) : false,
        included_units: db ? (db.included_units as number) : includedUnits,
        overage_tiers:  db ? (db.overage_tiers as unknown) : sortedTiers,
        billing_cycle:  db ? (db.billing_cycle as string) : (unitCycles.get(unitType) ?? contractBillingCycle),
      }
    })
  )

  if (cacheColumnAvailable && Object.keys(freshCacheWrites).length > 0 && termsArr?.[0]?.id) {
    // Best-effort — a failed cache write just means the next GET recomputes
    // rather than reusing, never a correctness issue worth failing over.
    await supabaseServer
      .from('contract_terms')
      .update({ ai_proposal_cache: { ...existingCache, ...freshCacheWrites } })
      .eq('id', termsArr[0].id)
      .then(({ error }) => { if (error) console.warn(`[meter-mappings] cache write failed for job ${jobId}:`, error.message) })
  }

  return NextResponse.json({
    suggestions,
    available_meters: meters ?? [],
    billing_cycle: contractBillingCycle,
  })
}

// ── POST ──────────────────────────────────────────────────────────────────────
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id: jobId } = await params

  // Verify the job belongs to the caller's org before writing anything —
  // this handler upserts contract_meter_mappings and, once all mappings are
  // confirmed, writes tier/pricing data into org_billing_config (the table
  // the live billing cron reads) scoped only by jobId below. Without this
  // check, an admin of one org could corrupt another org's live billing
  // configuration just by knowing/guessing a job id.
  const { data: ownedJob } = await supabaseServer
    .from('jobs')
    .select('id')
    .eq('id', jobId)
    .eq('org_id', org.orgId)
    .maybeSingle()
  if (!ownedJob) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  const body = await req.json() as {
    mappings: Array<{
      contract_unit_type: string
      meter_key: string
      confirmed: boolean
      included_units: number
      overage_tiers: unknown
      billing_cycle: string
      confidence?: number
      // Reviewer's resolution of an ambiguous minimum commitment, written
      // alongside the meter mapping itself — see ReviewPanel's
      // minimum_commitment ItemKind in configure/[id]/page.tsx.
      minimum_commitment_note?: string | null
    }>
  }

  const { mappings } = body
  if (!Array.isArray(mappings) || mappings.length === 0) {
    return NextResponse.json({ error: 'mappings array required' }, { status: 400 })
  }

  const session = await import('@/lib/auth').then(m => m.auth())
  const confirmedBy = session?.user?.email ?? 'unknown'

  // Sanitise tier unit thresholds — Postgres bigint rejects decimals.
  // AI extraction can produce floats (e.g. 4999999.01) for "unlimited" ceilings.
  type RawTier = { from_unit?: number | null; to_unit?: number | null; rate_per_unit?: number }
  function sanitiseTiers(tiers: unknown): RawTier[] {
    if (!Array.isArray(tiers)) return []
    return tiers.map((t: RawTier) => ({
      ...t,
      from_unit: t.from_unit != null ? Math.round(t.from_unit) : null,
      to_unit:   t.to_unit   != null ? Math.round(t.to_unit)   : null,
    }))
  }

  // A metric's minimum commitment is stored per-tier (duplicated across that
  // metric's tiers by extraction) but tracked for confirmation once per
  // metric here, matching contract_meter_mappings' one-row-per-metric shape.
  // Take the first tier that carries one rather than trying to merge
  // conflicting values across tiers of the same metric.
  type MinCommitTier = { minimum_commitment?: { mode: string; amount: number; requires_confirmation: boolean } | null }
  function resolveMinimumCommitment(tiers: unknown): MinCommitTier['minimum_commitment'] | null {
    if (!Array.isArray(tiers)) return null
    for (const t of tiers as MinCommitTier[]) {
      if (t.minimum_commitment) return t.minimum_commitment
    }
    return null
  }

  // Upsert all mappings
  const rows = mappings.map(m => {
    const mc = resolveMinimumCommitment(m.overage_tiers)
    return {
      job_id:             jobId,
      contract_unit_type: m.contract_unit_type,
      meter_key:          m.meter_key,
      confidence:         m.confidence ?? null,
      confirmed:          m.confirmed,
      confirmed_by:       m.confirmed ? confirmedBy : null,
      confirmed_at:       m.confirmed ? new Date().toISOString() : null,
      included_units:     Math.round(m.included_units ?? 0),
      overage_tiers:      sanitiseTiers(m.overage_tiers),
      billing_cycle:      m.billing_cycle,
      minimum_commitment_mode: mc?.mode ?? null,
      minimum_commitment_requires_confirmation: mc?.requires_confirmation ?? false,
      // Only stamp confirmed_by/at for the minimum commitment once it's no
      // longer flagged as requiring confirmation — mirrors the meter
      // mapping's own confirmed/confirmed_by/confirmed_at pattern above.
      minimum_commitment_confirmed_by: mc && !mc.requires_confirmation ? confirmedBy : null,
      minimum_commitment_confirmed_at: mc && !mc.requires_confirmation ? new Date().toISOString() : null,
      minimum_commitment_note: m.minimum_commitment_note ?? null,
    }
  })

  let { error } = await supabaseServer
    .from('contract_meter_mappings')
    .upsert(rows, { onConflict: 'job_id,contract_unit_type' })

  // The minimum_commitment_* columns require a migration
  // (20260811000001_minimum_commitment_confirmation.sql) that may not have
  // run yet in every environment. Rather than hard-failing every mapping
  // save until it does, degrade to the columns that definitely exist — the
  // ambiguity itself still lives in overage_tiers JSONB (already written
  // above) and is what the UI actually reads to flag it, so nothing about
  // the "never silently apply" guarantee depends on these columns existing.
  if (error?.message?.includes('minimum_commitment')) {
    console.warn('[meter-mappings] minimum_commitment_* columns missing — run the pending migration. Falling back without them.')
    const fallbackRows = rows.map(r => ({
      job_id: r.job_id, contract_unit_type: r.contract_unit_type, meter_key: r.meter_key,
      confidence: r.confidence, confirmed: r.confirmed, confirmed_by: r.confirmed_by, confirmed_at: r.confirmed_at,
      included_units: r.included_units, overage_tiers: r.overage_tiers, billing_cycle: r.billing_cycle,
    }))
    ;({ error } = await supabaseServer
      .from('contract_meter_mappings')
      .upsert(fallbackRows, { onConflict: 'job_id,contract_unit_type' }))
  }

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // If all confirmed, write to org_billing_config and initialise billing period
  const allConfirmed = mappings.every(m => m.confirmed)
  if (allConfirmed) {
    const { data: job } = await supabaseServer
      .from('jobs')
      .select('org_id')
      .eq('id', jobId)
      .single()

    if (job?.org_id) {
      const configRows = mappings.map(m => ({
        org_id:         job.org_id,
        meter_key:      m.meter_key,
        included_units: Math.round(m.included_units ?? 0),
        overage_tiers:  sanitiseTiers(m.overage_tiers),
        billing_cycle:  m.billing_cycle,
        source:         'agreement',
        job_id:         jobId,
        active:         true,
        updated_at:     new Date().toISOString(),
      }))

      await supabaseServer
        .from('org_billing_config')
        .upsert(configRows, { onConflict: 'org_id,meter_key' })

      // Initialise org_subscriptions billing period from the contract start date.
      // This makes the cron pick up enterprise customers the same way as self-service.
      const { data: terms } = await supabaseServer
        .from('contract_terms')
        .select('contract_start_date, billing_frequency, crm_id')
        .eq('job_id', jobId)
        .maybeSingle()

      if (terms?.contract_start_date) {
        const periodStart = new Date(terms.contract_start_date)
        const periodEnd   = new Date(periodStart)
        const freq        = terms.billing_frequency ?? 'monthly'
        if      (freq === 'annual')      periodEnd.setFullYear(periodEnd.getFullYear() + 1)
        else if (freq === 'semi-annual') periodEnd.setMonth(periodEnd.getMonth() + 6)
        else if (freq === 'quarterly')   periodEnd.setMonth(periodEnd.getMonth() + 3)
        else                             periodEnd.setMonth(periodEnd.getMonth() + 1)

        await supabaseServer.from('org_subscriptions').upsert({
          org_id:               job.org_id,
          plan_id:              'enterprise',
          status:               'active',
          billing_cycle:        freq,
          current_period_start: periodStart.toISOString(),
          current_period_end:   periodEnd.toISOString(),
          syncs_used:           0,
          usage_counters:       {},
          updated_at:           new Date().toISOString(),
        }, { onConflict: 'org_id' })
      }
    }
  }

  return NextResponse.json({ ok: true, all_confirmed: allConfirmed })
}
