// Step 17G.4A — component-centric commercial structure for the "Products,
// Services & Pricing" section: groups the SAME typed contract facts
// already scattered across separate parts of /configure/[id] (base fee +
// band table, additional_recurring_fees, overage_tiers,
// percentage_of_basis, discounts, base_fee_proration,
// fixed_fee_billing_timing, variable_invoice_timing) by the commercial
// THING they describe, not by which extraction object happens to carry
// them. Pure, DB-free — never recomputes an amount a real execution path
// (lib/tariff.ts, lib/usage-pull.ts, lib/performance-share-fee.ts) already
// owns; every figure here is read straight off already-computed/typed
// fields.
import { resolveFixedFeeBand, type ResolveFixedFeeBandResult } from './fixed-fee-band'
import type { FixedFeeBand } from './types'
import { isVariableInvoiceTimingConfirmed } from './rule-interpretation'

export type PricingModel = 'fixed' | 'usage' | 'performance'

export interface ComponentDetailFact {
  label: string
  value: string
  // Renders as an amber "⚠ Decision required" style fact with a "Review"
  // action wired to the existing ReviewPanel — never a second decision/
  // provenance system (item 12).
  decisionRequired?: boolean
  // Step 17G.6F, items 2/5 — the specific business QUESTION a
  // decisionRequired row's Review action actually answers, shown as
  // supporting text on the main card — never an invented ANSWER. Also
  // used for a resolved, purely-informational explanation (e.g. why an
  // Invoice status reads "Blocked by upstream decision").
  helperText?: string
}

export interface OverageDetail {
  label: string
  ratePerUnit: number
  fromUnit: number
}

export interface CommercialComponent {
  key: string
  title: string
  pricingModel: PricingModel
  pricingModelLabel: string
  // Compact summary lines shown collapsed — e.g. ["SEK 2,000 / month"] or
  // ["SEK 0.38 / issued request", "SEK 0.60 / request above 5,000"].
  summaryLines: string[]
  billingCadence: string | null
  detail: ComponentDetailFact[]
  bandTable?: FixedFeeBand[]
  bandResolution?: ResolveFixedFeeBandResult
  rateSchedule?: { from: number; to: number | null; rate_pct: number }[]
  hasUnresolvedDecision: boolean
  // Step 17H.4B0D4H1B4E2.2 — raw operational-input keys this component's
  // "Required inputs" rows above already represent. Lets a caller compute,
  // by set difference against collectOperationalDataInputs' full list,
  // exactly which inputs have NO owning component (one_time_fees /
  // unsupported_commercial_mechanisms sources) — a typed relationship, not
  // a label guess, and never duplicated/re-derived by the caller.
  consumedOperationalInputKeys?: string[]
  // Step E9C.2 §4 — the fee/mechanism's own stable identity
  // (AdditionalRecurringFee.recurring_fee_id), threaded through to the
  // presentation layer so a caller (Commercial Logic's own due-state
  // correlation) can key off it instead of `key`/`title`, both of which
  // are DERIVED FROM fee_label — a mutable display string, not an id
  // (confirmed: `key: \`performance_${f.fee_label}\`` below has always
  // been label-derived). No schema change — recurring_fee_id already
  // exists on AdditionalRecurringFee; this only carries it one layer
  // further than it previously travelled. Null/undefined for legacy data
  // extracted before recurring_fee_id existed, or for a component kind
  // that has no such id at all (e.g. the fixed base fee) — callers must
  // fall back to `title`/`key` in that case, never treat absence as an error.
  recurringFeeId?: string | null
}

