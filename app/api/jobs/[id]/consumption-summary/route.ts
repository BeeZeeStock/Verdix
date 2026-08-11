/**
 * GET /api/jobs/[id]/consumption-summary
 *
 * Per-billing-cycle consumption for a job's metered/overage terms — what
 * actually gets pushed into invoicing. invoice-scheduler bills a period's
 * overage in arrears, on the *next* period's invoice (alongside that next
 * period's advance base fee) — so a period's own row is never where its own
 * overage snapshot lives once truly billed. Status per period:
 *   - future:  hasn't started yet.
 *   - current: today falls within it — live pull, usage-so-far.
 *   - pending: it has closed (today is past its end) but the next period's
 *     invoice — the one that will carry this period's arrears overage —
 *     hasn't been sent yet. Usage is final at this point, so still a live
 *     pull, just framed as "what will be billed" rather than "so far".
 *   - past:    closed, and the next period's invoice has actually been
 *     sent — read that row's overage_line_items snapshot (not this row's
 *     own, which only ever holds the *previous* period's arrears amount).
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { computeOverageForPeriod, type OverageLineItem } from '@/lib/usage-pull'
import type { ContractTerms } from '@/lib/types'

type PeriodStatus = 'past' | 'current' | 'pending' | 'future'

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

  const periods = await Promise.all(rows.map(async (row, i) => {
    const periodStart = row.period_start as string
    const periodEnd   = row.period_end as string
    // rows is ordered by period_start ascending, so the next row is this
    // period's immediate successor — the invoice that bills its arrears.
    const nextRow = rows[i + 1] ?? null

    let status: PeriodStatus
    if (today < periodStart) status = 'future'
    else if (today <= periodEnd) status = 'current'
    else if (nextRow && (nextRow.status === 'sent' || nextRow.status === 'paid')) status = 'past'
    else status = 'pending'

    let overageItems: OverageLineItem[] = []

    if (status === 'past' && nextRow) {
      overageItems = (nextRow.overage_line_items ?? []) as OverageLineItem[]
    } else if ((status === 'current' || status === 'pending') && customerId && terms) {
      // Live read-only preview — same computation the real cron will run.
      // 'current': usage-so-far, cycle still open. 'pending': the cycle has
      // closed so this is the final figure, just not actually invoiced yet.
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
      overageItems,
      overageTotal: overageItems.reduce((s, i) => s + i.amount, 0),
    }
  }))

  return NextResponse.json({ periods })
}
