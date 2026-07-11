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
  escalators?: { escalator_pct?: number; effective_date?: string; description?: string }[]
  discounts?:  { discount_pct?: number; discount_type?: string; description?: string; start_date?: string; end_date?: string }[]
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
    inDiscount: boolean; discountPct: number; discountName: string
    escalated: boolean; escalationMult: number; escalatorDesc: string
  }
  const months: MM[] = []
  let loopIdx = 0
  let cursor = new Date(start.getFullYear(), start.getMonth(), 1)

  while (cursor < end) {
    const md = new Date(cursor)
    const effectiveBase = monthlyBaseFor(loopIdx, md)

    let inDiscount = false, discountPct = 0, discountName = ''
    for (const d of discounts) {
      if (!d.start_date || !d.end_date) continue
      if (md >= parseLD(d.start_date) && md <= parseLD(d.end_date)) {
        inDiscount   = true
        discountPct  = d.discount_pct ?? 0
        // Prefer the human-readable description; fall back to the type label
        discountName = d.description || d.discount_type || ''
        break
      }
    }

    // Escalators are skipped when ramp_schedule is present (rates already baked in)
    let escalated = false, escalationMult = 1, escalatorDesc = ''
    if (!yearPricing && !rampSchedule) {
      for (const e of escalators) {
        const ed = e.effective_date ? parseLD(e.effective_date) : null
        if (ed && md >= ed) {
          const msSince = (md.getFullYear() - ed.getFullYear()) * 12 + (md.getMonth() - ed.getMonth())
          const yi      = Math.floor(msSince / 12)
          const mult    = Math.pow(1 + escPct / 100, yi + 1)
          escalationMult = mult; escalated = mult > 1
          escalatorDesc  = e.description || ''
          break
        }
      }
    }

    let sub = effectiveBase
    if (!yearPricing && !rampSchedule && escalated) sub = effectiveBase * escalationMult
    const gross = sub  // before discount — used in remarks
    if (inDiscount) sub *= (1 - discountPct / 100)

    months.push({ date: md, sub, gross: inDiscount ? gross : sub, inDiscount, discountPct, discountName, escalated, escalationMult, escalatorDesc })
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
    loopIdx++
  }

  const n             = months.length
  const numBuckets    = Math.ceil(n / 12)
  const isYearPricing = !!yearPricing   // billing model: fixed annual prices per year
  const isRampBilling = !!rampSchedule  // billing model: step-ramp monthly fees

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
    inDiscount: boolean; discountPct: number; discountName: string
    escalated: boolean; escalationMult: number; escalatorDesc: string
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
          inDiscount: prev.inDiscount, discountPct: prev.discountPct, discountName: prev.discountName,
          escalated: prev.escalated, escalationMult: prev.escalationMult, escalatorDesc: prev.escalatorDesc,
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

  // ── Cumulative recurring totals per year (for derivation remarks) ─────────
  const cumByYear = annualBuckets.reduce<number[]>((acc, b) => {
    acc.push((acc[acc.length - 1] ?? 0) + b.total)
    return acc
  }, [])

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
            {(['Component', 'Period', isYearPricing ? 'Rate / yr' : 'Rate / mo', isYearPricing ? 'Years' : 'Months', 'Amount', 'Remarks'] as const).map((h, i) => (
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
                    {(() => {
                      const creditNote = b.creditNetted < 0 ? `Net of ${fmt(b.creditNetted, cur)} credit · ` : ''
                      if (segs.length > 1) return `${creditNote}${segs.length} pricing segments`
                      if (isYearPricing) {
                        // Show the running sum of independent year values clearly
                        const parts = annualBuckets.slice(0, yi + 1).map((ab, i) => `Year ${i + 1} (${fmt(ab.total, cur)})`)
                        const sum   = fmt(cumByYear[yi], cur)
                        if (yi === 0) return `${creditNote}${parts[0]} = ${sum} · standalone year price`
                        return `${creditNote}${parts.join(' + ')} = ${sum} total to date`
                      }
                      return `${creditNote}Single pricing period`
                    })()}
                  </td>
                </tr>

                {/* Segment rows */}
                {segs.map((p, pi) => {
                  const lbl = labels[pi] ?? `Period ${pi + 1}`

                  // For year_pricing: show annual rate; for all others: show monthly rate
                  const displayRate  = isYearPricing ? p.rate * 12 : p.rate
                  const displayUnits = isYearPricing ? 1 : p.months          // 1 year vs N months
                  const grossRate    = isYearPricing ? p.gross * 12 : p.gross // pre-discount gross
                  const grossTotal   = p.gross * p.months                      // always in same unit
                  const discountAmt  = p.subtotal - grossTotal                 // negative when discounted

                  // ── Situation-specific arithmetic remark ──────────────────
                  // Human-readable discount label (name from contract, or fallback)
                  const dLabel = p.discountName
                    ? `"${p.discountName}"`
                    : `${p.discountPct}% discount`
                  const eLabel = p.escalatorDesc ? `"${p.escalatorDesc}"` : 'price escalator'

                  let baseRemark: string
                  if (isYearPricing && !p.inDiscount && !p.escalated) {
                    if (yi === 0) {
                      baseRemark = `Base price Year 1: ${fmt(displayRate, cur)}/yr — set in contract pricing schedule`
                    } else {
                      const prevAnnual = annualBuckets[yi - 1].total
                      const delta      = displayRate - prevAnnual
                      const deltaPct   = ((delta / prevAnnual) * 100).toFixed(0)
                      baseRemark = `Base price Year ${yi + 1}: ${fmt(displayRate, cur)}/yr — ${delta > 0 ? 'up' : 'down'} ${fmt(Math.abs(delta), cur)} (${delta > 0 ? '+' : ''}${deltaPct}%) from Year ${yi} base (${fmt(prevAnnual, cur)})`
                    }
                  } else if (isYearPricing && p.inDiscount) {
                    baseRemark = `Base price Year ${yi + 1}: ${fmt(grossRate, cur)}/yr — ${dLabel} applied below`
                  } else if (p.inDiscount && p.escalated) {
                    const baseMonthlyGross = p.gross / p.escalationMult
                    baseRemark = `Base ${fmt(baseMonthlyGross, cur)}/mo × ${eLabel} ×${p.escalationMult.toFixed(3)} = ${fmt(p.gross, cur)}/mo gross (before ${dLabel})`
                  } else if (p.inDiscount) {
                    baseRemark = `Base price: ${fmt(grossRate, cur)}/${isYearPricing ? 'yr' : 'mo'} — ${dLabel} applied below`
                  } else if (p.escalated) {
                    baseRemark = `Base ${fmt(baseMonthly, cur)}/mo × ${eLabel} ×${p.escalationMult.toFixed(3)} = ${fmt(p.rate, cur)}/mo (Year ${yi + 1} cumulative)`
                  } else if (isRampBilling) {
                    baseRemark = `Ramp ${pi + 1} rate from contract schedule`
                  } else {
                    baseRemark = 'Base subscription rate from contract'
                  }

                  return (
                    <Fragment key={`y${yi}s${pi}`}>
                      {/* Base / gross rate row */}
                      <tr style={{ borderBottom: p.inDiscount ? undefined : '1px solid #EFF1EE', background: 'white' }}>
                        <td className="py-2.5 pr-5 text-[11px]" style={{ paddingLeft: 28, color: '#3A3A38' }}>
                          {p.inDiscount ? `${lbl} (gross)` : lbl}
                        </td>
                        <td className="py-2.5 pr-5 text-[11px]" style={{ color: '#6B6660' }}>
                          {smy(p.from)}&thinsp;–&thinsp;{smy(p.to)}
                        </td>
                        <td className="py-2.5 pr-5 text-right text-[11px] font-medium tabular-nums" style={{ color: '#3A3A38' }}>
                          {fmt(p.inDiscount ? grossRate : displayRate, cur)}
                        </td>
                        <td className="py-2.5 pr-5 text-center text-[11px]" style={{ color: '#6B6660' }}>
                          {p.inDiscount ? p.months : displayUnits}
                        </td>
                        <td className="py-2.5 pr-5 text-right text-[11px] font-medium tabular-nums" style={{ color: '#3A3A38' }}>
                          {fmt(p.inDiscount ? grossTotal : p.subtotal, cur)}
                        </td>
                        <td className="py-2.5 text-[11px]" style={{ color: '#9CA3AF' }}>{baseRemark}</td>
                      </tr>

                      {/* Discount breakdown row — only when a discount applies */}
                      {p.inDiscount && (
                        <tr style={{ borderBottom: '1px solid #EFF1EE', background: '#FFFDF5' }}>
                          <td className="py-2 pr-5 text-[11px] font-medium" style={{ paddingLeft: 28, color: '#B45309' }}>
                            {p.discountName ? `Less ${p.discountPct}% — ${p.discountName}` : `Less ${p.discountPct}% discount`}
                          </td>
                          <td className="py-2 pr-5 text-[11px]" style={{ color: '#B45309' }}>
                            {smy(p.from)}&thinsp;–&thinsp;{smy(p.to)}
                          </td>
                          <td className="py-2 pr-5 text-right text-[11px] font-medium tabular-nums" style={{ color: '#B45309' }}>
                            -{fmt(Math.abs(isYearPricing ? (grossRate - displayRate) : (p.gross - p.rate)), cur)}
                          </td>
                          <td className="py-2 pr-5 text-center text-[11px]" style={{ color: '#B45309' }}>
                            {p.months}
                          </td>
                          <td className="py-2 pr-5 text-right text-[11px] font-medium tabular-nums" style={{ color: '#B45309' }}>
                            -{fmt(Math.abs(discountAmt), cur)}
                          </td>
                          <td className="py-2 text-[11px]" style={{ color: '#B45309' }}>
                            Base ({fmt(grossRate, cur)}) × {p.discountPct}% = {fmt(Math.abs(isYearPricing ? grossRate - displayRate : p.gross - p.rate), cur)} saving → net {fmt(displayRate, cur)}/{isYearPricing ? 'yr' : 'mo'}
                          </td>
                        </tr>
                      )}
                    </Fragment>
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
                    <td className="py-2.5 text-[11px]" style={{ color: '#9CA3AF' }}>
                      One-time fee · not recurring · adds {fmt(ot.amount, cur)} to TCV
                    </td>
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
              {(() => {
                const recurringTotal = months.reduce((s, m) => s + m.sub, 0) + creditTotal
                if (isYearPricing) {
                  const yearParts = annualBuckets.map((ab, i) => `Year ${i + 1} (${fmt(ab.total, cur)})`).join(' + ')
                  if (oneTimeFees > 0)
                    return `${yearParts} = ${fmt(recurringTotal, cur)} recurring + one-time fees (${fmt(oneTimeFees, cur)}) = ${fmt(totalTcv, cur)} Net TCV`
                  return `${yearParts} = ${fmt(totalTcv, cur)} Net TCV`
                }
                if (oneTimeFees > 0)
                  return `Recurring subscription (${fmt(recurringTotal, cur)}) + one-time fees (${fmt(oneTimeFees, cur)}) = ${fmt(totalTcv, cur)}`
                return 'Total net contract value · all discounts and credits applied'
              })()}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}
