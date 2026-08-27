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
import { computeBaseTcv, computeCommittedFixedFees, computeConditionalFixedFees, contractLifecycleStatus, type BaseTcvItem } from '@/lib/contract-tcv-calc'
import { resolveCommittedFixedFeeValue, type CommittedFixedFeeResolution } from '@/lib/committed-fixed-fee-resolver'
import { ruleCadenceLabel, cadenceNoun, contractMonthLabel, volumeTierCopy } from '@/lib/cadence-labels'
import { optionsForRuleType, optionsForEdit, deriveSelectedOption, baseFeeHasExpiringWaiver, discountHasUnresolvedComponentScope, CREDIT_SURVIVAL_OPTIONS, type RuleType, type StructuredOption, type RuleProposal, type DiscountScopeContext } from '@/lib/rule-interpretation'
import { detectRuleInteractionCandidates } from '@/lib/rule-interactions'
import { computeCommercialRuleWorkload, isMinimumCommitmentModeUnresolved, isMinimumCommitmentProrationUnresolved, isServiceCreditUnresolved, isDiscountUnresolved, countSourceConfirmations, isOneTimeFeeUnresolved, isProvenanceResolved, type CommercialRuleWorkload } from '@/lib/commercial-rule-status'
import { isMonetaryBasisRecognitionApplicable, isPaidBasisFinalizationApplicable } from '@/lib/paid-basis-finalization'
import { isMeterMappingResolved } from '@/lib/meter-mapping-status'
import { describeBillabilityCondition, isChangeOrderConditional, resolveOneTimeFeeTypeLabel } from '@/lib/billability-condition'
import { formatEligibleComponentsFact, formatCarryForwardFact, formatCashRedeemableFact, formatEarningBasisFact, computeExcludedFromEarningBasisKeys } from '@/lib/review-card-format'
import { getCreditRepresentationCapability } from '@/lib/connectors/billing/types'
import { FinancialAmount, FinancialMetaTag } from '@/app/_components/FinancialAmount'
import { FinancialKPICard } from '@/app/_components/FinancialKPICard'
import { StatusInline } from '@/app/_components/StatusChip'
import { BillingReconciliationPanel } from '@/app/_components/BillingReconciliationPanel'
import { describeMatchConditions, describeEffectivePeriod } from '@/lib/rulebook/organization-rulebook-display'
import { formatRenewalNoticePeriod } from '@/lib/contract-notice-period'
import type { OrganizationRuleRecord } from '@/lib/rulebook/organization-rules'

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
  // Step 17A hardening (review pass 6)/17B0, item B — typed component
  // targeting (see lib/types.ts's Discount.affected_components/
  // possibly_affected_components) — used to detect a genuinely open
  // hybrid-fee scope question and generate bounded scope options for it.
  affected_components?: string[] | null
  possibly_affected_components?: string[] | null
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
    credit_basis: 'pct_of_period_fee' | 'pct_of_affected_component' | 'fixed_amount_per_unit' | 'flat_amount' | 'usage_units'
    basis_component: string | null
    // 2026-08-30 correction — WHAT monetary state the percentage applies
    // to, independent of WHICH component (basis_component/computed_from_
    // component_keys). See lib/paid-basis-finalization.ts.
    monetary_basis_recognition?: 'paid' | 'component_amount' | 'unclear' | null
    monetary_basis_recognition_provenance?: 'contract_derived' | 'verdix_recommends' | 'reviewer_policy' | 'organization_rulebook' | null
    credit_value: number | null
    cap_amount: number | null
    cap_pct: number | null
    settlement_period: string | null
    cash_redeemable: boolean | 'unclear'
    cash_redeemable_provenance?: 'contract_derived' | 'verdix_recommends' | 'reviewer_policy' | null
    interaction_note?: string | null
    requires_confirmation: boolean
    confirmation_reason?: string | null
    // Independent gate on top of the main interpretation's own
    // requires_confirmation — a credit can be fully confirmed on
    // trigger/rate/cap while what it may reduce (and whether it carries
    // forward) remains a real, separate, unresolved decision the contract
    // never stated. See buildCreditApplicationRule (confirm-rule/route.ts).
    application_rule?: {
      // 2026-08-30 UI fix — WHAT a percentage credit's earning calculation
      // is computed FROM (lib/credit-ledger-service.ts's own field of the
      // same name), deliberately independent of eligible_component_keys
      // (WHAT it may later be applied against) — see lib/review-card-
      // format.ts's formatEarningBasisFact/computeExcludedFromEarningBasisKeys.
      computed_from_component_keys?: string[] | null
      eligible_component_keys: string[] | 'all' | null
      eligibility_provenance?: 'contract_derived' | 'verdix_recommends' | 'reviewer_policy' | null
      excluded_component_keys?: string[]
      carry_forward: boolean | 'unclear'
      one_time: boolean | 'unclear'
      // Step 5C — 'organization_rulebook' means an active, applicable
      // private Organization Rulebook policy filled this field, not the
      // contract or a reviewer directly. See lib/types.ts's FieldProvenance.
      survival_provenance?: 'contract_derived' | 'verdix_recommends' | 'reviewer_policy' | 'organization_rulebook' | null
      // Step 5C audit trail — only ever populated when survival_provenance
      // is 'organization_rulebook'. Informational only; never drives logic.
      survival_organization_rule_id?: string | null
      survival_organization_rule_version?: number | null
      expiry_periods?: number | null
      expiry_date?: string | null
      // Currently always 'next_period' at the data layer (lib/types.ts —
      // there is no same-period execution path at all yet); read here only
      // to display the Confirmed billing rules card's own "Application
      // timing" line independently of cash settlement.
      availability?: 'next_period'
      requires_confirmation: boolean
      confirmation_reason?: string | null
    } | null
    // 2026-08-24 audit — a THIRD independent gate, same discipline as
    // application_rule above: a credit can be fully confirmed on
    // trigger/rate/cap/application-scope while WHEN its paid monetary
    // basis is complete enough to freeze remains a real, separate,
    // unresolved decision. See lib/paid-basis-finalization.ts.
    earn_rule?: {
      finalization_deadline_days: number | null
      paid_basis_finalization_policy?: 'deadline_cutoff' | 'full_attribution' | null
      paid_basis_finalization_provenance?: 'contract_derived' | 'verdix_recommends' | 'reviewer_policy' | null
    } | null
  } | null
}
// Named aliases for the two nested shapes above — used by the Confirmed
// billing rules section's credit-card builders, which need to name these
// types in helper-function signatures rather than inline every time.
type ServiceCreditInterp = NonNullable<ServiceCredit['interpretation']>
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
  // Step 17B0, item G — the operational quantities this tier's surcharge
  // depends on (e.g. the raw usage count AND the contracted volume that
  // defines where the tier starts) — see lib/types.ts's OverageTier.
  required_operational_inputs?: string[] | null
}

type OneTimeFee = {
  fee_label: string; amount: number; due_date?: string | null; description?: string | null
  manual_trigger?: boolean; metric_name?: string | null; rate_per_unit?: number | null
  // Step 11 (+ amendments) — see lib/types.ts's OneTimeFee for the full
  // provenance/readiness discipline these drive. Same inline literal union
  // this page already uses for every other provenance field (e.g.
  // ServiceCreditInterpretation.cash_redeemable_provenance above), not an
  // imported FieldProvenance type — this page defines its own local
  // structural types throughout rather than importing from lib/types.ts.
  amount_provenance?: 'contract_derived' | 'verdix_recommends' | 'reviewer_policy' | null
  billability_provenance?: 'contract_derived' | 'verdix_recommends' | 'reviewer_policy' | null
  requires_confirmation?: boolean
  confirmation_reason?: string | null
  unresolved_kind?: 'needs_review' | 'unsupported_semantics'
  // Step 12 — see lib/types.ts's BillabilityCondition. Same
  // define-locally-not-imported convention as the provenance fields above.
  billability_condition?:
    | { kind: 'immediate' }
    | { kind: 'fixed_date'; date: string }
    | { kind: 'event'; event_type: 'contract_signature' | 'delivery' | 'customer_acceptance' | 'final_acceptance' | 'change_order_signature' }
    | null
  // Step 13 — stable subject identity for operational_event_evidence.
  fee_id?: string
}
type PeriodProrationRule = {
  reset_anchor: 'contract_start' | 'calendar' | null
  prorate_partial_periods: boolean | 'unclear'
  requires_confirmation: boolean
  confirmation_reason?: string | null
  source_clause?: string | null
}
type AdditionalRecurringFee = {
  fee_label: string; amount: number; description?: string | null
  billing_frequency?: 'monthly' | 'quarterly' | 'semi-annual' | 'annual' | null
  proration?: PeriodProrationRule | null
  // Step 17B0, item F/G — a per-unit/variable-rate fee (metric_name +
  // rate_per_unit) or a fee whose rate mechanism this shape cannot express
  // at all (unresolved_kind: 'unsupported_semantics' — e.g. a derived rate
  // formula/percentage schedule). See lib/types.ts's AdditionalRecurringFee.
  metric_name?: string | null
  rate_per_unit?: number | null
  required_operational_inputs?: string[] | null
  unresolved_kind?: 'unsupported_semantics' | null
  source_clause?: string | null
  derived_metric?: { metric_name: string; formula: string; raw_inputs: string[] } | null
}
type UnsupportedCommercialMechanism = {
  kind: string
  description: string
  source_clause?: string | null
  required_operational_inputs?: string[] | null
  execution_status: 'unsupported'
}

type Terms = {
  id?: string
  contract_id?: string
  crm_id?: string
  customer_name?: string; customer_address?: string; customer_email?: string | null; customer_org_number?: string | null; billing_contact?: string
  vendor_name?: string;   vendor_address?: string
  contract_start_date?: string; contract_end_date?: string; contract_term_months?: number
  auto_renews?: boolean; renewal_notice_days?: number; renewal_notice_months?: number | null; renewal_term_months?: number | null
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
  // Step 17B0, item F — commercial mechanisms extraction captured but
  // cannot execute yet (e.g. a rolling-average volume/band migration
  // rule) — must remain visible to the reviewer, never silently dropped.
  unsupported_commercial_mechanisms?: UnsupportedCommercialMechanism[]
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
  // Step 13 — real operational_event_evidence rows for this job, already
  // camelCased server-side (app/api/jobs/[id]/route.ts).
  operational_event_evidence?: OperationalEventEvidence[]
}

