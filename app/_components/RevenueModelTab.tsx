'use client'

import { useState, useEffect } from 'react'
import { computeUserOverage, computeMetricOverage } from '@/lib/tariff'
import type { OverageTier } from '@/lib/types'

// ── Types ─────────────────────────────────────────────────────────────────────

type Escalator = { escalator_pct?: number; effective_date?: string; escalator_type?: string; cap_pct?: number; description?: string }
type Discount  = { discount_pct?: number; start_date?: string; end_date?: string }
type Tier      = { tier_label?: string; from_unit?: number; to_unit?: number; rate_per_unit?: number; unit_type?: string }
type OneTimeFee = { fee_label: string; amount: number; due_date?: string | null; description?: string | null }
type RampStep = { start_date: string; end_date: string; monthly_fee: number; label?: string }
type Terms = {
  contract_start_date?: string; contract_end_date?: string; contract_term_months?: number
  base_monthly_fee?: number; base_annual_fee?: number; billing_frequency?: string; currency?: string
  included_units?: number; included_unit_type?: string
  year_pricing?: Record<string, number>
  ramp_schedule?: RampStep[]
  escalators?: Escalator[]; discounts?: Discount[]; overage_tiers?: Tier[]
  one_time_fees?: OneTimeFee[]
  renewal_notice_days?: number
}
type LineItem = { id: string; product_name: string; total_amount: number; billing_period: string }
type BillingInv = {
  id: string; number?: string | null; status?: string | null
  amount: number; currency: string; dueDate?: string | null; created: string
  hostedUrl?: string | null; feeLabel?: string | null; yearNum?: number | null; scheduledDate?: string | null
}
type StripeBillingData = {
  subscription: { id: string; status: string; dashboardUrl: string } | null
  invoices: BillingInv[]
  annualDraftInvoices: BillingInv[]
  oneTimeInvoices: BillingInv[]
  paymentSchedule: { year: number; amount: number; currency: string; periodStart: string | null; periodEnd: string | null }[] | null
  oneTimeFees: { fee_label: string; amount: number; due_date?: string | null }[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseLocalDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1)
}

function fmt(n: number, cur = 'EUR', compact = false): string {
  if (compact) {
    const sym = cur === 'EUR' ? '€' : cur === 'GBP' ? '£' : cur === 'USD' ? '$' : cur + ' '
    if (Math.abs(n) >= 1_000_000) return `${sym}${(n / 1_000_000).toFixed(0)}M`
    if (Math.abs(n) >= 1_000)     return `${sym}${(n / 1_000).toFixed(0)}k`
    return `${sym}${n.toFixed(0)}`
  }
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(n)
}

function shortMonth(d: Date) {
  return d.toLocaleDateString('en-GB', { month: 'short' })
}

function shortMonthYear(d: Date) {
  return d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })
}

// computeUserOverage and computeTransactionalOverage are imported from @/lib/tariff

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  terms: Terms
  items: LineItem[]
  cur: string
  jobId?: string
  onSaved?: () => void
}

