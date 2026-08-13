/**
 * POST /api/billing-test/simulate
 *
 * Preview-only: runs the exact same overage math the real invoice-scheduler
 * cron uses (computeMetricOverage), against an admin-entered test usage
 * value, for every confirmed contract mapped to the given meter. Never
 * touches planned_invoices or calls Stripe/Remembill — pure computation.
 *
 * Body: { meter_id, test_value, org_id?, job_id? }
 *   org_id omitted  → caller must be an org admin; their own org is used.
 *   org_id provided → caller must be a platform admin (Verdix staff).
 *   job_id provided → only that agreement's result is returned (an org can
 *                      have several bespoke agreements mapped to the same meter).
 *
 * Also previews org-level self-serve 'sync' usage against verdix_plans —
 * the same computation lib/billing-engine.ts actually charges (base_price_eur
 * + flat overage past sync_limit), so it works regardless of whether the
 * org's plan was set via a real Stripe checkout or an admin override in
 * /admin/customers — self-serve customers have no commercial-contract page
 * for this to live on, so it's previewed separately from per-agreement results.
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { requireAdmin } from '@/lib/admin'
import { getOrgSubscription, getPlan } from '@/lib/billing'
import { computeMetricOverage, describeTieredUsage } from '@/lib/tariff'
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

export async function POST(req: NextRequest) {
  const body = await req.json() as { meter_id?: string; test_value?: number; org_id?: string; job_id?: string }
  const { meter_id: meterId, test_value: testValue, job_id: jobIdFilter } = body

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

  let mappingsQuery = supabaseServer
    .from('contract_meter_mappings')
    .select('job_id, included_units, overage_tiers, jobs!inner(id, org_id, contract_terms(customer_name, currency))')
    .eq('meter_key', meter.meter_key)
    .eq('confirmed', true)
    .eq('jobs.org_id', orgId)
  if (jobIdFilter) mappingsQuery = mappingsQuery.eq('job_id', jobIdFilter)
  const { data: mappings } = await mappingsQuery

  type MappingRow = {
    job_id: string
    included_units: number | null
    overage_tiers: Array<{ from_unit?: number | null; to_unit?: number | null; rate_per_unit?: number }>
    jobs: { id: string; org_id: string; contract_terms: { customer_name: string | null; currency: string | null }[] } | null
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
      // Each agreement bills in its own contract currency — never assume
      // EUR, which is only correct for the self-serve planPreview below.
      currency:      m.jobs?.contract_terms?.[0]?.currency ?? 'EUR',
      includedUnits,
      billableUnits: Math.max(0, testValue - includedUnits),
      amount:        Math.round(amount * 100) / 100,
      description:   describeTieredUsage(meter.display_name, testValue, tiers, includedUnits),
    }
  })

  // Self-serve billing is always the 'sync' meter, always priced from
  // verdix_plans directly (lib/billing-engine.ts) — org_billing_config is
  // never involved for self-serve orgs, so this must read the same source
  // the real engine reads, not a table that many self-serve orgs (anyone
  // whose plan was set via /admin/customers rather than a live Stripe
  // checkout) will never have a row in.
  let planPreview: {
    includedUnits: number; billableUnits: number; amount: number; description: string
  } | null = null

  if (!jobIdFilter && meter.meter_key === 'sync') {
    const sub  = await getOrgSubscription(orgId).catch(() => null)
    const plan = sub ? await getPlan(sub.plan_id) : null

    if (plan) {
      const includedUnits = plan.sync_limit ?? 0
      const billableUnits = Math.max(0, testValue - includedUnits)
      const overagePrice  = plan.overage_price_eur ?? 0
      const amount         = Math.round(billableUnits * overagePrice * 100) / 100
      planPreview = {
        includedUnits,
        billableUnits,
        amount,
        description: `${meter.display_name} (${plan.name} plan) — ${testValue.toLocaleString()} total, `
          + `${includedUnits.toLocaleString()} included, ${billableUnits.toLocaleString()} billable @ €${overagePrice}/unit`,
      }
    }
  }

  return NextResponse.json({
    meterKey:     meter.meter_key,
    meterLabel:   meter.display_name,
    unitLabel:    meter.unit_label,
    testValue,
    jobs,
    planPreview,
  })
}