export interface CommercialComponentFee {
  fee_label: string
  // Step E9C.2 §4 — see CommercialComponent.recurringFeeId's own comment;
  // this is the raw field this function reads it from (AdditionalRecurringFee.
  // recurring_fee_id, already extraction-populated — no schema change).
  recurring_fee_id?: string | null
  amount?: number | null
  rate_per_unit?: number | null
  metric_name?: string | null
  semantic_input_key?: string | null
  billing_frequency?: string | null
  percentage_of_basis?: {
    derived_metric: { metric_key: string; numerator_input_key: string; denominator_input_key: string }
    rate_schedule: { bands: { from: number; to: number | null; rate_pct: number }[] }
    basis_input_key: string
  } | null
  variable_invoice_timing?: { timing: 'invoice_at_next_period_start' | 'invoice_at_period_end' | 'unclear'; requires_confirmation: boolean } | null
  // Step: consolidate Operational Inputs by semantic ownership — the fee's
  // own direct additional input(s), distinct from percentage_of_basis's
  // own derived_metric.raw_inputs (which buildPerformanceComponents
  // already surfaces). Colocated here as "Required inputs" rows rather
  // than a second, standalone GUI section.
  required_operational_inputs?: string[] | null
  // Step 17H.4B0D4H1B4E2.5 §9-13 — a flat rate_per_unit fee's RATE can
  // itself be a derived metric (lib/types.ts's AdditionalRecurringFee.
  // derived_metric doc: "value-weighted payment rate = paid invoice value
  // ÷ total invoice value") — genuinely distinct from percentage_of_basis
  // (a different typed mechanism entirely, still a plain per-unit usage
  // charge, never reclassified as Performance). Its raw_inputs belong to
  // THIS fee via this typed field, never a label guess — previously
  // unread by buildUsageComponents, which orphaned them into the neutral
  // fallback bucket.
  derived_metric?: { metric_name: string; formula: string; raw_inputs: string[] } | null
}

export interface CommercialComponentTier {
  tier_label?: string | null
  unit_type?: string | null
  from_unit?: number | null
  rate_per_unit?: number | null
  semantic_input_key?: string | null
  // Same rationale as CommercialComponentFee.required_operational_inputs —
  // a tier's own overage surcharge can depend on inputs beyond the metric
  // already implied by unit_type (e.g. the contracted volume it counts
  // against).
  required_operational_inputs?: string[] | null
}

export interface CommercialComponentsTerms {
  currency?: string | null
  base_monthly_fee?: number | null
  base_annual_fee?: number | null
  billing_frequency?: string | null
  base_fee_bands?: FixedFeeBand[] | null
  base_fee_committed_volume?: number | null
  base_fee_proration?: { prorate_partial_periods: boolean | 'unclear'; requires_confirmation: boolean } | null
  fixed_fee_billing_timing?: { timing: string; requires_confirmation: boolean } | null
  discounts?: {
    discount_pct?: number | null
    duration_days?: number | null
    duration_months?: number | null
    affected_components?: string[] | null
  }[] | null
  additional_recurring_fees?: CommercialComponentFee[] | null
  overage_tiers?: CommercialComponentTier[] | null
  unsupported_commercial_mechanisms?: {
    kind?: string
    description?: string | null
    source_clause?: string | null
    required_operational_inputs?: string[] | null
    rolling_band_migration?: {
      aggregate?: { input_key?: string | null; window_count?: number | null } | null
      trigger_comparator?: string | null
      notice_required?: boolean | null
    } | null
    execution_status?: string
  }[] | null
}

// Shared by buildUsageComponents and buildPerformanceComponents — a
// required-operational-input's business label is always the humanized
// key, never the raw snake_case string, wherever it's colocated (item 3:
// business label before technical key).
export function humanizeKey(k: string) {
  return k.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())
}

function fmt(n: number | null | undefined, cur: string) {
  if (n == null) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
}
function fmtUnit(n: number | null | undefined, cur: string) {
  if (n == null) return '—'
  const fractionDigits = n > 0 && n < 1 ? 4 : 2
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, minimumFractionDigits: 0, maximumFractionDigits: fractionDigits }).format(n)
}
function cadenceLabel(freq: string | null | undefined): string | null {
  if (!freq) return null
  return freq.charAt(0).toUpperCase() + freq.slice(1)
}