export function RevenueModelTab({ terms, items, cur, jobId, onSaved }: Props) {
  const allTiers   = terms.overage_tiers ?? []
  const userTiers  = allTiers.filter(t => t.unit_type?.toLowerCase().includes('user'))
  const apiTiers   = allTiers.filter(t =>
    t.unit_type?.toLowerCase().includes('api') || t.unit_type?.toLowerCase().includes('call'))

  const sortedUserTiers = [...userTiers].sort((a, b) => (a.from_unit ?? 0) - (b.from_unit ?? 0))
  const sortedApiTiers  = [...apiTiers].sort((a, b) => (a.from_unit ?? 0) - (b.from_unit ?? 0))

  // Included seats for users (derived from first user tier's from_unit)
  const includedUsers = sortedUserTiers.length > 0
    ? Math.max(0, (sortedUserTiers[0].from_unit ?? 1) - 1)
    : 0

  // Included units for API/transactional metrics — from tier boundary or explicit field
  const includedApiCalls = sortedApiTiers.length > 0
    ? Math.max(0, (sortedApiTiers[0].from_unit ?? 1) - 1)
    : (terms.included_units ?? 0)

  // Billing period unit for scenario input and overage computation
  const billingFreq        = terms.billing_frequency ?? 'monthly'
  const monthsPerPeriod    = billingFreq === 'annual' ? 12 : billingFreq === 'quarterly' ? 3 : 1
  const apiCallPeriodLabel = billingFreq === 'annual' ? 'year' : billingFreq === 'quarterly' ? 'quarter' : 'month'

  const escalators     = terms.escalators ?? []
  const contractEscPct = escalators[0]?.escalator_pct ?? 0
  const yearPricing    = terms.year_pricing   // e.g. {year1: 54000, year2: 57240, year3: 60675}
  const rampSchedule   = terms.ramp_schedule && terms.ramp_schedule.length > 0 ? terms.ramp_schedule : null
  const baseAnnual     = terms.base_annual_fee ?? 0
  // Flat monthly base: used when there is no per-year pricing or ramp schedule
  const base           = terms.base_monthly_fee ?? (yearPricing || rampSchedule ? 0 : baseAnnual / 12)

  // Returns the effective monthly fee for the given date/month index.
  // Priority: ramp_schedule (by calendar date) → year_pricing (by year index) → flat base.
  function monthlyBaseFor(monthIdx: number, date: Date): number {
    if (rampSchedule) {
      for (const step of rampSchedule) {
        const stepStart = parseLocalDate(step.start_date)
        const stepEnd   = parseLocalDate(step.end_date)
        if (date >= stepStart && date <= stepEnd) return step.monthly_fee
      }
      return rampSchedule[rampSchedule.length - 1].monthly_fee
    }
    if (yearPricing) {
      const yearNum = Math.floor(monthIdx / 12) + 1
      const key = `year${yearNum}`
      const annual = yearPricing[key] ?? yearPricing[`year${Object.keys(yearPricing).length}`] ?? baseAnnual
      return annual / 12
    }
    return base
  }

  // Compute how many annual escalation periods exist between effective_date and contract end
  const effectiveEscDate = escalators[0]?.effective_date ? parseLocalDate(escalators[0].effective_date) : null
  const endForEsc        = terms.contract_end_date ? parseLocalDate(terms.contract_end_date) : null
  const numEscYears = (effectiveEscDate && endForEsc)
    ? Math.max(1, Math.ceil(
        ((endForEsc.getFullYear()  - effectiveEscDate.getFullYear())  * 12 +
         (endForEsc.getMonth()     - effectiveEscDate.getMonth())) / 12))
    : 1

  // ── State ─────────────────────────────────────────────────────────────────

  const [scenarioUsers,    setScenarioUsers]    = useState(() => includedUsers)
  const [scenarioApiCalls, setScenarioApiCalls] = useState(0)

  // Overage per billing period — hoisted so JSX can reference it
  // (recomputed from state below, before the early-return guard)

  const [applyEscalator,   setApplyEscalator]   = useState(true)
  const [applyDiscount,    setApplyDiscount]    = useState(true)
  // One entry per annual escalation period (compound, each year × previous year's rate)
  const [escPerYear, setEscPerYear] = useState<number[]>(() =>
    Array.from({ length: numEscYears }, () => contractEscPct))
  const [saving, setSaving] = useState(false)
  const [saved,  setSaved]  = useState(false)

  // Actual billed overage per month — fetched from computed_invoices automatically
  const [actualOvgByMonth, setActualOvgByMonth] = useState<Map<string, number>>(new Map())

  type ActualInvoice = {
    id: string
    period_start: string
    period_end: string
    currency: string
    total_amount: number
    line_items: { type: string; amount: number; description: string; currency: string }[]
  }
  const [actualInvoices, setActualInvoices] = useState<ActualInvoice[]>([])
  const [billingData, setBillingData]         = useState<StripeBillingData | null>(null)
  const [billingLoading, setBillingLoading]   = useState(false)
  const [billingFetchDone, setBillingFetchDone] = useState(false)

  useEffect(() => {
    if (!jobId) return
    fetch(`/api/jobs/${jobId}/actual-overage`)
      .then(r => r.json())
      .then((data: ActualInvoice[]) => {
        if (!Array.isArray(data)) return
        setActualInvoices(data)
        const map = new Map<string, number>()
        for (const inv of data) {
          const ovgAmount = (inv.line_items ?? [])
            .filter(l => l.type === 'overage')
            .reduce((s, l) => s + l.amount, 0)
          if (ovgAmount <= 0) continue
          // Distribute evenly across months in the billing period
          const pStart = new Date(inv.period_start)
          const pEnd   = new Date(inv.period_end)
          const months: string[] = []
          let c = new Date(pStart.getFullYear(), pStart.getMonth(), 1)
          const eom = new Date(pEnd.getFullYear(), pEnd.getMonth(), 1)
          while (c <= eom) {
            months.push(`${c.getFullYear()}-${c.getMonth()}`)
            c = new Date(c.getFullYear(), c.getMonth() + 1, 1)
          }
          const perMonth = months.length > 0 ? ovgAmount / months.length : ovgAmount
          for (const key of months) {
            map.set(key, (map.get(key) ?? 0) + perMonth)
          }
        }
        setActualOvgByMonth(map)
      })
      .catch(() => {/* non-fatal */})
  }, [jobId])

  useEffect(() => {
    if (!jobId) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBillingLoading(true)
    fetch(`/api/jobs/${jobId}/stripe-summary`)
      .then(r => r.ok ? r.json() : null)
      .then((data: StripeBillingData | null) => {
        if (data?.subscription) setBillingData(data)
      })
      .catch(() => {/* non-fatal */})
      .finally(() => { setBillingLoading(false); setBillingFetchDone(true) })
  }, [jobId])

  const start = terms.contract_start_date ? parseLocalDate(terms.contract_start_date) : null
  const end   = terms.contract_end_date   ? parseLocalDate(terms.contract_end_date)   : null

  if (!start || !end) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center max-w-xs">
          <i className="ti ti-calendar-off block mb-3" style={{ fontSize: 32, color: '#D97706' }} />
          <p className="text-sm font-medium text-ink mb-1">Contract dates required</p>
          <p className="text-xs text-stone leading-relaxed">
            {!start && !end ? 'Start and end dates are' : !start ? 'A start date is' : 'An end date is'} missing.
            Go to the <strong>Contract terms</strong> tab and click the date to add it — TCV and this model will calculate automatically.
          </p>
        </div>
      </div>
    )
  }

  const today          = new Date()
  const contractActive = today >= start && today <= end
  const discounts      = terms.discounts ?? []
  const renewalDays    = terms.renewal_notice_days ?? 0

  // ── Save corrected escalator to DB ────────────────────────────────────────

  async function saveEscalatorCorrection() {
    if (!jobId) return
    setSaving(true)
    setSaved(false)
    const newEscalators = escalators.length > 0
      ? escalators.map((e, i) => i === 0 ? { ...e, escalator_pct: escPerYear[0] } : e)
      : [{ escalator_pct: escPerYear[0], escalator_type: 'fixed_pct', effective_date: null, cap_pct: null }]
    try {
      const res = await fetch(`/api/jobs/${jobId}/terms`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ escalators: newEscalators }),
      })
      if (res.ok) { setSaved(true); onSaved?.() }
    } finally {
      setSaving(false)
    }
  }

  // ── Overage amounts (computed once from scenario state) ───────────────────

  // periodApiOvg: overage for one billing period at the scenario API call volume
  const periodApiOvg = computeMetricOverage(scenarioApiCalls, apiTiers as OverageTier[], includedApiCalls)
  // monthly spread of that overage (used in per-month chart bars)
  const monthlyApiOvg = periodApiOvg / monthsPerPeriod

  // ── Build per-month model data ────────────────────────────────────────────

  type ModelMonth = {
    date: Date; sub: number; inDiscount: boolean; escalated: boolean
    discountPct: number; escalationMult: number; userOvg: number; apiOvg: number; total: number; isPast: boolean
  }
  const modelMonths: ModelMonth[] = []
  let cursor = new Date(start.getFullYear(), start.getMonth(), 1)
  const endMonth = new Date(end.getFullYear(), end.getMonth(), 1)
  let loopIdx = 0

  while (cursor <= endMonth) {
    const md = new Date(cursor)
    const effectiveBase = monthlyBaseFor(loopIdx, md)
    let inDiscount = false, discountPct = 0

    for (const d of discounts) {
      const ds = d.start_date ? parseLocalDate(d.start_date) : null
      const de = d.end_date   ? parseLocalDate(d.end_date)   : null
      if (ds && de && md >= ds && md <= de && d.discount_pct) {
        inDiscount = true; discountPct = d.discount_pct; break
      }
    }

    // Compound annual escalation applies only when neither year_pricing nor ramp_schedule
    // is set (those already encode per-period step-ups).
    let escalated = false
    let escalationMult = 1

    if (!yearPricing && !rampSchedule) {
      for (const e of escalators) {
        const ed = e.effective_date ? parseLocalDate(e.effective_date) : null
        if (ed && md >= ed) {
          const monthsSince = (md.getFullYear() - ed.getFullYear()) * 12 + (md.getMonth() - ed.getMonth())
          const yearIdx     = Math.min(Math.floor(monthsSince / 12), escPerYear.length - 1)
          const mult        = escPerYear.slice(0, yearIdx + 1).reduce((p, r) => p * (1 + r / 100), 1)
          if (applyEscalator) { escalationMult = mult; escalated = mult > 1 }
          break
        }
      }
    }

    let sub = effectiveBase
    if (!yearPricing && !rampSchedule && applyEscalator && escalationMult > 1) sub = effectiveBase * escalationMult
    if (inDiscount && applyDiscount) sub *= (1 - discountPct / 100)

    const userOvg = computeUserOverage(scenarioUsers, includedUsers, userTiers)
    const apiOvg  = monthlyApiOvg

    modelMonths.push({
      date: md, sub, inDiscount: inDiscount && applyDiscount,
      escalated, discountPct, escalationMult,
      userOvg, apiOvg, total: sub + userOvg + apiOvg,
      isPast: md <= today,
    })
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
    loopIdx++
  }

  const n = modelMonths.length

  // ── KPI totals ────────────────────────────────────────────────────────────

  const totalSub     = modelMonths.reduce((s, m) => s + m.sub,     0)
  const totalUserOvg = modelMonths.reduce((s, m) => s + m.userOvg, 0)
  const totalApiOvg  = modelMonths.reduce((s, m) => s + m.apiOvg,  0)

  // Split one-time amounts into positive fees and negative credits separately
  const oneTimeFromItems = items.filter(i => /one.?time/i.test(i.billing_period))
  const allOneTime = oneTimeFromItems.length > 0
    ? oneTimeFromItems.map(i => ({ label: i.product_name, amount: i.total_amount }))
    : (terms.one_time_fees ?? []).map(f => ({ label: f.fee_label, amount: f.amount ?? 0 }))
  const posOneTime   = allOneTime.filter(ot => ot.amount > 0)
  const negOneTime   = allOneTime.filter(ot => ot.amount < 0)
  const oneTimeFees  = posOneTime.reduce((s, ot) => s + ot.amount, 0)
  const creditTotal  = negOneTime.reduce((s, ot) => s + ot.amount, 0)   // negative value
  const grossTcv     = totalSub + totalUserOvg + totalApiOvg + oneTimeFees
  const totalTcv     = grossTcv + creditTotal

  // ── Actuals (from computed_invoices) ───────────────────────────────
  const baseBilledToDate = modelMonths.filter(m => m.isPast).reduce((s, m) => s + m.sub, 0)
  const actualOvgTotal   = actualInvoices.reduce((s, inv) =>
    s + (inv.line_items ?? []).filter(l => l.type === 'overage').reduce((ss, l) => ss + l.amount, 0), 0)
  const remaining        = Math.max(0, totalSub - baseBilledToDate)
  const projectedTcv     = totalTcv + actualOvgTotal

  // Invoices that carry at least one overage line — shown in detail cards
  const ovgInvoices = actualInvoices.filter(inv =>
    (inv.line_items ?? []).some(l => l.type === 'overage'))

  const discountSaving = modelMonths.reduce((s, m) => {
    if (!m.inDiscount) return s
    const undiscountedRate = m.escalationMult > 1 ? base * m.escalationMult : base
    return s + (undiscountedRate - m.sub)
  }, 0)
  const escalatorUplift = modelMonths.reduce((s, m) => {
    if (!m.escalated || m.escalationMult <= 1) return s
    const flatBase = m.inDiscount ? base * (1 - m.discountPct / 100) : base
    return s + (m.sub - flatBase)
  }, 0)
  const creditLabels = negOneTime.map(c => c.label).join(' · ')

  // Credit milestones — one entry per one_time_fee with a due_date and negative amount
  const creditSchedule = (terms.one_time_fees ?? []).filter(f => f.amount < 0 && f.due_date)
  const creditByMonth  = new Map<string, number>()
  creditSchedule.forEach(f => {
    const d = parseLocalDate(f.due_date!)
    const key = `${d.getFullYear()}-${d.getMonth()}`
    creditByMonth.set(key, (creditByMonth.get(key) ?? 0) + (f.amount ?? 0))
  })

  // Map each scheduled credit to its year-bucket index so annualBuckets can net it in.
  // Credits whose due_date falls outside the contract period are assigned to the last bucket.
  const creditsByYearIdx = new Map<number, number>()  // yearIdx → total credit amount (negative)
  let unscheduledCredit = creditTotal - creditSchedule.reduce((s, f) => s + (f.amount ?? 0), 0)
  creditSchedule.forEach(f => {
    const d = parseLocalDate(f.due_date!)
    const mi = modelMonths.findIndex(m =>
      m.date.getFullYear() === d.getFullYear() && m.date.getMonth() === d.getMonth()
    )
    const yi = mi >= 0 ? Math.floor(mi / 12) : -1
    if (yi >= 0) {
      creditsByYearIdx.set(yi, (creditsByYearIdx.get(yi) ?? 0) + (f.amount ?? 0))
    } else {
      unscheduledCredit += (f.amount ?? 0)
    }
  })

  // ── Contract timeline layout ──────────────────────────────────────────────
  const TLW = 1100, TLH = 250
  const tlx1 = 80, tlx2 = TLW - 50, tlW = tlx2 - tlx1
  // Chevron bar geometry
  const chevY = 105, chevH = 50, notch = 20
  const totalMs = end.getTime() - start.getTime()
  const clamp   = (d: Date) => Math.max(0, Math.min(1, (d.getTime() - start.getTime()) / totalMs))
  const txOf    = (d: Date) => tlx1 + clamp(d) * tlW
  const todayX  = Math.min(txOf(today), tlx2)
  const renewalStart = renewalDays > 0
    ? new Date(end.getTime() - renewalDays * 24 * 60 * 60 * 1000) : null

  type Milestone = { date: Date; label: string; sub: string; side: 'top' | 'bottom'; color: string }
  const milestones: Milestone[] = [
    { date: start, label: 'Contract start', sub: shortMonthYear(start), side: 'bottom', color: '#1A3D2B' },
    ...discounts.filter(d => d.start_date && d.end_date).flatMap(d => [
      { date: parseLocalDate(d.start_date!), label: `${d.discount_pct ?? ''}% discount`, sub: shortMonthYear(parseLocalDate(d.start_date!)), side: 'top' as const, color: '#4A7C59' },
      { date: parseLocalDate(d.end_date!),   label: 'Discount ends', sub: shortMonthYear(parseLocalDate(d.end_date!)), side: 'top' as const, color: '#4A7C59' },
    ]),
    // Ramp step milestones (skip first step — it begins at contract start)
    ...(rampSchedule
      ? rampSchedule.slice(1).map(step => ({
          date:  parseLocalDate(step.start_date),
          label: step.label ?? `${fmt(step.monthly_fee, cur)}/mo`,
          sub:   shortMonthYear(parseLocalDate(step.start_date)),
          side:  'bottom' as const,
          color: '#27AE60',
        }))
      : []),
    // One escalator milestone per year-transition where the rate is active
    // (suppressed when ramp_schedule is present — rates already reflected there)
    ...(!rampSchedule && applyEscalator
      ? Array.from({ length: Math.ceil(n / 12) - 1 }, (_, yi) => {
          const pct = escPerYear[yi]
          if (!pct) return null
          const m = modelMonths[(yi + 1) * 12]
          if (!m) return null
          return { date: m.date, label: `+${pct}% escalator`, sub: shortMonthYear(m.date), side: 'bottom' as const, color: '#27AE60' } as Milestone
        }).filter((x): x is Milestone => x !== null)
      : []),
    ...creditSchedule.map(f => ({
      date: parseLocalDate(f.due_date!),
      label: f.fee_label,
      sub: shortMonthYear(parseLocalDate(f.due_date!)),
      side: 'top' as const,
      color: '#B45309',
    })),
    ...(renewalStart ? [{ date: renewalStart, label: 'Renewal by', sub: shortMonthYear(renewalStart), side: 'top' as const, color: '#B9802F' }] : []),
    { date: end, label: 'Contract end', sub: shortMonthYear(end), side: 'bottom', color: '#1A3D2B' },
  ]

  const milestoneXPos      = milestones.map(m => txOf(m.date))
  const todayNearMilestone = milestones.some((_, i) => Math.abs(todayX - milestoneXPos[i]) < 70)

  // Assign stagger levels: same-side milestones within 160px get alternating levels
  const milestoneLevel = milestones.map(() => 0)
  for (let i = 1; i < milestones.length; i++) {
    for (let j = 0; j < i; j++) {
      if (milestones[j].side === milestones[i].side && Math.abs(milestoneXPos[i] - milestoneXPos[j]) < 160) {
        milestoneLevel[i] = milestoneLevel[j] === 0 ? 1 : 0
        break
      }
    }
  }

  const milestoneAnchor = milestones.map((m, i) => {
    const x   = milestoneXPos[i]
    const lv  = milestoneLevel[i]
    const rel = (x - tlx1) / tlW
    // Position-based edge pinning takes priority
    if (rel < 0.12) return 'start'   // left edge — text flows right
    if (rel > 0.88) return 'end'     // right edge — text flows left
    const leftN  = milestones.some((o, j) => j !== i && o.side === m.side && milestoneLevel[j] === lv && milestoneXPos[j] < x && x - milestoneXPos[j] < 160)
    const rightN = milestones.some((o, j) => j !== i && o.side === m.side && milestoneLevel[j] === lv && milestoneXPos[j] > x && milestoneXPos[j] - x < 160)
    if (leftN && !rightN) return 'start'
    if (rightN && !leftN) return 'end'
    return 'middle'
  })

  // ── Revenue chart layout ──────────────────────────────────────────────────
  const maxBase    = rampSchedule
    ? Math.max(...rampSchedule.map(s => s.monthly_fee))
    : yearPricing
      ? Math.max(...Object.values(yearPricing).map(a => a / 12))
      : (base || baseAnnual / 12)
  const maxMonthly = Math.max(...modelMonths.map(m => {
    const key = `${m.date.getFullYear()}-${m.date.getMonth()}`
    return m.total + (actualOvgByMonth.get(key) ?? 0)
  }), maxBase, 1)
  const CW = 1100, CH = 220
  const cx1 = 70, cx2 = CW - 12, cw = cx2 - cx1
  const plotTop = 12, plotBottom = 190, plotH = plotBottom - plotTop
  const bGap = n > 18 ? 1.5 : 4
  const bW   = Math.max(4, cw / n - bGap)
  const yOf  = (v: number) => plotBottom - (v / maxMonthly) * plotH
  const gridSteps = [0, 0.25, 0.5, 0.75, 1].map(f => f * maxMonthly)

  // ── Waterfall layout ──────────────────────────────────────────────────────
  const numBuckets = Math.ceil(n / 12)
  const annualBuckets = Array.from({ length: numBuckets }, (_, yi) => {
    const slice = modelMonths.slice(yi * 12, yi * 12 + 12)
    const first = slice[0].date
    const last  = slice[slice.length - 1].date
    const gross = slice.reduce((s, m) => s + m.total, 0)
    // Net in credits that fall within this year; last bucket absorbs unscheduled credits too
    const yearCredit = (creditsByYearIdx.get(yi) ?? 0) + (yi === numBuckets - 1 ? unscheduledCredit : 0)
    return {
      label: `Year ${yi + 1}`,
      dateRange: `${shortMonthYear(first)} – ${shortMonthYear(last)}`,
      sub: slice.reduce((s, m) => s + m.sub, 0),
      userOvg: slice.reduce((s, m) => s + m.userOvg, 0),
      apiOvg: slice.reduce((s, m) => s + m.apiOvg, 0),
      total: gross + yearCredit,  // net of any credits due in this year
      creditNetted: yearCredit,   // how much was subtracted (negative, or 0)
    }
  })

  // ── Waterfall bars ────────────────────────────────────────────────────────
  type WBar = { label: string; sub?: string; amount: number; kind: 'onetime' | 'period' | 'total'; color: string; tooltip: string }
  const wfBars: WBar[] = []
  if (oneTimeFees > 0) {
    wfBars.push({ label: 'One-time', amount: oneTimeFees, kind: 'onetime', color: '#D9A35A', tooltip: `One-time fees: ${fmt(oneTimeFees, cur)}` })
  }
  annualBuckets.forEach((b, i) => {
    const colors = ['#73C99B', '#27AE60', '#1F7A4A', '#0F2D1A']
    const creditNote = b.creditNetted < 0 ? ` incl. ${fmt(b.creditNetted, cur)} credit` : ''
    wfBars.push({ label: b.label, sub: b.dateRange, amount: b.total, kind: 'period', color: colors[Math.min(i, colors.length - 1)], tooltip: `${b.label} (${b.dateRange}): ${fmt(b.total, cur)}${creditNote}` })
  })
  wfBars.push({ label: 'TCV', amount: totalTcv, kind: 'total', color: '#1A3D2B', tooltip: `Total contract value: ${fmt(totalTcv, cur)}` })

  let wfCum = 0
  const wfPositioned = wfBars.map(b => {
    const from = b.kind === 'total' ? 0 : wfCum
    const to   = b.kind === 'total' ? totalTcv : wfCum + b.amount
    if (b.kind !== 'total') wfCum = to
    return { ...b, from, to }
  })

  const WW = 1100, WH = 215
  const wx1 = 70, wx2 = WW - 12, ww = wx2 - wx1
  const wTop = 22, wBottom = 150, wPlotH = wBottom - wTop
  const wBarsN = wfPositioned.length
  const wGap   = 20
  const wBW    = Math.min(140, (ww - wGap * (wBarsN - 1)) / wBarsN)
  const wStartX = wx1 + (ww - (wBW * wBarsN + wGap * (wBarsN - 1))) / 2
  const wScale   = totalTcv > 0 ? totalTcv : 1
  const wyOf     = (v: number) => wBottom - (v / wScale) * wPlotH
  const wGridSteps = [0, 0.5, 1].map(f => f * wScale)

  // Dirty flag: user changed escPerYear[0] vs contract default
  const escIsDirty = escPerYear[0] !== contractEscPct && jobId

  return (
    <div className="flex-1 overflow-y-auto p-8 space-y-6">

      {/* ── Scenario controls ─────────────────────────────────────────── */}
      <div className="bg-white border border-forest/10 rounded-2xl p-6">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-[10px] font-bold text-stone uppercase tracking-[0.14em]">Scenario inputs</h3>
          <button
            onClick={() => {
              setScenarioUsers(includedUsers)
              setScenarioApiCalls(0)
              setApplyEscalator(true)
              setApplyDiscount(true)
              setEscPerYear(Array.from({ length: numEscYears }, () => contractEscPct))
              setSaved(false)
            }}
            className="text-[10px] text-stone hover:text-forest transition-colors underline underline-offset-2"
          >
            Reset to contract defaults
          </button>
        </div>

        <div className={`grid gap-8 ${rampSchedule ? 'grid-cols-3' : 'grid-cols-4'}`}>
          {/* Users */}
          <div>
            <label className="text-[10px] font-semibold text-stone uppercase tracking-[0.1em] block mb-2">Total users / month</label>
            <input
              type="number" min={0} value={scenarioUsers}
              onChange={e => setScenarioUsers(Math.max(0, Number(e.target.value)))}
              className="w-28 text-sm font-medium text-ink border border-forest/20 rounded-lg px-3 py-2 outline-none focus:border-forest"
            />
            <p className="text-[10px] text-stone mt-1.5">
              {includedUsers > 0 ? `${includedUsers.toLocaleString()} seats included` : 'No seat allowance'}
            </p>
            {scenarioUsers > includedUsers && userTiers.length > 0 && (
              <p className="text-[10px] text-[#4A7C59] mt-0.5 font-medium">
                +{(scenarioUsers - includedUsers).toLocaleString()} extra → overage applies
              </p>
            )}
          </div>

          {/* API calls */}
          <div>
            <label className="text-[10px] font-semibold text-stone uppercase tracking-[0.1em] block mb-2">
              API calls / {apiCallPeriodLabel}
            </label>
            <input
              type="number" min={0} step={10000} value={scenarioApiCalls}
              onChange={e => setScenarioApiCalls(Math.max(0, Number(e.target.value)))}
              className="w-36 text-sm font-medium text-ink border border-forest/20 rounded-lg px-3 py-2 outline-none focus:border-forest"
            />
            <p className="text-[10px] text-stone mt-1.5">
              {includedApiCalls > 0
                ? `${includedApiCalls.toLocaleString()} included / ${apiCallPeriodLabel}`
                : apiTiers.length > 0 ? 'No free allowance' : 'No API overage tiers'}
            </p>
            {apiTiers.length > 0 && scenarioApiCalls > includedApiCalls && (
              <p className="text-[10px] text-[#B9802F] mt-0.5 font-medium">
                {(scenarioApiCalls - includedApiCalls).toLocaleString()} excess → €{(periodApiOvg).toFixed(0)}/{apiCallPeriodLabel}
              </p>
            )}
            {apiTiers.length > 0 && scenarioApiCalls <= includedApiCalls && includedApiCalls > 0 && (
              <p className="text-[10px] text-stone/60 mt-0.5">Within included allowance</p>
            )}
          </div>

          {/* Escalator — per-year compound inputs (hidden when ramp_schedule encodes the rates) */}
          {!rampSchedule && <div>
            <label className="text-[10px] font-semibold text-stone uppercase tracking-[0.1em] block mb-2">Price escalator</label>
            <div className="flex items-center gap-3 mb-3">
              <button onClick={() => setApplyEscalator(v => !v)}
                className={`w-9 h-5 rounded-full transition-colors relative flex-shrink-0 ${applyEscalator ? 'bg-forest' : 'bg-stone/25'}`}>
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${applyEscalator ? 'left-4' : 'left-0.5'}`} />
              </button>
              <span className="text-xs text-stone">{applyEscalator ? 'On' : 'Off'}</span>
            </div>
            {applyEscalator && (
              <div className="space-y-2">
                {escPerYear.map((pct, yi) => (
                  <div key={yi} className="flex items-center gap-1.5">
                    {numEscYears > 1 && (
                      <span className="text-[9px] text-stone/70 w-[52px] flex-shrink-0 leading-tight">
                        Yr {yi + 1}→{yi + 2}
                      </span>
                    )}
                    <input
                      type="number" min={0} max={50} step={0.5} value={pct}
                      onChange={e => {
                        const v = e.target.value === '' ? 0 : Number(e.target.value)
                        setEscPerYear(arr => arr.map((x, i) => i === yi ? v : x))
                        if (yi === 0) setSaved(false)
                      }}
                      className="w-16 text-sm font-medium text-ink border border-forest/20 rounded-lg px-2 py-1.5 outline-none focus:border-forest"
                    />
                    <span className="text-xs text-stone">%</span>
                    {/* Confirm/save tick — appears on first-year input when it differs from the DB value */}
                    {yi === 0 && escIsDirty && (
                      <button
                        onClick={saveEscalatorCorrection}
                        disabled={saving}
                        title="Save as contract default"
                        className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold rounded-lg transition-colors border disabled:opacity-50"
                        style={saved
                          ? { background: '#D4EAD9', borderColor: 'rgba(74,124,89,0.35)', color: '#1A3D2B' }
                          : { background: '#F0F8F3', borderColor: 'rgba(26,61,43,0.25)', color: '#1A3D2B' }}
                      >
                        {saving ? (
                          <i className="ti ti-loader-2 animate-spin" style={{ fontSize: 10 }} />
                        ) : saved ? (
                          <><i className="ti ti-check" style={{ fontSize: 10 }} /> Saved</>
                        ) : (
                          <><i className="ti ti-check" style={{ fontSize: 10 }} /> Save</>
                        )}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            {escalators[0]?.effective_date && (
              <p className="text-[10px] text-stone mt-2">
                From {shortMonthYear(parseLocalDate(escalators[0].effective_date))} · compound annual
              </p>
            )}
            {applyEscalator && escPerYear.length > 1 && (
              <p className="text-[10px] text-stone/60 mt-0.5">Each year builds on the previous</p>
            )}
          </div>}

          {/* Discount */}
          <div>
            <label className="text-[10px] font-semibold text-stone uppercase tracking-[0.1em] block mb-2">Introductory discount</label>
            <div className="flex items-center gap-3 mb-3">
              <button onClick={() => setApplyDiscount(v => !v)}
                className={`w-9 h-5 rounded-full transition-colors relative flex-shrink-0 ${applyDiscount ? 'bg-forest' : 'bg-stone/25'}`}>
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${applyDiscount ? 'left-4' : 'left-0.5'}`} />
              </button>
              <span className="text-xs text-stone">{applyDiscount ? 'On' : 'Off'}</span>
            </div>
            {discounts.map((d, i) => (
              <p key={i} className="text-[10px] text-stone">
                {d.discount_pct}% off
                {d.start_date && d.end_date && (
                  <> &middot; {shortMonthYear(parseLocalDate(d.start_date))} – {shortMonthYear(parseLocalDate(d.end_date))}</>
                )}
              </p>
            ))}
          </div>
        </div>
      </div>

      {/* ── Contract timeline ──────────────────────────────────────────── */}
      <div className="bg-white border border-forest/10 rounded-2xl p-6">
        <h3 className="text-[10px] font-bold text-stone uppercase tracking-[0.14em] mb-4">Contract timeline</h3>
        <svg viewBox={`0 0 ${TLW} ${TLH}`} className="w-full" style={{ height: 250 }} overflow="visible">
          {/* ── Chevron segments (one per contract year) ── */}
          {(() => {
            const chevColors = ['#73C99B', '#3BAD6E', '#27AE60', '#1F8A4A', '#1F7A4A', '#0F5A35']
            const nc = numBuckets
            const segW = tlW / nc
            const midY = chevY + chevH / 2
            const R = 7  // corner radius

            // Convert polygon vertices to a smooth rounded-corner SVG path.
            // At each vertex, pull back r px along each edge and draw a quadratic bezier.
            function roundedPath(pts: [number, number][]): string {
              const n = pts.length
              let d = ''
              for (let i = 0; i < n; i++) {
                const prev = pts[(i - 1 + n) % n]
                const curr = pts[i]
                const next = pts[(i + 1) % n]
                const v1x = prev[0] - curr[0], v1y = prev[1] - curr[1]
                const v2x = next[0] - curr[0], v2y = next[1] - curr[1]
                const d1  = Math.sqrt(v1x * v1x + v1y * v1y)
                const d2  = Math.sqrt(v2x * v2x + v2y * v2y)
                const rc  = Math.min(R, d1 / 2, d2 / 2)
                const p1x = curr[0] + (v1x / d1) * rc
                const p1y = curr[1] + (v1y / d1) * rc
                const p2x = curr[0] + (v2x / d2) * rc
                const p2y = curr[1] + (v2y / d2) * rc
                d += i === 0 ? `M ${p1x},${p1y} ` : `L ${p1x},${p1y} `
                d += `Q ${curr[0]},${curr[1]} ${p2x},${p2y} `
              }
              return d + 'Z'
            }

            return annualBuckets.map((b, yi) => {
              const x0  = tlx1 + yi * segW
              const x1  = x0 + segW
              const col = chevColors[Math.min(yi, chevColors.length - 1)]
              let polyPts: [number, number][]
              if (nc === 1)
                polyPts = [[x0,chevY],[x1,chevY],[x1,chevY+chevH],[x0,chevY+chevH]]
              else if (yi === 0)
                polyPts = [[x0,chevY],[x1-notch,chevY],[x1,midY],[x1-notch,chevY+chevH],[x0,chevY+chevH]]
              else
                polyPts = [[x0,chevY],[x1-notch,chevY],[x1,midY],[x1-notch,chevY+chevH],[x0,chevY+chevH],[x0+notch,midY]]
              const cx = x0 + segW / 2 + (yi === 0 ? -notch / 4 : notch / 4)
              return (
                <g key={yi}>
                  <path d={roundedPath(polyPts)} fill={col} />
                  <text x={cx} y={midY - 7} textAnchor="middle" fontSize={13} fontWeight={700} fill="white" letterSpacing="0.04em">
                    {b.label.toUpperCase()}
                  </text>
                  <text x={cx} y={midY + 9} textAnchor="middle" fontSize={9} fill="rgba(255,255,255,0.75)">
                    {b.dateRange}
                  </text>
                </g>
              )
            })
          })()}

          {/* ── Discount period overlay ── */}
          {discounts.map((d, i) => {
            if (!d.start_date || !d.end_date) return null
            const x1 = txOf(parseLocalDate(d.start_date))
            const x2 = txOf(parseLocalDate(d.end_date))
            const w  = Math.max(0, x2 - x1)
            if (w === 0) return null
            return (
              <rect key={i} x={x1} y={chevY} width={w} height={chevH}
                fill="white" opacity={0.18} />
            )
          })}

          {/* ── Milestone connectors + labels ── */}
          {milestones.map((m, i) => {
            const mx    = milestoneXPos[i]
            const isTop = m.side === 'top'
            const lv    = milestoneLevel[i]
            const ext   = lv * 26

            // Compute true chevron boundary at x=mx by interpolating along angled edges
            const segWc = tlW / numBuckets
            const midYc = chevY + chevH / 2
            const yi2   = Math.max(0, Math.min(numBuckets - 1, Math.floor((mx - tlx1) / segWc)))
            const sx0   = tlx1 + yi2 * segWc
            const sx1   = sx0 + segWc
            // Right-tip angled zone: x1-notch → x1 (all segments have a tip here)
            const inRightTip  = numBuckets > 1 && mx >= sx1 - notch
            // Left-notch angled zone: x0 → x0+notch (middle/last segments only)
            const inLeftNotch = yi2 > 0 && mx <= sx0 + notch
            const faceY = (() => {
              if (inRightTip) {
                const t = Math.min(1, (mx - (sx1 - notch)) / notch)
                return isTop
                  ? chevY + (midYc - chevY) * t
                  : chevY + chevH - (chevH / 2) * t
              }
              if (inLeftNotch) {
                const t = Math.min(1, (mx - sx0) / notch)
                return isTop
                  ? chevY + (midYc - chevY) * t
                  : chevY + chevH - (chevH / 2) * t
              }
              return isTop ? chevY : chevY + chevH
            })()

            const dotY   = isTop ? chevY - 28 - ext : chevY + chevH + 28 + ext
            const labelY = isTop ? chevY - 42 - ext : chevY + chevH + 44 + ext
            const subY   = isTop ? chevY - 31 - ext : chevY + chevH + 56 + ext

            const anchor    = milestoneAnchor[i]
            const lx        = anchor === 'start' ? mx + 6 : anchor === 'end' ? mx - 6 : mx
            const dashArray = m.color === '#1A3D2B' ? undefined : '3 2'

            // Contract start / end get an L-shaped connector; all other events use a straight line
            const isBoundary = m.label === 'Contract start' || m.label === 'Contract end'
            const isStart    = m.label === 'Contract start'

            if (isBoundary) {
              const chevEdge = isTop ? chevY : chevY + chevH
              const armLen   = 28
              const vertDrop = 18
              const vy = isTop ? chevEdge - vertDrop : chevEdge + vertDrop
              // Arms point inward so labels stay within the SVG viewBox
              const hx = isStart ? mx + armLen : mx - armLen
              const ta = isStart ? 'start' : 'end'
              const lbx = isStart ? hx + 5 : hx - 5
              return (
                <g key={i}>
                  {/* Vertical jog from chevron edge */}
                  <line x1={mx} y1={chevEdge} x2={mx} y2={vy}
                    stroke={m.color} strokeWidth={1.5} />
                  {/* Horizontal arm */}
                  <line x1={mx} y1={vy} x2={hx} y2={vy}
                    stroke={m.color} strokeWidth={1.5} />
                  {/* Dot at elbow end */}
                  <circle cx={hx} cy={vy} r={4} fill={m.color} />
                  <text x={lbx} y={vy - 6} textAnchor={ta} fontSize={10} fill={m.color} fontWeight={700}>
                    {m.label}
                  </text>
                  <text x={lbx} y={vy + 7} textAnchor={ta} fontSize={9} fill="#9CA3AF">
                    {m.sub}
                  </text>
                </g>
              )
            }

            return (
              <g key={i}>
                <line x1={mx} y1={isTop ? dotY + 5 : dotY - 5} x2={mx} y2={faceY}
                  stroke={m.color} strokeWidth={1.5} strokeDasharray={dashArray} />
                <circle cx={mx} cy={dotY} r={4} fill={m.color} />
                <text x={lx} y={labelY} textAnchor={anchor} fontSize={10} fill={m.color} fontWeight={700}>
                  {m.label}
                </text>
                <text x={lx} y={subY} textAnchor={anchor} fontSize={9} fill="#9CA3AF">
                  {m.sub}
                </text>
              </g>
            )
          })}

          {/* ── Today marker ── */}
          {contractActive && (
            <g>
              <line x1={todayX} y1={chevY - 2} x2={todayX} y2={chevY + chevH + 2}
                stroke="white" strokeWidth={2.5} strokeDasharray="5 3" opacity={0.9} />
              {!todayNearMilestone && (
                <>
                  <text x={todayX} y={chevY - 9} textAnchor="middle" fontSize={10} fill="#1A3D2B" fontWeight={700}>
                    Today
                  </text>
                </>
              )}
            </g>
          )}

          {/* ── Footer status ── */}
          <text x={tlx1} y={TLH - 6} fontSize={10} fill="#9CA3AF">
            {today > end
              ? 'Contract completed'
              : `${modelMonths.filter(m => m.isPast).length} / ${n} months elapsed`}
          </text>
        </svg>

        {/* Legend */}
        <div className="flex items-center gap-5 mt-3 flex-wrap">
          {discounts.length > 0 && (
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-sm border border-forest/30" style={{ background: 'rgba(255,255,255,0.5)', outline: '1.5px solid #4A7C59' }} />
              <span className="text-[9px] text-stone">Discount period</span>
            </div>
          )}
          {renewalStart && (
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-sm bg-[#FAC775] opacity-70" />
              <span className="text-[9px] text-stone">Renewal window</span>
            </div>
          )}
          {escalators.length > 0 && (
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-[#27AE60]" />
              <span className="text-[9px] text-stone">Escalator</span>
            </div>
          )}
          {creditSchedule.length > 0 && (
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-[#B45309]" />
              <span className="text-[9px] text-stone">Credit</span>
            </div>
          )}
          {contractActive && (
            <div className="flex items-center gap-1.5">
              <svg width={16} height={8}>
                <line x1={0} y1={4} x2={16} y2={4} stroke="#1A3D2B" strokeWidth={2} strokeDasharray="4 3" />
              </svg>
              <span className="text-[9px] text-stone">Today</span>
            </div>
          )}
        </div>
      </div>

      {/* ── Monthly revenue breakdown ──────────────────────────────────── */}
      <div className="bg-white border border-forest/10 rounded-2xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-[10px] font-bold text-stone uppercase tracking-[0.14em]">Monthly revenue breakdown</h3>
          <div className="flex items-center gap-5">
            {[
              { color: '#B8E0CC', label: 'Discounted' },
              { color: '#27AE60', label: 'Base rate' },
              { color: '#1F7A4A', label: 'Escalated' },
              ...(userTiers.length > 0 ? [{ color: '#4A7C59', label: 'User overage' }] : []),
              ...(apiTiers.length  > 0 ? [{ color: '#52C48A', label: 'API overage (scenario)'  }] : []),
              ...(actualOvgByMonth.size > 0 ? [{ color: '#0B5C36', label: 'API overage - Actual billed' }] : []),
              ...(creditByMonth.size > 0 ? [{ color: '#B45309', label: 'Credit applied' }] : []),
            ].map(li => (
              <div key={li.label} className="flex items-center gap-1.5">
                <div className="w-3 h-3 rounded-sm" style={{ background: li.color }} />
                <span className="text-[9px] text-stone">{li.label}</span>
              </div>
            ))}
          </div>
        </div>

        <svg viewBox={`0 0 ${CW} ${CH}`} className="w-full" style={{ height: 230 }}>
          {gridSteps.map((v, i) => {
            const yy = yOf(v)
            return (
              <g key={i}>
                <line x1={cx1} y1={yy} x2={cx2} y2={yy}
                  stroke={i === 0 ? '#D1D5DB' : '#F0F2EE'} strokeWidth={i === 0 ? 1 : 0.75} />
                <text x={cx1 - 6} y={yy + 4} textAnchor="end" fontSize={10} fill="#9CA3AF">
                  {fmt(v, cur, true)}
                </text>
              </g>
            )
          })}

          {modelMonths.map((m, i) => {
            const x    = cx1 + i * (bW + bGap)
            const subH = Math.max(0, (m.sub / maxMonthly) * plotH)
            const uH   = (m.userOvg / maxMonthly) * plotH
            const aH   = (m.apiOvg  / maxMonthly) * plotH
            const subY = plotBottom - subH
            const subFill = m.inDiscount ? '#B8E0CC' : (m.escalated && m.escalationMult > 1) ? '#1F7A4A' : '#27AE60'
            const mdKey  = `${m.date.getFullYear()}-${m.date.getMonth()}`
            const credit = creditByMonth.get(mdKey) ?? 0
            const isCreditMonth = credit < 0
            const actualOvg = actualOvgByMonth.get(mdKey) ?? 0
            const acH = actualOvg > 0 ? (actualOvg / maxMonthly) * plotH : 0
            return (
              <g key={i} opacity={contractActive && !m.isPast ? 0.3 : 1}>
                <title>{`${m.date.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}\nSubscription: ${fmt(m.sub, cur)}\nUser overage: ${fmt(m.userOvg, cur)}\nAPI overage (scenario): ${fmt(m.apiOvg, cur)}${actualOvg > 0 ? `\nActual billed overage: ${fmt(actualOvg, cur)}` : ''}\nTotal: ${fmt(m.total + actualOvg, cur)}${isCreditMonth ? `\nCredit: ${fmt(credit, cur)}` : ''}`}</title>
                {/* Amber left-edge highlight for credit month */}
                {isCreditMonth && <rect x={x} y={subY} width={Math.max(2, bW)} height={subH} rx={1.5} fill="#FEF3C7" opacity={0.6} />}
                <rect x={x} y={subY} width={bW} height={subH} rx={1.5} fill={subFill}
                  stroke={isCreditMonth ? '#B45309' : 'none'} strokeWidth={isCreditMonth ? 1.5 : 0} />
                {m.userOvg > 0 && <rect x={x} y={subY - uH} width={bW} height={uH} fill="#4A7C59" />}
                {m.apiOvg  > 0 && <rect x={x} y={subY - uH - aH} width={bW} height={aH} fill="#52C48A" />}
                {/* Actual billed overage — deep forest green, shown automatically from computed_invoices */}
                {acH > 0 && <rect x={x} y={subY - uH - aH - acH} width={bW} height={acH} fill="#0B5C36" rx={1} />}
                {/* Downward triangle marker + credit label above bar */}
                {isCreditMonth && (() => {
                  const barTop = yOf(m.total)
                  const cx     = x + bW / 2
                  return (
                    <>
                      <text x={cx} y={barTop - 18} textAnchor="middle" fontSize={8} fill="#B45309" fontWeight={700}>
                        {fmt(credit, cur, true)}
                      </text>
                      <polygon points={`${cx - 5},${barTop - 14} ${cx + 5},${barTop - 14} ${cx},${barTop - 6}`} fill="#B45309" />
                    </>
                  )
                })()}
              </g>
            )
          })}

          {contractActive && (() => {
            const pastCount = modelMonths.filter(m => m.isPast).length
            if (pastCount === 0) return null
            const idx    = Math.min(pastCount - 1, n - 1)
            const m      = modelMonths[idx]
            const barCx  = cx1 + idx * (bW + bGap) + bW / 2
            const divX   = cx1 + idx * (bW + bGap) + bW + bGap / 2
            const mdKey  = `${m.date.getFullYear()}-${m.date.getMonth()}`
            const aOvg   = actualOvgByMonth.get(mdKey) ?? 0
            const barTop = yOf(m.total + aOvg)
            const ts = 6  // triangle half-width
            return (
              <g>
                {/* Past / future divider */}
                <line x1={divX} y1={plotTop} x2={divX} y2={plotBottom}
                  stroke="#1A3D2B" strokeWidth={1} strokeDasharray="4 3" opacity={0.3} />
                {/* "Today" label above triangle */}
                <text x={barCx} y={barTop - ts * 2 - 5}
                  textAnchor="middle" fontSize={9} fill="#1A3D2B" fontWeight={700}>Today</text>
                {/* Downward-pointing triangle pinned to top of bar */}
                <polygon
                  points={`${barCx - ts},${barTop - ts - 2} ${barCx + ts},${barTop - ts - 2} ${barCx},${barTop - 2}`}
                  fill="#1A3D2B"
                />
              </g>
            )
          })()}

          {modelMonths.map((m, i) => {
            const step  = n <= 12 ? 1 : n <= 24 ? 2 : 3
            const show  = i % step === 0 || i === n - 1
            if (!show) return null
            const x         = cx1 + i * (bW + bGap) + bW / 2
            const isNewYear = m.date.getMonth() === 0 && i > 0
            const isFirst   = i === 0
            const label = (isFirst || isNewYear) ? shortMonthYear(m.date) : shortMonth(m.date)
            return (
              <text key={i}
                x={x} y={plotBottom + 15}
                textAnchor="middle"
                fontSize={9}
                fill={isNewYear ? '#1F7A4A' : '#9CA3AF'}
                fontWeight={isNewYear || isFirst ? 700 : 400}
              >
                {label}
              </text>
            )
          })}
        </svg>
      </div>

      {/* ── Waterfall: cumulative build-up to TCV ─────────────────────── */}
      <div className="bg-white border border-forest/10 rounded-2xl p-6">
        <h3 className="text-[10px] font-bold text-stone uppercase tracking-[0.14em] mb-4">Cumulative revenue build-up to TCV</h3>
        <svg viewBox={`0 0 ${WW} ${WH}`} className="w-full" style={{ height: 215 }}>
          {wGridSteps.map((v, i) => {
            const yy = wyOf(v)
            return (
              <g key={i}>
                <line x1={wx1} y1={yy} x2={wx2} y2={yy}
                  stroke={i === 0 ? '#D1D5DB' : '#F0F2EE'} strokeWidth={i === 0 ? 1 : 0.75} />
                <text x={wx1 - 6} y={yy + 4} textAnchor="end" fontSize={10} fill="#9CA3AF">
                  {fmt(v, cur, true)}
                </text>
              </g>
            )
          })}

          {wfPositioned.slice(0, -1).map((b, i) => {
            const xR = wStartX + i * (wBW + wGap) + wBW
            const xL = wStartX + (i + 1) * (wBW + wGap)
            const y  = wyOf(b.to)
            return <line key={i} x1={xR} y1={y} x2={xL} y2={y} stroke="#C9CCC6" strokeWidth={1} strokeDasharray="3 2" />
          })}

          {wfPositioned.map((b, i) => {
            const x    = wStartX + i * (wBW + wGap)
            const yTop = wyOf(b.to)
            const yBot = wyOf(b.from)
            const h    = Math.max(2, yBot - yTop)
            return (
              <g key={i}>
                <title>{b.tooltip}</title>
                <rect x={x} y={yTop} width={wBW} height={h} rx={3} fill={b.color} />
                <text x={x + wBW / 2} y={yTop - 8} textAnchor="middle" fontSize={11}
                  fontWeight={b.kind === 'total' ? 700 : 600} fill="#3A3A38">
                  {fmt(b.amount, cur, true)}
                </text>
                <text x={x + wBW / 2} y={wBottom + 18} textAnchor="middle" fontSize={11}
                  fill={b.kind === 'total' ? '#1A3D2B' : '#6B6660'}
                  fontWeight={b.kind === 'total' ? 700 : 400}>
                  {b.label}
                </text>
                {b.sub && (
                  <text x={x + wBW / 2} y={wBottom + 31} textAnchor="middle" fontSize={9} fill="#9CA3AF">
                    ({b.sub})
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      </div>

      {/* ── KPI cards ─────────────────────────────────────────────────── */}
      <div className={`grid gap-4 ${creditTotal < 0 ? 'grid-cols-5' : 'grid-cols-4'}`}>
        {[
          {
            label: 'Base TCV',
            value: totalSub + oneTimeFees,
            sub: 'Contracted fees + one-time',
            color: '#1A3D2B',
          },
          ...(creditTotal < 0 ? [{
            label: 'Credits',
            value: creditTotal,
            sub: creditLabels || 'Contract credits',
            color: '#B45309',
            isCredit: true,
          }] : []),
          {
            label: 'User overage',
            value: totalUserOvg,
            sub: `${Math.max(0, scenarioUsers - includedUsers)} extra users × ${n} mo`,
            color: '#4A7C59',
          },
          {
            label: 'API overage',
            value: totalApiOvg,
            sub: `${scenarioApiCalls.toLocaleString()} calls/${apiCallPeriodLabel} · ${includedApiCalls > 0 ? `${includedApiCalls.toLocaleString()} included` : 'no allowance'}`,
            color: '#B9802F',
          },
          {
            label: 'Total TCV',
            value: totalTcv,
            sub: creditTotal < 0 ? 'Net after credits + overages' : 'Subscription + all overages',
            color: '#1A3D2B',
            bold: true,
          },
        ].map(c => (
          <div key={c.label}
            className="bg-white border rounded-2xl p-5"
            style={{ borderColor: c.isCredit ? 'rgba(180,83,9,0.2)' : 'rgba(26,61,43,0.1)', background: c.isCredit ? '#FFFBEB' : 'white' }}>
            <p className="text-[10px] font-semibold uppercase tracking-[0.1em] mb-2"
              style={{ color: c.isCredit ? '#B45309' : '#6B6660' }}>
              {c.label}
            </p>
            <p className={`${c.bold ? 'text-[28px]' : 'text-2xl'} font-medium leading-none`}
              style={{ color: c.color, fontVariantNumeric: 'tabular-nums' }}>
              {fmt(c.value, cur)}
            </p>
            <p className="text-[10px] mt-1.5" style={{ color: c.isCredit ? '#B45309' : '#6B6660' }}>{c.sub}</p>
          </div>
        ))}
      </div>

      {/* ── Configured billing schedule ───────────────────────────────── */}
      {billingLoading && (
        <div className="bg-white border border-forest/10 rounded-2xl px-6 py-4 flex items-center gap-3">
          <div className="w-3.5 h-3.5 rounded-full border-2 border-forest/20 border-t-forest/70 animate-spin flex-shrink-0" />
          <p className="text-[11px] text-stone">Loading billing schedule from Stripe…</p>
        </div>
      )}
      {!billingLoading && billingFetchDone && !billingData?.subscription && jobId && (
        <div className="bg-white border border-forest/10 rounded-2xl px-6 py-5">
          <p className="text-[10px] font-bold text-stone uppercase tracking-[0.14em] mb-1">Configured billing schedule</p>
          <p className="text-[11px] text-stone/50">Not yet pushed to Stripe — approve &amp; push this contract to see the live billing schedule here.</p>
        </div>
      )}
      {!billingLoading && billingData?.subscription && (() => {
        type BillingEvent = {
          label: string; date: Date; amount: number; currency: string
          status: string; hostedUrl?: string | null
        }
        const rawEvents: BillingEvent[] = []

        // Year 1 — first subscription invoice
        const firstInv = billingData.invoices[0]
        if (firstInv) {
          const d = firstInv.dueDate ?? firstInv.scheduledDate ?? firstInv.created
          rawEvents.push({ label: 'Year 1', date: new Date(d), amount: firstInv.amount, currency: firstInv.currency, status: firstInv.status ?? 'unknown', hostedUrl: firstInv.hostedUrl })
        }

        // Year 2+ — pre-created annual draft invoices
        const sortedDrafts = [...billingData.annualDraftInvoices].sort((a, b) => (a.yearNum ?? 0) - (b.yearNum ?? 0))
        for (const inv of sortedDrafts) {
          const d = inv.scheduledDate ?? inv.dueDate ?? inv.created
          rawEvents.push({ label: `Year ${inv.yearNum}`, date: new Date(d), amount: inv.amount, currency: inv.currency, status: inv.status ?? 'draft', hostedUrl: inv.hostedUrl })
        }

        // One-time fees — sorted by date, interleaved chronologically
        for (const inv of billingData.oneTimeInvoices) {
          const d = inv.dueDate ?? inv.created
          rawEvents.push({ label: inv.feeLabel ?? 'One-time fee', date: new Date(d), amount: inv.amount, currency: inv.currency, status: inv.status ?? 'unknown', hostedUrl: inv.hostedUrl })
        }

        if (rawEvents.length === 0) return null

        // Sort chronologically
        const events = [...rawEvents].sort((a, b) => a.date.getTime() - b.date.getTime())

        const truncate = (s: string, max = 14) => s.length > max ? s.slice(0, max - 1) + '…' : s
        const statusColor = (s: string) =>
          s === 'paid' ? '#27AE60' : s === 'open' ? '#D97706' : '#6B9FD4'
        const statusLabel = (s: string) =>
          s === 'paid' ? 'Paid' : s === 'open' ? 'Due' : 'Draft'

        // Build cumulative waterfall bars (each starts where previous ended)
        type WBar = { label: string; sub: string; from: number; to: number; amount: number; status: string; kind: 'segment' | 'total' }
        let cum = 0
        const wBars: WBar[] = events.map(ev => {
          const from = cum
          const to   = cum + ev.amount
          cum = to
          return {
            label:  truncate(ev.label),
            sub:    ev.date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }),
            from, to, amount: ev.amount, status: ev.status, kind: 'segment',
          }
        })
        const configuredTotal = cum
        // TCV total bar — spans full height from 0
        wBars.push({ label: 'TCV', sub: '', from: 0, to: configuredTotal, amount: configuredTotal, status: 'total', kind: 'total' })

        const n = wBars.length
        const bScale = configuredTotal > 0 ? configuredTotal : 1

        // Same SVG dimensions as the waterfall chart above
        const bWW = 1100, bWH = 230
        const bx1 = 70, bx2 = bWW - 12, bww = bx2 - bx1
        const bTop = 22, bBottom = 158, bPlotH = bBottom - bTop
        const bGap    = n > 8 ? 10 : 20
        const bBW     = Math.min(120, (bww - bGap * (n - 1)) / n)
        const bStartX = bx1 + (bww - (bBW * n + bGap * (n - 1))) / 2
        const byOf    = (v: number) => bBottom - (v / bScale) * bPlotH
        const bGrid   = [0, 0.5, 1].map(f => f * bScale)

        const contractTcv = (billingData.paymentSchedule ?? []).reduce((s, y) => s + y.amount, 0)
          + (billingData.oneTimeFees ?? []).reduce((s: number, f: { amount: number }) => s + f.amount, 0)
        const tcvDelta = contractTcv > 0 ? (configuredTotal - contractTcv) / contractTcv : 0
        const isMatch  = Math.abs(tcvDelta) < 0.005

        return (
          <div className="bg-white border border-forest/10 rounded-2xl p-6">
            <div className="flex items-start justify-between mb-4">
              <h3 className="text-[10px] font-bold text-stone uppercase tracking-[0.14em]">Configured billing schedule</h3>
              <div className="flex items-center gap-4 flex-shrink-0">
                <div className="flex items-center gap-2 text-[10px] text-stone/60">
                  <span className="inline-block w-2 h-2 rounded-sm" style={{ background: '#27AE60' }} /> Paid
                  <span className="inline-block w-2 h-2 rounded-sm ml-1" style={{ background: '#D97706' }} /> Due
                  <span className="inline-block w-2 h-2 rounded-sm ml-1" style={{ background: '#6B9FD4' }} /> Draft
                </div>
                {billingData.subscription.dashboardUrl && (
                  <a href={billingData.subscription.dashboardUrl} target="_blank" rel="noopener noreferrer"
                    className="text-[10px] text-stone/50 hover:text-forest transition-colors flex items-center gap-1">
                    <i className="ti ti-external-link" style={{ fontSize: 10 }} /> Stripe
                  </a>
                )}
              </div>
            </div>

            <svg viewBox={`0 0 ${bWW} ${bWH}`} className="w-full" style={{ height: 230 }}>
              {/* Grid */}
              {bGrid.map((v, i) => {
                const yy = byOf(v)
                return (
                  <g key={i}>
                    <line x1={bx1} y1={yy} x2={bx2} y2={yy}
                      stroke={i === 0 ? '#D1D5DB' : '#F0F2EE'} strokeWidth={i === 0 ? 1 : 0.75} />
                    {v > 0 && (
                      <text x={bx1 - 6} y={yy + 4} textAnchor="end" fontSize={10} fill="#9CA3AF">
                        {fmt(v, cur, true)}
                      </text>
                    )}
                  </g>
                )
              })}

              {/* Dashed connectors between segment bars (at the "to" level) */}
              {wBars.slice(0, -2).map((b, i) => {
                const xR = bStartX + i * (bBW + bGap) + bBW
                const xL = bStartX + (i + 1) * (bBW + bGap)
                const y  = byOf(b.to)
                return <line key={i} x1={xR} y1={y} x2={xL} y2={y} stroke="#C9CCC6" strokeWidth={1} strokeDasharray="3 2" />
              })}

              {/* Bars */}
              {wBars.map((b, i) => {
                const x    = bStartX + i * (bBW + bGap)
                const yTop = byOf(b.to)
                const yBot = byOf(b.kind === 'total' ? 0 : b.from)
                const h    = Math.max(2, yBot - yTop)
                const col  = b.kind === 'total' ? '#1A3D2B' : statusColor(b.status)
                return (
                  <g key={i}>
                    <rect x={x} y={yTop} width={bBW} height={h} rx={3} fill={col} />

                    {/* Amount above */}
                    <text x={x + bBW / 2} y={Math.min(yTop - 6, bTop + 12)} textAnchor="middle"
                      fontSize={11} fontWeight={b.kind === 'total' ? 700 : 600} fill="#3A3A38"
                      style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {fmt(b.amount, cur, true)}
                    </text>

                    {/* Bar name */}
                    <text x={x + bBW / 2} y={bBottom + 18} textAnchor="middle"
                      fontSize={11} fill={b.kind === 'total' ? '#1A3D2B' : '#6B6660'}
                      fontWeight={b.kind === 'total' ? 700 : 400}>
                      {b.label}
                    </text>
                    {/* Date */}
                    {b.sub && (
                      <text x={x + bBW / 2} y={bBottom + 31} textAnchor="middle" fontSize={9} fill="#9CA3AF">
                        {b.sub}
                      </text>
                    )}
                    {/* Status */}
                    {b.kind === 'segment' && (
                      <text x={x + bBW / 2} y={bBottom + (b.sub ? 43 : 31)} textAnchor="middle"
                        fontSize={9} fill={statusColor(b.status)} fontWeight={500}>
                        {statusLabel(b.status)}
                      </text>
                    )}
                  </g>
                )
              })}
            </svg>

            <div className="mt-4 pt-4 border-t border-forest/[0.07] flex items-center justify-between gap-6">
              <div className="flex items-center gap-8">
                <div>
                  <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-stone/50 mb-1">Configured in Stripe</p>
                  <p className="text-[20px] font-semibold text-ink leading-none" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {fmt(configuredTotal, cur)}
                  </p>
                </div>
                {contractTcv > 0 && (
                  <div>
                    <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-stone/50 mb-1">Contract TCV</p>
                    <p className="text-[20px] font-semibold leading-none" style={{ color: '#9CA3AF', fontVariantNumeric: 'tabular-nums' }}>
                      {fmt(contractTcv, cur)}
                    </p>
                  </div>
                )}
              </div>
              {contractTcv > 0 && (
                isMatch
                  ? <div className="flex items-center gap-1.5 text-[11px] font-medium text-green-700 bg-green-50 px-3 py-1.5 rounded-lg">
                      <i className="ti ti-circle-check-filled" style={{ fontSize: 13 }} /> Matches contract
                    </div>
                  : <div className="flex items-center gap-1.5 text-[11px] font-medium text-amber-700 bg-amber-50 px-3 py-1.5 rounded-lg">
                      <i className="ti ti-alert-triangle-filled" style={{ fontSize: 13 }} />
                      {tcvDelta > 0 ? '+' : ''}{(tcvDelta * 100).toFixed(1)}% vs contract
                    </div>
              )}
            </div>
          </div>
        )
      })()}

      {/* ── Sensitivity impact summary ────────────────────────────────── */}
      {(discountSaving > 0 || escalatorUplift > 0 || totalUserOvg + totalApiOvg > 0 || creditTotal < 0) && (
        <div className="bg-white border border-forest/10 rounded-2xl p-5">
          <p className="text-[10px] font-bold text-stone uppercase tracking-[0.14em] mb-4">Scenario impact breakdown</p>
          <div className="flex gap-10">
            {applyDiscount && discountSaving > 0 && (
              <div>
                <p className="text-[10px] text-stone mb-1">Discount saving</p>
                <p className="text-lg font-semibold text-[#4A7C59]" style={{ fontVariantNumeric: 'tabular-nums' }}>-{fmt(discountSaving, cur)}</p>
                <p className="text-[10px] text-stone/70">vs no introductory discount</p>
              </div>
            )}
            {applyEscalator && escalatorUplift > 0 && (
              <div>
                <p className="text-[10px] text-stone mb-1">Escalator uplift</p>
                <p className="text-lg font-semibold text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>+{fmt(escalatorUplift, cur)}</p>
                <p className="text-[10px] text-stone/70">vs flat rate · compound annual</p>
              </div>
            )}
            {totalUserOvg > 0 && (
              <div>
                <p className="text-[10px] text-stone mb-1">User overage</p>
                <p className="text-lg font-semibold text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>+{fmt(totalUserOvg, cur)}</p>
                <p className="text-[10px] text-stone/70">{scenarioUsers - includedUsers} extra users, {n} months</p>
              </div>
            )}
            {totalApiOvg > 0 && (
              <div>
                <p className="text-[10px] text-stone mb-1">API overage</p>
                <p className="text-lg font-semibold text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>+{fmt(totalApiOvg, cur)}</p>
                <p className="text-[10px] text-stone/70">{scenarioApiCalls.toLocaleString()} calls/{apiCallPeriodLabel} · {(scenarioApiCalls - includedApiCalls).toLocaleString()} excess</p>
              </div>
            )}
            {creditTotal < 0 && (
              <div className="border-l-2 border-amber-300 pl-4">
                <p className="text-[10px] text-stone mb-1">Credits applied</p>
                <p className="text-lg font-semibold" style={{ color: '#B45309', fontVariantNumeric: 'tabular-nums' }}>{fmt(creditTotal, cur)}</p>
                <p className="text-[10px] text-stone/70">{creditLabels}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Revenue actuals ───────────────────────────────────────────── */}
      {projectedTcv > 0 && (() => {
        // Waterfall bars: Base billed → Overage billed → One-time → Remaining → TCV projected
        type ABar = { label: string; sub?: string; amount: number; kind: 'segment' | 'total'; color: string; dashed?: boolean }
        const aBars: ABar[] = [
          { label: 'Base billed', sub: `${modelMonths.filter(m => m.isPast).length} mo elapsed`, amount: baseBilledToDate, kind: 'segment', color: '#27AE60' },
          ...(actualOvgTotal > 0 ? [{ label: 'Overage billed', amount: actualOvgTotal, kind: 'segment' as const, color: '#0B5C36' }] : []),
          ...(oneTimeFees > 0 ? [{ label: 'One-time', amount: oneTimeFees, kind: 'segment' as const, color: '#D9A35A' }] : []),
          { label: 'Remaining', sub: 'contracted ARR', amount: remaining, kind: 'segment', color: '#C8E6D4', dashed: true },
          { label: 'TCV projected', amount: projectedTcv, kind: 'total', color: '#1A3D2B' },
        ]
        let cum = 0
        const aPos = aBars.map(b => {
          const from = b.kind === 'total' ? 0 : cum
          const to   = b.kind === 'total' ? projectedTcv : cum + b.amount
          if (b.kind !== 'total') cum = to
          return { ...b, from, to }
        })

        const AW = 1100, AH = 200
        const ax1 = 70, ax2 = AW - 12, aw = ax2 - ax1
        const aTop = 24, aBot = 148, aPlotH = aBot - aTop
        const aN   = aPos.length
        const aGap = 24
        const aBW  = Math.min(140, (aw - aGap * (aN - 1)) / aN)
        const aStartX = ax1 + (aw - (aBW * aN + aGap * (aN - 1))) / 2
        const aScale  = projectedTcv > 0 ? projectedTcv : 1
        const ayOf    = (v: number) => aBot - (v / aScale) * aPlotH
        const aGrid   = [0, 0.5, 1].map(f => f * aScale)

        return (
          <div className="bg-white border border-forest/10 rounded-2xl p-6">
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-[10px] font-bold text-stone uppercase tracking-[0.14em]">Revenue actuals — billed to date</h3>
              <span className="text-[10px] text-stone">Remaining stays at contracted ARR · no overage projection</span>
            </div>

            {/* Waterfall */}
            <svg viewBox={`0 0 ${AW} ${AH}`} className="w-full" style={{ height: 200 }}>
              {aGrid.map((v, i) => {
                const yy = ayOf(v)
                return (
                  <g key={i}>
                    <line x1={ax1} y1={yy} x2={ax2} y2={yy}
                      stroke={i === 0 ? '#D1D5DB' : '#F0F2EE'} strokeWidth={i === 0 ? 1 : 0.75} />
                    <text x={ax1 - 6} y={yy + 4} textAnchor="end" fontSize={10} fill="#9CA3AF">
                      {fmt(v, cur, true)}
                    </text>
                  </g>
                )
              })}

              {/* Connector lines */}
              {aPos.slice(0, -1).map((b, i) => {
                const xR = aStartX + i * (aBW + aGap) + aBW
                const xL = aStartX + (i + 1) * (aBW + aGap)
                return <line key={i} x1={xR} y1={ayOf(b.to)} x2={xL} y2={ayOf(b.to)}
                  stroke="#C9CCC6" strokeWidth={1} strokeDasharray="3 2" />
              })}

              {/* Bars */}
              {aPos.map((b, i) => {
                const x    = aStartX + i * (aBW + aGap)
                const yTop = ayOf(b.to)
                const yBot = ayOf(b.from)
                const h    = Math.max(2, yBot - yTop)
                return (
                  <g key={i}>
                    <title>{`${b.label}: ${fmt(b.amount, cur)}`}</title>
                    <rect x={x} y={yTop} width={aBW} height={h} rx={3} fill={b.color}
                      opacity={b.dashed ? 0.5 : 1}
                      stroke={b.dashed ? '#4A7C59' : 'none'} strokeWidth={b.dashed ? 1.5 : 0}
                      strokeDasharray={b.dashed ? '5 3' : undefined} />
                    <text x={x + aBW / 2} y={yTop - 7} textAnchor="middle" fontSize={11}
                      fontWeight={b.kind === 'total' ? 700 : 600} fill="#3A3A38">
                      {fmt(b.amount, cur, true)}
                    </text>
                    <text x={x + aBW / 2} y={aBot + 17} textAnchor="middle" fontSize={11}
                      fill={b.kind === 'total' ? '#1A3D2B' : '#6B6660'}
                      fontWeight={b.kind === 'total' ? 700 : 400}>
                      {b.label}
                    </text>
                    {b.sub && (
                      <text x={x + aBW / 2} y={aBot + 29} textAnchor="middle" fontSize={9} fill="#9CA3AF">
                        {b.sub}
                      </text>
                    )}
                  </g>
                )
              })}
            </svg>

            {/* Overage invoice detail cards */}
            {ovgInvoices.length > 0 && (
              <div className="mt-5 pt-5 border-t border-forest/8">
                <p className="text-[10px] font-bold text-stone uppercase tracking-[0.14em] mb-3">Overage invoices</p>
                <div className="flex flex-wrap gap-3">
                  {ovgInvoices.map(inv => {
                    const ovgLines = inv.line_items.filter(l => l.type === 'overage')
                    const invOvgTotal = ovgLines.reduce((s, l) => s + l.amount, 0)
                    const pStart = new Date(inv.period_start)
                    const pEnd   = new Date(inv.period_end)
                    const sameMonth = pStart.getMonth() === pEnd.getMonth() && pStart.getFullYear() === pEnd.getFullYear()
                    const periodLabel = sameMonth
                      ? pStart.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
                      : `${pStart.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })} – ${pEnd.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })}`
                    return (
                      <div key={inv.id}
                        className="flex-1 min-w-[260px] max-w-sm border border-forest/12 rounded-xl p-4"
                        style={{ background: '#F4FAF6' }}>
                        <div className="flex items-start justify-between mb-3">
                          <div>
                            <p className="text-[10px] font-semibold text-stone uppercase tracking-[0.1em]">Period</p>
                            <p className="text-sm font-medium text-ink mt-0.5">{periodLabel}</p>
                          </div>
                          <div className="text-right">
                            <p className="text-[10px] font-semibold text-stone uppercase tracking-[0.1em]">Overage total</p>
                            <p className="text-sm font-semibold mt-0.5" style={{ color: '#0B5C36', fontVariantNumeric: 'tabular-nums' }}>
                              {fmt(invOvgTotal, inv.currency || cur)}
                            </p>
                          </div>
                        </div>
                        <div className="space-y-1.5">
                          {ovgLines.map((l, li) => (
                            <div key={li} className="flex items-start justify-between gap-3">
                              <p className="text-[11px] text-stone leading-snug flex-1">{l.description}</p>
                              <p className="text-[11px] font-medium text-ink flex-shrink-0" style={{ fontVariantNumeric: 'tabular-nums' }}>
                                {fmt(l.amount, l.currency || cur)}
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )
      })()}

    </div>
  )
}
