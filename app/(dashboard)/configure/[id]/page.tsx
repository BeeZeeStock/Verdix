'use client'

import { useState, useEffect, useRef, use } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { RevenueModelTab } from '@/app/_components/RevenueModelTab'
import { BillingSummaryCard } from '@/app/_components/BillingSummaryCard'
import { MeterMappingPanel } from '@/app/_components/MeterMappingPanel'
import { ParkedInvoicesCard } from '@/app/_components/ParkedInvoicesCard'
import { ConsumptionTimelineCard } from '@/app/_components/ConsumptionTimelineCard'
import { ManualInvoiceCard } from '@/app/_components/ManualInvoiceCard'
import { computeBaseTcv, contractLifecycleStatus } from '@/lib/contract-tcv-calc'

const PDFViewer = dynamic(() => import('@/app/_components/PDFViewer'), { ssr: false })

// ── Types ──────────────────────────────────────────────────────────────────

type Escalator = { escalator_pct?: number; escalator_type?: string; effective_date?: string; description?: string; cap_pct?: number }
type Discount   = { discount_pct?: number; discount_amount?: number; discount_type?: string; start_date?: string; end_date?: string; duration_months?: number; applies_to?: string; description?: string }
type Tier       = {
  tier_label?: string; from_unit?: number; to_unit?: number; rate_per_unit?: number; unit_type?: string
  measurement_period?: 'monthly' | 'quarterly' | 'semi-annual' | 'annual' | null
  minimum_period_amount?: number | null
  minimum_commitment?: {
    mode: 'floor' | 'additive' | 'minimum_spend' | 'prepaid_commitment' | 'minimum_quantity'
    amount: number
    included_allowance_interaction?: 'before_allowance' | 'after_allowance' | 'unclear'
    requires_confirmation: boolean
    confirmation_reason?: string | null
  } | null
  reset_anchor?: 'contract_start' | 'calendar' | null
}

type OneTimeFee = { fee_label: string; amount: number; due_date?: string | null; description?: string | null; manual_trigger?: boolean; metric_name?: string | null; rate_per_unit?: number | null }
type AdditionalRecurringFee = { fee_label: string; amount: number; description?: string | null; billing_frequency?: 'monthly' | 'quarterly' | 'semi-annual' | 'annual' | null }

type Terms = {
  id?: string
  contract_id?: string
  crm_id?: string
  customer_name?: string; customer_address?: string; customer_email?: string | null; customer_org_number?: string | null; billing_contact?: string
  vendor_name?: string;   vendor_address?: string
  contract_start_date?: string; contract_end_date?: string; contract_term_months?: number
  auto_renews?: boolean; renewal_notice_days?: number; renewal_term_months?: number | null
  currency?: string
  base_monthly_fee?: number; base_annual_fee?: number
  billing_frequency?: string; payment_terms_days?: number; payment_terms_text?: string
  included_units?: number; included_unit_type?: string
  year_pricing?: Record<string, number>
  ramp_schedule?: { start_date: string; end_date: string; monthly_fee: number; label?: string }[]
  escalators?: Escalator[]; discounts?: Discount[]; overage_tiers?: Tier[]
  one_time_fees?: OneTimeFee[]
  additional_recurring_fees?: AdditionalRecurringFee[]
  field_sources?: Record<string, string>
  extraction_confidence?: string; extraction_notes?: string
  number_format?: 'dot' | 'comma'
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
  // Canonical figures from getContractSummaries (lib/contract-tcv.ts) — see
  // the terminology-standardisation plan: Billed to date is every
  // planned_invoices row actually sent/paid; Committed contract value is
  // Fixed fees + confirmed minimum commitments only (unconfirmed ones are
  // deliberately excluded, never guessed).
  billedToDate?: number
  committedContractValue?: number
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fmt(n: number | null | undefined, cur = 'EUR') {
  if (n == null) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
}

// Maps ISO currency codes to their conventional display symbols.
// For currencies without a unique symbol, falls back to the code + space.
const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: '€', GBP: '£', USD: '$', SEK: 'kr ', NOK: 'kr ', DKK: 'kr ',
  CHF: 'Fr ', JPY: '¥', CAD: 'CA$', AUD: 'A$', PLN: 'zł ', CZK: 'Kč ',
  HUF: 'Ft ', MXN: 'MX$', BRL: 'R$', INR: '₹', CNY: '¥', SGD: 'S$', HKD: 'HK$',
}
function currencySymbol(cur: string) { return CURRENCY_SYMBOLS[cur.toUpperCase()] ?? (cur + ' ') }

// For per-unit rates which are often fractional (e.g. €0.05, €0.035).
// fmt() uses maximumFractionDigits:0 which rounds 0.05 → €0, so we need
// a rate-aware formatter that keeps up to 4 decimal places for values < 1.
function fmtUnit(n: number | null | undefined, cur = 'EUR') {
  if (n == null) return '—'
  if (n > 0 && n < 1) return `${currencySymbol(cur)}${n.toFixed(4).replace(/\.?0+$/, '')}`
  return fmt(n, cur)
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

  // One-time fees are included regardless of whether recurring pricing exists.
  const oneTimeFees = (terms.one_time_fees ?? []).reduce((s, f) => s + Number(f.amount ?? 0), 0)

  const hasFee = terms.base_monthly_fee || terms.base_annual_fee || terms.year_pricing ||
    (terms.ramp_schedule && terms.ramp_schedule.length > 0)
  if (!hasFee) return oneTimeFees

  const start        = parseLocalDate(terms.contract_start_date)
  const end          = parseLocalDate(terms.contract_end_date)
  const discounts    = terms.discounts   ?? []
  const escalators   = terms.escalators  ?? []
  const yearPricing  = terms.year_pricing
  const rampSchedule = terms.ramp_schedule && terms.ramp_schedule.length > 0 ? terms.ramp_schedule : null
  const baseMonthly = terms.base_monthly_fee ?? (terms.base_annual_fee ? terms.base_annual_fee / 12 : 0)

  // additional_recurring_fees amounts are stored as monthly equivalents regardless
  // of billing_frequency (billing_frequency only affects how often invoices are raised,
  // not the per-month rate). The Revenue Model tab and the UI display both treat
  // amount as monthly — match that here so TCV stays consistent.
  const additionalMonthly = (terms.additional_recurring_fees ?? []).reduce((s, f) => s + Number(f.amount ?? 0), 0)

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
    let amount = monthlyBaseFor(loopIdx, md) + additionalMonthly

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

  // Add minimum consumption commitments for overage tiers that carry a floor payment.
  // Each tier's minimum_period_amount is owed once per measurement_period regardless of usage.
  const termMonths = loopIdx  // total months iterated above
  for (const tier of (terms.overage_tiers ?? [])) {
    if (!tier.minimum_period_amount) continue
    const periodsPerYear = tier.measurement_period === 'quarterly' ? 4
      : tier.measurement_period === 'semi-annual' ? 2
      : tier.measurement_period === 'annual'      ? 1
      : 12  // monthly or unspecified
    const periodsInTerm = termMonths / (12 / periodsPerYear)
    total += tier.minimum_period_amount * periodsInTerm
  }

  return total + oneTimeFees
}

// Builds 2–3 natural-language sentences summarising the contract for the
// "at a glance" card. Pure data transform — no React, no side-effects.
function buildContractSummary(
  terms: Terms | undefined,
  cur: string,
  tcv: number,
  userTiers: Tier[],
  apiTiers: Tier[],
): string[] {
  if (!terms) return []
  const lines: string[] = []

  // ── Sentence 1: pricing structure · customer · dates · TCV ───────────────
  let pricing: string
  if (terms.ramp_schedule && terms.ramp_schedule.length > 0) {
    const first = terms.ramp_schedule[0]
    const last  = terms.ramp_schedule[terms.ramp_schedule.length - 1]
    pricing = first.monthly_fee === last.monthly_fee
      ? `flat ${fmt(first.monthly_fee, cur)}/month subscription`
      : `${terms.ramp_schedule.length}-stage ramp (${fmt(first.monthly_fee, cur)} → ${fmt(last.monthly_fee, cur)}/mo)`
  } else if (terms.year_pricing && Object.keys(terms.year_pricing).length > 0) {
    const vals = Object.values(terms.year_pricing)
    pricing = vals.length === 1
      ? `${fmt(vals[0], cur)}/year subscription`
      : `multi-year pricing (${vals.map(v => fmt(v, cur)).join(' → ')}/yr)`
  } else if (terms.base_monthly_fee) {
    const addlMonthly = (terms.additional_recurring_fees ?? []).reduce((s, f) => s + Number(f.amount ?? 0), 0)
    const totalMonthly = terms.base_monthly_fee + addlMonthly
    pricing = addlMonthly > 0
      ? `combined ${fmt(totalMonthly, cur)}/month subscription`
      : `flat ${fmt(terms.base_monthly_fee, cur)}/month subscription`
  } else if (terms.base_annual_fee) {
    pricing = `${fmt(terms.base_annual_fee, cur)}/year subscription`
  } else {
    pricing = 'subscription'
  }

  const duration = terms.contract_term_months ? `${terms.contract_term_months}-month ` : ''
  const customer = terms.customer_name ? ` with ${terms.customer_name}` : ''
  const dates    = terms.contract_start_date && terms.contract_end_date
    ? `, running ${fmtDate(terms.contract_start_date)} to ${fmtDate(terms.contract_end_date)}`
    : terms.contract_start_date ? `, starting ${fmtDate(terms.contract_start_date)}` : ''
  const tcvStr   = tcv > 0 ? `, valued at ${fmt(tcv, cur)}` : ''
  lines.push(`${duration}contract${customer}${dates} — ${pricing}${tcvStr}.`)

  // ── Sentence 2: billing cadence · payment terms · auto-renewal ───────────
  const bits: string[] = []
  if (terms.billing_frequency) bits.push(`billed ${terms.billing_frequency.toLowerCase()}`)
  if (terms.payment_terms_text) bits.push(terms.payment_terms_text)
  else if (terms.payment_terms_days) bits.push(`Net ${terms.payment_terms_days}`)
  if (terms.auto_renews === true) {
    const notice = terms.renewal_notice_days ? `${terms.renewal_notice_days}-day notice required` : 'advance notice required'
    bits.push(`auto-renews (${notice})`)
  } else if (terms.auto_renews === false) {
    bits.push('does not auto-renew')
  } else {
    bits.push('auto-renewal terms unclear — review contract')
  }
  if (bits.length > 0) lines.push(bits.join(' · ') + '.')

  // ── Sentence 3: escalators · discounts · overages ────────────────────────
  const extras: string[] = []
  if (terms.escalators && terms.escalators.length > 0) {
    const e = terms.escalators[0]
    const cap = e.cap_pct ? ` capped at ${e.cap_pct}%` : ''
    extras.push(e.escalator_pct != null
      ? `${e.escalator_pct}% annual escalator${cap}`
      : 'price escalator — confirm rate from source clause')
  }
  if (terms.discounts && terms.discounts.length > 0) {
    const d    = terms.discounts[0]
    const pct  = d.discount_pct != null ? `${d.discount_pct}%` : ''
    const type = d.discount_type ? ` ${d.discount_type.replace(/_/g, ' ')}` : ''
    const till = d.end_date ? ` through ${fmtDate(d.end_date)}` : ''
    extras.push(`${pct}${type} discount${till}`.trim())
  }
  if (userTiers.length > 0) {
    const min = Math.min(...userTiers.map(t => t.rate_per_unit ?? 0).filter(v => v > 0))
    extras.push(min > 0 ? `user overages from ${fmt(min, cur)}/user/mo` : 'user overage tiers')
  }
  if (apiTiers.length > 0) extras.push('API call overages apply')
  if (extras.length > 0) {
    const s = extras.join(' · ')
    lines.push(s.charAt(0).toUpperCase() + s.slice(1) + '.')
  }

  return lines
}

// Derives billing model from contract structure (no LLM required)
function deriveBillingModel(terms: Terms | undefined): 'fixed' | 'hybrid' | 'consumption' {
  const hasTiers = (terms?.overage_tiers?.length ?? 0) > 0
  const hasFixed = !!(terms?.base_monthly_fee || terms?.base_annual_fee ||
    terms?.year_pricing || (terms?.ramp_schedule?.length ?? 0) > 0)
  if (hasTiers && hasFixed) return 'hybrid'
  if (hasTiers) return 'consumption'
  return 'fixed'
}

// Classifies a one-time fee label into service / hardware / other
function classifyFee(label: string): 'service' | 'hardware' | 'other' {
  const l = label.toLowerCase()
  if (/service|implement|setup|onboard|profession|training|consult|deploy|migration/.test(l)) return 'service'
  if (/hardware|device|equipment|physical|machine|sensor/.test(l)) return 'hardware'
  return 'other'
}

