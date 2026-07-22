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

const ADMIN_EMAILS = ['bilal.zahoor@yahoo.com', 'bilal@lynoraai.com']

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

// ── Billing cycle normaliser ──────────────────────────────────────────────────
function normaliseCycle(freq: string | null | undefined): string {
  if (!freq) return 'monthly'
  const f = freq.toLowerCase()
  if (f.includes('annual') || f.includes('year')) return 'yearly'
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
    .select('id, org_id, contract_terms ( overage_tiers, billing_frequency, included_units, included_unit_type )')
    .eq('id', jobId)
    .eq('org_id', org.orgId)
    .single()

  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  const termsArr  = job.contract_terms as unknown as Array<{
    overage_tiers?: Array<{ unit_type?: string; from_unit?: number | null; to_unit?: number | null; rate_per_unit?: number }>
    billing_frequency?: string | null
    included_units?: number | null
    included_unit_type?: string | null
  }>
  const terms = termsArr?.[0] ?? {}

  const overageTiers = terms.overage_tiers ?? []
  const billingCycle = normaliseCycle(terms.billing_frequency)

  // Group tiers by unit_type to build one mapping per unique unit
  const unitGroups = new Map<string, Array<{ from_unit: number | null; to_unit: number | null; rate_per_unit: number }>>()
  for (const t of overageTiers) {
    if (!t.unit_type) continue
    if (!unitGroups.has(t.unit_type)) unitGroups.set(t.unit_type, [])
    unitGroups.get(t.unit_type)!.push({
      from_unit:    t.from_unit ?? null,
      to_unit:      t.to_unit   ?? null,
      rate_per_unit: t.rate_per_unit ?? 0,
    })
  }

  // Fetch any existing DB mappings for this job
  const { data: existing } = await supabaseServer
    .from('contract_meter_mappings')
    .select('*')
    .eq('job_id', jobId)

  const existingMap = new Map((existing ?? []).map((r: Record<string, unknown>) => [r.contract_unit_type as string, r]))

  // Fetch available meters: only this org's registered meters.
  // Verdix admins also see platform meters (org_id IS NULL) for their own contract processing.
  const session = await auth()
  const isAdmin = ADMIN_EMAILS.includes(session?.user?.email ?? '')
  const meterQuery = supabaseServer
    .from('billing_meters')
    .select('meter_key, display_name, unit_label, org_id')
    .order('meter_key')

  const { data: meters } = await (isAdmin
    ? meterQuery.or(`org_id.is.null,org_id.eq.${job.org_id}`)
    : meterQuery.eq('org_id', job.org_id))

  // Build suggestions
  const suggestions = Array.from(unitGroups.entries()).map(([unitType, tiers]) => {
    const db = existingMap.get(unitType)
    const auto = autoMap(unitType)

    // Included units: first tier's from_unit - 1 (or 0 if first tier starts at 0/1)
    const sortedTiers = [...tiers].sort((a, b) => (a.from_unit ?? 0) - (b.from_unit ?? 0))
    const includedUnits = sortedTiers.length > 0
      ? Math.max(0, (sortedTiers[0].from_unit ?? 1) - 1)
      : (terms.included_units ?? 0)

    return {
      contract_unit_type: unitType,
      meter_key:          db ? (db.meter_key as string) : auto.meter_key,
      confidence:         db ? (db.confidence as number) : auto.confidence,
      confirmed:          db ? Boolean(db.confirmed)  : false,
      included_units:     db ? (db.included_units as number) : includedUnits,
      overage_tiers:      db ? (db.overage_tiers as unknown) : sortedTiers,
      billing_cycle:      db ? (db.billing_cycle as string) : billingCycle,
    }
  })

  return NextResponse.json({
    suggestions,
    available_meters: meters ?? [],
    billing_cycle: billingCycle,
  })
}

// ── POST ──────────────────────────────────────────────────────────────────────
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try { await requireOrg('admin') } catch (res) { return res as Response }

  const { id: jobId } = await params
  const body = await req.json() as {
    mappings: Array<{
      contract_unit_type: string
      meter_key: string
      confirmed: boolean
      included_units: number
      overage_tiers: unknown
      billing_cycle: string
      confidence?: number
    }>
  }

  const { mappings } = body
  if (!Array.isArray(mappings) || mappings.length === 0) {
    return NextResponse.json({ error: 'mappings array required' }, { status: 400 })
  }

  const session = await import('@/lib/auth').then(m => m.auth())
  const confirmedBy = session?.user?.email ?? 'unknown'

  // Upsert all mappings
  const rows = mappings.map(m => ({
    job_id:             jobId,
    contract_unit_type: m.contract_unit_type,
    meter_key:          m.meter_key,
    confidence:         m.confidence ?? null,
    confirmed:          m.confirmed,
    confirmed_by:       m.confirmed ? confirmedBy : null,
    confirmed_at:       m.confirmed ? new Date().toISOString() : null,
    included_units:     m.included_units,
    overage_tiers:      m.overage_tiers,
    billing_cycle:      m.billing_cycle,
  }))

  const { error } = await supabaseServer
    .from('contract_meter_mappings')
    .upsert(rows, { onConflict: 'job_id,contract_unit_type' })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // If all confirmed, write to org_billing_config
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
        included_units: m.included_units,
        overage_tiers:  m.overage_tiers,
        billing_cycle:  m.billing_cycle,
        source:         'agreement',
        job_id:         jobId,
        active:         true,
        updated_at:     new Date().toISOString(),
      }))

      await supabaseServer
        .from('org_billing_config')
        .upsert(configRows, { onConflict: 'org_id,meter_key' })
    }
  }

  return NextResponse.json({ ok: true, all_confirmed: allConfirmed })
}