// The fixed/base recurring component — "Platform subscription" (the same
// generic label the pre-existing Products & Services table already used
// for this exact row, not new Remembill-specific wording). Attaches every
// commercial CONDITION that affects this SAME fee, wherever it's typed
// today: base_fee_bands/committed volume (band selection), discounts
// scoped to the base fee (pilot/waiver), base_fee_proration (partial-
// period treatment), fixed_fee_billing_timing (invoice-issuance timing),
// and the rolling-band migration rule (volume adjustment) when present.
function buildFixedComponent(terms: CommercialComponentsTerms, cur: string): CommercialComponent | null {
  const hasFixed = !!(terms.base_monthly_fee || terms.base_annual_fee)
  if (!hasFixed) return null

  const amount = terms.base_monthly_fee ?? terms.base_annual_fee!
  const unit = terms.base_monthly_fee ? '/month' : '/year'
  const summaryLines = [`${fmt(amount, cur)}${unit}`]

  const detail: ComponentDetailFact[] = []
  let bandTable: FixedFeeBand[] | undefined
  let bandResolution: ResolveFixedFeeBandResult | undefined
  if (terms.base_fee_bands && terms.base_fee_bands.length > 0) {
    bandTable = terms.base_fee_bands
    bandResolution = resolveFixedFeeBand(terms.base_fee_bands, terms.base_fee_committed_volume)
    if (terms.base_fee_committed_volume != null) {
      detail.push({ label: 'Contracted volume', value: terms.base_fee_committed_volume.toLocaleString() })
    }
    // Step 17H.3C1 — a failed resolution (committed volume outside every
    // band, or no committed volume known) previously made this row
    // disappear entirely, silently hiding the only visible signal a
    // band-selection failure ever had. Every actual resolver outcome now
    // gets a row under the same label, using the resolver's own reason
    // text verbatim — never a second, invented status vocabulary.
    if (bandResolution.status === 'resolved') {
      const b = bandResolution.band
      detail.push({ label: 'Selected band', value: `${b.from_unit.toLocaleString()}–${b.to_unit != null ? b.to_unit.toLocaleString() : '∞'}` })
    } else {
      detail.push({ label: 'Selected band', value: `⚠ Pricing band unresolved — ${bandResolution.reason}` })
    }
  }

  // Step 17H.3D1 — the old "Pilot"/"Discount" summary facts that used to
  // render here (a primitive, fixed-component-only summary) were removed:
  // Commercial Logic's dedicated discount migration (page.tsx's Commercial
  // Logic build loop, step 8) now explains the SAME contractual rule once,
  // completely (type/value/applicability/period/interpretation/source/
  // provenance/edit), attached ONLY when Discount.affected_components
  // truthfully resolves to this component — never defaulted here onto the
  // fixed component merely because affected_components was absent (the
  // old lookup's `!d.affected_components || length === 0` fallback did
  // exactly that, a real "make up the relationship" bug the new migration
  // does not repeat — see the 17H.3D1 report). Rendering both here and in
  // Commercial Logic would explain the same rule twice.

  if (terms.base_fee_proration) {
    const p = terms.base_fee_proration
    detail.push({
      label: 'Partial-period treatment',
      value: p.requires_confirmation
        ? 'Decision required'
        : p.prorate_partial_periods === true ? 'Prorated for partial periods'
        : p.prorate_partial_periods === false ? 'Start fixed fee from next full billing period'
        : 'Unclear — review contract',
      decisionRequired: p.requires_confirmation,
    })
  }

  // Step 17G.6A, items 7/8/14 — relabeled "Billing timing" -> "Recurring
  // fixed-fee timing" and reworded to a plain, unambiguous sentence (no
  // "settlement timing"/"billing anchor" jargon), matching the same
  // canonical wording now used in the ReviewPanel question/options
  // (lib/rule-interpretation.ts's FIXED_FEE_BILLING_TIMING_OPTIONS) and in
  // BillingPeriodWorkspaceCard (Billing Timeline) — audited so all three
  // surfaces agree. Underlying canonical values (bill_at_period_start /
  // bill_at_period_end) are untouched.
  const billingTiming = terms.fixed_fee_billing_timing
  const billingTimingUnresolved = !billingTiming || billingTiming.requires_confirmation
  detail.push({
    label: 'Recurring fixed-fee timing',
    value: billingTiming && !billingTiming.requires_confirmation
      ? (billingTiming.timing === 'bill_at_period_start' ? 'Invoiced at the beginning of each billing period' : 'Invoiced at the end of each billing period')
      : 'Decision required',
    decisionRequired: billingTimingUnresolved,
    // Step 17G.6G — reverted 17G.6F's pilot-embedding: the pilot is a
    // separate commercial fact (its own "Pilot" row above) and must not
    // be folded into this question's wording — a platform-generic
    // question, identical for every contract regardless of whether a
    // pilot exists, matching the SAME wording the ReviewPanel question
    // already uses (below, in page.tsx) word-for-word.
    helperText: billingTimingUnresolved ? 'When should the recurring fixed fee be invoiced?' : undefined,
  })

  // Volume adjustment — the RULE only (what the contract says), never the
  // live monitoring state (current rolling average / notice status /
  // proposed transition), which stays exclusively in Billing Timeline's
  // own runtime evaluation view — this section states the rule, that view
  // states what's currently happening under it. Attribution to
  // fixed_component is structural, not a label guess: a rolling-band
  // migration only ever exists to move base_fee_bands (confirmed — the
  // runtime card's own copy states "a real price must be added to
  // base_fee_bands before this can ever activate"), and base_fee_bands is
  // exclusively a fixed-component concept — no other CommercialComponent
  // type has anything analogous. UnsupportedCommercialMechanism itself
  // carries no typed affected_components field (confirmed by direct
  // read of lib/types.ts — unlike Discount, which does), so this
  // attribution is the one legitimate typed/structural relationship
  // available today, not an invented one.
  const fixedComponentConsumedInputKeys: string[] = []
  const rollingBandMechanism = (terms.unsupported_commercial_mechanisms ?? []).find(m => m.execution_status === 'executable' && !!m.rolling_band_migration)
  if (rollingBandMechanism?.rolling_band_migration) {
    const rb = rollingBandMechanism.rolling_band_migration
    const windowCount = rb.aggregate?.window_count
    const inputKey = rb.aggregate?.input_key
    // Step 17H.4B0D4H1B4E7.1 §11/§12 — this row is what Commercial Logic's
    // progressive-disclosure section collapses to as its one-line default
    // summary (the section's first row) — it used to BE the full
    // measurement mechanics sentence ("Measured using X, evaluated as a
    // rolling average over the last N completed billing periods"), so the
    // "collapsed" state was really the whole mechanism, not a summary.
    // Reworded to state the COMMERCIAL EFFECT concisely; the measurement
    // mechanics move to their own row below (still "Volume adjustment ..."
    // prefixed, so ruleCategoryFor groups it with the rest of this
    // mechanism, not into the unrelated "Timing" section a bare
    // "Measurement" label would land in) — nothing removed, only
    // relocated from the summary line into the detail rows underneath it.
    detail.push({
      label: 'Volume adjustment',
      value: windowCount
        ? `Rolling ${windowCount}-period average determines future pricing band`
        : 'Pricing may move to a higher band based on the contractual rolling-volume rule.',
    })
    if (windowCount && inputKey) {
      detail.push({
        label: 'Volume adjustment measurement',
        value: `Measured using ${humanizeKey(inputKey).toLowerCase()}, evaluated as a rolling average over the last ${windowCount} completed billing periods.`,
      })
    }
    detail.push({ label: 'Volume adjustment trigger', value: 'Average exceeds the contracted volume for this agreement.' })
    detail.push({
      label: 'Volume adjustment effect',
      value: rb.notice_required
        ? 'Future pricing band changes from the next eligible contract period, after advance notice.'
        : 'Future pricing band changes from the next eligible contract period.',
    })
    detail.push({ label: 'Volume adjustment history', value: 'Never rewrites the signed agreement or a past invoice.' })
    if (rollingBandMechanism.source_clause) {
      detail.push({ label: 'Volume adjustment source', value: rollingBandMechanism.source_clause })
    }
    // The rolling-band rule's own operational input(s) are already stated
    // above ("Measured using ...") rather than repeated as a separate
    // "Required inputs" row — but must still count as consumed so the
    // page's leftover/unassigned-input computation doesn't treat this key
    // as having no owning component.
    if (inputKey) fixedComponentConsumedInputKeys.push(inputKey)
    fixedComponentConsumedInputKeys.push(...(rollingBandMechanism.required_operational_inputs ?? []))
  }

  const hasUnresolvedDecision = detail.some(d => d.decisionRequired)

  return {
    key: 'fixed_component',
    title: 'Platform subscription',
    pricingModel: 'fixed',
    pricingModelLabel: bandTable ? 'Fixed recurring + volume-band pricing' : 'Fixed recurring',
    summaryLines,
    billingCadence: cadenceLabel(terms.billing_frequency),
    detail,
    bandTable,
    bandResolution,
    hasUnresolvedDecision,
    consumedOperationalInputKeys: Array.from(new Set(fixedComponentConsumedInputKeys)),
  }
}

