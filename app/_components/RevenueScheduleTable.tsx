'use client'

import { Fragment } from 'react'

// ── Narrow prop types (structurally compatible with both configure page and
//   RevenueModelTab — only the fields this component actually needs) ──────────

interface ScheduleTerms {
  contract_start_date?: string
  contract_end_date?: string
  base_monthly_fee?: number
  base_annual_fee?: number
  year_pricing?: Record<string, number>
  ramp_schedule?: { start_date: string; end_date: string; monthly_fee: number; label?: string }[]
  escalators?: { escalator_pct?: number; effective_date?: string }[]
  discounts?:  { discount_pct?: number; start_date?: string; end_date?: string }[]
  one_time_fees?: { fee_label: string; amount: number; due_date?: string | null }[]
}
interface ScheduleItem {
  product_name: string
  total_amount: number
  billing_period: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseLD(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1)
}

function fmt(n: number, cur = 'EUR', compact = false): string {
  if (compact) {
    const sym = cur === 'EUR' ? '€' : cur === 'GBP' ? '£' : cur === 'USD' ? '$' : cur + ' '
    if (Math.abs(n) >= 1_000_000) return `${sym}${(n / 1_000_000).toFixed(1)}M`
    if (Math.abs(n) >= 1_000)     return `${sym}${(n / 1_000).toFixed(1)}k`
    return `${sym}${n.toFixed(0)}`
  }
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(n)
}

function smy(d: Date): string {
  return d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })
}

// ── Component ──────────────────────────────────────────────────────────────────

