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
import { computePerUnitFeeLineItemsForPeriod } from '@/lib/per-unit-fee-pull'
import { isPartialWindow } from '@/lib/tariff'
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
    // Confirmed minimum commitments a future period will eventually enforce
    // — a cheap, static read of the current contract model (no live usage
    // pull; the period hasn't started, so there's nothing to measure yet).
    // Lets the timeline show a mode-accurate note ("Additive fee: X", not a
    // blanket "Minimum floor: X" regardless of actual mode) for a metric
    // ahead of time, instead of only the generic "will be measured" message
    // that gave no hint a commercial rule was already confirmed.
    let pendingMinimums: Array<{
      meter_key: string
      amount: number
      currency: string
      mode: string
      // The metric's own cadence — drives the "Partial-month/quarter/year
      // treatment" label client-side instead of a hardcoded "quarter".
      period: string | null
      // null when the commitment isn't calendar-anchored (contract_start
      // anchoring never produces a partial window, so there's nothing to
      // confirm); otherwise whether this specific period is a partial one
      // and, if so, whether proration has actually been decided yet.
      partialPeriod: { isPartial: boolean; needsConfirmation: boolean; prorated: boolean } | null
    }> = []

    if (status === 'past' && nextRow) {
      overageItems = (nextRow.overage_line_items ?? []) as OverageLineItem[]
    } else if ((status === 'current' || status === 'pending') && customerId && terms) {
      // Live read-only preview — same computation the real cron will run.
      // 'current': usage-so-far, cycle still open — always a fresh live
      // read (item B's explicit "Active period → live/fresh preview";
      // unchanged from before). 'pending': the cycle has closed so this is
      // the final figure, just not actually invoiced yet — Step 17F.2,
      // item B: PREFERS an already-finalized resolved_usage_period_
      // snapshots row (real billing close may have already run for this
      // exact window even though the invoice itself hasn't been sent) over
      // a fresh live pull, so a source value that drifted AFTER close
      // never makes this display disagree with what was actually billed.
      // Falls through to the identical fresh-pull behavior when nothing is
      // pinned yet (billing close hasn't run) — never a behavior change
      // for 'current', and never for 'pending' either until a snapshot
      // genuinely exists.
      const preferClosedPeriodSnapshot = status === 'pending'
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
        // billingAsOfUnix is required on every call now, but the real-
        // billing closure check it governs is skipped whenever
        // livePreviewAsOfUnix is also set (preview mode) — same value,
        // captured once, satisfies the type without changing this route's
        // existing preview behavior at all.
        billingAsOfUnix:     Math.floor(Date.now() / 1000),
        livePreviewAsOfUnix: Math.floor(Date.now() / 1000),
        preferClosedPeriodSnapshot,
      }).catch(() => [])
      // Step 17D.1, item J — the newly-executable per-unit fee (e.g. the
      // €0.38 request fee) gets the SAME live-preview treatment as
      // overage: a fresh, non-durable read for 'current' (finalize
      // omitted/false — never pins resolved_usage_period_snapshots from a
      // preview request); for 'pending', the SAME preferClosedPeriodSnapshot
      // preference as overage above, concatenated into the same
      // OverageLineItem list this screen already renders.
      overageItems = overageItems.concat(
        await computePerUnitFeeLineItemsForPeriod({
          jobId, orgId: org.orgId, terms, currency: row.currency ?? terms.currency ?? 'EUR',
          periodStart, periodEnd, includeZeroAmount: true, preferClosedPeriodSnapshot,
        }).catch(() => []),
      )
    } else if (status === 'future' && terms) {
      const seen = new Set<string>()
      const contractStart = terms.contract_start_date ? new Date(terms.contract_start_date + 'T00:00:00') : null
      const contractEnd   = terms.contract_end_date   ? new Date(terms.contract_end_date   + 'T00:00:00') : null
      pendingMinimums = (terms.overage_tiers ?? [])
        .filter(t => t.unit_type && t.minimum_commitment && !t.minimum_commitment.requires_confirmation && !seen.has(t.unit_type) && seen.add(t.unit_type))
        .map(t => {
          const mc = t.minimum_commitment!
          const isCalendarAnchored = t.reset_anchor === 'calendar'
          const window = { start: new Date(periodStart + 'T00:00:00'), end: new Date(periodEnd + 'T00:00:00') }
          const isPartial = isCalendarAnchored && isPartialWindow(window, contractStart, contractEnd)
          return {
            meter_key: t.unit_type!,
            amount: mc.amount,
            currency: row.currency ?? terms.currency ?? 'EUR',
            mode: mc.mode,
            period: t.measurement_period ?? null,
            partialPeriod: isPartial
              ? { isPartial: true, needsConfirmation: mc.prorate_partial_periods === 'unclear', prorated: mc.prorate_partial_periods === true }
              : null,
          }
        })
    }

    return {
      id:           row.id,
      periodStart,
      periodEnd,
      status,
      currency:     row.currency,
      overageItems,
      overageTotal: overageItems.reduce((s, i) => s + i.amount, 0),
      pendingMinimums,
    }
  }))

  // A meter's live "so far" figure is computed from the cadence window
  // containing *today*, independent of which invoice row triggered the
  // pull — so once a meter's cadence outlasts the invoice cadence (a
  // quarterly-measured metric inside monthly invoice rows), every invoice
  // row still open within that same quarter recomputes the exact same
  // figure. Collapse consecutive rows whose overageItems are identical
  // (same meters, same measured windows) into one displayed row, and show
  // that shared window's own dates instead of whichever invoice period
  // happened to trigger it first — otherwise the same number renders
  // several times under different, misleadingly short-looking date ranges.
  const windowKey = (items: OverageLineItem[]) =>
    items.length === 0 ? null : items.map(it => `${it.meter_key}:${it.windowStart ?? ''}:${it.windowEnd ?? ''}`).sort().join('|')

  const merged: typeof periods = []
  for (const p of periods) {
    const key  = windowKey(p.overageItems)
    const prev = merged[merged.length - 1]
    if (key && prev && key === windowKey(prev.overageItems)) {
      prev.status = p.status // prefer the later row's framing (closer to "now")
      continue
    }
    merged.push(p)
  }
  for (const p of merged) {
    const starts = new Set(p.overageItems.map(it => it.windowStart).filter(Boolean))
    const ends   = new Set(p.overageItems.map(it => it.windowEnd).filter(Boolean))
    if (starts.size === 1 && ends.size === 1) {
      p.periodStart = [...starts][0] as string
      p.periodEnd   = [...ends][0] as string
    }
  }

  return NextResponse.json({ periods: merged })
}