// One usage-based component per flat per-unit fee (rate_per_unit, no
// percentage_of_basis) — with any overage_tiers entry sharing the SAME
// semantic_input_key merged in as an "overage above" summary line, since
// they describe the same underlying commercial component (item 8) even
// though they live in two different typed arrays today.
function buildUsageComponents(terms: CommercialComponentsTerms, cur: string): CommercialComponent[] {
  const fees = (terms.additional_recurring_fees ?? []).filter(f => typeof f.rate_per_unit === 'number' && f.rate_per_unit > 0 && !f.percentage_of_basis)
  return fees.map(f => {
    const unitLabel = f.metric_name ?? 'unit'
    const summaryLines = [`${fmtUnit(f.rate_per_unit, cur)} / ${unitLabel.replace(/_/g, ' ')}`]
    // Matched by semantic_input_key when both sides have one (the same
    // canonical key lib/usage-source-cards.ts already groups by); falls
    // back to matching the tier's own unit_type against the fee's
    // metric_name only when neither side has a semantic key yet.
    const matchingTiers = (terms.overage_tiers ?? []).filter(t => {
      if (typeof t.rate_per_unit !== 'number' || t.rate_per_unit <= 0) return false
      if (f.semantic_input_key && t.semantic_input_key) return t.semantic_input_key === f.semantic_input_key
      return t.unit_type === f.metric_name
    })
    for (const t of matchingTiers) {
      const includedUpTo = (t.from_unit ?? 1) - 1
      summaryLines.push(`${fmtUnit(t.rate_per_unit, cur)} / ${unitLabel.replace(/_/g, ' ')} above ${includedUpTo.toLocaleString()}`)
    }
    // Step 17G.5A — the commercial LOGIC behind this charge (what gets
    // charged and when), for the new "Commercial Logic & Billing Rules"
    // section. Never a provenance-badged fact: these rows are read
    // straight off the fee's own typed identity (metric_name/from_unit),
    // the same tier-of-confidence every other plain ContractTerms field on
    // this page (e.g. base_monthly_fee itself) is shown at — no separate
    // FieldProvenance record exists for "does this metric get charged per
    // unit," so none is fabricated here (see provenanceLabel's own doc
    // comment in page.tsx for why that line is never crossed).
    const detail: ComponentDetailFact[] = [
      { label: 'Charging rule', value: `Charge each ${unitLabel.replace(/_/g, ' ')}` },
    ]
    if (matchingTiers.length > 0) {
      const includedUpTo = (matchingTiers[0].from_unit ?? 1) - 1
      detail.push({ label: 'Overage rule', value: `Additional charge applies above the contracted threshold of ${includedUpTo.toLocaleString()}` })
    }
    // Step 17G.6A/17G.6B — "Measurement" (when the quantity becomes known)
    // kept explicitly distinct from the CURRENT scheduling treatment
    // (when the resulting charge actually gets attached to an invoice) —
    // never conflated, per the instruction not to ask "in advance vs in
    // arrears" as if it were a choice. Both are read straight off audited
    // execution behavior (lib/usage-pull.ts / the invoice-scheduler's
    // Stage B), not per-contract guesses.
    //
    // Step 17G.6B — labeled "Current billing treatment," never "Invoice
    // timing," and NEVER given a provenance badge (see page.tsx's
    // isTimingFact check): unlike the fixed recurring fee's own timing
    // (a genuine, reviewer-gated decision — fixed_fee_billing_timing) or
    // Performance Share's Invoice timing (variable_invoice_timing, also
    // reviewer-gated), a flat usage/overage charge has NO typed decision
    // field and NO confirm-rule path anywhere in this codebase that
    // governs when it gets attached to an invoice — it is unconditional
    // scheduler behavior. Calling this "reviewer policy" (or any
    // provenance) would fabricate a decision that was never made;
    // stating it as commercial/contractual truth ("Verdix never issues
    // usage charges on a separate invoice") would overclaim an
    // implementation detail as a guarantee. Audited directly against
    // app/api/admin/invoice-scheduler/route.ts (lines ~475-497, 940-1013)
    // before writing this copy: the scheduler locates the immediately
    // preceding closed period's row and attaches that period's usage/
    // overage line items to the CURRENT period's own already-created
    // invoice/planned_invoices row.
    detail.push({ label: 'Measurement', value: 'Usage is measured for the billing period and finalized after the period closes.' })
    // Step 17G.6F, item 3 — "Current billing treatment" -> "Billing
    // treatment" (controlled vocabulary, item 8); wording tightened to
    // "added to," matching the exact phrase requested. Still never
    // provenance-badged — see the doc comment above.
    detail.push({ label: 'Billing treatment', value: 'Prior-period usage is added to the next billing-cycle invoice.' })
    // Step 17G.6E, items 4-7 — re-audited a second time, directly against
    // app/api/admin/invoice-scheduler/route.ts (not re-derived from
    // memory): the fixedFeeDecision gate (lines ~404-417,
    // resolveFixedFeeSchedulingDecision) and the overage-attachment logic
    // (lines ~475-497, the unconditional "immediately preceding period"
    // lookup) are two SEPARATE pieces of code — the gate decides IF/WHEN
    // this run proceeds at all; once past it, the SAME attachment code
    // runs regardless of which value gated it through. The invoice-
    // creation section (lines ~951-1013) then writes row.base_amount
    // (the fixed fee) and every overageLineItems entry (the prior
    // period's usage) to the exact same `invoiceId`, unconditionally.
    // Net finding: bill_at_period_start and bill_at_period_end produce
    // the IDENTICAL composition (current period's fixed fee + prior
    // period's usage, one invoice) — the field only ever changes the
    // calendar date that combined invoice is allowed to fire on, never
    // what's on it. This was re-verified, not assumed, specifically
    // because the prior pass's unresolved-state wording over-claimed
    // this same conclusion without re-deriving it fresh — the finding
    // itself was already correct, but stating it while the decision was
    // still open was the actual problem, fixed below by not stating any
    // eventual-content claim until the decision resolves.
    if (terms.base_monthly_fee || terms.base_annual_fee) {
      const billingTiming = terms.fixed_fee_billing_timing
      const blockedByFixedTiming = !billingTiming || billingTiming.requires_confirmation
      // Step 17G.6F, items 3/4/7 — the new controlled-vocabulary
      // dependency fact (item 1's "Blocked by upstream decision" /
      // "Ready for invoice" states), reusing the SAME fixed_fee_billing_
      // timing check "Invoice composition" below already audits — never a
      // second, independently-derived blocker signal. This is what makes
      // decision PROPAGATION explicit (the fixed component's own
      // Recurring fixed-fee timing row is the single place that decision
      // lives; this row only ever explains the downstream CONSEQUENCE for
      // this component, never duplicates the decision itself).
      // Step 17G.6G, item 6 — "before invoice finalization," not "before
      // the combined invoice can be finalized": the latter presumed a
      // specific eventual invoice composition (combined) that hasn't been
      // verified for every timing outcome at the point this text is
      // shown — this sentence states only that finalization is blocked,
      // never what shape the eventual invoice takes.
      detail.push({
        label: 'Invoice status',
        value: blockedByFixedTiming ? 'Blocked by upstream decision' : 'Ready for invoice',
        helperText: blockedByFixedTiming ? 'Recurring fixed-fee timing must be resolved before invoice finalization.' : undefined,
      })
      if (blockedByFixedTiming) {
        // Item 5 — simple, and deliberately says nothing about eventual
        // invoice content. Secondary sentence only states the verified,
        // present-tense fact that transmission is on hold — not a
        // prediction of what a future invoice will contain.
        detail.push({
          label: 'Invoice composition',
          value: 'Pending recurring fixed-fee timing decision. Invoice transmission remains on hold until this decision is resolved.',
        })
      } else if (billingTiming.timing === 'bill_at_period_end') {
        detail.push({ label: 'Invoice composition', value: 'Prior-period usage is combined with the current period’s recurring fixed fee, invoiced at the end of that period.' })
      } else {
        detail.push({ label: 'Invoice composition', value: 'Prior-period usage is combined with the current period’s recurring fixed fee.' })
      }
    }
    // Step 17H.4B0D4H1B4E2.5 §9-13 — a flat per-unit fee whose RATE is
    // itself a derived metric (e.g. "value-weighted payment rate = paid
    // invoice value ÷ total invoice value" — lib/types.ts's own doc
    // example) states that formula here, genuinely distinct from
    // percentage_of_basis (never reclassifies this fee as Performance —
    // it's still a plain per-unit usage charge). Read straight off the
    // fee's own typed derived_metric.formula, never invented.
    if (f.derived_metric) {
      detail.push({ label: 'Rate calculation', value: f.derived_metric.formula })
    }
    // Step: consolidate Operational Inputs by semantic ownership — this
    // fee's own required_operational_inputs, its derived_metric's own
    // raw_inputs (previously unread here — orphaned into the neutral
    // "Other required inputs" fallback even though they belong to THIS
    // fee via a typed relationship, not a label guess), plus every matched
    // tier's own, deduplicated, colocated here as "Required inputs" rows
    // (the same {label, value: 'Source: ...'} shape buildPerformanceComponents
    // already uses, bucketed automatically by lib/commercial-logic-
    // grouping.ts's existing, unmodified ruleCategoryFor check — never a
    // second, standalone "Operational Inputs" definition surface).
    const requiredInputKeys = Array.from(new Set([
      ...(f.required_operational_inputs ?? []),
      ...(f.derived_metric?.raw_inputs ?? []),
      ...matchingTiers.flatMap(t => t.required_operational_inputs ?? []),
    ]))
    for (const key of requiredInputKeys) {
      detail.push({ label: humanizeKey(key), value: 'Source: Manual operational input' })
    }
    return {
      key: `usage_${f.fee_label}`,
      title: f.fee_label,
      pricingModel: 'usage' as const,
      pricingModelLabel: 'Usage-based',
      summaryLines,
      billingCadence: cadenceLabel(f.billing_frequency ?? terms.billing_frequency),
      detail,
      hasUnresolvedDecision: false,
      consumedOperationalInputKeys: requiredInputKeys,
      recurringFeeId: f.recurring_fee_id ?? null,
    }
  })
}

