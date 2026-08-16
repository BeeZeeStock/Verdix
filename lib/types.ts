// A minimum commitment is commercially ambiguous the moment it coexists with
// an included allowance on the same metric (does the minimum apply before or
// after the free units? is it a floor under usage charges, or an additional
// fixed charge on top?) — never inferred silently. requires_confirmation
// defaults to true whenever that ambiguity is detected at extraction time;
// the billing owner picks the interpretation in the review workflow, and
// only a confirmed commitment counts toward committed_contract_value.
export interface MinimumCommitment {
  /** floor: max(usage_charge, amount). additive: amount charged on top of usage regardless.
   *  minimum_spend: amount is a spend commitment usage consumes, shortfall billed at true-up.
   *  prepaid_commitment: amount is prepaid, usage draws down from it.
   *  minimum_quantity: a unit-quantity commitment (take-or-pay), not a currency floor. */
  mode: 'floor' | 'additive' | 'minimum_spend' | 'prepaid_commitment' | 'minimum_quantity'
  amount: number
  currency?: string | null
  /** Cadence this commitment is evaluated over. Defaults to the tier's own measurement_period when unset. */
  period?: 'monthly' | 'quarterly' | 'semi-annual' | 'annual' | null
  included_allowance_interaction?: 'before_allowance' | 'after_allowance' | 'unclear'
  rollover?: boolean
  prorate_partial_periods?: boolean | 'unclear'
  source_clause?: string | null
  requires_confirmation: boolean
  confirmation_reason?: string | null
}

// How a metric's tier table is actually evaluated once usage crosses a
// second band — this is the one piece of tiered-pricing semantics that
// changes the invoice total even when the rate table itself is identical.
// graduated/staircase: each band's rate applies only to the units within it.
// volume/all-units: the band containing total quantity sets the rate for
// ALL qualifying units. block: reaching a band charges a flat fee for that
// band (not a per-unit rate). custom: contract language doesn't map cleanly
// onto any of the above — requires_confirmation must be true.
// Same shape as DiscountInterpretation.tier_method — reused, not duplicated,
// because the ambiguity is identical whether the tier table sets prices,
// discounts, or overage rates.
export interface TierCalculationMethod {
  method: 'graduated' | 'volume' | 'block' | 'custom'
  source_clause?: string | null
  requires_confirmation: boolean
  confirmation_reason?: string | null
}

export interface OverageTier {
  tier_label: string
  from_unit: number | null
  to_unit: number | null
  rate_per_unit: number
  unit_type: string
  /** How often usage is accumulated and billed. May differ from the contract's main billing_frequency. */
  measurement_period?: 'monthly' | 'quarterly' | 'semi-annual' | 'annual' | null
  /** Minimum payment per measurement period regardless of actual usage (a consumption floor).
   *  @deprecated kept for backward compatibility with existing extracted/stored data — prefer
   *  minimum_commitment, which can represent modes other than a pure floor and carries its own
   *  confirmation state. New extractions populate both when a minimum is present. */
  minimum_period_amount?: number | null
  /** Structured minimum-commitment rule, when the contract states one for this metric. */
  minimum_commitment?: MinimumCommitment | null
  /** Whether measurement_period resets on the contract's own start-date anniversary (default,
   *  preserves existing behavior) or on true calendar boundaries (Jan/Apr/Jul/Oct for quarterly,
   *  Jan/Jul for semi-annual, Jan for annual) — only set to 'calendar' when the contract text
   *  explicitly says so (e.g. "calendar quarter"); never inferred. */
  reset_anchor?: 'contract_start' | 'calendar' | null
  /** How this metric's tier table is evaluated once usage spans more than one
   *  band. Null on pre-existing rows (extracted before this field existed) —
   *  the calculation engine treats null as 'graduated' for backward
   *  compatibility only; every new extraction populates this explicitly. */
  tier_calculation?: TierCalculationMethod | null
}