// Exports billing line items as a Stripe-compatible CSV
function downloadBillingCSV(items: LineItem[], jobName: string, cur: string) {
  const headers = ['Product Name', 'Quantity', 'Unit Price', 'Total Amount', 'Billing Period', 'Currency']
  const rows = items.map(i => [
    `"${(i.product_name ?? '').replace(/"/g, '""')}"`,
    i.quantity,
    i.unit_price,
    i.total_amount,
    `"${i.billing_period}"`,
    i.currency || cur,
  ])
  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${jobName.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-billing.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// Finds the sentence in extraction_notes that discusses a specific year's calculation.
// Split on semicolons or sentence-ending periods (negative lookbehind avoids splitting on decimals like 0.9).
function splitCalcNotes(notes: string): string[] {
  return notes.split(/;\s*|(?<!\d)\.\s+(?=[A-Z])/).map(s => s.trim()).filter(Boolean)
}

// Formats raw calculation text:
//   1. Adds comma separators to integers ≥ 4 digits (456987 → 456,987)
//   2. Replaces * with ×
//   3. If there's a trailing text description (words, not numbers), shows it first
//   4. Splits each = step onto its own line for readability
//   5. Humanises internal variable names (Year1_fee → Year 1 fee)
function formatCalcNote(raw: string): string {
  const fmtNums = (s: string) =>
    s
      .replace(/\b(\d{4,})\b/g, n => parseInt(n, 10).toLocaleString('en-US'))
      .replace(/\s*\*\s*/g, ' × ')

  // Strip the redundant "Year N = " prefix
  const stripped = raw.replace(/^.*?year\s*\d+\s*=\s*/i, '').trim()

  // Detect trailing parenthetical — only treat as a formula description if it
  // contains real words (not just numbers and operators like "(456987 + 20*2500)")
  const trailingParen = stripped.match(/^([\s\S]+?)\s*\(([^)]+)\)\s*$/)
  if (trailingParen) {
    const candidate = trailingParen[2].trim()
    const isTextDesc = /[a-zA-Z]{3,}/.test(candidate) && !/^\s*[\d(]/.test(candidate)
    if (isTextDesc) {
      // Description first, then each calculation step on its own line
      const steps = trailingParen[1].trim().split(/\s*=\s*/)
      return `${candidate}\n\n${steps.map(fmtNums).join('\n= ')}`
    }
  }

  // No text description: split on = so each simplification step gets its own line,
  // and humanise variable names in the first (formula) step
  const steps = stripped.split(/\s*=\s*/)
  const lhs = steps[0]
    .replace(/year(\d+)\s*\+\s*year(\d+)\s*fees?/gi, (_, a, b) => `Year ${a} + Year ${b} fees`)
    .replace(/year(\d+)_?fee/gi, (_, n) => `Year ${n} fee`)
  steps[0] = lhs

  // When the LHS has year carry-forward refs + an incremental fee block (base + users*rate),
  // generate a natural-language description so the user knows what each number means.
  const yearRefs = [...lhs.matchAll(/year\s*\d+(?:\s*\+\s*year\s*\d+)*/gi)].map(m => m[0].trim())
  const incrMatch = lhs.match(/\(\s*(\d{4,})\s*\+\s*(\d+)\s*[*×]\s*(\d+)\s*\)/)
  if (yearRefs.length > 0 && incrMatch) {
    const [, base, users, rate] = incrMatch
    const prevStr = [...new Set(yearRefs)].join(' + ')
    const desc = `${prevStr} carried forward + base annual fee (${parseInt(base).toLocaleString('en-US')}) + ${users} users × ${parseInt(rate).toLocaleString('en-US')} annual per-user fee (not per month)`
    return `${desc}\n\n${steps.map(fmtNums).join('\n= ')}`
  }

  return steps.map(fmtNums).join('\n= ')
}

function getYearNote(notes: string | undefined, yearKey: string): string | undefined {
  if (!notes) return undefined
  const yr = yearKey.replace('year', '')
  const parts = splitCalcNotes(notes)
  const match = parts.find(s => new RegExp(`year\\s*${yr}\\b`, 'i').test(s)) ?? parts[0]
  return match ? formatCalcNote(match) : undefined
}

// ── Sub-components ─────────────────────────────────────────────────────────

function BillingModelBadge({ model }: { model: 'fixed' | 'hybrid' | 'consumption' }) {
  const map = {
    fixed:       { label: 'Fixed — Subscription',        bg: '#EEF9F2', color: '#1A3D2B', border: 'rgba(74,124,89,0.25)' },
    hybrid:      { label: 'Hybrid — Fixed + Consumption', bg: '#EFF6FF', color: '#1E40AF', border: 'rgba(59,130,246,0.25)' },
    consumption: { label: 'Consumption',                  bg: '#FEF9C3', color: '#854D0E', border: 'rgba(234,179,8,0.4)' },
  }[model]
  return (
    <span className="text-[10px] font-semibold px-3 py-1.5 rounded-full"
      style={{ background: map.bg, color: map.color, border: `1px solid ${map.border}` }}>
      {map.label}
    </span>
  )
}

function Stat({ label, value, sub }: { label: string; value?: string | null; sub?: string }) {
  return (
    <div>
      <p className="text-[10px] font-semibold text-stone uppercase tracking-[0.12em] mb-1.5">{label}</p>
      <p className="text-[15px] font-medium text-ink leading-snug">{value ?? '—'}</p>
      {sub && <p className="text-[11px] text-stone mt-0.5">{sub}</p>}
    </div>
  )
}

function EditableStat({ label, value, sub, hint, inputType = 'text', placeholder, onSave }: {
  label: string
  value?: string | null
  sub?: string
  hint?: string
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
          {!value && hint && <p className="text-[11px] mt-0.5 leading-snug" style={{ color: '#B45309' }}>{hint}</p>}
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

function CalcTooltip({ calc, children }: { calc?: string | null; children: React.ReactNode }) {
  const [show, setShow] = useState(false)
  if (!calc) return <>{children}</>
  return (
    <span className="relative inline-block" onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      <span className="cursor-help border-b border-dashed" style={{ borderColor: 'rgba(26,61,43,0.35)' }}>
        {children}
      </span>
      {show && (
        <div
          className="absolute z-50 bottom-full mb-2.5 rounded-xl shadow-xl pointer-events-none text-left"
          style={{ background: '#1A3D2B', color: '#fff', padding: '10px 13px', width: 290, left: '50%', transform: 'translateX(-50%)' }}
        >
          <p className="text-[9px] font-bold uppercase tracking-[0.15em] mb-1.5" style={{ color: 'rgba(255,255,255,0.45)' }}>
            How this is calculated
          </p>
          <p className="text-[11px] leading-relaxed whitespace-pre-line" style={{ color: 'rgba(255,255,255,0.88)' }}>{calc}</p>
          <div className="absolute left-1/2 -translate-x-1/2 top-full" style={{ width: 0, height: 0, borderLeft: '6px solid transparent', borderRight: '6px solid transparent', borderTop: '6px solid #1A3D2B' }} />
        </div>
      )}
    </span>
  )
}

function BigValue({ label, value, unit, warn, note, calcNote, children }: {
  label: string; value: string; unit?: string; warn?: boolean; note?: string; calcNote?: string; children?: React.ReactNode
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
        <CalcTooltip calc={calcNote}>
          <span className="text-[30px] font-medium leading-none" style={{ color: '#1A3D2B', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
        </CalcTooltip>
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
      className="hover:underline whitespace-nowrap transition-colors"
      style={{ fontSize: 11, fontWeight: 600, color: '#1F7A4A', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
      title={`Open §${heading} in contract PDF`}
    >
      §{num ?? heading}
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

// ── Review panel helpers ───────────────────────────────────────────────────

type ItemKind = 'overage_tier' | 'escalator' | 'base_fee' | 'user_seat' | 'one_time' | 'minimum_commitment' | 'unknown'

// A tier and its rendered LineItem share a tier_label — buildLineItems
// (execute route) sets product_name from tier_label, optionally with a
// trailing "— overage"/"— included in base fee" clause appended.
function findTierForItem(item: LineItem, tiers: Tier[]): Tier | undefined {
  const cleanName = item.product_name.replace(/\s*—\s*(included in base fee|overage)\s*$/i, '').trim().toLowerCase()
  return tiers.find(t => (t.tier_label ?? '').trim().toLowerCase() === cleanName)
}

function classifyItem(item: LineItem, tiers: Tier[] = []): ItemKind {
  const rule = (item.applied_rule ?? '').toLowerCase()
  const name = item.product_name.toLowerCase()

  // One-time fees are unambiguous from billing_period alone — check first.
  // A parked manual-trigger one-time fee also has quantity 0 (same as an
  // unconfirmed usage tier below), so this must run before that check or
  // it would get misclassified as a pricing tier.
  if (item.billing_period === 'one_time' || rule.includes('one_time') || name.includes('setup') || name.includes('onboarding')) return 'one_time'

  if (rule.includes('escalator') || name.includes('escalator') || name.includes('cpi') || name.includes('price escalator')) return 'escalator'

  // A minimum commitment flagged as ambiguous (unclear interaction with an
  // included allowance, unclear proration, etc.) takes priority over the
  // ordinary overage_tier classification — it needs a reviewer's explicit
  // interpretation, not just a rate confirmation. Never silently resolved.
  const matchedTier = findTierForItem(item, tiers)
  if (matchedTier?.minimum_commitment?.requires_confirmation) return 'minimum_commitment'

  // Usage/overage pricing tiers always carry quantity 0 from extraction (no
  // usage confirmed yet) — a structural signal, unlike matching "overage"/
  // "tier" in the tier's own label, which correctly no longer always
  // contains those words (a tier can just be named "SMS reminders 1–500").
  if (item.quantity === 0) return 'overage_tier'
  if (rule.includes('overage') || name.includes('overage') || name.includes('tier')) return 'overage_tier'

  if (name.includes('user') || name.includes('seat') || name.includes('license')) return 'user_seat'
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

function getReviewContext(item: LineItem, kind: ItemKind, numberFormat: 'dot' | 'comma' = 'dot', tiers: Tier[] = []): ReviewContext {
  const score = item.confidence_score
  // Terser than a full sentence and varied by what's actually uncertain,
  // rather than one repeated line on every card in the drawer — "why review"
  // should read as diagnostic, not filler.
  const ambiguous = score < 0.85 ? 'Multiple values in the source clause may apply.' : null

  // Format a number example in the contract's own notation so it matches what the user sees in the PDF
  const fmtExample = (n: number) => numberFormat === 'comma' ? String(n).replace('.', ',') : String(n)

  switch (kind) {
    case 'overage_tier': {
      const isIncluded = !item.unit_price || item.unit_price === 0
      // The tier's own label may already read naturally on its own ("SMS
      // reminders 1–500 — included in base fee") or may need a rate clause
      // appended ("SMS reminders 501–2,000") — strip any trailing
      // description so the sentence never repeats itself.
      const cleanName = item.product_name.replace(/\s*—\s*(included in base fee|overage)\s*$/i, '').trim()
      return {
        typeLabel:          isIncluded ? 'Included usage tier' : 'Usage pricing tier',
        typeIcon:           isIncluded ? 'ti-gift' : 'ti-chart-bar',
        primaryField:       'unit_price',
        primaryLabel:       'Rate per unit',
        primaryPlaceholder: item.unit_price > 0 ? `e.g. ${fmtExample(item.unit_price)}` : numberFormat === 'comma' ? 'e.g. 0,035' : 'e.g. 0.035',
        whatToCheck:        isIncluded
          ? `Confirm that ${cleanName} are included in the base fee.`
          : `Confirm that ${cleanName} are charged at ${fmtUnit(item.unit_price, item.currency)}/unit, billed ${item.billing_period}.`,
        whyFlagged:         ambiguous ?? 'Billing-impacting pricing term.',
      }
    }
    case 'minimum_commitment': {
      const mc = findTierForItem(item, tiers)?.minimum_commitment
      const modeLabel: Record<string, string> = {
        floor: 'a usage floor (bill the greater of usage or the minimum)',
        additive: 'charged on top of usage regardless',
        minimum_spend: 'a spend commitment usage draws against',
        prepaid_commitment: 'prepaid up front, with usage drawing it down',
        minimum_quantity: 'a minimum billable quantity, not a currency floor',
      }
      const modeText = mc ? (modeLabel[mc.mode] ?? mc.mode) : 'a minimum commitment'
      return {
        typeLabel:          'Minimum commitment',
        typeIcon:           'ti-alert-triangle',
        primaryField:       'unit_price',
        primaryLabel:       'Minimum amount',
        primaryPlaceholder: mc ? `e.g. ${fmtExample(mc.amount)}` : 'e.g. 5000',
        whatToCheck:        `Confirm how the ${fmt(mc?.amount ?? 0, item.currency)} minimum for ${item.product_name} interacts with the included allowance — ${modeText}.`,
        whyFlagged:         mc?.confirmation_reason
          ?? 'This metric has both an included allowance and a stated minimum; the contract does not say how they interact.',
      }
    }
    case 'escalator':
      return {
        typeLabel:          'Price escalator',
        typeIcon:           'ti-trending-up',
        primaryField:       'unit_price',
        primaryLabel:       'Escalation rate (%)',
        primaryPlaceholder: 'e.g. 3',
        whatToCheck:        'Confirm the escalation method and rate cap stated in the contract.',
        whyFlagged:         'The contract defines an escalation mechanism, but the applicable rate requires interpretation.',
      }
    case 'user_seat':
      return {
        typeLabel:          'Per-seat pricing',
        typeIcon:           'ti-users',
        primaryField:       'unit_price',
        primaryLabel:       'Price per seat',
        primaryPlaceholder: `e.g. ${fmtExample(item.unit_price || 0)}`,
        whatToCheck:        `Confirm that ${fmtUnit(item.unit_price, item.currency)}/seat applies above the included seat count.`,
        whyFlagged:         ambiguous ?? 'Billing-impacting pricing term.',
      }
    case 'one_time':
      return {
        typeLabel:          'One-time fee',
        typeIcon:           'ti-receipt',
        primaryField:       'unit_price',
        primaryLabel:       'Fee amount',
        primaryPlaceholder: `e.g. ${fmtExample(item.unit_price || 0)}`,
        whatToCheck:        `Confirm the one-time fee of ${fmt(item.unit_price, item.currency)} for ${item.product_name}.`,
        whyFlagged:         'One-time charge — confirm before invoicing.',
      }
    case 'base_fee':
      return {
        typeLabel:          'Base subscription fee',
        typeIcon:           'ti-file-invoice',
        primaryField:       'unit_price',
        primaryLabel:       'Fee amount',
        primaryPlaceholder: `e.g. ${fmtExample(item.unit_price || 0)}`,
        whatToCheck:        `Confirm the recurring fee of ${fmt(item.unit_price, item.currency)}, billed ${item.billing_period ?? 'per period'}.`,
        whyFlagged:         'Billing-impacting pricing term.',
      }
    default:
      return {
        typeLabel:          'Line item',
        typeIcon:           'ti-file-text',
        primaryField:       'product_name',
        primaryLabel:       'Description',
        primaryPlaceholder: 'Enter correct description…',
        whatToCheck:        'Confirm this value against the source clause.',
        whyFlagged:         ambiguous ?? 'Billing-impacting pricing term.',
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
  overageTiers,
  numberFormat = 'dot',
  onViewSource,
}: {
  items: LineItem[]
  corrections: Record<string, { value: string; remember: boolean }>
  onCorrect: (itemId: string, value: string) => void
  onClose: () => void
  onRefresh: () => void
  jobId: string
  overageTiers?: Tier[]
  numberFormat?: 'dot' | 'comma'
  onViewSource?: (section?: string) => void
}) {
  const [saving,    setSaving]    = useState<string | null>(null)
  const [resolved,  setResolved]  = useState<Record<string, 'confirmed' | 'corrected'>>({})
  const [editing,   setEditing]   = useState<string | null>(null)
  const [draftPrice, setDraftPrice] = useState<Record<string, string>>({})
  const [draftName,  setDraftName]  = useState<Record<string, string>>({})
  const [saveError,  setSaveError]  = useState<Record<string, string>>({})
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({})

  const resolvedCount = items.filter(i => resolved[i.id] || i.id in corrections).length
  const allDone = resolvedCount === items.length

  // After confirming/saving one term, jump straight to the next one that
  // still needs attention — View clause → Confirm/Edit → next item, instead
  // of making the reviewer scroll to find where they left off.
  const scrollToNextUnresolved = (afterId: string) => {
    const idx = items.findIndex(i => i.id === afterId)
    for (let i = idx + 1; i < items.length; i++) {
      const next = items[i]
      if (!resolved[next.id] && !(next.id in corrections)) {
        itemRefs.current[next.id]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        return
      }
    }
  }

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
      await Promise.all([
        // Record as confirmed so future extractions learn this is acceptable
        fetch('/api/corrections', {
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
        }),
        // Persist confidence_score = 1 so the banner doesn't reappear after reload
        fetch(`/api/jobs/${jobId}/line-items`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ itemId: item.id, fields: { confidence_score: 1 } }),
        }),
      ])
      onCorrect(item.id, item.product_name)
      setResolved(r => ({ ...r, [item.id]: 'confirmed' }))
      setEditing(null)
      scrollToNextUnresolved(item.id)
      onRefresh()
    } finally {
      setSaving(null)
    }
  }

  const saveCorrection = async (item: LineItem, ctx: ReviewContext) => {
    setSaveError(e => { const n = { ...e }; delete n[item.id]; return n })
    setSaving(item.id)
    try {
      if (ctx.primaryField === 'unit_price') {
        const raw = draftPrice[item.id]?.trim()
        // Normalize comma decimals (Finnish/German locale) before parsing
        const normalized = raw ? raw.replace(/[^0-9.,]/g, '').replace(',', '.') : ''
        const price = normalized ? parseFloat(normalized) : null

        if (price === null || isNaN(price)) {
          const ex = numberFormat === 'comma' ? '0,035' : '0.035'
          setSaveError(e => ({ ...e, [item.id]: `Please enter a valid number (e.g. ${ex})` }))
          return
        }

        // Update the line item record directly (confidence_score: 1 prevents banner from reappearing)
        const lineRes = await fetch(`/api/jobs/${jobId}/line-items`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            itemId: item.id,
            fields: { unit_price: price, total_amount: price * (item.quantity || 1), confidence_score: 1 },
          }),
        })
        if (!lineRes.ok) {
          const err = await lineRes.text().catch(() => lineRes.statusText)
          setSaveError(e => ({ ...e, [item.id]: `Save failed: ${err}` }))
          return
        }

        // If this is an overage tier, also update contract_terms.overage_tiers so
        // the Charging parameters display reflects the corrected rate immediately
        if (overageTiers && overageTiers.length > 0) {
          const baseName = item.product_name.replace(/\s*[—–-]\s*overage\s*$/i, '').trim()
          const matchIdx = overageTiers.findIndex(t =>
            t.tier_label && (
              t.tier_label.toLowerCase() === baseName.toLowerCase() ||
              item.product_name.toLowerCase().includes(t.tier_label.toLowerCase())
            )
          )
          if (matchIdx >= 0) {
            const updatedTiers = overageTiers.map((t, i) =>
              i === matchIdx ? { ...t, rate_per_unit: price } : t
            )
            const termsRes = await fetch(`/api/jobs/${jobId}/terms`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ overage_tiers: updatedTiers }),
            })
            if (!termsRes.ok) {
              const err = await termsRes.text().catch(() => termsRes.statusText)
              setSaveError(e => ({ ...e, [item.id]: `Rate saved but charging parameters update failed: ${err}` }))
              return
            }
          }
        }

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
      } else {
        const name = draftName[item.id]?.trim()
        if (!name) {
          setSaveError(e => ({ ...e, [item.id]: 'Please enter a name' }))
          return
        }
        await Promise.all([
          fetch('/api/corrections', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jobId,
              fieldName:        'product_name',
              extractedValue:   item.product_name,
              correctedValue:   name,
              applyToFuture:    true,
            }),
          }),
          fetch(`/api/jobs/${jobId}/line-items`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ itemId: item.id, fields: { confidence_score: 1 } }),
          }),
        ])
        onCorrect(item.id, name)
      }

      // Only mark resolved if we reached here (all saves succeeded)
      setResolved(r => ({ ...r, [item.id]: 'corrected' }))
      setEditing(null)
      scrollToNextUnresolved(item.id)
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
            <p className="text-sm font-semibold text-ink">Review contract terms</p>
            <p className="text-xs text-stone mt-0.5">
              {resolvedCount} of {items.length} confirmed
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
                {onViewSource && (
                  <button
                    onClick={() => onViewSource(section)}
                    className="flex-shrink-0 text-[10px] font-medium text-forest hover:underline whitespace-nowrap"
                  >
                    View source clause ↗
                  </button>
                )}
              </div>

              <div className="space-y-3">
                {groupItems.map(item => {
                  const kind        = classifyItem(item, overageTiers ?? [])
                  const ctx         = getReviewContext(item, kind, numberFormat, overageTiers ?? [])
                  const isResolved  = !!(resolved[item.id] || item.id in corrections)
                  const isEditing   = editing === item.id
                  const isSaving    = saving === item.id
                  const score       = item.confidence_score
                  const scoreColor  = score < 0.7 ? '#DC2626' : score < 0.85 ? '#D97706' : '#6B7280'

                  return (
                    <div
                      key={item.id}
                      ref={el => { itemRefs.current[item.id] = el }}
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
                            Needs confirmation
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
                              {kind === 'escalator'
                                ? (() => {
                                    const m = item.product_name.match(/\((\d+(?:\.\d+)?)%/)
                                    return m ? `${m[1]}%` : '—%'
                                  })()
                                : `${fmtUnit(item.unit_price, item.currency)}/unit`}
                            </span>
                          </div>
                          {item.quantity > 0 && kind !== 'escalator' && (
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
                            <i className="ti ti-shield-check mr-1" />Confirm this term
                          </p>
                          <p className="text-xs leading-relaxed" style={{ color: '#78350F' }}>
                            {ctx.whatToCheck}
                          </p>
                        </div>

                        {/* Reason for review */}
                        <p className="text-[11px] text-stone leading-relaxed mb-3">
                          <span className="font-medium">Why review: </span>
                          {ctx.whyFlagged}
                        </p>

                        {/* Actions or edit form */}
                        {kind === 'minimum_commitment' && !isResolved ? (
                          // A minimum commitment's ambiguity is resolved by picking one of
                          // the structured interpretations (floor/additive/minimum_spend/
                          // prepaid/minimum_quantity) — that selection, plus reviewer/
                          // timestamp/note, is written per-metric in the Meter mapping
                          // panel below, not here as a simple value confirmation.
                          <button
                            onClick={() => document.getElementById('meter-mapping-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                            className="w-full py-2 rounded-xl text-sm font-semibold transition-colors"
                            style={{ background: '#1A3D2B', color: 'white' }}
                          >
                            <i className="ti ti-arrow-down mr-1.5" style={{ fontSize: 12 }} />
                            Resolve in Meter mapping ↓
                          </button>
                        ) : isResolved ? (
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
                              <>
                                <input
                                  type="text"
                                  inputMode="decimal"
                                  placeholder={ctx.primaryPlaceholder}
                                  value={draftPrice[item.id] ?? ''}
                                  onChange={e => {
                                    setDraftPrice(d => ({ ...d, [item.id]: e.target.value }))
                                    setSaveError(err => { const n = { ...err }; delete n[item.id]; return n })
                                  }}
                                  onKeyDown={e => { if (e.key === 'Enter') saveCorrection(item, ctx) }}
                                  className="w-full text-sm border rounded-xl px-3 py-2 outline-none"
                                  style={{ borderColor: saveError[item.id] ? '#DC2626' : '#FAC775', background: '#FFFDF5' }}
                                  autoFocus
                                />
                                {saveError[item.id] && (
                                  <p className="text-xs mt-1" style={{ color: '#DC2626' }}>{saveError[item.id]}</p>
                                )}
                              </>
                            ) : (
                              <>
                                <input
                                  type="text"
                                  placeholder={ctx.primaryPlaceholder}
                                  value={draftName[item.id] ?? item.product_name}
                                  onChange={e => {
                                    setDraftName(d => ({ ...d, [item.id]: e.target.value }))
                                    setSaveError(err => { const n = { ...err }; delete n[item.id]; return n })
                                  }}
                                  onKeyDown={e => { if (e.key === 'Enter') saveCorrection(item, ctx) }}
                                  className="w-full text-sm border rounded-xl px-3 py-2 outline-none"
                                  style={{ borderColor: saveError[item.id] ? '#DC2626' : '#FAC775', background: '#FFFDF5' }}
                                  autoFocus
                                />
                                {saveError[item.id] && (
                                  <p className="text-xs mt-1" style={{ color: '#DC2626' }}>{saveError[item.id]}</p>
                                )}
                              </>
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
                                : <><i className="ti ti-check mr-1.5" style={{ fontSize: 12 }} />Confirm value</>
                              }
                            </button>
                            <button
                              onClick={() => setEditing(item.id)}
                              className="flex-1 py-2 rounded-xl text-sm font-semibold transition-colors"
                              style={{ background: '#1A3D2B', color: 'white' }}
                            >
                              <i className="ti ti-edit mr-1.5" style={{ fontSize: 12 }} />
                              Edit value
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
              Confirm each term against its source clause, or edit it before approval.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Processing messages ────────────────────────────────────────────────────

const COMMON_CURRENCIES = [
  { code: 'EUR', name: 'Euro' },
  { code: 'GBP', name: 'British Pound' },
  { code: 'USD', name: 'US Dollar' },
  { code: 'SEK', name: 'Swedish Krona' },
  { code: 'NOK', name: 'Norwegian Krone' },
  { code: 'DKK', name: 'Danish Krone' },
  { code: 'CHF', name: 'Swiss Franc' },
  { code: 'JPY', name: 'Japanese Yen' },
  { code: 'CAD', name: 'Canadian Dollar' },
  { code: 'AUD', name: 'Australian Dollar' },
  { code: 'PLN', name: 'Polish Złoty' },
  { code: 'CZK', name: 'Czech Koruna' },
  { code: 'SGD', name: 'Singapore Dollar' },
  { code: 'HKD', name: 'Hong Kong Dollar' },
]

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
  const [billingEdit, setBillingEdit] = useState<{ itemId: string; field: 'quantity' | 'unit_price' | 'billing_period'; value: string } | null>(null)
  const [approved, setApproved]       = useState<{ stripeSubscriptionId: string; dashboardUrl?: string; customerId?: string } | null>(null)
  const [meterMappingsConfirmed, setMeterMappingsConfirmed] = useState(false)
  const [drawer, setDrawer]   = useState<{ open: boolean; section?: string }>({ open: false })
  const [pdfUrl, setPdfUrl]   = useState<string | null>(null)
  const [pdfUrlError, setPdfUrlError] = useState(false)
  const PANEL_WIDTH_PCT = 60   // fixed % of viewport

  // Fetch a fresh signed URL whenever the PDF drawer opens (stored URL may be expired)
  useEffect(() => {
    if (!drawer.open || pdfUrl) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPdfUrlError(false)
    fetch(`/api/jobs/${id}/pdf-url`)
      .then(async r => {
        if (!r.ok) throw new Error(`${r.status}`)
        const { url } = await r.json()
        setPdfUrl(url)
      })
      .catch(() => setPdfUrlError(true))
  }, [drawer.open, id, pdfUrl])

  const [activeTab, setActiveTab]       = useState<'terms' | 'model'>('terms')
  const [reviewPanelOpen, setReviewPanelOpen] = useState(false)
  const [escEditing,   setEscEditing]   = useState<number | null>(null)
  const [escEditValue, setEscEditValue] = useState('')
  const [escSaving,    setEscSaving]    = useState(false)
  const [tierEditing,   setTierEditing]   = useState<number | null>(null)
  const [tierEditValue, setTierEditValue] = useState('')
  const [tierSaving,    setTierSaving]    = useState(false)
  const [dateDraftStart, setDateDraftStart] = useState('')
  const [dateDraftEnd,   setDateDraftEnd]   = useState('')
  const [dateEditing,    setDateEditing]    = useState<'start' | 'end' | null>(null)
  const [dateSaving,     setDateSaving]     = useState(false)
  const [calcExpanded,   setCalcExpanded]   = useState(false)
  const [currencyEditing, setCurrencyEditing] = useState(false)
  const [currencyDraft,   setCurrencyDraft]   = useState('')
  const [rebuilding,      setRebuilding]      = useState(false)
  const [rebuildError,    setRebuildError]    = useState<string | null>(null)
  const [rebuildDone,     setRebuildDone]     = useState(false)
  const [scheduleExists,  setScheduleExists]  = useState<boolean | null>(null)
  const [parkedInvoices,  setParkedInvoices]  = useState<Array<{ id: string; feeLabel: string | null; currency: string; baseAmount: number; metricName: string | null; ratePerUnit: number | null; description: string | null }>>([])
  const [sentOneTimeInvoices, setSentOneTimeInvoices] = useState<{ feeLabel: string | null; amount: number }[]>([])
  const [connectedBillingPlatforms, setConnectedBillingPlatforms] = useState<string[]>([])
  const [selectedBillingPlatform,   setSelectedBillingPlatform]   = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/org/integrations')
      .then(r => r.json())
      .then(data => {
        const billingPlatformIds = ['stripe', 'chargebee', 'remembill', 'zuora', 'maxio', 'recurly', 'quickbooks', 'xero']
        const active = (data.integrations ?? [])
          .filter((i: { connector_name: string; is_active: boolean }) => i.is_active && billingPlatformIds.includes(i.connector_name))
          .map((i: { connector_name: string }) => i.connector_name)
        setConnectedBillingPlatforms(active)
        if (active.length === 1) setSelectedBillingPlatform(active[0])
      })
      .catch(() => {})
  }, [])

  const terms: Terms | undefined = job?.contract_terms?.[0]
  const cur = terms?.currency ?? job?.currency ?? 'EUR'

  const needsReview = items.filter(i => i.confidence_score < 0.95 && !(i.id in corrections)).length

  const fetchJob = async () => {
    const res = await fetch(`/api/jobs/${id}`)
    if (!res.ok) return
    const data = await res.json()
    setJob(data)
    if (data.line_items?.length) setItems(data.line_items)

    // Auto-sync: if line_items have corrected overage rates that are still zero
    // in contract_terms.overage_tiers, patch terms immediately.
    // This reconciles corrections saved before the review-panel propagation fix.
    const tiers: Tier[] = data.contract_terms?.[0]?.overage_tiers ?? []
    const lineItems: LineItem[] = data.line_items ?? []
    if (tiers.length > 0 && lineItems.length > 0) {
      let synced = false
      const newTiers = tiers.map(t => {
        if ((t.rate_per_unit ?? 0) > 0) return t  // already has a rate — skip
        const match = lineItems.find(item => {
          if (item.unit_price <= 0) return false
          const baseName = item.product_name.replace(/\s*—\s*overage\s*$/i, '').trim()
          return t.tier_label && (
            baseName.toLowerCase() === t.tier_label.toLowerCase() ||
            item.product_name.toLowerCase().includes(t.tier_label.toLowerCase())
          )
        })
        if (!match) return t
        synced = true
        return { ...t, rate_per_unit: match.unit_price }
      })
      if (synced) {
        await fetch(`/api/jobs/${id}/terms`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ overage_tiers: newTiers }),
        })
        // Re-fetch once so the UI reflects the synced rates
        const res2 = await fetch(`/api/jobs/${id}`)
        if (res2.ok) {
          const data2 = await res2.json()
          setJob(data2)
          if (data2.line_items?.length) setItems(data2.line_items)
          return data2
        }
      }
    }

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

  // When the last flagged item is reviewed, promote the DB status so the list reflects "Ready to approve".
  useEffect(() => {
    if (needsReview !== 0) return
    if (job?.execute_status !== 'PENDING_HUMAN_REVIEW') return
    if (!items.length) return
    fetch(`/api/jobs/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ execute_status: 'READY_TO_APPROVE' }),
    }).then(() => fetchJob()).catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsReview, job?.execute_status, id, items.length])

  const saveTierRate = async (idx: number) => {
    const rate = parseFloat(tierEditValue.replace(/[^0-9.,]/g, '').replace(',', '.'))
    if (isNaN(rate) || !terms?.overage_tiers) return
    setTierSaving(true)
    try {
      const tier = terms.overage_tiers[idx]
      const newTiers = terms.overage_tiers.map((t, i) => i === idx ? { ...t, rate_per_unit: rate } : t)
      // Update contract_terms.overage_tiers
      await fetch(`/api/jobs/${id}/terms`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overage_tiers: newTiers }),
      })
      // Also sync the corresponding line_item unit_price so billing config stays consistent
      if (tier.tier_label) {
        const matchingItem = items.find(item => {
          const baseName = item.product_name.replace(/\s*—\s*overage\s*$/i, '').trim()
          return baseName.toLowerCase() === tier.tier_label!.toLowerCase() ||
            item.product_name.toLowerCase().includes(tier.tier_label!.toLowerCase())
        })
        if (matchingItem) {
          await fetch(`/api/jobs/${id}/line-items`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ itemId: matchingItem.id, fields: { unit_price: rate, confidence_score: 1 } }),
          })
        }
      }
      setTierEditing(null)
      await fetchJob()
    } finally {
      setTierSaving(false)
    }
  }

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
    const numFields = ['contract_term_months', 'payment_terms_days', 'base_monthly_fee', 'base_annual_fee', 'renewal_notice_days']
    const boolFields = ['auto_renews']
    const body: Record<string, unknown> = {}
    if (numFields.includes(field)) {
      const n = parseFloat(raw.replace(/[^0-9.]/g, ''))
      if (isNaN(n)) return
      body[field] = n
    } else if (boolFields.includes(field)) {
      const lower = raw.toLowerCase().trim()
      body[field] = lower === 'yes' || lower === 'true' || lower === 'y'
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

  const saveLineItemField = async (itemId: string, field: 'quantity' | 'unit_price' | 'billing_period', raw: string) => {
    const item = items.find(i => i.id === itemId)
    if (!item) return
    const fields: Record<string, unknown> = {}
    if (field === 'billing_period') {
      fields.billing_period = raw
    } else {
      const num = parseFloat(raw.replace(/[^0-9.-]/g, ''))
      if (isNaN(num)) return
      fields[field] = num
      const qty = field === 'quantity' ? num : item.quantity
      const up  = field === 'unit_price' ? num : item.unit_price
      fields.total_amount = Math.round(qty * up * 100) / 100
    }
    setItems(prev => prev.map(i => i.id === itemId ? { ...i, ...fields } : i))
    await fetch(`/api/jobs/${id}/line-items`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId, fields }),
    })
  }

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
        body: JSON.stringify({
          modifiedLineItems: modifiedItems,
          ...(selectedBillingPlatform ? { billing_platform: selectedBillingPlatform } : {}),
        }),
      })
      const data = await res.json()
      if (data.success) {
        setApproved({ stripeSubscriptionId: data.stripeSubscriptionId, dashboardUrl: data.dashboardUrl, customerId: data.customerId })
        fetchJob()
      } else {
        setApproveError(data.error ?? 'Billing configuration failed. Please try again.')
        fetchJob()
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

  const isFailed = job.execute_status === 'FAILED' && !approved

  // ── Main view ─────────────────────────────────────────────────────────────
  const isConfigured = job.execute_status === 'COMPLETED' || !!approved
  const subId = approved?.stripeSubscriptionId ?? job.billing_subscription_id ?? null
  const billingPlatform = approved
    ? (approved.dashboardUrl?.includes('chargebee') ? 'chargebee'
      : approved.dashboardUrl?.includes('remembill') ? 'remembill'
      : 'stripe')
    : (job.billing_platform ?? 'stripe')
  const dashboardUrl = approved?.dashboardUrl
    ?? (subId && billingPlatform === 'stripe'
      ? `https://dashboard.stripe.com/test/subscriptions/${subId}`
      : subId && billingPlatform === 'chargebee'
      ? `https://app.chargebee.com/subscriptions/${subId}`
      : null)

  const tiers = terms?.overage_tiers ?? []

  // Group overage tiers by unit_type for dynamic display; preserve original index for edits
  const chargingGroups = new Map<string, Array<{ tier: Tier; origIdx: number }>>()
  for (let i = 0; i < tiers.length; i++) {
    const key = tiers[i].unit_type ?? 'Other'
    if (!chargingGroups.has(key)) chargingGroups.set(key, [])
    chargingGroups.get(key)!.push({ tier: tiers[i], origIdx: i })
  }

  // Keep backward-compat refs used by buildContractSummary
  const userTiers  = tiers.filter(t => t.unit_type?.toLowerCase().includes('user'))
  const apiTiers   = tiers.filter(t => t.unit_type?.toLowerCase().includes('api') || t.unit_type?.toLowerCase().includes('call'))

  // Classify one-time fees into services / hardware / credits / other
  const allFees      = terms?.one_time_fees ?? []
  const serviceFees  = allFees.filter(f => f.amount >= 0 && classifyFee(f.fee_label) === 'service')
  const hardwareFees = allFees.filter(f => f.amount >= 0 && classifyFee(f.fee_label) === 'hardware')
  const otherPosFees = allFees.filter(f => f.amount >= 0 && classifyFee(f.fee_label) === 'other')
  const creditFees   = allFees.filter(f => f.amount < 0)
  const serviceFeeTotal  = serviceFees.reduce((s, f) => s + f.amount, 0)
  const hardwareFeeTotal = hardwareFees.reduce((s, f) => s + f.amount, 0)

  const billingModel = deriveBillingModel(terms)
  const src = terms?.field_sources ?? {}

  // Single-source Fixed fees: sum of each billing-config row's total_amount
  // (each row already holds its full, pre-multiplied contribution to the
  // term) — what the contract says at signing, before any overages.
  // computeBaseTcv is the one shared implementation (lib/contract-tcv.ts) —
  // also used by getContractSummaries for the "New contracts" list and the
  // Agreements dashboard, so this page can never silently diverge from them.
  const tcv = computeBaseTcv(items)

  // Additions = sent one-time invoices for variable fees (total_amount = 0 in billing config)
  const additionsTotal = sentOneTimeInvoices.reduce((s, inv) => {
    const matchingItem = items.find(i => i.product_name === inv.feeLabel)
    return s + ((!matchingItem || matchingItem.total_amount === 0) ? inv.amount : 0)
  }, 0)
  // Billed to date / Committed contract value — canonical figures computed
  // server-side (GET /api/jobs/[id], via getContractSummaries) so this page
  // never diverges from the "New contracts" list or Agreements dashboard.
  const billedToDate            = job?.billedToDate ?? 0
  const committedContractValue  = job?.committedContractValue ?? tcv
  const lifecycleStatus         = contractLifecycleStatus(terms?.contract_start_date ?? null, terms?.contract_end_date ?? null)
  // Once a contract's own end date has passed, nothing further will ever be
  // invoiced against it — "billed to date" becomes the final, realised
  // total under a different label, per the terminology-standardisation plan.
  const isCompleted             = lifecycleStatus === 'completed'

  const summaryLines = buildContractSummary(terms, cur, tcv, userTiers, apiTiers)

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
            <div className="flex items-center">
              {(['terms', 'model'] as const).map(tab => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className="text-xs font-medium px-3 py-1.5 transition-colors border-b-2"
                  style={activeTab === tab
                    ? { color: '#1A3D2B', borderBottomColor: '#1A3D2B' }
                    : { color: '#9CA3AF', borderBottomColor: 'transparent' }
                  }
                >
                  {tab === 'terms' ? 'Contract · Commercials' : 'Graphical view'}
                </button>
              ))}
            </div>
          </div>
          {isConfigured ? (
            <span className="text-xs font-medium flex items-center gap-1.5" style={{ color: '#4A7C59' }}>
              <i className="ti ti-circle-check" style={{ fontSize: 13 }} /> Configured in {billingPlatform === 'remembill' ? 'Remembill' : billingPlatform === 'chargebee' ? 'Chargebee' : 'Stripe'}
            </span>
          ) : isFailed ? (
            <span className="text-xs font-medium flex items-center gap-1.5 text-red-500">
              <i className="ti ti-alert-circle" style={{ fontSize: 13 }} /> Push failed — fix &amp; retry below
            </span>
          ) : needsReview === 0 ? (
            <span className="text-xs font-medium flex items-center gap-1.5" style={{ color: '#4A7C59' }}>
              <i className="ti ti-circle-check" style={{ fontSize: 13 }} /> Ready to approve
            </span>
          ) : null}
        </div>

        {/* Push-failed banner — stays visible so the user can fix data and retry */}
        {isFailed && (
          <div className="flex-shrink-0 mx-8 mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 flex items-start gap-3">
            <i className="ti ti-alert-circle text-red-500 mt-0.5 flex-shrink-0" style={{ fontSize: 16 }} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-red-700 mb-0.5">Last push failed — fix the issue below and retry</p>
              <p className="text-xs text-red-600 leading-relaxed">{job.error_message}</p>
            </div>
          </div>
        )}

        {/* Content row */}
        <div className="flex flex-1 overflow-hidden">

          {/* ── Model tab: full screen ────────────────────────────────────── */}
          {activeTab === 'model' && terms && (
            <RevenueModelTab terms={terms} items={items} cur={cur} jobId={id} onSaved={fetchJob} onRepush={handleApprove} baseTcv={tcv} meterMappingsConfirmed={meterMappingsConfirmed} />
          )}
          {activeTab === 'model' && !terms && (
            <div className="flex-1 flex items-center justify-center text-stone text-sm">
              No contract terms available for modeling.
            </div>
          )}

          {/* ── Terms tab ────────────────────────────────────────────────── */}
          <div className={`flex-1 overflow-y-auto px-8 py-8 space-y-6 ${activeTab !== 'terms' ? 'hidden' : ''}`}>

            {/* ── 1. Contract Brief ── */}
            {summaryLines.length > 0 && (
              <div className="py-1">
                <p className="text-[10px] font-bold uppercase tracking-[0.16em] mb-2" style={{ color: '#4A7C59' }}>
                  Contract brief
                </p>
                {summaryLines.map((line, i) => (
                  <p key={i} className={`text-[13px] text-ink leading-snug ${i < summaryLines.length - 1 ? 'mb-1.5' : ''}`}>{line}</p>
                ))}
              </div>
            )}

            {/* ── Items need review callout ── */}
            {needsReview > 0 && (
              <div className="flex items-center justify-between gap-4 py-3 border-t border-b border-amber-200/60">
                <div className="flex items-start gap-2.5">
                  <i className="ti ti-alert-triangle flex-shrink-0 mt-0.5" style={{ fontSize: 14, color: '#D97706' }} />
                  <div>
                    <p className="text-sm font-medium" style={{ color: '#92400E' }}>
                      {needsReview} contract term{needsReview > 1 ? 's' : ''} need confirmation
                    </p>
                    <p className="text-xs mt-0.5" style={{ color: '#B45309' }}>
                      Review these items against the source agreement before approving.
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setReviewPanelOpen(true)}
                  className="flex-shrink-0 text-xs font-medium transition-colors whitespace-nowrap hover:underline"
                  style={{ color: '#92400E' }}
                >
                  Review items →
                </button>
              </div>
            )}

            {/* ── 2. Contract Overview ── */}
            <div className="bg-white rounded-2xl border border-forest/10 p-6">
              <h2 className="text-[10px] font-bold text-stone uppercase tracking-[0.14em] mb-5">Contract overview</h2>
              <div className="grid grid-cols-3 gap-x-8 gap-y-6">
                <EditableStat
                  label="Contract ID / Number"
                  value={terms?.contract_id ?? null}
                  placeholder="e.g. CLR-2024-0001"
                  onSave={v => saveField('contract_id', v)}
                />
                <EditableStat
                  label="CRM ID"
                  value={terms?.crm_id ?? null}
                  placeholder="Enter CRM deal ID"
                  onSave={v => saveField('crm_id', v)}
                />
                <EditableStat
                  label="Customer name"
                  value={terms?.customer_name}
                  onSave={v => saveField('customer_name', v)}
                />
                <EditableStat
                  label="Customer billing address"
                  value={terms?.customer_address ?? null}
                  onSave={v => saveField('customer_address', v)}
                />
                <EditableStat
                  label="Customer invoice email"
                  value={terms?.customer_email ?? null}
                  onSave={v => saveField('customer_email', v)}
                />
                <EditableStat
                  label="Customer org / reg number"
                  value={terms?.customer_org_number ?? null}
                  onSave={v => saveField('customer_org_number', v)}
                />
                {/* Currency — editable dropdown */}
                <div className="group">
                  <p className="text-[10px] font-semibold text-stone uppercase tracking-[0.12em] mb-1.5">Currency</p>
                  {currencyEditing ? (
                    <div className="flex items-center gap-1.5">
                      <select
                        autoFocus
                        value={currencyDraft}
                        onChange={e => setCurrencyDraft(e.target.value)}
                        className="text-sm font-medium text-ink border border-forest/30 rounded-lg px-2 py-1 outline-none focus:border-forest bg-white"
                      >
                        {COMMON_CURRENCIES.map(c => (
                          <option key={c.code} value={c.code}>{c.code} — {c.name}</option>
                        ))}
                      </select>
                      <button onClick={() => setCurrencyEditing(false)} className="text-stone/50 hover:text-ink p-1 transition-colors flex-shrink-0" title="Cancel">
                        <i className="ti ti-x" style={{ fontSize: 13 }} />
                      </button>
                      <button
                        onClick={async () => { await saveField('currency', currencyDraft); setCurrencyEditing(false) }}
                        className="flex items-center justify-center w-7 h-7 rounded-lg text-white flex-shrink-0 transition-colors"
                        style={{ background: '#1A3D2B' }}
                        title="Save"
                      >
                        <i className="ti ti-check" style={{ fontSize: 12 }} />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-start gap-1">
                      <p className="text-[15px] font-medium text-ink leading-snug">{cur}</p>
                      <button
                        onClick={() => { setCurrencyDraft(cur); setCurrencyEditing(true) }}
                        title="Change currency"
                        className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 p-1 rounded hover:bg-forest/5 mt-0.5"
                      >
                        <i className="ti ti-pencil-minus" style={{ fontSize: 11, color: '#9CA3AF' }} />
                      </button>
                    </div>
                  )}
                </div>

                {/* Contract term — start and end date each independently editable */}
                <div className="group">
                  <p className="text-[10px] font-semibold text-stone uppercase tracking-[0.12em] mb-1.5">Contract term</p>
                  <p className="text-[15px] font-medium text-ink leading-snug">
                    {terms?.contract_term_months ? `${terms.contract_term_months} months` : '—'}
                  </p>
                  <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                    {dateEditing === 'start' ? (
                      <div className="flex items-center gap-1">
                        <input autoFocus type="date" value={dateDraftStart}
                          onChange={e => setDateDraftStart(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') saveDateField('start'); if (e.key === 'Escape') setDateEditing(null) }}
                          className="text-[11px] border border-forest/30 rounded px-1.5 py-0.5 outline-none focus:border-forest" />
                        <button onClick={() => setDateEditing(null)} className="text-stone/50 hover:text-ink transition-colors" title="Cancel">
                          <i className="ti ti-x" style={{ fontSize: 11 }} />
                        </button>
                        <button onClick={() => saveDateField('start')} disabled={dateSaving || !dateDraftStart}
                          className="flex items-center justify-center w-5 h-5 rounded text-white disabled:opacity-50"
                          style={{ background: '#1A3D2B', fontSize: 10 }} title="Save">
                          {dateSaving ? <i className="ti ti-loader-2 animate-spin" style={{ fontSize: 10 }} /> : <i className="ti ti-check" style={{ fontSize: 10 }} />}
                        </button>
                      </div>
                    ) : (
                      <button onClick={() => { setDateDraftStart(terms?.contract_start_date ?? ''); setDateEditing('start') }}
                        className={`text-[11px] hover:underline transition-colors ${terms?.contract_start_date ? 'text-stone hover:text-forest' : 'text-amber-600 hover:text-amber-700 font-medium'}`}
                        title="Edit start date">
                        {terms?.contract_start_date ? fmtDate(terms.contract_start_date) : 'Add start date'}
                      </button>
                    )}
                    <span className="text-[11px] text-stone/40">–</span>
                    {dateEditing === 'end' ? (
                      <div className="flex items-center gap-1">
                        <input autoFocus type="date" value={dateDraftEnd}
                          onChange={e => setDateDraftEnd(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') saveDateField('end'); if (e.key === 'Escape') setDateEditing(null) }}
                          className="text-[11px] border border-forest/30 rounded px-1.5 py-0.5 outline-none focus:border-forest" />
                        <button onClick={() => setDateEditing(null)} className="text-stone/50 hover:text-ink transition-colors" title="Cancel">
                          <i className="ti ti-x" style={{ fontSize: 11 }} />
                        </button>
                        <button onClick={() => saveDateField('end')} disabled={dateSaving || !dateDraftEnd}
                          className="flex items-center justify-center w-5 h-5 rounded text-white disabled:opacity-50"
                          style={{ background: '#1A3D2B', fontSize: 10 }} title="Save">
                          {dateSaving ? <i className="ti ti-loader-2 animate-spin" style={{ fontSize: 10 }} /> : <i className="ti ti-check" style={{ fontSize: 10 }} />}
                        </button>
                      </div>
                    ) : (
                      <button onClick={() => { setDateDraftEnd(terms?.contract_end_date ?? ''); setDateEditing('end') }}
                        className={`text-[11px] hover:underline transition-colors ${terms?.contract_end_date ? 'text-stone hover:text-forest' : 'text-amber-600 hover:text-amber-700 font-medium'}`}
                        title="Edit end date">
                        {terms?.contract_end_date ? fmtDate(terms.contract_end_date) : 'Add end date'}
                      </button>
                    )}
                  </div>
                </div>

                <EditableStat
                  label="Billing cycle"
                  value={terms?.billing_frequency
                    ? terms.billing_frequency.charAt(0).toUpperCase() + terms.billing_frequency.slice(1)
                    : null}
                  placeholder="e.g. monthly, annual"
                  onSave={v => saveField('billing_frequency', v)}
                />
                <EditableStat
                  label="Payment terms"
                  value={terms?.payment_terms_text ?? (terms?.payment_terms_days ? `Net ${terms.payment_terms_days} days` : null)}
                  hint="e.g. Net 30 days from invoice date"
                  placeholder="e.g. Net 30 days from invoice date"
                  onSave={v => saveField('payment_terms_text', v)}
                />
                <EditableStat
                  label="Auto-renewal"
                  value={terms?.auto_renews == null ? null : terms.auto_renews ? 'Yes' : 'No'}
                  hint="Enter Yes or No"
                  placeholder="Yes or No"
                  sub={terms?.renewal_notice_days ? `${terms.renewal_notice_days} days notice required` : undefined}
                  onSave={v => saveField('auto_renews', v)}
                />
                <Stat label="Fixed fees" value={tcv > 0 ? fmt(tcv, cur) : billingModel === 'consumption' ? 'Usage-based' : '—'} />
              </div>
            </div>

            {/* ── 3. Commercial Terms ── */}
            <div className="bg-white rounded-2xl border border-forest/10 overflow-hidden">
              {/* Header with billing model badge */}
              <div className="p-6 flex items-center justify-between" style={{ borderBottom: '1px solid rgba(26,61,43,0.07)' }}>
                <h2 className="text-[10px] font-bold text-stone uppercase tracking-[0.14em]">Commercial terms</h2>
                <BillingModelBadge model={billingModel} />
              </div>

              {/* Discounts */}
              {(terms?.discounts?.length ?? 0) > 0 && (
                <div className="p-6" style={{ borderBottom: '1px solid rgba(26,61,43,0.07)' }}>
                  <SectionHeader title="Discounts" section={src.discounts} onSection={openPDF} />
                  <div className="grid grid-cols-3 gap-8">
                    {terms!.discounts!.map((d, i) => {
                      const typeLabel = d.discount_type === 'introductory' ? 'One-time · introductory'
                        : d.discount_type === 'volume' ? 'Recurring · volume'
                        : d.discount_type === 'negotiated' ? 'Recurring · negotiated'
                        : d.discount_type?.replace(/_/g, ' ') ?? 'Discount'
                      const discountedFee = terms?.base_monthly_fee && d.discount_pct
                        ? terms.base_monthly_fee * (1 - d.discount_pct / 100) : null
                      const rampNote = !discountedFee && terms?.ramp_schedule?.length && d.discount_pct
                        ? `Applied to ramp rates — e.g. ${fmt(terms.ramp_schedule[0].monthly_fee * (1 - d.discount_pct / 100), cur)}/mo net in Ramp 1`
                        : null
                      return (
                        <BigValue key={i} label={typeLabel}
                          value={d.discount_pct != null ? `${d.discount_pct}%` : fmt(d.discount_amount, cur)}
                          unit="off"
                          note={[
                            d.start_date && d.end_date ? `${fmtDate(d.start_date)} – ${fmtDate(d.end_date)}` : null,
                            discountedFee ? `Net fee: ${fmt(discountedFee, cur)}/mo` : null,
                            rampNote,
                            d.applies_to ? `Applies to: ${d.applies_to}` : null,
                          ].filter(Boolean).join(' · ') || undefined}
                        />
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Charging parameters — dynamic groups by unit_type, only if tiers exist */}
              {chargingGroups.size > 0 && (
                <div className="p-6" style={{ borderBottom: '1px solid rgba(26,61,43,0.07)' }}>
                  <SectionHeader title="Charging parameters" section={src.overage_tiers} onSection={openPDF} />
                  <div className="space-y-6">
                    {Array.from(chargingGroups.entries()).map(([unitType, tierList]) => (
                      <div key={unitType}>
                        <p className="text-[10px] font-semibold text-stone uppercase tracking-[0.12em] mb-3 capitalize">{unitType}</p>
                        <div className="grid grid-cols-3 gap-8">
                          {tierList.map(({ tier: t, origIdx }) => {
                            const isEditingTier = tierEditing === origIdx
                            const fmtRate = (r: number) => r > 0 && r < 1
                              ? `${currencySymbol(cur)}${r.toFixed(4).replace(/\.?0+$/, '')}`
                              : fmt(r, cur)
                            const note = t.from_unit != null
                              ? `From unit ${t.from_unit.toLocaleString()}${t.to_unit != null ? ` to ${t.to_unit.toLocaleString()}` : '+'}`
                              : undefined
                            return (
                              <div key={origIdx} className="rounded-xl p-4 transition-all"
                                style={isEditingTier ? { background: '#FFFBEB', border: '1px solid #F59E0B' } : { background: 'transparent' }}>
                                <div className="flex items-center justify-between mb-2">
                                  <p className="text-[10px] font-semibold text-stone uppercase tracking-[0.12em]">{t.tier_label ?? `Tier ${origIdx + 1}`}</p>
                                  {!isEditingTier && (
                                    <button onClick={() => { setTierEditValue(t.rate_per_unit != null ? `${t.rate_per_unit}` : ''); setTierEditing(origIdx) }}
                                      title="Edit this rate" className="text-stone/35 hover:text-forest transition-colors">
                                      <i className="ti ti-pencil-minus" style={{ fontSize: 12 }} />
                                    </button>
                                  )}
                                </div>
                                {isEditingTier ? (
                                  <div className="flex items-center gap-2 mt-1">
                                    <input autoFocus type="text" value={tierEditValue}
                                      onChange={e => setTierEditValue(e.target.value)}
                                      onKeyDown={ev => { if (ev.key === 'Enter') saveTierRate(origIdx); if (ev.key === 'Escape') setTierEditing(null) }}
                                      placeholder={terms?.number_format === 'comma' ? 'e.g. 0,035' : 'e.g. 0.035'}
                                      className="flex-1 text-[28px] font-medium bg-transparent outline-none leading-none"
                                      style={{ color: '#1A3D2B', fontVariantNumeric: 'tabular-nums' }} />
                                    <button onClick={() => setTierEditing(null)} className="text-stone/50 hover:text-ink transition-colors p-1 flex-shrink-0" title="Cancel">
                                      <i className="ti ti-x" style={{ fontSize: 13 }} />
                                    </button>
                                    {tierEditValue && (
                                      <button onClick={() => saveTierRate(origIdx)} disabled={tierSaving} title="Save"
                                        className="flex items-center justify-center w-8 h-8 rounded-lg text-white transition-colors flex-shrink-0 disabled:opacity-50"
                                        style={{ background: '#1A3D2B' }}>
                                        {tierSaving ? <i className="ti ti-loader-2 animate-spin" style={{ fontSize: 13 }} /> : <i className="ti ti-check" style={{ fontSize: 13 }} />}
                                      </button>
                                    )}
                                  </div>
                                ) : (
                                  <>
                                    <div className="flex items-baseline gap-1.5">
                                      <span className="text-[30px] font-medium leading-none" style={{ color: '#1A3D2B', fontVariantNumeric: 'tabular-nums' }}>
                                        {t.rate_per_unit != null ? fmtRate(t.rate_per_unit) : '—'}
                                      </span>
                                      <span className="text-[12px] text-stone">/ {t.unit_type ?? 'unit'}</span>
                                    </div>
                                    {note && <p className="text-[11px] text-stone mt-1">{note}</p>}
                                  </>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Price escalations */}
              {(terms?.escalators?.length ?? 0) > 0 && (
                <div className="p-6">
                  <SectionHeader title="Price escalations" section={src.escalators} onSection={openPDF} />
                  <div className="grid grid-cols-3 gap-8">
                    {terms!.escalators!.map((e, i) => {
                      const isEditing = escEditing === i
                      const label = e.escalator_type === 'fixed_pct' ? 'Fixed annual increase' : e.escalator_type ?? 'Escalator'
                      const note  = e.effective_date
                        ? `Effective ${fmtDate(e.effective_date)}${e.cap_pct ? ` · capped at ${e.cap_pct}%` : ''}`
                        : e.description ?? undefined
                      return (
                        <div key={i} className="rounded-xl p-4 transition-all"
                          style={isEditing ? { background: '#FFFBEB', border: '1px solid #F59E0B' } : { background: 'transparent' }}>
                          <div className="flex items-center justify-between mb-2">
                            <p className="text-[10px] font-semibold text-stone uppercase tracking-[0.12em]">{label}</p>
                            {!isEditing && (
                              <button onClick={() => { setEscEditValue(e.escalator_pct != null ? `${e.escalator_pct}` : ''); setEscEditing(i) }}
                                title="Edit this value" className="text-stone/35 hover:text-forest transition-colors">
                                <i className="ti ti-pencil-minus" style={{ fontSize: 12 }} />
                              </button>
                            )}
                          </div>
                          {isEditing ? (
                            <div className="flex items-center gap-2 mt-1">
                              <input autoFocus type="text" value={escEditValue}
                                onChange={e => setEscEditValue(e.target.value)}
                                onKeyDown={ev => { if (ev.key === 'Enter') saveEscalatorPct(i); if (ev.key === 'Escape') setEscEditing(null) }}
                                placeholder="e.g. 3"
                                className="flex-1 text-[28px] font-medium bg-transparent outline-none leading-none"
                                style={{ color: '#1A3D2B', fontVariantNumeric: 'tabular-nums' }} />
                              <span className="text-sm text-stone self-end pb-0.5">%</span>
                              <button onClick={() => setEscEditing(null)} className="text-stone/50 hover:text-ink transition-colors p-1 flex-shrink-0" title="Cancel">
                                <i className="ti ti-x" style={{ fontSize: 13 }} />
                              </button>
                              {escEditValue && (
                                <button onClick={() => saveEscalatorPct(i)} disabled={escSaving} title="Save"
                                  className="flex items-center justify-center w-8 h-8 rounded-lg text-white transition-colors flex-shrink-0 disabled:opacity-50"
                                  style={{ background: '#1A3D2B' }}>
                                  {escSaving ? <i className="ti ti-loader-2 animate-spin" style={{ fontSize: 13 }} /> : <i className="ti ti-check" style={{ fontSize: 13 }} />}
                                </button>
                              )}
                            </div>
                          ) : (
                            <>
                              <div className="flex items-baseline gap-1.5">
                                <span className="text-[30px] font-medium leading-none" style={{ color: '#1A3D2B', fontVariantNumeric: 'tabular-nums' }}>
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
              )}
            </div>

            {/* ── 4. Pricing ── */}
            {(terms?.base_monthly_fee || terms?.year_pricing ||
              (terms?.ramp_schedule?.length ?? 0) > 0 ||
              serviceFeeTotal > 0 || hardwareFeeTotal > 0) && (
              <div className="bg-white rounded-2xl border border-forest/10 p-6">
                <h2 className="text-[10px] font-bold text-stone uppercase tracking-[0.14em] mb-5">Pricing</h2>
                <div className="grid grid-cols-3 gap-8">
                  {terms?.base_monthly_fee && (
                    <BigValue label="Monthly fee"
                      value={fmt(terms.base_monthly_fee + (terms.additional_recurring_fees ?? []).reduce((s, f) => s + Number(f.amount ?? 0), 0), cur)}
                      unit="/ month"
                      warn={baseItem ? baseItem.confidence_score < 0.95 && !correction(baseItem.id) : false}>
                      {baseItem && baseItem.confidence_score < 0.95 && (
                        <CorrectionInput value={correction(baseItem.id)} onChange={v => setCorr(baseItem.id, v)} />
                      )}
                    </BigValue>
                  )}
                  {terms?.year_pricing && Object.entries(terms.year_pricing).map(([year, price]) => {
                    const yItem = findItem(`${year} pricing`)
                    return (
                      <BigValue key={year} label={`${year.replace('year', 'Year ')} annual value`}
                        value={fmt(price, cur)} unit="/ year"
                        warn={yItem ? yItem.confidence_score < 0.95 && !correction(yItem.id) : false}>
                        {yItem && yItem.confidence_score < 0.95 && (
                          <CorrectionInput value={correction(yItem.id)} onChange={v => setCorr(yItem.id, v)} />
                        )}
                      </BigValue>
                    )
                  })}
                  {terms?.ramp_schedule && terms.ramp_schedule.map((step, i) => {
                    const disc = (terms?.discounts ?? []).find(d => {
                      const ds = d.start_date ? parseLocalDate(d.start_date) : null
                      const de = d.end_date   ? parseLocalDate(d.end_date)   : null
                      const ss = parseLocalDate(step.start_date)
                      return ds && de && ss >= ds && ss <= de
                    })
                    const netFee = disc?.discount_pct ? step.monthly_fee * (1 - disc.discount_pct / 100) : null
                    return (
                      <BigValue key={i} label={step.label ?? `Ramp ${i + 1}`} value={fmt(step.monthly_fee, cur)} unit="/ month gross"
                        note={[
                          `${fmtDate(step.start_date)} – ${fmtDate(step.end_date)}`,
                          netFee ? `Net after ${disc!.discount_pct}% discount: ${fmt(netFee, cur)}/mo` : null,
                        ].filter(Boolean).join(' · ')} />
                    )
                  })}
                  {serviceFeeTotal > 0 && (
                    <BigValue label="Services total" value={fmt(serviceFeeTotal, cur)}
                      note={`${serviceFees.length} fee${serviceFees.length > 1 ? 's' : ''} · one-time`} />
                  )}
                  {hardwareFeeTotal > 0 && (
                    <BigValue label="Hardware / physical" value={fmt(hardwareFeeTotal, cur)}
                      note={`${hardwareFees.length} item${hardwareFees.length > 1 ? 's' : ''} · one-time`} />
                  )}
                </div>
              </div>
            )}

            {/* ── 5. Price calculations (collapsible) ── */}
            {terms?.extraction_notes && terms?.year_pricing && (() => {
              const calcRows = Object.keys(terms.year_pricing).map(yr => ({
                label: yr.replace('year', 'Year '),
                note: getYearNote(terms.extraction_notes, yr),
              })).filter(r => r.note)
              if (calcRows.length === 0) return null
              return (
                <div className="bg-white rounded-2xl border border-forest/10 overflow-hidden">
                  <button
                    onClick={() => setCalcExpanded(v => !v)}
                    className="w-full p-6 flex items-center justify-between text-left"
                    style={{ borderBottom: calcExpanded ? '1px solid rgba(26,61,43,0.07)' : undefined }}
                  >
                    <div>
                      <h2 className="text-[10px] font-bold text-stone uppercase tracking-[0.14em]">Price calculations</h2>
                      <p className="text-[11px] text-stone mt-0.5">How the contracted values were computed — formulas as extracted from the agreement</p>
                    </div>
                    <i className={`ti ti-chevron-${calcExpanded ? 'up' : 'down'} text-stone/40 flex-shrink-0 ml-4`} style={{ fontSize: 16 }} />
                  </button>
                  {calcExpanded && (
                    <div className="px-6 pb-6">
                      {calcRows.map(({ label, note }, i) => (
                        <div key={i} className="flex gap-6 py-4"
                          style={{ borderBottom: i < calcRows.length - 1 ? '1px solid rgba(26,61,43,0.07)' : undefined }}>
                          <p className="text-[11px] font-semibold text-stone w-16 flex-shrink-0 pt-0.5">{label}</p>
                          <p className="text-[11.5px] font-mono leading-relaxed whitespace-pre-line"
                            style={{ color: '#1A3D2B' }}>{note}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })()}

            {/* ── 6. Products & Services Breakdown ── */}
            {(terms?.base_monthly_fee || terms?.year_pricing || (terms?.ramp_schedule?.length ?? 0) > 0 ||
              serviceFees.length > 0 || hardwareFees.length > 0 || otherPosFees.length > 0 || creditFees.length > 0) && (
              <div className="bg-white rounded-2xl border border-forest/10 overflow-hidden">
                <div className="p-6" style={{ borderBottom: '1px solid rgba(26,61,43,0.07)' }}>
                  <h2 className="text-[10px] font-bold text-stone uppercase tracking-[0.14em]">Products &amp; services breakdown</h2>
                  <p className="text-[11px] text-stone mt-0.5">All fee components extracted from the contract</p>
                </div>
                <div className="p-6">
                  <table className="w-full">
                    <thead>
                      <tr>
                        {(['Description', 'Amount', 'Type'] as const).map((h, i) => (
                          <th key={h} className="text-[10px] font-semibold text-stone/60 tracking-[0.1em] pb-2 pr-4 last:pr-0"
                            style={{ borderBottom: '1px solid rgba(26,61,43,0.08)', textAlign: i === 0 ? 'left' : 'right' }}>
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {terms?.base_monthly_fee && (
                        <tr style={{ borderBottom: '1px solid rgba(26,61,43,0.05)' }}>
                          <td className="py-2.5 pr-4 text-[12px] text-ink">{src.base_monthly_fee ?? 'Platform subscription'}</td>
                          <td className="py-2.5 pr-4 text-[12px] font-medium text-ink text-right" style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {fmt(terms.base_monthly_fee, cur)}<span className="text-stone text-[10px] font-normal">/mo</span>
                          </td>
                          <td className="py-2.5 text-[11px] text-stone text-right">Recurring</td>
                        </tr>
                      )}
                      {terms?.year_pricing && Object.entries(terms.year_pricing).map(([yr, price]) => (
                        <tr key={yr} style={{ borderBottom: '1px solid rgba(26,61,43,0.05)' }}>
                          <td className="py-2.5 pr-4 text-[12px] text-ink">
                            Platform subscription · <span className="text-stone">{yr.replace('year', 'Year ')}</span>
                          </td>
                          <td className="py-2.5 pr-4 text-[12px] font-medium text-ink text-right" style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {fmt(price, cur)}<span className="text-stone text-[10px] font-normal">/yr</span>
                          </td>
                          <td className="py-2.5 text-[11px] text-stone text-right">Recurring</td>
                        </tr>
                      ))}
                      {terms?.ramp_schedule && terms.ramp_schedule.map((step, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid rgba(26,61,43,0.05)' }}>
                          <td className="py-2.5 pr-4 text-[12px] text-ink">
                            {step.label ?? `Ramp stage ${i + 1}`}
                            <span className="text-stone text-[10px] ml-2">{fmtDate(step.start_date)} – {fmtDate(step.end_date)}</span>
                          </td>
                          <td className="py-2.5 pr-4 text-[12px] font-medium text-ink text-right" style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {fmt(step.monthly_fee, cur)}<span className="text-stone text-[10px] font-normal">/mo</span>
                          </td>
                          <td className="py-2.5 text-[11px] text-stone text-right">Recurring</td>
                        </tr>
                      ))}
                      {serviceFees.map((f, i) => (
                        <tr key={`svc-${i}`} style={{ borderBottom: '1px solid rgba(26,61,43,0.05)' }}>
                          <td className="py-2.5 pr-4 text-[12px] text-ink">
                            {f.fee_label}
                            {f.description && <span className="text-stone text-[10px] block">{f.description}</span>}
                          </td>
                          <td className="py-2.5 pr-4 text-[12px] font-medium text-ink text-right" style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {f.manual_trigger && f.rate_per_unit
                              ? <span>{fmt(f.rate_per_unit, cur)}<span className="text-stone font-normal">/{f.metric_name ?? 'unit'}</span></span>
                              : fmt(f.amount, cur)}
                          </td>
                          <td className="py-2.5 text-[11px] text-stone text-right">
                            {f.manual_trigger ? <span className="text-amber-600">On delivery</span> : 'Services'}
                          </td>
                        </tr>
                      ))}
                      {hardwareFees.map((f, i) => (
                        <tr key={`hw-${i}`} style={{ borderBottom: '1px solid rgba(26,61,43,0.05)' }}>
                          <td className="py-2.5 pr-4 text-[12px] text-ink">
                            {f.fee_label}
                            {f.description && <span className="text-stone text-[10px] block">{f.description}</span>}
                          </td>
                          <td className="py-2.5 pr-4 text-[12px] font-medium text-ink text-right" style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {f.manual_trigger && f.rate_per_unit
                              ? <span>{fmt(f.rate_per_unit, cur)}<span className="text-stone font-normal">/{f.metric_name ?? 'unit'}</span></span>
                              : fmt(f.amount, cur)}
                          </td>
                          <td className="py-2.5 text-[11px] text-stone text-right">
                            {f.manual_trigger ? <span className="text-amber-600">On delivery</span> : 'Hardware'}
                          </td>
                        </tr>
                      ))}
                      {otherPosFees.map((f, i) => (
                        <tr key={`oth-${i}`} style={{ borderBottom: '1px solid rgba(26,61,43,0.05)' }}>
                          <td className="py-2.5 pr-4 text-[12px] text-ink">
                            {f.fee_label}
                            {f.description && <span className="text-stone text-[10px] block">{f.description}</span>}
                          </td>
                          <td className="py-2.5 pr-4 text-[12px] font-medium text-ink text-right" style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {f.manual_trigger && f.rate_per_unit
                              ? <span>{fmt(f.rate_per_unit, cur)}<span className="text-stone font-normal">/{f.metric_name ?? 'unit'}</span></span>
                              : fmt(f.amount, cur)}
                          </td>
                          <td className="py-2.5 text-[11px] text-stone text-right">
                            {f.manual_trigger ? <span className="text-amber-600">On delivery</span> : 'One-time'}
                          </td>
                        </tr>
                      ))}
                      {creditFees.map((f, i) => (
                        <tr key={`cr-${i}`} style={{ borderBottom: '1px solid rgba(26,61,43,0.05)' }}>
                          <td className="py-2.5 pr-4 text-[12px]" style={{ color: '#B45309' }}>{f.fee_label}</td>
                          <td className="py-2.5 pr-4 text-[12px] font-medium text-right" style={{ fontVariantNumeric: 'tabular-nums', color: '#B45309' }}>{fmt(f.amount, cur)}</td>
                          <td className="py-2.5 text-[11px] text-right" style={{ color: '#B45309' }}>Credit</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ── 7. Billing Configuration ── */}
            <div className="bg-white rounded-2xl border border-forest/10 overflow-hidden">
              <div className="p-6 flex items-center justify-between" style={{ borderBottom: '1px solid rgba(26,61,43,0.07)' }}>
                <div>
                  <h2 className="text-[10px] font-bold text-stone uppercase tracking-[0.14em]">Billing configuration</h2>
                  <p className="text-[11px] text-stone mt-1">Line items to be configured in the billing platform</p>
                </div>
                <div className="flex items-center gap-3">
                  {items.length > 0 && (
                    <button onClick={() => downloadBillingCSV(items, job.name, cur)}
                      className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-xl transition-colors"
                      style={{ background: '#EEF9F2', color: '#1A3D2B', border: '1px solid rgba(74,124,89,0.25)' }}>
                      <i className="ti ti-download" style={{ fontSize: 12 }} /> Download CSV
                    </button>
                  )}
                  {isConfigured && (
                    <span className="text-xs font-semibold px-3 py-2 rounded-xl flex items-center gap-1.5"
                      style={{ background: '#D4EAD9', color: '#1A3D2B', border: '1px solid rgba(74,124,89,0.3)' }}>
                      <i className="ti ti-circle-check" style={{ fontSize: 12 }} />
                      Configured in {billingPlatform === 'remembill' ? 'Remembill' : billingPlatform === 'chargebee' ? 'Chargebee' : 'Stripe'}
                    </span>
                  )}
                </div>
              </div>

              {items.length > 0 && (() => {
                const platformLabel = billingPlatform === 'remembill' ? 'Remembill' : billingPlatform === 'chargebee' ? 'Chargebee' : 'Stripe'
                const periodOptions = ['monthly', 'quarterly', 'semi-annual', 'annual', 'one_time']
                const editCellStyle = 'w-full text-right bg-transparent border-0 border-b border-forest/30 focus:outline-none focus:border-forest text-[12px] tabular-nums py-0 px-0'
                return (
                <div className="p-6">
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr>
                          {(['Product', 'Qty', 'Unit price', 'Total', 'Period'] as const).map((h, idx) => (
                            <th key={h} className="text-[10px] font-semibold text-stone/60 tracking-[0.1em] pb-2"
                              style={{ borderBottom: '1px solid rgba(26,61,43,0.08)', textAlign: idx === 0 ? 'left' : 'right', paddingRight: idx < 4 ? 16 : 0 }}>
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {items.map(item => {
                          const isEscalator = classifyItem(item) === 'escalator'
                          const isVariable  = classifyItem(item) === 'one_time' && item.total_amount === 0
                          return (
                          <tr key={item.id} style={{ borderBottom: '1px solid rgba(26,61,43,0.05)' }}>
                            {/* Product */}
                            <td className="py-2.5 pr-4 text-[12px] text-ink">
                              {item.confidence_score < 0.95 && !correction(item.id) && (
                                <i className="ti ti-alert-triangle mr-1.5" style={{ fontSize: 11, color: '#D97706' }} />
                              )}
                              {correction(item.id) || item.product_name}
                              {item.source_section && (
                                <button onClick={() => openPDF(item.source_section)} className="ml-1.5 text-stone/40 hover:text-forest transition-colors" title="View in PDF">
                                  <i className="ti ti-file-text" style={{ fontSize: 10 }} />
                                </button>
                              )}
                            </td>

                            {/* Qty — editable */}
                            <td className="py-2.5 pr-4 text-[12px] text-stone text-right" style={{ fontVariantNumeric: 'tabular-nums', minWidth: 48 }}>
                              {!isEscalator && billingEdit?.itemId === item.id && billingEdit.field === 'quantity' ? (
                                <input autoFocus type="number" min="0" step="1"
                                  className={editCellStyle}
                                  style={{ width: 56 }}
                                  value={billingEdit.value}
                                  onChange={e => setBillingEdit(b => b && ({ ...b, value: e.target.value }))}
                                  onBlur={() => { saveLineItemField(item.id, 'quantity', billingEdit.value); setBillingEdit(null) }}
                                  onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                                />
                              ) : (
                                <span
                                  className={isEscalator ? '' : 'cursor-pointer hover:text-forest transition-colors'}
                                  title={isEscalator ? undefined : 'Click to edit'}
                                  onClick={() => !isEscalator && setBillingEdit({ itemId: item.id, field: 'quantity', value: String(item.quantity) })}
                                >{item.quantity}</span>
                              )}
                            </td>

                            {/* Unit price — editable */}
                            <td className="py-2.5 pr-4 text-[12px] text-stone text-right" style={{ fontVariantNumeric: 'tabular-nums', minWidth: 96 }}>
                              {isEscalator ? (
                                <span>{item.unit_price != null ? `${item.unit_price}%` : '—'}</span>
                              ) : billingEdit?.itemId === item.id && billingEdit.field === 'unit_price' ? (
                                <input autoFocus type="number" min="0" step="any"
                                  className={editCellStyle}
                                  style={{ width: 96 }}
                                  value={billingEdit.value}
                                  onChange={e => setBillingEdit(b => b && ({ ...b, value: e.target.value }))}
                                  onBlur={() => { saveLineItemField(item.id, 'unit_price', billingEdit.value); setBillingEdit(null) }}
                                  onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                                />
                              ) : (
                                <span
                                  className="cursor-pointer hover:text-forest transition-colors"
                                  title="Click to edit"
                                  onClick={() => {
                                    if (classifyItem(item) === 'one_time' && item.unit_price === 0) {
                                      const termFee = allFees.find(f => f.fee_label === item.product_name)
                                      if (termFee?.manual_trigger && termFee.rate_per_unit) {
                                        setBillingEdit({ itemId: item.id, field: 'unit_price', value: String(termFee.rate_per_unit) })
                                        return
                                      }
                                    }
                                    setBillingEdit({ itemId: item.id, field: 'unit_price', value: String(item.unit_price) })
                                  }}
                                >
                                  {classifyItem(item) === 'one_time' && item.unit_price === 0 ? (() => {
                                    const termFee = allFees.find(f => f.fee_label === item.product_name)
                                    if (termFee?.manual_trigger && termFee.rate_per_unit) {
                                      return <span>{fmt(termFee.rate_per_unit, cur)}<span className="text-stone/60">/{termFee.metric_name ?? 'unit'}</span></span>
                                    }
                                    return fmtUnit(item.unit_price, cur)
                                  })() : fmtUnit(item.unit_price, cur)}
                                </span>
                              )}
                            </td>

                            {/* Total — calculated, read-only */}
                            <td className="py-2.5 pr-4 text-[12px] font-medium text-ink text-right" style={{ fontVariantNumeric: 'tabular-nums' }}>
                              {isEscalator
                                ? <span>{item.total_amount != null ? `${item.total_amount}%` : '—'}</span>
                                : isVariable
                                  ? <span className="text-amber-600 font-normal text-[11px]">Variable — on delivery</span>
                                  : fmt(item.total_amount, cur)}
                            </td>

                            {/* Period — editable via select */}
                            <td className="py-2.5 text-[11px] text-stone text-right">
                              {isEscalator ? (
                                <span className="capitalize">{item.billing_period}</span>
                              ) : (
                                <select
                                  value={item.billing_period ?? 'monthly'}
                                  onChange={e => saveLineItemField(item.id, 'billing_period', e.target.value)}
                                  className="bg-transparent border-0 text-[11px] text-stone text-right focus:outline-none cursor-pointer hover:text-forest transition-colors capitalize appearance-none"
                                  style={{ direction: 'rtl' }}
                                >
                                  {periodOptions.map(p => (
                                    <option key={p} value={p} style={{ direction: 'ltr' }}>{p.replace('_', ' ')}</option>
                                  ))}
                                </select>
                              )}
                            </td>
                          </tr>
                        )})}
                      </tbody>
                      {/* Fixed fees footer */}
                      <tfoot>
                        <tr style={{ borderTop: '2px solid rgba(26,61,43,0.10)' }}>
                          <td colSpan={3} className="pt-3 text-[10px] font-bold text-stone uppercase tracking-[0.1em]">Fixed fees</td>
                          <td className="pt-3 text-[13px] font-semibold text-ink text-right pr-4" style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {fmt(tcv, cur)}
                          </td>
                          <td />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                  <p className="text-[10px] text-stone/50 mt-4">
                    Platform: <span className="font-medium text-stone/70">{platformLabel}</span>
                  </p>
                </div>
              )})()}

              {isConfigured && billingPlatform === 'chargebee' && dashboardUrl && (
                <div className="px-6 py-4 flex items-center justify-between" style={{ background: 'rgba(26,61,43,0.04)', borderTop: '1px solid rgba(26,61,43,0.07)' }}>
                  <div>
                    <p className="text-[11px] font-semibold text-ink">Active subscription in Chargebee</p>
                    {subId && <p className="text-[10px] text-stone font-mono mt-0.5">{subId}</p>}
                  </div>
                  <a href={dashboardUrl} target="_blank" rel="noreferrer"
                    className="text-xs font-semibold px-4 py-2 rounded-xl text-white transition-colors"
                    style={{ background: '#1A3D2B' }}>
                    View in Chargebee →
                  </a>
                </div>
              )}
            </div>

            {/* ── 8. Billing Setup ── */}
            {isConfigured && (billingPlatform === 'stripe' || billingPlatform === 'remembill') && (!!subId || !!job.billing_customer_id || !!approved?.customerId) && (
              <>
                {parkedInvoices.length > 0 && (
                  <ParkedInvoicesCard jobId={id} parkedInvoices={parkedInvoices} />
                )}
                <ManualInvoiceCard jobId={id} />
                {(terms?.overage_tiers?.length ?? 0) > 0 && (
                  <ConsumptionTimelineCard jobId={id} />
                )}
                <BillingSummaryCard jobId={id} key={rebuildDone ? 'rebuilt' : approved ? 'approved' : 'initial'} onHasSchedule={setScheduleExists} onParkedInvoices={setParkedInvoices} onSentOneTimeInvoices={setSentOneTimeInvoices} />
                {/* Rebuild banner — shown when customer exists but no planned schedule yet */}
                {!subId && !rebuildDone && scheduleExists === false && (() => {
                  const missingForRebuild: string[] = []
                  if (!terms?.contract_start_date) missingForRebuild.push('start date')
                  if (!terms?.contract_term_months && !terms?.contract_end_date) missingForRebuild.push('end date or term length')
                  return (
                  <div className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 flex items-start gap-3">
                    <i className="ti ti-calendar-x flex-shrink-0 mt-0.5" style={{ fontSize: 16, color: '#D97706' }} />
                    <div className="flex-1">
                      <p className="text-sm font-medium text-amber-900 mb-0.5">Billing schedule not built</p>
                      {missingForRebuild.length > 0 ? (
                        <p className="text-xs text-amber-800 mb-3">
                          Cannot generate the billing schedule — the following information is missing: <strong>{missingForRebuild.join(', ')}</strong>. Add these in the contract details above, then click &ldquo;Generate billing schedule&rdquo;.
                        </p>
                      ) : (
                        <p className="text-xs text-amber-800 mb-3">
                          The billing schedule was not generated when this contract was approved. Click below to create invoices for all billing periods in {billingPlatform === 'remembill' ? 'Remembill' : 'Stripe'}.
                        </p>
                      )}
                      {rebuildError && <p className="text-xs text-red-600 mb-2">{rebuildError}</p>}
                      <button
                        onClick={async () => {
                          setRebuilding(true)
                          setRebuildError(null)
                          try {
                            const res = await fetch(`/api/jobs/${id}/rebuild-schedule`, { method: 'POST' })
                            const data = await res.json()
                            if (!res.ok) setRebuildError(data.error ?? 'Rebuild failed')
                            else setRebuildDone(true)
                          } catch {
                            setRebuildError('Network error — please try again')
                          } finally {
                            setRebuilding(false)
                          }
                        }}
                        disabled={rebuilding || missingForRebuild.length > 0}
                        className="inline-flex items-center gap-2 text-xs font-semibold px-3 py-1.5 rounded-xl transition-colors disabled:opacity-40"
                        style={{ background: '#1A3D2B', color: '#fff' }}
                      >
                        {rebuilding
                          ? <><i className="ti ti-loader-2 animate-spin" style={{ fontSize: 11 }} /> Generating…</>
                          : <><i className="ti ti-calendar-plus" style={{ fontSize: 11 }} /> Generate billing schedule</>}
                      </button>
                    </div>
                  </div>
                  )
                })()}
              </>
            )}

            {/* ── Warning: missing dates ── */}
            {(!terms?.contract_start_date || !terms?.contract_end_date) && (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 flex items-start gap-3">
                <i className="ti ti-alert-triangle flex-shrink-0 mt-0.5" style={{ fontSize: 16, color: '#D97706' }} />
                <div>
                  <p className="text-sm font-medium text-amber-900 mb-0.5">
                    {!terms?.contract_start_date && !terms?.contract_end_date
                      ? 'Contract start and end dates are missing'
                      : !terms?.contract_start_date ? 'Contract start date is missing'
                      : 'Contract end date is missing'}
                  </p>
                  <p className="text-xs text-amber-800">
                    Fixed fees cannot be calculated without both dates. Click the date fields above in Contract overview to add them.
                  </p>
                </div>
              </div>
            )}

            {/* ── Meter mapping (enterprise contracts with overage tiers) ──
                 Stays visible after the job is configured/pushed to billing —
                 mappings can be added or changed later (new meters, missed
                 confirmations), and real usage-based billing depends on them
                 regardless of whether the base fee was already approved. */}
            {tiers.length > 0 && (
              <div id="meter-mapping-panel">
                <MeterMappingPanel
                  jobId={id}
                  currency={cur}
                  isConfigured={isConfigured}
                  onConfirmedChange={setMeterMappingsConfirmed}
                  contractBillingFrequency={terms?.billing_frequency ?? null}
                />
              </div>
            )}

            {/* ── Fixed fees + Approve footer ── */}
            <div className="bg-white rounded-2xl border border-forest/10 px-7 py-5 flex items-center justify-between gap-8">
                {/* Left: label + number */}
                <div className="min-w-0 flex items-end gap-8">
                  <div>
                    <p className="text-[9px] font-bold uppercase tracking-[0.18em] mb-2 text-stone/50">
                      Fixed fees
                    </p>
                    <p className="text-[36px] font-semibold leading-none text-ink" style={{ fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em' }}>
                      {tcv > 0
                        ? fmt(tcv, cur)
                        : billingModel === 'consumption'
                          ? <span className="text-[22px] text-stone/60">Usage-based</span>
                          : <span className="text-stone/30">—</span>}
                    </p>
                    {tcv === 0 && billingModel === 'consumption' && terms?.contract_start_date && terms?.contract_end_date && (
                      <p className="text-[10px] text-stone/40 mt-2">Fixed fees depend on usage volume</p>
                    )}
                    {tcv === 0 && billingModel !== 'consumption' && terms?.contract_start_date && terms?.contract_end_date &&
                      parseLocalDate(terms.contract_end_date) <= parseLocalDate(terms.contract_start_date) && (
                      <p className="text-[10px] text-amber-600 mt-2">End date is before start date — correct it above</p>
                    )}
                    {tcv === 0 && billingModel !== 'consumption' && (!terms?.contract_start_date || !terms?.contract_end_date) && (
                      <p className="text-[10px] text-stone/40 mt-2">Add contract dates above to calculate</p>
                    )}
                  </div>
                  {committedContractValue > tcv && (
                    <div>
                      <p className="text-[9px] font-bold uppercase tracking-[0.18em] mb-2 text-stone/40">Committed contract value</p>
                      <p className="text-[24px] font-semibold leading-none text-stone/60" style={{ fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em' }}>
                        {fmt(committedContractValue, cur)}
                      </p>
                    </div>
                  )}
                  {additionsTotal > 0 && (
                    <div>
                      <p className="text-[9px] font-bold uppercase tracking-[0.18em] mb-2 text-stone/40">Additions</p>
                      <p className="text-[24px] font-semibold leading-none text-stone/60" style={{ fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em' }}>
                        +{fmt(additionsTotal, cur)}
                      </p>
                    </div>
                  )}
                  {billedToDate > 0 && (
                    <div>
                      <p className="text-[9px] font-bold uppercase tracking-[0.18em] mb-2 text-stone/50">
                        {isCompleted ? 'Realised TCV' : 'Billed to date'}
                      </p>
                      <p className="text-[36px] font-semibold leading-none text-ink" style={{ fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em' }}>
                        {fmt(billedToDate, cur)}
                      </p>
                    </div>
                  )}
                </div>

                {/* Right: approve action (only shown before billing is configured) */}
                {!isConfigured && (() => {
                  // Only block when computeBillingSchedule would return [] —
                  // missing term length is the sole hard blocker.
                  // billing_frequency defaults to monthly; base fee defaults to 0.
                  const scheduleBlockers: string[] = []
                  if (!terms?.contract_start_date) scheduleBlockers.push('contract start date')
                  if (!terms?.contract_term_months && !terms?.contract_end_date) scheduleBlockers.push('contract end date or term length')
                  const needsPlatformChoice = connectedBillingPlatforms.length > 1 && !selectedBillingPlatform
                  const blocked = approving || needsReview > 0 || (tiers.length > 0 && !meterMappingsConfirmed) || scheduleBlockers.length > 0 || needsPlatformChoice
                  const platformLabel = selectedBillingPlatform
                    ? selectedBillingPlatform.charAt(0).toUpperCase() + selectedBillingPlatform.slice(1)
                    : connectedBillingPlatforms.length === 1
                      ? connectedBillingPlatforms[0].charAt(0).toUpperCase() + connectedBillingPlatforms[0].slice(1)
                      : 'billing platform'
                  return (
                  <div className="flex flex-col items-end gap-2 flex-shrink-0">
                    {/* Platform selector — only shown when multiple billing platforms connected */}
                    {connectedBillingPlatforms.length > 1 && (
                      <div className="flex flex-col items-end gap-1">
                        <label className="text-[9px] font-bold uppercase tracking-[0.14em] text-stone">
                          Push to
                        </label>
                        <select
                          value={selectedBillingPlatform ?? ''}
                          onChange={e => setSelectedBillingPlatform(e.target.value || null)}
                          className="text-xs font-medium border border-forest/20 rounded-lg px-3 py-1.5 bg-white text-ink focus:outline-none focus:ring-2 focus:ring-forest/20"
                        >
                          <option value="">Select platform…</option>
                          {connectedBillingPlatforms.map(p => (
                            <option key={p} value={p}>
                              {p.charAt(0).toUpperCase() + p.slice(1)}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    <button
                      onClick={handleApprove}
                      disabled={blocked}
                      className="inline-flex items-center gap-2 font-semibold text-[13px] px-6 py-2.5 rounded-xl transition-all disabled:opacity-40 bg-forest text-white hover:bg-sage">
                      {approving
                        ? <><i className="ti ti-loader-2 animate-spin" style={{ fontSize: 13 }} /> Pushing to {platformLabel}…</>
                        : isFailed
                          ? <>Retry push to {platformLabel} <i className="ti ti-refresh" style={{ fontSize: 13 }} /></>
                          : <>Approve &amp; push to {platformLabel} <i className="ti ti-arrow-up-right" style={{ fontSize: 13 }} /></>}
                    </button>
                    {needsPlatformChoice && (
                      <p className="text-[10px] text-amber-600">Select a billing platform above</p>
                    )}
                    {scheduleBlockers.length > 0 && needsReview === 0 && (
                      <p className="text-[10px] text-amber-600 text-right max-w-[220px]">
                        Billing schedule needs: {scheduleBlockers.join(', ')}
                      </p>
                    )}
                    {needsReview > 0 && (
                      <p className="text-[10px] text-stone/50">
                        Review {needsReview} flagged item{needsReview > 1 ? 's' : ''} above first
                      </p>
                    )}
                    {tiers.length > 0 && !meterMappingsConfirmed && needsReview === 0 && scheduleBlockers.length === 0 && (
                      <p className="text-[10px] text-amber-600">
                        Confirm billing meter mappings above first
                      </p>
                    )}
                    {approveError && <p className="text-[10px] text-red-500 max-w-xs">{approveError}</p>}
                  </div>
                  )
                })()}
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
          overageTiers={terms?.overage_tiers}
          numberFormat={terms?.number_format ?? 'dot'}
          onViewSource={openPDF}
        />
      )}

      {/* ── PDF Drawer ──────────────────────────────────────────────────── */}
      {/* When the review panel is also open, stop short of its 480px width
          instead of covering it — "View source clause" should let the
          reviewer see the clause and the term they're confirming at once,
          not replace one drawer with the other. */}
      {drawer.open && (
        <div className="fixed inset-0 z-40 flex justify-end" style={reviewPanelOpen ? { right: 480 } : undefined}>
          <div className="absolute inset-0 bg-black/35" onClick={() => closePDF()} />
          <div className="relative h-full bg-white shadow-2xl flex flex-col" style={{ width: `${PANEL_WIDTH_PCT}%` }}>
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
                    ? <PDFViewer url={pdfUrl} section={drawer.section} />
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