export function RevenueScheduleTable({
  terms,
  items,
  cur,
}: {
  terms: ScheduleTerms
  items: ScheduleItem[]
  cur: string
}) {
  if (!terms.contract_start_date || !terms.contract_end_date) return null

  const start       = parseLD(terms.contract_start_date)
  const end         = parseLD(terms.contract_end_date)
  const yearPricing  = terms.year_pricing
  const rampSchedule = terms.ramp_schedule && terms.ramp_schedule.length > 0 ? terms.ramp_schedule : null
  const baseMonthly  = terms.base_monthly_fee ?? (terms.base_annual_fee ? terms.base_annual_fee / 12 : 0)
  const discounts    = terms.discounts  ?? []
  const escalators   = terms.escalators ?? []
  const escPct       = escalators[0]?.escalator_pct ?? 0

  function monthlyBaseFor(monthIdx: number, date: Date): number {
    if (rampSchedule) {
      for (const step of rampSchedule) {
        const stepStart = parseLD(step.start_date)
        const stepEnd   = parseLD(step.end_date)
        if (date >= stepStart && date <= stepEnd) return step.monthly_fee
      }
      return rampSchedule[rampSchedule.length - 1].monthly_fee
    }
    if (yearPricing) {
      const yearNum = Math.floor(monthIdx / 12) + 1
      const key = `year${yearNum}`
      const annual = yearPricing[key] ?? yearPricing[`year${Object.keys(yearPricing).length}`] ?? (terms.base_annual_fee ?? 0)
      return annual / 12
    }
    return baseMonthly
  }

  // ── Build month-by-month revenue using contract defaults ──────────────────
  type MM = {
    date: Date; sub: number; gross: number
    inDiscount: boolean; discountPct: number
    escalated: boolean; escalationMult: number
  }
  const months: MM[] = []
  let loopIdx = 0
  let cursor = new Date(start.getFullYear(), start.getMonth(), 1)

  while (cursor < end) {
    const md = new Date(cursor)
    const effectiveBase = monthlyBaseFor(loopIdx, md)

    let inDiscount = false, discountPct = 0
    for (const d of discounts) {
      if (!d.start_date || !d.end_date) continue
      if (md >= parseLD(d.start_date) && md <= parseLD(d.end_date)) {
        inDiscount = true; discountPct = d.discount_pct ?? 0; break
      }
    }

    // Escalators are skipped when ramp_schedule is present (rates already baked in)
    let escalated = false, escalationMult = 1
    if (!yearPricing && !rampSchedule) {
      for (const e of escalators) {
        const ed = e.effective_date ? parseLD(e.effective_date) : null
        if (ed && md >= ed) {
          const msSince = (md.getFullYear() - ed.getFullYear()) * 12 + (md.getMonth() - ed.getMonth())
          const yi      = Math.floor(msSince / 12)
          const mult    = Math.pow(1 + escPct / 100, yi + 1)
          escalationMult = mult; escalated = mult > 1; break
        }
      }
    }

    let sub = effectiveBase
    if (!yearPricing && !rampSchedule && escalated) sub = effectiveBase * escalationMult
    const gross = sub  // before discount — used in remarks
    if (inDiscount) sub *= (1 - discountPct / 100)

    months.push({ date: md, sub, gross: inDiscount ? gross : sub, inDiscount, discountPct, escalated, escalationMult })
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
    loopIdx++
  }

  const n          = months.length
  const numBuckets = Math.ceil(n / 12)

  // ── One-time / credit split ───────────────────────────────────────────────
  const oneTimeFromItems = items.filter(i => /one.?time/i.test(i.billing_period))
  const allOneTime = oneTimeFromItems.length > 0
    ? oneTimeFromItems.map(i => ({ label: i.product_name, amount: i.total_amount }))
    : (terms.one_time_fees ?? []).map(f => ({ label: f.fee_label, amount: f.amount ?? 0 }))
  const posOneTime  = allOneTime.filter(ot => ot.amount > 0)
  const oneTimeFees = posOneTime.reduce((s, ot) => s + ot.amount, 0)

  const creditSchedule = (terms.one_time_fees ?? []).filter(f => (f.amount ?? 0) < 0 && f.due_date)
  const creditsByYearIdx = new Map<number, number>()
  let unscheduledCredit = (terms.one_time_fees ?? [])
    .filter(f => (f.amount ?? 0) < 0 && !f.due_date)
    .reduce((s, f) => s + (f.amount ?? 0), 0)

  creditSchedule.forEach(f => {
    const d  = parseLD(f.due_date!)
    const mi = months.findIndex(m => m.date.getFullYear() === d.getFullYear() && m.date.getMonth() === d.getMonth())
    if (mi >= 0) {
      const yi = Math.floor(mi / 12)
      creditsByYearIdx.set(yi, (creditsByYearIdx.get(yi) ?? 0) + (f.amount ?? 0))
    } else {
      unscheduledCredit += (f.amount ?? 0)
    }
  })

  const creditTotal = (terms.one_time_fees ?? [])
    .filter(f => (f.amount ?? 0) < 0)
    .reduce((s, f) => s + (f.amount ?? 0), 0)

  // ── Annual buckets ────────────────────────────────────────────────────────
  const annualBuckets = Array.from({ length: numBuckets }, (_, yi) => {
    const slice = months.slice(yi * 12, yi * 12 + 12)
    const gross = slice.reduce((s, m) => s + m.sub, 0)
    const yc    = (creditsByYearIdx.get(yi) ?? 0) + (yi === numBuckets - 1 ? unscheduledCredit : 0)
    return {
      label: `Year ${yi + 1}`,
      dateRange: `${smy(slice[0].date)} – ${smy(slice[slice.length - 1].date)}`,
      total: gross + yc,
      creditNetted: yc,
    }
  })

  const totalTcv = months.reduce((s, m) => s + m.sub, 0) + oneTimeFees + creditTotal

  // ── Segment detection within each year ───────────────────────────────────
  type Seg = {
    from: Date; to: Date; months: number; rate: number; gross: number; subtotal: number
    inDiscount: boolean; discountPct: number; escalated: boolean; escalationMult: number
  }
  const yearSegs: Seg[][] = []
  for (let yi = 0; yi < numBuckets; yi++) {
    const slice = months.slice(yi * 12, yi * 12 + 12)
    const segs: Seg[] = []
    let ss = 0
    for (let i = 1; i <= slice.length; i++) {
      const prev = slice[i - 1]
      const curr = i < slice.length ? slice[i] : null
      const changed = !curr
        || Math.abs(curr.sub - prev.sub) > 0.5
        || curr.inDiscount !== prev.inDiscount
        || curr.escalated  !== prev.escalated
      if (changed) {
        const seg = slice.slice(ss, i)
        segs.push({
          from: seg[0].date, to: seg[seg.length - 1].date,
          months: seg.length, rate: prev.sub, gross: prev.gross, subtotal: prev.sub * seg.length,
          inDiscount: prev.inDiscount, discountPct: prev.discountPct,
          escalated: prev.escalated, escalationMult: prev.escalationMult,
        })
        ss = i
      }
    }
    yearSegs.push(segs)
  }

  let rampCtr = 0
  const segLabels: string[][] = yearSegs.map(segs =>
    segs.map(p => {
      if (rampSchedule) { rampCtr++; return `Ramp ${rampCtr}` }
      if (p.inDiscount) return 'Discounted rate'
      if (p.escalated)  return 'Escalated rate'
      return 'Base rate'
    })
  )

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse" style={{ minWidth: 820 }}>
        <colgroup>
          <col style={{ width: '20%' }} />
          <col style={{ width: '13%' }} />
          <col style={{ width: '12%' }} />
          <col style={{ width: '7%' }} />
          <col style={{ width: '13%' }} />
          <col />
        </colgroup>
        <thead>
          <tr style={{ borderBottom: '1.5px solid #C5DECA' }}>
            {(['Component', 'Period', 'Rate / mo', 'Months', 'Amount', 'Remarks'] as const).map((h, i) => (
              <th
                key={h}
                className={`pb-3 text-[10px] font-bold uppercase tracking-[0.1em] text-stone ${i === 3 ? 'text-center' : i >= 2 && i <= 4 ? 'text-right' : 'text-left'} ${i < 5 ? 'pr-5' : ''}`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {annualBuckets.map((b, yi) => {
            const segs   = yearSegs[yi]   ?? []
            const labels = segLabels[yi]  ?? []
            const creditsThisYear = creditSchedule.filter(f => {
              const d  = parseLD(f.due_date!)
              const mi = months.findIndex(m => m.date.getFullYear() === d.getFullYear() && m.date.getMonth() === d.getMonth())
              return mi >= 0 && Math.floor(mi / 12) === yi
            })
            return (
              <Fragment key={`y${yi}`}>
                {/* Year header */}
                <tr style={{ background: '#EAF3DE', borderTop: yi > 0 ? '1.5px solid #C5DECA' : undefined }}>
                  <td className="pr-5 py-3" style={{ paddingLeft: 14 }}>
                    <span className="font-bold text-[13px]" style={{ color: '#1A3D2B' }}>{b.label}</span>
                  </td>
                  <td className="py-3 pr-5 text-[11px] font-medium" style={{ color: '#4A7C59' }}>{b.dateRange}</td>
                  <td /><td />
                  <td className="py-3 pr-5 text-right font-bold text-[13px]" style={{ color: '#1A3D2B' }}>
                    {fmt(b.total, cur)}
                  </td>
                  <td className="py-3 text-[10px]" style={{ color: '#4A7C59' }}>
                    {b.creditNetted < 0 ? `Net of ${fmt(b.creditNetted, cur)} credit · ` : ''}
                    {segs.length > 1 ? `${segs.length} pricing segments` : 'Single pricing period'}
                  </td>
                </tr>

                {/* Segment rows */}
                {segs.map((p, pi) => {
                  const lbl = labels[pi] ?? `Period ${pi + 1}`
                  let remark: string
                  if (rampSchedule && p.inDiscount)
                    remark = `${p.discountPct}% discount · gross ${fmt(p.gross, cur)}/mo → net ${fmt(p.rate, cur)}/mo`
                  else if (rampSchedule)
                    remark = `Ramp rate ${fmt(p.rate, cur)}/mo`
                  else if (p.inDiscount && p.escalated)
                    remark = `${p.discountPct}% discount + price escalator (×${p.escalationMult.toFixed(4)})`
                  else if (p.inDiscount)
                    remark = `${p.discountPct}% introductory discount · gross ${fmt(baseMonthly || p.gross, cur)}/mo → net ${fmt(p.rate, cur)}/mo`
                  else if (p.escalated)
                    remark = `Price escalator · ×${p.escalationMult.toFixed(4)} cumulative (Year ${yi + 1})`
                  else
                    remark = 'Base subscription rate'
                  return (
                    <tr key={`y${yi}s${pi}`} style={{ borderBottom: '1px solid #EFF1EE', background: 'white' }}>
                      <td className="py-2.5 pr-5 text-[11px]" style={{ paddingLeft: 28, color: '#3A3A38' }}>{lbl}</td>
                      <td className="py-2.5 pr-5 text-[11px]" style={{ color: '#6B6660' }}>
                        {smy(p.from)}&thinsp;–&thinsp;{smy(p.to)}
                      </td>
                      <td className="py-2.5 pr-5 text-right text-[11px] font-medium tabular-nums" style={{ color: '#3A3A38' }}>
                        {fmt(p.rate, cur)}
                      </td>
                      <td className="py-2.5 pr-5 text-center text-[11px]" style={{ color: '#6B6660' }}>{p.months}</td>
                      <td className="py-2.5 pr-5 text-right text-[11px] font-medium tabular-nums" style={{ color: '#3A3A38' }}>
                        {fmt(p.subtotal, cur)}
                      </td>
                      <td className="py-2.5 text-[11px]" style={{ color: '#9CA3AF' }}>{remark}</td>
                    </tr>
                  )
                })}

                {/* Credit rows */}
                {creditsThisYear.map((f, ci) => (
                  <tr key={`y${yi}c${ci}`} style={{ background: '#FFFBEB', borderBottom: '1px solid #FDE68A' }}>
                    <td className="py-2.5 pr-5 text-[11px] font-medium" style={{ paddingLeft: 28, color: '#92400E' }}>
                      {f.fee_label}
                    </td>
                    <td className="py-2.5 pr-5 text-[11px]" style={{ color: '#B45309' }}>
                      {smy(parseLD(f.due_date!))}
                    </td>
                    <td className="py-2.5 pr-5 text-right text-[11px]" style={{ color: '#D1D5DB' }}>—</td>
                    <td className="py-2.5 pr-5 text-center text-[11px]" style={{ color: '#D1D5DB' }}>—</td>
                    <td className="py-2.5 pr-5 text-right text-[11px] font-medium tabular-nums" style={{ color: '#B45309' }}>
                      {fmt(f.amount ?? 0, cur)}
                    </td>
                    <td className="py-2.5 text-[11px]" style={{ color: '#B45309' }}>
                      Credit / grant — not a billed charge; recorded as one-time fee for TCV completeness
                    </td>
                  </tr>
                ))}
              </Fragment>
            )
          })}

          {/* Positive one-time fees */}
          {posOneTime.length > 0 && (
            <Fragment key="onetimes">
              <tr style={{ background: '#FAFAF8', borderTop: '1.5px solid #C5DECA' }}>
                <td className="py-3 pr-5 font-bold text-[12px]" style={{ paddingLeft: 14, color: '#3A3A38' }}>
                  One-time fees
                </td>
                <td /><td /><td />
                <td className="py-3 pr-5 text-right font-bold text-[12px]" style={{ color: '#3A3A38' }}>
                  {fmt(oneTimeFees, cur)}
                </td>
                <td />
              </tr>
              {posOneTime.map((ot, i) => {
                const feeDate = (terms.one_time_fees ?? []).find(
                  f => f.fee_label === ot.label && (f.amount ?? 0) > 0
                )?.due_date
                return (
                  <tr key={`ot${i}`} style={{ borderBottom: '1px solid #EFF1EE', background: 'white' }}>
                    <td className="py-2.5 pr-5 text-[11px]" style={{ paddingLeft: 28, color: '#3A3A38' }}>{ot.label}</td>
                    <td className="py-2.5 pr-5 text-[11px]" style={{ color: '#6B6660' }}>
                      {feeDate ? smy(parseLD(feeDate)) : '—'}
                    </td>
                    <td className="py-2.5 pr-5 text-right text-[11px]" style={{ color: '#D1D5DB' }}>—</td>
                    <td className="py-2.5 pr-5 text-center text-[11px]" style={{ color: '#D1D5DB' }}>—</td>
                    <td className="py-2.5 pr-5 text-right text-[11px] font-medium tabular-nums" style={{ color: '#3A3A38' }}>
                      {fmt(ot.amount, cur)}
                    </td>
                    <td className="py-2.5 text-[11px]" style={{ color: '#9CA3AF' }}>One-time fee</td>
                  </tr>
                )
              })}
            </Fragment>
          )}

          {/* Net TCV */}
          <tr style={{ background: '#1A3D2B', borderTop: '2px solid #0F2D1A' }}>
            <td className="py-4 pr-5 font-bold text-[13px] text-white" style={{ paddingLeft: 14 }} colSpan={4}>
              Net TCV
            </td>
            <td className="py-4 pr-5 text-right font-bold text-[14px] text-white tabular-nums">
              {fmt(totalTcv, cur)}
            </td>
            <td className="py-4 text-[11px]" style={{ color: 'rgba(255,255,255,0.5)' }}>
              Total net contract value · all discounts and credits applied
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}