// Step 13 — same local structural-type convention as OneTimeFee.billability_condition
// above (this page defines its own types, not imported from lib/).
type OperationalEventEvidence = {
  id: string
  subjectId: string
  eventType: 'contract_signature' | 'delivery' | 'customer_acceptance' | 'final_acceptance' | 'change_order_signature'
  occurredAt: string
  source: 'reviewer_attestation' | 'trusted_system_event'
  recordedAt: string
  recordedBy: string
  status: 'active' | 'revoked'
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
  // committedFixedFees/conditionalFixedFees — the full-contract split
  // (recurring + one-time, annotated by the caller via
  // computeCommittedFixedFees/computeConditionalFixedFees), NOT the
  // one-time-fees-only split this function derives internally below for
  // oneTimeStr. Agreement A final amendment, item 2 — the summary sentence
  // must never call the Change-Order-conditional portion "committed".
  // Hardening item 3 — a readiness object, not a bare number: when
  // unresolved, the sentence must say so instead of ever printing a
  // computed figure a billing-impacting decision could still change.
  committedFixedFeeReadiness: CommittedFixedFeeResolution,
  conditionalFixedFees: number,
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
  // Item 3 — same conditionality split as the Pricing overview's own
  // cards (isChangeOrderConditionalFee): a fee gated on a Change Order
  // that may never be executed is never folded into the same total as a
  // fee that's definitely going to be billed, so this sentence can never
  // disagree with the overview cards' own figures again.
  const unconditionalSummaryFees = oneTimeFees.filter(f => !isChangeOrderConditionalFee(f))
  const conditionalSummaryFees   = oneTimeFees.filter(isChangeOrderConditionalFee)
  const unconditionalSummaryTotal = unconditionalSummaryFees.reduce((s, f) => s + Number(f.amount ?? 0), 0)
  const conditionalSummaryTotal   = conditionalSummaryFees.reduce((s, f) => s + Number(f.amount ?? 0), 0)
  const oneTimeStr = (unconditionalSummaryFees.length === 1
    ? ` plus a ${fmt(unconditionalSummaryFees[0].amount, cur)} one-time ${unconditionalSummaryFees[0].fee_label.toLowerCase()}`
    : unconditionalSummaryFees.length > 1
      ? ` plus ${fmt(unconditionalSummaryTotal, cur)} in one-time fees`
      : '') + (conditionalSummaryFees.length > 0
    ? `${unconditionalSummaryFees.length > 0 ? ' (' : ' plus '}${fmt(conditionalSummaryTotal, cur)} conditional on a signed Change Order${unconditionalSummaryFees.length > 0 ? ')' : ''}`
    : '')
  const committedFixedFees = committedFixedFeeReadiness.amount ?? 0
  const tcvStr = committedFixedFeeReadiness.status === 'unresolved'
    ? ` Committed fixed fees: not yet determinable — ${committedFixedFeeReadiness.reasons[0] ?? 'a billing-impacting decision is unresolved'}.`
    : committedFixedFees > 0
      ? ` Committed fixed fees over the initial term: ${fmt(committedFixedFees, cur)}${conditionalFixedFees > 0 ? ` (plus ${fmt(conditionalFixedFees, cur)} conditional on a signed Change Order — potential total ${fmt(committedFixedFees + conditionalFixedFees, cur)})` : ''}.`
      : ''
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
    const notice = formatRenewalNoticePeriod(terms) ?? 'advance notice required'
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

// billabilityConditionLabel/isChangeOrderConditionalFee now live in
// lib/billability-condition.ts (describeBillabilityCondition/
// isChangeOrderConditional) — item 10/3, so both this page's review card
// and Products & Services overview table, and any future page, share the
// exact same canonical labels/conditionality definition, with real unit
// test coverage (lib/billability-condition.test.ts).
function billabilityConditionLabel(c: OneTimeFee['billability_condition']): string | null {
  return describeBillabilityCondition(c ?? null)
}
function isChangeOrderConditionalFee(f: OneTimeFee): boolean {
  return isChangeOrderConditional(f.billability_condition ?? null)
}

// Item 10 final amendment — thin JSX wrapper around
// lib/billability-condition.ts's resolveOneTimeFeeTypeLabel (the tested,
// pure undefined/null discriminator — see its own doc comment). Only the
// presentational bits (styling, this table's own generic fallback string)
// live here; the governing logic is the same one every future one-time-fee
// consumer should reuse, not re-derived per call site.
function oneTimeFeeTypeLabel(f: OneTimeFee, genericFallback: string) {
  const result = resolveOneTimeFeeTypeLabel(f.billability_condition)
  if (result.kind === 'condition') return result.label
  if (result.kind === 'needs_review') return 'Needs review'
  return f.manual_trigger ? <span className="text-amber-600">On delivery</span> : genericFallback
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

// Shared structured-fact row — used everywhere a card shows a label/value
// pair (Applies to, Carry-forward, Cash, Trigger, Rebate, Basis, Timing,
// Cap, Value, and every other calculation_preview/params row across the
// review UI). Fixes a real wrapping/alignment defect the previous
// `flex justify-between` + `text-right` pattern had everywhere it was used:
// a right-aligned value wraps from its RIGHT edge, which orphans the final
// word of a long value on its own line with a huge gap in front of it (e.g.
// "Applies to: transaction processing fees, platform subscription\nfees").
// A CSS grid with a fixed label column and a LEFT-aligned value column
// wraps naturally from the value's own left edge instead. `grid-cols-1` by
// default stacks label above value (mobile); `sm:grid-cols-[label_1fr]`
// switches to a side-by-side row once there's enough width. One shared
// component, not re-implemented per card, so this fix can never be applied
// to only one card and missed on the others.
// action — optional per-row confirm button/status chip (e.g. one-time-fee
// cards' Amount/Billing condition rows). A 3rd desktop column
// (label | value | action) that becomes its own stacked block on mobile —
// label / value / action each on their own line — rather than an action
// squeezed onto the same line as a long value, which is what "reuse the
// same responsive fact-row approach" specifically means to avoid.
function FactRow({ label, value, icon, dense, action }: { label: string; value: React.ReactNode; icon?: string; dense?: boolean; action?: React.ReactNode }) {
  return (
    <div className={`grid grid-cols-1 ${action ? 'sm:grid-cols-[9rem_1fr_auto]' : 'sm:grid-cols-[9rem_1fr]'} gap-x-3 gap-y-1 sm:items-center ${dense ? 'text-[12.5px]' : 'text-xs'}`}>
      <dt className="flex items-center gap-1.5 text-stone">
        {icon && <i className={`ti ${icon} text-forest flex-shrink-0`} style={{ fontSize: 13 }} />}
        <span>{label}</span>
      </dt>
      <dd className={`${dense ? 'font-semibold' : 'font-medium'} text-ink text-left`}>{value}</dd>
      {action && <div className="sm:flex-shrink-0">{action}</div>}
    </div>
  )
}
function FactList({ rows, dense, className }: { rows: { label: string; value: React.ReactNode; icon?: string; action?: React.ReactNode }[]; dense?: boolean; className?: string }) {
  if (!rows.length) return null
  return (
    <dl className={`space-y-1.5 ${className ?? ''}`}>
      {rows.map((row, i) => <FactRow key={i} label={row.label} value={row.value} icon={row.icon} dense={dense} action={row.action} />)}
    </dl>
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

// Item 6 — a small, adjacent "View source clause ↗" affordance for a
// review card, using the SAME onViewSource callback (and PDF-scrolling
// behavior) the line-items table's per-section header already uses.
// Module scope (not declared inside ReviewPanel) so it isn't recreated on
// every render — a component created during render resets its own state
// each time, which is meaningless here since it's stateless, but is still
// flagged by react-hooks/static-components and is bad practice regardless.
// Renders nothing when no section is known (never a dead/misleading link)
// or when the caller has no onViewSource at all.
function SourceClauseLink({ section, onViewSource }: { section: string | undefined; onViewSource?: (section: string) => void }) {
  if (!section || !onViewSource) return null
  return (
    <button
      onClick={() => onViewSource(section)}
      className="text-[10px] font-medium text-forest hover:underline whitespace-nowrap flex-shrink-0"
    >
      View source clause ↗
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

  // Step 17B0, item D — lib/line-items.ts's own unresolved-marker row for
  // an unconfirmed base_fee_proration (see its own comment) — must be
  // caught before the generic `quantity === 0` check below, which would
  // otherwise misclassify it as an unconfirmed usage/overage tier. Reuses
  // the 'base_fee_proration' ItemKind (already the RuleInterpretationCard
  // kind for this exact rule) rather than inventing a parallel one.
  if (name === 'recurring base fee — partial-period treatment unresolved') return 'base_fee_proration'

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
// Gated on STATE (provenance), not on whether a value is present — a
// 'verdix_recommends' grade can carry a fully concrete eligible_component_keys/
// carry_forward value (that's the whole point of a recommendation) without
// being resolved. AI confidence is not provenance: only 'clear_from_source'
// (which confirm-rule persists as contract_derived) counts as resolved
// here; 'verdix_recommends' and 'decision_required' both still show as
// open, just with different actions available (confirm the recommendation,
// vs. must Override). Mirrors confirm-rule/route.ts's isProvenanceResolved.
function isSubStateOpen(state: 'clear_from_source' | 'verdix_recommends' | 'decision_required' | undefined): boolean {
  return state !== 'clear_from_source'
}
// Maps a graded ProposalState to the FieldProvenance confirm-rule persists
// when a reviewer accepts it via the general "Confirm & apply" action
// (i.e. without a dedicated, explicit "Confirm recommendation" click) —
// 'verdix_recommends' stays 'verdix_recommends' here deliberately; only a
// SEPARATE, specific reviewer action (see confirmRecommendation below)
// upgrades a recommendation to 'reviewer_policy'. 'decision_required'
// sends no provenance at all — there is no value to claim provenance over.
function stateToProvenance(state: 'clear_from_source' | 'verdix_recommends' | 'decision_required' | undefined): 'contract_derived' | 'verdix_recommends' | undefined {
  if (state === 'clear_from_source') return 'contract_derived'
  if (state === 'verdix_recommends') return 'verdix_recommends'
  return undefined
}

// Shared presentation for a single independently-graded sub-question on a
// service credit (application scope, survival & expiry) — same three-state
// visual language (green/amber/red) already used for the main trigger/rate/
// cap proposal card above, just parameterized so the two sub-badges don't
// duplicate this styling block twice.
function SubStateBadge({ label, state, decisionRequiredText, resolvedText, nonBlocking }: {
  label: string
  state: 'clear_from_source' | 'verdix_recommends' | 'decision_required'
  decisionRequiredText: string
  resolvedText: string
  // True for a sub-question that is informational, not a billing blocker,
  // when unresolved — currently only cash_redeemable for the invoice-
  // credit execution path (lib/commercial-rule-status.ts's
  // requiredServiceCreditFields never requires it there). A
  // 'decision_required' grading renders as neutral gray "Not specified"
  // instead of the alarming red "Decision required" used for a genuine
  // blocker like eligibility/survival, so the reviewer isn't cued to treat
  // ordinary contract silence here as something requiring action. If a
  // future execution context makes this field required, pass
  // nonBlocking={false} (or omit it) and the normal blocking treatment
  // applies unchanged.
  nonBlocking?: boolean
  // Note: an active Organization Policy covering genuine contract silence
  // (Step 5C) no longer renders through this badge at all — it gets its
  // own dedicated "applied automatically" informational card (see
  // RuleInterpretationCard's survivalOrgPolicyApplied branch), which unlike
  // this generic badge can offer a real "Override for this agreement"
  // action. This badge only ever renders decision_required (no policy, or
  // the reviewer's own active override) / verdix_recommends now.
}) {
  const isInformationalGap = state === 'decision_required' && nonBlocking
  return (
    <div className="rounded-xl p-3" style={{
      background: state === 'clear_from_source' ? '#F0FDF4' : isInformationalGap ? '#F5F5F4' : state === 'decision_required' ? '#FEF2F2' : '#FFFDF5',
      border: `1px solid ${state === 'clear_from_source' ? 'rgba(11,92,54,0.2)' : isInformationalGap ? 'rgba(120,113,108,0.25)' : state === 'decision_required' ? '#FECACA' : 'rgba(217,167,90,0.35)'}`,
    }}>
      <span
        className="inline-block text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full mb-1.5"
        style={state === 'clear_from_source'
          ? { background: 'rgba(11,92,54,0.12)', color: '#0B5C36' }
          : isInformationalGap
            ? { background: 'rgba(120,113,108,0.14)', color: '#57534E' }
            : state === 'decision_required'
              ? { background: 'rgba(153,27,27,0.1)', color: '#991B1B' }
              : { background: 'rgba(180,83,9,0.12)', color: '#92400E' }}
      >
        {label} · {state === 'clear_from_source' ? 'Clear from source' : state === 'decision_required' ? (isInformationalGap ? 'Not specified' : 'Decision required') : 'Verdix recommendation'}
      </span>
      <p className="text-[11px] leading-relaxed" style={{ color: isInformationalGap ? '#57534E' : state === 'decision_required' ? '#7F1D1D' : '#4A5D50' }}>
        {state === 'decision_required' ? decisionRequiredText : resolvedText}
      </p>
    </div>
  )
}

// Module scope (not just inside RuleInterpretationCard) so the confirmed-
// policy summary section can describe the SAME persisted application_rule
// the same way the review card itself did while resolving it — one
// implementation, not two independently-worded copies that could drift.
//
// carry_forward: false semantics (regression fix) — every CreditApplicationRule's
// availability is hardcoded to 'next_period' (see lib/types.ts; there is no
// same-period execution path anywhere in this codebase), meaning a credit is
// ALWAYS deferred to and applied against the invoice immediately following
// the one it was earned in — never the same period. carry_forward therefore
// only ever answers whether an unused REMAINDER survives PAST that first
// next-period application, not whether the credit is applied at all.
// carry_forward: false structurally means "applied against the next
// invoice only; any remainder then expires" (state B in the product
// discussion that found this bug) — it can NEVER mean "does not survive to
// be applied past the period it was earned in" (state C), because that
// same-period state is unreachable given the fixed availability. The
// previous wording here described state C, which this model cannot even
// represent, instead of state B, which is exactly what false means.
function describeSurvivalResolution(r: { carry_forward: boolean; expiry_periods?: number | null; expiry_date?: string | null }): string {
  if (!r.carry_forward) return 'Unused balance is applied against the next invoice only; any remainder then expires.'
  if (r.expiry_date) return `Unused balance carries forward until ${r.expiry_date}, after which any remainder expires.`
  if (r.expiry_periods === 1) return 'Unused balance applies to the next billing period only; any remainder then expires.'
  if (r.expiry_periods && r.expiry_periods > 1) return `Unused balance carries forward for ${r.expiry_periods} billing periods.`
  return 'Unused balance carries forward until fully used.'
}

// Review-card action-label cleanup — a service-credit card's card-level
// primary action confirms the credit's OWN terms (trigger/rate/basis/cap),
// never the Organization Policy that may separately, silently be applying
// to its survival sub-field (that's its own "applied automatically" card,
// with its own "Override for this agreement" action — a different button
// entirely, never renamed by this). Plain "Confirm & apply" reads as if
// SOMETHING about organization policy still needs confirming; naming what
// is actually being confirmed removes that ambiguity regardless of
// whether an organization policy happens to be involved on this credit.
function serviceCreditConfirmLabel(creditType?: string): string {
  if (creditType === 'rebate') return 'Confirm rebate terms'
  if (creditType === 'service_credit') return 'Confirm service-credit terms'
  return 'Confirm credit terms'
}

function RuleInterpretationCard({
  jobId, kind, contractUnitType, discountId, creditId, creditType, interactionKey, cadenceLabel, contractPeriodLabel, waiverExpiry, discountScope, sourceClause, currency, meterMappingConfirmed, meterSuggestion, showMeterDependencyNotice, onApplied,
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
  // Only meaningful for kind 'service_credit' — picks the credit-type-
  // specific survival wording below ("unused rebate balance" vs "unused
  // service-credit balance") instead of a one-size-fits-all sentence.
  creditType?: string
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
  // Step 17B0, item C — true when this base_fee_proration/
  // recurring_fee_proration card's open question was created by a waiver
  // on this same fee expiring mid-cycle (see baseFeeHasExpiringWaiver),
  // not a calendar/contract-start mismatch — swaps in
  // getWaiverExpiryFeeProrationOptions instead of the generic calendar
  // options. Ignored for every other kind.
  waiverExpiry?: boolean
  // Only meaningful for kind 'discount' — this discount's own typed
  // affected_components/possibly_affected_components, so a genuinely open
  // hybrid-fee scope question renders bounded scope options instead of
  // DISCOUNT_OPTIONS' tier-mechanics choices. See
  // discountHasUnresolvedComponentScope/getComponentScopeOptions.
  discountScope?: DiscountScopeContext | null
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
  const options = optionsForRuleType(ruleType, cadenceLabel, contractPeriodLabel, waiverExpiry, discountScope)
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
  // No cashOpenAfterConfirm — cash_redeemable is never a readiness blocker
  // for the invoice-credit execution path (see lib/commercial-rule-status
  // .ts's requiredServiceCreditFields), so there's nothing to nag the
  // reviewer to "still resolve" after confirming. The SubStateBadge during
  // review still shows an unresolved cash grading, just not styled as a
  // blocker (see the cash_redeemable_state badge below).
  // Inline survival-treatment picker (service_credit, survival_state ===
  // 'decision_required'/'verdix_recommends' only, today) — see
  // CREDIT_SURVIVAL_OPTIONS. The reviewer must pick/confirm one of these
  // BEFORE the main Confirm action becomes available; Override remains a
  // separate, unrelated escape hatch for "the extracted interpretation
  // itself is wrong", not "let me see my choices".
  // Contract B UX amendment — when an active Organization Policy already
  // covers genuine contract silence (aiProposal.survival_organization_policy
  // present), the default view is an informational "applied automatically"
  // card, not a picker the reviewer must act on. Clicking "Override for
  // this agreement" reveals the SAME inline picker used for the no-policy
  // case (unchanged mechanism/provenance) — this flag only ever toggles
  // which UI shows; it never itself resolves or submits anything.
  const [showSurvivalOverridePicker, setShowSurvivalOverridePicker] = useState(false)
  const [selectedSurvivalOption, setSelectedSurvivalOption] = useState<string | null>(null)
  const [survivalLimitedPeriods, setSurvivalLimitedPeriods] = useState('')
  const [survivalExpiryDate, setSurvivalExpiryDate] = useState('')
  const [survivalFreeText, setSurvivalFreeText] = useState('')
  const [survivalTranslating, setSurvivalTranslating] = useState(false)
  const [survivalErrorMsg, setSurvivalErrorMsg] = useState<string | null>(null)
  // Only "Other" ever calls the AI (buildCreditSurvivalPrompt) — every
  // structured option maps deterministically, client-side, with no AI call
  // at all. The translated result is a PROPOSAL, not yet applied: it sits
  // here until the reviewer explicitly clicks "Confirm this treatment"
  // (below), which is what actually sets survivalResolution — never
  // auto-applied the moment translation succeeds.
  const [survivalTranslatedPreview, setSurvivalTranslatedPreview] = useState<{ carry_forward: boolean; expiry_periods: number | null; expiry_date: string | null; calculation_summary: string | null } | null>(null)
  // The FINAL resolved value — set instantly for the structured options
  // (pure client-side mapping, no AI call) or only once the reviewer
  // explicitly confirms a translated "Other" preview. Non-null is what
  // unlocks the main confirm action once survival is the open field.
  const [survivalResolution, setSurvivalResolution] = useState<{ carry_forward: boolean; expiry_periods: number | null; expiry_date: string | null } | null>(null)

  const chooseSurvivalOption = (optionId: string) => {
    setSelectedSurvivalOption(optionId)
    setSurvivalErrorMsg(null)
    setSurvivalTranslatedPreview(null)
    if (optionId === 'carry_forward_until_used') setSurvivalResolution({ carry_forward: true, expiry_periods: null, expiry_date: null })
    else if (optionId === 'next_period_only') setSurvivalResolution({ carry_forward: true, expiry_periods: 1, expiry_date: null })
    else setSurvivalResolution(null) // carry_forward_limited / expire_on_date (need an input) / other (needs translation + explicit confirm)
  }

  const confirmSurvivalLimitedPeriods = () => {
    const n = parseInt(survivalLimitedPeriods, 10)
    if (!Number.isInteger(n) || n <= 0) { setSurvivalErrorMsg('Enter a whole number of periods greater than 0.'); return }
    setSurvivalResolution({ carry_forward: true, expiry_periods: n, expiry_date: null })
  }

  const confirmSurvivalExpiryDate = () => {
    if (!survivalExpiryDate) { setSurvivalErrorMsg('Pick a date.'); return }
    setSurvivalResolution({ carry_forward: true, expiry_periods: null, expiry_date: survivalExpiryDate })
  }

  // Step 1 of 2 for "Other" — translates free text into a PROPOSED rule,
  // shown to the reviewer as a preview (survivalTranslatedPreview), not yet
  // applied. Step 2 (confirmSurvivalTranslatedPreview, below) is the
  // reviewer's own explicit act of accepting it.
  const translateSurvivalFreeText = async () => {
    if (!survivalFreeText.trim()) { setSurvivalErrorMsg('Describe how the unused balance should be treated.'); return }
    setSurvivalTranslating(true)
    setSurvivalErrorMsg(null)
    setSurvivalTranslatedPreview(null)
    try {
      const res = await fetch(`/api/jobs/${jobId}/interpret-rule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ruleType: 'service_credit', creditId, sourceClause, freeText: survivalFreeText, subField: 'survival' }),
      })
      const data = await res.json().catch(() => ({ ok: false }))
      if (!res.ok || !data.ok || typeof data.survival?.carry_forward !== 'boolean') {
        setSurvivalErrorMsg(data.questions?.[0] ?? data.error ?? 'Verdix could not translate that into a specific treatment.')
        return
      }
      setSurvivalTranslatedPreview({
        carry_forward: data.survival.carry_forward,
        expiry_periods: data.survival.expiry_periods ?? null,
        expiry_date: data.survival.expiry_date ?? null,
        calculation_summary: data.calculationSummary ?? null,
      })
    } catch {
      setSurvivalErrorMsg('Verdix could not reach the AI interpretation service. Try again.')
    } finally {
      setSurvivalTranslating(false)
    }
  }

  // Step 2 of 2 — the reviewer's explicit act of accepting the translated
  // preview. Only this click sets survivalResolution; provenance becomes
  // reviewer_policy because the REVIEWER confirmed it, not because the AI
  // translated it — the translation itself is never trusted as final.
  const confirmSurvivalTranslatedPreview = () => {
    if (!survivalTranslatedPreview) return
    setSurvivalResolution(survivalTranslatedPreview)
  }

  // Maps an already-concrete application_rule (as returned by a
  // verdix_recommends proposal) back to the matching CREDIT_SURVIVAL_OPTIONS
  // id, so the recommended choice can be pre-selected and marked "Verdix
  // recommended" — mirrors deriveSelectedOption's existing pattern for the
  // top-level structured-option lists, scoped to this one sub-field.
  const deriveSurvivalOptionId = (appRuleValue?: Record<string, unknown>): string | null => {
    if (!appRuleValue || appRuleValue.carry_forward !== true) return null
    if (appRuleValue.expiry_date) return 'expire_on_date'
    if (appRuleValue.expiry_periods === 1) return 'next_period_only'
    if (typeof appRuleValue.expiry_periods === 'number' && appRuleValue.expiry_periods > 1) return 'carry_forward_limited'
    return 'carry_forward_until_used'
  }

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
          setSelectedOption(deriveSelectedOption(ruleType, data.proposal.proposed_interpretation, waiverExpiry))
        }
        // Same pre-selection discipline as above, scoped to the survival
        // sub-field: a recommendation is shown pre-picked with its already-
        // concrete value (never for a genuine decision_required, which
        // starts blank) — but nothing is written anywhere until the
        // reviewer clicks the outer Confirm action, so pre-populating
        // survivalResolution here is safe. Sets the resolution directly
        // (not via chooseSurvivalOption, which blanks it for the
        // needs-more-input options) since the recommendation already
        // carries a concrete expiry_periods/expiry_date if any.
        if (data.proposal.survival_state === 'verdix_recommends') {
          const rec = (data.proposal.proposed_interpretation as Record<string, unknown> | null)?.application_rule as Record<string, unknown> | undefined
          const recId = deriveSurvivalOptionId(rec)
          if (recId && rec) {
            setSelectedSurvivalOption(recId)
            setSurvivalResolution({
              carry_forward: true,
              expiry_periods: typeof rec.expiry_periods === 'number' ? rec.expiry_periods : null,
              expiry_date: typeof rec.expiry_date === 'string' ? rec.expiry_date : null,
            })
            if (typeof rec.expiry_periods === 'number' && rec.expiry_periods > 1) setSurvivalLimitedPeriods(String(rec.expiry_periods))
            if (typeof rec.expiry_date === 'string') setSurvivalExpiryDate(rec.expiry_date)
          }
        }
      } catch {
        if (!cancelled) setPhase('input')
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // forceProvenance lets a dedicated "Confirm recommendation" click (see the
  // 'applied'-phase render below) explicitly upgrade ONE specific
  // verdix_recommends sub-field to reviewer_policy, without touching the
  // other — a reviewer endorsing the eligibility recommendation doesn't
  // thereby also endorse a separate, still-open survival recommendation.
  // Omitted on the normal "Confirm & apply" path, where each sub-field's
  // provenance is exactly whatever the AI itself graded (stateToProvenance)
  // — accepting the proposal's main facts must never silently launder a
  // recommendation into an executable fact.
  const confirmProposal = async (forceProvenance?: { eligibility?: true; survival?: true }) => {
    if (!aiProposal?.proposed_interpretation) return
    setPhase('confirming')
    try {
      // A reviewer's inline survival selection (chooseSurvivalOption /
      // confirmSurvivalLimitedPeriods / confirmSurvivalExpiryDate /
      // confirmSurvivalTranslatedPreview) overrides whatever the AI
      // proposed for carry_forward/expiry_periods/expiry_date — it's now an
      // explicit reviewer choice, always reviewer_policy provenance, never
      // derived from aiProposal.survival_state.
      const interpretation = survivalResolution
        ? {
            ...aiProposal.proposed_interpretation,
            application_rule: {
              ...((aiProposal.proposed_interpretation as Record<string, unknown>).application_rule as Record<string, unknown> | undefined),
              carry_forward: survivalResolution.carry_forward,
              expiry_periods: survivalResolution.expiry_periods,
              expiry_date: survivalResolution.expiry_date,
            },
          }
        : aiProposal.proposed_interpretation
      const applicationRuleProvenance = ruleType === 'service_credit' ? {
        eligibility: forceProvenance?.eligibility ? 'reviewer_policy' as const : stateToProvenance(aiProposal.application_state),
        survival: (forceProvenance?.survival || survivalResolution) ? 'reviewer_policy' as const : stateToProvenance(aiProposal.survival_state),
      } : undefined
      // Same discipline as applicationRuleProvenance above, for
      // cash_redeemable (Step 1.5) — a plain top-level field, not nested
      // under application_rule, so it travels as its own request field.
      // No forceProvenance escalation path (unlike eligibility/survival) —
      // cash_redeemable never blocks readiness (see lib/commercial-rule-
      // status.ts's requiredServiceCreditFields), so there is no "still
      // open, confirm this recommendation" affordance that would need one;
      // a Verdix recommendation here is recorded exactly as graded.
      const cashRedeemableProvenance = ruleType === 'service_credit' ? stateToProvenance(aiProposal.cash_redeemable_state) : undefined
      const res = await fetch(`/api/jobs/${jobId}/confirm-rule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ruleType, contractUnitType, discountId, creditId, interactionKey, sourceClause, reviewerInput: aiProposal.reasoning,
          aiProposedInterpretation: aiProposal.proposed_interpretation, approvedInterpretation: interpretation,
          applicationRuleProvenance, cashRedeemableProvenance,
          // Step 5C — evidence of what organization policy (if any) the
          // reviewer was shown, purely for confirm-rule's own staleness
          // comparison against its independently re-resolved authoritative
          // state — never trusted as a selection. See RuleProposal.
          // survival_organization_policy's comment for the full rationale.
          survivalOrganizationPolicySeen: ruleType === 'service_credit' ? aiProposal.survival_organization_policy : undefined,
        }),
      })
      // A non-JSON response (e.g. an unhandled server exception returning
      // Next.js's HTML error page) used to throw here and fall into the
      // catch block below, which only ever showed a generic "try again" —
      // the real cause (a specific server error, or just this HTTP status)
      // is now surfaced instead of swallowed.
      const data = await res.json().catch(() => ({ error: `Unexpected response from server (${res.status})` }))
      if (!res.ok && !data.propagation) { setErrorMsg(data.error ?? 'Approval failed.'); setPhase('proposed'); return }
      // Step 5C, pre-commit review (item 3) — the organization policy the
      // reviewer was shown no longer matches what confirm-rule's own,
      // authoritative re-resolution found (disabled, now conflicting, or
      // edited to a different value/version). Everything else on this
      // credit DID save — only the survival sub-field was deliberately
      // left unresolved rather than silently applying a policy the
      // reviewer never actually saw. Surface it plainly and require a
      // fresh look, rather than reporting a clean "applied".
      if (data.staleOrganizationPolicy) {
        setErrorMsg("Your organization's carry-forward policy changed while this was open. This credit was saved, but the unused-balance treatment still needs a fresh look — reopen this card to see the current policy.")
        setPhase('proposed')
        return
      }
      setPropagation(data.propagation ?? {})
      const anyFailed = Object.values(data.propagation ?? {}).includes('failed')
      if (anyFailed) {
        setPhase('partial')
      } else {
        setEligibilityOpenAfterConfirm(ruleType === 'service_credit' && !forceProvenance?.eligibility && isSubStateOpen(aiProposal.application_state))
        setSurvivalOpenAfterConfirm(ruleType === 'service_credit' && !forceProvenance?.survival && !survivalResolution && isSubStateOpen(aiProposal.survival_state))
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
      // A reviewer's already-resolved inline survival selection (set before
      // switching to a different top-level option, which routes through
      // generate()/this function rather than confirmProposal()) must not be
      // silently dropped just because the interpretation now comes from
      // interpret-rule instead of propose-rule — same merge as
      // confirmProposal(), applied here too. Takes priority over whatever
      // buildServiceCreditPrompt itself returned for survival, since the
      // reviewer's explicit picker selection is more specific than a
      // free-text translation.
      const overrideAppRule = (proposal as Record<string, unknown>)?.application_rule as Record<string, unknown> | undefined
      const interpretation = survivalResolution
        ? {
            ...(proposal as Record<string, unknown>),
            application_rule: {
              ...overrideAppRule,
              carry_forward: survivalResolution.carry_forward,
              expiry_periods: survivalResolution.expiry_periods,
              expiry_date: survivalResolution.expiry_date,
            },
          }
        : proposal
      // buildServiceCreditPrompt now asks about application_rule too (a
      // reviewer's override instruction, or the source clause itself, may
      // address eligibility/survival even though this path is primarily
      // about trigger/rate/basis) — any concrete value it returns reflects
      // either the reviewer's own words or the clause, so it earns
      // reviewer_policy provenance the same way confirming a recommendation
      // does. Left unset (not "downgraded", just absent) when the override
      // stayed silent — confirm-rule's fallback then correctly leaves the
      // field however it already was (still unresolved if never set).
      const eligibilityAddressed = overrideAppRule?.eligible_component_keys != null
      const survivalAddressed = !!overrideAppRule
        && (overrideAppRule.carry_forward === true || overrideAppRule.carry_forward === false)
        && (overrideAppRule.one_time === true || overrideAppRule.one_time === false)
      const applicationRuleProvenance = ruleType === 'service_credit' && (survivalResolution || eligibilityAddressed || survivalAddressed)
        ? {
            eligibility: eligibilityAddressed ? 'reviewer_policy' as const : undefined,
            survival: (survivalResolution || survivalAddressed) ? 'reviewer_policy' as const : undefined,
          }
        : undefined
      // Same discipline as eligibilityAddressed/survivalAddressed above, for
      // cash_redeemable (Step 1.5): buildServiceCreditPrompt now asks about
      // it directly on the proposal (not nested in application_rule) — a
      // concrete true/false the override actually returned earns
      // reviewer_policy; "unclear"/absent leaves it unset, letting confirm-
      // rule's own fallback preserve whatever was already on file.
      const cashAddressed = (proposal as Record<string, unknown>)?.cash_redeemable === true || (proposal as Record<string, unknown>)?.cash_redeemable === false
      const cashRedeemableProvenance = ruleType === 'service_credit' && cashAddressed ? 'reviewer_policy' as const : undefined
      const res = await fetch(`/api/jobs/${jobId}/confirm-rule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ruleType, contractUnitType, discountId, creditId, interactionKey, sourceClause, reviewerInput: freeText,
          aiProposedInterpretation: proposal, approvedInterpretation: interpretation,
          applicationRuleProvenance, cashRedeemableProvenance,
        }),
      })
      const data = await res.json().catch(() => ({ error: `Unexpected response from server (${res.status})` }))
      if (!res.ok && !data.propagation) { setErrorMsg(data.error ?? 'Approval failed.'); setPhase('proposal'); return }
      setPropagation(data.propagation ?? {})
      const anyFailed = Object.values(data.propagation ?? {}).includes('failed')
      if (anyFailed) {
        setPhase('partial')
      } else {
        // Not computing a targeted "still open" follow-up card here (unlike
        // confirmProposal(), which has aiProposal.application_state/
        // survival_state to know precisely what's still open) — if the
        // override left eligibility/survival genuinely unaddressed,
        // isServiceCreditUnresolved (now correctly treating a null/absent
        // application_rule as unresolved) means this credit reappears as
        // its own fresh card in the outer "Service credits" list on the
        // next refresh regardless; this only skips the same-instance
        // inline "X still open" shortcut, not the underlying correctness.
        setEligibilityOpenAfterConfirm(false)
        setSurvivalOpenAfterConfirm(false)
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
    ? deriveSelectedOption(ruleType, aiProposal.proposed_interpretation, waiverExpiry)
    : null

  // Computed once, shared by both the survival badge and the confirm-button
  // logic below — carry_forward (unused-balance survival) and one_time
  // (repeatability) are independent sub-questions bundled under one AI-
  // graded survival_state; see the SubStateBadge render's own comment for
  // why. The inline CREDIT_SURVIVAL_OPTIONS picker only covers the
  // carry-forward-only case today (the one this UI pattern was built for);
  // repeatability-open and both-open still use the SubStateBadge/Override
  // pair unchanged. Shows for BOTH decision_required (blank start) and
  // verdix_recommends (pre-selected, still requires explicit confirmation
  // before it counts as reviewer_policy — see the useEffect above).
  const appRule = (aiProposal?.proposed_interpretation as Record<string, unknown> | null)?.application_rule as Record<string, unknown> | undefined
  const survivalCarryForwardOpen = appRule?.carry_forward === 'unclear'
  const survivalOneTimeOpen = appRule?.one_time === 'unclear'
  // Step 5C — an active, applicable Organization Rulebook policy already
  // covers this genuinely-silent field (see propose-rule/route.ts's
  // withOrganizationPolicyAvailability). Never force the reviewer to make
  // a manual carry-forward decision an organization has already made once
  // for itself — "Confirm & apply" below submits carry_forward exactly as
  // the AI proposed it (still 'unclear'), and confirm-rule's own
  // organization-resolution branch (lib/credit-application-rule.ts) mints
  // organization_rulebook provenance from that, with the real matching
  // rule's id/version — this flag only ever suppresses a redundant prompt,
  // it never itself decides or submits a value.
  // True when an active Organization Policy is available AND the reviewer
  // hasn't asked to override it for this agreement — the default state for
  // Contract B's rebate. showSurvivalOverridePicker is the reviewer's own
  // explicit "Override for this agreement" click, never auto-set.
  const survivalOrgPolicyApplied = !!aiProposal?.survival_organization_policy && !showSurvivalOverridePicker
  const survivalNeedsInlinePicker = !survivalOrgPolicyApplied && (
    (aiProposal?.survival_state === 'decision_required' && survivalCarryForwardOpen && !survivalOneTimeOpen) ||
    (aiProposal?.survival_state === 'verdix_recommends' && appRule?.carry_forward === true) ||
    // The org-policy path itself, once the reviewer has explicitly clicked
    // Override — same picker, same mechanism, just reached a different way
    // than the no-policy decision_required case above.
    (!!aiProposal?.survival_organization_policy && showSurvivalOverridePicker)
  )
  const survivalIsRecommendation = aiProposal?.survival_state === 'verdix_recommends'
  const survivalRecommendedOptionId = survivalIsRecommendation ? deriveSurvivalOptionId(appRule) : null
  const survivalSelectionPending = survivalNeedsInlinePicker && !survivalResolution
  // Shared between the applied-policy card and the SubStateBadge fallback
  // below, so the two branches never disagree on what to call this
  // sub-field.
  const survivalLabel = survivalCarryForwardOpen && !survivalOneTimeOpen ? `Unused ${creditType === 'rebate' ? 'rebate' : 'balance'} survival`
    : survivalOneTimeOpen && !survivalCarryForwardOpen ? 'Repeatability'
    : 'Survival & expiry'

  if (phase === 'applied' && (eligibilityOpenAfterConfirm || survivalOpenAfterConfirm)) {
    // Two independent open items, each rendered with the action that
    // actually matches its OWN state — a 'verdix_recommends' sub-field
    // gets a dedicated "Confirm recommendation" action (which upgrades
    // just that field to reviewer_policy without touching the other, still-
    // open one) alongside "Choose another"; a genuinely silent
    // 'decision_required' sub-field only ever gets "Resolve" (Override) —
    // there is no recommendation to confirm. Never a blanket "Resolve X and
    // Y" button that could be clicked without the reviewer registering
    // which specific claim they're endorsing.
    // Survival wording is credit-type-specific: Contract-Year repeatability
    // (whether the credit can be earned again next period) is a separate,
    // source-derived question already answered by the earn rule — it's not
    // part of what's actually unresolved here, so the sentence only names
    // the genuinely open question, what happens to an unused balance.
    const survivalNoun = creditType === 'rebate' ? 'rebate' : 'service-credit'
    const openItems = [
      eligibilityOpenAfterConfirm ? {
        key: 'eligibility', label: 'Application scope', state: aiProposal?.application_state,
        recommendsReason: 'Verdix recommends this based on the reasoning above — the contract doesn’t explicitly state what future charges this credit may reduce.',
        decisionRequiredReason: "The contract states this credit's size but not what future charges it may reduce.",
        onConfirmRecommendation: () => confirmProposal({ eligibility: true }),
      } : null,
      survivalOpenAfterConfirm ? {
        key: 'survival', label: `Unused ${survivalNoun} balance`, state: aiProposal?.survival_state,
        recommendsReason: `Verdix recommends this based on the reasoning above — the agreement doesn’t state what happens to any portion of ${creditType === 'rebate' ? 'an earned rebate' : 'an unused Service Credit'} that remains ${creditType === 'rebate' ? 'unused after it is credited' : 'unused'}.`,
        decisionRequiredReason: creditType === 'rebate'
          ? 'The agreement does not state what happens to any portion of an earned rebate that remains unused after it is credited.'
          : 'The agreement does not specify whether an unused Service Credit carries forward, expires, or for how long it remains available.',
        onConfirmRecommendation: () => confirmProposal({ survival: true }),
      } : null,
      // Deliberately no cash entry here — cash_redeemable never blocks the
      // invoice-credit execution path (see lib/commercial-rule-status.ts's
      // requiredServiceCreditFields), so there is nothing for this "still
      // open, resolve it" nagging widget to say about it. Its badge during
      // review (below) still shows the grading, just not as a blocker.
    ].filter((x): x is NonNullable<typeof x> => x !== null)

    return (
      <div className="space-y-2">
        {openItems.map(item => {
          const isRecommendation = item.state === 'verdix_recommends'
          return (
            <div key={item.key} className="rounded-xl p-3" style={{ background: isRecommendation ? '#FFFDF5' : '#FEF2F2', border: `1px solid ${isRecommendation ? 'rgba(217,167,90,0.35)' : '#FECACA'}` }}>
              <p className="text-sm font-medium flex items-center gap-1.5" style={{ color: isRecommendation ? '#92400E' : '#7F1D1D' }}>
                <i className={isRecommendation ? 'ti ti-bulb' : 'ti ti-alert-triangle'} style={{ fontSize: 15 }} />
                {item.label} {isRecommendation ? '· Verdix recommendation' : 'still open'}
              </p>
              <p className="text-[11px] mt-1" style={{ color: isRecommendation ? '#78350F' : '#7F1D1D' }}>
                {isRecommendation ? item.recommendsReason : item.decisionRequiredReason}
                {' '}It will keep counting as a decision outstanding, and won&rsquo;t be applied against billing, until this is resolved.
              </p>
              <div className="flex gap-2 mt-2">
                {isRecommendation && (
                  <button
                    onClick={item.onConfirmRecommendation}
                    className="text-xs font-semibold px-3 py-1.5 rounded-lg"
                    style={{ background: '#1A3D2B', color: 'white' }}
                  >
                    Confirm recommendation
                  </button>
                )}
                <button
                  onClick={() => setPhase('input')}
                  className="text-xs font-semibold px-3 py-1.5 rounded-lg"
                  style={isRecommendation ? { color: '#92400E', border: '1px solid rgba(217,167,90,0.5)' } : { background: '#1A3D2B', color: 'white' }}
                >
                  {isRecommendation ? 'Choose another' : 'Resolve'}
                </button>
              </div>
            </div>
          )
        })}
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
            {/* Structured facts, default/scan-first view — leads with what
                the model already computed (calculation_preview) plus,
                service_credit only, whichever of application scope/carry-
                forward/cash is ITSELF clear_from_source (an open sub-field
                still gets its own callout further below, unchanged). The
                verbatim clause and the model's prose reasoning are both
                available on demand (View source clause / More details,
                immediately below this block) — never inline here by
                default, so the default card is facts-first, not
                paragraph-first. */}
            {(() => {
              const appRule = (aiProposal.proposed_interpretation as Record<string, unknown> | null)?.application_rule as Record<string, unknown> | undefined
              const cashRedeemable = (aiProposal.proposed_interpretation as Record<string, unknown> | null)?.cash_redeemable as boolean | 'unclear' | undefined
              const factRows: { label: string; value: string }[] = [...(aiProposal.calculation_preview ?? [])]
              if (ruleType === 'service_credit' && aiProposal.application_state === 'clear_from_source') {
                factRows.push({ label: 'Applies to', value: formatEligibleComponentsFact(appRule?.eligible_component_keys as string[] | 'all' | null | undefined) })
              }
              if (ruleType === 'service_credit' && aiProposal.survival_state === 'clear_from_source' && typeof appRule?.carry_forward === 'boolean') {
                factRows.push({ label: 'Carry-forward', value: formatCarryForwardFact(appRule.carry_forward as boolean, appRule.expiry_periods as number | null, appRule.expiry_date as string | null) })
              }
              if (ruleType === 'service_credit' && aiProposal.cash_redeemable_state === 'clear_from_source') {
                factRows.push({ label: 'Cash', value: formatCashRedeemableFact(cashRedeemable) })
              }
              return <FactList rows={factRows} />
            })()}
            {!!aiProposal.reasoning && (
              <div className="mt-2 pt-2" style={{ borderTop: '1px solid rgba(26,61,43,0.08)' }}>
                <button
                  onClick={() => setShowFullReasoning(v => !v)}
                  className="text-[11px] font-medium text-forest hover:underline"
                >
                  {showFullReasoning ? 'Hide details' : 'More details'}
                </button>
                {showFullReasoning && <p className="text-xs text-ink leading-relaxed mt-1.5">{aiProposal.reasoning}</p>}
              </div>
            )}
          </div>
          {/* Inline alternatives for a whole-card "Verdix recommendation" —
              same principle as the survival sub-field picker above, applied
              generically to every rule type this shared component serves
              (options already comes from optionsForRuleType(ruleType, ...),
              so no per-rule-type customization is needed here): a
              recommendation must show its alternatives directly, not hide
              them behind Override. selectedOption already defaults to
              aiRecommendedOptionId (see the propose-rule useEffect above),
              so this list starts pre-picked at Verdix's own choice; picking
              a DIFFERENT option routes through the same generate()/
              interpret-rule flow Override already uses (a genuinely
              different structured value needs the same re-interpretation
              step), while re-confirming the recommended option itself stays
              on the fast path (confirmProposal(), no extra AI call). Not
              shown for 'clear_from_source' — that state's plain
              Confirm & apply / Override pair is unchanged, per instruction. */}
          {aiProposal.state === 'verdix_recommends' && (
            <div className="rounded-xl p-3 space-y-2" style={{ background: '#FFFDF5', border: '1px solid rgba(217,167,90,0.35)' }}>
              <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: '#92400E' }}>Alternatives</p>
              <div className="space-y-1.5">
                {options.map(opt => {
                  const isRecommended = aiRecommendedOptionId != null && opt.id === aiRecommendedOptionId
                  return (
                    <label
                      key={opt.id}
                      className="flex items-start gap-2 p-2 rounded-lg cursor-pointer border transition-colors"
                      style={{
                        borderColor: selectedOption === opt.id ? '#1A3D2B' : 'rgba(26,61,43,0.15)',
                        background: selectedOption === opt.id ? '#F0FDF4' : 'white',
                      }}
                    >
                      <input
                        type="radio"
                        name={`rule-recommendation-${contractUnitType ?? creditId ?? discountId ?? 'card'}`}
                        checked={selectedOption === opt.id}
                        onChange={() => setSelectedOption(opt.id)}
                        className="mt-0.5"
                      />
                      <span>
                        <span className="flex items-center gap-1.5">
                          <span className="block text-xs font-medium text-ink">{opt.label}</span>
                          {isRecommended && (
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
            </div>
          )}
          {/* Application scope — service_credit only. Graded and shown
              separately from the trigger/rate/cap badge above: a credit can
              be Clear from source on what it's worth while genuinely
              Decision required on what it may reduce (or vice versa), and
              folding both into one badge previously meant the whole card
              read as "Verdix recommendation" the moment EITHER question was
              less than fully explicit — even for a credit like Growth
              Credit, whose application scope is itself stated verbatim. */}
          {/* clear_from_source is handled above as an "Applies to" fact row
              — this badge only ever appears for the two states that need an
              actual callout: a genuine open decision, or a recommendation
              worth flagging as not-yet-certain. */}
          {aiProposal.application_state && aiProposal.application_state !== 'clear_from_source' && (
            <SubStateBadge
              label="Application scope"
              state={aiProposal.application_state}
              decisionRequiredText="Contract is silent on what this credit may reduce."
              resolvedText="Verdix recommends a scope based on the source language."
            />
          )}
          {/* Survival & expiry — deliberately a SEPARATE badge from
              Application scope above, not a second line inside it. A clause
              can state exactly what a credit may offset (Growth Credit:
              "applicable only against future transaction-processing fees")
              while saying nothing about how long an earned-but-unused
              credit survives — those are different questions, and folding
              survival's silence into the eligibility badge would incorrectly
              mark an otherwise-explicit eligibility answer as unresolved.
              carry_forward (unused-balance survival) and one_time
              (repeatability) are themselves two further independent
              sub-questions bundled under this one AI-graded survival_state —
              a contract can resolve repeatability (e.g. an annually-
              re-evaluated rebate has no "one-time" restriction, unlike a
              milestone credit) while staying genuinely silent on what
              happens to an unapplied remainder. The label/reasoning below
              names whichever ONE of the two is actually still open, rather
              than always claiming both are unresolved regardless of what
              the underlying fields actually say. */}
          {/* Contract B UX amendment — an active, applicable Organization
              Policy is an already-approved organizational default, not an
              open decision the reviewer must act on. Default view is a
              plain informational "applied automatically" fact, matching
              every other resolved fact on this card, with its own explicit
              "Override for this agreement" escape hatch — never the
              DECISION REQUIRED-style callout below, which is reserved for
              genuinely unresolved fields (no policy at all) or the
              reviewer's own active override-in-progress. */}
          {survivalOrgPolicyApplied && aiProposal.survival_organization_policy && (
            <div className="rounded-xl p-3 space-y-1" style={{ background: '#EFF6FF', border: '1px solid rgba(30,64,175,0.25)' }}>
              <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: '#1E40AF' }}>
                {survivalLabel} · Organization policy
              </p>
              <p className="text-sm font-medium text-ink">
                {/* false regression fix — availability is always
                    'next_period' (no same-period execution path exists),
                    so false structurally means "applied against the next
                    invoice only, then any remainder expires" — never "does
                    not carry forward at all". See describeSurvivalResolution's
                    own comment for the full explanation. */}
                {aiProposal.survival_organization_policy.value ? 'Carry forward until fully used' : 'Expires after next invoice'}
              </p>
              <p className="text-[11px]" style={{ color: '#1E3A5F' }}>
                {/* Step 16A — this card can only ever render for genuine
                    contract silence in the first place (both
                    withOrganizationPolicyAvailability and confirm-rule's
                    own resolution skip explicit_non_agreement entirely, so
                    survival_organization_policy is never even set for that
                    case) — but the copy itself stays conditional on the
                    structured reason too, rather than assuming that
                    upstream gate is the only thing keeping it accurate. */}
                {aiProposal.survival_unresolved_reason === 'silent' || !aiProposal.survival_unresolved_reason
                  ? 'Applied automatically because the agreement is silent.'
                  : 'Applied automatically.'}
                {aiProposal.survival_organization_policy.rule_name && ` Policy: ${aiProposal.survival_organization_policy.rule_name}.`}
              </p>
              <button
                onClick={() => setShowSurvivalOverridePicker(true)}
                className="text-[11px] font-medium hover:underline"
                style={{ color: '#1E40AF' }}
              >
                Override for this agreement
              </button>
            </div>
          )}
          {!survivalOrgPolicyApplied && aiProposal.survival_state && aiProposal.survival_state !== 'clear_from_source' && (() => {
            // Item 5/6 — heading + one short fact, never restating what the
            // heading (DECISION REQUIRED/badge) or the picker immediately
            // below it already communicate ("Choose the treatment" was
            // redundant with the picker itself). The clause/full reasoning
            // stay available via View source clause/More details above,
            // never restated here.
            const decisionRequiredText = aiProposal.survival_organization_policy
              // Reached only via the reviewer's own "Override for this
              // agreement" click (survivalOrgPolicyApplied is false) — the
              // organization default itself is already shown/available via
              // the applied-policy card above whenever they back out.
              ? 'Choose a treatment for this agreement only — the organization policy itself is unchanged.'
              // Step 16A — the agreement doesn't merely fail to raise this
              // question, it affirmatively states the parties did not
              // reach agreement on it (see UnresolvedReason's own comment
              // in lib/rule-interpretation.ts). No organization policy
              // reaches this branch at all for this reason (withOrganizationPolicyAvailability/
              // confirm-rule's own resolution both skip it), so this is
              // always a genuine, agreement-specific reviewer decision.
              : aiProposal.survival_unresolved_reason === 'explicit_non_agreement'
                ? 'The agreement explicitly leaves this unresolved. Choose a treatment for this agreement.'
                : survivalCarryForwardOpen && !survivalOneTimeOpen
                  ? 'Contract is silent on unused-balance treatment.'
                  : survivalOneTimeOpen && !survivalCarryForwardOpen
                    ? 'Contract is silent on whether this credit can be earned more than once.'
                    : 'Contract is silent on survival and repeatability.'
            const resolvedText = survivalNeedsInlinePicker
              ? 'Verdix recommends a treatment below.'
              : 'Verdix recommends a treatment based on the source language.'
            return (
              <SubStateBadge
                label={survivalLabel}
                state={aiProposal.survival_state}
                decisionRequiredText={decisionRequiredText}
                resolvedText={resolvedText}
              />
            )
          })()}
          {/* Cash redeemability — a FOURTH independently-graded badge (Step
              1.5), same reasoning as the split above: most service-credit
              clauses never mention cash redemption at all even when
              trigger/value/cap/application scope are fully explicit, so
              folding this into any of the other three would incorrectly
              drag an otherwise-clear credit down to "Decision required"
              purely because this one, usually-unaddressed question is open.
              nonBlocking: contract silence here is informational, not a
              billing blocker — see lib/commercial-rule-status.ts's
              requiredServiceCreditFields (cash is only required for a
              'cash_settlement' execution context, which doesn't exist yet;
              today's only real path, invoice_credit, never needs it). */}
          {aiProposal.cash_redeemable_state && aiProposal.cash_redeemable_state !== 'clear_from_source' && (
            <SubStateBadge
              label="Cash"
              state={aiProposal.cash_redeemable_state}
              nonBlocking
              decisionRequiredText="Not specified · does not block invoice-credit use."
              resolvedText="Verdix recommends this based on the source language."
            />
          )}
          {/* Inline decision-required/recommendation picker — neither state
              should gate its choices behind Override. Override means "the
              extracted interpretation is wrong"; this is "answer the
              ambiguity Verdix already identified" (or "confirm/replace
              Verdix's own recommendation"), a different action entirely.
              Scoped to the carry-forward-only case today — see
              survivalNeedsInlinePicker's own comment above. */}
          {survivalNeedsInlinePicker && (
            <div className="rounded-xl p-3 space-y-2" style={{ background: survivalIsRecommendation ? '#FFFDF5' : '#FEF2F2', border: `1px solid ${survivalIsRecommendation ? 'rgba(217,167,90,0.35)' : '#FECACA'}` }}>
              <div className="flex items-center justify-between gap-2">
                <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: survivalIsRecommendation ? '#92400E' : '#7F1D1D' }}>How should the unused balance be treated?</p>
                {/* Escape hatch back to the organization default — only
                    reachable via the reviewer's own Override click, never
                    shown for the ordinary no-policy decision_required case. */}
                {aiProposal?.survival_organization_policy && showSurvivalOverridePicker && (
                  <button
                    onClick={() => { setShowSurvivalOverridePicker(false); setSelectedSurvivalOption(null); setSurvivalResolution(null) }}
                    className="text-[10px] font-medium hover:underline flex-shrink-0"
                    style={{ color: '#7F1D1D' }}
                  >
                    Use organization policy
                  </button>
                )}
              </div>
              <div className="space-y-1.5">
                {CREDIT_SURVIVAL_OPTIONS.map(opt => {
                  const isRecommended = survivalIsRecommendation && opt.id === survivalRecommendedOptionId
                  return (
                    <label
                      key={opt.id}
                      className="flex items-start gap-2 p-2 rounded-lg cursor-pointer border transition-colors"
                      style={{
                        borderColor: selectedSurvivalOption === opt.id ? '#1A3D2B' : 'rgba(26,61,43,0.15)',
                        background: selectedSurvivalOption === opt.id ? '#F0FDF4' : 'white',
                      }}
                    >
                      <input
                        type="radio"
                        name={`survival-option-${creditId ?? contractUnitType ?? 'card'}`}
                        checked={selectedSurvivalOption === opt.id}
                        onChange={() => chooseSurvivalOption(opt.id)}
                        className="mt-0.5"
                      />
                      <span>
                        <span className="flex items-center gap-1.5">
                          <span className="block text-xs font-medium text-ink">{opt.label}</span>
                          {isRecommended && (
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
              {selectedSurvivalOption === 'carry_forward_limited' && (
                <div className="flex items-center gap-2 pl-1">
                  <input
                    type="number"
                    min={1}
                    value={survivalLimitedPeriods}
                    onChange={e => setSurvivalLimitedPeriods(e.target.value)}
                    placeholder="Number of periods"
                    className="w-36 text-xs border rounded-lg px-2 py-1.5"
                    style={{ borderColor: 'rgba(26,61,43,0.15)' }}
                  />
                  <button
                    onClick={confirmSurvivalLimitedPeriods}
                    className="text-xs font-semibold px-3 py-1.5 rounded-lg"
                    style={{ background: '#1A3D2B', color: 'white' }}
                  >
                    Set
                  </button>
                </div>
              )}
              {selectedSurvivalOption === 'expire_on_date' && (
                <div className="flex items-center gap-2 pl-1">
                  <input
                    type="date"
                    value={survivalExpiryDate}
                    onChange={e => setSurvivalExpiryDate(e.target.value)}
                    className="text-xs border rounded-lg px-2 py-1.5"
                    style={{ borderColor: 'rgba(26,61,43,0.15)' }}
                  />
                  <button
                    onClick={confirmSurvivalExpiryDate}
                    className="text-xs font-semibold px-3 py-1.5 rounded-lg"
                    style={{ background: '#1A3D2B', color: 'white' }}
                  >
                    Set
                  </button>
                </div>
              )}
              {/* Other — the ONLY survival choice that calls the AI at all.
                  Translating produces a PROPOSAL (survivalTranslatedPreview),
                  never auto-applied — the reviewer must explicitly confirm
                  it below before it becomes survivalResolution/reviewer_policy. */}
              {selectedSurvivalOption === 'other' && (
                <div className="space-y-1.5 pl-1">
                  <textarea
                    value={survivalFreeText}
                    onChange={e => { setSurvivalFreeText(e.target.value); setSurvivalTranslatedPreview(null) }}
                    placeholder="Describe how this should work"
                    rows={2}
                    className="w-full text-xs border rounded-lg p-2"
                    style={{ borderColor: 'rgba(26,61,43,0.15)' }}
                  />
                  <button
                    onClick={translateSurvivalFreeText}
                    disabled={survivalTranslating}
                    className="text-xs font-semibold px-3 py-1.5 rounded-lg disabled:opacity-40"
                    style={{ background: '#1A3D2B', color: 'white' }}
                  >
                    {survivalTranslating ? <i className="ti ti-loader-2 animate-spin" style={{ fontSize: 13 }} /> : 'Translate'}
                  </button>
                  {survivalTranslatedPreview && (
                    <div className="rounded-lg p-2 space-y-1.5" style={{ background: '#FFFDF5', border: '1px solid rgba(217,167,90,0.35)' }}>
                      <p className="text-[9px] font-bold uppercase tracking-widest" style={{ color: '#92400E' }}>Verdix proposes</p>
                      <p className="text-[11px]" style={{ color: '#78350F' }}>{survivalTranslatedPreview.calculation_summary ?? describeSurvivalResolution(survivalTranslatedPreview)}</p>
                      <button
                        onClick={confirmSurvivalTranslatedPreview}
                        className="text-xs font-semibold px-3 py-1.5 rounded-lg"
                        style={{ background: '#1A3D2B', color: 'white' }}
                      >
                        Confirm this treatment
                      </button>
                    </div>
                  )}
                </div>
              )}
              {survivalErrorMsg && <p className="text-[11px]" style={{ color: '#DC2626' }}>{survivalErrorMsg}</p>}
              {survivalResolution && (
                <p className="text-[11px] flex items-center gap-1" style={{ color: '#0B5C36' }}>
                  <i className="ti ti-circle-check-filled" style={{ fontSize: 12 }} />
                  Treatment selected — {describeSurvivalResolution(survivalResolution)}
                </p>
              )}
            </div>
          )}
          {errorMsg && <p className="text-xs" style={{ color: '#DC2626' }}>{errorMsg}</p>}
          <div className="flex gap-2">
            {/* Combined primary action — accounts for both the top-level
                recommendation (may need generate()'s re-interpretation step
                if the reviewer picked a different option than Verdix's own)
                and the survival sub-field (always a fast client-side merge,
                never re-interpretation). An unresolved survival sub-field
                always blocks first, regardless of the top-level state — a
                reviewer can't confirm a whole card while one of its
                sub-questions is still open. */}
            {(() => {
              const topLevelChanged = aiProposal.state === 'verdix_recommends' && selectedOption != null && selectedOption !== aiRecommendedOptionId
              const label = topLevelChanged
                ? 'Confirm selected treatment'
                : survivalResolution
                  ? (survivalIsRecommendation && selectedSurvivalOption === survivalRecommendedOptionId ? 'Confirm recommendation' : 'Confirm selected treatment')
                  : aiProposal.state === 'verdix_recommends' ? 'Confirm recommendation'
                    : ruleType === 'service_credit' ? serviceCreditConfirmLabel(creditType) : 'Confirm & apply'
              const handleClick = () => { if (topLevelChanged) generate(); else confirmProposal() }
              return (
                <button
                  onClick={handleClick}
                  disabled={phase === 'confirming' || survivalSelectionPending}
                  title={survivalSelectionPending ? 'Select a treatment above to continue' : undefined}
                  className="flex-1 py-2 rounded-xl text-sm font-semibold transition-colors disabled:opacity-40"
                  style={{ background: '#1A3D2B', color: 'white' }}
                >
                  {phase === 'confirming' ? <i className="ti ti-loader-2 animate-spin" style={{ fontSize: 13 }} /> : label}
                </button>
              )
            })()}
            <button
              onClick={() => setPhase('input')}
              disabled={phase === 'confirming'}
              className="px-4 py-2 rounded-xl text-sm text-stone hover:text-ink border transition-colors disabled:opacity-40"
              style={{ borderColor: 'rgba(26,61,43,0.15)' }}
            >
              Edit interpretation
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
              {/* Item 5 — heading + one short fact, then choices immediately
                  below (unchanged). A single short sentence, not the AI's
                  full reasoning paragraph — that stays available under
                  More details, never inline here by default. */}
              {(() => {
                const text = aiProposal.reasoning || 'Contract does not specify how this should be handled — nothing is preselected.'
                const { short, truncated } = truncateSentences(text, 1, 140)
                return (
                  <>
                    <p className="text-xs" style={{ color: '#7F1D1D' }}>{short}</p>
                    {truncated && (
                      <button onClick={() => setShowFullReasoning(v => !v)} className="text-[11px] font-medium mt-1 hover:underline" style={{ color: '#991B1B' }}>
                        {showFullReasoning ? 'Hide details' : 'More details'}
                      </button>
                    )}
                    {truncated && showFullReasoning && <p className="text-xs mt-1.5" style={{ color: '#7F1D1D' }}>{text}</p>}
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
            <FactList rows={Object.entries(proposal).map(([field, value]) => ({
              label: field.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()),
              value: field === 'amount' && typeof value === 'number' ? fmt(value, currency) : String(value),
            }))} />
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
              {phase === 'confirming'
                ? <i className="ti ti-loader-2 animate-spin" style={{ fontSize: 13 }} />
                : ruleType === 'service_credit' ? serviceCreditConfirmLabel(creditType) : 'Confirm & apply'}
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
  // Whole-interpretation provenance (trigger/rate/basis, mode/amount, tier
  // method, ...) — see confirm-rule/route.ts's decisionProvenance. Distinct
  // from a service credit's own per-sub-field eligibility_provenance/
  // survival_provenance, which live directly on approved_interpretation.
  // application_rule instead. Absent on rows written before the
  // 20260821000003_commercial_rule_provenance.sql migration ran.
  decision_provenance?: 'reviewer_policy' | 'contract_derived' | null
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

// A credit's product-facing name, distinct from CREDIT_BASIS_LABEL above
// (which labels the BASIS field, not the credit itself) — "Annual Rebate"
// reads naturally where "Rebate basis" would not. Falls back to the
// credit's own description/CREDIT_BASIS_LABEL wherever a credit_type isn't
// one of these three named product concepts.
const CREDIT_TYPE_LABEL: Record<string, string> = { rebate: 'Annual Rebate', conditional_credit: 'Growth Credit', service_credit: 'Service Credit' }
// Icon per credit_type for the Confirmed billing rules cards — falls back
// to the same receipt icon the review-panel Service credits section
// already uses for anything not one of these three named product concepts.
const CREDIT_TYPE_ICON: Record<string, string> = { rebate: 'ti-percentage', conditional_credit: 'ti-rocket', service_credit: 'ti-clock-check' }

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

// Shared label for FieldProvenance — never invents a badge for a field with
// no real provenance record (null/undefined stays unlabeled) since a
// fabricated "Clear from source"/"Reviewer policy" on a field this codebase
// never actually graded would misrepresent it. See lib/types.ts's
// FieldProvenance and isProvenanceResolved (lib/commercial-rule-status.ts) —
// 'verdix_recommends' is deliberately absent here too: a rule reaching this
// persistent confirmed-rules section has already cleared that gate, so only
// the three resolving values are ever shown. 'organization_rulebook' (Step
// 5C) reads "Organization policy", not "Verdix recommendation" — it was an
// org's own confirmed default applying, never AI interpretation.
function provenanceLabel(p?: string | null): string | null {
  return p === 'contract_derived' ? 'Clear from source'
    : p === 'reviewer_policy' ? 'Reviewer policy'
    : p === 'organization_rulebook' ? 'Organization policy'
    : null
}

// Small icon per parameter row, matched heuristically off the label text
// rather than threading an icon through every params.push(...) call site —
// the label vocabulary here is small and stable (cadence/date fields,
// trigger, scope, exclusions, repeatability, balance), so a substring match
// stays accurate without coupling every card builder to a fixed icon list.
// Falls back to a plain bullet for anything unmatched, never a wrong icon.
function paramIcon(label: string): string {
  const l = label.toLowerCase()
  if (l.includes('billing period') || l.includes('partial-period') || l.includes('effective')) return 'ti-calendar'
  if (l.includes('trigger')) return 'ti-bolt'
  if (l.includes('eligible') || l.includes('applies to')) return 'ti-list-check'
  if (l.includes('excluded')) return 'ti-circle-x'
  if (l.includes('repeatable')) return 'ti-repeat'
  if (l.includes('unused balance')) return 'ti-wallet'
  if (l.includes('cap')) return 'ti-gauge'
  if (l.includes('frequency')) return 'ti-refresh'
  return 'ti-point-filled'
}

// Final amendment — the outcome states app/api/org/rulebook/promote
// returns from its server-side canonical-slot dedup check (see that
// route's own header comment). 'ineligible' is a client-only sentinel —
// the server actually returns eligible:false, never a state string, for
// that case; the component folds it in here so a single slotState variable
// covers "still loading" (null) vs. every other outcome.
type PromoteSlotState = 'no_existing' | 'already_covered' | 'existing_draft' | 'draft_conflict' | 'proposed_policy_change' | 'ineligible'
type SlotRuleSummary = { id: string; name: string; status: string; value: unknown; version: number }

// Paid-basis finalization (2026-08-24 audit) — a dedicated, standalone
// decision card, deliberately NOT routed through RuleInterpretationCard's
// generic propose/interpret AI-proposal machinery. That machinery exists
// to grade an AI's own reading of the contract into clear_from_source /
// verdix_recommends / decision_required; this question has none of that —
// the source is confirmed silent on it (lib/paid-basis-finalization.ts),
// so there is nothing for an AI to propose. Reusing RuleInterpretationCard
// here would also re-run its 'proposing' phase and force the reviewer back
// through the credit's ENTIRE trigger/rate/cap/application-scope proposal
// just to answer this one new question — exactly what the audit's "do not
// make the reviewer reconfirm those" instruction rules out. Structurally
// the same "no propose-rule pipeline, reviewer's own decision" shape
// confirm-rule/route.ts already uses for partial_period/one_time_fee, just
// addressed via the existing service_credit ruleType (the field lives on
// that credit's own earn_rule) rather than a new RuleType.
function PaidBasisFinalizationCard({
  jobId, creditId, sourceClause, existingInterpretation, onApplied,
}: {
  jobId: string
  creditId: string
  sourceClause: string
  // The credit's full, already-confirmed interpretation — sent back
  // unchanged except for earn_rule.paid_basis_finalization_policy, so
  // every other already-resolved field (trigger, rate, cap, application
  // scope) survives this confirmation exactly as it was.
  existingInterpretation: Record<string, unknown>
  onApplied: () => void
}) {
  const [saving, setSaving] = useState<'deadline_cutoff' | 'full_attribution' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const choose = async (policy: 'deadline_cutoff' | 'full_attribution') => {
    setSaving(policy)
    setError(null)
    try {
      const earnRule = (existingInterpretation.earn_rule as Record<string, unknown> | null) ?? {}
      const res = await fetch(`/api/jobs/${jobId}/confirm-rule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ruleType: 'service_credit',
          creditId,
          sourceClause,
          reviewerInput: policy === 'deadline_cutoff'
            ? 'Reviewer selected: cut off the paid basis at the contractual calculation deadline.'
            : 'Reviewer selected: include Contract-Year-attributable payments received after the calculation deadline.',
          aiProposedInterpretation: null,
          approvedInterpretation: { ...existingInterpretation, earn_rule: { ...earnRule, paid_basis_finalization_policy: policy } },
          earnRuleProvenance: { paidBasisFinalization: 'reviewer_policy' },
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) throw new Error(data.error ?? 'Could not save this decision.')
      onApplied()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save this decision.')
      setSaving(null)
    }
  }

  const OPTIONS: { id: 'deadline_cutoff' | 'full_attribution'; label: string; description: string }[] = [
    { id: 'deadline_cutoff', label: 'Cut off at calculation deadline', description: 'Only qualifying fees paid by the 30-day calculation boundary count.' },
    { id: 'full_attribution', label: 'Include late Contract-Year payments', description: 'Fees attributable to the Contract Year should still count if paid later.' },
  ]

  return (
    <div className="rounded-xl p-3" style={{ background: '#FEF2F2', border: '1px solid #FECACA' }}>
      <p className="text-[10px] font-bold uppercase tracking-widest mb-1.5" style={{ color: '#7F1D1D' }}>
        <i className="ti ti-help-circle mr-1" />Decision required · Paid-basis finalization
      </p>
      <p className="text-xs leading-relaxed mb-3" style={{ color: '#7F1D1D' }}>
        The agreement says the rebate is based on transaction-processing fees actually paid for the Contract Year and must be calculated within 30 days after year end. It does not specify how to treat Contract-Year fees paid after that calculation boundary.
      </p>
      <div className="space-y-2">
        {OPTIONS.map(opt => (
          <button
            key={opt.id}
            onClick={() => choose(opt.id)}
            disabled={saving !== null}
            className="w-full text-left rounded-lg p-2.5 transition-colors disabled:opacity-60"
            style={{ background: 'white', border: '1px solid rgba(127,29,29,0.2)' }}
          >
            <p className="text-xs font-semibold text-ink">{opt.label}{saving === opt.id ? ' · Saving…' : ''}</p>
            <p className="text-[11px] text-stone mt-0.5">{opt.description}</p>
          </button>
        ))}
      </div>
      {error && <p className="text-[11px] mt-2" style={{ color: '#B91C1C' }}>{error}</p>}
    </div>
  )
}

// Step 5D — Organization Rulebook controls attached to a service credit's
// "Unused-balance policy" line on the confirmed card. Renders one of two
// mutually-exclusive states, matching survival_provenance exactly (never
// both, never neither — a field is either a reviewer's own contract-local
// decision or an organization default, per the Step 4 precedence this whole
// subsystem is built on):
//   'reviewer_policy'      -> one of five states depending on what already
//                              occupies this decision's canonical policy
//                              slot (final amendment, item 7) — never just
//                              "Use as organization default" unconditionally:
//                                no_existing            -> "Use as organization default"
//                                already_covered         -> "Covered by organization policy" + View policy
//                                existing_draft           -> "Organization policy draft created" + View draft
//                                draft_conflict            -> points at Settings -> Organization Rulebook
//                                proposed_policy_change    -> "This decision differs from your organization
//                                                              policy" + Propose policy change
//   'organization_rulebook' -> "View policy" (item 11) + "Override for this
//                              agreement" (item 12).
// Any other provenance (contract_derived, verdix_recommends, or unresolved)
// renders nothing — promotion only makes sense for an explicit reviewer
// decision, and there is no organization policy to view/override otherwise.
//
// The server remains the authoritative dedup boundary (see the promote
// route) — slotState here is only ever what the server most recently
// reported, re-fetched fresh at both mount and every click, never
// something this component decides on its own.
function OrganizationPolicyControls({
  jobId, creditId, carryForward, survivalProvenance, ruleId, ruleVersion, onChanged,
}: {
  jobId: string
  creditId: string
  carryForward: boolean | 'unclear'
  survivalProvenance?: string | null
  ruleId?: string | null
  ruleVersion?: number | null
  onChanged: () => void
}) {
  const [mode, setMode] = useState<'idle' | 'promote-preview' | 'view-policy' | 'override'>('idle')
  const [preview, setPreview] = useState<{ scopeSummary: { ruleTypeLabel: string; applicationTimingLabel: string; treatmentLabel: string } } | null>(null)
  const [policyDetail, setPolicyDetail] = useState<OrganizationRuleRecord | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  // null = not yet known (still loading, or not applicable — see the
  // fetch effect's own guard). Populated by the SAME promote dry-run call
  // the preview step already made — this just moves that call earlier
  // (mount time, not click time) so the right button/state renders before
  // the reviewer does anything, per item 7's "client state must not be the
  // dedup boundary, but the client must still SHOW the server's boundary
  // up front" requirement.
  const [slotState, setSlotState] = useState<PromoteSlotState | null>(null)
  const [slotExistingRule, setSlotExistingRule] = useState<SlotRuleSummary | null>(null)
  // Final read-model amendment — the rule that is CURRENTLY APPLICABLE
  // (temporally in effect right now) for this slot, independent of
  // slotState/slotExistingRule above (which prioritize a draft successor
  // when one exists, correct for THEIR original dedup purpose but wrong
  // for "what would Use organization policy revert me to" — see the
  // /api/org/rulebook/promote route's own comment). Deliberately sourced
  // from the route's `currentlyApplicableRule` field, NOT `activeRule` —
  // `activeRule` is status='active' only, which a future-dated row can
  // also satisfy (see organization-rulebook-display.ts's 'future' display
  // group); `currentlyApplicableRule` re-runs it through the production
  // temporal matcher (effectiveFrom/effectiveTo vs now) server-side. null
  // = no rule is currently applicable to this scope; undefined-vs-null is
  // not distinguished here since "not yet loaded" is already covered by
  // slotState === null in the render guard below.
  const [currentlyApplicableRule, setCurrentlyApplicableRule] = useState<SlotRuleSummary | null>(null)
  // Starts genuinely unselected (never pre-filled from the organization
  // policy's current value) — "Save override" stays disabled until the
  // reviewer has explicitly clicked one of the two options below, even if
  // what they click happens to match the organization's own current value.
  // Without this, opening the panel and clicking Save immediately would
  // silently convert organization_rulebook -> reviewer_policy while
  // RETAINING the org policy's value with no real decision ever made —
  // exactly the gap this component must not have.
  const [overrideValue, setOverrideValue] = useState<boolean | null>(null)
  // Every app/api/org/rulebook/* route requires requireOrg('admin')
  // server-side — that remains the real security boundary. This is purely
  // a UX improvement: a 'member'-role reviewer would otherwise see "Use as
  // organization default" / "View policy" and get a bare 403 on click.
  // Fetched once per card instance (cheap, cached by the browser) rather
  // than threading org role through the whole page's already-large prop
  // chain. Defaults to hidden (null = "not yet known") rather than
  // optimistically showing the control while this resolves.
  const [isOrgAdmin, setIsOrgAdmin] = useState<boolean | null>(null)
  useEffect(() => {
    let cancelled = false
    fetch('/api/org').then(r => r.ok ? r.json() : null).then(data => {
      if (!cancelled) setIsOrgAdmin(data ? (data.role === 'admin' || data.role === 'owner') : false)
    }).catch(() => { if (!cancelled) setIsOrgAdmin(false) })
    return () => { cancelled = true }
  }, [])

  // Final amendment, item 7 — fetches the canonical-slot dedup state
  // EAGERLY (mount time), not only when the reviewer clicks a button, so
  // the correct state (already_covered/existing_draft/draft_conflict/
  // proposed_policy_change/no_existing) can be rendered from the start
  // instead of always defaulting to "Use as organization default" and
  // only discovering an existing draft/policy after the click. Only runs
  // for the branch this actually applies to (reviewer_policy + a concrete
  // boolean value — the same gate the render logic below uses) and only
  // once the reviewer's role is known, since the route is admin-only.
  useEffect(() => {
    if (survivalProvenance !== 'reviewer_policy' || typeof carryForward !== 'boolean') return
    if (isOrgAdmin !== true) return
    let cancelled = false
    fetch('/api/org/rulebook/promote', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, creditId }),
    }).then(r => r.json()).then(data => {
      if (cancelled) return
      if (data.eligible) { setSlotState(data.state); setSlotExistingRule(data.existingRule ?? null); setCurrentlyApplicableRule(data.currentlyApplicableRule ?? null) }
      else setSlotState('ineligible')
    }).catch(() => { if (!cancelled) setSlotState('ineligible') })
    return () => { cancelled = true }
  }, [jobId, creditId, survivalProvenance, carryForward, isOrgAdmin])

  async function openPromotePreview() {
    setBusy(true); setMsg(null)
    const res = await fetch('/api/org/rulebook/promote', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, creditId }),
    })
    const data = await res.json().catch(() => ({}))
    setBusy(false)
    if (!res.ok || !data.eligible) { setMsg({ ok: false, text: data.message ?? data.error ?? 'Not eligible to promote.' }); return }
    // Always re-sync slotState from this fresh call too — the mount-time
    // fetch could be stale by the time the reviewer actually clicks.
    setSlotState(data.state)
    setSlotExistingRule(data.existingRule ?? null)
    setCurrentlyApplicableRule(data.currentlyApplicableRule ?? null)
    if (data.state !== 'no_existing' && data.state !== 'proposed_policy_change') {
      // Something now exists that makes a NEW draft/successor pointless —
      // stay on the idle branch so the up-to-date state (already_covered/
      // existing_draft/draft_conflict) renders instead of a stale preview.
      return
    }
    setPreview(data.preview)
    setMode('promote-preview')
  }

  async function confirmPromote() {
    setBusy(true); setMsg(null)
    const res = await fetch('/api/org/rulebook/promote', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, creditId, confirm: true }),
    })
    const data = await res.json().catch(() => ({}))
    setBusy(false)
    if (!res.ok || !data.eligible) { setMsg({ ok: false, text: data.error ?? data.message ?? 'Failed to create draft.' }); return }
    setMode('idle')
    setSlotState(data.state)
    setSlotExistingRule(data.existingRule ?? (data.rule ? { id: data.rule.id, name: data.rule.name, status: data.rule.status, value: data.rule.value, version: data.rule.version } : null))
    setMsg({
      ok: true,
      text: data.state === 'proposed_policy_change'
        ? 'Created as a draft successor to the current policy — nothing changes until it is approved in Settings → Organization Rulebook.'
        : 'Created as a draft organization policy — nothing changes until it is approved in Settings → Organization Rulebook.',
    })
  }

  async function viewRule(id: string | null | undefined) {
    if (!id) return
    setBusy(true); setMsg(null)
    const res = await fetch(`/api/org/rulebook/${id}`)
    const data = await res.json().catch(() => ({}))
    setBusy(false)
    if (!res.ok) { setMsg({ ok: false, text: 'Could not load policy details.' }); return }
    setPolicyDetail(data.rule)
    setMode('view-policy')
  }
  // Kept as a thin wrapper — the organization_rulebook branch below still
  // calls this by its original name.
  const openViewPolicy = () => viewRule(ruleId)

  // Submits directly to confirm-rule with the minimal payload needed —
  // bypasses propose-rule entirely (the current value/provenance is
  // already known from persisted state, there is nothing for the AI to
  // read). applicationRuleProvenance.survival: 'reviewer_policy' is exactly
  // what a picker-driven override already produces elsewhere on this page;
  // confirm-rule's own buildCreditApplicationRule applies it the same way
  // regardless of which UI control produced the request. Never touches the
  // organization rule itself — this route has no such write path (item 12).
  async function submitOverride() {
    // Belt-and-braces alongside the button's own disabled state — never
    // submit without an explicit reviewer choice, even if this function
    // were somehow invoked another way in the future.
    if (overrideValue === null) return
    setBusy(true); setMsg(null)
    const res = await fetch(`/api/jobs/${jobId}/confirm-rule`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ruleType: 'service_credit', creditId,
        reviewerInput: 'Reviewer override for this agreement (Organization Rulebook policy overridden locally)',
        aiProposedInterpretation: null,
        approvedInterpretation: { application_rule: { carry_forward: overrideValue } },
        applicationRuleProvenance: { survival: 'reviewer_policy' as const },
      }),
    })
    const data = await res.json().catch(() => ({ error: `Unexpected response from server (${res.status})` }))
    setBusy(false)
    if (!res.ok && !data.propagation) { setMsg({ ok: false, text: data.error ?? 'Failed to save override.' }); return }
    setMode('idle')
    onChanged()
  }

  // The counterpart to submitOverride/Override for this agreement —
  // returns a contract-specific reviewer_policy override back to whatever
  // the currently active organization policy says. Deliberately does NOT
  // hard-code slotExistingRule's value into this request (that would be
  // exactly the "cache the previous policy value client-side" anti-pattern
  // item 7 rules out) — carry_forward: 'unclear' + survival: null (the
  // explicit revert signal buildCreditApplicationRule checks for) asks
  // confirm-rule to re-resolve fresh, server-side, against whatever is
  // active as of right now (see confirm-rule/route.ts's requestsReResolution).
  // Only ever reachable from a state where an active organization rule for
  // this exact slot is already confirmed to exist (proposed_policy_change/
  // already_covered — both require activeRule to be present; see
  // classifyOrganizationPolicySlotOutcome), so this can never silently
  // "revert" to a draft/disabled/scheduled-but-not-yet-effective policy.
  async function revertToOrganizationPolicy() {
    setBusy(true); setMsg(null)
    const res = await fetch(`/api/jobs/${jobId}/confirm-rule`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ruleType: 'service_credit', creditId,
        reviewerInput: 'Revert to organization policy for this agreement',
        aiProposedInterpretation: null,
        // approvedInterpretation is still required by the route's generic
        // validation but is never consulted for this action — the server
        // decides the value, rule id/version, and provenance entirely on
        // its own (see confirm-rule/route.ts's revertSurvivalToOrganizationPolicy
        // branch). This client never claims a value, a rule, or a
        // provenance for this action — only the intent.
        approvedInterpretation: {},
        revertSurvivalToOrganizationPolicy: true,
      }),
    })
    const data = await res.json().catch(() => ({ error: `Unexpected response from server (${res.status})` }))
    setBusy(false)
    if (!res.ok) {
      const text = data.error === 'policy_no_longer_applicable'
        ? 'No active organization policy currently applies anymore — your existing choice for this agreement is unchanged. Refresh to see the latest state.'
        : data.error === 'not_eligible_for_revert'
          ? 'This field is not currently a contract-specific override, so there is nothing to revert.'
          : data.message ?? data.error ?? 'Failed to revert to organization policy.'
      setMsg({ ok: false, text })
      return
    }
    // 207 (Multi-Status) is still res.ok (2xx) — a real write happened but a
    // downstream mirror (e.g. contract_meter_mappings) failed; distinct from
    // the two reject cases above, which never write anything at all.
    // setMode('idle') in both success branches — harmless when this was
    // reached via the "Use organization policy" button directly (mode is
    // already idle), necessary when reached via saveOverrideOrRevert's
    // same-value normalization from the "Change override" picker (mode
    // would otherwise stay stuck on 'override' after a successful revert).
    if (data.propagation && data.ok === false) {
      setMode('idle')
      setMsg({ ok: false, text: 'Reverted, but a downstream update failed — check Confirmed billing rules.' })
      onChanged()
      return
    }
    setMode('idle')
    setMsg({ ok: true, text: 'Reverted to the organization policy for this agreement.' })
    onChanged()
  }

  // Item 6 — dispatch, not a third write path. If the reviewer's chosen
  // override value happens to equal the currently active organization
  // policy's own value, submitting it as a fresh reviewer_policy would
  // create a redundant, same-value override that only obscures the real
  // provenance (it IS the organization default, just mislabeled as an
  // agreement-specific exception). Normalize that one case to the real
  // revert action instead — still the same hardened, server-authoritative
  // revertSurvivalToOrganizationPolicy path, never a value/rule/version
  // asserted by the client. Every other chosen value still goes through
  // submitOverride exactly as before.
  async function saveOverrideOrRevert() {
    if (overrideValue === null) return
    if (currentlyApplicableRule && overrideValue === currentlyApplicableRule.value) {
      await revertToOrganizationPolicy()
      return
    }
    await submitOverride()
  }

  // Every app/api/org/rulebook/* route is requireOrg('admin') — a
  // 'member'-role reviewer would only ever see these controls fail with a
  // 403. isOrgAdmin === null means "still loading"; treated the same as
  // false (hidden) rather than flashing an actionable control that then
  // disappears once the real role is known.
  const canManageRulebook = isOrgAdmin === true

  if (survivalProvenance === 'reviewer_policy' && typeof carryForward === 'boolean') {
    if (!canManageRulebook) return null
    // Still loading the slot state — render nothing rather than flash
    // "Use as organization default" and then swap to a different state a
    // moment later (the same discipline canManageRulebook's own null-case
    // comment above already applies to role loading).
    if (slotState === null) return null

    const proposingChange = slotState === 'proposed_policy_change'
    return (
      <div className="mt-2">
        {/* Post-override read model fix — this block used to be driven
            entirely by slotState (the PROMOTION dedup classifier, which
            checks a draft successor BEFORE an active rule — correct for
            ITS job of never creating a second competing draft). Reused
            unmodified here, that meant a never-activated draft successor
            (e.g. v2) silently hid the fact that a DIFFERENT rule (v1) is
            actually active/applicable and governing this agreement right
            now — the card showed "View draft" / a policy detail panel as
            if it were the current default, with no way to change the
            override or revert to what's actually applicable. Now driven
            primarily by currentlyApplicableRule (a separate,
            always-independent, TEMPORALLY-GATED lookup — see the promote
            route's own comment: status='active' alone is not enough, a
            row can be active but future-dated) — a draft successor is
            still shown, but only ever as an explicitly-labeled "Draft
            policy change · Not active", never as the current default. */}
        {mode !== 'promote-preview' && mode !== 'view-policy' && mode !== 'override' && (
          <div className="rounded-xl p-3" style={{ background: '#FFFDF5', border: '1px solid rgba(217,167,90,0.35)' }}>
            <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: '#92400E' }}>Reviewer policy</p>
            {/* "Override" only makes sense when there's an active org
                policy this decision actually overrides. When the contract
                was silent and no org policy applies to this scope, the
                reviewer made a standalone decision, not an override of
                anything — wording (and the "Change override"/"Change
                decision" button below) reflects which case this is. */}
            <p className="text-[11px] text-stone mb-2">{currentlyApplicableRule ? 'Agreement-specific override' : 'Agreement-specific decision'}</p>
            {currentlyApplicableRule ? (
              <p className="text-[11px] text-stone">
                Organization default: <span className="font-medium text-ink">{currentlyApplicableRule.value ? 'Carry forward until fully used' : 'Expires after next invoice'}</span>
                {' '}<span className="text-stone/70">· Active · v{currentlyApplicableRule.version}</span>
              </p>
            ) : (
              // Item 7, scenario E — no policy is currently applicable to
              // this scope (either none exists, or it exists but is
              // future-dated and not yet in effect); "Use organization
              // policy" is deliberately absent below, not merely
              // disabled, so there is nothing misleading to click.
              <p className="text-[11px] text-stone">No active organization policy currently applies to this scope.</p>
            )}
            {/* slotExistingRule here is always a status='draft' row (see
                findOrganizationRulesForSlot/classifyOrganizationPolicySlotOutcome
                — draftRule is by definition status='draft', effective_from
                null) — it has never been activated and therefore has no
                future effective time. "Scheduled change" is reserved for a
                genuinely future-dated ACTIVE row (organization-rulebook-
                display.ts's 'future' group), a state this branch cannot
                reach — so this is always a draft, labeled as such. */}
            {slotState === 'existing_draft' && slotExistingRule && (
              <p className="text-[10px] text-stone/70 mt-1">
                Draft policy change · v{slotExistingRule.version} · <span className="italic">Not active</span> —{' '}
                <button onClick={() => viewRule(slotExistingRule?.id)} disabled={busy} className="underline hover:text-ink">view draft</button>
              </p>
            )}
            {slotState === 'draft_conflict' && (
              <p className="text-[10px] text-stone/70 mt-1">
                A conflicting draft also exists for this policy —{' '}
                <Link href="/settings/rulebook" className="underline hover:text-ink">resolve it in Settings → Organization Rulebook</Link>.
              </p>
            )}
            <div className="flex gap-2 mt-2">
              {/* Reopens the same picker/mechanism "Override for this
                  agreement" already uses (submitOverride) — a different
                  entry point into an unchanged action, not a new one. */}
              <button onClick={() => { setOverrideValue(null); setMode('override') }} disabled={busy} className="text-[11px] font-medium px-2.5 py-1 rounded-lg border" style={{ borderColor: 'rgba(26,61,43,0.15)' }}>
                {currentlyApplicableRule ? 'Change override' : 'Change decision'}
              </button>
              {currentlyApplicableRule && (
                <button onClick={revertToOrganizationPolicy} disabled={busy} className="text-[11px] font-medium px-2.5 py-1 rounded-lg border" style={{ borderColor: 'rgba(26,61,43,0.15)' }}>
                  Use organization policy
                </button>
              )}
            </div>
            {/* Secondary, unrelated to reverting — promoting THIS
                agreement's own override UP into becoming/updating the org
                default. Unchanged mechanism (openPromotePreview/
                confirmPromote), kept but visually de-emphasized below the
                two primary controls above. */}
            {(slotState === 'no_existing' || slotState === 'ineligible') && (
              <button onClick={openPromotePreview} disabled={busy} className="text-[10px] font-medium text-forest hover:underline mt-2 flex items-center gap-1">
                <i className="ti ti-gavel" style={{ fontSize: 11 }} /> Use as organization default
              </button>
            )}
            {slotState === 'already_covered' && (
              <button onClick={() => viewRule(slotExistingRule?.id)} disabled={busy} className="text-[10px] font-medium text-forest hover:underline mt-2">View policy</button>
            )}
            {slotState === 'proposed_policy_change' && (
              <button onClick={openPromotePreview} disabled={busy} className="text-[10px] font-medium text-forest hover:underline mt-2">
                Propose this as the new organization policy instead
              </button>
            )}
          </div>
        )}
        {mode === 'override' && (
          <div className="mt-2 rounded-xl p-3" style={{ background: '#FAFAF9', border: '1px solid rgba(26,61,43,0.1)' }}>
            <p className="text-[11px] font-medium text-ink mb-2">This changes this agreement only — the organization policy itself is not affected.</p>
            <div className="flex flex-col gap-1.5 mb-2">
              <label className="flex items-center gap-2 text-[11px] text-ink">
                <input type="radio" checked={overrideValue === true} onChange={() => setOverrideValue(true)} />
                Carry forward until fully used{currentlyApplicableRule?.value === true ? ' (current organization policy)' : ''}
              </label>
              <label className="flex items-center gap-2 text-[11px] text-ink">
                <input type="radio" checked={overrideValue === false} onChange={() => setOverrideValue(false)} />
                Expires after next invoice{currentlyApplicableRule?.value === false ? ' (current organization policy)' : ''}
              </label>
            </div>
            {/* Item 6 — choosing the value that already matches the
                current organization default saves via revertToOrganizationPolicy
                instead (organization_rulebook provenance), not a redundant
                same-value reviewer_policy row. See saveOverrideOrRevert. */}
            <div className="flex gap-2">
              <button onClick={saveOverrideOrRevert} disabled={busy || overrideValue === null} className="text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-forest text-white disabled:opacity-50">
                {busy ? 'Saving…' : 'Save override'}
              </button>
              <button onClick={() => { setOverrideValue(null); setMode('idle') }} className="text-[11px] px-3 py-1.5 rounded-lg border border-forest/20 text-stone">Cancel</button>
            </div>
          </div>
        )}
        {mode === 'promote-preview' && preview && (
          <div className="mt-2 rounded-xl p-3" style={{ background: '#EFF6FF', border: '1px solid rgba(30,64,175,0.2)' }}>
            <p className="text-[11px] font-semibold mb-2" style={{ color: '#1E40AF' }}>
              {proposingChange ? 'Proposed organization policy change — preview' : 'New organization policy — preview'}
            </p>
            <div className="text-[11px] mb-1.5">
              <span className="text-stone">Where it applies</span>
              <div className="text-ink font-medium">{preview.scopeSummary.ruleTypeLabel}</div>
            </div>
            <div className="text-[11px] mb-2">
              <span className="text-stone">What Verdix will do</span>
              <div className="text-ink font-medium">{preview.scopeSummary.treatmentLabel}</div>
            </div>
            {/* Context only — never part of match scope (item 3). This
                credit's own application timing has no bearing on whether
                this policy applies; only rule_type does (see
                ORGANIZATION_POLICY_SCOPE_DIMENSIONS). */}
            <p className="text-[10px] text-stone/60 mb-2">
              This credit&apos;s own application timing: {preview.scopeSummary.applicationTimingLabel} (not part of this policy&apos;s scope)
            </p>
            <p className="text-[10px] text-stone/80 mb-2 leading-relaxed">
              Explicit contract language always overrides this policy. A reviewer can override it for an individual agreement.
            </p>
            <div className="flex gap-2">
              <button onClick={confirmPromote} disabled={busy} className="text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-forest text-white disabled:opacity-50">
                {busy ? 'Saving…' : proposingChange ? 'Propose change' : 'Create as draft'}
              </button>
              <button onClick={() => setMode('idle')} className="text-[11px] px-3 py-1.5 rounded-lg border border-forest/20 text-stone">Cancel</button>
            </div>
          </div>
        )}
        {mode === 'view-policy' && policyDetail && (
          <div className="mt-2 rounded-xl p-3" style={{ background: '#EFF6FF', border: '1px solid rgba(30,64,175,0.2)' }}>
            <p className="text-[11px] font-semibold mb-1" style={{ color: '#1E40AF' }}>{policyDetail.name} · v{policyDetail.version}</p>
            <p className="text-[11px] text-ink mb-1">{describeMatchConditions(policyDetail.matchConditions).join(' · ')}</p>
            <p className="text-[11px] text-stone mb-2">{describeEffectivePeriod(policyDetail.effectiveFrom, policyDetail.effectiveTo)}</p>
            <button onClick={() => setMode('idle')} className="text-[11px] text-stone underline">Close</button>
          </div>
        )}
        {msg && <p className={`text-[11px] mt-1 ${msg.ok ? 'text-forest' : 'text-red-600'}`}>{msg.text}</p>}
      </div>
    )
  }

  if (survivalProvenance === 'organization_rulebook') {
    return (
      <div className="mt-2">
        <div className="flex items-center gap-3">
          {/* GET /api/org/rulebook/[id] is also requireOrg('admin') — a
              'member' reviewer can still see the "Organization policy"
              badge/summary already rendered elsewhere on this card, just
              not this route-backed detail lookup. "Override for this
              agreement" stays visible regardless of role, same as every
              other edit action already on this page (e.g. "Edit
              interpretation") — none of those are role-gated today either;
              narrowing just this one new action would be an inconsistent,
              half-fix rather than a real one. */}
          {canManageRulebook && (
            <button onClick={openViewPolicy} disabled={busy || !ruleId} className="text-[11px] font-medium text-forest hover:underline flex items-center gap-1 disabled:opacity-50">
              <i className="ti ti-eye" style={{ fontSize: 12 }} /> View policy{ruleVersion ? ` (v${ruleVersion})` : ''}
            </button>
          )}
          <button
            onClick={() => { setOverrideValue(null); setMode(mode === 'override' ? 'idle' : 'override') }}
            className="text-[11px] font-medium text-stone hover:text-ink flex items-center gap-1"
          >
            <i className="ti ti-user-edit" style={{ fontSize: 12 }} /> Override for this agreement
          </button>
        </div>
        {mode === 'view-policy' && policyDetail && (
          <div className="mt-2 rounded-xl p-3" style={{ background: '#EFF6FF', border: '1px solid rgba(30,64,175,0.2)' }}>
            <p className="text-[11px] font-semibold mb-1" style={{ color: '#1E40AF' }}>{policyDetail.name} · v{policyDetail.version}</p>
            <p className="text-[11px] text-ink mb-1">{describeMatchConditions(policyDetail.matchConditions).join(' · ')}</p>
            <p className="text-[11px] text-stone mb-2">{describeEffectivePeriod(policyDetail.effectiveFrom, policyDetail.effectiveTo)}</p>
            <button onClick={() => setMode('idle')} className="text-[11px] text-stone underline">Close</button>
          </div>
        )}
        {mode === 'override' && (
          <div className="mt-2 rounded-xl p-3" style={{ background: '#FAFAF9', border: '1px solid rgba(26,61,43,0.1)' }}>
            <p className="text-[11px] font-medium text-ink mb-2">This changes this agreement only — the organization policy itself is not affected.</p>
            <div className="flex flex-col gap-1.5 mb-2">
              <label className="flex items-center gap-2 text-[11px] text-ink">
                <input type="radio" checked={overrideValue === true} onChange={() => setOverrideValue(true)} />
                Carry forward until fully used{carryForward === true ? ' (current organization policy)' : ''}
              </label>
              <label className="flex items-center gap-2 text-[11px] text-ink">
                <input type="radio" checked={overrideValue === false} onChange={() => setOverrideValue(false)} />
                Expires after next invoice{carryForward === false ? ' (current organization policy)' : ''}
              </label>
            </div>
            {/* Deliberately starts with NEITHER option selected (see
                overrideValue's own comment) — picking the option that
                happens to match the current organization policy is still a
                real, explicit choice (a reviewer may want THIS agreement
                pinned to that treatment even if the org default later
                changes), it just requires the same active click as picking
                the other one. Save stays disabled until either is clicked. */}
            <div className="flex gap-2">
              <button onClick={submitOverride} disabled={busy || overrideValue === null} className="text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-forest text-white disabled:opacity-50">
                {busy ? 'Saving…' : 'Save override'}
              </button>
              <button onClick={() => { setOverrideValue(null); setMode('idle') }} className="text-[11px] px-3 py-1.5 rounded-lg border border-forest/20 text-stone">Cancel</button>
            </div>
          </div>
        )}
        {msg && <p className={`text-[11px] mt-1 ${msg.ok ? 'text-forest' : 'text-red-600'}`}>{msg.text}</p>}
      </div>
    )
  }

  return null
}

