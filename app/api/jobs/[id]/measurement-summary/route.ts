/**
 * GET /api/jobs/[id]/measurement-summary
 *
 * Step 17H.2B.2 — the pricing-FREE counterpart to /consumption-summary,
 * used exclusively by Billing Timeline's Refresh action. Returns only what
 * has genuinely been OBSERVED for a period's usage-adjacent metrics
 * (quantity, source, source type) — never a computed monetary amount.
 * lib/usage-measurement-summary.ts's resolveMeasurementSummaryForPeriod is
 * the only function this route calls for measurement; it never imports or
 * reaches computeOverageForPeriod's pricing block, computePerUnitFee-
 * LineItemsForPeriod's `amount = quantity * rate` line, or any tier/rolling-
 * band/performance calculation.
 *
 * Deliberately narrower than /consumption-summary (item 4 — "do not
 * casually change its existing contract globally"): that route stays
 * exactly as-is, still used by Billing Periods and by Billing Timeline's
 * own initial mount load (for 'past'-status persisted invoice data, which
 * carries zero pricing computation of its own — see that route's own
 * 'past' branch, a direct read of already-sent overage_line_items).
 *
 * Scope, per items 8/9: only 'current' and 'pending' periods are ever
 * measured here — a 'future' period is never polled (nothing has started
 * yet), and a 'past' period is never re-polled (its real, already-sent
 * invoice is the authoritative record; re-measuring it here would risk
 * disagreeing with history for no reason). 'past'/'future' periods are
 * simply absent from this route's response.
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { resolveMeasurementSummaryForPeriod, type UsageMeasurementFact } from '@/lib/usage-measurement-summary'
import { unwrapEmbedded } from '@/lib/postgrest-helpers'
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

  const terms = unwrapEmbedded(job.contract_terms as unknown as ContractTerms | ContractTerms[])
  const customerId = job.billing_customer_id as string | null

  const { data: rows } = await supabaseServer
    .from('planned_invoices')
    .select('id, period_start, period_end, status')
    .eq('job_id', jobId)
    .eq('invoice_type', 'period')
    .order('period_start', { ascending: true })

  if (!rows || rows.length === 0 || !customerId || !terms) {
    return NextResponse.json({ periods: [] })
  }

  const today = new Date().toISOString().slice(0, 10)
  const asOf = new Date()

  const periods = await Promise.all(rows.map(async (row, i) => {
    const periodStart = row.period_start as string
    const periodEnd   = row.period_end as string
    const nextRow = rows[i + 1] ?? null

    let status: PeriodStatus
    if (today < periodStart) status = 'future'
    else if (today <= periodEnd) status = 'current'
    else if (nextRow && (nextRow.status === 'sent' || nextRow.status === 'paid')) status = 'past'
    else status = 'pending'

    // Items 8/9 — never measure a future window, never re-poll a closed
    // (past) one. Only 'current'/'pending' ever call the measurement path.
    if (status !== 'current' && status !== 'pending') return null

    const measurements: UsageMeasurementFact[] = await resolveMeasurementSummaryForPeriod({
      orgId: org.orgId, jobId, terms, customerId,
      periodStart, periodEnd, asOf,
      preferClosedPeriodSnapshot: status === 'pending',
    }).catch(() => [])

    return { periodStart, periodEnd, status, measurements }
  }))

  return NextResponse.json({ periods: periods.filter((p): p is NonNullable<typeof p> => p !== null) })
}