// One performance-based component per percentage_of_basis fee — surfaces
// what's being measured and how (never a false "SEK 0" unit price, item
// 10), plus its own variable_invoice_timing decision (item 12: a
// provenance-aware reviewer decision, never an ordinary editable field).
function buildPerformanceComponents(terms: CommercialComponentsTerms): CommercialComponent[] {
  const fees = (terms.additional_recurring_fees ?? []).filter(f => !!f.percentage_of_basis)
  return fees.map(f => {
    const config = f.percentage_of_basis!
    const timing = f.variable_invoice_timing
    // Step 17G.5A — "Calculation" and "Measurement timing" added alongside
    // the existing facts (never replacing them — Products, Services &
    // Pricing keeps rendering the same detail array, so this is additive
    // duplication during the transition, per plan). numerator/denominator
    // are read straight off DerivedMetric's own typed keys, no new
    // arithmetic. "Determined after the billing period closes" is a fixed
    // architectural fact (lib/performance-share-fee.ts only ever resolves
    // a period once every required operational input is active+finalized
    // for it — see PerformanceShareDisplay's own doc comment in page.tsx),
    // not a per-contract guess.
    const humanize = humanizeKey // module-level, shared with buildUsageComponents
    // Step 17G.6A, item 12 — relabeled "Basis" -> "Charge basis" and
    // "Rate" -> "Rate selection" (item 14's canonical vocabulary),
    // "Measurement timing" -> "Measurement" reworded to "Calculated
    // after..." to match the item's exact wording. Values unchanged.
    // Step 17G.6D, item 34 — capitalized like every other humanized
    // label on this card ("Value weighted payment rate," not "value
    // weighted payment rate"). The exact hyphenation your example shows
    // ("Value-weighted") isn't safely reconstructable from the raw
    // snake_case key alone — nothing distinguishes which underscore was
    // originally a hyphen vs. a space — so this stays a plain
    // capitalize-first-letter transform rather than a guess.
    const detail: ComponentDetailFact[] = [
      { label: 'Performance measure', value: humanize(config.derived_metric.metric_key) },
      { label: 'Calculation', value: `${humanize(config.derived_metric.numerator_input_key)} ÷ ${humanize(config.derived_metric.denominator_input_key)}` },
      { label: 'Charge basis', value: humanize(config.basis_input_key) },
      { label: 'Rate selection', value: 'Contractual rate schedule' },
    ]
    // Step 17G.6F, item 5 — "Used to calculate" -> "Calculation flow": the
    // full step-by-step chain from raw inputs to the final charge, in one
    // place, replacing the shorter arrow-sentence. Every step is read
    // straight off this same config — numerator/denominator (the
    // Calculation fact above), the derived metric itself, and the two
    // fixed architectural steps every percentage_of_basis fee goes
    // through (a rate lookup against the contractual schedule, then the
    // resulting charge) — never a second, independently-invented
    // calculation.
    detail.push({
      label: 'Calculation flow',
      value: [
        humanize(config.derived_metric.numerator_input_key),
        `÷ ${humanize(config.derived_metric.denominator_input_key)}`,
        `→ ${humanize(config.derived_metric.metric_key)}`,
        '→ Applicable contractual rate',
        '→ Performance-share charge',
      ].join('\n'),
    })
    // Step 17G.6A, item 5 — the required operational inputs this
    // calculation depends on, deduplicated (basis_input_key is often the
    // SAME key as denominator_input_key, as in the real Remembill
    // shape — must not be listed twice). Source is a currently-true
    // architectural constant, not per-contract state: every operational
    // input this codebase supports today is manual entry (see
    // OperationalInputCard's own "Source method: Manual entry" — no other
    // source-method type exists yet), so this is read straight off that
    // same fact, never invented or fetched separately here (this module
    // stays pure/DB-free). Placed between Calculation flow and
    // Measurement/Invoice timing, matching item 12's exact expected
    // section order.
    const requiredInputKeys = Array.from(new Set([
      config.derived_metric.numerator_input_key, config.derived_metric.denominator_input_key, config.basis_input_key,
    ]))
    for (const key of requiredInputKeys) {
      detail.push({ label: humanize(key), value: 'Source: Manual operational input' })
    }
    detail.push({ label: 'Measurement', value: 'Calculated after the billing period closes.' })
    // Step 17G.6G — reverted 17G.6F's "Performance-share invoice timing"
    // relabel back to plain "Invoice timing": generic wording suitable for
    // ANY performance/outcome-based variable charge, not just one
    // literally named "performance share" — the enclosing component's own
    // accordion title already establishes context, so no per-mechanism
    // prefix is needed. Question reverted to the exact same generic
    // wording the ReviewPanel already uses (page.tsx), word-for-word —
    // never an invented, contract-specific elaboration.
    //
    // Step 17H.4B0D4H1B4E5.2 — this used to treat requires_confirmation:false
    // alone as "resolved" (value: 'Invoiced at period end', decisionRequired:
    // false) even for 'invoice_at_period_end', which has NO execution path
    // (see isVariableInvoiceTimingConfirmed's own header in
    // lib/rule-interpretation.ts) — the exact "UI says resolved while
    // runtime says not executable" defect this pass closes. Reuses that
    // SAME shared predicate (never a second, possibly-diverging check) so
    // this card can never disagree with what lib/performance-share-pull.ts
    // actually does at billing time. A genuinely reviewer-confirmed but
    // non-executable choice gets its own honest THIRD state — distinct
    // from both "fully ready" and "nothing chosen yet" — rather than being
    // folded into either.
    const isExecutable = isVariableInvoiceTimingConfirmed(timing)
    const isConfirmedButNotExecutable = !!timing && !timing.requires_confirmation && !isExecutable
    const timingUnresolved = !isExecutable
    detail.push({
      label: 'Invoice timing',
      value: isExecutable
        ? 'Invoiced at start of next period'
        : isConfirmedButNotExecutable
        ? 'Invoiced at period end — needs configuration'
        : 'Decision required',
      decisionRequired: timingUnresolved,
      helperText: isExecutable
        ? undefined
        : isConfirmedButNotExecutable
        ? 'Verdix does not yet have an execution path for invoicing exactly at period end — choose "At the start of the next billing period" instead, or leave this open until that configuration is available.'
        : 'When should the calculated variable charge be invoiced?',
    })
    return {
      key: `performance_${f.fee_label}`,
      title: f.fee_label,
      pricingModel: 'performance' as const,
      pricingModelLabel: 'Performance-based',
      summaryLines: ['Rate determined by ' + config.derived_metric.metric_key.replace(/_/g, ' ')],
      billingCadence: cadenceLabel(f.billing_frequency ?? terms.billing_frequency),
      detail,
      rateSchedule: config.rate_schedule.bands,
      hasUnresolvedDecision: detail.some(d => d.decisionRequired),
      consumedOperationalInputKeys: requiredInputKeys,
      recurringFeeId: f.recurring_fee_id ?? null,
    }
  })
}

export function buildCommercialComponents(terms: CommercialComponentsTerms | undefined, cur: string): CommercialComponent[] {
  if (!terms) return []
  const fixed = buildFixedComponent(terms, cur)
  const usage = buildUsageComponents(terms, cur)
  const performance = buildPerformanceComponents(terms)
  return [...(fixed ? [fixed] : []), ...usage, ...performance]
}