// Read-only card for the "Confirmed billing rules" section — the persistent,
// post-confirmation counterpart to RuleInterpretationCard's pre-confirmation
// review flow. Deliberately does not reuse RuleInterpretationCard itself:
// that component's 'applied' phase is a one-line "confirmed and applied"
// banner with no way to redisplay what was actually approved days/weeks
// earlier (it only ever holds the state from the confirm click that just
// happened, in-memory). This renders directly from contract_terms — the
// durable operational value — so it survives reload, is never blank on a
// freshly-opened job, and can never show a different value than what
// billing/invoicing itself reads.
function ConfirmedRuleCard({
  icon, typeLabel, title, sourceClause, interpretation, params, provenance, auditReviewer, auditDate, onViewSource, onEdit, footer,
}: {
  // Tabler icon name (e.g. "ti-wallet"), no "ti " prefix — chosen per rule
  // kind at the card-builder call site, not guessed here.
  icon: string
  typeLabel: string
  title: string
  sourceClause?: string | null
  interpretation: string
  params: { label: string; value: string }[]
  // Usually one entry — a rule bundling two independently-graded questions
  // (a service credit's eligibility vs. its unused-balance survival) passes
  // two, each labeled, so the card never claims a single verdict for
  // sub-fields that were actually resolved through different routes.
  provenance: { label: string; value?: string | null }[]
  auditReviewer?: string | null
  auditDate?: string | null
  onViewSource?: () => void
  onEdit: () => void
  // Step 5D — an optional, rule-kind-specific control block rendered below
  // the provenance badges (Organization Rulebook promotion/view-policy/
  // override-for-this-agreement, today only ever passed for a service
  // credit's survival sub-field). Every other rule kind passes nothing —
  // this card stays generic; the specifics live entirely at the call site.
  footer?: React.ReactNode
}) {
  const resolvedProvenance = provenance.filter(p => provenanceLabel(p.value) != null)
  return (
    <div className="rounded-2xl p-6 bg-white" style={{ border: '1px solid rgba(26,61,43,0.1)', boxShadow: '0 1px 2px rgba(26,61,43,0.04)' }}>
      <div className="flex items-start gap-4 mb-4">
        <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 bg-mint-soft">
          <i className={`ti ${icon} text-forest`} style={{ fontSize: 22 }} />
        </div>
        <div className="min-w-0 pt-0.5">
          <p className="text-[10px] font-bold uppercase tracking-widest mb-1.5" style={{ color: '#0B5C36' }}>{typeLabel}</p>
          <p className="text-lg font-semibold text-ink leading-snug mb-1.5">{title}</p>
          {interpretation && <p className="text-[13px] text-stone leading-relaxed">{interpretation}</p>}
        </div>
      </div>
      {/* No inline verbatim quote by default (concision pass) — "View
          source" below is the sole source affordance, avoiding a duplicate
          of the same clause on one card. sourceClause is still accepted as
          a prop (some callers pass it) but only ever used to decide whether
          this card has a source to show at all — never rendered directly. */}
      {params.length > 0 && (
        <div className="pt-4 mb-4" style={{ borderTop: '1px solid rgba(26,61,43,0.08)' }}>
          <FactList dense rows={params.map(p => ({ label: p.label, value: p.value, icon: paramIcon(p.label) }))} />
        </div>
      )}
      {resolvedProvenance.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-1">
          {resolvedProvenance.map((p, i) => {
            const label = provenanceLabel(p.value)!
            // Three distinct treatments: green (contract-grounded), amber
            // (reviewer decision), blue (Step 5C — an organization's own
            // confirmed policy, never AI interpretation, never the contract
            // itself — see provenanceLabel's own comment above).
            const colors = label === 'Clear from source' ? { bg: 'rgba(11,92,54,0.1)', fg: '#0B5C36' }
              : label === 'Organization policy' ? { bg: 'rgba(30,64,175,0.1)', fg: '#1E40AF' }
              : { bg: 'rgba(180,83,9,0.1)', fg: '#92400E' }
            return (
              <span key={i} className="text-[11px] font-semibold px-3 py-1 rounded-full" style={{ background: colors.bg, color: colors.fg }}>
                {resolvedProvenance.length > 1 ? `${p.label}: ${label}` : label}
              </span>
            )
          })}
        </div>
      )}
      {footer}
      <div className="flex items-center justify-between gap-3 pt-4 mt-4" style={{ borderTop: '1px solid rgba(26,61,43,0.08)' }}>
        <p className="text-[11px] text-stone/70">
          {(auditReviewer || auditDate) && <>Confirmed{auditReviewer ? ` by ${auditReviewer}` : ''}{auditDate ? ` · ${auditDate}` : ''}</>}
        </p>
        <div className="flex items-center gap-4 flex-shrink-0">
          {onViewSource && (
            <button
              onClick={onViewSource}
              title={sourceClause ?? undefined}
              className="flex items-center gap-1 text-[12px] font-medium text-forest hover:underline"
            >
              <i className="ti ti-external-link" style={{ fontSize: 13 }} /> View source clause
            </button>
          )}
          <button onClick={onEdit} className="flex items-center gap-1 text-[12px] font-medium text-stone hover:text-ink">
            <i className="ti ti-pencil" style={{ fontSize: 13 }} /> Edit interpretation
          </button>
        </div>
      </div>
    </div>
  )
}

