'use client'

import { useState, useEffect, useCallback, useRef, use, Fragment } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { RevenueModelTab } from '@/app/_components/RevenueModelTab'
import { BillingSummaryCard } from '@/app/_components/BillingSummaryCard'
import { VatConfigRow } from '@/app/_components/VatConfigRow'
import { useVatConfig } from '@/app/_components/useVatConfig'
import { MeterMappingPanel } from '@/app/_components/MeterMappingPanel'
import { ParkedInvoicesCard } from '@/app/_components/ParkedInvoicesCard'
import { ConsumptionTimelineCard } from '@/app/_components/ConsumptionTimelineCard'
import { ManualInvoiceCard } from '@/app/_components/ManualInvoiceCard'
import { computeBaseTcv, contractLifecycleStatus } from '@/lib/contract-tcv-calc'
import { ruleCadenceLabel, cadenceNoun, contractMonthLabel } from '@/lib/cadence-labels'
import { optionsForRuleType, optionsForEdit, deriveSelectedOption, type RuleType, type StructuredOption, type RuleProposal } from '@/lib/rule-interpretation'
import { detectRuleInteractionCandidates } from '@/lib/rule-interactions'
import { computeCommercialRuleWorkload, isMinimumCommitmentModeUnresolved, isMinimumCommitmentProrationUnresolved, isServiceCreditUnresolved, isDiscountUnresolved } from '@/lib/commercial-rule-status'
import { isMeterMappingResolved } from '@/lib/meter-mapping-status'

const PDFViewer = dynamic(() => import('@/app/_components/PDFViewer'), { ssr: false })

// ── Types ──────────────────────────────────────────────────────────────────

type Escalator = {
  escalator_pct?: number; escalator_type?: string; effective_date?: string; description?: string; cap_pct?: number
  interpretation?: {
    treatment: 'applies' | 'not_applied'
    index: 'CPI' | 'fixed_pct' | 'other' | null
    frequency: 'annual' | 'monthly' | 'quarterly' | null
    effective_date: string | null
    cap_pct: number | null
    calculation_method: string | null
    requires_confirmation: boolean
    confirmation_reason?: string | null
  } | null
}
type Discount   = {
  discount_rule_id?: string
  discount_pct?: number; discount_amount?: number; discount_type?: string; start_date?: string; end_date?: string; duration_months?: number; applies_to?: string; description?: string
  interpretation?: {
    discount_type: 'flat_percentage' | 'flat_amount' | 'tiered_discount' | 'volume_discount' | 'component_specific' | 'time_ramp' | 'custom'
    discount_basis: 'percentage' | 'amount'
    tier_method: 'graduated' | 'volume' | 'block' | 'custom' | null
    tiers: Array<{ from_unit: number | null; to_unit: number | null; value: number }> | null
    applies_to: string | null
    application_order: string | null
    reset_period: string | null
    worked_example: string | null
    requires_confirmation: boolean
    confirmation_reason?: string | null
  } | null
}
type ServiceCredit = {
  credit_rule_id?: string
  credit_type?: string; description?: string; source_clause?: string | null; stated_pct?: number | null; stated_amount?: number | null
  interpretation?: {
    trigger_type: 'sla_breach' | 'usage_threshold' | 'promotional' | 'earned_milestone' | 'other'
    trigger_description: string | null
    credit_basis: 'pct_of_period_fee' | 'pct_of_affected_component' | 'flat_amount' | 'usage_units'
    basis_component: string | null
    credit_value: number | null
    cap_amount: number | null
    cap_pct: number | null
    settlement_period: string | null
    cash_redeemable: boolean
    interaction_note?: string | null
    requires_confirmation: boolean
    confirmation_reason?: string | null
    // Independent gate on top of the main interpretation's own
    // requires_confirmation — a credit can be fully confirmed on
    // trigger/rate/cap while what it may reduce (and whether it carries
    // forward) remains a real, separate, unresolved decision the contract
    // never stated. See buildCreditApplicationRule (confirm-rule/route.ts).
    application_rule?: {
      eligible_component_keys: string[] | 'all' | null
      carry_forward: boolean | 'unclear'
      one_time: boolean | 'unclear'
      requires_confirmation: boolean
      confirmation_reason?: string | null
    } | null
  } | null
}
type Tier       = {
  tier_label?: string; from_unit?: number; to_unit?: number; rate_per_unit?: number; unit_type?: string
  measurement_period?: 'monthly' | 'quarterly' | 'semi-annual' | 'annual' | null
  minimum_period_amount?: number | null
  minimum_commitment?: {
    mode: 'floor' | 'additive' | 'minimum_spend' | 'prepaid_commitment' | 'minimum_quantity'
    amount: number
    period?: 'monthly' | 'quarterly' | 'semi-annual' | 'annual' | null
    included_allowance_interaction?: 'before_allowance' | 'after_allowance' | 'unclear'
    prorate_partial_periods?: boolean | 'unclear'
    source_clause?: string | null
    requires_confirmation: boolean
    confirmation_reason?: string | null
  } | null
  reset_anchor?: 'contract_start' | 'calendar' | null
  tier_calculation?: {
    method: 'graduated' | 'volume' | 'block' | 'custom'
    source_clause?: string | null
    requires_confirmation: boolean
    confirmation_reason?: string | null
  } | null
}

type OneTimeFee = { fee_label: string; amount: number; due_date?: string | null; description?: string | null; manual_trigger?: boolean; metric_name?: string | null; rate_per_unit?: number | null }
type PeriodProrationRule = {
  reset_anchor: 'contract_start' | 'calendar' | null
  prorate_partial_periods: boolean | 'unclear'
  requires_confirmation: boolean
  confirmation_reason?: string | null
  source_clause?: string | null
}
type AdditionalRecurringFee = { fee_label: string; amount: number; description?: string | null; billing_frequency?: 'monthly' | 'quarterly' | 'semi-annual' | 'annual' | null; proration?: PeriodProrationRule | null }

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
  base_fee_proration?: PeriodProrationRule | null
  billing_frequency?: string; payment_terms_days?: number; payment_terms_text?: string
  included_units?: number; included_unit_type?: string
  year_pricing?: Record<string, number>
  ramp_schedule?: { start_date: string; end_date: string; monthly_fee: number; label?: string }[]
  escalators?: Escalator[]; discounts?: Discount[]; service_credits?: ServiceCredit[]; overage_tiers?: Tier[]
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

// AI reasoning defaults to 2-3 sentences on the review card — a full
// chain-of-reasoning paragraph buries "what Verdix thinks / why / what it
// costs" under prose the reviewer has to wade through. Splits on
// sentence-ending punctuation rather than truncating by character count, so
// it never cuts off mid-sentence.
function truncateSentences(text: string, maxSentences = 3, maxChars = 220): { short: string; truncated: boolean } {
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [text]
  const bySentence = sentences.length > maxSentences ? sentences.slice(0, maxSentences).join('').trim() : text
  if (bySentence.length <= maxChars) return { short: bySentence, truncated: bySentence !== text }
  // A hard character-length safety net — a single long run-on sentence (or
  // several short ones with no terminal punctuation the regex could split
  // on) would otherwise sail through the sentence-count check untouched.
  const hardCut = bySentence.slice(0, maxChars).replace(/\s+\S*$/, '')
  return { short: `${hardCut}…`, truncated: true }
}

// For per-unit rates which are often fractional (e.g. €0.05, SEK 0.035).
// fmt() fixes 2 decimal places, which would round a sub-cent rate like
// 0.0035 away to 0.00, so this keeps up to 4 decimal places for values < 1.
// Always routes through Intl.NumberFormat (same as fmt()) rather than a
// hand-maintained symbol table — the old table showed "kr" for SEK/NOK/DKK
// here but "SEK"/"NOK"/"DKK" everywhere fmt() was used instead, which read
// as inconsistent for the same currency. Intl's en-US currency formatting
// already renders major currencies with their real symbol (€, $, £, ¥) and
// everything else as its ISO code (SEK, CHF, PLN, ...) — the one convention
// this file should use everywhere.
function fmtUnit(n: number | null | undefined, cur = 'EUR') {
  if (n == null) return '—'
  const fractionDigits = n > 0 && n < 1 ? 4 : 2
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, minimumFractionDigits: 0, maximumFractionDigits: fractionDigits }).format(n)
}

