'use client'

import { useState, useEffect, useRef, use } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { RevenueModelTab } from '@/app/_components/RevenueModelTab'
import { RevenueScheduleTable } from '@/app/_components/RevenueScheduleTable'
import { InvoicesTab } from '@/app/_components/InvoicesTab'

const PDFViewer = dynamic(() => import('@/app/_components/PDFViewer'), { ssr: false })

// ── Types ──────────────────────────────────────────────────────────────────

type Escalator = { escalator_pct?: number; escalator_type?: string; effective_date?: string; description?: string; cap_pct?: number }
type Discount   = { discount_pct?: number; discount_amount?: number; discount_type?: string; start_date?: string; end_date?: string; duration_months?: number; applies_to?: string; description?: string }
type Tier       = { tier_label?: string; from_unit?: number; to_unit?: number; rate_per_unit?: number; unit_type?: string }

type OneTimeFee = { fee_label: string; amount: number; due_date?: string | null; description?: string | null }

type Terms = {
  id?: string
  customer_name?: string; customer_address?: string; billing_contact?: string
  vendor_name?: string;   vendor_address?: string
  contract_start_date?: string; contract_end_date?: string; contract_term_months?: number
  auto_renews?: boolean; renewal_notice_days?: number
  currency?: string
  base_monthly_fee?: number; base_annual_fee?: number
  billing_frequency?: string; payment_terms_days?: number; payment_terms_text?: string
  included_units?: number; included_unit_type?: string
  year_pricing?: Record<string, number>
  ramp_schedule?: { start_date: string; end_date: string; monthly_fee: number; label?: string }[]
  escalators?: Escalator[]; discounts?: Discount[]; overage_tiers?: Tier[]
  one_time_fees?: OneTimeFee[]
  field_sources?: Record<string, string>
  extraction_confidence?: string; extraction_notes?: string
}

type LineItem = {
  id: string; product_name: string; quantity: number; unit_price: number
  billing_period: string; total_amount: number; currency: string
  confidence_score: number; source_section?: string
  stripe_price_id?: string; applied_rule?: string
}

type Job = {
  id: string; name: string; execute_status: string; currency: string
  contract_pdf_url?: string; error_message?: string
  billing_subscription_id?: string; billing_platform?: string; billing_customer_id?: string
  line_items: LineItem[]; contract_terms: Terms[]
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fmt(n: number | null | undefined, cur = 'EUR') {
  if (n == null) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(n)
}

function fmtDate(s: string | null | undefined) {
  if (!s) return '—'
  return new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function fmtShort(d: Date) {
  return d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })
}

// Parses a 'YYYY-MM-DD' string as a local-midnight date, avoiding the UTC-parse
// day-shift that `new Date('YYYY-MM-DD')` introduces in non-UTC timezones.
function parseLocalDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1)
}

// Computes true TCV from extracted contract terms: base fee × each calendar
// month of the contract, with escalators and discounts applied per-period.
// One-time fees from structured line items are added on top.
// Math is deterministic code — LLM only extracts the raw values.
function computeContractTCV(terms: Terms | undefined, lineItems: LineItem[]): number {
  if (!terms?.contract_start_date || !terms.contract_end_date) return 0
  const hasFee = terms.base_monthly_fee || terms.base_annual_fee || terms.year_pricing ||
    (terms.ramp_schedule && terms.ramp_schedule.length > 0)
  if (!hasFee) return 0

  const start        = parseLocalDate(terms.contract_start_date)
  const end          = parseLocalDate(terms.contract_end_date)
  const discounts    = terms.discounts   ?? []
  const escalators   = terms.escalators  ?? []
  const yearPricing  = terms.year_pricing
  const rampSchedule = terms.ramp_schedule && terms.ramp_schedule.length > 0 ? terms.ramp_schedule : null
  const baseMonthly  = terms.base_monthly_fee ?? (terms.base_annual_fee ? terms.base_annual_fee / 12 : 0)

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
      const annual = yearPricing[key] ?? yearPricing[`year${Object.keys(yearPricing).length}`] ?? (terms?.base_annual_fee ?? 0)
      return annual / 12
    }
    return baseMonthly
  }

  let total  = 0
  let loopIdx = 0
  let cursor = new Date(start.getFullYear(), start.getMonth(), 1)
  const endMonth = new Date(end.getFullYear(), end.getMonth(), 1)

  while (cursor <= endMonth) {
    const md = new Date(cursor)
    let amount = monthlyBaseFor(loopIdx, md)

    // Skip escalators when ramp_schedule is present (rates already baked in)
    if (!yearPricing && !rampSchedule) {
      for (const e of escalators) {
        const ed = e.effective_date ? parseLocalDate(e.effective_date) : null
        if (ed && md >= ed && e.escalator_pct) {
          const monthsSince  = (md.getFullYear() - ed.getFullYear()) * 12 + (md.getMonth() - ed.getMonth())
          const timesApplied = 1 + Math.floor(monthsSince / 12)
          amount *= Math.pow(1 + e.escalator_pct / 100, timesApplied)
          break
        }
      }
    }
    for (const d of discounts) {
      const ds = d.start_date ? parseLocalDate(d.start_date) : null
      const de = d.end_date   ? parseLocalDate(d.end_date)   : null
      if (ds && de && md >= ds && md <= de && d.discount_pct) { amount *= (1 - d.discount_pct / 100); break }
    }

    total += amount
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
    loopIdx++
  }

  // Prefer structured line items; fall back to terms.one_time_fees if none exist yet
  const oneTimeFromItems = lineItems.filter(i => /one.?time/i.test(i.billing_period))
  const oneTimeTotal = oneTimeFromItems.length > 0
    ? oneTimeFromItems.reduce((s, i) => s + i.total_amount, 0)
    : (terms.one_time_fees ?? []).reduce((s, f) => s + (f.amount ?? 0), 0)

  return total + oneTimeTotal
}

// ── Sub-components ─────────────────────────────────────────────────────────

function Stat({ label, value, sub }: { label: string; value?: string | null; sub?: string }) {
  return (
    <div>
      <p className="text-[10px] font-semibold text-stone uppercase tracking-[0.12em] mb-1.5">{label}</p>
      <p className="text-[15px] font-medium text-ink leading-snug">{value ?? '—'}</p>
      {sub && <p className="text-[11px] text-stone mt-0.5">{sub}</p>}
    </div>
  )
}

function EditableStat({ label, value, sub, inputType = 'text', placeholder, onSave }: {
  label: string
  value?: string | null
  sub?: string
  inputType?: 'text' | 'date' | 'number'
  placeholder?: string
  onSave: (v: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)

  const startEdit = () => { setDraft(value ?? ''); setEditing(true) }
  const cancel    = () => setEditing(false)
  const save      = async () => {
    if (!draft.trim()) return
    setSaving(true)
    try { await onSave(draft.trim()); setEditing(false) } finally { setSaving(false) }
  }

  if (editing) return (
    <div>
      <p className="text-[10px] font-semibold text-stone uppercase tracking-[0.12em] mb-1.5">{label}</p>
      <div className="flex items-center gap-1.5">
        <input
          autoFocus
          type={inputType}
          value={draft}
          placeholder={placeholder}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel() }}
          className="flex-1 text-sm font-medium text-ink border border-forest/30 rounded-lg px-2.5 py-1.5 outline-none focus:border-forest min-w-0"
        />
        <button onClick={cancel} className="text-stone/50 hover:text-ink p-1 transition-colors flex-shrink-0" title="Cancel">
          <i className="ti ti-x" style={{ fontSize: 13 }} />
        </button>
        <button
          onClick={save}
          disabled={saving || !draft.trim()}
          className="flex items-center justify-center w-7 h-7 rounded-lg text-white flex-shrink-0 transition-colors disabled:opacity-50"
          style={{ background: '#1A3D2B' }}
          title="Save"
        >
          {saving
            ? <i className="ti ti-loader-2 animate-spin" style={{ fontSize: 12 }} />
            : <i className="ti ti-check" style={{ fontSize: 12 }} />}
        </button>
      </div>
    </div>
  )

  return (
    <div className="group">
      <p className="text-[10px] font-semibold text-stone uppercase tracking-[0.12em] mb-1.5">{label}</p>
      <div className="flex items-start gap-1">
        <div className="flex-1 min-w-0">
          <p className="text-[15px] font-medium text-ink leading-snug">{value ?? <span className="text-stone/40">—</span>}</p>
          {sub && <p className="text-[11px] text-stone mt-0.5">{sub}</p>}
        </div>
        <button
          onClick={startEdit}
          title={`Edit ${label.toLowerCase()}`}
          className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 p-1 rounded hover:bg-forest/5 mt-0.5"
        >
          <i className="ti ti-pencil-minus" style={{ fontSize: 11, color: '#9CA3AF' }} />
        </button>
      </div>
    </div>
  )
}