function EditCommercialRuleDrawer({
  jobId, ruleType, contractUnitType, discountId, creditId, cadenceLabel, waiverExpiry, ruleTitle, currency, currentRecord, historyRecords, onClose, onApplied,
}: {
  jobId: string
  ruleType: RuleType
  contractUnitType?: string
  // Which discount this drawer edits, when ruleType is 'discount' — required
  // so a contract with several discounts only ever touches the one being edited.
  discountId?: string
  // Same addressing pattern as discountId, when ruleType is 'service_credit'.
  creditId?: string
  // Only meaningful for ruleType 'partial_period'. See RuleInterpretationCard.
  cadenceLabel?: string
  // See RuleInterpretationCard's identical prop.
  waiverExpiry?: boolean
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
  const options = currentRecord ? optionsForEdit(ruleType, currentRecord.approved_interpretation, cadenceLabel, waiverExpiry) : optionsForRuleType(ruleType, cadenceLabel, null, waiverExpiry)
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
              <FactList rows={Object.entries(currentRecord.approved_interpretation)
                .filter(([f]) => !NARRATIVE_FIELDS.includes(f) && f !== 'requires_confirmation' && f !== 'confirmation_reason')
                .map(([field, value]) => ({
                  label: FIELD_LABELS[field] ?? field.replace(/_/g, ' '),
                  value: formatFieldValue(field, value, currency),
                }))}
              />
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
                <FactList rows={Object.entries(proposal).filter(([f]) => !NARRATIVE_FIELDS.includes(f)).map(([field, value]) => {
                  const oldValue = currentRecord?.approved_interpretation?.[field]
                  const changed = changedFields.includes(field)
                  return {
                    label: FIELD_LABELS[field] ?? field.replace(/_/g, ' '),
                    value: (
                      <>
                        {changed && currentRecord ? (
                          <span className="text-stone/50">{formatFieldValue(field, oldValue, currency)} → </span>
                        ) : null}
                        <span className={changed ? 'text-ink' : ''}>{formatFieldValue(field, value, currency)}</span>
                      </>
                    ),
                  }
                })} />
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
  oneTimeFees,
  unsupportedCommercialMechanisms,
  fieldSources,
  operationalEventEvidence,
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
  workload,
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
  // Step 11B — the minimal OneTimeFee review path.
  oneTimeFees?: OneTimeFee[]
  // Step 17B0, item F — commercial mechanisms extraction captured but
  // cannot execute yet — must remain visible, never silently dropped.
  unsupportedCommercialMechanisms?: UnsupportedCommercialMechanism[]
  // Item 6 — maps a field key (e.g. "base_monthly_fee") to the contract
  // section it was extracted from, e.g. "1.1 Base Platform Fee" — the
  // same field the main page's own line-items view already reads
  // (terms.field_sources), threaded in here so the base-fee/recurring-fee
  // billing-period cards can show their own adjacent source link even
  // though the base fee itself isn't addressed by a fee_label the way a
  // one-time fee is (see findSourceSection for that path instead).
  fieldSources?: Record<string, string>
  // Step 13 — real operational_event_evidence rows for this job.
  operationalEventEvidence?: OperationalEventEvidence[]
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
  // Agreement A final amendment, item 3 — computed ONCE by the owning page
  // component (same inputs as its own summary/readiness banner: terms,
  // meterMappingSummary, unresolvedInteractions, vatConfigured,
  // job?.operational_event_evidence) and passed down here, rather than this
  // panel independently re-deriving a second computeCommercialRuleWorkload
  // call from its own separately-fetched meterSuggestions/vat. One job
  // state -> one canonical workload object -> every displayed count. Safe
  // because every input that differed between the two former calls
  // (meter-mapping totals, VAT status) is already fetched by both the
  // parent and this panel off the SAME refreshSignal/endpoint, so using the
  // parent's value introduces no staleness — see the removed local
  // computeCommercialRuleWorkload call this replaced for the full history.
  workload: CommercialRuleWorkload
}) {
  const [saving,    setSaving]    = useState<string | null>(null)
  const [resolved,  setResolved]  = useState<Record<string, 'confirmed' | 'corrected'>>({})
  const [editing,   setEditing]   = useState<string | null>(null)
  const [previewing, setPreviewing] = useState<string | null>(null)
  const [draftPrice, setDraftPrice] = useState<Record<string, string>>({})
  const [draftName,  setDraftName]  = useState<Record<string, string>>({})
  const [saveError,  setSaveError]  = useState<Record<string, string>>({})
  // Step 13 — the occurredAt draft input per fee, keyed by fee_id. Defaults
  // lazily (today's date) only when a reviewer actually opens the input,
  // not eagerly for every fee on render.
  const [evidenceDateDraft, setEvidenceDateDraft] = useState<Record<string, string>>({})
  // Concision pass — Extraction notes is secondary diagnostic text (a
  // point-in-time extraction snapshot, not a live outstanding-decision
  // list, per its own existing comment below), collapsed by default so it
  // doesn't compete with the actual review cards for attention.
  const [extractionNotesOpen, setExtractionNotesOpen] = useState(false)
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({})

  // Item 6 — every LineItem already carries its own source_section (the
  // same field buildLineItems stamps on every generated row). Reused
  // here, never hardcoded, so a review card's source link is driven by
  // the actual extracted provenance for THAT fee, not a section number
  // typed into the JSX. Matched by product_name, mirroring how
  // buildLineItems itself addresses a one-time fee's own generated row.
  const findSourceSection = (feeLabel: string): string | undefined =>
    items.find(i => i.product_name === feeLabel)?.source_section ?? undefined

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

  // Same canonical useVatConfig hook every VAT surface in the product uses
  // (main GUI's pre-approval row, BillingSummaryCard, and this drawer's own
  // VatReviewCard below) — refreshSignal keeps this in sync with whichever
  // surface last saved, and onVatStatusChange feeds the page's own
  // vatConfigured state so the Approve gate sees one canonical value. Still
  // needed for the VAT card UI below even though its aggregate .configured
  // no longer independently feeds a second computeCommercialRuleWorkload
  // call — see the `workload` prop's own doc comment.
  const vat = useVatConfig(jobId, refreshSignal, onVatStatusChange)

  // Agreement A final amendment, item 3 — canonical readiness is now the
  // `workload` prop, computed ONCE by the owning page component and passed
  // down (see its doc comment above), never a second independent
  // computeCommercialRuleWorkload call built from this panel's own
  // separately-fetched meterSuggestions/vat. This replaces the old
  // resolvedCount/items.length header, which tracked per-LINE-ITEM
  // confirmation (a mechanism the metric-scoped rule cards — minimum
  // commitment, partial period, base-fee proration, tier calculation —
  // never actually write to, so it stayed stuck at "0 of N" regardless of
  // how many of those cards were genuinely confirmed.
  const commercialWorkload = workload
  const usageMappingsOutstanding = Math.max(0, commercialWorkload.meterMapping.total - commercialWorkload.meterMapping.confirmed)
  const commercialDecisionsOutstanding = commercialWorkload.totalToConfirm + commercialWorkload.interactionsToConfirm
  const vatOutstandingInPanel = !commercialWorkload.vat.configured
  const needsReviewInPanel = items.filter(i => i.confidence_score < 0.95 && !(i.id in corrections)).length
  const totalBlockers = commercialDecisionsOutstanding + usageMappingsOutstanding + (vatOutstandingInPanel ? 1 : 0) + needsReviewInPanel
  // Same presentational split as the main page's readinessBreakdown — see
  // countSourceConfirmations. Derived from serviceCredits' own persisted
  // source_clause/description, never from AI-proposal/interaction state.
  const sourceConfirmationsInPanel = countSourceConfirmations(commercialWorkload.blockers, serviceCredits)
  const genuineDecisionsInPanel = commercialDecisionsOutstanding - sourceConfirmationsInPanel
  const readinessBreakdownInPanel = [
    genuineDecisionsInPanel > 0 && `${genuineDecisionsInPanel} commercial decision${genuineDecisionsInPanel > 1 ? 's' : ''}`,
    sourceConfirmationsInPanel > 0 && `${sourceConfirmationsInPanel} source confirmation${sourceConfirmationsInPanel > 1 ? 's' : ''}`,
    usageMappingsOutstanding > 0 && `${usageMappingsOutstanding} usage mapping${usageMappingsOutstanding > 1 ? 's' : ''}`,
    vatOutstandingInPanel && '1 VAT',
    needsReviewInPanel > 0 && `${needsReviewInPanel} extracted field${needsReviewInPanel > 1 ? 's' : ''}`,
  ].filter((x): x is string => typeof x === 'string')

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
            <span className="text-[10px] font-semibold uppercase tracking-widest text-stone flex-1">{typeLabel}</span>
            <SourceClauseLink section={fieldSources?.overage_tiers} onViewSource={onViewSource} />
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
                : `${totalBlockers} item${totalBlockers > 1 ? 's' : ''} to review — ${readinessBreakdownInPanel.join(' · ')}`}
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
                {/* Item 5 follow-up — every discount in this group traces
                    back to the SAME extracted field_sources.discounts
                    section (extraction records one section per FIELD, not
                    per discount item), so the link is placed on EACH card
                    below rather than only on this shared group title —
                    with more than one discount, a title-only link is only
                    ever adjacent to the first card and requires scrolling
                    back up for every card after it, which reads as
                    "detached" in practice even though it technically
                    precedes the group. */}
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
                            <span className="text-[10px] font-semibold uppercase tracking-widest text-stone flex-1">Discount structure</span>
                            <SourceClauseLink section={fieldSources?.discounts} onViewSource={onViewSource} />
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
                            discountScope={{ affectedComponents: d.affected_components, possiblyAffectedComponents: d.possibly_affected_components }}
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
            const unresolvedCredits = (serviceCredits ?? []).filter(c => isServiceCreditUnresolved(c))
            if (unresolvedCredits.length === 0) return null
            return (
              <div>
                {/* Item 5 follow-up — same rationale as the Discounts group
                    above: field_sources.service_credits is one section per
                    FIELD, not per credit item, and this group can hold
                    several credits (e.g. Annual Rebate / Growth Credit /
                    SLA Service Credit) — the link is placed on EACH card,
                    not just this shared group title, so it's visible
                    without scrolling back up regardless of which card is
                    in view. */}
                <div className="flex items-center gap-2 mb-3">
                  {/* "Service credits" undersold what this section actually
                      holds — rebates and other non-SLA credit types too
                      (e.g. Annual Rebate, Growth/Expansion Credit), not just
                      service-availability credits. Display label only —
                      credit_type/ServiceCredit/service_credits (the field,
                      variable, and API names) are all unchanged. */}
                  <p className="text-[10px] font-bold uppercase tracking-widest text-stone">Credits &amp; rebates</p>
                  <div className="flex-1 h-px" style={{ background: 'rgba(26,61,43,0.1)' }} />
                </div>
                <div className="space-y-3">
                  {unresolvedCredits.map((c, i) => {
                    const creditId = c.credit_rule_id ?? String((serviceCredits ?? []).indexOf(c))
                    const label = c.description || `Service credit ${i + 1}`
                    // 2026-08-24 -> 2026-08-30 audit — a credit whose main
                    // interpretation AND application_rule are ALREADY
                    // resolved, but whose NEW monetary-basis-recognition
                    // and/or paid-basis-finalization sub-questions are the
                    // sole reason isServiceCreditUnresolved still flags it,
                    // must never be sent back through RuleInterpretationCard's
                    // full propose/interpret flow — that would force the
                    // reviewer to reconfirm trigger/rate/cap/eligibility/
                    // carry-forward all over again for questions they never
                    // asked about. Shows the small, dedicated card instead;
                    // only a genuinely fresh/still-open credit falls through
                    // to the full AI-assisted flow.
                    const interp = c.interpretation
                    const mainInterpretationResolved = !!interp && !interp.requires_confirmation
                      && !!interp.application_rule && !interp.application_rule.requires_confirmation
                    const monetaryBasisOpen = mainInterpretationResolved
                      && isMonetaryBasisRecognitionApplicable(interp!)
                      && !isProvenanceResolved(interp!.monetary_basis_recognition_provenance)
                    const onlyPaidBasisOpen = mainInterpretationResolved
                      && isPaidBasisFinalizationApplicable(interp!)
                      && !isProvenanceResolved(interp!.earn_rule?.paid_basis_finalization_provenance)
                    return (
                      <div key={creditId} className="rounded-2xl border overflow-hidden" style={{ borderColor: '#FAC775', background: 'white' }}>
                        <div className="px-4 pt-4 pb-3">
                          <div className="flex items-center gap-1.5 mb-2.5">
                            <i className="ti ti-receipt-refund text-stone" style={{ fontSize: 12 }} />
                            <span className="text-[10px] font-semibold uppercase tracking-widest text-stone flex-1">{CREDIT_BASIS_LABEL[c.credit_type ?? 'other'] ?? 'Credit basis'}</span>
                            <SourceClauseLink section={fieldSources?.service_credits} onViewSource={onViewSource} />
                          </div>
                          <p className="text-sm font-medium text-ink leading-snug mb-3">{label}</p>
                          {monetaryBasisOpen && interp ? (
                            // No reviewer picker exists for this field
                            // deliberately (2026-08-30 audit, Part 3) — the
                            // contract already answers it; a genuinely
                            // unclear/synthetic case has no in-app decision
                            // to offer either. This is a data-classification
                            // gap, not a reviewer decision, so it's shown as
                            // an honest, non-interactive notice rather than
                            // a fabricated A/B choice.
                            <div className="rounded-xl p-3" style={{ background: '#F5F5F4', border: '1px solid rgba(120,113,108,0.25)' }}>
                              <p className="text-[10px] font-bold uppercase tracking-widest mb-1.5" style={{ color: '#57534E' }}>
                                <i className="ti ti-database-off mr-1" />Monetary basis not yet classified
                              </p>
                              <p className="text-xs leading-relaxed" style={{ color: '#57534E' }}>
                                Whether this credit&apos;s percentage basis is amounts actually paid or the stated component amount hasn&apos;t been classified from the source yet. This isn&apos;t a decision made here — it comes directly from the contract text and needs a data correction, not a reviewer choice.
                              </p>
                            </div>
                          ) : onlyPaidBasisOpen && interp ? (
                            <PaidBasisFinalizationCard
                              jobId={jobId}
                              creditId={creditId}
                              sourceClause={c.source_clause ?? label}
                              existingInterpretation={interp as unknown as Record<string, unknown>}
                              onApplied={onRefresh}
                            />
                          ) : (
                            /* Same as the Discounts section above — no separate
                               static "why review" blurb; the AI proposal card's
                               own clause-specific reasoning is the single
                               source of truth. */
                            <RuleInterpretationCard
                              jobId={jobId}
                              kind="service_credit"
                              creditId={creditId}
                              creditType={c.credit_type}
                              sourceClause={c.source_clause ?? label}
                              currency={cur ?? 'EUR'}
                              onApplied={onRefresh}
                            />
                          )}
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
                {/* Item 5 follow-up — a rule interaction is a DERIVED
                    comparison between an already-sourced service credit and
                    an already-sourced discount/escalator, not its own
                    extracted field — links to the credit's own group source
                    (its own card, addressed via creditId, is the anchor this
                    card resolves) rather than inventing a second combined
                    reference. Placed on each card (this group can hold more
                    than one candidate), not just the shared group title. */}
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
                          <span className="text-[10px] font-semibold uppercase tracking-widest text-stone flex-1">Interaction to confirm</span>
                          <SourceClauseLink section={fieldSources?.service_credits} onViewSource={onViewSource} />
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
              ambiguity (or one already resolved) shows nothing here.
              Deliberately does NOT hardcode a "Decision required" badge or
              generic "does not specify" prose here — RuleInterpretationCard
              runs its own propose-rule analysis of the real source_clause
              and owns its own state badge (Clear from source / Verdix
              recommendation / Decision required), exactly like every other
              metric-scoped rule card (renderMetricRuleCard above). A
              contract that actually resolves the period-boundary question
              in its source text (e.g. an explicit "Contract Month" clause)
              must show as resolved, not be contradicted by stale outer
              copy asserting the contract is silent. */}
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
                    <div className="rounded-2xl border overflow-hidden" style={{ borderColor: 'rgba(26,61,43,0.12)', background: 'white' }}>
                      <div className="px-4 pt-4 pb-3">
                        <div className="flex items-center gap-1.5 mb-2.5">
                          <i className="ti ti-calendar-exclamation text-stone" style={{ fontSize: 12 }} />
                          <span className="text-[10px] font-semibold uppercase tracking-widest text-stone flex-1">Platform fee billing period</span>
                          <SourceClauseLink section={fieldSources?.base_monthly_fee ?? fieldSources?.base_annual_fee} onViewSource={onViewSource} />
                        </div>
                        <RuleInterpretationCard
                          jobId={jobId}
                          kind="base_fee_proration"
                          contractUnitType={BASE_FEE_PRORATION_SENTINEL}
                          cadenceLabel={cadenceNoun(contractBillingFrequency)}
                          contractPeriodLabel={contractMonthLabel(contractStartDate)}
                          waiverExpiry={baseFeeHasExpiringWaiver(discounts)}
                          sourceClause={baseFeeProration?.source_clause ?? ''}
                          currency={cur ?? 'EUR'}
                          onApplied={onRefresh}
                        />
                      </div>
                    </div>
                  )}
                  {unresolvedFees.map((f, i) => (
                    <div key={f.fee_label ?? i} className="rounded-2xl border overflow-hidden" style={{ borderColor: 'rgba(26,61,43,0.12)', background: 'white' }}>
                      <div className="px-4 pt-4 pb-3">
                        <div className="flex items-center gap-1.5 mb-2.5">
                          <i className="ti ti-calendar-exclamation text-stone" style={{ fontSize: 12 }} />
                          <span className="text-[10px] font-semibold uppercase tracking-widest text-stone flex-1">{f.fee_label} billing period</span>
                          <SourceClauseLink section={findSourceSection(f.fee_label)} onViewSource={onViewSource} />
                        </div>
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

          {/* Step 17B0, item F — commercial mechanisms/fee shapes
              extraction genuinely captured but cannot execute yet (a
              derived-rate/percentage-schedule fee, a rolling-average
              volume/band-migration rule, ...). Distinct from the
              unresolved-and-confirmable cards above: there is nothing a
              reviewer can pick or type to resolve these — the mechanism
              itself has no runtime yet — so this card is informational
              only, never gates on a reviewer action, and (per item F's
              explicit requirement) must never disappear even though
              nothing here can be confirmed. Unsupported terms may still
              block approval/execution elsewhere (readiness checks), but
              this is the one place a reviewer can always see WHAT was
              found and WHY it's blocked, with its exact operational
              dependencies. */}
          {(() => {
            const unsupportedFees = (additionalRecurringFees ?? []).filter(f => f.unresolved_kind === 'unsupported_semantics')
            const unsupportedMechanisms = unsupportedCommercialMechanisms ?? []
            if (unsupportedFees.length === 0 && unsupportedMechanisms.length === 0) return null
            return (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-stone">Unsupported commercial mechanisms</p>
                  <div className="flex-1 h-px" style={{ background: 'rgba(26,61,43,0.1)' }} />
                </div>
                <div className="space-y-3">
                  {unsupportedFees.map((f, i) => (
                    <div key={`fee:${f.fee_label ?? i}`} className="rounded-2xl border overflow-hidden" style={{ borderColor: '#FECACA', background: 'white' }}>
                      <div className="px-4 pt-4 pb-3">
                        <div className="flex items-center gap-1.5 mb-2">
                          <i className="ti ti-alert-hexagon text-red-500" style={{ fontSize: 12 }} />
                          <span className="text-sm font-medium text-ink flex-1">{f.fee_label}</span>
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-red-600 bg-red-50 px-2 py-0.5 rounded-full">Unsupported</span>
                        </div>
                        {f.description && <p className="text-xs text-stone leading-relaxed mb-2">{f.description}</p>}
                        {f.source_clause && (
                          <p className="text-[11px] text-stone/70 leading-relaxed mb-2 italic">&ldquo;{f.source_clause}&rdquo;</p>
                        )}
                        {!!f.required_operational_inputs?.length && (
                          <p className="text-[11px] text-stone">
                            Depends on: {f.required_operational_inputs.join(', ')}
                          </p>
                        )}
                        {f.derived_metric && (
                          <p className="text-[11px] text-stone mt-1">
                            Rate formula: {f.derived_metric.formula} (inputs: {f.derived_metric.raw_inputs.join(', ')})
                          </p>
                        )}
                        <p className="text-[11px] text-stone/60 mt-2">Cannot be billed automatically yet — no execution runtime for this rate mechanism. Preserved for review and manual handling; will never silently disappear.</p>
                      </div>
                    </div>
                  ))}
                  {unsupportedMechanisms.map((m, i) => (
                    <div key={`mech:${i}`} className="rounded-2xl border overflow-hidden" style={{ borderColor: '#FECACA', background: 'white' }}>
                      <div className="px-4 pt-4 pb-3">
                        <div className="flex items-center gap-1.5 mb-2">
                          <i className="ti ti-alert-hexagon text-red-500" style={{ fontSize: 12 }} />
                          <span className="text-sm font-medium text-ink flex-1">{m.kind.replace(/_/g, ' ')}</span>
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-red-600 bg-red-50 px-2 py-0.5 rounded-full">Unsupported</span>
                        </div>
                        <p className="text-xs text-stone leading-relaxed mb-2">{m.description}</p>
                        {m.source_clause && (
                          <p className="text-[11px] text-stone/70 leading-relaxed mb-2 italic">&ldquo;{m.source_clause}&rdquo;</p>
                        )}
                        {!!m.required_operational_inputs?.length && (
                          <p className="text-[11px] text-stone">
                            Depends on: {m.required_operational_inputs.join(', ')}
                          </p>
                        )}
                        <p className="text-[11px] text-stone/60 mt-2">Not itself a billable fee — governs how another fee&apos;s rate/band changes over time. No execution runtime yet; preserved for review and manual handling.</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
          })()}

          {/* One-time fees — Step 11B, the minimal review path for
              lib/one-time-fee.ts's buildOneTimeFeeConfirmation. No AI
              proposal, no free-text-to-JSON translation (unlike
              RuleInterpretationCard's flow) — a one-time fee's amount and
              billability are each either already resolved, or a direct
              "confirm what's already there" action, independently
              (item 4). A capability-blocked fee (unresolved_kind:
              'unsupported_semantics') shows no action at all — there is
              nothing a reviewer can confirm their way out of (item 3). */}
          {(() => {
            // Step 12 — a semantically-resolved event condition is no
            // longer "unresolved" (isOneTimeFeeUnresolved correctly stops
            // counting it), but it must stay visible: confirming WHAT the
            // trigger is is not the same as the trigger having happened.
            // Kept here, not in isOneTimeFeeUnresolved, since this is a
            // display/visibility concern, not a readiness/blocking one —
            // Approve's own gate (via RequiredOperationalEventMissingBlocker)
            // is the actual enforcement point, unaffected by this filter.
            const feesNeedingAttention = (oneTimeFees ?? []).filter(f =>
              isOneTimeFeeUnresolved(f) ||
              f.unresolved_kind === 'unsupported_semantics' ||
              (f.billability_condition?.kind === 'event' &&
                (f.billability_provenance === 'contract_derived' || f.billability_provenance === 'reviewer_policy'))
            )
            if (feesNeedingAttention.length === 0) return null

            // billabilityConditionLabel is now module-scope (see near
            // classifyFee above) — item 10, so the Products & Services
            // overview table can share the exact same canonical labels
            // this review card uses, rather than an independent "On
            // delivery"/"Services" fee-type guess that could contradict it.

            // The client only ever says WHICH dimension it is confirming —
            // confirmAmount / confirmBillability, plain booleans — never an
            // asserted provenance value. The server (lib/one-time-fee.ts,
            // via app/api/jobs/[id]/confirm-rule/route.ts) is solely
            // responsible for minting 'reviewer_policy' from that signal.
            const confirmOneTimeFee = async (feeLabel: string, field: 'amount' | 'billability') => {
              const savingKey = `one_time_fee:${feeLabel}:${field}`
              setSaving(savingKey)
              setSaveError(prev => ({ ...prev, [feeLabel]: '' }))
              try {
                const res = await fetch(`/api/jobs/${jobId}/confirm-rule`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    ruleType: 'one_time_fee',
                    contractUnitType: feeLabel,
                    reviewerInput: 'Reviewer confirmed via the one-time fee review card.',
                    aiProposedInterpretation: null,
                    approvedInterpretation: field === 'amount' ? { confirmAmount: true } : { confirmBillability: true },
                  }),
                })
                if (res.ok) {
                  onRefresh()
                } else {
                  const data = await res.json().catch(() => null)
                  setSaveError(prev => ({ ...prev, [feeLabel]: data?.error ?? 'Verdix could not save this confirmation.' }))
                }
              } catch {
                setSaveError(prev => ({ ...prev, [feeLabel]: 'Verdix could not save this confirmation.' }))
              } finally {
                setSaving(null)
              }
            }

            // Step 13 — the browser submits only { subjectId, occurredAt }.
            // It never sends eventType, source, or any commercial-provenance
            // value — the server derives eventType from the persisted
            // billability_condition and always mints source:
            // 'reviewer_attestation' itself (app/api/jobs/[id]/operational-events/attest).
            const recordEvidence = async (feeId: string, feeLabel: string, occurredAt: string) => {
              const savingKey = `one_time_fee:${feeLabel}:evidence`
              setSaving(savingKey)
              setSaveError(prev => ({ ...prev, [feeLabel]: '' }))
              try {
                const res = await fetch(`/api/jobs/${jobId}/operational-events/attest`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ subjectId: feeId, occurredAt }),
                })
                if (res.ok) {
                  onRefresh()
                } else {
                  const data = await res.json().catch(() => null)
                  setSaveError(prev => ({ ...prev, [feeLabel]: data?.error ?? 'Verdix could not record this.' }))
                }
              } catch {
                setSaveError(prev => ({ ...prev, [feeLabel]: 'Verdix could not record this.' }))
              } finally {
                setSaving(null)
              }
            }

            const revokeEvidence = async (feeId: string, feeLabel: string) => {
              const savingKey = `one_time_fee:${feeLabel}:evidence-revoke`
              setSaving(savingKey)
              setSaveError(prev => ({ ...prev, [feeLabel]: '' }))
              try {
                const res = await fetch(`/api/jobs/${jobId}/operational-events/revoke`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ subjectId: feeId }),
                })
                if (res.ok) {
                  onRefresh()
                } else {
                  const data = await res.json().catch(() => null)
                  setSaveError(prev => ({ ...prev, [feeLabel]: data?.error ?? 'Verdix could not revoke this.' }))
                }
              } catch {
                setSaveError(prev => ({ ...prev, [feeLabel]: 'Verdix could not revoke this.' }))
              } finally {
                setSaving(null)
              }
            }

            const EVIDENCE_ACTION_LABELS: Record<string, string> = {
              contract_signature: 'Record signature',
              delivery: 'Record delivery',
              customer_acceptance: 'Record acceptance',
              final_acceptance: 'Record final acceptance',
              change_order_signature: 'Record change order signature',
            }
            const EVIDENCE_RECORDED_LABELS: Record<string, string> = {
              contract_signature: 'Contract signature recorded',
              delivery: 'Delivery recorded',
              customer_acceptance: 'Customer acceptance recorded',
              final_acceptance: 'Final acceptance recorded',
              change_order_signature: 'Change order signature recorded',
            }

            return (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-stone">One-time fees</p>
                  <div className="flex-1 h-px" style={{ background: 'rgba(26,61,43,0.1)' }} />
                </div>
                <div className="space-y-3">
                  {feesNeedingAttention.map((f, i) => {
                    const blocked = f.unresolved_kind === 'unsupported_semantics'
                    const amountResolved = f.amount_provenance === 'contract_derived' || f.amount_provenance === 'reviewer_policy'
                    // Step 12 final amendment — manual_trigger is now purely
                    // an execution PROJECTION (lib/billability-condition.ts):
                    // every confirmed AND unconfirmed 'event' condition
                    // projects to manual_trigger:true, so it can no longer be
                    // read as "genuinely manual, nothing to confirm" once a
                    // record has entered the Step 12 lifecycle
                    // (billability_condition !== undefined) — that would
                    // incorrectly hide the confirm button and mislabel an
                    // UNCONFIRMED event condition as already resolved. Only
                    // a genuine legacy/professional-services fee (no
                    // billability_condition at all) still gets the
                    // manual_trigger-implies-resolved treatment.
                    const isStep12Condition = f.billability_condition !== undefined
                    const genuineManualHold = !isStep12Condition && !!f.manual_trigger
                    const billabilityResolved = genuineManualHold
                      || f.billability_provenance === 'contract_derived' || f.billability_provenance === 'reviewer_policy'
                    return (
                      <div key={f.fee_label ?? i} className="rounded-2xl border overflow-hidden" style={{ borderColor: blocked ? '#FECACA' : '#FAC775', background: 'white' }}>
                        <div className="px-4 pt-4 pb-3">
                          <div className="flex items-center gap-1.5 mb-2.5">
                            <i className="ti ti-receipt text-stone" style={{ fontSize: 12 }} />
                            <span className="text-[10px] font-semibold uppercase tracking-widest text-stone">One-time fee</span>
                          </div>
                          <p className="text-sm font-medium text-ink leading-snug">{f.fee_label}</p>
                          <p className="text-base font-semibold text-ink mb-3">{fmt(f.amount, cur ?? 'EUR')}</p>

                          {blocked ? (
                            <p className="text-[11px] leading-relaxed" style={{ color: '#991B1B' }}>
                              Verdix cannot represent this fee&apos;s billability condition — it does not fit a fixed date, an
                              immediate due, or a supported contractual event (signature, delivery, customer acceptance, final
                              acceptance, signed change order) — so this stays blocked from billing. There is no confirmation
                              that resolves it.
                            </p>
                          ) : (
                            <div className="space-y-2">
                              {/* Amount/Billing condition rows — compact
                                  label/value/action layout (shared FactRow,
                                  same responsive behavior as the review
                                  cards). The action slot alone communicates
                                  open-vs-resolved state — a resolved row
                                  gets a small provenance chip instead of a
                                  button; there is no separate "needs
                                  confirmation"/"confirmed (...)" prose
                                  duplicating what the action already says. */}
                              <FactList rows={[
                                {
                                  label: 'Amount',
                                  value: fmt(f.amount, cur ?? 'EUR'),
                                  action: amountResolved ? (
                                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full inline-flex items-center gap-1 whitespace-nowrap" style={{ background: 'rgba(11,92,54,0.1)', color: '#0B5C36' }}>
                                      <i className="ti ti-check" style={{ fontSize: 10 }} />
                                      {f.amount_provenance === 'contract_derived' ? 'Clear from source' : 'Reviewer policy'}
                                    </span>
                                  ) : (
                                    <button
                                      onClick={() => confirmOneTimeFee(f.fee_label, 'amount')}
                                      disabled={saving === `one_time_fee:${f.fee_label}:amount`}
                                      className="text-[11px] font-medium px-2.5 py-1 rounded-lg border whitespace-nowrap"
                                      style={{ borderColor: 'rgba(26,61,43,0.15)' }}
                                    >
                                      {saving === `one_time_fee:${f.fee_label}:amount` ? 'Confirming…' : 'Confirm'}
                                    </button>
                                  ),
                                },
                                // Step 12 — three distinct billability states, never
                                // conflated: manual_trigger (professional-services,
                                // unrelated to billability_condition); an event
                                // condition that's already confirmed (waiting on
                                // real-world evidence Verdix cannot yet ingest — no
                                // "bill now"/fake-date escape hatch is ever offered
                                // for this state); and the ordinary needs-confirmation
                                // / confirmed case for immediate/fixed_date/unconfirmed
                                // conditions.
                                (() => {
                                  const conditionLabel = billabilityConditionLabel(f.billability_condition)
                                  const eventAwaitingEvidence = f.billability_condition?.kind === 'event' && billabilityResolved
                                  const statusNote = genuineManualHold
                                    ? 'Held for manual delivery confirmation'
                                    : eventAwaitingEvidence
                                      ? 'Interpretation confirmed — waiting for required operational event'
                                      : null
                                  // Preserves the existing null vs undefined
                                  // distinction (lib/billability-condition.ts's
                                  // resolveOneTimeFeeTypeLabel): a genuine
                                  // legacy record (billability_condition
                                  // undefined, isStep12Condition false) reads
                                  // "Manual billing" here — never "On
                                  // delivery" (the old generic fallback),
                                  // and deliberately not "Manual delivery"
                                  // either, since "delivery" is already a
                                  // distinct, canonical contractual
                                  // billability event elsewhere on this same
                                  // card — reusing the word here could
                                  // wrongly imply billing is triggered by
                                  // delivery. Never conflated with "Needs
                                  // review" either — that label is reserved
                                  // for a condition Step 12 actually
                                  // evaluated and found the contract
                                  // genuinely silent on
                                  // (describeBillabilityCondition returned
                                  // null for a defined condition).
                                  const conditionValue = genuineManualHold ? 'Manual billing' : (conditionLabel ?? 'Needs review')
                                  return {
                                    label: 'Billing condition',
                                    value: (
                                      <>
                                        <span>{conditionValue}</span>
                                        {statusNote && <span className="block text-[10px] text-stone mt-0.5 font-normal">{statusNote}</span>}
                                      </>
                                    ),
                                    action: (genuineManualHold || eventAwaitingEvidence) ? undefined
                                      : billabilityResolved ? (
                                        <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full inline-flex items-center gap-1 whitespace-nowrap" style={{ background: 'rgba(11,92,54,0.1)', color: '#0B5C36' }}>
                                          <i className="ti ti-check" style={{ fontSize: 10 }} />
                                          {f.billability_provenance === 'contract_derived' ? 'Clear from source' : 'Reviewer policy'}
                                        </span>
                                      ) : (
                                        <button
                                          onClick={() => confirmOneTimeFee(f.fee_label, 'billability')}
                                          disabled={saving === `one_time_fee:${f.fee_label}:billability`}
                                          className="text-[11px] font-medium px-2.5 py-1 rounded-lg border whitespace-nowrap"
                                          style={{ borderColor: 'rgba(26,61,43,0.15)' }}
                                        >
                                          {saving === `one_time_fee:${f.fee_label}:billability` ? 'Confirming…' : 'Confirm'}
                                        </button>
                                      ),
                                  }
                                })(),
                              ]} />
                              {(() => {
                                // Step 13 — only ever rendered once billability
                                // interpretation is itself resolved (item 16: "Extend
                                // the Step-12 OneTimeFee card only after the billability
                                // interpretation is resolved"). Language deliberately
                                // avoids "Confirm" (already means contractual
                                // interpretation elsewhere on this card) — "Record"/
                                // "occurred" makes clear the reviewer is attesting a
                                // real-world fact, not re-confirming the contract.
                                if (f.billability_condition?.kind !== 'event' || !billabilityResolved || !f.fee_id) return null
                                const eventType = f.billability_condition.event_type
                                const activeEvidence = operationalEventEvidence?.find(
                                  e => e.subjectId === f.fee_id && e.eventType === eventType && e.status === 'active'
                                )
                                const dateKey = f.fee_id
                                // Deliberately blank, not today — recording that a
                                // real-world event occurred must be an intentional
                                // reviewer choice, never a silently-suggested date
                                // that happens to predate signing/Effective Date.
                                const draft = evidenceDateDraft[dateKey] ?? ''
                                const recording = saving === `one_time_fee:${f.fee_label}:evidence`
                                const revoking = saving === `one_time_fee:${f.fee_label}:evidence-revoke`
                                return (
                                  <div className="pt-2 mt-1" style={{ borderTop: '1px solid rgba(26,61,43,0.08)' }}>
                                    {activeEvidence ? (
                                      <div className="flex items-start justify-between gap-2">
                                        <div>
                                          <p className="text-[11px] font-medium text-ink">{EVIDENCE_RECORDED_LABELS[eventType] ?? 'Event recorded'}</p>
                                          <p className="text-[11px] text-stone">Occurred: {new Date(activeEvidence.occurredAt).toLocaleDateString()}</p>
                                          <p className="text-[11px] text-stone">Source: Reviewer attestation</p>
                                        </div>
                                        <button
                                          onClick={() => revokeEvidence(f.fee_id!, f.fee_label)}
                                          disabled={revoking}
                                          className="text-[11px] font-medium px-2.5 py-1 rounded-lg border shrink-0"
                                          style={{ borderColor: 'rgba(220,38,38,0.3)', color: '#DC2626' }}
                                        >
                                          {revoking ? 'Revoking…' : 'Revoke'}
                                        </button>
                                      </div>
                                    ) : (
                                      <div className="flex items-center gap-2 flex-wrap">
                                        <input
                                          type="date"
                                          value={draft}
                                          max={new Date().toISOString().slice(0, 10)}
                                          onChange={e => setEvidenceDateDraft(prev => ({ ...prev, [dateKey]: e.target.value }))}
                                          className="text-[11px] px-2 py-1 rounded-lg border"
                                          style={{ borderColor: 'rgba(26,61,43,0.15)' }}
                                        />
                                        <button
                                          onClick={() => recordEvidence(f.fee_id!, f.fee_label, draft)}
                                          disabled={recording || !draft}
                                          className="text-[11px] font-medium px-2.5 py-1 rounded-lg border"
                                          style={{ borderColor: 'rgba(26,61,43,0.15)' }}
                                        >
                                          {recording ? 'Recording…' : (EVIDENCE_ACTION_LABELS[eventType] ?? 'Record occurrence')}
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                )
                              })()}
                              {saveError[f.fee_label] && (
                                <p className="text-[11px]" style={{ color: '#DC2626' }}>{saveError[f.fee_label]}</p>
                              )}
                            </div>
                          )}
                          {/* Local per-card source link (item 6) — never a
                              detached aggregate block covering several
                              fees at once. */}
                          <div className="mt-3 pt-3" style={{ borderTop: '1px solid rgba(26,61,43,0.08)' }}>
                            <SourceClauseLink section={findSourceSection(f.fee_label)} onViewSource={onViewSource} />
                          </div>
                        </div>
                      </div>
                    )
                  })}
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
                <button
                  onClick={() => setExtractionNotesOpen(v => !v)}
                  className="flex items-center gap-1.5 w-full text-left"
                >
                  <i className="ti ti-note text-stone" style={{ fontSize: 12 }} />
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-stone flex-1">Extraction notes</span>
                  <span className="text-[11px] font-medium text-forest">{extractionNotesOpen ? 'Hide' : 'View notes'}</span>
                </button>
                {/* Secondary diagnostic information, not primary review
                    content (item 10) — collapsed by default. This text is
                    written once, at extraction time, and never rewritten
                    afterward — a policy it flags as unresolved here may
                    since have been confirmed via its own review card above
                    (or may have none at all if it doesn't map to a
                    structured rule type). It is a point-in-time snapshot,
                    not a live list of outstanding decisions — the review
                    cards above and the "items to review" count are the
                    live signal for what's actually still open. */}
                {extractionNotesOpen && (
                  <>
                    <p className="text-xs text-stone leading-relaxed whitespace-pre-line mt-2">{extractionNotes}</p>
                    <p className="text-[10px] text-stone/70 italic mt-2">
                      Reflects the original extraction — a decision mentioned here may already be resolved by a review card above; it is not itself a live outstanding-decision indicator.
                    </p>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Item 2 (final amendment) — this used to be grouped under a
              "Contract §X — View source clause" header per source_section,
              e.g. one shared header covering all of §4.1-4.4's one-time
              fees at once (every one-time-fee row shares the SAME
              field_sources.one_time_fees string — see buildLineItems).
              That header/link is now a genuine duplicate of the local
              SourceClauseLink already attached to each item's own
              specialized review card elsewhere on this page (billability
              cards for one-time fees, proration cards for base/recurring
              fees, metric rule cards for tiers) — removed entirely rather
              than suppressed-when-empty (the prior fix), since every
              relevant review family now carries its own local source
              reference and a second, less precise, combined-section link
              serves no distinct purpose. The per-item cards themselves
              (confidence-gated plain "confirm this value" cards, and the
              metric-scoped rule-card stack) are unchanged — only the
              grouping/header wrapper is gone; items render as one flat list. */}
          <div className="space-y-3">
            {items.map(item => {
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
                          {isRuleInterpretation && <SourceClauseLink section={fieldSources?.escalators} onViewSource={onViewSource} />}
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
  // Step 17A.1 — bumping this restarts the poll effect below (it's in that
  // effect's own dependency array) without duplicating its recursion logic.
  // Needed because retryExtraction fires a fresh POST /execute from the
  // "Extraction failed" screen, well after the original poll chain already
  // stopped at the terminal FAILED status — nothing else would otherwise
  // ever resume polling for the new EXTRACTING run.
  const [pollGeneration, setPollGeneration] = useState(0)
  const [retryingExtraction, setRetryingExtraction] = useState(false)
  const [retryExtractionError, setRetryExtractionError] = useState<string | null>(null)
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
  // Collapsed by default — the Confirmed billing rules section can hold a
  // card per commercial rule plus the usage-input list, which is a lot of
  // vertical space to show unprompted on every page load once a contract
  // has several rules confirmed. The reviewer opens it deliberately via the
  // header, same collapse affordance MeterMappingPanel already uses.
  const [confirmedRulesExpanded, setConfirmedRulesExpanded] = useState(false)

  // Read-only summary for the main-tab meter-mapping status chip — the
  // review-drawer's MeterMappingPanel mount (inside ReviewPanel) is the only
  // place a mapping is actually confirmed/changed; this fetch never writes,
  // so it can't diverge from that panel's own state the way two independent
  // editable mounts of the same component previously could.
  const [meterMappingSummary, setMeterMappingSummary] = useState<{ total: number; confirmed: number }>({ total: 0, confirmed: 0 })
  // Full per-metric rows + the org's available meters — same read-only fetch
  // as meterMappingSummary above (no second request), kept for the "Usage
  // input configuration" cards in the persistent Confirmed billing rules
  // section, which need to say WHERE each metric's data actually comes from
  // (a specific meter, manual entry, derived, or the credit ledger), not
  // just a confirmed/outstanding count.
  type MeterInputRow = { contract_unit_type: string; meter_key: string; confirmed: boolean; input_classification?: 'meter' | 'meter_or_manual_input' | 'derived' | 'persisted_balance'; manual_value_configured?: boolean }
  const [meterInputRows, setMeterInputRows] = useState<MeterInputRow[]>([])
  const [availableMeters, setAvailableMeters] = useState<Array<{ meter_key: string; display_name: string }>>([])
  useEffect(() => {
    // Same out-of-order-response guard as fetchJob's own fetchJobSeq — this
    // effect re-runs on every refreshSignal bump (meter-mapping confirm,
    // VAT save, or any fetchJob() completion), and two bumps in quick
    // succession can dispatch overlapping requests with no guarantee the
    // earlier one's response arrives first; without this guard a late,
    // stale response could overwrite meterMappingSummary/meterInputRows
    // with an outdated count after a newer one already landed.
    let cancelled = false
    fetch(`/api/jobs/${id}/meter-mappings`)
      .then(r => r.json())
      .then((res: { suggestions?: MeterInputRow[]; available_meters?: Array<{ meter_key: string; display_name: string }> }) => {
        if (cancelled) return
        const suggestions = res.suggestions ?? []
        setMeterMappingSummary({
          total: suggestions.length,
          confirmed: suggestions.filter(s => isMeterMappingResolved({ classification: s.input_classification ?? 'meter', confirmed: s.confirmed, meter_key: s.meter_key, manual_value_configured: s.manual_value_configured })).length,
        })
        setMeterInputRows(suggestions)
        setAvailableMeters(res.available_meters ?? [])
      })
      .catch(() => {})
    return () => { cancelled = true }
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
  const [parkedInvoices,  setParkedInvoices]  = useState<Array<{
    id: string; feeId: string | null; feeLabel: string | null; currency: string; baseAmount: number
    metricName: string | null; ratePerUnit: number | null; description: string | null
    billabilityCondition: { kind: 'immediate' } | { kind: 'fixed_date'; date: string }
      | { kind: 'event'; event_type: 'contract_signature' | 'delivery' | 'customer_acceptance' | 'final_acceptance' | 'change_order_signature' } | null
    evidence: { occurredAt: string; recordedAt: string } | null
    plannedInvoiceStatus: string
  }>>([])
  // Bumped after recording operational-event evidence from the Parked
  // Invoices card — included in BillingSummaryCard's own remount key
  // (same existing idiom as rebuildDone/approved below) so billing-summary
  // is re-fetched and parkedInvoices reflects the newly-recorded evidence,
  // without a full page reload. Evidence recording itself never calls
  // Stripe/Remembill/the scheduler — this only refreshes the READ model.
  const [parkedEvidenceTick, setParkedEvidenceTick] = useState(0)
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

  // Review-count state sync fix — every confirm action in this page (rule
  // interpretation, one-time-fee confirm, operational-event evidence,
  // meter-mapping confirm, VAT save, ...) fires this SAME canonical
  // fetchJob() as its "refresh" step, but fire-and-forget — none of those
  // call sites await it (onRefresh/onApplied are typed () => void, called
  // synchronously right after a POST succeeds). Two confirm actions taken
  // in quick succession (e.g. "resolve item 1" immediately followed by
  // "resolve item 2") each dispatch their own independent fetchJob() call,
  // with no cross-call ordering guarantee: nothing prevents the FIRST
  // call's response (reflecting state from before item 2 was resolved)
  // from arriving and calling setJob() AFTER the second, newer call's
  // response already did — silently clobbering the correct, fully-resolved
  // state with a stale one. Because nothing else re-triggers another
  // fetchJob() afterward, that stale state then persists indefinitely
  // (surviving closing the drawer, since the drawer and the top-level
  // banner both read the same now-wrong job/terms state) until a full page
  // reload starts over. fetchJobSeq is a monotonic call counter: each
  // invocation captures its own sequence number and only ever applies its
  // result if no NEWER call has been dispatched since — an old response
  // arriving late is discarded rather than applied, so the canonical state
  // can only ever move forward to what was actually most recently
  // requested, never backward to something already superseded.
  const fetchJobSeq = useRef(0)
  // Readiness audit — a successfully-persisted mutation (confirm-rule, meter
  // mapping, VAT, ...) followed by a refresh that itself fails (network
  // blip, transient 5xx) previously left the UI silently showing whatever
  // job/terms snapshot it had before, forever — no error, no retry, no
  // signal anything was wrong. That's a real risk specifically for a job
  // already at a stable status (READY_TO_APPROVE/PENDING_HUMAN_REVIEW/...),
  // since the poll loop below deliberately stops once a job reaches one of
  // those, so nothing else would ever call fetchJob() again on its own.
  // refreshError surfaces that failure (never rolls back or re-attempts the
  // already-persisted mutation itself — only the READ that follows it) with
  // a manual retry, the same minimal pattern approveError/scheduleBlockers
  // already use elsewhere on this page — not a new fetching mechanism.
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const fetchJob = useCallback(async () => {
    const seq = ++fetchJobSeq.current
    try {
      const res = await fetch(`/api/jobs/${id}`)
      if (!res.ok) {
        if (seq === fetchJobSeq.current) setRefreshError('Could not refresh the latest state — some information on this page may be out of date.')
        return
      }
      const data = await res.json()
      if (seq === fetchJobSeq.current) {
        setJob(data)
        if (data.line_items?.length) setItems(data.line_items)
        setRefreshSignal(s => s + 1)
        setRefreshError(null)
      }

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
            if (seq === fetchJobSeq.current) {
              setJob(data2)
              if (data2.line_items?.length) setItems(data2.line_items)
            }
            return data2
          }
        }
      }

      return data
    } catch {
      // fetch() itself threw (offline, DNS, aborted connection) — same
      // stale-forever risk as a non-OK response, same minimal signal.
      if (seq === fetchJobSeq.current) setRefreshError('Could not refresh the latest state — some information on this page may be out of date.')
      return undefined
    }
  }, [id])

  // Stable top-level callback for EditCommercialRuleDrawer's onApplied — a
  // plain inline arrow function referencing fetchJob here (which closes
  // over the fetchJobSeq ref above) trips react-hooks/refs when constructed
  // inside the surrounding IIFE this drawer renders from; defining it once,
  // outside any nested closure, keeps the exact same behavior without that.
  const handleEditRuleApplied = useCallback(() => {
    setEditingRule(null)
    fetchRuleInterpretations()
    fetchJob()
  }, [fetchJob])

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
      if (cancelled) return
      // Step 17A.1 — a transient fetch failure (flaky network, a dropped
      // request while the tab was backgrounded, ...) used to be treated
      // identically to "reached a terminal status" here (both left `data`
      // falsy), permanently killing the poll chain on a single blip. The
      // job could still be extracting fine server-side; the page would
      // just silently stop finding out, showing an unchanging "processing"
      // spinner forever with no error and no way to tell it apart from a
      // genuine hang. fetchJob already surfaces the failure via
      // refreshError — this loop's own job is only to keep trying, same as
      // it already does for any other non-terminal status.
      if (data && ['PENDING_HUMAN_REVIEW', 'READY_TO_APPROVE', 'COMPLETED', 'FAILED'].includes(data.execute_status)) return
      timer = setTimeout(poll, 3000)
    }
    poll()
    const cycle = setInterval(() => setMsgIdx(i => (i + 1) % PROCESSING_MESSAGES.length), 2000)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      clearInterval(cycle)
    }
  }, [id, pollGeneration])

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

    // Step 15 audit fix — "Retry push" previously called /approve directly,
    // which always rejects a FAILED job (approve/route.ts's claim boundary
    // excludes FAILED on purpose — see its own comment) with a message
    // telling the admin to use "Authorize billing retry" first. That route
    // had no UI path to reach it at all, making retry a dead end. Fixed:
    // authorize first (the resolver-backed safety check now lives there),
    // and only proceed to the real approve call if that succeeds.
    if (isFailed) {
      try {
        const authRes = await fetch(`/api/jobs/${id}/authorize-billing-retry`, { method: 'POST' })
        const authData = await authRes.json()
        if (!authRes.ok) {
          setApproveError(authData.error ?? 'Billing retry could not be authorized.')
          setApproving(false)
          fetchJob()
          return
        }
      } catch {
        setApproveError('Network error — please check your connection and try again.')
        setApproving(false)
        return
      }
    }

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

  // Step 17A.1 — the ONLY retry path for an extraction (not billing-push)
  // failure: calls POST /execute directly, never authorize-billing-retry
  // (that route is for a job that already has contract_terms and a
  // billing-execution attempt — neither exists yet for a job that failed
  // during its first extraction pass). execute/route.ts's own atomic
  // .neq('execute_status', 'EXTRACTING') claim guards against this firing
  // twice concurrently (double-click, or a second tab) and creating a
  // duplicate background pipeline run.
  const retryExtraction = async () => {
    setRetryingExtraction(true)
    setRetryExtractionError(null)
    try {
      const res = await fetch(`/api/jobs/${id}/execute`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setRetryExtractionError(data.error ?? 'Could not restart extraction — please try again.')
        setRetryingExtraction(false)
        return
      }
      // Reflect the new EXTRACTING status immediately, then bump
      // pollGeneration to resume the recursive poll loop below (it already
      // stopped once when this job first reached the terminal FAILED
      // status — nothing else re-triggers it on its own).
      await fetchJob()
      setPollGeneration(g => g + 1)
      setRetryingExtraction(false)
    } catch {
      setRetryExtractionError('Network error — please check your connection and try again.')
      setRetryingExtraction(false)
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
        <p className="text-stone text-sm mb-6">Usually takes under a minute</p>
        {refreshError && (
          <p className="text-xs text-amber-700 mb-4">{refreshError}</p>
        )}
        <Link href="/configure" className="text-xs text-stone hover:text-ink underline underline-offset-2">
          Back to contracts
        </Link>
      </div>
    </div>
  )

  // Step 17A.1 — distinct from isFailed below: this job never even
  // produced a contract_terms row, so it failed somewhere in extraction
  // itself (PDF text extraction, masking, the Claude call, or saving
  // terms) — not in a later billing push, which is what isFailed/the
  // "Push failed" banner further down is about. Structural signal (no
  // terms), not execute_status alone, since both failure modes persist the
  // same execute_status: 'FAILED' value.
  const isExtractionFailed = job.execute_status === 'FAILED' && !terms

  if (isExtractionFailed) return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center max-w-sm">
        <i className="ti ti-alert-circle text-red-500 block mb-4" style={{ fontSize: 32 }} />
        <p className="text-ink font-medium mb-2">Extraction failed</p>
        <p className="text-stone text-sm mb-6">{job.error_message ?? 'Something went wrong while extracting this contract.'}</p>
        {retryExtractionError && (
          <p className="text-xs text-red-600 mb-4">{retryExtractionError}</p>
        )}
        <div className="flex items-center justify-center gap-3">
          <Link href="/configure" className="text-sm text-stone hover:text-ink px-4 py-2.5">
            Back to contracts
          </Link>
          <button
            onClick={retryExtraction}
            disabled={retryingExtraction}
            className="text-sm bg-forest text-white px-4 py-2.5 rounded-xl hover:bg-sage transition-colors disabled:opacity-40 flex items-center gap-2"
          >
            {retryingExtraction
              ? <><i className="ti ti-loader-2 animate-spin" style={{ fontSize: 14 }} /> Retrying…</>
              : <>Retry <i className="ti ti-refresh" style={{ fontSize: 13 }} /></>
            }
          </button>
        </div>
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
  // Readiness audit fix — this component (ConfigureResultsPage) is a
  // separate scope from ReviewPanel, which computes its own identical call
  // for its own drawer cards; the "Confirmed billing rules" cards below are
  // rendered from here instead, so they need their own instance of the SAME
  // shared, date-aware helper — never a second, duplicated date
  // calculation, just called from the scope that actually needs it.
  const partialPeriodMetricsTop = computePartialPeriodMetrics(terms?.contract_start_date, terms?.contract_end_date, terms?.overage_tiers ?? [])
  const commercialRuleWorkload = computeCommercialRuleWorkload(
    terms ?? null,
    // Same real per-suggestion meterMappingSummary (fetched once, eagerly,
    // via the identical isMeterMappingResolved logic — see its own
    // useEffect above) the Review Panel drawer's own commercialWorkload
    // call uses — previously this call folded the real total/confirmed
    // counts down into a single 0/1 pair, which could disagree with the
    // drawer's precise count and was the other half of the "different
    // totals in different parts of the same page" discrepancy (item 4).
    meterMappingSummary,
    unresolvedInteractions.length,
    undefined,
    // vatConfigured is undefined while still loading — treated as "not yet
    // known to be unconfigured" (configured: true) rather than outstanding,
    // so the readiness count doesn't flash "+1" the instant the page mounts
    // and settles back down a moment later once the real value arrives.
    { configured: vatConfigured !== false },
    undefined,
    // Step 13 — real evidence for this job, so the Approve footer/status
    // banner agree with the server-side approve/route.ts gate exactly.
    job?.operational_event_evidence,
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
  // Presentational split ONLY — sourceConfirmationsOutstanding is a subset
  // of commercialDecisionsOutstanding (never added to totalOutstanding
  // separately), distinguishing "already fully source-resolved, just needs
  // a Confirm & apply click" (e.g. Growth Credit) from an item that
  // genuinely needs a reviewer to choose among options. Derived from
  // terms.service_credits' own persisted source_clause/description (see
  // countSourceConfirmations) — stable from initial page load, independent
  // of which cards a reviewer has opened.
  const sourceConfirmationsOutstanding = countSourceConfirmations(commercialRuleWorkload.blockers, terms?.service_credits)
  const genuineDecisionsOutstanding = commercialDecisionsOutstanding - sourceConfirmationsOutstanding
  // Genuine approval blockers (rulebook contradictions / unsupported-
  // semantics capability gaps — never a required_operational_event_missing
  // hold, see commercialRuleWorkload.approvalBlockers's own doc comment)
  // — previously MISSING from this page's readiness computation entirely:
  // totalOutstanding never looked at executionBlockers in any form, so a
  // genuine approval blocker (were one ever to occur — currently
  // unreachable in production, per lib/commercial-rule-status.ts's own
  // comments) would have shown "Ready to approve" here while the server
  // correctly rejected it. Found and fixed while establishing the single
  // shared classification this page and approve/route.ts both now use, so
  // they can never diverge on this again — Contract B live acceptance
  // failure (2026-08-29), the reverse direction of this same class of bug.
  const approvalBlockersOutstanding = commercialRuleWorkload.approvalBlockers.length
  const readinessBreakdown = [
    genuineDecisionsOutstanding > 0 && `${genuineDecisionsOutstanding} commercial decision${genuineDecisionsOutstanding > 1 ? 's' : ''} outstanding`,
    sourceConfirmationsOutstanding > 0 && `${sourceConfirmationsOutstanding} source confirmation${sourceConfirmationsOutstanding > 1 ? 's' : ''} outstanding`,
    usageMappingsOutstanding > 0 && `${usageMappingsOutstanding} usage mapping${usageMappingsOutstanding > 1 ? 's' : ''} outstanding`,
    vatOutstanding && 'VAT not configured',
    needsReview > 0 && `${needsReview} extracted field${needsReview > 1 ? 's' : ''} below confidence threshold`,
    approvalBlockersOutstanding > 0 && `${approvalBlockersOutstanding} unresolved execution blocker${approvalBlockersOutstanding > 1 ? 's' : ''}`,
  ].filter((x): x is string => typeof x === 'string')
  const totalOutstanding = commercialDecisionsOutstanding + usageMappingsOutstanding + (vatOutstanding ? 1 : 0) + needsReview + approvalBlockersOutstanding

  // Readiness audit — "ready to approve" (totalOutstanding === 0) and
  // "every fee is billable now" are two different questions (Approve gates
  // on interpretation/configuration readiness only; a fee still held on
  // real-world operational evidence is a SEPARATE, execution-time concern
  // — see lib/commercial-rule-status.ts's RequiredOperationalEventMissingBlocker
  // and getBillabilityExecutionCapability). This is purely informational
  // surfacing of the SAME executionHolds field the server-side gate reads
  // (never re-filtered here — was previously a locally-duplicated
  // type-guard filter, now the canonical field directly) — never a
  // blocking condition, never read by handleApprove/totalOutstanding/the
  // approve route's own gate.
  const pendingExecutionHolds = commercialRuleWorkload.executionHolds
    .map(b => ({
      feeLabel: b.field.startsWith('one_time_fee:') ? b.field.slice('one_time_fee:'.length) : b.field,
      eventLabel: describeBillabilityCondition({ kind: 'event', event_type: b.event_type }) ?? b.event_type,
    }))

  // Classify one-time fees into services / hardware / credits / other
  const allFees      = terms?.one_time_fees ?? []
  const serviceFees  = allFees.filter(f => f.amount >= 0 && classifyFee(f.fee_label) === 'service')
  const hardwareFees = allFees.filter(f => f.amount >= 0 && classifyFee(f.fee_label) === 'hardware')
  const otherPosFees = allFees.filter(f => f.amount >= 0 && classifyFee(f.fee_label) === 'other')
  const creditFees   = allFees.filter(f => f.amount < 0)
  // Item 3 — the Pricing overview's own total, kept SEPARATE from the
  // service/hardware/other TYPE split above (still used by the detailed
  // Products & Services table below, item 10). The type split previously
  // doubled as the summary card here too, which was wrong two ways: (a)
  // "other"-classified fees (e.g. a fee whose label doesn't match any
  // service/hardware keyword — a real example: "ERP connector") had no
  // card at all and were silently dropped from this summary, and (b) even
  // if they had one, fee TYPE has nothing to do with whether the fee will
  // ever actually be billed — a Change-Order-gated fee may never occur,
  // regardless of what kind of fee it is. Conditionality (isChangeOrder
  // ConditionalFee) is the dimension that actually matters for a "how
  // much will this contract collect" summary, and it accounts for every
  // positive one-time fee, never silently dropping one.
  const positiveOneTimeFees     = allFees.filter(f => f.amount >= 0)
  const unconditionalOneTimeFees = positiveOneTimeFees.filter(f => !isChangeOrderConditionalFee(f))
  const conditionalOneTimeFees   = positiveOneTimeFees.filter(isChangeOrderConditionalFee)
  const unconditionalOneTimeFeeTotal = unconditionalOneTimeFees.reduce((s, f) => s + f.amount, 0)
  const conditionalOneTimeFeeTotal   = conditionalOneTimeFees.reduce((s, f) => s + f.amount, 0)

  const billingModel = deriveBillingModel(terms)
  const src = terms?.field_sources ?? {}

  // Single-source Fixed fees: sum of each billing-config row's total_amount
  // (each row already holds its full, pre-multiplied contribution to the
  // term) — what the contract says at signing, before any overages.
  // computeBaseTcv is the one shared implementation (lib/contract-tcv.ts) —
  // also used by getContractSummaries for the "New contracts" list and the
  // Agreements dashboard, so this page can never silently diverge from them.
  // tcv itself is deliberately left as the POTENTIAL total (unchanged
  // meaning) — see committedFixedFeeTotal/conditionalFixedFeeTotal below
  // for the split a "committed" claim must use instead (Agreement A final
  // amendment, item 2).
  const tcv = computeBaseTcv(items)

  // Agreement A final amendment (post-review correction) — commitment
  // classification is derived DIRECTLY from terms.one_time_fees (which
  // natively carries fee_id, amount, and billability_condition — no
  // matching needed) rather than joining `items`/LineItem rows against
  // terms.one_time_fees by product_name === fee_label. Display labels are
  // not stable commercial identity — that is exactly why OneTimeFee.fee_id
  // exists (Step 13): two fees can legitimately share a label ("Implementation
  // fee" / "Implementation fee"), and a label match would silently
  // misclassify one of them, corrupting a financial total. The recurring
  // portion of `items` needs no identity matching at all: every non-one-time
  // row is committed by construction — Change-Order conditionality only
  // ever applies to one_time_fees in this domain model (see
  // isChangeOrderConditional) — so it's included as-is, untagged (defaults
  // to 'committed'). computeCommittedFixedFees/computeConditionalFixedFees
  // themselves stay dumb summations — they never import billability-condition.ts;
  // only this construction boundary does.
  const recurringTcvItems: BaseTcvItem[] = items.filter(i => i.billing_period !== 'one_time')
  const oneTimeTcvItems: BaseTcvItem[] = (terms?.one_time_fees ?? []).map(f => ({
    product_name: f.fee_label,
    applied_rule: null,
    total_amount: f.amount,
    billing_period: 'one_time',
    commitmentStatus: isChangeOrderConditional(f.billability_condition) ? 'conditional_future_agreement' as const : 'committed' as const,
  }))
  const tcvItems: BaseTcvItem[] = [...recurringTcvItems, ...oneTimeTcvItems]
  const committedFixedFeeTotal   = computeCommittedFixedFees(tcvItems)
  const conditionalFixedFeeTotal = computeConditionalFixedFees(tcvItems)
  // Hardening item 3 (review pass 2) — routed through the shared
  // resolveCommittedFixedFeeValue resolver (lib/committed-fixed-fee-
  // resolver.ts) rather than a page-local computation, so this page can
  // never disagree with the portfolio/admin surfaces (lib/contract-tcv.ts)
  // that present the SAME agreement's committed fixed fees.
  const committedFixedFeeReadiness = resolveCommittedFixedFeeValue(
    tcvItems,
    terms?.discounts ?? null,
    terms?.base_fee_proration,
    terms?.additional_recurring_fees,
  )

  // Additions = sent one-time invoices for variable fees (total_amount = 0 in billing config)
  const additionsTotal = sentOneTimeInvoices.reduce((s, inv) => {
    const matchingItem = items.find(i => i.product_name === inv.feeLabel)
    return s + ((!matchingItem || matchingItem.total_amount === 0) ? inv.amount : 0)
  }, 0)
  // Billed to date / Committed contract value — canonical figures computed
  // server-side (GET /api/jobs/[id], via getContractSummaries) so this page
  // never diverges from the "New contracts" list or Agreements dashboard.
  const billedToDate            = job?.billedToDate ?? 0
  // Falls back to committedFixedFeeTotal, never tcv — tcv is the POTENTIAL
  // total (includes any Change-Order-conditional fee); the fallback must
  // not reintroduce the exact number this fix excludes from "committed".
  const committedContractValue  = job?.committedContractValue ?? committedFixedFeeTotal
  const lifecycleStatus         = contractLifecycleStatus(terms?.contract_start_date ?? null, terms?.contract_end_date ?? null)
  // Once a contract's own end date has passed, nothing further will ever be
  // invoiced against it — "billed to date" becomes the final, realised
  // total under a different label, per the terminology-standardisation plan.
  const isCompleted             = lifecycleStatus === 'completed'

  const summaryLines = buildContractSummary(terms, cur, committedFixedFeeReadiness, conditionalFixedFeeTotal, userTiers, apiTiers)

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
              {pendingExecutionHolds.length > 0 && (
                <span className="text-stone font-normal">
                  · {pendingExecutionHolds.length} billing condition{pendingExecutionHolds.length > 1 ? 's' : ''} pending
                </span>
              )}
            </span>
          ) : null}
        </div>

        {/* Readiness audit — a refresh failure after a successful mutation
            (see fetchJob's own comment) must not leave the page silently
            claiming stale state forever. Never rolls back the mutation
            itself (already persisted) — only offers to re-fetch. */}
        {refreshError && (
          <div className="flex-shrink-0 mx-8 mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-center gap-3">
            <i className="ti ti-refresh-alert text-amber-600 flex-shrink-0" style={{ fontSize: 16 }} />
            <p className="text-sm text-amber-800 flex-1">{refreshError}</p>
            <button onClick={() => fetchJob()} className="text-xs font-semibold text-amber-700 hover:text-amber-900 underline underline-offset-2 flex-shrink-0">
              Retry
            </button>
          </div>
        )}

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

        {/* Step 15 — derived reconciliation state, shown whenever it
            genuinely needs admin attention (renders nothing for
            none/safe_to_resume/executed_same_plan — item 9). Deliberately
            shown regardless of isFailed/isConfigured: an executed-plan-
            changed correction assessment is just as relevant on an
            already-COMPLETED job (item 10/23) as on a FAILED one. */}
        <div className="flex-shrink-0 mx-8 mt-4">
          <BillingReconciliationPanel jobId={id} currency={cur} onResolved={fetchJob} />
        </div>

        {/* Content row */}
        <div className="flex flex-1 overflow-hidden">

          {/* ── Model tab: full screen ────────────────────────────────────── */}
          {activeTab === 'model' && terms && (
            <RevenueModelTab terms={terms} items={items} cur={cur} jobId={id} onSaved={fetchJob} onRepush={handleApprove} baseTcv={tcv} meterMappingsConfirmed={meterMappingsConfirmed} isConfigured={isConfigured} />
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
                  sub={terms ? formatRenewalNoticePeriod(terms) ?? undefined : undefined}
                  onSave={v => saveField('auto_renews', v)}
                />
                {/* Item 3 (final amendment) — committedFixedFeeTotal, not
                    tcv (the potential total, which can include a
                    Change-Order-conditional fee) — the same TCV
                    commitment-model figure Card A/the Billing Configuration
                    footer show, never re-derived independently here. */}
                <Stat
                  label="Committed fixed fees"
                  value={committedFixedFeeReadiness.status === 'unresolved'
                    ? 'Not yet determinable'
                    : committedFixedFeeTotal > 0 ? fmt(committedFixedFeeTotal, cur) : billingModel === 'consumption' ? 'Usage-based' : '—'}
                  sub={committedFixedFeeReadiness.status === 'unresolved'
                    ? 'Resolve pending decisions above'
                    : conditionalFixedFeeTotal > 0 ? `+ ${fmt(conditionalFixedFeeTotal, cur)} conditional (Change Order)` : undefined}
                />
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
                      // Step 17B0.1, item 3 — this used to always say "can't
                      // tell a staircase from a volume schedule," even for a
                      // flat, non-tiered waiver whose actual open question is
                      // which component(s) it covers, not tier mechanics.
                      // The message must derive from the discount's real
                      // shape, same signal RuleInterpretationCard itself uses
                      // to choose between DISCOUNT_OPTIONS and the scope
                      // options (see getComponentScopeOptions).
                      const scopeUnresolved = discountHasUnresolvedComponentScope(d)
                      return (
                        <div key={discountId} className="flex items-center justify-between gap-4">
                          <p className="text-[11px] text-amber-700 min-w-0">
                            <i className="ti ti-alert-triangle mr-1" style={{ fontSize: 11 }} />
                            <span className="font-medium">{label}</span> — {scopeUnresolved
                              ? <>which component(s) this waiver covers has not been confirmed.</>
                              : <>structure not yet interpreted; &quot;applies to&quot; alone can&apos;t tell a staircase from a volume schedule.</>}
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
                            {volumeTierCopy(unitType)}
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
                      // runs (see the Confirmed billing rules section) — when that
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
              unconditionalOneTimeFeeTotal > 0 || conditionalOneTimeFeeTotal > 0) && (
              <div className="bg-white rounded-2xl border border-forest/10 p-6">
                {/* Was a plain, unlinked h2 — field_sources.base_monthly_fee/
                    base_annual_fee has a real, matchable section reference
                    (e.g. "3.1 Platform fee") but nothing here ever surfaced
                    it, unlike every subsection of the Commercial Terms card
                    above. Same SectionChip/openPDF wiring as those. */}
                <div className="flex items-center justify-between mb-5">
                  <h2 className="text-[10px] font-bold text-stone uppercase tracking-[0.14em]">Pricing</h2>
                  <SectionChip heading={src.base_monthly_fee ?? src.base_annual_fee} onClick={() => openPDF(src.base_monthly_fee ?? src.base_annual_fee)} />
                </div>
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
                  {/* Item 3 — conditionality-aware, never fee-type-based:
                      the SAME isChangeOrderConditionalFee split
                      buildContractSummary's own oneTimeStr sentence uses,
                      so the two can never show conflicting figures again.
                      Conditional fees get their own, clearly-labeled card
                      only when any exist — never silently folded into the
                      unconditional total, and never silently dropped. */}
                  {unconditionalOneTimeFeeTotal > 0 && (
                    <BigValue label="Unconditional one-time fees" value={fmt(unconditionalOneTimeFeeTotal, cur)}
                      note={`${unconditionalOneTimeFees.length} fee${unconditionalOneTimeFees.length > 1 ? 's' : ''} · one-time`} />
                  )}
                  {conditionalOneTimeFeeTotal > 0 && (
                    <BigValue label="Conditional one-time fees" value={fmt(conditionalOneTimeFeeTotal, cur)}
                      note={`${conditionalOneTimeFees.length} fee${conditionalOneTimeFees.length > 1 ? 's' : ''} · pending a signed Change Order`} />
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
                          {/* Was printing the raw section citation itself
                              (e.g. "3.1 Platform fee") as if it were the
                              product description, with no way to click
                              through to it. Real product name + a real,
                              clickable source chip instead. */}
                          <td className="py-2.5 pr-4 text-[12px] text-ink">
                            <span className="flex items-center gap-1.5">
                              Platform subscription
                              <SectionChip heading={src.base_monthly_fee ?? src.base_annual_fee} onClick={() => openPDF(src.base_monthly_fee ?? src.base_annual_fee)} />
                            </span>
                          </td>
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
                            {oneTimeFeeTypeLabel(f, 'Services')}
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
                            {oneTimeFeeTypeLabel(f, 'Hardware')}
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
                            {oneTimeFeeTypeLabel(f, 'One-time')}
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
                // Same source of truth the Approve section's own platform
                // control uses (item 5) — previously this fell through to
                // 'Stripe' whenever billingPlatform was anything other than
                // 'remembill'/'chargebee', INCLUDING the not-yet-configured
                // case (billingPlatform undefined for a job that hasn't
                // been approved yet), showing "Platform: Stripe" as if a
                // provider had already been chosen/saved while the Approve
                // footer below still correctly showed "Select platform…".
                // Never claims a platform is configured/selected unless it
                // actually is.
                const platformLabel = isConfigured
                  ? (billingPlatform === 'remembill' ? 'Remembill' : billingPlatform === 'chargebee' ? 'Chargebee' : billingPlatform === 'stripe' ? 'Stripe' : 'Not yet configured')
                  : selectedBillingPlatform
                    ? selectedBillingPlatform.charAt(0).toUpperCase() + selectedBillingPlatform.slice(1)
                    : connectedBillingPlatforms.length === 1
                      ? connectedBillingPlatforms[0].charAt(0).toUpperCase() + connectedBillingPlatforms[0].slice(1)
                      : 'Not yet selected'
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
                          // Step 17B0, item D — lib/line-items.ts's unresolved
                          // base_fee_proration marker row: the flat rate (unit_price)
                          // IS known and shown normally, but Qty/Total are never
                          // materialized into a concrete multi-period schedule while
                          // the partial-period treatment is unconfirmed.
                          const isBaseFeeProrationUnresolved = rowKind === 'base_fee_proration'
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
                          // Qty/Unit-price cells are non-editable for the same reason
                          // as an escalator row — Qty here would just be re-inventing
                          // the exact concrete schedule this row exists to withhold.
                          const isNonEditableRow = isEscalatorLike || isBaseFeeProrationUnresolved
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
                              {!isNonEditableRow && billingEdit?.itemId === item.id && billingEdit.field === 'quantity' ? (
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
                                  className={isNonEditableRow ? '' : 'cursor-pointer hover:text-forest transition-colors'}
                                  title={isNonEditableRow ? undefined : 'Click to edit'}
                                  onClick={() => !isNonEditableRow && setBillingEdit({ itemId: item.id, field: 'quantity', value: String(item.quantity) })}
                                >{isBaseFeeProrationUnresolved || (isVariableTier && item.quantity === 0) ? <span className="text-stone/40">—</span> : item.quantity}</span>
                              )}
                            </td>

                            {/* Unit price — editable */}
                            <td className="py-2.5 pr-4 text-[12px] text-stone text-right" style={{ fontVariantNumeric: 'tabular-nums', minWidth: 96 }}>
                              {isBaseFeeProrationUnresolved ? (
                                <span>{fmtUnit(item.unit_price, cur)}</span>
                              ) : isEscalatorLike ? (
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
                              {isBaseFeeProrationUnresolved
                                ? <span className="text-amber-600 font-normal text-[11px]">Pending interpretation</span>
                                : isEscalatorUnresolved
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
                      {/* Item 3 (final amendment) — this footer previously
                          summed `tcv` (the potential total, including any
                          Change-Order-conditional fee — the table above
                          lists that fee as its own row) under the bare
                          label "Fixed fees", which is exactly the
                          unqualified 1,258,000-as-"Fixed fees" claim this
                          fix removes. Uses the SAME committedFixedFeeTotal/
                          conditionalFixedFeeTotal already computed once
                          near the top of this component via the TCV
                          commitment model (lib/contract-tcv-calc.ts) —
                          never re-summed independently here. */}
                      <tfoot>
                        <tr style={{ borderTop: '2px solid rgba(26,61,43,0.10)' }}>
                          <td colSpan={3} className="pt-3 text-[10px] font-bold text-stone uppercase tracking-[0.1em]">Committed fixed fees</td>
                          <td className="pt-3 text-[13px] font-semibold text-ink text-right pr-4" style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {committedFixedFeeReadiness.status === 'unresolved'
                              ? <span className="text-amber-600 font-normal text-[11px]">Not yet determinable</span>
                              : fmt(committedFixedFeeTotal, cur)}
                          </td>
                          <td />
                        </tr>
                        {conditionalFixedFeeTotal > 0 && (
                          <tr>
                            <td colSpan={3} className="pt-1.5 text-[10px] font-semibold text-stone uppercase tracking-[0.1em]">Conditional — pending signed Change Order</td>
                            <td className="pt-1.5 text-[12px] font-medium text-stone text-right pr-4" style={{ fontVariantNumeric: 'tabular-nums' }}>
                              {fmt(conditionalFixedFeeTotal, cur)}
                            </td>
                            <td />
                          </tr>
                        )}
                        {conditionalFixedFeeTotal > 0 && (
                          <tr>
                            <td colSpan={3} className="pt-1.5 text-[10px] font-semibold text-stone uppercase tracking-[0.1em]">Potential total</td>
                            <td className="pt-1.5 text-[12px] font-medium text-stone text-right pr-4" style={{ fontVariantNumeric: 'tabular-nums' }}>
                              {fmt(committedFixedFeeTotal + conditionalFixedFeeTotal, cur)}
                            </td>
                            <td />
                          </tr>
                        )}
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
                  <ParkedInvoicesCard
                    jobId={id}
                    parkedInvoices={parkedInvoices}
                    onEvidenceRecorded={() => setParkedEvidenceTick(t => t + 1)}
                  />
                )}
                <ManualInvoiceCard jobId={id} />
                {(terms?.overage_tiers?.length ?? 0) > 0 && (
                  <ConsumptionTimelineCard jobId={id} />
                )}
                <BillingSummaryCard jobId={id} key={(rebuildDone ? 'rebuilt' : approved ? 'approved' : 'initial') + ':' + parkedEvidenceTick} onHasSchedule={setScheduleExists} onParkedInvoices={setParkedInvoices} onSentOneTimeInvoices={setSentOneTimeInvoices} />
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
              // provenance renders only where a REAL FieldProvenance value is
              // persisted (today: only CreditApplicationRule's eligibility_
              // provenance/survival_provenance) — never fabricated for rule
              // types that don't track it (minimum commitment, tier
              // calculation, discount, escalator), since inventing a
              // "Clear from source"/"Reviewer policy" label for a field with
              // no actual provenance record would misrepresent it.
              // 'organization_rulebook' (Step 5C) reads "Organization
              // policy" — an org's own confirmed default, not AI
              // interpretation, not the contract itself.
              const provenanceLabel = (p?: string | null) => p === 'contract_derived' ? 'Clear from source' : p === 'reviewer_policy' ? 'Reviewer policy' : p === 'organization_rulebook' ? 'Organization policy' : null
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
                    label: `Partial-period treatment (${unitType})`,
                    value: mc.prorate_partial_periods === true ? 'Prorated by days' : mc.prorate_partial_periods === false ? 'Full amount charged' : 'Not applicable',
                  })
                }
                const tierCalc = tierList.find(({ tier: t }) => t.tier_calculation)?.tier.tier_calculation
                if (tierCalc) {
                  confirmedRuleLines.push({ label: 'Tier calculation', value: TIER_METHOD_DISPLAY[tierCalc.method] ?? tierCalc.method })
                }
              }
              // Platform-fee billing-period anchor/treatment — reuses the
              // same deriveSelectedOption/optionsForRuleType lookup the
              // review card itself uses, so the summary can never describe
              // a different treatment than what was actually confirmed.
              if (terms?.base_fee_proration && !terms.base_fee_proration.requires_confirmation) {
                const bfp = terms.base_fee_proration
                const bfpWaiverExpiry = baseFeeHasExpiringWaiver(terms?.discounts)
                const optionId = deriveSelectedOption('base_fee_proration', bfp as unknown as Record<string, unknown>, bfpWaiverExpiry)
                const cadenceLabel = cadenceNoun(terms?.billing_frequency)
                const periodLabel = contractMonthLabel(terms?.contract_start_date)
                const opt = optionsForRuleType('base_fee_proration', cadenceLabel, periodLabel, bfpWaiverExpiry).find(o => o.id === optionId)
                confirmedRuleLines.push({ label: 'Platform-fee billing-period treatment', value: opt?.label ?? (bfp.reset_anchor === 'contract_start' ? 'Contract-month anchored' : 'Calendar-anchored') })
              }
              confirmedRuleLines.push({
                label: 'Escalation',
                value: !escalator ? 'None in contract' : escalatorInterp!.treatment === 'not_applied' ? 'Not applied' : (escalatorInterp!.index ?? 'Applies'),
              })
              for (const d of terms?.discounts ?? []) {
                if (!d.interpretation) continue
                confirmedRuleLines.push({ label: 'Discount', value: d.description || d.applies_to || d.interpretation.discount_type })
              }
              // Service credits — the confirmed EXECUTION policy (what it may
              // reduce, and what happens to an unused balance), not just the
              // basis/description, with real provenance shown per sub-field
              // since eligibility and survival can be confirmed via
              // different routes (an AI-graded clear_from_source vs an
              // explicit reviewer picker choice).
              for (const c of terms?.service_credits ?? []) {
                if (!c.interpretation) continue
                const label = CREDIT_TYPE_LABEL[c.credit_type ?? ''] ?? c.description ?? 'Service credit'
                const appRule = c.interpretation.application_rule
                if (appRule && !appRule.requires_confirmation && typeof appRule.carry_forward === 'boolean') {
                  const survivalProv = provenanceLabel(appRule.survival_provenance)
                  confirmedRuleLines.push({
                    label: `${label} unused-balance policy`,
                    value: `${describeSurvivalResolution({ carry_forward: appRule.carry_forward, expiry_periods: appRule.expiry_periods, expiry_date: appRule.expiry_date })}${survivalProv ? ` (${survivalProv})` : ''}`,
                  })
                } else {
                  confirmedRuleLines.push({ label, value: c.description || c.interpretation.credit_basis })
                }
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
              // Credit-representation capability — the connector's ACTUAL,
              // verified ability to put a contractual credit (Rebate/Growth/
              // Service Credit) onto a real invoice, not just whether the
              // rule interpretations are confirmed. lib/credit-ledger-service.ts
              // already fails a credit-bearing invoice closed at push time
              // when this is 'unsupported_pending_vendor_guidance' — this
              // banner previously had no way to reflect that ahead of time,
              // so a reviewer could see "ready to push" while a real invoice
              // for this exact contract would later fail closed. Normal
              // (non-credit) invoices are genuinely unaffected — only
              // credit-bearing ones are at risk, so this is its own status
              // line, not a global downgrade of "ready to push" for every
              // invoice this contract will ever generate.
              const hasServiceCredits = (terms?.service_credits ?? []).length > 0
              // Agreement A final amendment, item 4 — selectedBillingPlatform
              // (the same canonical state the Approve button/selector below
              // reads), NEVER billingPlatform here: this banner can render
              // before approval (gated on commercialRuleWorkload.status
              // above, not isConfigured), and billingPlatform's own
              // pre-execution branch falls back to job.billing_platform ??
              // 'stripe' — a field Step 15 only ever populates AFTER a
              // successful execution. Showing "stripe credit-adjustment
              // capability" from that fallback would assert a platform the
              // org may never have connected or selected at all. An empty
              // selection resolves to 'unsupported_pending_vendor_guidance'
              // (getCreditRepresentationCapability's own safe default for an
              // unrecognized key) — fails closed exactly like every other
              // capability check in this codebase, rather than guessing.
              const creditCapability = getCreditRepresentationCapability(selectedBillingPlatform ?? '')
              const creditCapabilityBlocked = hasServiceCredits && creditCapability === 'unsupported_pending_vendor_guidance'
              const billingReady = vatConfigured === true && !creditCapabilityBlocked
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
                      {vatConfigured !== true
                        ? 'Billing readiness: VAT treatment still required before push'
                        : billingReady
                          ? 'Billing readiness: ready to push'
                          : !selectedBillingPlatform
                            ? 'Billing readiness: select a billing platform below to check credit-adjustment support'
                            : `Billing readiness: normal invoices ready — invoices carrying a credit will fail closed (${selectedBillingPlatform} cannot yet represent a contractual credit adjustment)`}
                    </p>
                  </div>
                  {hasServiceCredits && (
                    <div className="mt-2 flex items-center gap-1.5">
                      <i className={`ti ${creditCapability === 'supported' ? 'ti-circle-check-filled' : 'ti-shield-exclamation'}`} style={{ fontSize: 13, color: creditCapability === 'supported' ? '#0B5C36' : '#D97706' }} />
                      <p className="text-[11px]" style={{ color: creditCapability === 'supported' ? '#0B5C36' : '#92400E' }}>
                        {selectedBillingPlatform
                          ? `${selectedBillingPlatform} credit-adjustment capability: ${creditCapability === 'supported' ? 'Supported' : 'Unsupported — pending vendor guidance'}`
                          : 'Credit-adjustment capability: unknown until a billing platform is selected'}
                      </p>
                    </div>
                  )}
                </div>
              )
            })()}

            {/* ── Confirmed billing rules ── Persistent, one-rule-at-a-time
                 counterpart to the "Rule interpretations confirmed" banner
                 above. That banner deliberately only renders once EVERY
                 commercial rule on the contract is resolved, and even then
                 shows one compact text line per rule — by design, it never
                 shows the executable interpretation, the source clause, or
                 per-field provenance. Confirming an individual rule via
                 Review contract terms used to make its detail vanish
                 entirely from the main GUI the moment requires_confirmation
                 flipped to false, with nowhere left to see how the
                 agreement is actually configured short of re-opening that
                 rule for editing. This section shows each rule's card as
                 soon as THAT rule is confirmed — independent of whether
                 other rules are still outstanding — reading straight from
                 contract_terms (the durable operational value), so it can
                 never disagree with what invoicing itself uses and never
                 goes blank on reload. "Edit interpretation" re-opens the
                 same EditCommercialRuleDrawer used everywhere else in this
                 file: confirming a change there writes a NEW audit revision
                 (commercial_rule_interpretations.is_current), never
                 overwrites the prior one, and requires stepping back through
                 propose→review→confirm before the change takes effect. */}
            {(() => {
              const findAudit = (ruleType: string, unitKey: string | null) =>
                ruleInterpretations.find(r => r.rule_type === ruleType && r.contract_unit_type === unitKey && r.is_current)

              const MODE_LABEL: Record<string, string> = {
                floor: 'Minimum charge floor', additive: 'Additive fee', minimum_spend: 'Spend commitment',
                prepaid_commitment: 'Prepaid commitment', minimum_quantity: 'Minimum quantity',
              }
              const MODE_INTERPRETATION: Record<string, string> = {
                floor: 'Floor, not additive — the greater of actual usage charges or this minimum is billed each period.',
                additive: 'Charged on top of the usage charge every period, regardless of actual usage.',
                minimum_spend: 'Usage draws down against this committed spend; any shortfall is billed as a true-up.',
                prepaid_commitment: 'This amount is prepaid; usage draws down from the prepaid balance.',
                minimum_quantity: 'A minimum unit quantity is committed (take-or-pay), independent of usage.',
              }

              // Short VALUE-only string for the "Value" params row below —
              // concision pass: this used to build a full "Worth X% of Y."
              // sentence for a redundant prose line under the card title;
              // that prose is gone (everything it said is now a params row),
              // so this only needs the value itself.
              const describeCreditValue = (interp: ServiceCreditInterp, stated_pct: number | null | undefined, stated_amount: number | null | undefined): string | null => {
                const v = interp.credit_value
                if (interp.credit_basis === 'pct_of_affected_component' && (v != null || stated_pct != null)) {
                  return `${v ?? stated_pct}% of ${interp.basis_component ?? 'the affected component'}`
                }
                if (interp.credit_basis === 'pct_of_period_fee' && (v != null || stated_pct != null)) return `${v ?? stated_pct}% of the period fee`
                if (interp.credit_basis === 'fixed_amount_per_unit' && v != null) return `${fmt(v, cur)} per unit`
                if (interp.credit_basis === 'usage_units' && v != null) return `${v} units`
                if (v != null) return fmt(v, cur)
                if (stated_amount != null) return fmt(stated_amount, cur)
                return null
              }

              type Card = {
                key: string; icon: string; typeLabel: string; title: string; sourceClause?: string | null; interpretation: string
                params: { label: string; value: string }[]; provenance: { label: string; value?: string | null }[]
                auditReviewer?: string | null; auditDate?: string | null; onViewSource?: () => void; onEdit: () => void
                footer?: React.ReactNode
              }
              const cards: Card[] = []

              // 1. Transaction pricing — tier structure + calculation method,
              // per metric. Only once the method itself is resolved
              // (requires_confirmation === false); a metric with a single
              // flat rate has no method to disambiguate at all.
              for (const [unitType, tierList] of chargingGroups.entries()) {
                const tierCalc = tierList.find(({ tier: t }) => t.tier_calculation)?.tier.tier_calculation
                if (!tierCalc || tierCalc.requires_confirmation) continue
                const paidTiers = tierList.filter(({ tier: t }) => (t.rate_per_unit ?? 0) > 0)
                const audit = findAudit('tier_calculation', unitType)
                cards.push({
                  key: `tier:${unitType}`,
                  icon: 'ti-chart-bar',
                  // Step 16A — generic category label, matching every other
                  // typeLabel in this file (e.g. line 4007's identical
                  // 'Tier calculation method' for the same concept) — never
                  // hard-coded to "Transaction," which was wrong for any
                  // non-transaction unit type (e.g. this contract's SQMs).
                  // The specific unit type is already named in `title` below.
                  typeLabel: 'Tier calculation method',
                  title: `${TIER_METHOD_DISPLAY[tierCalc.method] ?? tierCalc.method} · ${unitType}`,
                  sourceClause: tierCalc.source_clause,
                  interpretation: tierCalc.method === 'volume'
                    ? volumeTierCopy(unitType)
                    : tierCalc.method === 'graduated'
                      ? 'Each unit is billed at the rate for the tier it falls into — rates apply progressively as usage crosses each threshold.'
                      : tierCalc.method === 'block'
                        ? 'Usage is billed in fixed blocks at each block’s rate.'
                        : 'Custom calculation — see source clause.',
                  params: paidTiers.map(({ tier: t }) => ({
                    label: t.tier_label ?? (t.from_unit != null ? `${t.from_unit.toLocaleString()}–${t.to_unit != null ? t.to_unit.toLocaleString() : '+'}` : 'Rate'),
                    value: `${fmtUnit(t.rate_per_unit, cur)} / ${unitType}`,
                  })),
                  provenance: [{ label: 'Pricing method', value: audit?.decision_provenance }],
                  auditReviewer: audit?.reviewer_name ?? audit?.reviewer_email, auditDate: audit ? fmtDate(audit.created_at) : null,
                  onViewSource: src.overage_tiers ? () => openPDF(src.overage_tiers) : undefined,
                  onEdit: () => setEditingRule(`tier:${unitType}`),
                })
              }

              // 2. Minimum charge floor — per metric, mode/amount/cadence
              // plus (when calendar-anchored) partial-period treatment.
              for (const [unitType, tierList] of chargingGroups.entries()) {
                const mc = tierList.find(({ tier: t }) => t.minimum_commitment)?.tier.minimum_commitment
                const t0 = tierList[0]?.tier
                if (!mc || !mc.mode) continue
                const hasAllowance = tierList.some(({ tier: t }) => (t.rate_per_unit ?? 0) === 0)
                if (isMinimumCommitmentModeUnresolved(mc, hasAllowance)) continue
                const audit = findAudit('minimum_commitment', unitType)
                const params: { label: string; value: string }[] = [{ label: 'Applies to', value: unitType }]
                if (t0?.reset_anchor === 'calendar') {
                  // Readiness audit fix — mc.prorate_partial_periods being
                  // unclear/null does NOT by itself mean a reviewer decision
                  // is outstanding; it only does when the contract's own
                  // dates actually create a partial first/last calendar
                  // window for this cadence (partialPeriodMetrics, computed
                  // once above via the SAME date-aware
                  // isMinimumCommitmentProrationUnresolved check readiness
                  // itself uses — never a second, duplicated date
                  // calculation). A contract that starts and ends exactly on
                  // calendar-period boundaries (e.g. 1 Oct – 30 Sep) has no
                  // partial window at all, so this can never manufacture a
                  // provenance value or a reviewer decision for a scenario
                  // that cannot occur — it only ever changes which of two
                  // purely-descriptive strings is shown.
                  const provenValue = mc.prorate_partial_periods === true ? 'Prorated by days'
                    : mc.prorate_partial_periods === false ? 'Full amount charged'
                    : partialPeriodMetricsTop.has(unitType) ? 'Decision required'
                    : 'Not applicable — full calendar periods'
                  params.push({ label: 'Partial-period treatment', value: provenValue })
                }
                cards.push({
                  key: `min:${unitType}`,
                  icon: 'ti-shield',
                  typeLabel: MODE_LABEL[mc.mode] ?? mc.mode,
                  title: `${fmt(mc.amount, cur)}${ruleCadenceLabel(mc.period, t0?.reset_anchor) ? ` / ${ruleCadenceLabel(mc.period, t0?.reset_anchor)}` : ''} — ${unitType}`,
                  sourceClause: mc.source_clause,
                  interpretation: MODE_INTERPRETATION[mc.mode] ?? '',
                  params,
                  provenance: [{ label: 'Minimum rule', value: audit?.decision_provenance }],
                  auditReviewer: audit?.reviewer_name ?? audit?.reviewer_email, auditDate: audit ? fmtDate(audit.created_at) : null,
                  onViewSource: src.overage_tiers ? () => openPDF(src.overage_tiers) : undefined,
                  onEdit: () => setEditingRule(`min:${unitType}`),
                })
              }

              // Price escalation — only once a genuinely valid treatment
              // ('applies' or 'not_applied') is on record; an interpretation
              // predating the treatment field (or otherwise missing it) is
              // not safe to render as confirmed, it needs re-resolving via
              // Edit interpretation instead of being displayed as-is.
              for (const [i, e] of (terms?.escalators ?? []).entries()) {
                const interp = e.interpretation
                if (!interp || interp.requires_confirmation || (interp.treatment !== 'applies' && interp.treatment !== 'not_applied')) continue
                const notApplied = interp.treatment === 'not_applied'
                const audit = findAudit('escalator', null)
                const sourceTerm = e.escalator_type
                  ? `${e.escalator_type.replace(/_/g, ' ').replace(/\bcpi\b/i, 'CPI')}-linked escalation detected`
                  : e.description || null
                cards.push({
                  key: `esc:${i}`,
                  icon: 'ti-trending-up',
                  typeLabel: 'Price escalation',
                  title: notApplied ? 'Not applied' : `${interp.index}${interp.cap_pct != null ? `, capped ${interp.cap_pct}%` : interp.index !== 'other' ? ', uncapped' : ''}`,
                  sourceClause: sourceTerm,
                  interpretation: notApplied
                    ? 'Reviewer decision: exclude the escalation clause — what the extraction found is preserved above even though it does not run.'
                    : (interp.calculation_method ?? ''),
                  params: notApplied ? [] : [
                    { label: 'Frequency', value: interp.frequency ?? '—' },
                    ...(interp.effective_date ? [{ label: 'Effective', value: fmtDate(interp.effective_date) }] : []),
                  ],
                  provenance: [{ label: 'Escalation treatment', value: audit?.decision_provenance }],
                  auditReviewer: audit?.reviewer_name ?? audit?.reviewer_email, auditDate: audit ? fmtDate(audit.created_at) : null,
                  onViewSource: src.escalators ? () => openPDF(src.escalators) : undefined,
                  onEdit: () => setEditingRule(`esc:${i}`),
                })
              }

              // 3. Platform fee — billing-period anchor/treatment. Reuses the
              // same deriveSelectedOption/optionsForRuleType lookup the
              // review card itself uses, so this can never describe a
              // different treatment than what was actually confirmed.
              if (terms?.base_fee_proration && !terms.base_fee_proration.requires_confirmation && terms?.base_monthly_fee) {
                const bfp = terms.base_fee_proration
                const bfpWaiverExpiry = baseFeeHasExpiringWaiver(terms?.discounts)
                const optionId = deriveSelectedOption('base_fee_proration', bfp as unknown as Record<string, unknown>, bfpWaiverExpiry)
                const cadenceLabel = cadenceNoun(terms?.billing_frequency)
                const periodLabel = contractMonthLabel(terms?.contract_start_date)
                const opt = optionsForRuleType('base_fee_proration', cadenceLabel, periodLabel, bfpWaiverExpiry).find(o => o.id === optionId)
                const audit = findAudit('base_fee_proration', BASE_FEE_PRORATION_SENTINEL)
                cards.push({
                  key: 'basefee',
                  icon: 'ti-wallet',
                  typeLabel: 'Platform fee',
                  title: `${fmt(terms.base_monthly_fee, cur)} / ${cadenceLabel}`,
                  sourceClause: bfp.source_clause,
                  interpretation: opt?.description ?? (bfp.reset_anchor === 'contract_start' ? 'Billed on the contract-month cycle, anchored to the contract start date.' : 'Billed on calendar-month boundaries.'),
                  params: [{ label: 'Billing period', value: opt?.label ?? (periodLabel ? `Contract month, ${periodLabel}` : 'Calendar month') }],
                  provenance: [{ label: 'Billing-period treatment', value: audit?.decision_provenance ?? 'reviewer_policy' }],
                  auditReviewer: audit?.reviewer_name ?? audit?.reviewer_email, auditDate: audit ? fmtDate(audit.created_at) : null,
                  onViewSource: src.base_monthly_fee ? () => openPDF(src.base_monthly_fee) : undefined,
                  onEdit: () => setEditingRule('basefee'),
                })
              }

              // 4/5/6. Service credits (Annual Rebate / Growth Credit /
              // Service Availability Credit, or any other credit_type) —
              // only once BOTH the trigger/basis interpretation and its
              // application_rule (eligibility + unused-balance survival) are
              // fully resolved (isServiceCreditUnresolved false); a credit
              // still missing its application scope stays in Review contract
              // terms until that's resolved, rather than showing an
              // incomplete card here.
              for (const c of terms?.service_credits ?? []) {
                if (!c.credit_rule_id || isServiceCreditUnresolved(c)) continue
                const interp = c.interpretation!
                const appRule = interp.application_rule!
                const audit = findAudit('service_credit', `credit:${c.credit_rule_id}`)
                const params: { label: string; value: string }[] = []
                if (interp.trigger_description) params.push({ label: 'Trigger', value: interp.trigger_description })
                const value = describeCreditValue(interp, c.stated_pct, c.stated_amount)
                if (value) params.push({ label: 'Value', value })
                const cap = interp.cap_amount != null ? fmt(interp.cap_amount, cur) : interp.cap_pct != null ? `${interp.cap_pct}%` : null
                if (cap) params.push({ label: `Cap${interp.settlement_period ? ` (${interp.settlement_period})` : ''}`, value: cap })
                // Earning basis vs. application scope (2026-08-30 UI fix) —
                // rendered as up to three DISTINCT rows rather than the
                // previous "Eligible components"/"Excluded" pair, which
                // conflated what a percentage credit's SIZE is computed
                // from with what the resulting credit may later reduce.
                // Only shown when computed_from_component_keys actually
                // carries data — a credit with no percentage-of-component
                // basis (flat_amount, usage_units, ...) has no earning-
                // basis concept to display, and behaves exactly as before
                // (falls straight through to "Can be applied against").
                const computedFromKeys = Array.isArray(appRule.computed_from_component_keys) && appRule.computed_from_component_keys.length > 0
                  ? appRule.computed_from_component_keys : null
                if (computedFromKeys) {
                  const isRebate = c.credit_type === 'rebate'
                  const basisValue = formatEarningBasisFact(computedFromKeys) + (interp.monetary_basis_recognition === 'paid' ? ' actually paid' : '')
                  params.push({ label: isRebate ? 'Rebate basis' : 'Earning basis', value: basisValue })
                  const excludedFromBasis = computeExcludedFromEarningBasisKeys({
                    computedFromComponentKeys: computedFromKeys,
                    eligibleComponentKeys: appRule.eligible_component_keys,
                    excludedComponentKeys: appRule.excluded_component_keys,
                  })
                  if (excludedFromBasis.length > 0) {
                    params.push({ label: isRebate ? 'Excluded from rebate basis' : 'Excluded from earning basis', value: formatEligibleComponentsFact(excludedFromBasis) })
                  }
                }
                params.push({
                  label: 'Can be applied against',
                  value: appRule.eligible_component_keys === 'all' ? 'All future amounts payable'
                    : Array.isArray(appRule.eligible_component_keys) ? formatEligibleComponentsFact(appRule.eligible_component_keys) : 'Decision required',
                })
                params.push({ label: 'Repeatable', value: appRule.one_time === true ? 'No — one-time' : appRule.one_time === false ? 'Yes' : 'Decision required' })
                if (typeof appRule.carry_forward === 'boolean') {
                  // Short-form (matches every other param row on this card,
                  // and is what this exact regression was found against) —
                  // formatCarryForwardFact, not describeSurvivalResolution's
                  // full-sentence prose. Both were corrected for the same
                  // false-case semantic bug; this switch is a legitimate
                  // consistency fix (short values throughout this list), not
                  // an unrelated change.
                  params.push({ label: 'Unused balance', value: formatCarryForwardFact(appRule.carry_forward, appRule.expiry_periods, appRule.expiry_date) })
                  // Step 5C/5D — plain informational id/version text here
                  // (a real, clickable "View policy" action now lives in
                  // OrganizationPolicyControls, this card's footer — see
                  // item 11). Only ever present when this field was
                  // actually resolved by an org policy.
                  if (appRule.survival_provenance === 'organization_rulebook' && appRule.survival_organization_rule_id) {
                    params.push({
                      label: 'Organization policy',
                      value: `Rule ${appRule.survival_organization_rule_id.slice(0, 8)}${appRule.survival_organization_rule_version ? ` · v${appRule.survival_organization_rule_version}` : ''}`,
                    })
                  }
                }
                // Application timing — REMOVED (Contract B acceptance
                // blocker). This row used to derive its value directly from
                // carry_forward (true -> "Future invoices", false -> "Next
                // invoice") — the exact bilateral violation the Global
                // Rulebook's credit.next_invoice_timing_ne_carry_forward
                // anti-inference rule already guards the OTHER direction of
                // (timing must never establish carry_forward): a survival
                // override silently rewrote what looked like an independent
                // "when does this apply" fact. Audited and confirmed there is
                // currently no independently extracted/persisted application-
                // timing fact anywhere in this codebase — availability
                // (lib/types.ts) is a hardcoded 'next_period' execution-
                // scheduling constant, identical for every credit on every
                // contract, never contract-derived, never variable. "Future
                // invoices" was never a real stored fact; it was purely this
                // buggy derivation's output. Rather than manufacture a
                // constant/generic value with no real data behind it, this
                // row is removed entirely until a genuine, independently
                // sourced/provenanced timing field exists — do not
                // reintroduce a carry_forward-derived (or any other
                // survival-derived) value here.
                // Cash settlement (Step 1.5, corrected) — a standalone fact
                // about the credit itself, never blended with invoice
                // application timing/scope. A resolved boolean
                // shows its real answer; 'unclear' (contract silent) no
                // longer keeps the credit off this card at all — cash isn't
                // required to apply the credit against future invoices (see
                // lib/commercial-rule-status.ts's requiredServiceCreditFields)
                // — so it's shown here too, but as plain informational
                // metadata, not a flagged/blocking value.
                params.push({
                  label: 'Cash settlement allowed',
                  value: interp.cash_redeemable === true ? 'Yes'
                    : interp.cash_redeemable === false ? 'No'
                      : 'Not specified',
                })
                // Monetary basis recognition (2026-08-30 correction) — WHAT
                // monetary state (paid / stated component amount) the
                // percentage applies to, shown as its own fact/provenance
                // row, separate from Paid-basis finalization below (WHEN a
                // paid basis freezes). Only shown when the question
                // actually applies (isMonetaryBasisRecognitionApplicable);
                // this card is only reached once isServiceCreditUnresolved
                // is false, so 'component_amount' here means a resolved
                // DECISION that's still capability-blocked from execution —
                // never silently hidden just because it's not yet executable.
                if (isMonetaryBasisRecognitionApplicable(interp)) {
                  params.push({
                    label: 'Monetary basis',
                    value: interp.monetary_basis_recognition === 'paid' ? 'Actually paid'
                      : interp.monetary_basis_recognition === 'component_amount' ? 'Stated component amount (execution blocked — no verified path yet)'
                      : 'Decision required',
                  })
                }
                // Paid-basis finalization (2026-08-24 audit) — only shown
                // for a credit the question actually applies to (see
                // isPaidBasisFinalizationApplicable, which itself requires
                // monetary_basis_recognition === 'paid'); this card is only
                // reached once isServiceCreditUnresolved is false, so a
                // 'full_attribution' row here means a resolved DECISION
                // that's still capability-blocked from execution (see
                // computeCommercialRuleWorkload's serviceCreditCapabilityBlockers) —
                // never silently hidden just because it's not yet executable.
                if (isPaidBasisFinalizationApplicable(interp)) {
                  params.push({
                    label: 'Paid-basis finalization',
                    value: interp.earn_rule?.paid_basis_finalization_policy === 'deadline_cutoff' ? 'Cut off at calculation deadline'
                      : interp.earn_rule?.paid_basis_finalization_policy === 'full_attribution' ? 'Include late Contract-Year payments (execution blocked — no invoice-terminality model yet)'
                      : 'Decision required',
                  })
                }
                cards.push({
                  key: `credit:${c.credit_rule_id}`,
                  icon: CREDIT_TYPE_ICON[c.credit_type ?? ''] ?? 'ti-receipt-refund',
                  typeLabel: CREDIT_TYPE_LABEL[c.credit_type ?? ''] ?? CREDIT_BASIS_LABEL[c.credit_type ?? 'other'] ?? 'Service credit',
                  title: c.description || CREDIT_TYPE_LABEL[c.credit_type ?? ''] || 'Service credit',
                  sourceClause: c.source_clause,
                  // No lead prose sentence — every fact it used to restate
                  // (trigger, value, eligibility, survival) is already a
                  // params row above (concision pass).
                  interpretation: '',
                  params,
                  provenance: [
                    { label: 'Eligibility', value: appRule.eligibility_provenance },
                    { label: 'Unused-balance policy', value: appRule.survival_provenance },
                    { label: 'Cash redeemability', value: interp.cash_redeemable_provenance },
                    ...(isMonetaryBasisRecognitionApplicable(interp) ? [{ label: 'Monetary basis', value: interp.monetary_basis_recognition_provenance }] : []),
                    ...(isPaidBasisFinalizationApplicable(interp) ? [{ label: 'Paid-basis finalization', value: interp.earn_rule?.paid_basis_finalization_provenance }] : []),
                  ],
                  auditReviewer: audit?.reviewer_name ?? audit?.reviewer_email, auditDate: audit ? fmtDate(audit.created_at) : null,
                  onViewSource: src.service_credits ? () => openPDF(src.service_credits) : undefined,
                  onEdit: () => setEditingRule(`credit:${c.credit_rule_id}`),
                  footer: c.credit_rule_id ? (
                    <OrganizationPolicyControls
                      jobId={id}
                      creditId={c.credit_rule_id}
                      carryForward={appRule.carry_forward}
                      survivalProvenance={appRule.survival_provenance}
                      ruleId={appRule.survival_organization_rule_id}
                      ruleVersion={appRule.survival_organization_rule_version}
                      onChanged={() => { fetchJob(); fetchRuleInterpretations() }}
                    />
                  ) : undefined,
                })
              }

              if (cards.length === 0) return null

              // 7. Usage input configuration — not full commercial-rule
              // cards (no interpretation/provenance to confirm), just where
              // each metric's data is expected to come from. Only metrics
              // this contract actually meters (chargingGroups) are shown.
              const usageRows = Array.from(chargingGroups.keys()).map(unitType => {
                const row = meterInputRows.find(r => r.contract_unit_type === unitType)
                const classification = row?.input_classification ?? 'meter'
                const meter = row?.meter_key ? availableMeters.find(m => m.meter_key === row.meter_key) : undefined
                const resolved = row ? isMeterMappingResolved({ classification, confirmed: row.confirmed, meter_key: row.meter_key, manual_value_configured: row.manual_value_configured }) : false
                let description: string
                if (!resolved) description = 'Not yet confirmed'
                else if (classification === 'derived') description = 'Derived from other confirmed usage data — no separate meter needed'
                else if (classification === 'persisted_balance') description = 'Tracked via the credit ledger — no meter needed'
                else if (classification === 'meter_or_manual_input' && row?.manual_value_configured && !row.meter_key) description = 'Manual monthly entry'
                else description = `Meter: ${meter?.display_name ?? row?.meter_key ?? '—'}`
                return { unitType, description, resolved }
              })

              return (
                <div className="bg-white rounded-2xl border border-forest/10 overflow-hidden">
                  <button
                    onClick={() => setConfirmedRulesExpanded(v => !v)}
                    className="w-full p-6 flex items-center justify-between text-left"
                    style={confirmedRulesExpanded ? { borderBottom: '1px solid rgba(26,61,43,0.07)' } : undefined}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <i className={`ti ti-chevron-right text-stone/50 transition-transform flex-shrink-0 ${confirmedRulesExpanded ? 'rotate-90' : ''}`} style={{ fontSize: 12 }} />
                      <div className="min-w-0">
                        <h2 className="text-[10px] font-bold text-stone uppercase tracking-[0.14em]">Confirmed billing rules</h2>
                        <p className="text-[11px] text-stone mt-1">How this agreement is currently configured to bill — updates immediately as each rule is confirmed or edited.</p>
                      </div>
                    </div>
                    <span className="text-[11px] text-stone flex-shrink-0">{cards.length} rule{cards.length === 1 ? '' : 's'} confirmed</span>
                  </button>
                  {confirmedRulesExpanded && (
                    <>
                      <div className="p-6 grid grid-cols-2 gap-5" style={{ background: '#FAF8F4' }}>
                        {cards.map(c => (
                          <ConfirmedRuleCard
                            key={c.key}
                            icon={c.icon}
                            typeLabel={c.typeLabel}
                            title={c.title}
                            sourceClause={c.sourceClause}
                            interpretation={c.interpretation}
                            params={c.params}
                            provenance={c.provenance}
                            auditReviewer={c.auditReviewer}
                            auditDate={c.auditDate}
                            onViewSource={c.onViewSource}
                            onEdit={c.onEdit}
                            footer={c.footer}
                          />
                        ))}
                      </div>
                      {usageRows.length > 0 && (
                        <div className="px-6 pb-6 pt-2" style={{ borderTop: '1px solid rgba(26,61,43,0.07)' }}>
                          <p className="text-[10px] font-bold uppercase tracking-widest text-stone mb-2">Usage input configuration</p>
                          <div className="grid gap-x-8 gap-y-1.5 text-[12px]" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
                            {usageRows.map(r => (
                              <div key={r.unitType} className="flex items-center justify-between gap-2">
                                <p><span className="text-stone capitalize">{r.unitType}:</span> <span className={`font-medium ${r.resolved ? 'text-ink' : ''}`} style={!r.resolved ? { color: '#B45309' } : undefined}>{r.description}</span></p>
                                <button onClick={() => setReviewPanelOpen(true)} className="text-[11px] font-medium text-stone hover:text-ink flex-shrink-0">{r.resolved ? 'Change' : 'Confirm'}</button>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  )}
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

            {/* ── Billing summary KPI cards + Approve footer ──
                 Three visually consistent cards (same height/padding/icon
                 size/label size/number size/border radius — enforced by
                 FinancialKPICard, not repeated per card) replacing the old
                 single-row layout where the middle figure ("Committed
                 contract value") rendered smaller and pale-grey next to
                 two full-contrast siblings. Renamed "Gross minimum charges
                 ... (excl. VAT)" to "Minimum charges before credits/
                 rebates" — "Gross" is reserved for VAT-inclusive totals
                 elsewhere in this product (see BillingSummaryCard's
                 invoice Net/VAT/Gross rows); labeling an excl.-VAT figure
                 "Gross" contradicted that everywhere else it appears. */}
            <div className="bg-white rounded-2xl border border-forest/10 overflow-hidden">
              <div className="p-6 grid grid-cols-1 md:grid-cols-3 gap-4">
                {/* Card A — Committed fixed fees. Agreement A final
                    amendment, item 2 — relabeled from "Fixed fees" and the
                    headline figure switched from tcv (potential, includes
                    any Change-Order-conditional fee) to
                    committedFixedFeeTotal, so this card can never claim a
                    conditional fee as committed. The conditional amount (if
                    any) is surfaced as its own line, never folded silently
                    into the headline. */}
                <FinancialKPICard icon="ti-wallet" label="Committed fixed fees" metaChip={<FinancialMetaTag>Net · excl. VAT</FinancialMetaTag>}>
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
                    const datesUnresolved = !datesResolved && (!terms?.contract_start_date || (!terms?.contract_end_date && !terms?.contract_term_months))
                    // Distinct from the dates check above: the CONTRACTUAL
                    // value (rate × period count) is real and known even
                    // while partial-period treatment is unresolved — it
                    // just doesn't establish that the GENERATED billing
                    // schedule (which periods, and at what amount, actually
                    // get invoiced) is final. Shown as a caveat alongside
                    // the figure, not a withholding of it, unlike dates.
                    const partialPeriodUnconfirmed = !!terms?.base_fee_proration?.requires_confirmation
                      || (terms?.additional_recurring_fees ?? []).some(f => f.proration?.requires_confirmation)
                    const endBeforeStart = billingModel !== 'consumption' && !!terms?.contract_start_date && !!terms?.contract_end_date
                      && parseLocalDate(terms.contract_end_date) <= parseLocalDate(terms.contract_start_date)
                    // Hardening item 3 — a THIRD, independent withholding
                    // condition alongside dates and partial-period
                    // confirmation: a discount whose applicability/scope is
                    // itself Decision Required (e.g. a pilot waiver naming
                    // only one component of a hybrid fee) means the figure
                    // itself — not just the invoice schedule around it — is
                    // not yet knowable. Withheld like dates, not merely
                    // caveated like partial-period treatment, because the
                    // AMOUNT (not just the timing) is what's undetermined.
                    const discountReadinessUnresolved = committedFixedFeeReadiness.status === 'unresolved'
                    const canShowFigure = committedFixedFeeTotal > 0 && datesResolved && !discountReadinessUnresolved
                    return (
                      <>
                        {canShowFigure ? (
                          <FinancialAmount amount={committedFixedFeeTotal} currency={cur} basis="net" size="xl" />
                        ) : billingModel === 'consumption' ? (
                          <p className="text-[20px] font-medium text-stone/60">Usage-based</p>
                        ) : discountReadinessUnresolved ? (
                          <p className="text-[20px] font-medium text-stone/60">Not yet determinable</p>
                        ) : (
                          <p className="text-[32px] font-semibold text-stone/30" style={{ fontVariantNumeric: 'tabular-nums' }}>—</p>
                        )}
                        {committedFixedFeeTotal === 0 && billingModel === 'consumption' && terms?.contract_start_date && terms?.contract_end_date && (
                          <p className="text-[10px] text-stone/40 mt-2">Fixed fees depend on usage volume</p>
                        )}
                        {committedFixedFeeTotal > 0 && datesUnresolved && (
                          <p className="text-[10px] text-amber-600 mt-2">Contract dates unresolved — fixed-fee total withheld until confirmed above</p>
                        )}
                        {committedFixedFeeTotal > 0 && datesResolved && discountReadinessUnresolved && (
                          <p className="text-[10px] text-amber-600 mt-2">
                            {committedFixedFeeReadiness.reasons[0] ?? 'A billing-impacting decision is unresolved'} — resolve pilot scope / partial-period treatment to determine committed fixed fees
                          </p>
                        )}
                        {committedFixedFeeTotal > 0 && datesResolved && !discountReadinessUnresolved && partialPeriodUnconfirmed && (
                          <p className="text-[10px] text-amber-600 mt-2">Partial-period billing treatment not yet confirmed — the generated invoice schedule is not final</p>
                        )}
                        {committedFixedFeeTotal === 0 && billingModel !== 'consumption' && endBeforeStart && (
                          <p className="text-[10px] text-amber-600 mt-2">End date is before start date — correct it above</p>
                        )}
                        {committedFixedFeeTotal === 0 && billingModel !== 'consumption' && (!terms?.contract_start_date || !terms?.contract_end_date) && (
                          <p className="text-[10px] text-stone/40 mt-2">Add contract dates above to calculate</p>
                        )}
                        {/* Never folded into the headline above — a
                            Change-Order-conditional fee may never actually
                            be billed, so it stays visibly separate. */}
                        {conditionalFixedFeeTotal > 0 && (
                          <p className="text-[10px] text-stone mt-2">
                            + {fmt(conditionalFixedFeeTotal, cur)} conditional on a signed Change Order — potential total {fmt(committedFixedFeeTotal + conditionalFixedFeeTotal, cur)}
                          </p>
                        )}
                        {/* Confirmation is expressed here, not by recoloring
                            the number above — same discipline as the
                            Confirmed billing rules cards: the figure stays
                            in the financial palette regardless of status. */}
                        {canShowFigure && !partialPeriodUnconfirmed && (
                          <div className="mt-2"><StatusInline kind="confirmed" label="Confirmed fees" /></div>
                        )}
                      </>
                    )
                  })()}
                </FinancialKPICard>

                {/* Card B — Minimum charges before credits/rebates. Renamed
                    from "Committed contract value" — that phrase read as a
                    promised/guaranteed total, but this figure is the
                    contractual MINIMUM the confirmed floor/proration policy
                    would charge across every window (Fixed fees + every
                    metric's minimum-commitment floor), computed BEFORE any
                    credit, rebate, or discount reduces it. Real invoiced
                    amounts can differ once actual usage/credits are known.
                    minimumCommitmentsTotal is the same delta
                    lib/contract-value.ts's computeContractValueModel
                    computes server-side (committedContractValue = fixedFees
                    + minimumCommitments), derived here from the two
                    already-fetched totals rather than a new server field.
                    Compared against committedFixedFeeTotal, NOT tcv —
                    committedContractValue is itself built from committed
                    (not potential) fixed fees server-side (Agreement A
                    final amendment, item 2), so diffing against the
                    potential total here would silently reintroduce the
                    conditional Change Order fee into this delta, or even
                    go negative once the two diverge. */}
                {committedContractValue > committedFixedFeeTotal && (() => {
                  const minimumCommitmentsTotal = committedContractValue - committedFixedFeeTotal
                  return (
                    <FinancialKPICard
                      icon="ti-shield" label="Minimum charges before credits/rebates"
                      metaChip={<FinancialMetaTag>Net · excl. VAT</FinancialMetaTag>} sage
                    >
                      <FinancialAmount amount={committedContractValue} currency={cur} basis="net" size="xl" />
                      <div className="mt-3 space-y-1 text-[11px] text-stone">
                        <p>
                          <span className="font-semibold text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(committedFixedFeeTotal, cur)}</span> committed fixed fees
                        </p>
                        <p>
                          <span className="font-semibold text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>+ {fmt(minimumCommitmentsTotal, cur)}</span> minimum commitments
                        </p>
                      </div>
                    </FinancialKPICard>
                  )
                })()}

                {/* Additions — not one of the three named KPI cards, kept
                    in the same visual family (same shell) rather than a
                    differently-styled leftover when it does appear. */}
                {additionsTotal > 0 && (
                  <FinancialKPICard icon="ti-plus" label="Additions">
                    <div className="flex items-baseline gap-1">
                      <span className="text-[32px] font-semibold" style={{ color: 'var(--color-financial-net)' }}>+</span>
                      <FinancialAmount amount={additionsTotal} currency={cur} basis="net" size="xl" />
                    </div>
                  </FinancialKPICard>
                )}

                {/* Card C — Billed to date */}
                {billedToDate > 0 && (
                  <FinancialKPICard
                    icon="ti-file-invoice" label={isCompleted ? 'Realised TCV' : 'Billed to date'}
                    metaChip={<FinancialMetaTag>Net · excl. VAT</FinancialMetaTag>}
                  >
                    <FinancialAmount amount={billedToDate} currency={cur} basis="net" size="xl" />
                    {/* planned_invoices.base_amount (what billedToDate
                        sums) is the NET figure sent to the billing
                        connector — see lib/billing-writer.ts. Gross per
                        invoice is shown on each issued/scheduled invoice
                        row below (Billing Summary), computed off the same
                        lib/vat.ts:computeVat every real invoice push uses;
                        not re-summed into a second aggregate gross total
                        here to avoid it silently drifting from the
                        per-invoice figures if VAT treatment changes
                        mid-term — no new calculation performed here. */}
                    <p className="text-[10px] text-stone/40 mt-2">Gross totals shown per invoice below</p>
                  </FinancialKPICard>
                )}
              </div>

                {/* Approve action (only shown before billing is configured) */}
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
                  <div className="px-6 py-4 flex justify-end" style={{ borderTop: '1px solid rgba(26,61,43,0.07)', background: 'rgba(26,61,43,0.02)' }}>
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
                    {/* Informational only — never read by `blocked` above.
                        The agreement's interpretation/configuration can be
                        fully resolved (totalOutstanding === 0) while a
                        specific fee still can't execute yet because its
                        required real-world event hasn't been evidenced —
                        two different questions, kept visibly separate
                        rather than folded into one "ready" claim. Styled
                        as neutral/informational (not amber) since this is
                        never something Approve is waiting on. */}
                    {pendingExecutionHolds.length > 0 && (
                      <div className="text-[10px] text-stone text-right max-w-[240px]">
                        <p className="font-medium text-ink">
                          {pendingExecutionHolds.length} billing condition{pendingExecutionHolds.length > 1 ? 's' : ''} pending
                        </p>
                        {pendingExecutionHolds.map((h, i) => (
                          <p key={i}>{h.feeLabel} — waiting for {h.eventLabel}</p>
                        ))}
                      </div>
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
          oneTimeFees={terms?.one_time_fees}
          unsupportedCommercialMechanisms={terms?.unsupported_commercial_mechanisms}
          fieldSources={terms?.field_sources}
          operationalEventEvidence={job?.operational_event_evidence}
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
          workload={commercialRuleWorkload}
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
        const isCredit = editingRule.startsWith('credit:')
        const isBaseFee = editingRule === 'basefee'
        const isRecurFee = editingRule.startsWith('recurfee:')
        const ruleType: RuleType = isMin ? 'minimum_commitment' : isTier ? 'tier_calculation' : isPartial ? 'partial_period'
          : isDiscount ? 'discount' : isCredit ? 'service_credit' : isBaseFee ? 'base_fee_proration' : isRecurFee ? 'recurring_fee_proration'
          : 'escalator'
        const unitType = isMin ? editingRule.slice(4) : isTier ? editingRule.slice(5) : isPartial ? editingRule.slice(8)
          : isBaseFee ? BASE_FEE_PRORATION_SENTINEL : isRecurFee ? editingRule.slice(9) : undefined
        const discountId = isDiscount ? editingRule.slice(5) : undefined
        const creditId = isCredit ? editingRule.slice(7) : undefined
        // Discounts/service credits address their audit history via a
        // synthetic 'discount:{id}'/'credit:{id}' key in contract_unit_type
        // (see confirm-rule) — reuses the column rather than needing a
        // dedicated one.
        const auditUnitKey = isDiscount ? `discount:${discountId}` : isCredit ? `credit:${creditId}` : (unitType ?? null)
        const records = ruleInterpretations.filter(r => r.rule_type === ruleType && r.contract_unit_type === auditUnitKey)
        const currentRecord = records.find(r => r.is_current) ?? null
        const historyRecords = records.filter(r => !r.is_current).sort((a, b) => b.revision_number - a.revision_number)
        const minCadence = unitType ? tiers.find(t => t.unit_type === unitType)?.minimum_commitment?.period : null
        const partialCadence = unitType ? tiers.find(t => t.unit_type === unitType)?.measurement_period : null
        const editingCredit = isCredit ? (terms?.service_credits ?? []).find(c => c.credit_rule_id === creditId) : undefined
        const ruleTitle = isMin
          ? `${unitType} · ${minCadence ? minCadence.charAt(0).toUpperCase() + minCadence.slice(1) : ''} minimum`.replace('  ', ' ')
          : isTier ? `${unitType} · Tier calculation method`
          : isPartial ? `${unitType} · Partial-period treatment`
          : isDiscount ? 'Discount structure'
          : isCredit ? (editingCredit?.description || CREDIT_BASIS_LABEL[editingCredit?.credit_type ?? 'other'] || 'Service credit')
          : isBaseFee ? 'Platform-fee billing-period treatment'
          : isRecurFee ? `${unitType} · Billing-period treatment`
          : 'Price escalation'
        return (
          <EditCommercialRuleDrawer
            jobId={id}
            ruleType={ruleType}
            contractUnitType={unitType}
            discountId={discountId}
            creditId={creditId}
            cadenceLabel={cadenceNoun(partialCadence)}
            waiverExpiry={isBaseFee ? baseFeeHasExpiringWaiver(terms?.discounts) : false}
            ruleTitle={ruleTitle}
            currency={cur}
            currentRecord={currentRecord}
            historyRecords={historyRecords}
            onClose={() => setEditingRule(null)}
            onApplied={handleEditRuleApplied}
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
