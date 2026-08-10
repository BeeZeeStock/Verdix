/**
 * GET /api/jobs/[id]/consumption-summary
 *
 * Per-billing-cycle consumption for a job's metered/overage terms — what
 * actually gets pushed into invoicing. Past (sent) periods read straight
 * from the overage_line_items snapshot already stored on planned_invoices
 * at send time. The current in-progress period does a live read-only pull
 * (same computeOverageForPeriod used by the real cron) so usage-so-far is
 * visible before the cycle closes. Future periods are placeholders.
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { computeOverageForPeriod, type OverageLineItem } from '@/lib/usage-pull'
import type { ContractTerms } from '@/lib/types'

type PeriodStatus = 'past' | 'current' | 'future'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let org
  try { org = await requireOrg('member') } catch (res) { return res as Response }

  const { id: jobId } = await params

  const { data: job } = await supabaseServer
    .from('jobs')
    .select('id, org_id, billing_customer_id, contract_terms ( * )')
    .eq('id', jobId)
    .eq('org_id', org.orgId)
    .maybeSingle()

  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  const termsArr = job.contract_terms as unknown as ContractTerms[]
  const terms    = termsArr?.[0]

  const { data: rows } = await supabaseServer
    .from('planned_invoices')
    .select('id, period_start, period_end, currency, status, overage_line_items')
    .eq('job_id', jobId)
    .eq('invoice_type', 'period')
    .order('period_start', { ascending: true })

  if (!rows || rows.length === 0) {
    return NextResponse.json({ periods: [] })
  }

  const today = new Date().toISOString().slice(0, 10)
  const customerId = job.billing_customer_id as string | null

  const periods = await Promise.all(rows.map(async row => {
    const periodStart = row.period_start as string
    const periodEnd   = row.period_end as string

    let status: PeriodStatus
    if (row.status === 'sent' || row.status === 'paid') status = 'past'
    else if (periodStart <= today && today <= periodEnd) status = 'current'
    else status = 'future'

    let overageItems = (row.overage_line_items ?? []) as OverageLineItem[]

    // Live read-only preview for the cycle currently in progress — same
    // computation the real cron will run when the period closes, but nothing
    // is written and no invoice is created.
    if (status === 'current' && customerId && terms) {
      overageItems = await computeOverageForPeriod({
        orgId:           org.orgId,
        jobId,
        terms,
        customerId,
        periodStartUnix: Math.floor(new Date(periodStart + 'T00:00:00').getTime() / 1000),
        periodEndUnix:   Math.floor(new Date(periodEnd   + 'T23:59:59').getTime() / 1000),
        currency:        row.currency ?? terms.currency ?? 'EUR',
        ignoreTestModeGate: true,
        includeZeroUsage:   true,
      }).catch(() => [])
    }

    return {
      id:           row.id,
      periodStart,
      periodEnd,
      status,
      currency:     row.currency,
      overageItems: status === 'future' ? [] : overageItems,
      overageTotal: status === 'future' ? 0 : overageItems.reduce((s, i) => s + i.amount, 0),
    }
  }))

  return NextResponse.json({ periods })
}