function BigValue({ label, value, unit, warn, note, children }: {
  label: string; value: string; unit?: string; warn?: boolean; note?: string; children?: React.ReactNode
}) {
  return (
    <div>
      <p className="text-[10px] font-semibold text-stone uppercase tracking-[0.12em] mb-2 flex items-center gap-2">
        {label}
        {warn && (
          <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-200">
            verify
          </span>
        )}
      </p>
      <div className="flex items-baseline gap-1.5">
        <span className="text-[30px] font-medium leading-none" style={{ color: '#1A3D2B', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
        {unit && <span className="text-[12px] text-stone">{unit}</span>}
      </div>
      {note && <p className="text-[11px] text-stone mt-1">{note}</p>}
      {children}
    </div>
  )
}

function SectionChip({ heading, onClick }: { heading?: string; onClick: () => void }) {
  if (!heading) return null
  const num = heading.match(/^[\d.]+/)?.[0]
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1 text-forest/70 hover:text-forest hover:bg-mint/60 bg-mint/30 border border-sage/30 rounded-full transition-colors whitespace-nowrap"
      style={{ fontSize: 10, fontWeight: 600, padding: '3px 10px 3px 8px' }}
      title={`Open §${heading} in contract PDF`}
    >
      <i className="ti ti-file-text" style={{ fontSize: 10 }} />
      {num ? `§${num}` : heading}
    </button>
  )
}

function CorrectionInput({
  value,
  onChange,
  onConfirm,
  confirmLabel = '✓',
}: {
  value: string
  onChange: (v: string) => void
  onConfirm?: (v: string) => Promise<void>
  confirmLabel?: string
}) {
  const [saving, setSaving] = useState(false)
  const [saved,  setSaved]  = useState(false)

  const handleConfirm = async () => {
    if (!value || !onConfirm) return
    setSaving(true)
    setSaved(false)
    try { await onConfirm(value); setSaved(true) } finally { setSaving(false) }
  }

  return (
    <div className="mt-2.5 pt-2.5 border-t border-amber-200">
      <p className="text-[9px] uppercase tracking-widest text-stone mb-1.5">Correct this value</p>
      <div className="flex items-center gap-2">
        <input
          type="text"
          placeholder="Enter correct value..."
          value={value}
          onChange={e => { onChange(e.target.value); setSaved(false) }}
          className="flex-1 text-xs bg-amber-50 border border-amber-300 rounded-lg px-3 py-1.5 outline-none focus:border-amber-400 placeholder:text-stone/50"
        />
        {onConfirm && value && (
          <button
            onClick={handleConfirm}
            disabled={saving}
            title="Save correction"
            className="flex items-center justify-center w-8 h-8 rounded-lg border transition-colors flex-shrink-0 disabled:opacity-50"
            style={saved
              ? { background: '#D4EAD9', borderColor: 'rgba(74,124,89,0.35)', color: '#1A3D2B' }
              : { background: '#F0F8F3', borderColor: 'rgba(26,61,43,0.25)',   color: '#1A3D2B' }}
          >
            {saving
              ? <i className="ti ti-loader-2 animate-spin" style={{ fontSize: 12 }} />
              : <i className="ti ti-check" style={{ fontSize: 12 }} />
            }
          </button>
        )}
      </div>
    </div>
  )
}

function Divider() {
  return <div className="border-t border-forest/8" />
}

function SectionHeader({ title, section, onSection }: { title: string; section?: string; onSection: (s: string) => void }) {
  return (
    <div className="flex items-center justify-between mb-5">
      <h3 className="text-[11px] font-bold text-stone uppercase tracking-[0.14em]">{title}</h3>
      <SectionChip heading={section} onClick={() => section && onSection(section)} />
    </div>
  )
}

function _unusedContractVisual({ terms, items, cur }: { terms: Terms; items: LineItem[]; cur: string }) {
  const start = terms.contract_start_date ? parseLocalDate(terms.contract_start_date) : null
  const end   = terms.contract_end_date   ? parseLocalDate(terms.contract_end_date)   : null

  if (!start || !end || !terms.base_monthly_fee) {
    return (
      <div className="flex flex-col items-center justify-center h-60 px-6 text-center gap-2">
        <i className="ti ti-chart-area text-stone/20" style={{ fontSize: 32 }} />
        <p className="text-xs text-stone">Contract dates or fee not available</p>
      </div>
    )
  }

  const today    = new Date()
  const totalMs  = end.getTime() - start.getTime()
  const clampPos = (d: Date) => Math.max(0, Math.min(1, (d.getTime() - start.getTime()) / totalMs))

  const PW = 332 // panel content width (380px panel − 24px padding × 2)

  // Timeline SVG constants
  const TH = 86
  const tx1 = 10, tx2 = PW - 10, trackW = tx2 - tx1, trackY = 44
  const txOf = (d: Date) => tx1 + clampPos(d) * trackW
  const todayX    = txOf(today)
  const todayFrac = clampPos(today)

  const discounts   = terms.discounts  ?? []
  const escalators  = terms.escalators ?? []
  const renewalDays = terms.renewal_notice_days ?? 0
  const renewalStart = renewalDays > 0
    ? new Date(end.getTime() - renewalDays * 24 * 60 * 60 * 1000)
    : null

  // Build monthly revenue series
  type MonthData = { date: Date; amount: number; inDiscount: boolean; escalated: boolean }
  const months: MonthData[] = []
  const base = terms.base_monthly_fee

  let cursor = new Date(start.getFullYear(), start.getMonth(), 1)
  const endMonth = new Date(end.getFullYear(), end.getMonth(), 1)

  while (cursor <= endMonth) {
    const md = new Date(cursor)

    let inDiscount = false, discountPct = 0
    for (const d of discounts) {
      const ds = d.start_date ? parseLocalDate(d.start_date) : null
      const de = d.end_date   ? parseLocalDate(d.end_date)   : null
      if (ds && de && md >= ds && md <= de && d.discount_pct) {
        inDiscount = true; discountPct = d.discount_pct; break
      }
    }

    let escalated = false, escalatorPct = 0
    for (const e of escalators) {
      const ed = e.effective_date ? parseLocalDate(e.effective_date) : null
      if (ed && md >= ed && e.escalator_pct) {
        escalated = true; escalatorPct = e.escalator_pct; break
      }
    }

    let amount = base
    if (escalated) amount = amount * (1 + escalatorPct / 100)
    if (inDiscount) amount = amount * (1 - discountPct / 100)

    months.push({ date: md, amount, inDiscount, escalated })
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
  }

  // Recurring revenue summary
  const recurringTotal = months.reduce((s, m) => s + m.amount, 0)
  const discountSaving = months.filter(m => m.inDiscount).reduce((s, m) => s + (base - m.amount), 0)
  const elapsedMonths  = months.filter(m => m.date <= today).length

  // One-time / fixed fees, sourced from structured line items (e.g. onboarding)
  const oneTimeItems = items
    .filter(i => /one.?time/i.test(i.billing_period))
    .map(i => ({ label: i.product_name, amount: i.total_amount }))
  const oneTimeTotal = oneTimeItems.reduce((s, i) => s + i.amount, 0)

  const grandTotal   = recurringTotal + oneTimeTotal
  const billedToDate = months.filter(m => m.date <= today).reduce((s, m) => s + m.amount, 0)
    + (today >= start ? oneTimeTotal : 0)

  // ── Waterfall buckets: follow billing_frequency from the contract ────────
  // "monthly" billing → show each invoiced month as a bar
  // "annual"/"yearly" billing → aggregate into contract-year bars
  const termMonths  = terms.contract_term_months ?? months.length
  const billingFreq = (terms.billing_frequency ?? '').toLowerCase()
  const useAnnual   = billingFreq.includes('annual') || billingFreq.includes('year')
                   || (!billingFreq.includes('month') && termMonths > 12)
  const GREEN_STEPS = ['#73C99B', '#27AE60', '#1F7A4A', '#0F2D1A']

  type WBar = { label: string; amount: number; tooltip: string; color: string; kind: 'onetime' | 'recurring' | 'total' }

  const recurringBars: WBar[] = useAnnual
    ? Array.from({ length: Math.ceil(months.length / 12) }, (_, yi) => {
        const slice  = months.slice(yi * 12, yi * 12 + 12)
        const amount = slice.reduce((s, m) => s + m.amount, 0)
        return {
          label: `Yr ${yi + 1}`,
          amount,
          tooltip: `Year ${yi + 1}: ${fmt(amount, cur)}`,
          color: GREEN_STEPS[Math.min(yi, GREEN_STEPS.length - 1)],
          kind: 'recurring' as const,
        }
      })
    : months.map(m => ({
        label: m.date.toLocaleDateString('en-GB', { month: 'short' }),
        amount: m.amount,
        tooltip: `${m.date.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}: ${fmt(m.amount, cur)}`,
        color: m.inDiscount ? '#B8E0CC' : m.escalated ? '#0F2D1A' : '#27AE60',
        kind: 'recurring' as const,
      }))

  const oneTimeBars: WBar[] = oneTimeItems.map(i => ({
    label: i.label.length > 12 ? i.label.slice(0, 11) + '…' : i.label,
    amount: i.amount,
    tooltip: `${i.label} (one-time): ${fmt(i.amount, cur)}`,
    color: '#D9A35A',
    kind: 'onetime' as const,
  }))

  const waterfallBars: WBar[] = [
    ...oneTimeBars,
    ...recurringBars,
    { label: 'TCV', amount: grandTotal, tooltip: `Total contract value: ${fmt(grandTotal, cur)}`, color: '#1A3D2B', kind: 'total' as const },
  ]

  let cum = 0
  const positioned = waterfallBars.map(b => {
    const from = b.kind === 'total' ? 0 : cum
    const to   = b.kind === 'total' ? grandTotal : cum + b.amount
    if (b.kind !== 'total') cum = to
    return { ...b, from, to }
  })

  // Waterfall SVG layout
  const WH = 156
  const plotTop = 16, plotBottom = 102, plotH = plotBottom - plotTop
  const px1 = 4, px2 = PW - 4, plotW = px2 - px1
  const barGap = positioned.length > 10 ? 2 : 5
  const barW   = Math.max(3, plotW / positioned.length - barGap)
  const rotateLabels = positioned.length > 8

  const yOf = (v: number) => plotBottom - (grandTotal > 0 ? (v / grandTotal) * plotH : 0)

  return (
    <div className="p-6 space-y-6">

      {/* ── Timeline ─────────────────────────────── */}
      <div>
        <p className="text-[10px] font-bold text-stone uppercase tracking-[0.14em] mb-3">Contract timeline</p>
        <svg width={PW} height={TH} viewBox={`0 0 ${PW} ${TH}`} className="w-full overflow-visible">

          {/* Base track */}
          <rect x={tx1} y={trackY - 4} width={trackW} height={8} rx={4} fill="#E8F0E9" />

          {/* Discount bands */}
          {discounts.map((d, i) => {
            if (!d.start_date || !d.end_date) return null
            const x1 = txOf(parseLocalDate(d.start_date))
            const x2 = txOf(parseLocalDate(d.end_date))
            return <rect key={i} x={x1} y={trackY - 4} width={Math.max(0, x2 - x1)} height={8} rx={2} fill="#B8E0CC" />
          })}

          {/* Renewal window */}
          {renewalStart && clampPos(renewalStart) < 1 && (
            <rect
              x={txOf(renewalStart)} y={trackY - 4}
              width={Math.max(0, txOf(end) - txOf(renewalStart))}
              height={8}
              fill="#FAC775" opacity={0.65}
            />
          )}

          {/* Elapsed portion */}
          <rect
            x={tx1} y={trackY - 4}
            width={Math.min(Math.max(0, todayX - tx1), trackW)}
            height={8} rx={4}
            fill="#1A3D2B" opacity={0.55}
          />

          {/* Escalator tick markers */}
          {escalators.map((e, i) => {
            if (!e.effective_date) return null
            const ex = txOf(parseLocalDate(e.effective_date))
            return (
              <g key={i}>
                <line x1={ex} y1={trackY - 16} x2={ex} y2={trackY + 5} stroke="#27AE60" strokeWidth={1.5} />
                <circle cx={ex} cy={trackY - 18} r={3} fill="#27AE60" />
              </g>
            )
          })}

          {/* Today marker */}
          {todayFrac >= 0 && todayFrac <= 1 && (
            <g>
              <line x1={todayX} y1={trackY - 22} x2={todayX} y2={trackY + 14} stroke="#1A3D2B" strokeWidth={1.5} strokeDasharray="3 2" />
              <text x={todayX} y={trackY - 25} textAnchor="middle" fontSize={9} fill="#1A3D2B" fontWeight={700}>today</text>
            </g>
          )}

          {/* Date labels */}
          <text x={tx1} y={trackY + 22} fontSize={9} fill="#9CA3AF" textAnchor="start">{fmtShort(start)}</text>
          <text x={tx2} y={trackY + 22} fontSize={9} fill="#9CA3AF" textAnchor="end">{fmtShort(end)}</text>

          {/* Legend */}
          {[
            discounts.length > 0  ? { color: '#B8E0CC', label: 'Discount' }        : null,
            escalators.length > 0 ? { color: '#27AE60', label: 'Escalator' }       : null,
            renewalStart           ? { color: '#FAC775', label: 'Renewal window' } : null,
          ].filter((x): x is { color: string; label: string } => x !== null).map((li, i) => (
            <g key={i} transform={`translate(${tx1 + i * 96}, ${TH - 6})`}>
              <rect width={7} height={7} rx={1.5} fill={li.color} opacity={0.9} />
              <text x={10} y={6.5} fontSize={8.5} fill="#9CA3AF">{li.label}</text>
            </g>
          ))}
        </svg>

        {/* Progress bar */}
        <div className="flex items-center gap-2 mt-1">
          <div className="flex-1 h-1 bg-forest/8 rounded-full overflow-hidden">
            <div className="h-full bg-forest rounded-full" style={{ width: `${Math.min(100, Math.round(todayFrac * 100))}%` }} />
          </div>
          <span className="text-[10px] text-stone font-medium whitespace-nowrap">
            {elapsedMonths} / {months.length} mo
          </span>
        </div>
      </div>

      {/* ── Revenue waterfall ─────────────────────── */}
      <div>
        <div className="flex items-baseline justify-between mb-3">
          <p className="text-[10px] font-bold text-stone uppercase tracking-[0.14em]">Revenue build-up</p>
          <span className="text-[9px] text-stone">{useAnnual ? 'by year' : 'by month'}</span>
        </div>
        <svg width={PW} height={WH} viewBox={`0 0 ${PW} ${WH}`} className="w-full overflow-visible">

          {/* Baseline */}
          <line x1={px1} y1={plotBottom} x2={px2} y2={plotBottom} stroke="#E8F0E9" strokeWidth={1} />

          {/* Connector ties */}
          {positioned.slice(0, -1).map((b, i) => {
            const xRight = px1 + i * (barW + barGap) + barW
            const xLeft  = px1 + (i + 1) * (barW + barGap)
            const y = yOf(b.to)
            return <line key={`c${i}`} x1={xRight} y1={y} x2={xLeft} y2={y} stroke="#C9CCC6" strokeWidth={1} strokeDasharray="2 2" />
          })}

          {/* Bars */}
          {positioned.map((b, i) => {
            const x    = px1 + i * (barW + barGap)
            const yTop = yOf(b.to)
            const yBot = yOf(b.from)
            const h    = Math.max(1.5, yBot - yTop)
            return (
              <g key={i}>
                <rect x={x} y={yTop} width={barW} height={h} rx={1.5} fill={b.color}>
                  <title>{b.tooltip}</title>
                </rect>
                {(b.kind === 'onetime' || b.kind === 'total' || useAnnual) && (
                  <text x={x + barW / 2} y={yTop - 5} textAnchor="middle" fontSize={8.5} fontWeight={b.kind === 'total' ? 700 : 600} fill="#4A4640">
                    {fmt(b.amount, cur).replace(/\.00$/, '')}
                  </text>
                )}
                <text
                  x={x + barW / 2}
                  y={plotBottom + (rotateLabels ? 9 : 13)}
                  textAnchor={rotateLabels ? 'end' : 'middle'}
                  fontSize={8.5}
                  fill="#9CA3AF"
                  transform={rotateLabels ? `rotate(-55 ${x + barW / 2} ${plotBottom + 9})` : undefined}
                >
                  {b.label}
                </text>
              </g>
            )
          })}
        </svg>

        {/* Chart legend */}
        <div className="flex items-center flex-wrap gap-x-4 gap-y-1 mt-1">
          {oneTimeBars.length > 0 && (
            <div className="flex items-center gap-1">
              <div className="w-2.5 h-2.5 rounded-sm bg-[#D9A35A]" />
              <span className="text-[9px] text-stone">One-time</span>
            </div>
          )}
          <div className="flex items-center gap-1">
            <div className="w-2.5 h-2.5 rounded-sm bg-[#27AE60]" />
            <span className="text-[9px] text-stone">Recurring</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2.5 h-2.5 rounded-sm bg-[#1A3D2B]" />
            <span className="text-[9px] text-stone">TCV</span>
          </div>
        </div>
      </div>

      {/* ── Financial summary ─────────────────────── */}
      <div className="border-t border-forest/8 pt-4 space-y-2.5">
        <div className="flex justify-between items-baseline">
          <span className="text-[10px] font-semibold text-stone uppercase tracking-[0.1em]">Total contract value</span>
          <span className="text-sm font-semibold text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(grandTotal, cur)}</span>
        </div>
        {oneTimeTotal > 0 && (
          <div className="flex justify-between items-baseline">
            <span className="text-[10px] text-stone">incl. one-time fees</span>
            <span className="text-xs font-medium" style={{ color: '#B9802F', fontVariantNumeric: 'tabular-nums' }}>{fmt(oneTimeTotal, cur)}</span>
          </div>
        )}
        <div className="flex justify-between items-baseline">
          <span className="text-[10px] text-stone">Billed to date</span>
          <span className="text-xs font-medium text-forest" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(billedToDate, cur)}</span>
        </div>
        <div className="flex justify-between items-baseline">
          <span className="text-[10px] text-stone">Remaining</span>
          <span className="text-xs font-medium text-stone" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(grandTotal - billedToDate, cur)}</span>
        </div>
        {discountSaving > 0 && (
          <div className="flex justify-between items-baseline pt-2.5 border-t border-forest/8">
            <span className="text-[10px] text-stone">Discount saving</span>
            <span className="text-xs font-medium text-[#4A7C59]" style={{ fontVariantNumeric: 'tabular-nums' }}>-{fmt(discountSaving, cur)}</span>
          </div>
        )}
      </div>

    </div>
  )
}