// A reviewer's resolved reading of an escalator whose actual rate can't be
// known at contract signing (CPI-linked, etc.) — mirrors MinimumCommitment's
// confirmation pattern: never fabricated, always explicit, always attributable.
//
// treatment is the field that actually decides what shows and what runs:
// 'applies' means the fields below describe a real, executable escalation;
// 'not_applied' means the reviewer explicitly decided to exclude the clause
// entirely (never inferred from empty fields — a reviewer who says "ignore
// this" produces a `treatment: 'not_applied'` interpretation, not a
// half-filled 'applies' one with placeholder-ish index/frequency values).
// Only 'applies' requires index/frequency/calculation_method to be real.
export interface EscalatorInterpretation {
  treatment: 'applies' | 'not_applied'
  index: 'CPI' | 'fixed_pct' | 'other' | null
  frequency: 'annual' | 'monthly' | 'quarterly' | null
  effective_date: string | null
  cap_pct: number | null
  /** Plain-English calculation formula, e.g. "CPI change + 2pp, capped at 6% per 12-month period" — never fabricated. Null when treatment is 'not_applied'. */
  calculation_method: string | null
  requires_confirmation: boolean
  confirmation_reason?: string | null
}

export interface PriceEscalator {
  escalator_pct: number | null
  escalator_type: 'fixed_pct' | 'CPI' | 'CPI_cap' | 'flat_amount'
  effective_date: string | null
  applies_from_year: number | null
  cap_pct: number | null
  description: string
  /** Reviewer-approved structured reading of this escalator's actual calculation, once resolved. */
  interpretation?: EscalatorInterpretation | null
}

// A tiered/volume discount schedule's own row — same shape whether the
// value is a percentage or a flat amount (see DiscountInterpretation.discount_basis).
export interface DiscountTierRow {
  from_unit: number | null
  to_unit: number | null
  value: number
}

// The two dimensions "before/after tiers" conflates: WHAT kind of discount
// this is, and HOW its tier structure is actually evaluated. A staircase
// (graduated) tier table and a volume (all-units) tier table can share the
// exact same rate schedule and still produce materially different invoice
// totals — tier_method is what tells them apart, and must never be assumed.
// The same ambiguity applies to tiered *pricing* — see OverageTier.tier_calculation,
// which uses this identical method vocabulary (TierCalculationMethod) so the
// two aren't interpreted by parallel, potentially-diverging models.
export interface DiscountInterpretation {
  discount_type: 'flat_percentage' | 'flat_amount' | 'tiered_discount' | 'volume_discount' | 'component_specific' | 'time_ramp' | 'custom'
  discount_basis: 'percentage' | 'amount'
  /** How a tiered/volume discount's bands are evaluated — meaningless (null) for a flat discount. */
  tier_method: 'graduated' | 'volume' | 'block' | 'custom' | null
  tiers: DiscountTierRow[] | null
  /** What the discount reduces, e.g. "usage charge", "base fee", or a specific named component. */
  applies_to: string | null
  /** Plain-English ordering relative to other pricing rules, e.g. "after usage pricing". */
  application_order: string | null
  reset_period: 'monthly' | 'quarterly' | 'semi-annual' | 'annual' | 'contract_term' | 'cumulative' | 'custom' | null
  /** A concrete numeric walkthrough at a sample quantity — lets a Finance reviewer validate the rule without decoding internal field names. */
  worked_example: string | null
  requires_confirmation: boolean
  confirmation_reason?: string | null
}

export interface Discount {
  /** Stable identifier so a contract with multiple discounts can address each
   *  one independently (review, interpretation, audit trail) instead of only
   *  ever operating on array position. Populated at extraction time; a
   *  pre-existing row that predates this field gets one backfilled on first
   *  write by confirm-rule rather than staying positionally-addressed forever. */
  discount_rule_id?: string
  discount_pct: number | null
  discount_amount: number | null
  discount_type: 'introductory' | 'volume' | 'negotiated' | 'other'
  start_date: string | null
  end_date: string | null
  duration_months: number | null
  applies_to: string
  description: string
  /** Reviewer-approved structured reading of this discount's actual tier/application mechanics, once resolved. */
  interpretation?: DiscountInterpretation | null
}

