/**
 * POST /api/billing-test/simulate
 *
 * Preview-only: runs the exact same overage math the real invoice-scheduler
 * cron uses (computeMetricOverage), against an admin-entered test usage
 * value, for every confirmed contract mapped to the given meter. Never
 * touches planned_invoices or calls Stripe/Remembill — pure computation.
 *
 * Body: { meter_id, test_value, org_id? }
 *   org_id omitted  → caller must be an org admin; their own org is used.
 *   org_id provided → caller must be a platform admin (Verdix staff).
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { requireAdmin } from '@/lib/admin'
import { computeMetricOverage } from '@/lib/tariff'
import type { OverageTier } from '@/lib/types'

async function resolveOrgId(req: NextRequest, bodyOrgId: string | undefined): Promise<string | Response> {
  if (bodyOrgId) {
    try { await requireAdmin() } catch (res) { return res as Response }
    return bodyOrgId
  }
  try {
    const org = await requireOrg('admin')
    return org.orgId
  } catch (res) {
    return res as Response
  }
}

function buildDescription(meterLabel: string, quantity: number, tiers: OverageTier[], includedUnits: number): string {
  const billable = Math.max(0, quantity - includedUnits)
  const rate     = tiers[0]?.rate_per_unit ?? 0
  return `${meterLabel} — ${billable.toLocaleString()} excess units @ ${rate}/unit (${quantity.toLocaleString()} total, ${includedUnits.toLocaleString()} included)`
}

export async function POST(req: NextRequest) {
  const body = await req.json() as { meter_id?: string; test_value?: number; org_id?: string }
  const { meter_id: meterId, test_value: testValue } = body

  if (!meterId || testValue == null || testValue < 0) {
    return NextResponse.json({ error: 'meter_id and a non-negative test_value are required' }, { status: 400 })
  }

  const orgIdOrRes = await resolveOrgId(req, body.org_id)
  if (orgIdOrRes instanceof Response) return orgIdOrRes
  const orgId = orgIdOrRes

  const { data: meter } = await supabaseServer
    .from('billing_meters')
    .select('id, org_id, meter_key, display_name, unit_label')
    .eq('id', meterId)
    .maybeSingle()

  if (!meter) return NextResponse.json({ error: 'Meter not found' }, { status: 404 })
  if (meter.org_id !== null && meter.org_id !== orgId) {
    return NextResponse.json({ error: 'Meter does not belong to this organisation' }, { status: 403 })
  }

  // Persist the simulated reading on the meter so it's visible in the Meters GUI too.
  await supabaseServer
    .from('billing_meters')
    .update({ test_usage_value: testValue, test_usage_updated_at: new Date().toISOString() })
    .eq('id', meterId)

  const { data: mappings } = await supabaseServer
    .from('contract_meter_mappings')
    .select('job_id, included_units, overage_tiers, jobs!inner(id, org_id, contract_terms(customer_name))')
    .eq('meter_key', meter.meter_key)
    .eq('confirmed', true)
    .eq('jobs.org_id', orgId)

  type MappingRow = {
    job_id: string
    included_units: number | null
    overage_tiers: Array<{ from_unit?: number | null; to_unit?: number | null; rate_per_unit?: number }>
    jobs: { id: string; org_id: string; contract_terms: { customer_name: string | null }[] } | null
  }

  const jobs = ((mappings ?? []) as unknown as MappingRow[]).map(m => {
    const includedUnits = m.included_units ?? 0
    const tiers: OverageTier[] = (m.overage_tiers ?? []).map((t, i) => ({
      tier_label:    `Tier ${i + 1}`,
      from_unit:     t.from_unit ?? null,
      to_unit:       t.to_unit   ?? null,
      rate_per_unit: t.rate_per_unit ?? 0,
      unit_type:     meter.meter_key,
    }))
    const amount = tiers.length > 0 ? computeMetricOverage(testValue, tiers, includedUnits) : 0
    return {
      jobId:         m.job_id,
      customerName:  m.jobs?.contract_terms?.[0]?.customer_name ?? null,
      includedUnits,
      billableUnits: Math.max(0, testValue - includedUnits),
      amount:        Math.round(amount * 100) / 100,
      description:   buildDescription(meter.display_name, testValue, tiers, includedUnits),
    }
  })

  return NextResponse.json({
    meterKey:     meter.meter_key,
    meterLabel:   meter.display_name,
    unitLabel:    meter.unit_label,
    testValue,
    jobs,
  })
}