// ── Review panel helpers ───────────────────────────────────────────────────

type ItemKind = 'overage_tier' | 'escalator' | 'base_fee' | 'user_seat' | 'one_time' | 'unknown'

function classifyItem(item: LineItem): ItemKind {
  const rule = (item.applied_rule ?? '').toLowerCase()
  const name = item.product_name.toLowerCase()
  if (rule.includes('escalator') || name.includes('escalator') || name.includes('cpi') || name.includes('price escalator')) return 'escalator'
  if (rule.includes('overage') || name.includes('overage') || name.includes('tier')) return 'overage_tier'
  if (name.includes('user') || name.includes('seat') || name.includes('license')) return 'user_seat'
  if (item.billing_period === 'one_time' || rule.includes('one_time') || name.includes('setup') || name.includes('onboarding')) return 'one_time'
  if (rule.includes('base') || name.includes('base') || name.includes('subscription') || name.includes('platform')) return 'base_fee'
  return 'unknown'
}

type ReviewContext = {
  typeLabel: string
  typeIcon: string
  whatToCheck: string
  primaryField: 'unit_price' | 'product_name'
  primaryLabel: string
  primaryPlaceholder: string
  whyFlagged: string
}

function getReviewContext(item: LineItem, kind: ItemKind): ReviewContext {
  const score = item.confidence_score
  const lowBecause = score < 0.7
    ? 'The AI had low confidence extracting this — the contract wording may be ambiguous or in an unusual format.'
    : score < 0.85
    ? 'The AI found this value but wasn\'t fully certain. A similar clause nearby may have caused confusion.'
    : 'The AI found this but flagged it for human confirmation due to its billing impact.'

  switch (kind) {
    case 'overage_tier':
      return {
        typeLabel:          'Overage pricing tier',
        typeIcon:           'ti-chart-bar',
        primaryField:       'unit_price',
        primaryLabel:       'Rate per unit',
        primaryPlaceholder: `e.g. ${item.unit_price || 0}`,
        whatToCheck:        `Verify the per-unit rate (${fmt(item.unit_price, item.currency)}/unit) matches the contract. This rate is used to automatically calculate overage charges each billing cycle.`,
        whyFlagged:         lowBecause,
      }
    case 'escalator':
      return {
        typeLabel:          'Price escalator',
        typeIcon:           'ti-trending-up',
        primaryField:       'unit_price',
        primaryLabel:       'Escalation rate (%)',
        primaryPlaceholder: 'e.g. 3',
        whatToCheck:        `Verify the escalation percentage and method. Verdix applies this automatically each contract year to calculate the correct base fee. An incorrect rate here will silently under-bill every renewal.`,
        whyFlagged:         lowBecause,
      }
    case 'user_seat':
      return {
        typeLabel:          'Per-seat pricing',
        typeIcon:           'ti-users',
        primaryField:       'unit_price',
        primaryLabel:       'Price per seat',
        primaryPlaceholder: `e.g. ${item.unit_price || 0}`,
        whatToCheck:        `Verify the per-seat rate (${fmt(item.unit_price, item.currency)}/seat). This is used to calculate charges when the customer exceeds their included seat count.`,
        whyFlagged:         lowBecause,
      }
    case 'one_time':
      return {
        typeLabel:          'One-time fee',
        typeIcon:           'ti-receipt',
        primaryField:       'unit_price',
        primaryLabel:       'Fee amount',
        primaryPlaceholder: `e.g. ${item.unit_price || 0}`,
        whatToCheck:        `Verify the one-time fee amount (${fmt(item.unit_price, item.currency)}). This will be invoiced once at the start of the contract.`,
        whyFlagged:         lowBecause,
      }
    case 'base_fee':
      return {
        typeLabel:          'Base subscription fee',
        typeIcon:           'ti-file-invoice',
        primaryField:       'unit_price',
        primaryLabel:       'Fee amount',
        primaryPlaceholder: `e.g. ${item.unit_price || 0}`,
        whatToCheck:        `Verify the base fee amount (${fmt(item.unit_price, item.currency)}). This is the recurring charge billed each ${item.billing_period ?? 'period'}.`,
        whyFlagged:         lowBecause,
      }
    default:
      return {
        typeLabel:          'Line item',
        typeIcon:           'ti-file-text',
        primaryField:       'product_name',
        primaryLabel:       'Description',
        primaryPlaceholder: 'Enter correct description…',
        whatToCheck:        'Review this item and confirm or correct the extracted value.',
        whyFlagged:         lowBecause,
      }
  }
}