function fmtDate(s: string | null | undefined) {
  if (!s) return '—'
  return new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

// Short, unambiguous economic-treatment label for a confirmed minimum
// commitment — "SEK 5,000/quarterly minimum" alone reads as an additive
// recurring charge; every display of a confirmed rule must say which
// treatment was actually approved (floor vs additive vs spend commitment).
function ruleModeShortLabel(mode: string): string {
  const labels: Record<string, string> = {
    floor: 'minimum floor', additive: 'additive fee', minimum_spend: 'spend commitment',
    prepaid_commitment: 'prepaid commitment', minimum_quantity: 'minimum quantity',
  }
  return labels[mode] ?? mode
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
  // "flat" specifically claims the entire bill is this one fixed number —
  // false the moment any usage-based pricing exists on the contract, even if
  // that usage hasn't been invoiced yet. A hybrid contract's base fee is
  // still fixed and recurring, just not the whole story, hence "base" here.
  const hasVariablePricing = (terms.overage_tiers?.length ?? 0) > 0
  let pricing: string
  if (terms.ramp_schedule && terms.ramp_schedule.length > 0) {
    const first = terms.ramp_schedule[0]
    const last  = terms.ramp_schedule[terms.ramp_schedule.length - 1]
    pricing = first.monthly_fee === last.monthly_fee
      ? `${hasVariablePricing ? 'base' : 'flat'} ${fmt(first.monthly_fee, cur)}/month subscription`
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
      : `${hasVariablePricing ? 'base' : 'flat'} ${fmt(terms.base_monthly_fee, cur)}/month subscription`
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

  // One-time fees (setup/integration/onboarding) are named separately from
  // the recurring subscription description — folding them into "valued at
  // X" right after "subscription" reads as if X were the subscription's own
  // value, when Fixed fees (tcv) is actually subscription + one-time combined.
  const oneTimeFees = (terms.one_time_fees ?? []).filter(f => (f.amount ?? 0) > 0)
  const oneTimeTotal = oneTimeFees.reduce((s, f) => s + Number(f.amount ?? 0), 0)
  const oneTimeStr = oneTimeFees.length === 1
    ? ` plus a ${fmt(oneTimeFees[0].amount, cur)} one-time ${oneTimeFees[0].fee_label.toLowerCase()}`
    : oneTimeFees.length > 1
      ? ` plus ${fmt(oneTimeTotal, cur)} in one-time fees`
      : ''
  const tcvStr = tcv > 0 ? ` Fixed fees over the initial term: ${fmt(tcv, cur)}.` : ''
  lines.push(`${duration}contract${customer}${dates} — ${pricing}${oneTimeStr}.${tcvStr}`)

  // ── Sentence 2: billing cadence · payment terms · auto-renewal ───────────
  const bits: string[] = []
  // A metric measured on a different cadence than the contract's own
  // billing_frequency makes a flat "billed monthly" misleading — it reads as
  // if everything on the contract invoices monthly, when usage/commercial
  // rules on a different cadence won't. Mirrors the Contract Overview's own
  // "Billing cycle: Mixed" detection (mixedBillingSchedule) so the two can
  // never contradict each other.
  const contractCycleLower = (terms.billing_frequency ?? '').toLowerCase()
  const otherCycles = Array.from(new Set(
    (terms.overage_tiers ?? [])
      .filter(t => t.unit_type && t.measurement_period && t.measurement_period.toLowerCase() !== contractCycleLower)
      .map(t => t.measurement_period!.toLowerCase())
  ))
  if (terms.billing_frequency && otherCycles.length > 0) {
    bits.push(`Base fee billed ${terms.billing_frequency.toLowerCase()}`)
    bits.push(`usage and applicable commercial rules evaluated ${otherCycles.join(' / ')}`)
  } else if (terms.billing_frequency) {
    bits.push(`billed ${terms.billing_frequency.toLowerCase()}`)
  }
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
    const interp = e.interpretation
    if (interp && !interp.requires_confirmation) {
      // A reviewer's confirmed decision is stated as fact, never re-flagged
      // as something still needing a rate confirmed from the source clause —
      // that stale phrasing is exactly the kind of internal contradiction
      // (confirmed vs. "needs review") this brief must not reintroduce.
      extras.push(interp.treatment === 'not_applied'
        ? 'price escalation not applied per confirmed reviewer interpretation'
        : `${interp.index === 'CPI' ? 'CPI-linked' : interp.index === 'fixed_pct' ? 'fixed-percentage' : 'confirmed'} price escalation${interp.cap_pct != null ? `, capped at ${interp.cap_pct}%` : ''}`)
    } else {
      const cap = e.cap_pct ? ` capped at ${e.cap_pct}%` : ''
      extras.push(e.escalator_pct != null
        ? `${e.escalator_pct}% annual escalator${cap}`
        : 'price escalator — needs interpretation')
    }
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

// Lightweight, read-only status — opens the Review panel (where the single
// live, editable MeterMappingPanel instance lives) rather than embedding a
// second full editable panel on the main Terms tab.
function MeterMappingStatusChip({ total, confirmed, onClick }: { total: number; confirmed: number; onClick: () => void }) {
  const allConfirmed = total > 0 && confirmed >= total
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center justify-between gap-3 bg-white rounded-2xl border px-6 py-4 text-left transition-colors hover:bg-stone-50"
      style={{ borderColor: allConfirmed ? 'rgba(11,92,54,0.2)' : '#FAC775' }}
    >
      <div className="flex items-center gap-2.5">
        <i className={`ti ${allConfirmed ? 'ti-circle-check-filled' : 'ti-plug-connected'}`}
          style={{ fontSize: 15, color: allConfirmed ? '#0B5C36' : '#D97706' }} />
        <div>
          <p className="text-sm font-medium text-ink">Usage mapping</p>
          <p className="text-xs text-stone">
            {total === 0 ? 'No metered usage to map' : `${confirmed}/${total} metric${total > 1 ? 's' : ''} confirmed`}
          </p>
        </div>
      </div>
      <span className="text-xs font-medium text-forest">{allConfirmed ? 'View' : 'Resolve'} →</span>
    </button>
  )
}

function BillingModelBadge({ model }: { model: 'fixed' | 'hybrid' | 'consumption' }) {
  const map = {
    fixed:       { label: 'Fixed — Subscription',        bg: '#EEF9F2', color: '#1A3D2B' },
    hybrid:      { label: 'Hybrid — Fixed + Consumption', bg: '#EFF6FF', color: '#1E40AF' },
    consumption: { label: 'Consumption',                  bg: '#FEF9C3', color: '#854D0E' },
  }[model]
  return (
    <span className="text-[10px] font-semibold px-3 py-1.5 rounded-full"
      style={{ background: map.bg, color: map.color }}>
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
          {/* Clicking the value itself starts editing too — hunting for the
              small hover-revealed pencil (especially over a near-empty "—"
              placeholder) was needlessly fiddly. The pencil stays as a
              secondary, more discoverable affordance. */}
          <p
            onClick={startEdit}
            title={`Edit ${label.toLowerCase()}`}
            className="text-[15px] font-medium text-ink leading-snug cursor-pointer rounded -mx-1 px-1 hover:bg-forest/5 transition-colors"
          >
            {value ?? <span className="text-stone/40">—</span>}
          </p>
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

// 'discount' is never produced by classifyItem (discounts aren't LineItems)
// — it exists purely so RuleInterpretationCard's kind→ruleType mapping can
// be reused for the Review panel's dedicated Discounts section below.
type ItemKind = 'overage_tier' | 'escalator' | 'escalator_interpretation' | 'base_fee' | 'user_seat' | 'one_time' | 'minimum_commitment' | 'partial_period' | 'tier_calculation' | 'discount' | 'service_credit' | 'rule_interaction' | 'base_fee_proration' | 'recurring_fee_proration' | 'unknown'
// The subset of ItemKind that's metric-scoped rather than tied to any one
// tariff-tier row — a single metric can need more than one of these at
// once (see metricNeededKinds in ReviewPanel).
type MetricRuleKind = 'minimum_commitment' | 'partial_period' | 'tier_calculation'

// A tier and its rendered LineItem share a tier_label — buildLineItems
// (execute route) sets product_name from tier_label, optionally with a
// trailing "— overage"/"— included in base fee" clause appended.
function stripTierSuffix(label: string): string {
  return label.replace(/\s*—\s*(included in base fee|overage)\s*$/i, '').trim().toLowerCase()
}

function findTierForItem(item: LineItem, tiers: Tier[]): Tier | undefined {
  const cleanName = stripTierSuffix(item.product_name)
  return tiers.find(t => stripTierSuffix(t.tier_label ?? '') === cleanName)
}

// A metric's minimum commitment resets on calendar-quarter (etc.) boundaries
// independent of the contract's own start/end date, so the first and/or
// last window the contract touches can be shorter than a full cadence cycle.
// Thin wrapper around lib/commercial-rule-status.ts's
// isMinimumCommitmentProrationUnresolved — the exact same date-aware window
// check the server-side readiness gate (computeCommercialRuleWorkload,
// approve/route.ts) uses, so this page can never show a partial-period card
// the server doesn't also count as outstanding, or vice versa.
function computePartialPeriodMetrics(contractStartDate: string | undefined, contractEndDate: string | undefined, tiers: Tier[]): Set<string> {
  const result = new Set<string>()
  const byUnit = new Map<string, Tier[]>()
  for (const t of tiers) {
    if (!t.unit_type) continue
    if (!byUnit.has(t.unit_type)) byUnit.set(t.unit_type, [])
    byUnit.get(t.unit_type)!.push(t)
  }
  for (const [unitType, unitTiers] of byUnit) {
    const mc = unitTiers.find(t => t.minimum_commitment)?.minimum_commitment
    const anchorTier = unitTiers.find(t => t.reset_anchor === 'calendar')
    if (isMinimumCommitmentProrationUnresolved(mc, !!anchorTier, anchorTier?.measurement_period, contractStartDate, contractEndDate)) {
      result.add(unitType)
    }
  }
  return result
}

function classifyItem(item: LineItem, escalators: Escalator[] = []): ItemKind {
  const rule = (item.applied_rule ?? '').toLowerCase()
  const name = item.product_name.toLowerCase()

  // One-time fees are unambiguous from billing_period alone — check first.
  // A parked manual-trigger one-time fee also has quantity 0 (same as an
  // unconfirmed usage tier below), so this must run before that check or
  // it would get misclassified as a pricing tier.
  if (item.billing_period === 'one_time' || rule.includes('one_time') || name.includes('setup') || name.includes('onboarding')) return 'one_time'

  if (rule.includes('escalator') || name.includes('escalator') || name.includes('cpi') || name.includes('price escalator')) {
    // A CPI-linked escalator with no resolved rate/interpretation needs the
    // same structured-interpretation flow as an ambiguous minimum — a plain
    // "confirm this value" doesn't make sense when there's no value yet.
    // An interpretation that's present but still flagged requires_confirmation,
    // or whose treatment isn't a recognized value (data predating the
    // treatment field — the exact shape that produced a real "Confirmed" +
    // "unresolved" contradiction), counts as unresolved too, not just an
    // entirely absent interpretation.
    const unresolved = escalators.some(e => e.escalator_pct == null && (
      !e.interpretation
      || e.interpretation.requires_confirmation
      || (e.interpretation.treatment !== 'applies' && e.interpretation.treatment !== 'not_applied')
    ))
    return unresolved ? 'escalator_interpretation' : 'escalator'
  }

  // minimum_commitment / partial_period / tier_calculation are no longer
  // decided here — they're metric-scoped (not tied to any one tariff-tier
  // row), and a metric can need more than one of them simultaneously (e.g.
  // both which minimum mode applies AND how a partial first/last period is
  // treated). Deciding them per-item meant whichever check matched FIRST
  // permanently hid the others until IT was confirmed — the metric-level
  // precomputation right before the render loop (metricNeededKinds) now
  // owns this, independent of item classification.

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

// classifyItem no longer decides tier_calculation (see its own comment) —
// this is the direct replacement for call sites outside ReviewPanel (e.g.
// the Commercial Terms table) that need to know whether a metric's tier
// method is still unresolved, without duplicating the full metricNeededKinds
// precomputation ReviewPanel itself uses.
function isTierCalculationUnresolvedFor(unitType: string | undefined, tiers: Tier[]): boolean {
  if (!unitType) return false
  const metricTiers = tiers.filter(t => t.unit_type === unitType)
  const paidCount = metricTiers.filter(t => (t.rate_per_unit ?? 0) > 0).length
  if (paidCount < 2) return false
  const tierCalc = metricTiers.find(t => t.tier_calculation)?.tier_calculation
  return !tierCalc || tierCalc.requires_confirmation
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
    case 'partial_period': {
      const mc = findTierForItem(item, tiers)?.minimum_commitment
      return {
        typeLabel:          'Partial-period treatment',
        typeIcon:           'ti-calendar-exclamation',
        primaryField:       'unit_price',
        primaryLabel:       'Proration',
        primaryPlaceholder: '',
        whatToCheck:        `Confirm how the ${mc ? fmt(mc.amount, item.currency) : ''} minimum for ${item.product_name} applies to a period the contract wasn't in effect for the whole of.`,
        whyFlagged:         "The agreement begins or ends part-way through a calendar period, but the minimum resets on calendar boundaries. No explicit proration rule was identified.",
      }
    }
    case 'tier_calculation': {
      const tc = findTierForItem(item, tiers)?.tier_calculation
      return {
        typeLabel:          'Tier calculation method',
        typeIcon:           'ti-stairs',
        primaryField:       'unit_price',
        primaryLabel:       'Calculation method',
        primaryPlaceholder: '',
        whatToCheck:        `Confirm whether ${item.product_name}'s price tiers apply per-band (graduated) or re-rate all units once a threshold is reached (volume).`,
        whyFlagged:         tc?.confirmation_reason
          ?? 'This metric has more than one price tier; the contract does not state whether crossing a threshold re-rates all units or only the units above it.',
      }
    }
    case 'escalator_interpretation':
      return {
        typeLabel:          'Price escalation',
        typeIcon:           'ti-trending-up',
        primaryField:       'unit_price',
        primaryLabel:       'Escalation rate (%)',
        primaryPlaceholder: 'e.g. 3',
        whatToCheck:        'Confirm the escalation index, frequency, cap, and calculation method.',
        whyFlagged:         'The contract defines a CPI-linked or otherwise variable escalation mechanism, but the applicable rate cannot be known at signing and requires interpretation.',
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

const ITEM_KIND_TO_RULE_TYPE: Partial<Record<ItemKind, RuleType>> = {
  minimum_commitment: 'minimum_commitment',
  partial_period: 'partial_period',
  escalator_interpretation: 'escalator',
  tier_calculation: 'tier_calculation',
  discount: 'discount',
  service_credit: 'service_credit',
  rule_interaction: 'rule_interaction',
  base_fee_proration: 'base_fee_proration',
  recurring_fee_proration: 'recurring_fee_proration',
}

// base_fee_proration is job-level (one instance per job, unlike every other
// rule type which is addressed by a real id) — a fixed sentinel keeps its
// propose/interpret/confirm cache key and audit addressing stable across
// every render and every re-open of the panel.
const BASE_FEE_PRORATION_SENTINEL = '__base_fee__'

// Reverse-maps a previously approved interpretation back to the structured
// option the reviewer most likely picked — so "Edit interpretation" can
// pre-select it instead of defaulting to nothing. Best-effort only; if the
// approved rule doesn't cleanly match one of the structured choices (e.g.
// it came from free text alone), falls back to 'other' rather than guessing.
// ── Rule interpretation card ────────────────────────────────────────────────
// Human input → AI interpretation → structured rule preview → human approval
// → propagation, entirely in-panel — the reviewer never leaves this card to
// resolve an ambiguous commercial rule (minimum commitment, escalator, or
// partial-period proration all share this one mechanism). No AI-proposed
// interpretation ever reaches contract_terms/contract_meter_mappings without
// the reviewer explicitly clicking "Confirm & apply" below.
// 'proposing'/'proposed' sit BEFORE 'input' in the normal flow — Verdix
// interprets first (propose-rule, no reviewer input yet), the reviewer only
// ever reaches 'input' by clicking "Override" on a proposal, or directly
// when the AI proposal itself is 'decision_required' (nothing to override,
// there was never anything pre-selected).
type RulePhase = 'proposing' | 'proposed' | 'input' | 'loading' | 'missing' | 'proposal' | 'confirming' | 'applied' | 'partial' | 'error'

// Split from a single combined "application_rule still open" check into two
// independent predicates — eligibility (what this credit may reduce) and
// survival (whether it expires/carries forward, and whether it's one-time)
// are genuinely separate questions a contract can resolve independently
// (see lib/rule-interpretation.ts's buildServiceCreditProposalPrompt). A
// credit whose eligibility is explicit but whose survival is unstated must
// show as resolved-on-eligibility, open-on-survival — never a single
// generic "application scope: decision required" that hides which specific
// question is actually still open. Mirrors confirm-rule/route.ts's
// buildCreditApplicationRule requiresConfirmation predicate, split the same way.
function eligibilityStillOpen(appRule: Record<string, unknown> | null | undefined): boolean {
  if (!appRule) return false
  return appRule.eligible_component_keys == null
}
function survivalStillOpen(appRule: Record<string, unknown> | null | undefined): boolean {
  if (!appRule) return false
  return appRule.one_time === 'unclear' || appRule.carry_forward === 'unclear'
}

// Shared presentation for a single independently-graded sub-question on a
// service credit (application scope, survival & expiry) — same three-state
// visual language (green/amber/red) already used for the main trigger/rate/
// cap proposal card above, just parameterized so the two sub-badges don't
// duplicate this styling block twice.
function SubStateBadge({ label, state, decisionRequiredText, resolvedText }: {
  label: string
  state: 'clear_from_source' | 'verdix_recommends' | 'decision_required'
  decisionRequiredText: string
  resolvedText: string
}) {
  return (
    <div className="rounded-xl p-3" style={{
      background: state === 'clear_from_source' ? '#F0FDF4' : state === 'decision_required' ? '#FEF2F2' : '#FFFDF5',
      border: `1px solid ${state === 'clear_from_source' ? 'rgba(11,92,54,0.2)' : state === 'decision_required' ? '#FECACA' : 'rgba(217,167,90,0.35)'}`,
    }}>
      <span
        className="inline-block text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full mb-1.5"
        style={state === 'clear_from_source'
          ? { background: 'rgba(11,92,54,0.12)', color: '#0B5C36' }
          : state === 'decision_required'
            ? { background: 'rgba(153,27,27,0.1)', color: '#991B1B' }
            : { background: 'rgba(180,83,9,0.12)', color: '#92400E' }}
      >
        {label} · {state === 'clear_from_source' ? 'Clear from source' : state === 'decision_required' ? 'Decision required' : 'Verdix recommendation'}
      </span>
      <p className="text-[11px] leading-relaxed" style={{ color: state === 'decision_required' ? '#7F1D1D' : '#4A5D50' }}>
        {state === 'decision_required' ? decisionRequiredText : resolvedText}
      </p>
    </div>
  )
}

function RuleInterpretationCard({
  jobId, kind, contractUnitType, discountId, creditId, interactionKey, cadenceLabel, contractPeriodLabel, sourceClause, currency, meterMappingConfirmed, meterSuggestion, showMeterDependencyNotice, onApplied,
  initialSelectedOption, initialFreeText,
}: {
  jobId: string
  kind: ItemKind
  contractUnitType?: string
  // Which discount this card resolves, when kind maps to ruleType 'discount'
  // — a contract can have several independent discounts, each addressed by
  // its own stable id rather than array position.
  discountId?: string
  // Same addressing pattern as discountId, when kind maps to ruleType 'service_credit'.
  creditId?: string
  // Composite key from lib/rule-interactions.ts, when kind maps to ruleType 'rule_interaction'.
  interactionKey?: string
  // The metric's cadence noun (e.g. "month"/"quarter"/"year") — only
  // meaningful for kind 'partial_period', where it drives "Full <cadence>
  // minimum applies" instead of a hardcoded "quarterly".
  cadenceLabel?: string
  // "17th–16th" — only meaningful for kind 'base_fee_proration'/
  // 'recurring_fee_proration', where it names the contract's own
  // billing-period boundary concretely for the "bill by contract month"
  // option. Null/absent when the contract starts on day 1 (no distinct
  // contract-month framing exists) or for every other kind.
  contractPeriodLabel?: string | null
  sourceClause: string
  currency: string
  meterMappingConfirmed?: boolean
  meterSuggestion?: { meter_key: string; display_name?: string } | null
  // Defaults to true. Callers stacking multiple cards for the same metric
  // (see renderMetricRuleCard) pass false on all but one, since every card
  // would otherwise repeat an identical "this metric's usage source isn't
  // confirmed" notice.
  showMeterDependencyNotice?: boolean
  onApplied: () => void
  // Re-opening an already-confirmed rule ("Edit interpretation") should show
  // what was actually approved last time, not a blank form — the reviewer
  // needs to see their prior choice before deciding whether to change it.
  initialSelectedOption?: string | null
  initialFreeText?: string
}) {
  const ruleType = ITEM_KIND_TO_RULE_TYPE[kind] ?? 'minimum_commitment'
  const options = optionsForRuleType(ruleType, cadenceLabel, contractPeriodLabel)
  // Re-opening an already-confirmed rule ("Edit interpretation") starts from
  // what's already approved, not a fresh AI proposal — only a first-time
  // review runs the propose-first flow.
  const isEditFlow = !!(initialSelectedOption || initialFreeText)
  const [phase, setPhase] = useState<RulePhase>(isEditFlow ? 'input' : 'proposing')
  const [selectedOption, setSelectedOption] = useState<string | null>(initialSelectedOption ?? null)
  const [freeText, setFreeText] = useState(initialFreeText ?? '')
  const [proposal, setProposal] = useState<Record<string, unknown> | null>(null)
  const [whatWillChange, setWhatWillChange] = useState<Array<{ component: string; change: string }>>([])
  const [missingQuestions, setMissingQuestions] = useState<string[]>([])
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [propagation, setPropagation] = useState<Record<string, string> | null>(null)
  const [aiProposal, setAiProposal] = useState<RuleProposal | null>(null)
  const [showFullReasoning, setShowFullReasoning] = useState(false)
  // Set at the moment a confirm succeeds, from the exact interpretation
  // object that was just sent as approvedInterpretation — not recomputed
  // later from aiProposal, which wouldn't reflect what a freeText override
  // via confirmAndApply actually approved. Two independent flags, not one —
  // see eligibilityStillOpen/survivalStillOpen above.
  const [eligibilityOpenAfterConfirm, setEligibilityOpenAfterConfirm] = useState(false)
  const [survivalOpenAfterConfirm, setSurvivalOpenAfterConfirm] = useState(false)

  useEffect(() => {
    if (isEditFlow) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}/propose-rule`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ruleType, contractUnitType, discountId, creditId, interactionKey, sourceClause }),
        })
        const data = await res.json().catch(() => ({ ok: false }))
        if (cancelled) return
        if (!res.ok || !data.ok) { setPhase('input'); return }
        setAiProposal(data.proposal)
        setPhase('proposed')
        // Pre-select the recommended/clear option in the underlying
        // structured-choice list so "Override" (or a decision_required item,
        // which reuses the same form) starts from the right place rather
        // than a blank slate — never pre-selected for decision_required.
        if (data.proposal.state !== 'decision_required' && data.proposal.proposed_interpretation) {
          setSelectedOption(deriveSelectedOption(ruleType, data.proposal.proposed_interpretation))
        }
      } catch {
        if (!cancelled) setPhase('input')
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const confirmProposal = async () => {
    if (!aiProposal?.proposed_interpretation) return
    setPhase('confirming')
    try {
      const res = await fetch(`/api/jobs/${jobId}/confirm-rule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ruleType, contractUnitType, discountId, creditId, interactionKey, sourceClause, reviewerInput: aiProposal.reasoning,
          aiProposedInterpretation: aiProposal.proposed_interpretation, approvedInterpretation: aiProposal.proposed_interpretation,
        }),
      })
      // A non-JSON response (e.g. an unhandled server exception returning
      // Next.js's HTML error page) used to throw here and fall into the
      // catch block below, which only ever showed a generic "try again" —
      // the real cause (a specific server error, or just this HTTP status)
      // is now surfaced instead of swallowed.
      const data = await res.json().catch(() => ({ error: `Unexpected response from server (${res.status})` }))
      if (!res.ok && !data.propagation) { setErrorMsg(data.error ?? 'Approval failed.'); setPhase('proposed'); return }
      setPropagation(data.propagation ?? {})
      const anyFailed = Object.values(data.propagation ?? {}).includes('failed')
      if (anyFailed) {
        setPhase('partial')
      } else {
        const confirmedAppRule = (aiProposal.proposed_interpretation as Record<string, unknown>)?.application_rule as Record<string, unknown> | undefined
        setEligibilityOpenAfterConfirm(ruleType === 'service_credit' && eligibilityStillOpen(confirmedAppRule))
        setSurvivalOpenAfterConfirm(ruleType === 'service_credit' && survivalStillOpen(confirmedAppRule))
        setPhase('applied')
        onApplied()
      }
    } catch (err) {
      setErrorMsg(err instanceof Error && err.message ? `Verdix could not save this approval: ${err.message}` : 'Verdix could not save this approval. Try again.')
      setPhase('proposed')
    }
  }

  const generate = async () => {
    setPhase('loading')
    setErrorMsg(null)
    try {
      const res = await fetch(`/api/jobs/${jobId}/interpret-rule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ruleType, contractUnitType, discountId, creditId, interactionKey, selectedOption: selectedOption ?? undefined, freeText, sourceClause }),
      })
      const data = await res.json().catch(() => ({ error: `Unexpected response from server (${res.status})` }))
      if (!res.ok) { setErrorMsg(data.error ?? 'Verdix could not interpret this rule.'); setPhase('input'); return }
      if (!data.ok) {
        setMissingQuestions(data.questions ?? ['Verdix needs more detail to operationalize this instruction.'])
        setPhase('missing')
        return
      }
      setProposal(data.proposal)
      setWhatWillChange(data.whatWillChange ?? [])
      setPhase('proposal')
    } catch (err) {
      setErrorMsg(err instanceof Error && err.message ? `Verdix could not reach the AI interpretation service: ${err.message}` : 'Verdix could not reach the AI interpretation service. Try again.')
      setPhase('input')
    }
  }

  const confirmAndApply = async () => {
    if (!proposal) return
    setPhase('confirming')
    try {
      const res = await fetch(`/api/jobs/${jobId}/confirm-rule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ruleType, contractUnitType, discountId, creditId, interactionKey, sourceClause, reviewerInput: freeText,
          aiProposedInterpretation: proposal, approvedInterpretation: proposal,
        }),
      })
      const data = await res.json().catch(() => ({ error: `Unexpected response from server (${res.status})` }))
      if (!res.ok && !data.propagation) { setErrorMsg(data.error ?? 'Approval failed.'); setPhase('proposal'); return }
      setPropagation(data.propagation ?? {})
      const anyFailed = Object.values(data.propagation ?? {}).includes('failed')
      if (anyFailed) {
        setPhase('partial')
      } else {
        const confirmedAppRule = (proposal as Record<string, unknown>)?.application_rule as Record<string, unknown> | undefined
        setEligibilityOpenAfterConfirm(ruleType === 'service_credit' && eligibilityStillOpen(confirmedAppRule))
        setSurvivalOpenAfterConfirm(ruleType === 'service_credit' && survivalStillOpen(confirmedAppRule))
        setPhase('applied')
        onApplied()
      }
    } catch (err) {
      setErrorMsg(err instanceof Error && err.message ? `Verdix could not save this approval: ${err.message}` : 'Verdix could not save this approval. Try again.')
      setPhase('proposal')
    }
  }

  // Stable regardless of what the reviewer currently has selected in the
  // override form — always reflects what Verdix itself originally proposed,
  // so switching options to explore alternatives doesn't lose track of it.
  const aiRecommendedOptionId = aiProposal?.proposed_interpretation
    ? deriveSelectedOption(ruleType, aiProposal.proposed_interpretation)
    : null

  if (phase === 'applied' && (eligibilityOpenAfterConfirm || survivalOpenAfterConfirm)) {
    const openParts = [
      eligibilityOpenAfterConfirm ? 'application scope' : null,
      survivalOpenAfterConfirm ? 'survival & expiry' : null,
    ].filter(Boolean).join(' and ')
    return (
      <div className="rounded-xl p-3" style={{ background: '#FEF2F2', border: '1px solid #FECACA' }}>
        <p className="text-sm font-medium flex items-center gap-1.5" style={{ color: '#7F1D1D' }}>
          <i className="ti ti-alert-triangle" style={{ fontSize: 15 }} /> Trigger, rate & cap confirmed — {openParts} still open
        </p>
        <p className="text-[11px] mt-1" style={{ color: '#7F1D1D' }}>
          {eligibilityOpenAfterConfirm && !survivalOpenAfterConfirm && "The contract states this credit's size but not what future charges it may reduce."}
          {survivalOpenAfterConfirm && !eligibilityOpenAfterConfirm && "The contract doesn't state how long an earned-but-unused credit remains available, or whether it can be earned more than once."}
          {eligibilityOpenAfterConfirm && survivalOpenAfterConfirm && "The contract doesn't state what future charges this credit may reduce, nor how long an earned-but-unused credit remains available."}
          {' '}It will keep counting as a decision outstanding, and won&rsquo;t be applied against billing, until this is resolved.
        </p>
        <button
          onClick={() => setPhase('input')}
          className="mt-2 text-xs font-semibold px-3 py-1.5 rounded-lg"
          style={{ background: '#1A3D2B', color: 'white' }}
        >
          Resolve {openParts}
        </button>
      </div>
    )
  }

  if (phase === 'applied') {
    return (
      <div className="rounded-xl p-3" style={{ background: '#F0FDF4', border: '1px solid rgba(11,92,54,0.2)' }}>
        <p className="text-sm font-medium flex items-center gap-1.5" style={{ color: '#0B5C36' }}>
          <i className="ti ti-circle-check-filled" style={{ fontSize: 15 }} /> Rule confirmed and applied
        </p>
        <p className="text-[11px] text-stone mt-1">Updated: Commercial Terms · Billing Configuration · Billing Schedule</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {phase === 'partial' && (
        <div className="rounded-xl p-3" style={{ background: '#FFFBEB', border: '1px solid #FDE68A' }}>
          <p className="text-sm font-medium" style={{ color: '#92400E' }}>Confirmed — propagation incomplete</p>
          <ul className="text-[11px] mt-1 space-y-0.5" style={{ color: '#78350F' }}>
            {Object.entries(propagation ?? {}).map(([component, status]) => (
              <li key={component}>{component.replace(/_/g, ' ')}: {status}</li>
            ))}
          </ul>
          <button
            onClick={confirmAndApply}
            className="mt-2 text-xs font-semibold px-3 py-1.5 rounded-lg"
            style={{ background: '#1A3D2B', color: 'white' }}
          >
            Retry propagation
          </button>
        </div>
      )}

      {phase === 'proposing' && (
        <div className="rounded-xl p-3 flex items-center gap-2" style={{ background: '#FAFAF9', border: '1px solid rgba(26,61,43,0.1)' }}>
          <i className="ti ti-loader-2 animate-spin text-stone" style={{ fontSize: 14 }} />
          <p className="text-xs text-stone">Verdix is reading the source clause and preparing an interpretation…</p>
        </div>
      )}

      {(phase === 'proposed' || (phase === 'confirming' && !proposal)) && aiProposal && aiProposal.state !== 'decision_required' && aiProposal.proposed_interpretation && (
        <>
          <div className="rounded-xl p-3" style={{ background: aiProposal.state === 'clear_from_source' ? '#F0FDF4' : '#FFFDF5', border: `1px solid ${aiProposal.state === 'clear_from_source' ? 'rgba(11,92,54,0.2)' : 'rgba(217,167,90,0.35)'}` }}>
            <span
              className="inline-block text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full mb-2"
              style={aiProposal.state === 'clear_from_source'
                ? { background: 'rgba(11,92,54,0.12)', color: '#0B5C36' }
                : { background: 'rgba(180,83,9,0.12)', color: '#92400E' }}
            >
              {aiProposal.state === 'clear_from_source' ? 'Clear from source' : 'Verdix recommendation'}
            </span>
            {/* SOURCE — the immutable clause itself, kept visually distinct
                from Verdix's own interpretation of it below, so a reviewer
                can check the two against each other at a glance. */}
            {!!sourceClause && (
              <p className="text-[11px] text-stone italic leading-relaxed mb-1.5 pl-2" style={{ borderLeft: '2px solid rgba(26,61,43,0.15)' }}>
                &ldquo;{sourceClause}&rdquo;
              </p>
            )}
            {(() => {
              const { short, truncated } = truncateSentences(aiProposal.reasoning)
              return (
                <>
                  <p className="text-xs text-ink leading-relaxed">{showFullReasoning ? aiProposal.reasoning : short}</p>
                  {truncated && (
                    <button
                      onClick={() => setShowFullReasoning(v => !v)}
                      className="text-[11px] font-medium text-forest hover:underline mt-1"
                    >
                      {showFullReasoning ? 'Show less' : 'More details'}
                    </button>
                  )}
                </>
              )
            })()}
            {!!aiProposal.calculation_preview?.length && (
              <dl className="mt-2 space-y-1 pt-2" style={{ borderTop: '1px solid rgba(26,61,43,0.08)' }}>
                {aiProposal.calculation_preview.map((row, i) => (
                  <div key={i} className="flex justify-between gap-3 text-xs">
                    <dt className="text-stone">{row.label}</dt>
                    <dd className="font-medium text-ink text-right">{row.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
          {/* Application scope — service_credit only. Graded and shown
              separately from the trigger/rate/cap badge above: a credit can
              be Clear from source on what it's worth while genuinely
              Decision required on what it may reduce (or vice versa), and
              folding both into one badge previously meant the whole card
              read as "Verdix recommendation" the moment EITHER question was
              less than fully explicit — even for a credit like Growth
              Credit, whose application scope is itself stated verbatim. */}
          {aiProposal.application_state && (
            <SubStateBadge
              label="Application scope"
              state={aiProposal.application_state}
              decisionRequiredText="The contract states this credit's size but not what future charges it may reduce — resolve this before it can be applied against an invoice."
              resolvedText="What this credit may reduce is covered in the reasoning above."
            />
          )}
          {/* Survival & expiry — deliberately a SEPARATE badge from
              Application scope above, not a second line inside it. A clause
              can state exactly what a credit may offset (Growth Credit:
              "applicable only against future transaction-processing fees")
              while saying nothing about how long an earned-but-unused
              credit survives — those are different questions, and folding
              survival's silence into the eligibility badge would incorrectly
              mark an otherwise-explicit eligibility answer as unresolved. */}
          {aiProposal.survival_state && (
            <SubStateBadge
              label="Survival & expiry"
              state={aiProposal.survival_state}
              decisionRequiredText="The contract doesn't state how long an earned-but-unused credit remains available, or whether it can be earned more than once — resolve this before it can be applied against an invoice."
              resolvedText="Whether this credit carries forward and whether it can be earned more than once is covered in the reasoning above."
            />
          )}
          {errorMsg && <p className="text-xs" style={{ color: '#DC2626' }}>{errorMsg}</p>}
          <div className="flex gap-2">
            <button
              onClick={confirmProposal}
              disabled={phase === 'confirming'}
              className="flex-1 py-2 rounded-xl text-sm font-semibold transition-colors disabled:opacity-40"
              style={{ background: '#1A3D2B', color: 'white' }}
            >
              {phase === 'confirming' ? <i className="ti ti-loader-2 animate-spin" style={{ fontSize: 13 }} /> : 'Confirm & apply'}
            </button>
            <button
              onClick={() => setPhase('input')}
              disabled={phase === 'confirming'}
              className="px-4 py-2 rounded-xl text-sm text-stone hover:text-ink border transition-colors disabled:opacity-40"
              style={{ borderColor: 'rgba(26,61,43,0.15)' }}
            >
              Override
            </button>
          </div>
        </>
      )}

      {(phase === 'input' || phase === 'loading' || phase === 'missing'
        || (phase === 'proposed' && aiProposal?.state === 'decision_required')) && (
        <>
          {phase === 'missing' && (
            <div className="rounded-xl p-3 mb-1" style={{ background: '#FEF2F2', border: '1px solid #FECACA' }}>
              <p className="text-xs font-semibold mb-1" style={{ color: '#991B1B' }}>Verdix needs more detail to operationalize this instruction.</p>
              <ul className="text-[11px] space-y-0.5" style={{ color: '#7F1D1D' }}>
                {missingQuestions.map((q, i) => <li key={i}>• {q}</li>)}
              </ul>
            </div>
          )}
          {aiProposal?.state === 'decision_required' && (
            <div className="rounded-xl p-3 mb-1" style={{ background: '#FEF2F2', border: '1px solid #FECACA' }}>
              <p className="text-[9px] font-bold uppercase tracking-widest mb-1" style={{ color: '#991B1B' }}>Decision required</p>
              {(() => {
                const text = aiProposal.reasoning || 'The agreement does not specify how this should be handled — nothing is preselected.'
                const { short, truncated } = truncateSentences(text)
                return (
                  <>
                    <p className="text-xs" style={{ color: '#7F1D1D' }}>{showFullReasoning ? text : short}</p>
                    {truncated && (
                      <button onClick={() => setShowFullReasoning(v => !v)} className="text-[11px] font-medium mt-1 hover:underline" style={{ color: '#991B1B' }}>
                        {showFullReasoning ? 'Show less' : 'More details'}
                      </button>
                    )}
                  </>
                )
              })()}
            </div>
          )}
          {(initialSelectedOption || initialFreeText) && phase === 'input' && (
            <p className="text-[11px] text-stone -mt-1">Showing the previously confirmed choice and comment — change either, or just re-generate to confirm it again.</p>
          )}
          {/* Only shown after clicking "Override" on a real proposal — a
              genuine decision_required item has no earlier AI-recommended
              screen to return to, since this input form IS that screen. */}
          {phase === 'input' && aiProposal && aiProposal.state !== 'decision_required' && aiProposal.proposed_interpretation && (
            <button
              onClick={() => setPhase('proposed')}
              className="text-[11px] font-medium text-forest hover:underline flex items-center gap-1 -mt-1"
            >
              <i className="ti ti-arrow-left" style={{ fontSize: 11 }} /> Back to Verdix&apos;s recommendation
            </button>
          )}
          <p className="text-[10px] font-bold uppercase tracking-widest text-stone">How should this rule be applied?</p>
          <div className="space-y-1.5">
            {options.map(opt => {
              // Lets the reviewer see what Verdix itself proposed even while
              // overriding it — the option list previously gave no way to
              // tell which choice (if any) the AI had actually recommended
              // once you left the proposal screen.
              const isAiRecommended = aiRecommendedOptionId != null && opt.id === aiRecommendedOptionId
              return (
                <label key={opt.id} className="flex items-start gap-2 p-2 rounded-lg cursor-pointer transition-colors"
                  style={{ background: selectedOption === opt.id ? '#F0FDF4' : 'transparent', border: `1px solid ${selectedOption === opt.id ? 'rgba(11,92,54,0.3)' : 'rgba(26,61,43,0.1)'}` }}>
                  <input type="radio" name={`rule-option-${contractUnitType ?? 'escalator'}`} className="mt-0.5" checked={selectedOption === opt.id} onChange={() => setSelectedOption(opt.id)} />
                  <span>
                    <span className="flex items-center gap-1.5">
                      <span className="block text-xs font-semibold text-ink">{opt.label}</span>
                      {isAiRecommended && (
                        <span className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full" style={{ background: 'rgba(11,92,54,0.12)', color: '#0B5C36' }}>
                          Verdix recommended
                        </span>
                      )}
                    </span>
                    <span className="block text-[11px] text-stone">{opt.description}</span>
                  </span>
                </label>
              )
            })}
          </div>
          <div>
            <label className="text-[10px] font-bold uppercase tracking-widest text-stone block mb-1">Tell Verdix how this should work</label>
            <textarea
              value={freeText}
              onChange={e => setFreeText(e.target.value)}
              placeholder="Example: Apply the stated minimum as the quarterly floor after the included allowance. Do not add it on top of calculated usage."
              rows={3}
              className="w-full text-xs border rounded-xl px-3 py-2 outline-none"
              style={{ borderColor: 'rgba(26,61,43,0.15)', background: '#FAFAF9' }}
            />
          </div>
          {errorMsg && <p className="text-xs" style={{ color: '#DC2626' }}>{errorMsg}</p>}
          <button
            onClick={generate}
            disabled={phase === 'loading' || (!selectedOption && !freeText.trim())}
            className="w-full py-2 rounded-xl text-sm font-semibold transition-colors disabled:opacity-40"
            style={{ background: '#1A3D2B', color: 'white' }}
          >
            {phase === 'loading' ? <i className="ti ti-loader-2 animate-spin" style={{ fontSize: 13 }} /> : 'Generate billing rule'}
          </button>
        </>
      )}

      {(phase === 'proposal' || phase === 'confirming') && proposal && (
        <>
          <div className="rounded-xl p-3" style={{ background: '#F0FDF4', border: '1px solid rgba(11,92,54,0.2)' }}>
            <p className="text-[10px] font-bold uppercase tracking-widest mb-2" style={{ color: '#0B5C36' }}>Proposed interpretation</p>
            <dl className="space-y-1.5">
              {Object.entries(proposal).map(([field, value]) => (
                <div key={field} className="flex justify-between gap-3 text-xs">
                  <dt className="text-stone capitalize flex-shrink-0">{field.replace(/_/g, ' ')}</dt>
                  <dd className="font-medium text-ink text-right">
                    {field === 'amount' && typeof value === 'number' ? fmt(value, currency) : String(value)}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="rounded-xl p-3" style={{ background: '#FFFDF5', border: '1px solid rgba(217,167,90,0.35)' }}>
            <p className="text-[10px] font-bold uppercase tracking-widest mb-2" style={{ color: '#92400E' }}>What will change</p>
            <ul className="space-y-1">
              {whatWillChange.map((c, i) => (
                <li key={i} className="text-[11px]" style={{ color: c.component === 'Usage Source' ? '#B45309' : '#78350F' }}>
                  <span className="font-semibold">{c.component}</span> — {c.change}
                </li>
              ))}
            </ul>
          </div>

          {errorMsg && <p className="text-xs" style={{ color: '#DC2626' }}>{errorMsg}</p>}
          <div className="flex gap-2">
            <button
              onClick={confirmAndApply}
              disabled={phase === 'confirming'}
              className="flex-1 py-2 rounded-xl text-sm font-semibold transition-colors disabled:opacity-40"
              style={{ background: '#1A3D2B', color: 'white' }}
            >
              {phase === 'confirming' ? <i className="ti ti-loader-2 animate-spin" style={{ fontSize: 13 }} /> : 'Confirm & apply'}
            </button>
            <button
              onClick={() => setPhase('input')}
              className="px-4 py-2 rounded-xl text-sm text-stone hover:text-ink border transition-colors"
              style={{ borderColor: 'rgba(26,61,43,0.15)' }}
            >
              Edit interpretation
            </button>
          </div>
        </>
      )}

      {/* Meter-mapping dependency — read-only notice, not a second editing
          surface. Confirming/changing a mapping happens in exactly one
          place, the Meter mapping section above (id="meter-mapping-panel");
          this card only says why it's blocked and jumps there.
          showMeterDependencyNotice defaults to true but is suppressed by
          callers stacking multiple cards for the SAME metric (minimum
          commitment + partial period + tier calculation can all depend on
          the same unconfirmed meter) — shown once at the metric-group
          level instead of once per stacked card. */}
      {showMeterDependencyNotice !== false && contractUnitType && meterMappingConfirmed === false && (
        <div className="rounded-xl p-3" style={{ background: '#F5F5F4', border: '1px solid rgba(26,61,43,0.1)' }}>
          <p className="text-[10px] font-bold uppercase tracking-widest text-stone mb-1.5">Usage source</p>
          <p className="text-[11px] text-stone mb-2">
            Contract metric <span className="font-medium text-ink">&quot;{contractUnitType}&quot;</span>{' '}
            {/* Only a truthy check (not just non-null) catches an empty-string
                meter_key/display_name — meterSuggestion can exist as an
                object while both its string fields are '', which `??`
                alone doesn't fall through on. */}
            {(meterSuggestion?.display_name || meterSuggestion?.meter_key)
              ? <>maps to <span className="font-medium text-ink">{meterSuggestion.display_name || meterSuggestion.meter_key}</span>, not yet confirmed.</>
              : <span className="font-medium text-ink">No meter selected.</span>}
          </p>
          <button
            onClick={() => document.getElementById('meter-mapping-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
            className="text-xs font-semibold py-1.5 px-3 rounded-lg border transition-colors"
            style={{ borderColor: 'rgba(26,61,43,0.25)', color: '#1A3D2B', background: '#F0FDF4' }}
          >
            Resolve in Meter mapping ↑
          </button>
        </div>
      )}
    </div>
  )
}

// ── Edit commercial rule drawer ─────────────────────────────────────────────
// Revising an already-approved commercial rule is a distinct experience from
// first-time review: it starts from what Verdix is executing today, offers
// changes framed relative to that ("Keep as X" / "Change to Y"), shows the
// proposed change as a diff with a plain-English summary, and — critically —
// flags when the change would touch a period that's already been invoiced,
// before the reviewer can approve it. Never routes back through the initial
// Review panel (that review is done); this is its own right-side drawer.
type RuleInterpretationRecord = {
  rule_type: string; contract_unit_type: string | null; source_clause: string | null; reviewer_input: string | null
  approved_interpretation: Record<string, unknown>; reviewer_email: string; reviewer_name: string | null; created_at: string
  revision_number: number; is_current: boolean
}

const FIELD_LABELS: Record<string, string> = {
  mode: 'Rule type', amount: 'Amount', period: 'Period', included_allowance_interaction: 'Allowance treatment',
  prorate_partial_periods: 'Partial-period proration', treatment: 'Treatment', index: 'Index', frequency: 'Frequency',
  cap_pct: 'Cap', effective_date: 'Effective date', calculation_method: 'Calculation', calculation_summary: 'Calculation',
  discount_type: 'Rule type', discount_basis: 'Discount basis', tier_method: 'Tier method', tiers: 'Tier schedule',
  applies_to: 'Applies to', application_order: 'Application order', reset_period: 'Reset',
  method: 'Calculation method', worked_example: 'Worked example',
}

const RULE_MODE_DISPLAY: Record<string, string> = {
  floor: 'Minimum charge floor', additive: 'Additive charge', minimum_spend: 'Spend commitment',
  prepaid_commitment: 'Prepaid commitment', minimum_quantity: 'Minimum quantity',
  flat_percentage: 'Flat percentage discount', flat_amount: 'Flat amount discount', tiered_discount: 'Tiered discount',
  volume_discount: 'Volume discount', component_specific: 'Component-specific discount', time_ramp: 'Time/ramp discount',
}

const TIER_METHOD_DISPLAY: Record<string, string> = {
  graduated: 'Graduated / staircase', volume: 'Volume / all-units', block: 'Block-based', custom: 'Custom',
}

// A rebate, a conditional/milestone credit, and a flat availability credit
// are genuinely different rule types with different timing/basis mechanics
// — labeling all of them "Service credit basis" hid that distinction from
// reviewers. Keyed by ServiceCredit['credit_type'].
const CREDIT_BASIS_LABEL: Record<string, string> = {
  rebate: 'Rebate basis',
  conditional_credit: 'Credit basis',
  service_credit: 'Service credit basis',
  promotional: 'Promotional credit basis',
  earned: 'Earned credit basis',
  usage: 'Usage credit basis',
  waiver: 'Waiver basis',
  other: 'Credit basis',
}

function formatFieldValue(field: string, value: unknown, currency: string): string {
  if (value == null) return '—'
  if (field === 'amount' && typeof value === 'number') return fmt(value, currency)
  if ((field === 'mode' || field === 'discount_type') && typeof value === 'string') return RULE_MODE_DISPLAY[value] ?? value
  if (field === 'included_allowance_interaction' && typeof value === 'string') return value.replace(/_/g, ' ')
  if (field === 'tier_method' && typeof value === 'string') return TIER_METHOD_DISPLAY[value] ?? value
  if (field === 'effective_date' && typeof value === 'string') return fmtDate(value)
  if (field === 'tiers' && Array.isArray(value)) {
    return (value as Array<{ from_unit: number | null; to_unit: number | null; value: number }>)
      .map(t => `${t.from_unit ?? 1}–${t.to_unit ?? '∞'}: ${t.value}`).join(' · ')
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return String(value)
}

function EditCommercialRuleDrawer({
  jobId, ruleType, contractUnitType, discountId, creditId, cadenceLabel, ruleTitle, currency, currentRecord, historyRecords, onClose, onApplied,
}: {
  jobId: string
  ruleType: RuleType
  contractUnitType?: string
  // Which discount this drawer edits, when ruleType is 'discount' — required
  // so a contract with several discounts only ever touches the one being edited.
  discountId?: string
  // Same addressing pattern as discountId, when ruleType is 'service_credit'.
  creditId?: string
  // Only meaningful for ruleType 'partial_period' — see RuleInterpretationCard.
  cadenceLabel?: string
  ruleTitle: string
  currency: string
  currentRecord: RuleInterpretationRecord | null
  historyRecords: RuleInterpretationRecord[]
  onClose: () => void
  onApplied: () => void
}) {
  // "Change to X" only makes sense once something is already confirmed —
  // a rule with no currentRecord yet (e.g. a discount's first interpretation,
  // which has no separate first-time Review-panel trigger) gets the plain,
  // unbiased option labels instead of a "change" framing.
  const options = currentRecord ? optionsForEdit(ruleType, currentRecord.approved_interpretation, cadenceLabel) : optionsForRuleType(ruleType, cadenceLabel)
  const [phase, setPhase] = useState<RulePhase>('input')
  const [selectedOption, setSelectedOption] = useState<string | null>(null)
  const [freeText, setFreeText] = useState('')
  const [proposal, setProposal] = useState<Record<string, unknown> | null>(null)
  const [whatWillChange, setWhatWillChange] = useState<Array<{ component: string; change: string }>>([])
  const [historicalImpact, setHistoricalImpact] = useState<{ affectedCount: number; periods: string[] } | null>(null)
  const [missingQuestions, setMissingQuestions] = useState<string[]>([])
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [propagation, setPropagation] = useState<Record<string, string> | null>(null)
  const [showHistory, setShowHistory] = useState(false)

  const generate = async () => {
    setPhase('loading')
    setErrorMsg(null)
    try {
      const res = await fetch(`/api/jobs/${jobId}/interpret-rule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ruleType, contractUnitType, discountId, creditId, selectedOption: selectedOption ?? undefined, freeText, sourceClause: currentRecord?.source_clause ?? ruleTitle }),
      })
      const data = await res.json().catch(() => ({ error: `Unexpected response from server (${res.status})` }))
      if (!res.ok) { setErrorMsg(data.error ?? 'Verdix could not interpret this change.'); setPhase('input'); return }
      if (!data.ok) {
        setMissingQuestions(data.questions ?? ['Verdix needs more detail to operationalize this change.'])
        setPhase('missing')
        return
      }
      setProposal(data.proposal)
      setWhatWillChange(data.whatWillChange ?? [])
      setHistoricalImpact(data.historicalImpact ?? null)
      setPhase('proposal')
    } catch (err) {
      setErrorMsg(err instanceof Error && err.message ? `Verdix could not reach the AI interpretation service: ${err.message}` : 'Verdix could not reach the AI interpretation service. Try again.')
      setPhase('input')
    }
  }

  const confirmAndApply = async () => {
    if (!proposal) return
    setPhase('confirming')
    try {
      const res = await fetch(`/api/jobs/${jobId}/confirm-rule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ruleType, contractUnitType, discountId, creditId, sourceClause: currentRecord?.source_clause ?? ruleTitle, reviewerInput: freeText,
          aiProposedInterpretation: proposal, approvedInterpretation: proposal,
        }),
      })
      const data = await res.json().catch(() => ({ error: `Unexpected response from server (${res.status})` }))
      if (!res.ok && !data.propagation) { setErrorMsg(data.error ?? 'Approval failed.'); setPhase('proposal'); return }
      setPropagation(data.propagation ?? {})
      const anyFailed = Object.values(data.propagation ?? {}).includes('failed')
      if (anyFailed) { setPhase('partial') } else { setPhase('applied'); onApplied() }
    } catch (err) {
      setErrorMsg(err instanceof Error && err.message ? `Verdix could not save this approval: ${err.message}` : 'Verdix could not save this approval. Try again.')
      setPhase('proposal')
    }
  }

  // Fields the proposal actually changes vs. the current interpretation —
  // shown as a diff rather than a flat list, per field. calculation_summary
  // and worked_example are narrative fields shown in their own blocks below,
  // not as a row in the field-by-field diff.
  const NARRATIVE_FIELDS = ['calculation_summary', 'worked_example']
  const changedFields = proposal
    ? Object.keys(proposal).filter(f => !NARRATIVE_FIELDS.includes(f) && JSON.stringify(proposal[f]) !== JSON.stringify(currentRecord?.approved_interpretation?.[f]))
    : []
  const meaningSentence = (proposal?.calculation_summary as string | undefined) ?? (proposal?.calculation_method as string | undefined) ?? null
  // A concrete numeric walkthrough — the thing that lets a Finance reviewer
  // validate "graduated vs volume" without decoding internal field names,
  // per the explicit product ask for this. Distinct from meaningSentence:
  // one states the rule, the other demonstrates it with real numbers.
  const workedExample = (proposal?.worked_example as string | undefined) ?? null

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative h-full bg-white shadow-2xl flex flex-col" style={{ width: 480 }}>
        <div className="flex-shrink-0 px-6 py-4 border-b border-forest/10 flex items-center justify-between">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-stone">Edit commercial rule</p>
            <p className="text-sm font-semibold text-ink mt-0.5">{ruleTitle}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-cream text-stone hover:text-ink transition-colors">
            <i className="ti ti-x" style={{ fontSize: 14 }} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          {/* State 1: current approved interpretation, always visible */}
          {currentRecord && (
            <div className="rounded-xl p-4" style={{ background: '#F6FAF4', border: '1px solid rgba(74,124,89,0.2)' }}>
              <div className="flex items-center justify-between mb-2">
                <p className="text-[10px] font-bold uppercase tracking-widest text-stone/60">Current interpretation</p>
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full" style={{ background: '#D4EAD9', color: '#1A3D2B' }}>Confirmed</span>
              </div>
              <dl className="space-y-1">
                {Object.entries(currentRecord.approved_interpretation)
                  .filter(([f]) => !NARRATIVE_FIELDS.includes(f) && f !== 'requires_confirmation' && f !== 'confirmation_reason')
                  .map(([field, value]) => (
                    <div key={field} className="flex justify-between gap-3 text-xs">
                      <dt className="text-stone flex-shrink-0">{FIELD_LABELS[field] ?? field.replace(/_/g, ' ')}</dt>
                      <dd className="font-medium text-ink text-right">{formatFieldValue(field, value, currency)}</dd>
                    </div>
                  ))}
              </dl>
              <p className="text-[10px] text-stone/60 mt-2">
                Confirmed by {currentRecord.reviewer_name ?? currentRecord.reviewer_email} · {fmtDate(currentRecord.created_at)}
                {currentRecord.revision_number > 1 && <> · Version {currentRecord.revision_number}</>}
              </p>
              {historyRecords.length > 0 && (
                <button onClick={() => setShowHistory(h => !h)} className="text-[11px] font-medium text-forest hover:underline mt-1">
                  {showHistory ? 'Hide' : 'View'} previous version{historyRecords.length > 1 ? 's' : ''} ({historyRecords.length})
                </button>
              )}
              {showHistory && (
                <div className="mt-2 space-y-2 border-t pt-2" style={{ borderColor: 'rgba(74,124,89,0.15)' }}>
                  {historyRecords.map(h => (
                    <div key={h.revision_number} className="text-[11px] text-stone">
                      <span className="font-medium text-ink">Version {h.revision_number}</span> — {formatFieldValue('mode', h.approved_interpretation.mode ?? h.approved_interpretation.treatment, currency)}
                      {' · '}{h.reviewer_name ?? h.reviewer_email} · {fmtDate(h.created_at)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {phase === 'partial' && (
            <div className="rounded-xl p-3" style={{ background: '#FFFBEB', border: '1px solid #FDE68A' }}>
              <p className="text-sm font-medium" style={{ color: '#92400E' }}>Confirmed — propagation incomplete</p>
              <ul className="text-[11px] mt-1 space-y-0.5" style={{ color: '#78350F' }}>
                {Object.entries(propagation ?? {}).map(([component, status]) => <li key={component}>{component.replace(/_/g, ' ')}: {status}</li>)}
              </ul>
              <button onClick={confirmAndApply} className="mt-2 text-xs font-semibold px-3 py-1.5 rounded-lg" style={{ background: '#1A3D2B', color: 'white' }}>
                Retry propagation
              </button>
            </div>
          )}

          {phase === 'applied' && (
            <div className="rounded-xl p-3" style={{ background: '#F0FDF4', border: '1px solid rgba(11,92,54,0.2)' }}>
              <p className="text-sm font-medium flex items-center gap-1.5" style={{ color: '#0B5C36' }}>
                <i className="ti ti-circle-check-filled" style={{ fontSize: 15 }} /> Change confirmed and applied
              </p>
              <p className="text-[11px] text-stone mt-1">Updated: Commercial Terms · Billing Configuration · Billing Schedule</p>
            </div>
          )}

          {/* State 2: how should this rule change */}
          {(phase === 'input' || phase === 'loading' || phase === 'missing') && (
            <>
              {phase === 'missing' && (
                <div className="rounded-xl p-3" style={{ background: '#FEF2F2', border: '1px solid #FECACA' }}>
                  <p className="text-xs font-semibold mb-1" style={{ color: '#991B1B' }}>Verdix needs more detail to operationalize this change.</p>
                  <ul className="text-[11px] space-y-0.5" style={{ color: '#7F1D1D' }}>
                    {missingQuestions.map((q, i) => <li key={i}>• {q}</li>)}
                  </ul>
                </div>
              )}
              <p className="text-[10px] font-bold uppercase tracking-widest text-stone">{currentRecord ? 'How should this rule change?' : 'How should this rule be applied?'}</p>
              <div className="space-y-1.5">
                {options.map((opt: StructuredOption) => (
                  <label key={opt.id} className="flex items-start gap-2 p-2 rounded-lg cursor-pointer transition-colors"
                    style={{ background: selectedOption === opt.id ? '#F0FDF4' : 'transparent', border: `1px solid ${selectedOption === opt.id ? 'rgba(11,92,54,0.3)' : 'rgba(26,61,43,0.1)'}` }}>
                    <input type="radio" name={`edit-rule-option-${contractUnitType ?? 'escalator'}`} className="mt-0.5" checked={selectedOption === opt.id} onChange={() => setSelectedOption(opt.id)} />
                    <span>
                      <span className="block text-xs font-semibold text-ink">{opt.label}</span>
                      <span className="block text-[11px] text-stone">{opt.description}</span>
                    </span>
                  </label>
                ))}
              </div>
              <div>
                <label className="text-[10px] font-bold uppercase tracking-widest text-stone block mb-1">Or describe the change in your own words</label>
                <textarea
                  value={freeText}
                  onChange={e => setFreeText(e.target.value)}
                  placeholder="e.g. Treat the amount as an additional quarterly fee rather than a minimum floor. Apply the full amount even for partial quarters."
                  rows={3}
                  className="w-full text-xs border rounded-xl px-3 py-2 outline-none"
                  style={{ borderColor: 'rgba(26,61,43,0.15)', background: '#FAFAF9' }}
                />
              </div>
              {errorMsg && <p className="text-xs" style={{ color: '#DC2626' }}>{errorMsg}</p>}
              <button
                onClick={generate}
                disabled={phase === 'loading' || (!selectedOption && !freeText.trim())}
                className="w-full py-2 rounded-xl text-sm font-semibold transition-colors disabled:opacity-40"
                style={{ background: '#1A3D2B', color: 'white' }}
              >
                {phase === 'loading' ? <i className="ti ti-loader-2 animate-spin" style={{ fontSize: 13 }} /> : 'Generate proposed change'}
              </button>
            </>
          )}

          {/* State 3 + 4: proposed change diff, what this means, impact, approval */}
          {(phase === 'proposal' || phase === 'confirming') && proposal && (
            <>
              <div className="rounded-xl p-3" style={{ background: '#F0FDF4', border: '1px solid rgba(11,92,54,0.2)' }}>
                <p className="text-[10px] font-bold uppercase tracking-widest mb-2" style={{ color: '#0B5C36' }}>Proposed interpretation</p>
                <dl className="space-y-1.5">
                  {Object.entries(proposal).filter(([f]) => !NARRATIVE_FIELDS.includes(f)).map(([field, value]) => {
                    const oldValue = currentRecord?.approved_interpretation?.[field]
                    const changed = changedFields.includes(field)
                    return (
                      <div key={field} className="flex justify-between gap-3 text-xs">
                        <dt className="text-stone flex-shrink-0">{FIELD_LABELS[field] ?? field.replace(/_/g, ' ')}</dt>
                        <dd className="font-medium text-ink text-right">
                          {changed && currentRecord ? (
                            <span className="text-stone/50">{formatFieldValue(field, oldValue, currency)} → </span>
                          ) : null}
                          <span className={changed ? 'text-ink' : ''}>{formatFieldValue(field, value, currency)}</span>
                        </dd>
                      </div>
                    )
                  })}
                </dl>
                {meaningSentence && (
                  <p className="text-xs text-stone leading-relaxed mt-3 pt-3" style={{ borderTop: '1px solid rgba(74,124,89,0.15)' }}>
                    <span className="font-semibold text-ink">What this means: </span>{meaningSentence}
                  </p>
                )}
              </div>

              {/* Worked example — a concrete numeric walkthrough, distinct from
                  the plain-English rule statement above. This is what actually
                  lets a Finance reviewer catch a graduated-vs-volume mistake
                  before it reaches a real invoice, not internal field names. */}
              {workedExample && (
                <div className="rounded-xl p-3" style={{ background: '#EFF6FF', border: '1px solid rgba(59,130,246,0.25)' }}>
                  <p className="text-[10px] font-bold uppercase tracking-widest mb-1.5" style={{ color: '#1E40AF' }}>Worked example</p>
                  <p className="text-xs text-stone leading-relaxed">{workedExample}</p>
                </div>
              )}

              <div className="rounded-xl p-3" style={{ background: '#FFFDF5', border: '1px solid rgba(217,167,90,0.35)' }}>
                <p className="text-[10px] font-bold uppercase tracking-widest mb-2" style={{ color: '#92400E' }}>What will change</p>
                <ul className="space-y-1">
                  {whatWillChange.map((c, i) => (
                    <li key={i} className="text-[11px]" style={{ color: c.component === 'Usage Source' ? '#B45309' : '#78350F' }}>
                      <span className="font-semibold">{c.component}</span> — {c.change}
                    </li>
                  ))}
                </ul>
              </div>

              {historicalImpact && (
                <div className="rounded-xl p-3" style={{ background: '#FEF2F2', border: '1px solid #FECACA' }}>
                  <p className="text-xs font-semibold mb-1" style={{ color: '#991B1B' }}>
                    <i className="ti ti-alert-triangle mr-1" style={{ fontSize: 12 }} /> Historical impact detected
                  </p>
                  <p className="text-[11px]" style={{ color: '#7F1D1D' }}>
                    This interpretation would also affect {historicalImpact.affectedCount} already-billed period{historicalImpact.affectedCount > 1 ? 's' : ''} ({historicalImpact.periods.join(', ')}). Existing issued invoices will not be changed automatically.
                  </p>
                </div>
              )}

              {errorMsg && <p className="text-xs" style={{ color: '#DC2626' }}>{errorMsg}</p>}
              <div className="flex gap-2">
                <button
                  onClick={confirmAndApply}
                  disabled={phase === 'confirming'}
                  className="flex-1 py-2 rounded-xl text-sm font-semibold transition-colors disabled:opacity-40"
                  style={{ background: '#1A3D2B', color: 'white' }}
                >
                  {phase === 'confirming' ? <i className="ti ti-loader-2 animate-spin" style={{ fontSize: 13 }} /> : 'Confirm & apply change'}
                </button>
                <button onClick={() => setPhase('input')} className="px-4 py-2 rounded-xl text-sm text-stone hover:text-ink border transition-colors" style={{ borderColor: 'rgba(26,61,43,0.15)' }}>
                  Continue editing
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
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
  escalators,
  discounts,
  serviceCredits,
  baseFeeAmount,
  baseFeeProration,
  additionalRecurringFees,
  extractionNotes,
  contractStartDate,
  contractEndDate,
  numberFormat = 'dot',
  onViewSource,
  cur,
  isConfigured,
  contractBillingFrequency,
  onMeterMappingsConfirmedChange,
  onVatStatusChange,
  onVatSaved,
  refreshSignal,
}: {
  items: LineItem[]
  corrections: Record<string, { value: string; remember: boolean }>
  onCorrect: (itemId: string, value: string) => void
  onClose: () => void
  onRefresh: () => void
  jobId: string
  overageTiers?: Tier[]
  escalators?: Escalator[]
  discounts?: Discount[]
  serviceCredits?: ServiceCredit[]
  baseFeeAmount?: number | null
  baseFeeProration?: PeriodProrationRule | null
  additionalRecurringFees?: AdditionalRecurringFee[]
  // Free-text notes the extraction model writes for anything it noticed but
  // couldn't fit into a structured field — e.g. a penalty clause, which
  // is the opposite polarity from service_credits (an additional charge,
  // not a reduction) and has no first-class structured home yet. Shown
  // as-is so it's never silently dropped just because nothing downstream
  // knows how to structure it.
  extractionNotes?: string | null
  contractStartDate?: string
  contractEndDate?: string
  numberFormat?: 'dot' | 'comma'
  onViewSource?: (section?: string) => void
  cur?: string
  isConfigured?: boolean
  contractBillingFrequency?: string | null
  onMeterMappingsConfirmedChange?: (confirmed: boolean) => void
  // Feeds the page's own vatConfigured state (same canonical status the
  // main GUI's VatConfigRow instance reports) — the Approve gate must see
  // the same boolean regardless of which surface last changed it.
  onVatStatusChange?: (configured: boolean) => void
  // Called after the drawer's own VAT card successfully saves, so the page
  // can bump its refreshSignal for every other mounted VAT surface (the
  // main GUI's VatConfigRow) to pick up immediately.
  onVatSaved?: () => void
  // Bumped by the parent whenever its own job/terms data refreshes, so the
  // embedded MeterMappingPanel (which manages its own independent fetch)
  // re-syncs after a rule interpretation confirmed elsewhere in this same
  // panel — otherwise it keeps showing stale "unconfirmed" state until
  // reload. Also used by the drawer's own VatReviewCard so a VAT save from
  // the main GUI (or vice versa) is reflected here without a manual reload.
  refreshSignal?: number
}) {
  const [saving,    setSaving]    = useState<string | null>(null)
  const [resolved,  setResolved]  = useState<Record<string, 'confirmed' | 'corrected'>>({})
  const [editing,   setEditing]   = useState<string | null>(null)
  const [previewing, setPreviewing] = useState<string | null>(null)
  const [draftPrice, setDraftPrice] = useState<Record<string, string>>({})
  const [draftName,  setDraftName]  = useState<Record<string, string>>({})
  const [saveError,  setSaveError]  = useState<Record<string, string>>({})
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({})

  // Meter-mapping suggestions, fetched once so any rule-interpretation card
  // can show/resolve its "usage source" dependency inline — the same data
  // MeterMappingPanel uses, so Confirm/Change mapping here writes through
  // the same endpoint and never diverges from that panel's own state.
  type MeterSuggestion = { contract_unit_type: string; meter_key: string; confirmed: boolean; included_units: number; overage_tiers: unknown; billing_cycle: string; input_classification?: 'meter' | 'meter_or_manual_input' | 'derived' | 'persisted_balance'; manual_value_configured?: boolean }
  type AvailableMeter  = { meter_key: string; display_name: string }
  const [meterSuggestions, setMeterSuggestions] = useState<MeterSuggestion[]>([])
  const [availableMeters,  setAvailableMeters]  = useState<AvailableMeter[]>([])
  useEffect(() => {
    fetch(`/api/jobs/${jobId}/meter-mappings`)
      .then(r => r.json())
      .then((res: { suggestions?: MeterSuggestion[]; available_meters?: AvailableMeter[] }) => {
        setMeterSuggestions(res.suggestions ?? [])
        setAvailableMeters(res.available_meters ?? [])
      })
      .catch(() => {})
    // Refetches on refreshSignal too, not just jobId — otherwise this
    // fetch's "confirmed" flags (used for every rule card's usage-source
    // notice) go stale the moment MeterMappingPanel confirms a mapping
    // elsewhere in the same drawer, producing the exact "Usage mappings ·
    // All confirmed" header next to a per-card "not yet confirmed" notice
    // contradiction — two independent fetches of the same fact, refreshing
    // on different signals.
  }, [jobId, refreshSignal])

  const partialPeriodMetrics = computePartialPeriodMetrics(contractStartDate, contractEndDate, overageTiers ?? [])

  // Canonical readiness — same computeCommercialRuleWorkload call the main
  // page and the server approval gate use, built from this panel's own
  // already-fetched data (overageTiers/discounts/serviceCredits/
  // baseFeeProration/meterSuggestions), so the drawer header can never show
  // a different "N confirmed" than the page-level readiness banner. This
  // replaces the old resolvedCount/items.length header, which tracked
  // per-LINE-ITEM confirmation (a mechanism the metric-scoped rule cards —
  // minimum commitment, partial period, base-fee proration, tier
  // calculation — never actually write to, so it stayed stuck at "0 of N"
  // regardless of how many of those cards were genuinely confirmed.
  const unresolvedInteractionsForWorkload = detectRuleInteractionCandidates({
    service_credits: serviceCredits, discounts, escalators,
  }).filter(cand => {
    const credit = (serviceCredits ?? []).find(c => c.credit_rule_id === cand.creditId)
    return !!credit?.interpretation && !credit.interpretation.requires_confirmation && !credit.interpretation.interaction_note
  })
  const meterMappingWorkload = {
    total: meterSuggestions.length,
    confirmed: meterSuggestions.filter(s => isMeterMappingResolved({
      classification: s.input_classification ?? 'meter', confirmed: s.confirmed, meter_key: s.meter_key, manual_value_configured: s.manual_value_configured,
    })).length,
  }
  // Same canonical useVatConfig hook every VAT surface in the product uses
  // (main GUI's pre-approval row, BillingSummaryCard, and this drawer's own
  // VatReviewCard below) — refreshSignal keeps this in sync with whichever
  // surface last saved, and onVatStatusChange feeds the page's own
  // vatConfigured state so the Approve gate sees one canonical value.
  const vat = useVatConfig(jobId, refreshSignal, onVatStatusChange)

  const commercialWorkload = computeCommercialRuleWorkload(
    {
      overage_tiers: overageTiers, escalators, discounts, service_credits: serviceCredits,
      base_fee_proration: baseFeeProration, additional_recurring_fees: additionalRecurringFees,
      contract_start_date: contractStartDate, contract_end_date: contractEndDate,
    },
    meterMappingWorkload,
    unresolvedInteractionsForWorkload.length,
    undefined,
    { configured: vat.configured },
  )
  const usageMappingsOutstanding = Math.max(0, commercialWorkload.meterMapping.total - commercialWorkload.meterMapping.confirmed)
  const commercialDecisionsOutstanding = commercialWorkload.totalToConfirm + commercialWorkload.interactionsToConfirm
  const vatOutstandingInPanel = !commercialWorkload.vat.configured
  const needsReviewInPanel = items.filter(i => i.confidence_score < 0.95 && !(i.id in corrections)).length
  const totalBlockers = commercialDecisionsOutstanding + usageMappingsOutstanding + (vatOutstandingInPanel ? 1 : 0) + needsReviewInPanel

  const resolvedCount = items.filter(i => resolved[i.id] || i.id in corrections).length
  // Same canonical readiness as totalBlockers above — not the old
  // resolvedCount === items.length equality, which the metric-scoped rule
  // cards never satisfy (they don't mark line items resolved).
  const allDone = totalBlockers === 0

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

  // Determine, per metric (unit_type), which of the 3 metric-scoped rule
  // kinds are still unresolved — computed directly from the metric's own
  // tiers, never from a per-item classifier. A metric can need more than
  // one of these simultaneously (e.g. both which minimum mode applies AND
  // how a partial first/last period is treated), and every tariff-tier row
  // of that metric carries identical duplicated ambiguity flags (the
  // established "duplicated per-metric" convention, so the billing engine
  // can read a rule from any tier row) — a first-match-wins per-item
  // classifier could only ever surface ONE of them, permanently hiding the
  // rest until that one card was confirmed. This is exactly why
  // Partial-month treatment could never appear until the minimum's own
  // mode/floor question was resolved first.
  const tiersByUnitType = new Map<string, Tier[]>()
  for (const t of overageTiers ?? []) {
    if (!t.unit_type) continue
    if (!tiersByUnitType.has(t.unit_type)) tiersByUnitType.set(t.unit_type, [])
    tiersByUnitType.get(t.unit_type)!.push(t)
  }
  const metricNeededKinds = new Map<string, MetricRuleKind[]>()
  for (const [unitType, tierList] of tiersByUnitType) {
    const kinds: MetricRuleKind[] = []
    const mc = tierList.find(t => t.minimum_commitment)?.minimum_commitment
    // Same canonical predicate the server-side readiness gate uses — a
    // minimum with an explicit mode and no included allowance (e.g.
    // TEST-PAY-002's transaction floor) no longer shows this card just
    // because its unrelated partial-period question is still open.
    const hasAllowance = tierList.some(t => (t.rate_per_unit ?? 0) === 0)
    if (isMinimumCommitmentModeUnresolved(mc, hasAllowance)) kinds.push('minimum_commitment')
    if (partialPeriodMetrics.has(unitType)) kinds.push('partial_period')
    const paidCount = tierList.filter(t => (t.rate_per_unit ?? 0) > 0).length
    if (paidCount >= 2) {
      const tierCalc = tierList.find(t => t.tier_calculation)?.tier_calculation
      if (!tierCalc || tierCalc.requires_confirmation) kinds.push('tier_calculation')
    }
    if (kinds.length > 0) metricNeededKinds.set(unitType, kinds)
  }

  // The first item.id encountered for a metric with outstanding kinds
  // becomes the "anchor" — the one render slot that shows ALL of that
  // metric's stacked rule cards, one per needed kind. Every other
  // tariff-tier row for the same metric is a pure duplicate and renders
  // nothing. metricAllItemIds lets confirming every one of a metric's
  // needed kinds mark every duplicate row resolved too, so the drawer's
  // "N of M confirmed" progress doesn't stay stuck on rows deliberately
  // never shown.
  const metricAnchorItemId = new Map<string, string>()
  const metricAllItemIds = new Map<string, string[]>()
  for (const item of items) {
    const unitType = findTierForItem(item, overageTiers ?? [])?.unit_type
    if (!unitType || !metricNeededKinds.has(unitType)) continue
    if (!metricAnchorItemId.has(unitType)) metricAnchorItemId.set(unitType, item.id)
    metricAllItemIds.set(unitType, [...(metricAllItemIds.get(unitType) ?? []), item.id])
  }

  const METRIC_RULE_LABELS: Record<MetricRuleKind, { typeLabel: string; typeIcon: string }> = {
    minimum_commitment: { typeLabel: 'Minimum commitment', typeIcon: 'ti-alert-triangle' },
    partial_period: { typeLabel: 'Partial-period treatment', typeIcon: 'ti-calendar-exclamation' },
    tier_calculation: { typeLabel: 'Tier calculation method', typeIcon: 'ti-stairs' },
  }

  // Renders ONE metric-scoped rule card — called once per entry in
  // metricNeededKinds[unitType], all stacked under the same anchor item's
  // render slot. Resolution is tracked under a synthetic `${kind}:${unitType}`
  // key (not a real item.id, since this card isn't tied to one), and only
  // once every one of a metric's needed kinds is resolved does it mark the
  // metric's real (hidden, duplicate) tariff-tier rows resolved too.
  const renderMetricRuleCard = (kind: MetricRuleKind, unitType: string, anchorItemId: string, showMeterDependencyNotice: boolean) => {
    const resolvedKey = `${kind}:${unitType}`
    const isCardResolved = !!resolved[resolvedKey]
    const ruleTier = (overageTiers ?? []).find(t => t.unit_type === unitType)
    const ruleSourceClause = kind === 'tier_calculation'
      ? (ruleTier?.tier_calculation?.source_clause ?? '')
      : (ruleTier?.minimum_commitment?.source_clause ?? '')
    const ruleMeterSuggestion = meterSuggestions.find(s => s.contract_unit_type === unitType)
    const ruleMeter = ruleMeterSuggestion ? availableMeters.find(m => m.meter_key === ruleMeterSuggestion.meter_key) : undefined
    const { typeLabel, typeIcon } = METRIC_RULE_LABELS[kind]

    return (
      <div
        key={resolvedKey}
        className="rounded-2xl border overflow-hidden transition-colors"
        style={{ borderColor: isCardResolved ? 'rgba(11,92,54,0.2)' : '#FAC775', background: isCardResolved ? '#F8FDF9' : 'white' }}
      >
        <div className="px-4 pt-4 pb-3">
          <div className="flex items-center gap-1.5 mb-2.5">
            <i className={`ti ${typeIcon} text-stone`} style={{ fontSize: 12 }} />
            <span className="text-[10px] font-semibold uppercase tracking-widest text-stone">{typeLabel}</span>
          </div>
          {/* Metric-scoped title — never one specific tariff tier's own name
              (e.g. "AI processing 100,001-250,000"). The rule applies to the
              whole metric, not one band of it. */}
          <p className="text-sm font-medium text-ink leading-snug mb-2">{unitType}</p>

          {isCardResolved ? (
            <div className="flex items-center gap-2">
              <i className="ti ti-circle-check-filled flex-shrink-0" style={{ fontSize: 15, color: '#0B5C36' }} />
              <span className="text-sm font-medium" style={{ color: '#0B5C36' }}>Confirmed</span>
            </div>
          ) : (
            <RuleInterpretationCard
              jobId={jobId}
              kind={kind}
              contractUnitType={unitType}
              cadenceLabel={cadenceNoun(ruleTier?.measurement_period)}
              sourceClause={ruleSourceClause}
              currency={cur ?? 'EUR'}
              meterMappingConfirmed={ruleMeterSuggestion?.confirmed}
              meterSuggestion={ruleMeterSuggestion ? { meter_key: ruleMeterSuggestion.meter_key, display_name: ruleMeter?.display_name } : null}
              showMeterDependencyNotice={showMeterDependencyNotice}
              onApplied={() => {
                setResolved(r => {
                  const next = { ...r, [resolvedKey]: 'confirmed' as const }
                  const stillNeeded = (metricNeededKinds.get(unitType) ?? []).some(k => k !== kind && !next[`${k}:${unitType}`])
                  if (!stillNeeded) {
                    for (const id of metricAllItemIds.get(unitType) ?? []) next[id] = 'confirmed'
                  }
                  return next
                })
                scrollToNextUnresolved(anchorItemId)
                onRefresh()
              }}
            />
          )}
        </div>
      </div>
    )
  }

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
      setPreviewing(null)
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
      setPreviewing(null)
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
            {/* Same canonical readiness model as the page-level banner
                (commercialWorkload above) — not the old per-line-item
                resolvedCount/items.length, which the metric-scoped rule
                cards (minimum commitment, partial period, base-fee
                proration, tier calculation) never write to, so it stayed
                stuck at "0 of N" regardless of how many of those were
                actually confirmed. */}
            <p className="text-xs text-stone mt-0.5">
              {totalBlockers === 0
                ? <span className="font-medium" style={{ color: '#0B5C36' }}>All confirmed · Ready to approve</span>
                : `${totalBlockers} decision${totalBlockers > 1 ? 's' : ''} outstanding`}
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
              width:      allDone ? '100%' : `${items.length > 0 ? (resolvedCount / items.length) * 100 : 0}%`,
              background: allDone ? '#0B5C36' : '#D97706',
            }}
          />
        </div>

        {/* Item list */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {/* Meter mapping — "where does this metric's usage data come from"
              is a review item like any other, so it lives here rather than
              as a separate section on the main page. Collapses itself once
              every metric is confirmed (existing MeterMappingPanel behavior).
              This is the ONE place a mapping is actually confirmed/changed —
              each rule-interpretation card below only shows a read-only
              dependency notice pointing back here (a "Confirm mapping"
              control used to be duplicated onto every card too, each backed
              by its own independent fetch/POST, so two different pickers
              could show or set different state for the same metric). */}
          {(overageTiers?.length ?? 0) > 0 && (
            <div id="meter-mapping-panel">
              <MeterMappingPanel
                jobId={jobId}
                isConfigured={isConfigured}
                onConfirmedChange={c => onMeterMappingsConfirmedChange?.(c)}
                contractBillingFrequency={contractBillingFrequency}
                refreshSignal={refreshSignal}
              />
            </div>
          )}

          {/* Discounts — each resolved independently, keyed by its own
              discount_rule_id rather than bundled into a single "primary
              discount" ambiguity. A contract can have several (onboarding,
              volume, reseller...) and only the unresolved ones surface here. */}
          {(() => {
            const unresolvedDiscounts = (discounts ?? []).filter(isDiscountUnresolved)
            if (unresolvedDiscounts.length === 0) return null
            return (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-stone">Discounts</p>
                  <div className="flex-1 h-px" style={{ background: 'rgba(26,61,43,0.1)' }} />
                </div>
                <div className="space-y-3">
                  {unresolvedDiscounts.map((d, i) => {
                    const discountId = d.discount_rule_id ?? String((discounts ?? []).indexOf(d))
                    const label = d.description || d.applies_to || `Discount ${i + 1}`
                    return (
                      <div key={discountId} className="rounded-2xl border overflow-hidden" style={{ borderColor: '#FAC775', background: 'white' }}>
                        <div className="px-4 pt-4 pb-3">
                          <div className="flex items-center gap-1.5 mb-2.5">
                            <i className="ti ti-discount-2 text-stone" style={{ fontSize: 12 }} />
                            <span className="text-[10px] font-semibold uppercase tracking-widest text-stone">Discount structure</span>
                          </div>
                          <p className="text-sm font-medium text-ink leading-snug mb-3">{label}</p>
                          {/* No separate static "why review" blurb here — it
                              used to show a generic staircase-vs-volume
                              explanation on every discount regardless of
                              whether it was actually tiered, which was simply
                              wrong for a flat discount like this one. The AI
                              proposal card below supplies the real,
                              clause-specific reasoning; a second, static,
                              sometimes-incorrect explanation above it is
                              redundant at best and misleading at worst. */}
                          <RuleInterpretationCard
                            jobId={jobId}
                            kind="discount"
                            discountId={discountId}
                            sourceClause={d.description ?? label}
                            currency={cur ?? 'EUR'}
                            onApplied={onRefresh}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })()}

          {/* Service credits — SLA/availability credits, rebates, promotional
              or earned/usage credits — same independent-addressing pattern as
              Discounts, keyed by credit_rule_id rather than bundled. */}
          {(() => {
            // Shared with lib/commercial-rule-status.ts's own service-credit
            // loop (isServiceCreditUnresolved) — same function, not a
            // separately-written copy of the expression, so this section's
            // card visibility can never drift from what actually drives the
            // outstanding COUNT. Checking only the top-level flag here used
            // to mean a credit whose trigger/rate/cap got confirmed but
            // whose application scope the contract never stated would
            // vanish from this section entirely — still counted as
            // outstanding everywhere else, but with no card left to resolve
            // it from.
            const unresolvedCredits = (serviceCredits ?? []).filter(isServiceCreditUnresolved)
            if (unresolvedCredits.length === 0) return null
            return (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-stone">Service credits</p>
                  <div className="flex-1 h-px" style={{ background: 'rgba(26,61,43,0.1)' }} />
                </div>
                <div className="space-y-3">
                  {unresolvedCredits.map((c, i) => {
                    const creditId = c.credit_rule_id ?? String((serviceCredits ?? []).indexOf(c))
                    const label = c.description || `Service credit ${i + 1}`
                    return (
                      <div key={creditId} className="rounded-2xl border overflow-hidden" style={{ borderColor: '#FAC775', background: 'white' }}>
                        <div className="px-4 pt-4 pb-3">
                          <div className="flex items-center gap-1.5 mb-2.5">
                            <i className="ti ti-receipt-refund text-stone" style={{ fontSize: 12 }} />
                            <span className="text-[10px] font-semibold uppercase tracking-widest text-stone">{CREDIT_BASIS_LABEL[c.credit_type ?? 'other'] ?? 'Credit basis'}</span>
                          </div>
                          <p className="text-sm font-medium text-ink leading-snug mb-3">{label}</p>
                          {/* Same as the Discounts section above — no separate
                              static "why review" blurb; the AI proposal card's
                              own clause-specific reasoning is the single
                              source of truth. */}
                          <RuleInterpretationCard
                            jobId={jobId}
                            kind="service_credit"
                            creditId={creditId}
                            sourceClause={c.source_clause ?? label}
                            currency={cur ?? 'EUR'}
                            onApplied={onRefresh}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })()}

          {/* Rule interactions — two independently-extracted rules (e.g. a
              service credit and an introductory discount) that reference the
              same fee component. Surfaced only once the credit's own basis is
              confirmed (confirm-rule needs somewhere to write the resolution
              back onto) and hidden again once that resolution is recorded. */}
          {(() => {
            const candidates = detectRuleInteractionCandidates({ service_credits: serviceCredits, discounts, escalators })
              .filter(cand => {
                const credit = (serviceCredits ?? []).find(c => c.credit_rule_id === cand.creditId)
                return !!credit?.interpretation && !credit.interpretation.requires_confirmation && !credit.interpretation.interaction_note
              })
            if (candidates.length === 0) return null
            return (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-stone">Rule interactions</p>
                  <div className="flex-1 h-px" style={{ background: 'rgba(26,61,43,0.1)' }} />
                </div>
                <div className="space-y-3">
                  {candidates.map(cand => (
                    <div key={cand.interactionKey} className="rounded-2xl border overflow-hidden" style={{ borderColor: '#FAC775', background: 'white' }}>
                      <div className="px-4 pt-4 pb-3">
                        <div className="flex items-center gap-1.5 mb-2.5">
                          <i className="ti ti-arrows-cross text-stone" style={{ fontSize: 12 }} />
                          <span className="text-[10px] font-semibold uppercase tracking-widest text-stone">Interaction to confirm</span>
                        </div>
                        <p className="text-sm font-medium text-ink leading-snug mb-3">{cand.creditLabel} × {cand.otherRule.label}</p>
                        <p className="text-[11px] text-stone leading-relaxed mb-3">
                          <span className="font-medium">Why review: </span>
                          {cand.overlapReason}
                        </p>
                        <RuleInterpretationCard
                          jobId={jobId}
                          kind="rule_interaction"
                          creditId={cand.creditId}
                          interactionKey={cand.interactionKey}
                          sourceClause={cand.overlapReason}
                          currency={cur ?? 'EUR'}
                          onApplied={onRefresh}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
          })()}

          {/* Partial-period treatment for the base fee and any additional
              recurring fees — same independent-addressing pattern as
              Discounts/Service credits above. Only surfaced once extraction
              has actually flagged a calendar-anchored ambiguity
              (requires_confirmation === true); a contract with no such
              ambiguity (or one already resolved) shows nothing here. */}
          {(() => {
            const baseUnresolved = !!baseFeeProration?.requires_confirmation && !!baseFeeAmount
            const unresolvedFees = (additionalRecurringFees ?? []).filter(f => f.proration?.requires_confirmation)
            if (!baseUnresolved && unresolvedFees.length === 0) return null
            return (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-stone">Partial-period treatment</p>
                  <div className="flex-1 h-px" style={{ background: 'rgba(26,61,43,0.1)' }} />
                </div>
                <div className="space-y-3">
                  {baseUnresolved && (
                    <div className="rounded-2xl border overflow-hidden" style={{ borderColor: '#FAC775', background: 'white' }}>
                      <div className="px-4 pt-4 pb-3">
                        <div className="flex items-center gap-1.5 mb-2.5">
                          <i className="ti ti-calendar-exclamation text-stone" style={{ fontSize: 12 }} />
                          <span className="text-[10px] font-semibold uppercase tracking-widest text-stone">Partial-period treatment</span>
                        </div>
                        <p className="text-sm font-medium text-ink leading-snug mb-1">Platform subscription fee</p>
                        <p className="text-[11px] text-stone leading-relaxed mb-3">
                          The agreement states the {fmt(baseFeeAmount, cur ?? 'EUR')} fee is billed {contractBillingFrequency ?? 'monthly'} in advance, but does not say whether billing periods reset on calendar boundaries or on the contract start date itself{contractStartDate ? ` (${contractStartDate})` : ''}. This decides whether a partial-period question exists at all.
                        </p>
                        <RuleInterpretationCard
                          jobId={jobId}
                          kind="base_fee_proration"
                          contractUnitType={BASE_FEE_PRORATION_SENTINEL}
                          cadenceLabel={cadenceNoun(contractBillingFrequency)}
                          contractPeriodLabel={contractMonthLabel(contractStartDate)}
                          sourceClause={baseFeeProration?.source_clause ?? ''}
                          currency={cur ?? 'EUR'}
                          onApplied={onRefresh}
                        />
                      </div>
                    </div>
                  )}
                  {unresolvedFees.map((f, i) => (
                    <div key={f.fee_label ?? i} className="rounded-2xl border overflow-hidden" style={{ borderColor: '#FAC775', background: 'white' }}>
                      <div className="px-4 pt-4 pb-3">
                        <div className="flex items-center gap-1.5 mb-2.5">
                          <i className="ti ti-calendar-exclamation text-stone" style={{ fontSize: 12 }} />
                          <span className="text-[10px] font-semibold uppercase tracking-widest text-stone">Partial-period treatment</span>
                        </div>
                        <p className="text-sm font-medium text-ink leading-snug mb-1">{f.fee_label}</p>
                        <p className="text-[11px] text-stone leading-relaxed mb-3">
                          The agreement states the {fmt(f.amount, cur ?? 'EUR')} fee is billed {f.billing_frequency ?? contractBillingFrequency ?? 'monthly'}, but does not say whether billing periods reset on calendar boundaries or on the contract start date itself{contractStartDate ? ` (${contractStartDate})` : ''}. This decides whether a partial-period question exists at all.
                        </p>
                        <RuleInterpretationCard
                          jobId={jobId}
                          kind="recurring_fee_proration"
                          contractUnitType={f.fee_label}
                          cadenceLabel={cadenceNoun(f.billing_frequency ?? contractBillingFrequency)}
                          contractPeriodLabel={contractMonthLabel(contractStartDate)}
                          sourceClause={f.proration?.source_clause ?? f.description ?? ''}
                          currency={cur ?? 'EUR'}
                          onApplied={onRefresh}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
          })()}

          {/* VAT — a required approval blocker, but deliberately never
              presented as a "rule interpretation": no AI proposal, no
              Clear-from-source/Verdix-recommendation state, because VAT is
              a plain user-provided operational input the contract is never
              read for (see lib/vat.ts). Reuses the exact same useVatConfig
              hook (and therefore the exact same customer_vat_config/
              pending_vat_* state) as the main GUI's VatConfigRow — never a
              second, independently-tracked VAT value. Guarded on !vat.loading
              so the brief initial fetch never flashes "not configured"
              (the hook's default state) before the real value arrives. */}
          {!vat.loading && (
          <div>
            <div className="flex items-center gap-2 mb-3">
              <p className="text-[10px] font-bold uppercase tracking-widest text-stone">VAT</p>
              <div className="flex-1 h-px" style={{ background: 'rgba(26,61,43,0.1)' }} />
            </div>
            <div
              className="rounded-2xl border overflow-hidden"
              style={{ borderColor: vat.configured ? 'rgba(11,92,54,0.2)' : '#FAC775', background: vat.configured ? '#F8FDF9' : 'white' }}
            >
              <div className="px-4 pt-4 pb-3">
                {!vat.editing ? (
                  <>
                    <div className="flex items-center gap-1.5 mb-2.5">
                      <i className={`ti ${vat.configured ? 'ti-circle-check-filled' : 'ti-calendar-exclamation'} text-stone`} style={{ fontSize: 12, color: vat.configured ? '#0B5C36' : undefined }} />
                      <span className="text-[10px] font-semibold uppercase tracking-widest text-stone">VAT treatment</span>
                      {!vat.configured && (
                        <span className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full" style={{ background: 'rgba(153,27,27,0.1)', color: '#991B1B' }}>
                          Required before approval
                        </span>
                      )}
                    </div>
                    {vat.configured ? (
                      <>
                        <p className="text-sm font-medium text-ink leading-snug mb-0.5">
                          VAT: {vat.treatment!.mode === 'zero_rated' ? '0% (zero-rated)' : `${vat.treatment!.ratePct}%`}
                        </p>
                        <p className="text-[11px] text-stone leading-relaxed mb-3">Source: User-provided billing configuration</p>
                      </>
                    ) : (
                      <p className="text-sm font-medium text-ink leading-snug mb-3">No VAT treatment configured</p>
                    )}
                    <button
                      onClick={vat.startEdit}
                      className="text-[11px] font-semibold px-3 py-1.5 rounded-lg"
                      style={vat.configured ? { color: '#1A3D2B', background: 'transparent', border: '1px solid rgba(26,61,43,0.15)' } : { background: '#1A3D2B', color: 'white' }}
                    >
                      {vat.configured ? 'Edit' : 'Configure'}
                    </button>
                  </>
                ) : (
                  <div className="space-y-2">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-stone mb-1">How is this customer taxed?</p>
                    <div className="flex items-center gap-4">
                      <label className="flex items-center gap-1.5 text-[12px] text-ink cursor-pointer">
                        <input type="radio" checked={vat.draftMode === 'rate'} onChange={() => vat.setDraftMode('rate')} /> Rate
                      </label>
                      {vat.draftMode === 'rate' && (
                        <input
                          type="number" min={0} max={100} step="0.01" value={vat.draftRate}
                          onChange={e => vat.setDraftRate(e.target.value)}
                          className="w-20 text-[12px] border rounded-lg px-2 py-1 outline-none"
                          style={{ borderColor: 'rgba(26,61,43,0.15)' }}
                        />
                      )}
                      {vat.draftMode === 'rate' && <span className="text-[12px] text-stone">%</span>}
                      <label className="flex items-center gap-1.5 text-[12px] text-ink cursor-pointer">
                        <input type="radio" checked={vat.draftMode === 'zero_rated'} onChange={() => vat.setDraftMode('zero_rated')} /> Zero-rated (0%)
                      </label>
                    </div>
                    {vat.saveError && <p className="text-[11px]" style={{ color: '#DC2626' }}>{vat.saveError}</p>}
                    <div className="flex items-center gap-2">
                      <button
                        onClick={async () => { const ok = await vat.save(); if (ok) onVatSaved?.() }}
                        disabled={vat.saving}
                        className="text-[11px] font-semibold px-3 py-1.5 rounded-lg disabled:opacity-40"
                        style={{ background: '#1A3D2B', color: 'white' }}
                      >
                        {vat.saving ? 'Saving…' : 'Save'}
                      </button>
                      <button onClick={vat.cancelEdit} disabled={vat.saving} className="text-[11px] text-stone hover:text-ink">Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
          )}

          {/* Extraction notes — free-text flags for anything the model
              noticed but couldn't fit into a structured field (e.g. a
              penalty clause, which is the opposite polarity from
              service_credits). No structured rule to confirm here, just
              visibility — the point is that it never silently disappears
              just because nothing downstream knows how to structure it. */}
          {extractionNotes && (
            <div className="rounded-2xl border overflow-hidden" style={{ borderColor: 'rgba(26,61,43,0.12)', background: '#FAFAF9' }}>
              <div className="px-4 pt-4 pb-3">
                <div className="flex items-center gap-1.5 mb-2">
                  <i className="ti ti-note text-stone" style={{ fontSize: 12 }} />
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-stone">Extraction notes</span>
                </div>
                <p className="text-xs text-stone leading-relaxed whitespace-pre-line">{extractionNotes}</p>
                {/* This text is written once, at extraction time, and never
                    rewritten afterward — a policy it flags as unresolved
                    here may since have been confirmed via its own review
                    card above (or may have none at all if it doesn't map to
                    a structured rule type). It is a point-in-time snapshot,
                    not a live list of outstanding decisions — the review
                    cards above and the "decisions outstanding" count are the
                    live signal for what's actually still open. */}
                <p className="text-[10px] text-stone/70 italic mt-2">
                  Reflects the original extraction — a decision mentioned here may already be resolved by a review card above; it is not itself a live outstanding-decision indicator.
                </p>
              </div>
            </div>
          )}

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
                  // Metric-scoped rules (minimum commitment, partial-period
                  // treatment, tier calculation) are handled entirely outside
                  // classifyItem now — see metricNeededKinds/renderMetricRuleCard
                  // above. The anchor row renders every one of its metric's
                  // needed kinds stacked as separate cards; every other row
                  // of that metric is a pure duplicate and renders nothing.
                  const metricUnitType = findTierForItem(item, overageTiers ?? [])?.unit_type
                  if (metricUnitType && metricNeededKinds.has(metricUnitType)) {
                    if (metricAnchorItemId.get(metricUnitType) !== item.id) return null
                    // The usage-source dependency notice, if this metric's
                    // meter isn't confirmed, only needs to say so once — on
                    // the first STILL-UNRESOLVED card in the stack (found
                    // dynamically, not just index 0 — confirming one kind
                    // without the others shouldn't leave the notice
                    // orphaned on an already-"Confirmed" card that no
                    // longer renders it).
                    const kinds = metricNeededKinds.get(metricUnitType)!
                    const firstUnresolvedIdx = kinds.findIndex(k => !resolved[`${k}:${metricUnitType}`])
                    return (
                      <Fragment key={item.id}>
                        {kinds.map((k, i) => renderMetricRuleCard(k, metricUnitType, item.id, i === firstUnresolvedIdx))}
                      </Fragment>
                    )
                  }

                  // Plain (non-metric) value-confirmation cards still gate
                  // on extraction confidence — unlike the metric-scoped
                  // branch above, there's no structural ambiguity signal
                  // here independent of confidence, so a confidently
                  // extracted value has nothing left to review.
                  if (item.confidence_score >= 0.95) return null

                  const kind        = classifyItem(item, escalators ?? [])
                  const ctx         = getReviewContext(item, kind, numberFormat, overageTiers ?? [])
                  const isResolved  = !!(resolved[item.id] || item.id in corrections)
                  const isRuleInterpretation = kind === 'escalator_interpretation'
                  const ruleTier       = isRuleInterpretation ? findTierForItem(item, overageTiers ?? []) : undefined
                  const ruleUnitType   = ruleTier?.unit_type
                  // The IMMUTABLE clause as actually extracted — never the
                  // generated "what to check" instruction text above (ctx.whatToCheck),
                  // which is a review PROMPT, not contract language. Feeding
                  // generated text into the AI as if it were the source clause
                  // produced false "the contract doesn't specify..." verdicts
                  // for clauses that were, in fact, explicit.
                  const ruleSourceClause = escalators?.[0]?.description ?? ''
                  // No separate title line for escalator_interpretation — the
                  // type badge right above already reads "Price escalation";
                  // repeating it as the card's own name was a duplicate heading.
                  const ruleTitle = ''
                  const ruleMeterSuggestion = ruleUnitType ? meterSuggestions.find(s => s.contract_unit_type === ruleUnitType) : undefined
                  const ruleMeter      = ruleMeterSuggestion ? availableMeters.find(m => m.meter_key === ruleMeterSuggestion.meter_key) : undefined
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
                          {/* No confidence-score "Needs confirmation" pill for
                              rule-interpretation kinds — RuleInterpretationCard
                              renders its own state badge (Clear from source /
                              Verdix recommendation / Decision required), and a
                              second, unconditional "Needs confirmation" pill
                              sitting right next to it just contradicted
                              whatever the AI card said underneath. */}
                          {!isRuleInterpretation && (
                            <div className="flex items-center gap-1.5">
                              {/* "Clear from source" and "Needs confirmation"
                                  answer different questions — source
                                  confidence vs. the human-confirmation
                                  workflow gate — and can both be true at
                                  once (e.g. an explicit "SEK 195 per
                                  chargeback" that's still awaiting a
                                  reviewer's click). One must never imply the
                                  absence of the other, so both render
                                  alongside each other rather than one
                                  replacing the other. */}
                              {score >= 0.95 && !!item.source_section && (
                                <span
                                  className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
                                  style={{ color: '#0B5C36', background: 'rgba(11,92,54,0.1)' }}
                                >
                                  Clear from source
                                </span>
                              )}
                              <span
                                className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
                                style={{ color: scoreColor, background: `${scoreColor}15` }}
                              >
                                Needs confirmation
                              </span>
                            </div>
                          )}
                        </div>

                        {/* Extracted name — omitted for escalator_interpretation
                            (ruleTitle is '') since the type badge above already
                            says "Price escalation"; a second identical line was
                            a duplicate heading. */}
                        {(!isRuleInterpretation || ruleTitle) && (
                          <p className="text-sm font-medium text-ink leading-snug mb-2">
                            {isRuleInterpretation ? ruleTitle : item.product_name}
                          </p>
                        )}

                        {!isRuleInterpretation && (
                          <>
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
                          </>
                        )}

                        {/* Actions or edit form */}
                        {isRuleInterpretation && !isResolved ? (
                          // Ambiguous commercial rules are resolved entirely in-panel:
                          // structured choice + free text → AI proposal → "what will
                          // change" → human approval — never routed to another screen.
                          <RuleInterpretationCard
                            jobId={jobId}
                            kind={kind}
                            contractUnitType={ruleUnitType}
                            cadenceLabel={cadenceNoun(ruleTier?.measurement_period)}
                            sourceClause={ruleSourceClause}
                            currency={item.currency}
                            meterMappingConfirmed={ruleMeterSuggestion?.confirmed}
                            meterSuggestion={ruleMeterSuggestion ? { meter_key: ruleMeterSuggestion.meter_key, display_name: ruleMeter?.display_name } : null}
                            onApplied={() => {
                              // Only escalator_interpretation reaches this
                              // branch now (minimum_commitment/partial_period/
                              // tier_calculation are handled by
                              // renderMetricRuleCard above) — a single
                              // job-level entity, no duplicate rows to fan out to.
                              setResolved(r => ({ ...r, [item.id]: 'confirmed' }))
                              scrollToNextUnresolved(item.id)
                              onRefresh()
                            }}
                          />
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
                        ) : isEditing && previewing === item.id ? (
                          <div className="space-y-2">
                            {/* Preview change — the reviewer sees exactly what's about to
                                change before it touches any billing data, per the same
                                approve-once-before-propagation pattern used for ambiguous
                                rules below. */}
                            <div className="rounded-xl p-3" style={{ background: '#FFFDF5', border: '1px solid rgba(217,167,90,0.35)' }}>
                              <p className="text-[10px] font-bold uppercase tracking-widest mb-2" style={{ color: '#92400E' }}>Proposed update</p>
                              <div className="flex justify-between text-xs mb-1">
                                <span className="text-stone">Old</span>
                                <span className="font-medium text-ink">
                                  {ctx.primaryField === 'unit_price' ? fmtUnit(item.unit_price, item.currency) : item.product_name}
                                </span>
                              </div>
                              <div className="flex justify-between text-xs mb-2">
                                <span className="text-stone">New</span>
                                <span className="font-semibold text-ink">
                                  {ctx.primaryField === 'unit_price' ? (draftPrice[item.id] || '—') : (draftName[item.id] || '—')}
                                </span>
                              </div>
                              <p className="text-[10px] font-semibold uppercase tracking-widest text-stone/60 mb-1">Affected configuration</p>
                              <ul className="text-[11px] text-stone space-y-0.5">
                                <li>• Billing Configuration</li>
                                <li>• Commercial Terms</li>
                              </ul>
                            </div>
                            {saveError[item.id] && (
                              <p className="text-xs" style={{ color: '#DC2626' }}>{saveError[item.id]}</p>
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
                                  : 'Confirm & apply'
                                }
                              </button>
                              <button
                                onClick={() => setPreviewing(null)}
                                className="px-3 py-2 rounded-xl text-sm text-stone hover:text-ink border transition-colors"
                                style={{ borderColor: 'rgba(26,61,43,0.15)' }}
                              >
                                Continue editing
                              </button>
                              <button
                                onClick={() => { setEditing(null); setPreviewing(null) }}
                                className="px-3 py-2 rounded-xl text-sm text-stone hover:text-ink border transition-colors"
                                style={{ borderColor: 'rgba(26,61,43,0.15)' }}
                              >
                                Cancel
                              </button>
                            </div>
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
                                  onKeyDown={e => { if (e.key === 'Enter') setPreviewing(item.id) }}
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
                                  onKeyDown={e => { if (e.key === 'Enter') setPreviewing(item.id) }}
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
                                onClick={() => setPreviewing(item.id)}
                                disabled={isSaving}
                                className="flex-1 py-2 rounded-xl text-sm font-semibold transition-colors disabled:opacity-40"
                                style={{ background: '#1A3D2B', color: 'white' }}
                              >
                                Preview change
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
  // Reported by VatConfigRow (job-scoped pending_vat_* pre-approval, or the
  // real customer_vat_config once approved) — undefined while its own fetch
  // is still in flight, so the Approve button isn't briefly enabled before
  // the real status is known.
  const [vatConfigured, setVatConfigured] = useState<boolean | undefined>(undefined)
  const [billingEdit, setBillingEdit] = useState<{ itemId: string; field: 'quantity' | 'unit_price' | 'billing_period'; value: string } | null>(null)
  const [approved, setApproved]       = useState<{ stripeSubscriptionId: string; dashboardUrl?: string; customerId?: string } | null>(null)
  const [meterMappingsConfirmed, setMeterMappingsConfirmed] = useState(false)
  // Bumped on every fetchJob() so components that manage their own
  // independent data fetch (MeterMappingPanel) know to re-sync — otherwise a
  // rule confirmed via RuleInterpretationCard (which writes through
  // /confirm-rule, not that panel's own save path) leaves it showing stale
  // "unconfirmed" state until the page is reloaded.
  const [refreshSignal, setRefreshSignal] = useState(0)
  // Tracks the last value this was actually called with, so a call that
  // reports the same confirmed-state twice in a row is a no-op instead of
  // bumping refreshSignal again — refreshSignal re-triggers MeterMappingPanel's
  // own fetch effect, so an unconditional bump on every call is a direct path
  // to a self-sustaining refetch loop if this ever gets invoked repeatedly
  // with an unchanged value (e.g. a re-render storm elsewhere).
  const lastConfirmedRef = useRef<boolean | null>(null)
  // Stable reference — MeterMappingPanel re-runs its own onConfirmedChange
  // effect whenever this callback's identity changes, so an inline arrow
  // function here would re-trigger on every render and bump refreshSignal
  // in an infinite loop (refreshSignal change -> panel refetch -> new
  // inline callback -> effect fires -> bump refreshSignal -> ...).
  const handleMeterMappingsConfirmedChange = useCallback((c: boolean) => {
    setMeterMappingsConfirmed(c)
    if (lastConfirmedRef.current === c) return
    lastConfirmedRef.current = c
    setRefreshSignal(s => s + 1)
  }, [])
  // Bumped whenever EITHER VAT surface (this page's own VatConfigRow, or
  // the Review Panel drawer's VatReviewCard) saves — no dedup guard needed
  // here the way handleMeterMappingsConfirmedChange needs one: useVatConfig's
  // save() only ever calls this on a genuine successful write, never on the
  // mount-driven initial load, so there is no repeated-call/ping-pong risk
  // to guard against.
  const handleVatSaved = useCallback(() => setRefreshSignal(s => s + 1), [])
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

  // Read-only summary for the main-tab meter-mapping status chip — the
  // review-drawer's MeterMappingPanel mount (inside ReviewPanel) is the only
  // place a mapping is actually confirmed/changed; this fetch never writes,
  // so it can't diverge from that panel's own state the way two independent
  // editable mounts of the same component previously could.
  const [meterMappingSummary, setMeterMappingSummary] = useState<{ total: number; confirmed: number }>({ total: 0, confirmed: 0 })
  useEffect(() => {
    fetch(`/api/jobs/${id}/meter-mappings`)
      .then(r => r.json())
      .then((res: { suggestions?: Array<{ confirmed: boolean; meter_key: string; input_classification?: 'meter' | 'meter_or_manual_input' | 'derived' | 'persisted_balance'; manual_value_configured?: boolean }> }) => {
        const suggestions = res.suggestions ?? []
        setMeterMappingSummary({
          total: suggestions.length,
          confirmed: suggestions.filter(s => isMeterMappingResolved({ classification: s.input_classification ?? 'meter', confirmed: s.confirmed, meter_key: s.meter_key, manual_value_configured: s.manual_value_configured })).length,
        })
      })
      .catch(() => {})
  }, [id, refreshSignal])
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

  // Audit-trail metadata (reviewer, timestamp, source clause) for every
  // currently-confirmed commercial rule — enriches the Commercial Terms
  // "Confirmed rules" card beyond what contract_terms alone can show, since
  // contract_terms only holds the current operational value, not who
  // approved it or when. Resilient to the audit table not existing yet.
  // Every revision, current and historical — the GET route returns them all
  // so "View previous version" can browse history without a second endpoint.
  const [ruleInterpretations, setRuleInterpretations] = useState<RuleInterpretationRecord[]>([])
  // Which confirmed rule (by "min:{unitType}" / "esc:{index}" key) has its
  // Edit-commercial-rule drawer open — a real right-side drawer now, not an
  // inline-expanding card, since this is a revision to an already-approved
  // rule and should feel distinct from first-time review.
  const [editingRule, setEditingRule] = useState<string | null>(null)
  const fetchRuleInterpretations = () => {
    fetch(`/api/jobs/${id}/rule-interpretations`)
      .then(r => r.json())
      .then((res: { interpretations?: RuleInterpretationRecord[] }) => setRuleInterpretations(res.interpretations ?? []))
      .catch(() => {})
  }
  useEffect(() => { fetchRuleInterpretations() }, [id])
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
    setRefreshSignal(s => s + 1)

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
    // `cancelled` is checked both before scheduling the next tick and before
    // acting on a response that arrives after cleanup — without it, a poll
    // chain started by one mount of this effect (e.g. before a Strict Mode
    // double-invoke, or an `id` change) keeps recursing via setTimeout
    // forever, since nothing else references or can cancel that specific
    // timer. Multiple orphaned chains each polling every 3s independently is
    // exactly what was flooding /meter-mappings with bursts of duplicate
    // requests.
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const poll = async () => {
      const data = await fetchJob()
      if (cancelled || !data) return
      if (['PENDING_HUMAN_REVIEW', 'READY_TO_APPROVE', 'COMPLETED', 'FAILED'].includes(data.execute_status)) return
      timer = setTimeout(poll, 3000)
    }
    poll()
    const cycle = setInterval(() => setMsgIdx(i => (i + 1) % PROCESSING_MESSAGES.length), 2000)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      clearInterval(cycle)
    }
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

  // A metric measured on a different cadence than the contract's own
  // billing_frequency makes "Billing cycle: Monthly" a flatly wrong answer
  // for the contract as a whole — Contract Overview must agree with the
  // "Billing schedule: Mixed" indicator shown lower on this same page
  // (MeterMappingPanel), not contradict it. Uses each tier's own extracted
  // measurement_period rather than requiring meter-mapping confirmation
  // first, since this is a display-only summary, not a billing decision.
  const contractCycleLower = (terms?.billing_frequency ?? '').toLowerCase()
  const distinctMetricCycles = Array.from(new Set(
    tiers.filter(t => t.unit_type && t.measurement_period).map(t => t.measurement_period!.toLowerCase())
  ))
  const mixedBillingSchedule = !!contractCycleLower && distinctMetricCycles.some(c => c !== contractCycleLower)

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

  // "Configured in X" claims the whole contract is set up in the billing
  // platform — true for the fixed fees, not true while a metric's tier
  // calculation method (graduated/volume/block) is still unresolved, since
  // that metric can't be billed correctly (or at all — see lib/usage-pull.ts)
  // until it's confirmed. Scoped explicitly rather than silently overclaiming.
  const hasUnresolvedTierCalculation = Array.from(chargingGroups.values()).some(tierList => {
    const paidCount = tierList.filter(({ tier: t }) => (t.rate_per_unit ?? 0) > 0).length
    if (paidCount < 2) return false
    const tierCalc = tierList.find(({ tier: t }) => t.tier_calculation)?.tier.tier_calculation
    return !tierCalc || tierCalc.requires_confirmation
  })

  // Single shared workload computation (lib/commercial-rule-status.ts) — both
  // the "items need review" breakdown and the "All commercial rules
  // confirmed" gate below read from this one object so they can't disagree,
  // and both now correctly count discounts/service credits/rule
  // interactions (previously invisible to the old confidence-score-only
  // needsReview count and the old hand-rolled allCommercialRulesConfirmed
  // boolean, which never checked discounts at all).
  const unresolvedInteractions = detectRuleInteractionCandidates({
    service_credits: terms?.service_credits, discounts: terms?.discounts, escalators: terms?.escalators,
  }).filter(cand => {
    const credit = (terms?.service_credits ?? []).find(c => c.credit_rule_id === cand.creditId)
    return !!credit?.interpretation && !credit.interpretation.requires_confirmation && !credit.interpretation.interaction_note
  })
  const commercialRuleWorkload = computeCommercialRuleWorkload(
    terms ?? null,
    { total: tiers.length > 0 ? 1 : 0, confirmed: tiers.length === 0 || meterMappingsConfirmed ? 1 : 0 },
    unresolvedInteractions.length,
    undefined,
    // vatConfigured is undefined while still loading — treated as "not yet
    // known to be unconfigured" (configured: true) rather than outstanding,
    // so the readiness count doesn't flash "+1" the instant the page mounts
    // and settles back down a moment later once the real value arrives.
    { configured: vatConfigured !== false },
  )

  // ── Unified readiness model ── The single source every readiness
  // indicator on this page reads from — the top "items to review" callout,
  // the meter-mapping summary chip, and the Approve footer's blocked state
  // and inline hint text. Previously each of those computed its own count
  // from a different subset (needsReview alone drove the top callout and
  // gated whether it even appeared; commercialRuleWorkload drove the Approve
  // footer; the meter-mapping widget had its own total/confirmed) — a
  // confidently-worded contract with outstanding commercial-rule or VAT
  // decisions could show "Ready to approve"-adjacent language in one place
  // while a different area of the same page said items were still
  // outstanding. Every count below is real (not a boolean folded into a
  // count of 1), so "5 commercial decisions outstanding" always literally
  // means 5, matching commercialRuleWorkload's own arithmetic.
  const usageMappingsOutstanding = tiers.length > 0 ? Math.max(0, meterMappingSummary.total - meterMappingSummary.confirmed) : 0
  const commercialDecisionsOutstanding = commercialRuleWorkload.totalToConfirm + commercialRuleWorkload.interactionsToConfirm
  // Canonical — sourced from commercialRuleWorkload.vat (the same object the
  // Review Panel and server approve gate consume), not a second, separately
  // computed boolean, so this page and the drawer can never disagree about
  // whether VAT is outstanding.
  const vatOutstanding = !commercialRuleWorkload.vat.configured
  const readinessBreakdown = [
    commercialDecisionsOutstanding > 0 && `${commercialDecisionsOutstanding} commercial decision${commercialDecisionsOutstanding > 1 ? 's' : ''} outstanding`,
    usageMappingsOutstanding > 0 && `${usageMappingsOutstanding} usage mapping${usageMappingsOutstanding > 1 ? 's' : ''} outstanding`,
    vatOutstanding && 'VAT not configured',
    needsReview > 0 && `${needsReview} extracted field${needsReview > 1 ? 's' : ''} below confidence threshold`,
  ].filter((x): x is string => typeof x === 'string')
  const totalOutstanding = commercialDecisionsOutstanding + usageMappingsOutstanding + (vatOutstanding ? 1 : 0) + needsReview

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
              <i className="ti ti-circle-check" style={{ fontSize: 13 }} /> {hasUnresolvedTierCalculation ? 'Fixed fees configured in' : 'Configured in'} {billingPlatform === 'remembill' ? 'Remembill' : billingPlatform === 'chargebee' ? 'Chargebee' : 'Stripe'}
            </span>
          ) : isFailed ? (
            <span className="text-xs font-medium flex items-center gap-1.5 text-red-500">
              <i className="ti ti-alert-circle" style={{ fontSize: 13 }} /> Push failed — fix &amp; retry below
            </span>
          ) : totalOutstanding === 0 && vatConfigured !== undefined ? (
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

            {/* ── Items need review callout ── Driven entirely by the
                 unified readiness model above (totalOutstanding /
                 readinessBreakdown) — the same numbers the meter-mapping
                 summary chip and the Approve footer read, so this can never
                 show a different count than either of those. Previously
                 gated on needsReview alone (confidence-only), which could
                 hide this banner entirely while commercial-rule or VAT
                 decisions were still outstanding. */}
            {totalOutstanding > 0 && (
              <div className="flex items-center justify-between gap-4 py-3 border-t border-b border-amber-200/60">
                <div className="flex items-start gap-2.5">
                  <i className="ti ti-alert-triangle flex-shrink-0 mt-0.5" style={{ fontSize: 14, color: '#D97706' }} />
                  <div>
                    <p className="text-sm font-medium" style={{ color: '#92400E' }}>
                      {totalOutstanding} item{totalOutstanding > 1 ? 's' : ''} to review
                    </p>
                    <p className="text-xs mt-0.5 leading-relaxed" style={{ color: '#B45309' }}>
                      {readinessBreakdown.join(' · ') || 'Review these items against the source agreement before approving.'}
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
                      <p
                        onClick={() => { setCurrencyDraft(cur); setCurrencyEditing(true) }}
                        title="Change currency"
                        className="text-[15px] font-medium text-ink leading-snug cursor-pointer rounded -mx-1 px-1 hover:bg-forest/5 transition-colors"
                      >
                        {cur}
                      </p>
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
                  value={mixedBillingSchedule
                    ? 'Mixed'
                    : terms?.billing_frequency
                      ? terms.billing_frequency.charAt(0).toUpperCase() + terms.billing_frequency.slice(1)
                      : null}
                  sub={mixedBillingSchedule
                    ? `Base fee: ${terms?.billing_frequency} · ${Array.from(chargingGroups.keys()).map(unitType => {
                        const cycle = chargingGroups.get(unitType)?.find(({ tier }) => tier.measurement_period)?.tier.measurement_period
                        return cycle && cycle.toLowerCase() !== contractCycleLower ? `${unitType}: ${cycle}` : null
                      }).filter(Boolean).join(' · ')}`
                    : undefined}
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

              {/* Confirmed rules — generated from the approved, normalized model
                  (a reviewer's rule-interpretation flow). Reviewer/timestamp/
                  source come from the commercial_rule_interpretations audit
                  trail; the rule content itself comes from contract_terms
                  (the current operational value) so this can never show a
                  stale interpretation if the audit lookup fails. "Edit
                  interpretation" re-opens the same in-panel flow used to
                  confirm it in the first place — approving a new proposal
                  creates a new revision, never overwrites the old one. */}
              {(() => {
                const confirmedMinimums = new Map<string, Tier>()
                for (const t of tiers) {
                  if (!t.unit_type || !t.minimum_commitment || confirmedMinimums.has(t.unit_type)) continue
                  // Mode/allowance mechanics only — NOT the flat DB
                  // requires_confirmation flag, which also folds in the
                  // partial-period question (rendered as its own inline
                  // "Needs confirmation" line below, lines ~3900-3908). An
                  // explicit floor with no allowance shows here as
                  // Confirmed even while only its partial-period treatment
                  // remains open, instead of hiding the whole clear-cut
                  // mode/amount/period behind an unrelated open question.
                  const hasAllowance = tiers.some(ft => ft.unit_type === t.unit_type && (ft.rate_per_unit ?? 0) === 0)
                  if (isMinimumCommitmentModeUnresolved(t.minimum_commitment, hasAllowance)) continue
                  confirmedMinimums.set(t.unit_type, t)
                }
                // Only a genuinely valid treatment ('applies' or 'not_applied') counts
                // as confirmed here — an interpretation predating the treatment field
                // (or otherwise missing it) is not safe to render as "Confirmed" even
                // if requires_confirmation happens to be false; it needs to be
                // re-resolved via "Edit interpretation" instead of displayed as-is.
                const confirmedEscalators = (terms?.escalators ?? []).filter(e =>
                  e.interpretation && !e.interpretation.requires_confirmation
                  && (e.interpretation.treatment === 'applies' || e.interpretation.treatment === 'not_applied')
                )
                if (confirmedMinimums.size === 0 && confirmedEscalators.length === 0) return null
                const modeLabel: Record<string, string> = {
                  floor: 'Minimum charge floor', additive: 'Additive fee', minimum_spend: 'Spend commitment',
                  prepaid_commitment: 'Prepaid commitment', minimum_quantity: 'Minimum quantity',
                }
                const findAudit = (ruleType: string, unitType: string | null) =>
                  ruleInterpretations.find(r => r.rule_type === ruleType && r.contract_unit_type === unitType)
                return (
                  <div className="p-6" style={{ borderBottom: '1px solid rgba(26,61,43,0.07)' }}>
                    <p className="text-[10px] font-bold text-stone uppercase tracking-[0.14em] mb-3">Confirmed rules</p>
                    <div className="grid grid-cols-2 gap-4">
                      {Array.from(confirmedMinimums.entries()).map(([unitType, t]) => {
                        const mc = t.minimum_commitment!
                        const editKey = `min:${unitType}`
                        const audit = findAudit('minimum_commitment', unitType)
                        return (
                          <div key={unitType} className="rounded-xl p-4" style={{ background: '#F6FAF4', border: '1px solid rgba(74,124,89,0.2)' }}>
                            <p className="text-[9px] font-bold uppercase tracking-widest text-stone/60 mb-1">{modeLabel[mc.mode] ?? mc.mode}</p>
                            <p className="text-lg font-semibold text-ink mb-1">
                              {fmt(mc.amount, cur)}{ruleCadenceLabel(mc.period, t.reset_anchor) ? ` / ${ruleCadenceLabel(mc.period, t.reset_anchor)}` : ''}
                            </p>
                            <p className="text-[11px] text-stone">Applies to: <span className="font-medium text-ink">{unitType}</span></p>
                            {mc.mode === 'additive' ? (
                              // An additive fee isn't itself "before/after the allowance" —
                              // it's charged regardless of usage; the allowance only affects
                              // whether the usage portion of the bill is zero or not. Stating
                              // it as an allowance-interaction reads as if the fee's timing
                              // depended on the allowance, which it doesn't.
                              <p className="text-[11px] text-stone">
                                Treatment: <span className="font-medium text-ink">
                                  {fmt(mc.amount, cur)} added to the {t.measurement_period ?? ''} {unitType} usage charge, independent of the included allowance
                                </span>
                              </p>
                            ) : (() => {
                              // Plain business language, not the raw enum — "after allowance"
                              // exposes an internal field name rather than saying what it
                              // means for billing. Reuses the metric's own $0-rate tier
                              // (not a separate calculation) for the included-unit count.
                              // Gated on the allowance tier actually EXISTING, not just on
                              // included_allowance_interaction being truthy — extraction can
                              // leave that enum at "unclear" purely as a leftover from a
                              // conflated ambiguity flag even when this metric has no
                              // allowance at all, which must never render as a live question.
                              const freeTier = tiers.find(ft => ft.unit_type === unitType && (ft.rate_per_unit ?? 0) === 0)
                              if (!freeTier || !mc.included_allowance_interaction) return null
                              const includedCount = freeTier.to_unit
                              const interaction = mc.included_allowance_interaction
                              const text = interaction === 'unclear'
                                ? "Needs confirmation — the contract doesn't state whether the minimum applies before or after the included allowance."
                                : interaction === 'before_allowance'
                                  ? `The minimum applies to all usage, including the ${includedCount != null ? `first ${includedCount.toLocaleString()} ` : ''}included units.`
                                  : includedCount != null
                                    ? `First ${includedCount.toLocaleString()} ${unitType} included before minimum evaluation.`
                                    : 'The included allowance is applied before the minimum is evaluated.'
                              return (
                                <p className="text-[11px] text-stone">Allowance treatment: <span className="font-medium text-ink">{text}</span></p>
                              )
                            })()}
                            {/* Two separately-labeled statuses, never one blanket "Confirmed"
                                — "Core minimum rule: Confirmed" describes ONLY mode/amount/
                                period/allowance (what isMinimumCommitmentModeUnresolved
                                actually checks). Partial-period policy is a genuinely separate
                                question with its own status line immediately below, so
                                "Confirmed" here can never be misread as "this rule is fully
                                billing-ready" while a partial-period decision is still open. */}
                            <p className="text-[10px] text-stone/60 mt-2">
                              Core minimum rule: <span className="font-medium" style={{ color: '#0B5C36' }}>{audit ? 'Confirmed' : 'Clear from source'}</span>
                              {audit && <> by {audit.reviewer_name ?? audit.reviewer_email} · {fmtDate(audit.created_at)}</>}
                            </p>
                            {/* Partial-quarter (etc.) treatment is only a live question under
                                calendar anchoring — contract_start anchoring never produces a
                                partial window at all, so this line only appears when it can
                                actually matter (mirrors computePartialPeriodMetrics exactly). */}
                            {t.reset_anchor === 'calendar' && (
                              mc.prorate_partial_periods === 'unclear' ? (
                                <div className="mt-1 flex items-center justify-between gap-2">
                                  <p className="text-[11px] text-amber-700">
                                    <i className="ti ti-alert-triangle mr-1" style={{ fontSize: 10 }} />
                                    Partial-period policy: Decision required
                                  </p>
                                  <button onClick={() => setEditingRule(`partial:${unitType}`)} className="text-[11px] font-semibold px-2.5 py-1 rounded-lg flex-shrink-0" style={{ background: '#1A3D2B', color: 'white' }}>Resolve</button>
                                </div>
                              ) : (
                                <p className="text-[11px] text-stone mt-1">
                                  Partial-period policy: <span className="font-medium text-ink">{mc.prorate_partial_periods === true ? 'Prorated' : 'Full amount charged'}</span>
                                </p>
                              )
                            )}
                            <div className="flex items-center gap-3 mt-2">
                              {src.overage_tiers && (
                                <button onClick={() => openPDF(src.overage_tiers)} className="text-[11px] font-medium text-forest hover:underline">View source ↗</button>
                              )}
                              <button onClick={() => setEditingRule(editKey)} className="text-[11px] font-medium text-stone hover:text-ink">Edit interpretation</button>
                            </div>
                          </div>
                        )
                      })}
                      {confirmedEscalators.map((e, i) => {
                        const editKey = `esc:${i}`
                        const audit = findAudit('escalator', null)
                        // treatment is an explicit reviewer decision, not inferred
                        // from empty fields — 'not_applied' means "confirmed: this
                        // clause does not run," never shown alongside contradictory
                        // "unresolved"/"pending" language the way the old heuristic
                        // (guessing from empty index/cap) sometimes did.
                        const notApplied = e.interpretation!.treatment === 'not_applied'
                        // What the extraction found is preserved and shown even
                        // when the reviewer excluded it — Verdix keeps what the
                        // agreement contained distinct from what actually runs.
                        const sourceTerm = e.escalator_type
                          ? `${e.escalator_type.replace(/_/g, ' ').replace(/\bcpi\b/i, 'CPI')}-linked escalation detected`
                          : e.description || null
                        return (
                          <div key={i} className="rounded-xl p-4" style={{ background: '#F6FAF4', border: '1px solid rgba(74,124,89,0.2)' }}>
                            <p className="text-[9px] font-bold uppercase tracking-widest text-stone/60 mb-1">Price escalation</p>
                            {notApplied ? (
                              <>
                                {sourceTerm && (
                                  <p className="text-[11px] text-stone">Source term: <span className="font-medium text-ink">{sourceTerm}</span></p>
                                )}
                                <p className="text-lg font-semibold text-ink mb-1 mt-1">Operational treatment: Not applied</p>
                                <p className="text-[11px] text-stone">Reviewer decision: exclude the escalation clause.</p>
                              </>
                            ) : (
                              <>
                                <p className="text-lg font-semibold text-ink mb-1">
                                  {e.interpretation!.index}{e.interpretation!.cap_pct != null ? `, capped ${e.interpretation!.cap_pct}%` : e.interpretation!.index !== 'other' ? ', uncapped' : ''}
                                </p>
                                <p className="text-[11px] text-stone">{e.interpretation!.calculation_method}</p>
                                <p className="text-[11px] text-stone">Frequency: <span className="font-medium text-ink">{e.interpretation!.frequency}</span></p>
                                {e.interpretation!.effective_date && (
                                  <p className="text-[11px] text-stone">Effective: <span className="font-medium text-ink">{fmtDate(e.interpretation!.effective_date)}</span></p>
                                )}
                              </>
                            )}
                            <p className="text-[10px] text-stone/60 mt-2">
                              Status: <span className="font-medium" style={{ color: '#0B5C36' }}>Confirmed</span>
                              {audit && <> by {audit.reviewer_name ?? audit.reviewer_email} · {fmtDate(audit.created_at)}</>}
                            </p>
                            <div className="flex items-center gap-3 mt-2">
                              {src.escalators && (
                                <button onClick={() => openPDF(src.escalators)} className="text-[11px] font-medium text-forest hover:underline">View source ↗</button>
                              )}
                              <button onClick={() => setEditingRule(editKey)} className="text-[11px] font-medium text-stone hover:text-ink">Edit interpretation</button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })()}

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
                  {/* Tier/volume structure interpretation, per discount — "before/
                      after usage tiers" alone can't distinguish a staircase from a
                      volume schedule, and each discount is resolved independently
                      (a contract can have several: onboarding, volume, reseller...),
                      never bundled into a single "primary discount" interpretation. */}
                  <div className="mt-4 pt-4 space-y-3" style={{ borderTop: '1px solid rgba(26,61,43,0.07)' }}>
                    {terms!.discounts!.map((d, i) => {
                      const discountId = d.discount_rule_id ?? String(i)
                      const editKey = `disc:${discountId}`
                      const interp = d.interpretation
                      const label = d.description || d.applies_to || `Discount ${i + 1}`
                      if (interp && !interp.requires_confirmation) {
                        return (
                          <div key={discountId} className="flex items-start justify-between gap-4">
                            <div className="text-[11px] text-stone space-y-0.5 min-w-0">
                              <p className="font-medium text-ink truncate">{label}</p>
                              {interp.tier_method && (
                                <p>Tier method: <span className="font-medium text-ink">{TIER_METHOD_DISPLAY[interp.tier_method] ?? interp.tier_method}</span></p>
                              )}
                              {interp.worked_example && <p className="text-stone/80 italic">{interp.worked_example}</p>}
                            </div>
                            <button onClick={() => setEditingRule(editKey)} className="text-[11px] font-medium text-stone hover:text-ink flex-shrink-0">Edit interpretation</button>
                          </div>
                        )
                      }
                      return (
                        <div key={discountId} className="flex items-center justify-between gap-4">
                          <p className="text-[11px] text-amber-700 min-w-0">
                            <i className="ti ti-alert-triangle mr-1" style={{ fontSize: 11 }} />
                            <span className="font-medium">{label}</span> — structure not yet interpreted; &quot;applies to&quot; alone can&apos;t tell a staircase from a volume schedule.
                          </p>
                          <button onClick={() => setEditingRule(editKey)} className="text-[11px] font-semibold px-3 py-1.5 rounded-lg flex-shrink-0" style={{ background: '#1A3D2B', color: 'white' }}>
                            Resolve interpretation
                          </button>
                        </div>
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
                    {Array.from(chargingGroups.entries()).map(([unitType, tierList]) => {
                      const paidTiers = tierList.filter(({ tier: t }) => (t.rate_per_unit ?? 0) > 0)
                      const tierCalc = tierList.find(({ tier: t }) => t.tier_calculation)?.tier.tier_calculation
                      // Only a metric with 2+ paid tiers has a graduated-vs-volume
                      // distinction to resolve at all — a single flat rate has
                      // nothing to disambiguate.
                      const needsTierMethod = paidTiers.length >= 2
                      const tierMethodResolved = !!tierCalc && !tierCalc.requires_confirmation
                      const cadence = tierList.find(({ tier: t }) => t.measurement_period)?.tier.measurement_period ?? 'billing period'
                      return (
                      <div key={unitType}>
                        <div className="flex items-center justify-between mb-1">
                          <p className="text-[10px] font-semibold text-stone uppercase tracking-[0.12em] capitalize">{unitType}</p>
                          {needsTierMethod && tierMethodResolved && (
                            <button onClick={() => setEditingRule(`tier:${unitType}`)} className="text-[10px] font-medium text-stone hover:text-ink">
                              Calculation: <span className="font-semibold text-ink">{TIER_METHOD_DISPLAY[tierCalc!.method] ?? tierCalc!.method}</span>
                            </button>
                          )}
                        </div>
                        {/* "Volume / all-units" alone reads ambiguously next
                            to a per-band rate table — spell out the actual
                            semantics so it can't be misread as progressive. */}
                        {needsTierMethod && tierMethodResolved && tierCalc!.method === 'volume' && (
                          <p className="text-[10px] text-stone/60 mb-2 -mt-0.5">
                            The rate corresponding to total monthly transaction volume applies to all transactions in that calendar month; tiers are not progressive.
                          </p>
                        )}
                        {/* The tier structure itself (e.g. the 1–500 included allowance below)
                            is not what's uncertain here — it's HOW the paid bands are evaluated
                            once usage spans more than one of them. A bare "Needs interpretation"
                            chip sitting above the tier rows reads as if the allowance were in
                            question, so this names the actual ambiguity explicitly instead. */}
                        {needsTierMethod && !tierMethodResolved && (
                          <div className="mb-3 rounded-lg p-2.5 flex items-center justify-between gap-3" style={{ background: '#FEF3C7' }}>
                            <div>
                              <p className="text-[10px] font-semibold" style={{ color: '#92400E' }}>{unitType} tier calculation method · Needs interpretation</p>
                              <p className="text-[10px] mt-0.5" style={{ color: '#92400E' }}>
                                Confirm whether rates apply progressively by tier, or whether total {cadence} volume selects one rate for all units.
                              </p>
                            </div>
                            <button onClick={() => setEditingRule(`tier:${unitType}`)} className="text-[10px] font-semibold px-2.5 py-1 rounded-lg flex-shrink-0" style={{ background: '#1A3D2B', color: 'white' }}>
                              Resolve
                            </button>
                          </div>
                        )}
                        {!(needsTierMethod && !tierMethodResolved) && <div className="mb-2" />}
                        <div className="grid grid-cols-3 gap-8">
                          {tierList.map(({ tier: t, origIdx }) => {
                            const isEditingTier = tierEditing === origIdx
                            const fmtRate = (r: number) => fmtUnit(r, cur)
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
                      )
                    })}
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
                      // The reviewer's confirmed decision governs what actually
                      // runs (see the Confirmed rules card above) — when that
                      // decision was "not applied", this raw extracted row must
                      // never look like an active billing parameter, since
                      // nothing here re-checks the confirmed state on its own.
                      const confirmedInactive = e.interpretation?.treatment === 'not_applied' && !e.interpretation.requires_confirmation
                      return (
                        <div key={i} className="rounded-xl p-4 transition-all"
                          style={isEditing ? { background: '#FFFBEB', border: '1px solid #F59E0B' } : confirmedInactive ? { background: '#FAFAF9', opacity: 0.6 } : { background: 'transparent' }}>
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-1.5">
                              <p className="text-[10px] font-semibold text-stone uppercase tracking-[0.12em]">{label}</p>
                              {confirmedInactive && (
                                <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full uppercase tracking-wide" style={{ background: '#F5F5F4', color: '#78716C' }}>
                                  Source extraction · inactive
                                </span>
                              )}
                            </div>
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
                      {hasUnresolvedTierCalculation ? 'Fixed fees configured in' : 'Configured in'} {billingPlatform === 'remembill' ? 'Remembill' : billingPlatform === 'chargebee' ? 'Chargebee' : 'Stripe'}
                    </span>
                  )}
                </div>
              </div>

              {items.length > 0 && (() => {
                const platformLabel = billingPlatform === 'remembill' ? 'Remembill' : billingPlatform === 'chargebee' ? 'Chargebee' : 'Stripe'
                const periodOptions = ['monthly', 'quarterly', 'semi-annual', 'annual', 'one_time']
                const editCellStyle = 'w-full text-right bg-transparent border-0 border-b border-forest/30 focus:outline-none focus:border-forest text-[12px] tabular-nums py-0 px-0'

                // Fixed line items / Variable pricing are visually separated —
                // a usage tier's Qty 0 / Total 0.00 reads as "nothing is
                // configured" when shown inline with real fixed fees, but is
                // exactly what an unconsumed pricing rule should look like on
                // its own. Same rows, same editing behavior, grouped order only.
                const groupOf = (item: LineItem): 'Variable pricing' | 'Fixed line items' => {
                  // Every tariff-tier row (any metric, resolved or not)
                  // classifies as 'overage_tier' now — classifyItem no longer
                  // has separate minimum_commitment/partial_period/
                  // tier_calculation branches to also check for.
                  const k = classifyItem(item, terms?.escalators ?? [])
                  return k === 'overage_tier' ? 'Variable pricing' : 'Fixed line items'
                }
                const groupOrder = ['Fixed line items', 'Variable pricing'] as const
                const orderedItems = groupOrder.flatMap(g => items.filter(i => groupOf(i) === g))
                let lastGroup: string | null = null

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
                        {orderedItems.map(item => {
                          // Classified once, with the real escalators/partial-period
                          // context — calling classifyItem(item) bare here previously
                          // meant an unresolved CPI escalator could never be told apart
                          // from a resolved one, so its Total column silently rendered
                          // the raw (often 0) total_amount as "0%" instead of flagging
                          // that no rate exists yet.
                          const rowKind = classifyItem(item, terms?.escalators ?? [])
                          const isEscalator = rowKind === 'escalator'
                          const isEscalatorUnresolved = rowKind === 'escalator_interpretation'
                          const isVariableTier = rowKind === 'overage_tier'
                          // A metric whose tier method (graduated/volume/block) isn't
                          // confirmed has no single safe Total to show — the same
                          // rate table can legitimately produce different totals
                          // under each method (see lib/tariff.ts) — real invoicing
                          // already refuses to bill it (lib/usage-pull.ts). Computed
                          // directly from the tiers now (classifyItem no longer
                          // decides tier_calculation — see isTierCalculationUnresolvedFor).
                          const isTierCalcUnresolved = isTierCalculationUnresolvedFor(findTierForItem(item, tiers)?.unit_type, tiers)
                          const isVariable  = rowKind === 'one_time' && item.total_amount === 0
                          // A reviewer's explicit "do not apply this escalator"
                          // decision must never render as "0%", which reads as a
                          // real configured rate rather than a deliberate exclusion.
                          const escalatorNotApplied = isEscalator && (terms?.escalators ?? []).some(e => e.interpretation?.treatment === 'not_applied')
                          // Both resolved and unresolved escalators get the same
                          // non-editable-numeric-cell treatment (Qty/Unit price are
                          // meaningless for a % rate either way) — only the Total
                          // column's text differs between them.
                          const isEscalatorLike = isEscalator || isEscalatorUnresolved
                          const group = groupOf(item)
                          const showGroupHeader = group !== lastGroup
                          lastGroup = group
                          return (
                          <Fragment key={item.id}>
                          {showGroupHeader && (
                            <tr>
                              <td colSpan={5} className="pt-4 pb-1.5 text-[9px] font-bold text-stone/50 uppercase tracking-[0.14em]">{group}</td>
                            </tr>
                          )}
                          <tr style={{ borderBottom: '1px solid rgba(26,61,43,0.05)' }}>
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
                              {!isEscalatorLike && billingEdit?.itemId === item.id && billingEdit.field === 'quantity' ? (
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
                                  className={isEscalatorLike ? '' : 'cursor-pointer hover:text-forest transition-colors'}
                                  title={isEscalatorLike ? undefined : 'Click to edit'}
                                  onClick={() => !isEscalatorLike && setBillingEdit({ itemId: item.id, field: 'quantity', value: String(item.quantity) })}
                                >{isVariableTier && item.quantity === 0 ? <span className="text-stone/40">—</span> : item.quantity}</span>
                              )}
                            </td>

                            {/* Unit price — editable */}
                            <td className="py-2.5 pr-4 text-[12px] text-stone text-right" style={{ fontVariantNumeric: 'tabular-nums', minWidth: 96 }}>
                              {isEscalatorLike ? (
                                <span>
                                  {isEscalatorUnresolved
                                    ? <span className="text-amber-600">Pending interpretation</span>
                                    : escalatorNotApplied
                                      ? <span className="text-stone/50">Not applied</span>
                                      : item.unit_price != null ? `${item.unit_price}%` : '—'}
                                </span>
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
                                    if (rowKind === 'one_time' && item.unit_price === 0) {
                                      const termFee = allFees.find(f => f.fee_label === item.product_name)
                                      if (termFee?.manual_trigger && termFee.rate_per_unit) {
                                        setBillingEdit({ itemId: item.id, field: 'unit_price', value: String(termFee.rate_per_unit) })
                                        return
                                      }
                                    }
                                    setBillingEdit({ itemId: item.id, field: 'unit_price', value: String(item.unit_price) })
                                  }}
                                >
                                  {rowKind === 'one_time' && item.unit_price === 0 ? (() => {
                                    const termFee = allFees.find(f => f.fee_label === item.product_name)
                                    if (termFee?.manual_trigger && termFee.rate_per_unit) {
                                      return <span>{fmt(termFee.rate_per_unit, cur)}<span className="text-stone/60">/{termFee.metric_name ?? 'unit'}</span></span>
                                    }
                                    return fmtUnit(item.unit_price, cur)
                                  })() : fmtUnit(item.unit_price, cur)}
                                </span>
                              )}
                            </td>

                            {/* Total — calculated, read-only. A variable-pricing tier
                                with no usage yet is a pricing rule waiting to be
                                consumed, not an invoice line for SEK 0 — showing the
                                raw total here previously read as "nothing configured". */}
                            <td className="py-2.5 pr-4 text-[12px] font-medium text-ink text-right" style={{ fontVariantNumeric: 'tabular-nums' }}>
                              {isEscalatorUnresolved
                                ? <span className="text-amber-600 font-normal text-[11px]">Pending interpretation</span>
                                : escalatorNotApplied
                                  ? <span className="text-stone/50 font-normal text-[11px]">Not applied</span>
                                  : isEscalator
                                    ? <span>{item.total_amount != null ? `${item.total_amount}%` : '—'}</span>
                                    : isTierCalcUnresolved
                                    ? <span className="text-amber-600 font-normal text-[11px]">Pending interpretation</span>
                                    : isVariable
                                    ? <span className="text-amber-600 font-normal text-[11px]">Variable — on delivery</span>
                                    : isVariableTier && item.quantity === 0
                                      ? <span className="text-stone/50 font-normal text-[11px]">Usage-based — not yet billed</span>
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
                          </Fragment>
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

                  {/* Commercial rules — pricing tiers and minimum/escalator
                      rules are configuration, not usage actuals, so they're
                      never represented as an ordinary qty × unit-price row.
                      Same confirmed-rule data as the Commercial Terms section. */}
                  {(() => {
                    const confirmed = tiers.filter(t => t.unit_type && t.minimum_commitment && !t.minimum_commitment.requires_confirmation)
                    const seen = new Set<string>()
                    const rules = confirmed.filter(t => t.unit_type && !seen.has(t.unit_type) && seen.add(t.unit_type))
                    if (rules.length === 0) return null
                    return (
                      <div className="mt-5 pt-4" style={{ borderTop: '1px solid rgba(26,61,43,0.07)' }}>
                        <p className="text-[9px] font-bold text-stone/50 uppercase tracking-[0.14em] mb-2">Commercial rules</p>
                        <div className="flex flex-wrap gap-2">
                          {rules.map(t => (
                            <span key={t.unit_type} className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full"
                              style={{ background: '#F6FAF4', color: '#0B5C36', border: '1px solid rgba(74,124,89,0.25)' }}>
                              <i className="ti ti-shield-check" style={{ fontSize: 11 }} />
                              {t.unit_type} · {fmt(t.minimum_commitment!.amount, cur)} {ruleModeShortLabel(t.minimum_commitment!.mode)}{ruleCadenceLabel(t.minimum_commitment!.period, t.reset_anchor) ? ` / ${ruleCadenceLabel(t.minimum_commitment!.period, t.reset_anchor)}` : ''} · Confirmed
                            </span>
                          ))}
                        </div>
                      </div>
                    )
                  })()}

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
                 Resolved from the Review panel (the single place a mapping
                 is actually confirmed/changed — see ReviewPanel's
                 MeterMappingPanel mount below). This is a glanceable,
                 read-only status chip on the main Commercial GUI, not a
                 second editable panel — two independent full MeterMappingPanel
                 mounts here previously meant two independent fetches and two
                 independent confirm actions for the same underlying data. */}
            {tiers.length > 0 && (
              <MeterMappingStatusChip
                total={meterMappingSummary.total}
                confirmed={meterMappingSummary.confirmed}
                onClick={() => setReviewPanelOpen(true)}
              />
            )}

            {/* ── Consolidated commercial-rule confirmation summary ──
                 Never implies the contract is fully reviewed while any
                 dependency (a minimum commitment, a tier-calculation method,
                 escalation, a discount, a service credit, a rule interaction,
                 or a usage meter) is still unresolved — this only renders
                 once every one of those is actually confirmed, per the single
                 shared lib/commercial-rule-status.ts workload computation
                 (previously this gate never checked discounts/service
                 credits/interactions at all, so it could show "confirmed"
                 with an unresolved introductory discount). */}
            {(() => {
              const escalator = terms?.escalators?.[0]
              const escalatorInterp = escalator?.interpretation
              if (commercialRuleWorkload.status !== 'all_commercial_rules_confirmed') return null

              const modeLabel: Record<string, string> = {
                floor: 'minimum floor', additive: 'additive fee', minimum_spend: 'spend commitment',
                prepaid_commitment: 'prepaid commitment', minimum_quantity: 'minimum quantity',
              }
              const confirmedRuleLines: { label: string; value: string }[] = []
              for (const [unitType, tierList] of chargingGroups.entries()) {
                const mc = tierList.find(({ tier: t }) => t.minimum_commitment)?.tier.minimum_commitment
                if (!mc) continue
                confirmedRuleLines.push({
                  label: 'Minimum rule',
                  value: `${fmt(mc.amount, cur)} ${ruleCadenceLabel(mc.period, tierList[0]?.tier.reset_anchor) ?? ''} ${modeLabel[mc.mode] ?? mc.mode} · ${unitType}`.trim(),
                })
                if (mc.prorate_partial_periods !== undefined && tierList[0]?.tier.reset_anchor === 'calendar') {
                  confirmedRuleLines.push({
                    label: 'Partial-period treatment',
                    value: mc.prorate_partial_periods === true ? 'Prorated by days' : mc.prorate_partial_periods === false ? 'Full amount charged' : 'Not applicable',
                  })
                }
                const tierCalc = tierList.find(({ tier: t }) => t.tier_calculation)?.tier.tier_calculation
                if (tierCalc) {
                  confirmedRuleLines.push({ label: 'Tier calculation', value: TIER_METHOD_DISPLAY[tierCalc.method] ?? tierCalc.method })
                }
              }
              confirmedRuleLines.push({
                label: 'Escalation',
                value: !escalator ? 'None in contract' : escalatorInterp!.treatment === 'not_applied' ? 'Not applied' : (escalatorInterp!.index ?? 'Applies'),
              })
              for (const d of terms?.discounts ?? []) {
                if (!d.interpretation) continue
                confirmedRuleLines.push({ label: 'Discount', value: d.description || d.applies_to || d.interpretation.discount_type })
              }
              for (const c of terms?.service_credits ?? []) {
                if (!c.interpretation) continue
                confirmedRuleLines.push({ label: 'Service credit', value: c.description || c.interpretation.credit_basis })
              }
              if (tiers.length > 0) {
                confirmedRuleLines.push({ label: 'Usage meter', value: 'Confirmed' })
              }

              // This banner reports ONE specific thing — every rule
              // interpretation (minimum floors, tier methods, escalation,
              // discounts, service credits, rule interactions) and usage
              // meter has a reviewer decision on file. It deliberately does
              // NOT claim the contract is ready to push: VAT and the
              // billing-schedule dates are separate readiness checks with
              // their own gates (see the VAT row and Approve button below),
              // and are called out here by name rather than folded
              // silently into one blanket "confirmed" claim — a reviewer
              // seeing this banner while VAT is still unset previously had
              // no way to tell the two apart.
              const billingReady = vatConfigured === true
              return (
                <div className="bg-white rounded-2xl border px-7 py-5" style={{ borderColor: 'rgba(11,92,54,0.2)', background: '#F8FDF9' }}>
                  <p className="text-sm font-semibold flex items-center gap-1.5 mb-1" style={{ color: '#0B5C36' }}>
                    <i className="ti ti-circle-check-filled" style={{ fontSize: 15 }} /> Rule interpretations confirmed
                  </p>
                  <p className="text-[11px] text-stone mb-3">
                    Every minimum floor, tier method, escalator, discount, service credit, rule interaction, and usage meter has a reviewer decision on file.
                  </p>
                  <div className="grid gap-x-8 gap-y-1.5 text-[12px]" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
                    {confirmedRuleLines.map((line, i) => (
                      <p key={i}><span className="text-stone">{line.label}:</span> <span className="font-medium text-ink">{line.value}</span></p>
                    ))}
                  </div>
                  <div className="mt-3 pt-3 flex items-center gap-1.5" style={{ borderTop: '1px solid rgba(11,92,54,0.12)' }}>
                    <i className={`ti ${billingReady ? 'ti-circle-check-filled' : 'ti-alert-triangle'}`} style={{ fontSize: 13, color: billingReady ? '#0B5C36' : '#D97706' }} />
                    <p className="text-[11px] font-medium" style={{ color: billingReady ? '#0B5C36' : '#92400E' }}>
                      {billingReady ? 'Billing readiness: ready to push' : 'Billing readiness: VAT treatment still required before push'}
                    </p>
                  </div>
                </div>
              )
            })()}

            {/* ── VAT (pre-approval) ── Surfaced here, not only after push,
                 so it can actually block Approve rather than only failing
                 closed server-side after the reviewer has already clicked
                 it. Staged on the job itself (pending_vat_*) until a real
                 billing customer exists; promoted into customer_vat_config
                 at approve time. BillingSummaryCard renders the same
                 component post-approval, reading/writing the real
                 customer_vat_config row directly — never both at once. */}
            {!isConfigured && (
              <div className="bg-white rounded-2xl border border-forest/10 overflow-hidden">
                <VatConfigRow jobId={id} onStatusChange={setVatConfigured} refreshSignal={refreshSignal} onSaved={handleVatSaved} />
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
                    {/* Never shown as a final authoritative total while the
                        dates it depends on are unresolved — computeBaseTcv
                        multiplies each line item's rate by a period count
                        derived from contract_start_date/contract_end_date/
                        contract_term_months, so a total computed before
                        those were known (or surviving in state from before
                        they were cleared) must not be presented as if it
                        were final. This is what previously let "24 ×
                        38,500 = 924,000" show at the same time as "dates
                        are missing" below. */}
                    {(() => {
                      const datesResolved = !!terms?.contract_start_date && (!!terms?.contract_end_date || !!terms?.contract_term_months)
                      return (
                        <p className="text-[36px] font-semibold leading-none text-ink" style={{ fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em' }}>
                          {tcv > 0 && datesResolved
                            ? fmt(tcv, cur)
                            : billingModel === 'consumption'
                              ? <span className="text-[22px] text-stone/60">Usage-based</span>
                              : <span className="text-stone/30">—</span>}
                        </p>
                      )
                    })()}
                    {tcv === 0 && billingModel === 'consumption' && terms?.contract_start_date && terms?.contract_end_date && (
                      <p className="text-[10px] text-stone/40 mt-2">Fixed fees depend on usage volume</p>
                    )}
                    {tcv > 0 && (!terms?.contract_start_date || (!terms?.contract_end_date && !terms?.contract_term_months)) && (
                      <p className="text-[10px] text-amber-600 mt-2">Contract dates unresolved — fixed-fee total withheld until confirmed above</p>
                    )}
                    {/* Distinct from the dates check above: the CONTRACTUAL
                        value (rate × period count) is real and known even
                        while partial-period treatment is unresolved — it
                        just doesn't establish that the GENERATED billing
                        schedule (which periods, and at what amount, actually
                        get invoiced) is final. Shown as a caveat alongside
                        the figure, not a withholding of it, unlike dates. */}
                    {tcv > 0 && !!terms?.contract_start_date && (!!terms?.contract_end_date || !!terms?.contract_term_months) &&
                      (!!terms?.base_fee_proration?.requires_confirmation || (terms?.additional_recurring_fees ?? []).some(f => f.proration?.requires_confirmation)) && (
                      <p className="text-[10px] text-amber-600 mt-2">Partial-period billing treatment not yet confirmed — the generated invoice schedule is not final</p>
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
                  // Unresolved commercial rules (minimum floors, tier
                  // calculation methods, escalators, discounts, service
                  // credits, rule interactions), unconfigured usage mappings,
                  // and unconfigured VAT must block Approve exactly like the
                  // server-side check in app/api/jobs/[id]/approve/route.ts
                  // — this is the client-side mirror of that gate, not a
                  // substitute for it. needsReview (confidence-only) alone
                  // previously let a fully-ambiguous but confidently-worded
                  // contract like TEST-PAY-002 show as pushable. Reads the
                  // same totalOutstanding/readinessBreakdown the top callout
                  // and meter-mapping chip use, so this can't disagree with
                  // either of them.
                  const blocked = approving || totalOutstanding > 0 || vatConfigured === undefined
                    || scheduleBlockers.length > 0 || needsPlatformChoice
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
                    {scheduleBlockers.length > 0 && (
                      <p className="text-[10px] text-amber-600 text-right max-w-[220px]">
                        Billing schedule needs: {scheduleBlockers.join(', ')}
                      </p>
                    )}
                    {/* Single unified hint — same breakdown as the top
                        callout and the meter-mapping chip, so this never
                        shows a different outstanding count than either. */}
                    {totalOutstanding > 0 && (
                      <button onClick={() => setReviewPanelOpen(true)} className="text-[10px] text-amber-600 underline underline-offset-2 hover:text-amber-700 text-right max-w-[220px]">
                        {readinessBreakdown.join(' · ')}
                      </button>
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
          // Full, unfiltered list — a metric-scoped ambiguity (minimum
          // commitment, tier calculation, partial-period treatment) is
          // driven by overageTiers' own requires_confirmation flags, not by
          // extraction confidence, and needs an anchor item to render under
          // regardless of how confidently that item's own VALUE was
          // extracted. A contract can state SEK 1.05/unit completely
          // unambiguously (high confidence) while still leaving open
          // whether an attached minimum floor prorates for a partial month
          // (a genuine business-rule question extraction confidence says
          // nothing about) — filtering by confidence here used to hide
          // that card entirely whenever every line item for the metric
          // happened to be high-confidence, which is the common case for a
          // clearly-worded contract. The plain (non-metric) per-item
          // confirm-card path still gates on confidence itself, just below.
          items={items}
          corrections={corrections}
          onCorrect={(itemId, value) => setCorr(itemId, value)}
          onClose={() => setReviewPanelOpen(false)}
          onRefresh={() => { fetchJob(); fetchRuleInterpretations() }}
          jobId={id}
          overageTiers={terms?.overage_tiers}
          escalators={terms?.escalators}
          discounts={terms?.discounts}
          serviceCredits={terms?.service_credits}
          baseFeeAmount={terms?.base_monthly_fee ?? terms?.base_annual_fee ?? null}
          baseFeeProration={terms?.base_fee_proration}
          additionalRecurringFees={terms?.additional_recurring_fees}
          extractionNotes={terms?.extraction_notes}
          contractStartDate={terms?.contract_start_date}
          contractEndDate={terms?.contract_end_date}
          numberFormat={terms?.number_format ?? 'dot'}
          onViewSource={openPDF}
          cur={cur}
          isConfigured={isConfigured}
          contractBillingFrequency={terms?.billing_frequency ?? null}
          onMeterMappingsConfirmedChange={handleMeterMappingsConfirmedChange}
          onVatStatusChange={setVatConfigured}
          onVatSaved={handleVatSaved}
          refreshSignal={refreshSignal}
        />
      )}

      {/* ── Edit commercial rule drawer ────────────────────────────────────
           Editing an already-confirmed rule from the main Commercial Terms
           view — a distinct experience from first-time review, not a return
           trip to the Review panel (see EditCommercialRuleDrawer above). */}
      {editingRule && (() => {
        const isMin = editingRule.startsWith('min:')
        const isTier = editingRule.startsWith('tier:')
        const isPartial = editingRule.startsWith('partial:')
        const isDiscount = editingRule.startsWith('disc:')
        const ruleType: RuleType = isMin ? 'minimum_commitment' : isTier ? 'tier_calculation' : isPartial ? 'partial_period' : isDiscount ? 'discount' : 'escalator'
        const unitType = isMin ? editingRule.slice(4) : isTier ? editingRule.slice(5) : isPartial ? editingRule.slice(8) : undefined
        const discountId = isDiscount ? editingRule.slice(5) : undefined
        // Discounts address their audit history via a synthetic
        // 'discount:{id}' key in contract_unit_type (see confirm-rule) —
        // reuses the column rather than needing a dedicated one.
        const auditUnitKey = isDiscount ? `discount:${discountId}` : (unitType ?? null)
        const records = ruleInterpretations.filter(r => r.rule_type === ruleType && r.contract_unit_type === auditUnitKey)
        const currentRecord = records.find(r => r.is_current) ?? null
        const historyRecords = records.filter(r => !r.is_current).sort((a, b) => b.revision_number - a.revision_number)
        const minCadence = unitType ? tiers.find(t => t.unit_type === unitType)?.minimum_commitment?.period : null
        const partialCadence = unitType ? tiers.find(t => t.unit_type === unitType)?.measurement_period : null
        const ruleTitle = isMin
          ? `${unitType} · ${minCadence ? minCadence.charAt(0).toUpperCase() + minCadence.slice(1) : ''} minimum`.replace('  ', ' ')
          : isTier ? `${unitType} · Tier calculation method`
          : isPartial ? `${unitType} · Partial-period treatment`
          : isDiscount ? 'Discount structure' : 'Price escalation'
        return (
          <EditCommercialRuleDrawer
            jobId={id}
            ruleType={ruleType}
            contractUnitType={unitType}
            discountId={discountId}
            cadenceLabel={cadenceNoun(partialCadence)}
            ruleTitle={ruleTitle}
            currency={cur}
            currentRecord={currentRecord}
            historyRecords={historyRecords}
            onClose={() => setEditingRule(null)}
            onApplied={() => { setEditingRule(null); fetchRuleInterpretations(); fetchJob() }}
          />
        )
      })()}

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
              {/* PDFViewer renders the document onto <canvas> for the
                  clause-highlighting overlay — there was no way to actually
                  save the file anywhere in this drawer (a canvas can't be
                  right-click-saved as a PDF). This links directly to the
                  same signed URL the viewer itself uses. */}
              {pdfUrl && !pdfUrlError && (
                <a
                  href={pdfUrl}
                  download
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-shrink-0 mr-1 text-stone hover:text-ink transition-colors w-7 h-7 flex items-center justify-center rounded-lg hover:bg-cream"
                  title="Download PDF"
                >
                  <i className="ti ti-download" style={{ fontSize: 14 }} />
                </a>
              )}
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