export interface OneTimeFee {
  fee_label: string
  amount: number
  due_date: string | null
  description: string | null
  /** True when the fee requires manual delivery confirmation before invoicing (e.g. professional services charged per hour) */
  manual_trigger?: boolean
  /** Unit of the delivery metric, e.g. "hours", "days", "sessions" */
  metric_name?: string | null
  /** Rate per metric unit — used to calculate the invoice amount at trigger time */
  rate_per_unit?: number | null
}

export interface AdditionalRecurringFee {
  fee_label: string
  amount: number          // amount per billing period
  description: string | null
  /** Billing cadence for this fee when it differs from the contract's main billing_frequency. */
  billing_frequency?: 'monthly' | 'quarterly' | 'semi-annual' | 'annual' | null
}

export interface RampStep {
  start_date: string
  end_date: string
  monthly_fee: number
  label?: string
}

export interface ContractTerms {
  contract_id: string | null
  crm_id: string | null
  customer_name: string | null
  customer_address: string | null
  billing_contact: string | null
  vendor_name: string | null
  vendor_address: string | null
  order_date: string | null
  contract_start_date: string | null
  contract_end_date: string | null
  contract_term_months: number | null
  auto_renews: boolean | null
  renewal_notice_days: number | null
  customer_email?: string | null
  customer_org_number?: string | null
  /** Length of each successive renewal period in months. Often differs from the initial term. */
  renewal_term_months?: number | null
  currency: string
  base_monthly_fee: number | null
  base_annual_fee: number | null
  billing_frequency: 'monthly' | 'quarterly' | 'semi-annual' | 'annual' | null
  payment_terms_days: number | null
  payment_terms_text: string | null
  included_units: number | null
  included_unit_type: string | null
  year_pricing: Record<string, number> | null
  ramp_schedule: RampStep[] | null
  escalators: PriceEscalator[]
  discounts: Discount[]
  overage_tiers: OverageTier[]
  billing_metered_items?: BillingMeteredItem[]
  additional_recurring_fees: AdditionalRecurringFee[] | null
  one_time_fees: OneTimeFee[]
  field_sources: Record<string, string>
  extraction_confidence: 'high' | 'medium' | 'low'
  extraction_notes: string | null
  number_format?: 'dot' | 'comma'
}

export interface BillingRecord {
  invoiceId: string
  customerName: string
  customerId?: string
  invoiceDate: Date
  amountBilled: number
  currency: string
  status: string
  contractRef?: string
  /** e.g. "subscription", "usage", "additional_users", "overage" — populated when the CSV has a type/line_item_type column */
  invoiceType?: string
}

export interface LeakageFinding {
  finding_id: string
  leakage_type: 'ESCALATOR_MISS' | 'DISCOUNT_OVERHANG' | 'OVERAGE_UNBILLED'
  customer_name: string
  contract_id: string | null
  invoice_id?: string
  billing_month: string
  description: string
  contracted_amount: number
  billed_amount: number
  leakage_amount: number
  evidence: string
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  priority: 'CRITICAL' | 'HIGH' | 'MEDIUM'
}

export interface ApprovedLineItem {
  product_name: string
  quantity: number
  unit_price: number
  billing_period: string
  total_amount: number
  currency: string
}

export interface BillingMeteredItem {
  unit_type:            string
  meter_id:             string
  price_id:             string
  subscription_item_id: string
  /** @deprecated Lago was removed in favour of the on-demand pull model. Field is preserved for backward compatibility with existing JSONB rows but is no longer read by any runtime path. */
  lago_metric_code?: string
}

export interface PartnerInvoiceLine {
  description: string
  quantity: number | null
  unit_rate: number | null
  volume: number | null
  amount_billed: number
  currency: string
  reference: string | null
}