// ── Review panel ──────────────────────────────────────────────────────────

function ReviewPanel({
  items,
  corrections,
  onCorrect,
  onClose,
  onRefresh,
  jobId,
}: {
  items: LineItem[]
  corrections: Record<string, { value: string; remember: boolean }>
  onCorrect: (itemId: string, value: string) => void
  onClose: () => void
  onRefresh: () => void
  jobId: string
}) {
  const [saving,    setSaving]    = useState<string | null>(null)
  const [resolved,  setResolved]  = useState<Record<string, 'confirmed' | 'corrected'>>({})
  const [editing,   setEditing]   = useState<string | null>(null)
  const [draftPrice, setDraftPrice] = useState<Record<string, string>>({})
  const [draftName,  setDraftName]  = useState<Record<string, string>>({})

  const resolvedCount = items.filter(i => resolved[i.id] || corrections[i.id]?.value).length
  const allDone = resolvedCount === items.length

  // Group by source_section so the same section header doesn't repeat per card
  const groups = items.reduce<Record<string, LineItem[]>>((acc, item) => {
    const key = item.source_section ?? 'Other'
    acc[key] = acc[key] ?? []
    acc[key].push(item)
    return acc
  }, {})

  const confirmItem = async (item: LineItem) => {
    setSaving(item.id)
    try {
      // Record as confirmed (no change needed) so future extractions learn this is acceptable
      await fetch('/api/corrections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId,
          fieldName:         'product_name',
          extractedValue:    item.product_name,
          correctedValue:    item.product_name,
          correctionReason:  'confirmed_correct',
          applyToFuture:     true,
        }),
      })
      onCorrect(item.id, item.product_name)
      setResolved(r => ({ ...r, [item.id]: 'confirmed' }))
      setEditing(null)
    } finally {
      setSaving(null)
    }
  }

  const saveCorrection = async (item: LineItem, ctx: ReviewContext) => {
    setSaving(item.id)
    try {
      if (ctx.primaryField === 'unit_price') {
        const raw   = draftPrice[item.id]?.trim()
        const price = raw ? parseFloat(raw.replace(/[^0-9.]/g, '')) : null

        if (price !== null && !isNaN(price)) {
          // Update the line item record directly
          await fetch(`/api/jobs/${jobId}/line-items`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              itemId: item.id,
              fields: { unit_price: price, total_amount: price * (item.quantity || 1) },
            }),
          })
          // Log the correction for future learning
          await fetch('/api/corrections', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jobId,
              fieldName:        'unit_price',
              extractedValue:   String(item.unit_price),
              correctedValue:   String(price),
              correctionReason: `Corrected rate for: ${item.product_name}`,
              applyToFuture:    true,
            }),
          })
          onCorrect(item.id, String(price))
        }
      } else {
        const name = draftName[item.id]?.trim()
        if (!name) return
        await fetch('/api/corrections', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jobId,
            fieldName:        'product_name',
            extractedValue:   item.product_name,
            correctedValue:   name,
            applyToFuture:    true,
          }),
        })
        onCorrect(item.id, name)
      }

      setResolved(r => ({ ...r, [item.id]: 'corrected' }))
      setEditing(null)
      onRefresh()
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative h-full bg-white shadow-2xl flex flex-col" style={{ width: 480 }}>

        {/* Header */}
        <div className="flex-shrink-0 px-6 py-4 border-b border-forest/10 flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-ink">Review extracted values</p>
            <p className="text-xs text-stone mt-0.5">
              {resolvedCount} of {items.length} resolved
              {allDone && <span className="ml-1.5 font-medium" style={{ color: '#0B5C36' }}>· Ready to approve</span>}
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-cream text-stone hover:text-ink transition-colors"
          >
            <i className="ti ti-x" style={{ fontSize: 14 }} />
          </button>
        </div>

        {/* Progress bar */}
        <div className="h-1 flex-shrink-0" style={{ background: 'rgba(26,61,43,0.08)' }}>
          <div
            className="h-full transition-all duration-500"
            style={{
              width:      `${items.length > 0 ? (resolvedCount / items.length) * 100 : 0}%`,
              background: allDone ? '#0B5C36' : '#D97706',
            }}
          />
        </div>

        {/* Item list */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {Object.entries(groups).map(([section, groupItems]) => (
            <div key={section}>
              {/* Section header from contract */}
              <div className="flex items-center gap-2 mb-3">
                <p className="text-[10px] font-bold uppercase tracking-widest text-stone">
                  Contract §{section}
                </p>
                <div className="flex-1 h-px" style={{ background: 'rgba(26,61,43,0.1)' }} />
              </div>

              <div className="space-y-3">
                {groupItems.map(item => {
                  const kind        = classifyItem(item)
                  const ctx         = getReviewContext(item, kind)
                  const isResolved  = !!(resolved[item.id] || corrections[item.id]?.value)
                  const isEditing   = editing === item.id
                  const isSaving    = saving === item.id
                  const score       = item.confidence_score
                  const scoreColor  = score < 0.7 ? '#DC2626' : score < 0.85 ? '#D97706' : '#6B7280'

                  return (
                    <div
                      key={item.id}
                      className="rounded-2xl border overflow-hidden transition-colors"
                      style={{
                        borderColor: isResolved ? 'rgba(11,92,54,0.2)' : '#FAC775',
                        background:  isResolved ? '#F8FDF9' : 'white',
                      }}
                    >
                      {/* Card top: type + confidence */}
                      <div className="px-4 pt-4 pb-3">
                        <div className="flex items-center justify-between mb-2.5">
                          <div className="flex items-center gap-1.5">
                            <i className={`ti ${ctx.typeIcon} text-stone`} style={{ fontSize: 12 }} />
                            <span className="text-[10px] font-semibold uppercase tracking-widest text-stone">
                              {ctx.typeLabel}
                            </span>
                          </div>
                          <span
                            className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
                            style={{ color: scoreColor, background: `${scoreColor}15` }}
                          >
                            {Math.round(score * 100)}% confidence
                          </span>
                        </div>

                        {/* Extracted name */}
                        <p className="text-sm font-medium text-ink leading-snug mb-2">
                          {item.product_name}
                        </p>

                        {/* Key values row */}
                        <div className="flex flex-wrap gap-3 mb-3">
                          <div className="text-xs">
                            <span className="text-stone">Rate · </span>
                            <span className="font-semibold text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>
                              {fmt(item.unit_price, item.currency)}/unit
                            </span>
                          </div>
                          {item.quantity > 0 && (
                            <div className="text-xs">
                              <span className="text-stone">Qty · </span>
                              <span className="font-semibold text-ink">{item.quantity}</span>
                            </div>
                          )}
                          <div className="text-xs">
                            <span className="text-stone">Billing · </span>
                            <span className="font-semibold text-ink">{item.billing_period}</span>
                          </div>
                        </div>

                        {/* What to check */}
                        <div className="rounded-xl p-3 mb-3" style={{ background: '#FFFBEB', border: '1px solid #FDE68A' }}>
                          <p className="text-[10px] font-bold uppercase tracking-widest mb-1" style={{ color: '#92400E' }}>
                            <i className="ti ti-eye mr-1" />What to verify
                          </p>
                          <p className="text-xs leading-relaxed" style={{ color: '#78350F' }}>
                            {ctx.whatToCheck}
                          </p>
                        </div>

                        {/* Why flagged */}
                        <p className="text-[11px] text-stone leading-relaxed mb-3">
                          <span className="font-medium">Why flagged: </span>
                          {ctx.whyFlagged}
                        </p>

                        {/* Actions or edit form */}
                        {isResolved ? (
                          <div className="flex items-center gap-2">
                            <i
                              className={`ti ${resolved[item.id] === 'corrected' ? 'ti-edit-circle' : 'ti-circle-check-filled'} flex-shrink-0`}
                              style={{ fontSize: 15, color: '#0B5C36' }}
                            />
                            <span className="text-sm font-medium" style={{ color: '#0B5C36' }}>
                              {resolved[item.id] === 'corrected' ? 'Correction saved' : 'Confirmed correct'}
                            </span>
                            <button
                              onClick={() => {
                                setResolved(r => { const n = { ...r }; delete n[item.id]; return n })
                                onCorrect(item.id, '')
                                setEditing(item.id)
                              }}
                              className="ml-auto text-xs text-stone hover:text-ink underline underline-offset-2"
                            >
                              Undo
                            </button>
                          </div>
                        ) : isEditing ? (
                          <div className="space-y-2">
                            <label className="text-[10px] font-bold uppercase tracking-widest text-stone block">
                              {ctx.primaryLabel}
                            </label>
                            {ctx.primaryField === 'unit_price' ? (
                              <input
                                type="number"
                                placeholder={ctx.primaryPlaceholder}
                                value={draftPrice[item.id] ?? ''}
                                onChange={e => setDraftPrice(d => ({ ...d, [item.id]: e.target.value }))}
                                onKeyDown={e => { if (e.key === 'Enter') saveCorrection(item, ctx) }}
                                className="w-full text-sm border rounded-xl px-3 py-2 outline-none"
                                style={{ borderColor: '#FAC775', background: '#FFFDF5' }}
                                autoFocus
                              />
                            ) : (
                              <input
                                type="text"
                                placeholder={ctx.primaryPlaceholder}
                                value={draftName[item.id] ?? item.product_name}
                                onChange={e => setDraftName(d => ({ ...d, [item.id]: e.target.value }))}
                                onKeyDown={e => { if (e.key === 'Enter') saveCorrection(item, ctx) }}
                                className="w-full text-sm border rounded-xl px-3 py-2 outline-none"
                                style={{ borderColor: '#FAC775', background: '#FFFDF5' }}
                                autoFocus
                              />
                            )}
                            <div className="flex gap-2">
                              <button
                                onClick={() => saveCorrection(item, ctx)}
                                disabled={isSaving}
                                className="flex-1 py-2 rounded-xl text-sm font-semibold transition-colors disabled:opacity-40"
                                style={{ background: '#1A3D2B', color: 'white' }}
                              >
                                {isSaving
                                  ? <i className="ti ti-loader-2 animate-spin" style={{ fontSize: 13 }} />
                                  : 'Save correction'
                                }
                              </button>
                              <button
                                onClick={() => setEditing(null)}
                                className="px-4 py-2 rounded-xl text-sm text-stone hover:text-ink border transition-colors"
                                style={{ borderColor: 'rgba(26,61,43,0.15)' }}
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex gap-2">
                            <button
                              onClick={() => confirmItem(item)}
                              disabled={isSaving}
                              className="flex-1 py-2 rounded-xl text-sm font-semibold border transition-colors disabled:opacity-40"
                              style={{ borderColor: 'rgba(26,61,43,0.25)', color: '#1A3D2B', background: '#F0FDF4' }}
                            >
                              {isSaving
                                ? <i className="ti ti-loader-2 animate-spin" style={{ fontSize: 13 }} />
                                : <><i className="ti ti-check mr-1.5" style={{ fontSize: 12 }} />Looks correct</>
                              }
                            </button>
                            <button
                              onClick={() => setEditing(item.id)}
                              className="flex-1 py-2 rounded-xl text-sm font-semibold transition-colors"
                              style={{ background: '#1A3D2B', color: 'white' }}
                            >
                              <i className="ti ti-edit mr-1.5" style={{ fontSize: 12 }} />
                              Correct value
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 px-6 py-4 border-t border-forest/10">
          {allDone ? (
            <div className="flex items-center gap-2 text-sm font-medium" style={{ color: '#0B5C36' }}>
              <i className="ti ti-circle-check-filled" style={{ fontSize: 16 }} />
              All items resolved — close and approve
            </div>
          ) : (
            <p className="text-xs text-stone leading-relaxed">
              For each item: confirm it looks correct, or correct the value. Open the signed contract in the PDF viewer to cross-check.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Processing messages ────────────────────────────────────────────────────

const PROCESSING_MESSAGES = [
  'Downloading signed contract...',
  'Identifying financial pages...',
  'Extracting commercial terms...',
  'Proposing billing configuration...',
]

// ── Page ───────────────────────────────────────────────────────────────────

export default function ConfigureResultsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [job, setJob]         = useState<Job | null>(null)
  const [items, setItems]     = useState<LineItem[]>([])
  const [msgIdx, setMsgIdx]   = useState(0)
  const [corrections, setCorrections] = useState<Record<string, { value: string; remember: boolean }>>({})
  const [approving, setApproving]     = useState(false)
  const [approveError, setApproveError] = useState<string | null>(null)
  const [approved, setApproved]       = useState<{ stripeSubscriptionId: string; dashboardUrl?: string } | null>(null)
  const [drawer, setDrawer]   = useState<{ open: boolean; section?: string }>({ open: false })
  const [pdfUrl, setPdfUrl]   = useState<string | null>(null)
  const [pdfUrlError, setPdfUrlError] = useState(false)
  const [pdfRenderKey, setPdfRenderKey] = useState(0)
  const [panelWidth, setPanelWidth] = useState(60)   // % of viewport
  const isDragging  = useRef(false)
  const dragOrigin  = useRef({ x: 0, w: 0 })

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isDragging.current) return
      const delta = dragOrigin.current.x - e.clientX          // drag left → widen
      const next  = dragOrigin.current.w + (delta / window.innerWidth) * 100
      setPanelWidth(Math.min(85, Math.max(30, next)))
    }
    const onUp = () => {
      if (isDragging.current) setPdfRenderKey(k => k + 1)  // re-render PDF at new panel width
      isDragging.current = false
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [])

  // Fetch a fresh signed URL whenever the PDF drawer opens (stored URL may be expired)
  useEffect(() => {
    if (!drawer.open || pdfUrl) return
    setPdfUrlError(false)
    fetch(`/api/jobs/${id}/pdf-url`)
      .then(async r => {
        if (!r.ok) throw new Error(`${r.status}`)
        const { url } = await r.json()
        setPdfUrl(url)
      })
      .catch(() => setPdfUrlError(true))
  }, [drawer.open, id, pdfUrl])

  const [activeTab, setActiveTab]       = useState<'terms' | 'model' | 'invoices'>('terms')
  const [reviewPanelOpen, setReviewPanelOpen] = useState(false)
  const [escEditing,   setEscEditing]   = useState<number | null>(null)
  const [escEditValue, setEscEditValue] = useState('')
  const [escSaving,    setEscSaving]    = useState(false)
  const [dateDraftStart, setDateDraftStart] = useState('')
  const [dateDraftEnd,   setDateDraftEnd]   = useState('')
  const [dateEditing,    setDateEditing]    = useState<'start' | 'end' | null>(null)
  const [dateSaving,     setDateSaving]     = useState(false)

  const terms: Terms | undefined = job?.contract_terms?.[0]
  const cur = terms?.currency ?? job?.currency ?? 'EUR'

  const needsReview = items.filter(i => i.confidence_score < 0.95 && !corrections[i.id]?.value).length

  const fetchJob = async () => {
    const res = await fetch(`/api/jobs/${id}`)
    if (!res.ok) return
    const data = await res.json()
    setJob(data)
    if (data.line_items?.length) setItems(data.line_items)
    return data
  }

  useEffect(() => {
    const poll = async () => {
      const data = await fetchJob()
      if (!data) return
      if (['PENDING_HUMAN_REVIEW', 'READY_TO_APPROVE', 'COMPLETED', 'FAILED'].includes(data.execute_status)) return
      setTimeout(poll, 3000)
    }
    poll()
    const cycle = setInterval(() => setMsgIdx(i => (i + 1) % PROCESSING_MESSAGES.length), 2000)
    return () => clearInterval(cycle)
  }, [id])

  const saveEscalatorPct = async (idx: number) => {
    const pct = parseFloat(escEditValue.replace(/[^0-9.]/g, ''))
    if (isNaN(pct) || !terms?.escalators) return
    setEscSaving(true)
    try {
      const newEscalators = terms.escalators.map((e, i) => i === idx ? { ...e, escalator_pct: pct } : e)
      await fetch(`/api/jobs/${id}/terms`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ escalators: newEscalators }),
      })
      setEscEditing(null)
      await fetchJob()
    } finally {
      setEscSaving(false)
    }
  }

  const saveField = async (field: string, raw: string) => {
    const numFields = ['contract_term_months', 'payment_terms_days', 'base_monthly_fee', 'base_annual_fee']
    const body: Record<string, unknown> = {}
    if (numFields.includes(field)) {
      const n = parseFloat(raw.replace(/[^0-9.]/g, ''))
      if (isNaN(n)) return
      body[field] = n
    } else {
      body[field] = raw
    }
    await fetch(`/api/jobs/${id}/terms`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    await fetchJob()
  }

  const saveDateField = async (field: 'start' | 'end') => {
    const value = field === 'start' ? dateDraftStart : dateDraftEnd
    if (!value) return
    setDateSaving(true)
    try {
      const key = field === 'start' ? 'contract_start_date' : 'contract_end_date'
      await fetch(`/api/jobs/${id}/terms`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: value }),
      })
      setDateEditing(null)
      await fetchJob()
    } finally {
      setDateSaving(false)
    }
  }

  const openPDF = (section?: string) => setDrawer({ open: true, section })
  const closePDF = () => { setDrawer({ open: false }); setPdfUrl(null); setPdfUrlError(false) }

  const correction = (itemId: string) => corrections[itemId]?.value ?? ''
  const setCorr    = (itemId: string, value: string) =>
    setCorrections(c => ({ ...c, [itemId]: { value, remember: c[itemId]?.remember ?? true } }))

  const findItem = (keyword: string) => items.find(i => i.product_name.toLowerCase().includes(keyword.toLowerCase()))

  const handleApprove = async () => {
    setApproving(true)
    setApproveError(null)
    const modifiedItems = items.map(i => ({
      ...i,
      product_name: corrections[i.id]?.value || i.product_name,
    }))

    const corrSaves = Object.entries(corrections)
      .filter(([, c]) => c.value)
      .map(([itemId, c]) => {
        const item = items.find(i => i.id === itemId)
        return fetch('/api/corrections', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jobId: id, fieldName: 'product_name',
            extractedValue: item?.product_name, correctedValue: c.value,
            customerName: terms?.customer_name, applyToFuture: c.remember,
          }),
        })
      })
    await Promise.all(corrSaves)

    try {
      const res  = await fetch(`/api/jobs/${id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modifiedLineItems: modifiedItems }),
      })
      const data = await res.json()
      if (data.success) {
        setApproved({ stripeSubscriptionId: data.stripeSubscriptionId, dashboardUrl: data.dashboardUrl })
      } else {
        setApproveError(data.error ?? 'Billing configuration failed. Please try again.')
      }
    } catch {
      setApproveError('Network error — please check your connection and try again.')
    } finally {
      setApproving(false)
    }
  }

  // ── Loading / error states ────────────────────────────────────────────────

  if (!job) return (
    <div className="flex items-center justify-center h-full">
      <div className="w-8 h-8 border-2 border-forest border-t-transparent rounded-full animate-spin" />
    </div>
  )

  const isProcessing = !['PENDING_HUMAN_REVIEW', 'READY_TO_APPROVE', 'COMPLETED', 'FAILED'].includes(job.execute_status)

  if (isProcessing) return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center max-w-sm">
        <div className="w-12 h-12 border-2 border-forest border-t-transparent rounded-full animate-spin mx-auto mb-6" />
        <p className="text-ink font-medium mb-2">{PROCESSING_MESSAGES[msgIdx]}</p>
        <p className="text-stone text-sm">Usually takes under a minute</p>
      </div>
    </div>
  )

  if (job.execute_status === 'FAILED') return (
    <div className="p-8 flex items-center justify-center h-full">
      <div className="text-center max-w-sm">
        <i className="ti ti-alert-circle text-danger block mb-4" style={{ fontSize: 40 }} />
        <h2 className="font-medium text-ink text-lg mb-2">Processing failed</h2>
        <p className="text-stone text-sm mb-6">{job.error_message}</p>
        <Link href="/configure/new" className="bg-forest text-white text-sm font-medium px-4 py-2 rounded-xl hover:bg-sage transition-colors">Try again</Link>
      </div>
    </div>
  )

  // ── Main view ─────────────────────────────────────────────────────────────
  const isConfigured = job.execute_status === 'COMPLETED' || !!approved
  const subId = approved?.stripeSubscriptionId ?? job.billing_subscription_id ?? null
  const billingPlatform = approved
    ? (approved.dashboardUrl?.includes('chargebee') ? 'chargebee' : 'stripe')
    : (job.billing_platform ?? 'stripe')
  const dashboardUrl = approved?.dashboardUrl
    ?? (subId && billingPlatform === 'stripe'
      ? `https://dashboard.stripe.com/test/subscriptions/${subId}`
      : subId && billingPlatform === 'chargebee'
      ? `https://app.chargebee.com/subscriptions/${subId}`
      : null)

  const tiers = terms?.overage_tiers ?? []
  const userTiers  = tiers.filter(t => t.unit_type?.toLowerCase().includes('user'))
  const apiTiers   = tiers.filter(t => t.unit_type?.toLowerCase().includes('api') || t.unit_type?.toLowerCase().includes('call'))
  const otherTiers = tiers.filter(t => !userTiers.includes(t) && !apiTiers.includes(t))

  const src = terms?.field_sources ?? {}
  const tcv = computeContractTCV(terms, items)

  const baseItem = findItem('base subscription')

  return (
    <>
      {/* ── Two-column shell ──────────────────────────────────────────────── */}
      <div className="h-full flex flex-col bg-cream">

        {/* Sticky header */}
        <div className="flex-shrink-0 bg-white/95 backdrop-blur border-b border-forest/10 px-8 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/configure" className="text-stone hover:text-forest text-sm flex items-center gap-1 transition-colors">
              <i className="ti ti-arrow-left" style={{ fontSize: 13 }} /> Back
            </Link>
            <div className="h-4 w-px bg-forest/15" />
            <div>
              <span className="font-medium text-ink text-sm">{job.name}</span>
              {terms?.customer_name && <span className="text-stone text-sm ml-2">· {terms.customer_name}</span>}
            </div>
            <div className="h-4 w-px bg-forest/15" />
            {/* Tab nav */}
            <div className="flex items-center gap-0.5 bg-forest/6 rounded-lg p-0.5">
              {(['terms', 'model', 'invoices'] as const).map(tab => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className="text-xs font-medium px-3 py-1.5 rounded-md transition-colors"
                  style={activeTab === tab
                    ? { background: 'white', color: '#1A3D2B', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }
                    : { color: '#6B6660' }
                  }
                >
                  {tab === 'terms' ? 'Contract terms' : tab === 'model' ? 'Revenue model' : 'Invoices'}
                </button>
              ))}
            </div>
          </div>
          {isConfigured ? (
            <span className="text-xs font-semibold px-3 py-1 rounded-full flex items-center gap-1.5" style={{ background: '#D4EAD9', border: '1px solid rgba(74,124,89,0.3)', color: '#1A3D2B' }}>
              <i className="ti ti-circle-check" style={{ fontSize: 12 }} /> Configured in Stripe
            </span>
          ) : needsReview > 0 ? (
            <button
              onClick={() => setReviewPanelOpen(true)}
              className="text-xs font-semibold px-3 py-1 rounded-full flex items-center gap-1.5 transition-opacity hover:opacity-80"
              style={{ background: '#FAEEDA', border: '1px solid #FAC775', color: '#633806' }}
            >
              <i className="ti ti-alert-triangle" style={{ fontSize: 11 }} />
              {needsReview} item{needsReview > 1 ? 's' : ''} need review
              <i className="ti ti-chevron-right" style={{ fontSize: 11 }} />
            </button>
          ) : (
            <span className="text-xs font-semibold px-3 py-1 rounded-full flex items-center gap-1.5" style={{ background: '#D4EAD9', border: '1px solid rgba(74,124,89,0.3)', color: '#1A3D2B' }}>
              <i className="ti ti-circle-check" style={{ fontSize: 12 }} /> Ready to approve
            </span>
          )}
        </div>

        {/* Content row */}
        <div className="flex flex-1 overflow-hidden">

          {/* ── Model tab: full screen ────────────────────────────────────── */}
          {activeTab === 'model' && terms && (
            <RevenueModelTab terms={terms} items={items} cur={cur} jobId={id} onSaved={fetchJob} />
          )}
          {activeTab === 'model' && !terms && (
            <div className="flex-1 flex items-center justify-center text-stone text-sm">
              No contract terms available for modeling.
            </div>
          )}

          {/* ── Invoices tab ─────────────────────────────────────────────── */}
          {activeTab === 'invoices' && (
            <div className="flex-1 overflow-y-auto">
              <InvoicesTab jobId={id} />
            </div>
          )}

          {/* ── Terms tab: single-column contract detail ──────────────────── */}
          <div className={`flex-1 overflow-y-auto px-8 py-8 space-y-6 ${activeTab !== 'terms' ? 'hidden' : ''}`}>

            {/* Stripe configured banner */}
            {isConfigured && (
              <div className="bg-forest text-white rounded-2xl px-6 py-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center flex-shrink-0">
                    <i className="ti ti-circle-check text-mint" style={{ fontSize: 16 }} />
                  </div>
                  <div>
                    <p className="text-sm font-medium">Billing configured in {billingPlatform === 'chargebee' ? 'Chargebee' : 'Stripe'}</p>
                    {subId && <p className="text-mint/60 text-[11px] font-mono mt-0.5">{subId}</p>}
                  </div>
                </div>
                {dashboardUrl && (
                  <a
                    href={dashboardUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="flex-shrink-0 inline-flex items-center gap-1.5 bg-white/10 hover:bg-white/20 border border-white/20 text-white text-xs font-semibold px-4 py-2 rounded-xl transition-colors"
                  >
                    View in {billingPlatform === 'chargebee' ? 'Chargebee' : 'Stripe'} →
                  </a>
                )}
              </div>
            )}

            {/* Contract overview card */}
            <div className="bg-white rounded-2xl border border-forest/10 p-6">
              <h2 className="text-[10px] font-bold text-stone uppercase tracking-[0.14em] mb-5">Contract overview</h2>
              <div className="grid grid-cols-3 gap-x-8 gap-y-6">
                <EditableStat
                  label="Customer"
                  value={terms?.customer_name}
                  sub={terms?.customer_address ?? undefined}
                  onSave={v => saveField('customer_name', v)}
                />

                {/* Contract term — special: start and end date each independently editable */}
                <div className="group">
                  <p className="text-[10px] font-semibold text-stone uppercase tracking-[0.12em] mb-1.5">Contract term</p>
                  <p className="text-[15px] font-medium text-ink leading-snug">
                    {terms?.contract_term_months ? `${terms.contract_term_months} months` : '—'}
                  </p>
                  {/* Date range row */}
                  <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                    {/* Start date */}
                    {dateEditing === 'start' ? (
                      <div className="flex items-center gap-1">
                        <input
                          autoFocus
                          type="date"
                          value={dateDraftStart}
                          onChange={e => setDateDraftStart(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') saveDateField('start'); if (e.key === 'Escape') setDateEditing(null) }}
                          className="text-[11px] border border-forest/30 rounded px-1.5 py-0.5 outline-none focus:border-forest"
                        />
                        <button onClick={() => setDateEditing(null)} className="text-stone/50 hover:text-ink transition-colors" title="Cancel">
                          <i className="ti ti-x" style={{ fontSize: 11 }} />
                        </button>
                        <button
                          onClick={() => saveDateField('start')}
                          disabled={dateSaving || !dateDraftStart}
                          className="flex items-center justify-center w-5 h-5 rounded text-white disabled:opacity-50"
                          style={{ background: '#1A3D2B', fontSize: 10 }}
                          title="Save"
                        >
                          {dateSaving ? <i className="ti ti-loader-2 animate-spin" style={{ fontSize: 10 }} /> : <i className="ti ti-check" style={{ fontSize: 10 }} />}
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => { setDateDraftStart(terms?.contract_start_date ?? ''); setDateEditing('start') }}
                        className="text-[11px] text-stone hover:text-forest hover:underline transition-colors"
                        title="Edit start date"
                      >
                        {fmtDate(terms?.contract_start_date)}
                      </button>
                    )}
                    <span className="text-[11px] text-stone/40">–</span>
                    {/* End date */}
                    {dateEditing === 'end' ? (
                      <div className="flex items-center gap-1">
                        <input
                          autoFocus
                          type="date"
                          value={dateDraftEnd}
                          onChange={e => setDateDraftEnd(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') saveDateField('end'); if (e.key === 'Escape') setDateEditing(null) }}
                          className="text-[11px] border border-forest/30 rounded px-1.5 py-0.5 outline-none focus:border-forest"
                        />
                        <button onClick={() => setDateEditing(null)} className="text-stone/50 hover:text-ink transition-colors" title="Cancel">
                          <i className="ti ti-x" style={{ fontSize: 11 }} />
                        </button>
                        <button
                          onClick={() => saveDateField('end')}
                          disabled={dateSaving || !dateDraftEnd}
                          className="flex items-center justify-center w-5 h-5 rounded text-white disabled:opacity-50"
                          style={{ background: '#1A3D2B', fontSize: 10 }}
                          title="Save"
                        >
                          {dateSaving ? <i className="ti ti-loader-2 animate-spin" style={{ fontSize: 10 }} /> : <i className="ti ti-check" style={{ fontSize: 10 }} />}
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => { setDateDraftEnd(terms?.contract_end_date ?? ''); setDateEditing('end') }}
                        className={`text-[11px] hover:underline transition-colors ${terms?.contract_end_date ? 'text-stone hover:text-forest' : 'text-amber-600 hover:text-amber-700 font-medium'}`}
                        title="Edit end date"
                      >
                        {terms?.contract_end_date ? fmtDate(terms.contract_end_date) : 'Add end date'}
                      </button>
                    )}
                  </div>
                </div>

                <EditableStat
                  label="Payment terms"
                  value={terms?.payment_terms_text ?? (terms?.payment_terms_days ? `Net ${terms.payment_terms_days} days` : null)}
                  onSave={v => saveField('payment_terms_text', v)}
                />
                <EditableStat
                  label="Billing contact"
                  value={terms?.billing_contact ?? terms?.customer_name ?? null}
                  onSave={v => saveField('billing_contact', v)}
                />
                <Stat
                  label="Currency"
                  value={cur}
                  sub={terms?.billing_frequency ? `Billed ${terms.billing_frequency}` : undefined}
                />
                <Stat
                  label="Auto-renews"
                  value={terms?.auto_renews == null ? '—' : terms.auto_renews ? 'Yes' : 'No'}
                  sub={terms?.renewal_notice_days ? `${terms.renewal_notice_days} days notice required` : undefined}
                />
              </div>
            </div>

            {/* Billing configuration */}
            <div className="bg-white rounded-2xl border border-forest/10 overflow-hidden">

              {/* Base subscription */}
              {(terms?.base_monthly_fee || terms?.year_pricing ||
                (terms?.ramp_schedule && terms.ramp_schedule.length > 0)) && (
                <div className="p-6">
                  <SectionHeader
                    title="Subscription fees"
                    section={src.base_monthly_fee ?? src.year_pricing ?? src.ramp_schedule}
                    onSection={openPDF}
                  />
                  {/* Flat monthly or year-pricing display */}
                  {(terms?.base_monthly_fee || terms?.year_pricing) && (
                    <div className="grid grid-cols-3 gap-8">
                      {terms?.base_monthly_fee && (
                        <BigValue
                          label="Monthly fee"
                          value={fmt(terms.base_monthly_fee, cur)}
                          unit="/ month"
                          warn={baseItem ? baseItem.confidence_score < 0.95 && !correction(baseItem.id) : false}
                        >
                          {baseItem && baseItem.confidence_score < 0.95 && (
                            <CorrectionInput value={correction(baseItem.id)} onChange={v => setCorr(baseItem.id, v)} />
                          )}
                        </BigValue>
                      )}
                      {terms?.year_pricing && Object.entries(terms.year_pricing).map(([year, price]) => {
                        const yItem = findItem(`${year} pricing`)
                        return (
                          <BigValue
                            key={year}
                            label={`${year.replace('year', 'Year ')} annual value`}
                            value={fmt(price, cur)}
                            unit="/ year"
                            warn={yItem ? yItem.confidence_score < 0.95 && !correction(yItem.id) : false}
                          >
                            {yItem && yItem.confidence_score < 0.95 && (
                              <CorrectionInput value={correction(yItem.id)} onChange={v => setCorr(yItem.id, v)} />
                            )}
                          </BigValue>
                        )
                      })}
                    </div>
                  )}
                  {/* Ramp schedule display */}
                  {terms?.ramp_schedule && terms.ramp_schedule.length > 0 && (
                    <div className={`grid gap-6 ${terms.ramp_schedule.length <= 2 ? 'grid-cols-2' : terms.ramp_schedule.length === 3 ? 'grid-cols-3' : 'grid-cols-4'}`}>
                      {terms.ramp_schedule.map((step, i) => {
                        const disc = (terms?.discounts ?? []).find(d => {
                          const ds = d.start_date ? parseLocalDate(d.start_date) : null
                          const de = d.end_date   ? parseLocalDate(d.end_date)   : null
                          const ss = parseLocalDate(step.start_date)
                          return ds && de && ss >= ds && ss <= de
                        })
                        const netFee = disc?.discount_pct ? step.monthly_fee * (1 - disc.discount_pct / 100) : null
                        return (
                          <BigValue
                            key={i}
                            label={step.label ?? `Ramp ${i + 1}`}
                            value={fmt(step.monthly_fee, cur)}
                            unit="/ month gross"
                            note={[
                              `${fmtDate(step.start_date)} – ${fmtDate(step.end_date)}`,
                              netFee ? `Net after ${disc!.discount_pct}% discount: ${fmt(netFee, cur)}/mo` : null,
                            ].filter(Boolean).join(' · ')}
                          />
                        )
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* Price escalators */}
              {(terms?.escalators?.length ?? 0) > 0 && (
                <>
                  <Divider />
                  <div className="p-6">
                    <SectionHeader title="Price escalator" section={src.escalators} onSection={openPDF} />
                    <div className="grid grid-cols-3 gap-8">
                      {terms!.escalators!.map((e, i) => {
                        const isEditing = escEditing === i
                        const label = e.escalator_type === 'fixed_pct' ? 'Fixed annual increase' : e.escalator_type ?? 'Escalator'
                        const note  = e.effective_date
                          ? `Effective ${fmtDate(e.effective_date)}${e.cap_pct ? ` · capped at ${e.cap_pct}%` : ''}`
                          : e.description ?? undefined
                        return (
                          <div
                            key={i}
                            className="rounded-xl p-4 transition-all"
                            style={isEditing
                              ? { background: '#FFFBEB', border: '1px solid #F59E0B' }
                              : { background: 'transparent' }}
                          >
                            {/* Label row */}
                            <div className="flex items-center justify-between mb-2">
                              <p className="text-[10px] font-semibold text-stone uppercase tracking-[0.12em]">{label}</p>
                              {!isEditing && (
                                <button
                                  onClick={() => {
                                    setEscEditValue(e.escalator_pct != null ? `${e.escalator_pct}` : '')
                                    setEscEditing(i)
                                  }}
                                  title="Edit this value"
                                  className="text-stone/35 hover:text-forest transition-colors"
                                >
                                  <i className="ti ti-pencil-minus" style={{ fontSize: 12 }} />
                                </button>
                              )}
                            </div>

                            {isEditing ? (
                              /* ── Edit mode: amber cell ── */
                              <div className="flex items-center gap-2 mt-1">
                                <input
                                  autoFocus
                                  type="text"
                                  value={escEditValue}
                                  onChange={e => setEscEditValue(e.target.value)}
                                  onKeyDown={ev => {
                                    if (ev.key === 'Enter') saveEscalatorPct(i)
                                    if (ev.key === 'Escape') setEscEditing(null)
                                  }}
                                  placeholder="e.g. 3"
                                  className="flex-1 text-[28px] font-medium bg-transparent outline-none leading-none"
                                  style={{ color: '#1A3D2B', fontVariantNumeric: 'tabular-nums' }}
                                />
                                <span className="text-sm text-stone self-end pb-0.5">%</span>
                                <button
                                  onClick={() => setEscEditing(null)}
                                  className="text-stone/50 hover:text-ink transition-colors p-1 flex-shrink-0"
                                  title="Cancel"
                                >
                                  <i className="ti ti-x" style={{ fontSize: 13 }} />
                                </button>
                                {escEditValue && (
                                  <button
                                    onClick={() => saveEscalatorPct(i)}
                                    disabled={escSaving}
                                    title="Save"
                                    className="flex items-center justify-center w-8 h-8 rounded-lg text-white transition-colors flex-shrink-0 disabled:opacity-50"
                                    style={{ background: '#1A3D2B' }}
                                  >
                                    {escSaving
                                      ? <i className="ti ti-loader-2 animate-spin" style={{ fontSize: 13 }} />
                                      : <i className="ti ti-check" style={{ fontSize: 13 }} />}
                                  </button>
                                )}
                              </div>
                            ) : (
                              /* ── View mode: normal white ── */
                              <>
                                <div className="flex items-baseline gap-1.5">
                                  <span
                                    className="text-[30px] font-medium leading-none"
                                    style={{ color: '#1A3D2B', fontVariantNumeric: 'tabular-nums' }}
                                  >
                                    {e.escalator_pct != null ? `${e.escalator_pct}%` : '—'}
                                  </span>
                                  <span className="text-[12px] text-stone">per year</span>
                                </div>
                                {note && <p className="text-[11px] text-stone mt-1">{note}</p>}
                              </>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </>
              )}

              {/* Discounts */}
              {(terms?.discounts?.length ?? 0) > 0 && (
                <>
                  <Divider />
                  <div className="p-6">
                    <SectionHeader title="Discounts" section={src.discounts} onSection={openPDF} />
                    <div className="grid grid-cols-3 gap-8">
                      {terms!.discounts!.map((d, i) => {
                        const discountedFee = terms?.base_monthly_fee && d.discount_pct
                          ? terms.base_monthly_fee * (1 - d.discount_pct / 100)
                          : null
                        // For ramp schedules, show the discounted first-step rate as a reference
                        const rampNote = !discountedFee && terms?.ramp_schedule?.length && d.discount_pct
                          ? `Applied to each ramp rate — e.g. ${fmt(terms.ramp_schedule[0].monthly_fee * (1 - d.discount_pct / 100), cur)}/mo net in Ramp 1`
                          : null
                        return (
                          <BigValue
                            key={i}
                            label={d.discount_type === 'introductory' ? 'Introductory discount'
                              : d.discount_type === 'channel_partner' ? 'Channel partner discount'
                              : d.discount_type ?? 'Discount'}
                            value={d.discount_pct != null ? `${d.discount_pct}%` : fmt(d.discount_amount, cur)}
                            unit="off"
                            note={
                              [
                                d.start_date && d.end_date ? `${fmtDate(d.start_date)} – ${fmtDate(d.end_date)}` : null,
                                discountedFee ? `Discounted fee: ${fmt(discountedFee, cur)}/mo` : null,
                                rampNote,
                              ].filter(Boolean).join(' · ') || undefined
                            }
                          />
                        )
                      })}
                    </div>
                  </div>
                </>
              )}

              {/* User overages */}
              {userTiers.length > 0 && (
                <>
                  <Divider />
                  <div className="p-6">
                    <SectionHeader title="Additional user overages" section={src.overage_tiers} onSection={openPDF} />
                    <div className="grid grid-cols-3 gap-8">
                      {userTiers.map((t, i) => (
                        <BigValue
                          key={i}
                          label={t.tier_label ?? `Tier ${i + 1}`}
                          value={fmt(t.rate_per_unit, cur)}
                          unit={`/ ${(t.unit_type ?? 'user').replace(/\s*(per\s*month|\/\s*mo)\s*/gi, '').trim()} / mo`}
                          note={t.from_unit != null && (!t.tier_label || !/\d/.test(t.tier_label))
                            ? `From user ${t.from_unit}${t.to_unit ? ` to ${t.to_unit}` : '+'}`
                            : undefined}
                        />
                      ))}
                    </div>
                  </div>
                </>
              )}

              {/* API overages */}
              {apiTiers.length > 0 && (
                <>
                  <Divider />
                  <div className="p-6">
                    <SectionHeader title="API call overages" section={src.overage_tiers ?? src.api_tiers} onSection={openPDF} />
                    <div className="grid grid-cols-3 gap-8">
                      {apiTiers.map((t, i) => (
                        <BigValue
                          key={i}
                          label={t.tier_label ?? `Tier ${i + 1}`}
                          value={t.rate_per_unit != null ? `${cur === 'EUR' ? '€' : '$'}${t.rate_per_unit.toFixed(4).replace(/\.?0+$/, '')}` : '—'}
                          unit={`/ ${t.unit_type ?? 'API call'}`}
                          note={t.from_unit != null
                            ? `Calls ${t.from_unit.toLocaleString()}${t.to_unit != null ? ` – ${t.to_unit.toLocaleString()}` : '+'}`
                            : undefined}
                        />
                      ))}
                    </div>
                  </div>
                </>
              )}

              {/* Other overages */}
              {otherTiers.length > 0 && (
                <>
                  <Divider />
                  <div className="p-6">
                    <SectionHeader title="Other overages" section={src.overage_tiers} onSection={openPDF} />
                    <div className="grid grid-cols-3 gap-8">
                      {otherTiers.map((t, i) => (
                        <BigValue
                          key={i}
                          label={t.tier_label ?? `Tier ${i + 1}`}
                          value={fmt(t.rate_per_unit, cur)}
                          unit={`/ ${t.unit_type ?? 'unit'}`}
                        />
                      ))}
                    </div>
                  </div>
                </>
              )}

              {/* One-time fees (positive) */}
              {(terms?.one_time_fees ?? []).filter(f => f.amount >= 0).length > 0 && (
                <>
                  <Divider />
                  <div className="p-6">
                    <SectionHeader title="One-time fees" section={src.one_time_fees} onSection={openPDF} />
                    <div className="grid grid-cols-3 gap-8">
                      {(terms?.one_time_fees ?? []).filter(f => f.amount >= 0).map((f, i) => (
                        <BigValue
                          key={i}
                          label={f.fee_label}
                          value={fmt(f.amount, cur)}
                          note={[
                            f.due_date ? `Due ${new Date(f.due_date).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}` : null,
                            f.description,
                          ].filter(Boolean).join(' · ') || undefined}
                        />
                      ))}
                    </div>
                  </div>
                </>
              )}

              {/* Credits (negative one-time amounts) */}
              {(terms?.one_time_fees ?? []).filter(f => f.amount < 0).length > 0 && (
                <>
                  <Divider />
                  <div className="p-6" style={{ background: '#FFFBEB' }}>
                    <div className="flex items-center justify-between mb-5">
                      <div className="flex items-center gap-2">
                        <h3 className="text-[11px] font-bold uppercase tracking-[0.14em]" style={{ color: '#B45309' }}>Credits</h3>
                        <span className="text-[9px] font-semibold px-2 py-0.5 rounded-full" style={{ background: '#FEF3C7', color: '#B45309', border: '1px solid #F59E0B' }}>
                          reduces net TCV
                        </span>
                      </div>
                      <SectionChip heading={src.one_time_fees} onClick={() => src.one_time_fees && openPDF(src.one_time_fees)} />
                    </div>
                    <div className="grid grid-cols-3 gap-8">
                      {(terms?.one_time_fees ?? []).filter(f => f.amount < 0).map((f, i) => (
                        <div key={i}>
                          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] mb-2" style={{ color: '#B45309' }}>{f.fee_label}</p>
                          <div className="flex items-baseline gap-1.5 mb-1">
                            <span className="text-[28px] font-medium leading-none" style={{ color: '#B45309', fontVariantNumeric: 'tabular-nums' }}>
                              {fmt(f.amount, cur)}
                            </span>
                          </div>
                          {(f.due_date || f.description) && (
                            <p className="text-[11px]" style={{ color: '#92400E' }}>
                              {[
                                f.due_date ? `Applied ${new Date(f.due_date).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}` : null,
                                f.description,
                              ].filter(Boolean).join(' · ')}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Revenue schedule breakdown */}
            {terms?.contract_start_date && terms?.contract_end_date &&
              (terms?.base_monthly_fee || terms?.base_annual_fee || terms?.year_pricing ||
               (terms?.ramp_schedule && terms.ramp_schedule.length > 0)) && (
              <div className="bg-white rounded-2xl border border-forest/10 p-6">
                <h2 className="text-[10px] font-bold text-stone uppercase tracking-[0.14em] mb-5">Revenue schedule</h2>
                <RevenueScheduleTable terms={terms} items={items} cur={cur} />
              </div>
            )}

            {/* Warning banner when dates missing */}
            {(!terms?.contract_start_date || !terms?.contract_end_date) && (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 flex items-start gap-3">
                <i className="ti ti-alert-triangle flex-shrink-0 mt-0.5" style={{ fontSize: 16, color: '#D97706' }} />
                <div>
                  <p className="text-sm font-medium text-amber-900 mb-0.5">
                    {!terms?.contract_start_date && !terms?.contract_end_date
                      ? 'Contract start and end dates are missing'
                      : !terms?.contract_start_date
                      ? 'Contract start date is missing'
                      : 'Contract end date is missing'}
                  </p>
                  <p className="text-xs text-amber-800">
                    TCV cannot be calculated without both dates. Click the date fields above in the Contract overview to add them.
                  </p>
                </div>
              </div>
            )}

            {/* TCV + Approve / Configured */}
            <div className="bg-forest text-white rounded-2xl px-6 py-5 flex items-center justify-between">
              <div>
                <p className="text-[10px] font-semibold text-mint/60 uppercase tracking-[0.14em] mb-1">Total contract value</p>
                <p className="text-[32px] font-medium leading-none font-mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {tcv > 0 ? fmt(tcv, cur) : <span style={{ opacity: 0.45 }}>€0</span>}
                </p>
                {tcv === 0 && (terms?.contract_start_date || terms?.contract_end_date) && (
                  <p className="text-[10px] text-mint/50 mt-1">Add missing dates above to calculate</p>
                )}
              </div>
              {isConfigured ? (
                <div className="text-right">
                  {dashboardUrl && (
                    <a
                      href={dashboardUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-2 bg-white text-forest font-semibold text-sm px-8 py-3 rounded-xl hover:bg-mint transition-colors"
                    >
                      View in {billingPlatform === 'chargebee' ? 'Chargebee' : 'Stripe'} →
                    </a>
                  )}
                  {subId && (
                    <p className="text-[11px] text-mint/50 mt-2 font-mono">{subId}</p>
                  )}
                </div>
              ) : (
                <div className="text-right">
                  <button
                    onClick={handleApprove}
                    disabled={approving || needsReview > 0}
                    className="bg-white text-forest font-semibold text-sm px-8 py-3 rounded-xl hover:bg-mint transition-colors disabled:opacity-50 flex items-center gap-2"
                  >
                    {approving
                      ? <><i className="ti ti-loader-2 animate-spin" style={{ fontSize: 14 }} /> Pushing to Stripe...</>
                      : 'Approve & configure billing →'
                    }
                  </button>
                  {needsReview > 0 && (
                    <p className="text-[11px] text-mint/60 mt-2">Review {needsReview} flagged item{needsReview > 1 ? 's' : ''} above before approving</p>
                  )}
                  {approveError && (
                    <p className="text-[11px] text-red-300 mt-2 max-w-xs">{approveError}</p>
                  )}
                </div>
              )}
            </div>

          </div>{/* end terms column */}

        </div>{/* end content row */}
      </div>

      {/* ── Review panel ────────────────────────────────────────────────── */}
      {reviewPanelOpen && (
        <ReviewPanel
          items={items.filter(i => i.confidence_score < 0.95)}
          corrections={corrections}
          onCorrect={(itemId, value) => setCorr(itemId, value)}
          onClose={() => setReviewPanelOpen(false)}
          onRefresh={fetchJob}
          jobId={id}
        />
      )}

      {/* ── PDF Drawer ──────────────────────────────────────────────────── */}
      {drawer.open && (
        <div className="fixed inset-0 z-40 flex justify-end">
          <div className="absolute inset-0 bg-black/35" onClick={() => closePDF()} />
          <div className="relative h-full bg-white shadow-2xl flex flex-col" style={{ width: `${panelWidth}%` }}>
            {/* ── Resize handle ── */}
            <div
              className="absolute left-0 top-0 h-full w-2 z-10 flex items-center justify-center group"
              style={{ cursor: 'col-resize' }}
              onMouseDown={e => {
                isDragging.current = true
                dragOrigin.current = { x: e.clientX, w: panelWidth }
                document.body.style.userSelect = 'none'
                e.preventDefault()
              }}
            >
              <div className="w-0.5 h-16 rounded-full bg-forest/20 group-hover:bg-forest/50 transition-colors" />
            </div>
            <div className="flex items-center justify-between px-5 py-3 border-b border-forest/10 bg-white">
              <div className="min-w-0 flex-1 mr-2 flex items-center overflow-hidden">
                <span className="text-sm font-medium text-ink whitespace-nowrap">Signed contract</span>
                {drawer.section && (
                  <span className="ml-2 text-[11px] text-stone truncate">· jumping to §{drawer.section}</span>
                )}
              </div>
              <button
                onClick={() => closePDF()}
                className="text-stone hover:text-ink transition-colors w-7 h-7 flex items-center justify-center rounded-lg hover:bg-cream"
              >
                <i className="ti ti-x" style={{ fontSize: 14 }} />
              </button>
            </div>
            <div className="flex-1 overflow-hidden">
              {job.contract_pdf_url
                ? pdfUrlError
                  ? <div className="h-full flex items-center justify-center">
                      <div className="text-center">
                        <i className="ti ti-alert-circle block mb-2 text-danger/60" style={{ fontSize: 28 }} />
                        <p className="text-sm text-stone">Could not load PDF</p>
                        <button
                          onClick={() => { setPdfUrl(null); setPdfUrlError(false) }}
                          className="mt-3 text-xs text-forest underline"
                        >Try again</button>
                      </div>
                    </div>
                  : pdfUrl
                    ? <PDFViewer key={pdfRenderKey} url={pdfUrl} section={drawer.section} />
                    : <div className="h-full flex items-center justify-center">
                        <div className="w-8 h-8 border-2 border-forest border-t-transparent rounded-full animate-spin" />
                      </div>
                : <div className="h-full flex items-center justify-center text-stone text-sm">No PDF available</div>
              }
            </div>
          </div>
        </div>
      )}
    </>
  )
}
