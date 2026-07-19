export interface OverageTier {
  tier_label: string
  from_unit: number | null
  to_unit: number | null
  rate_per_unit: number
  unit_type: string
}

export interface PriceEscalator {
  escalator_pct: number | null
  escalator_type: 'fixed_pct' | 'CPI' | 'CPI_cap' | 'flat_amount'
  effective_date: string | null
  applies_from_year: number | null
  cap_pct: number | null
  description: string
}

export interface Discount {
  discount_pct: number | null
  discount_amount: number | null
  discount_type: 'introductory' | 'volume' | 'negotiated' | 'other'
  start_date: string | null
  end_date: string | null
  duration_months: number | null
  applies_to: string
  description: string
}

export interface OneTimeFee {
  fee_label: string
  amount: number
  due_date: string | null
  description: string | null
}

export interface AdditionalRecurringFee {
  fee_label: string
  amount: number          // amount per billing period (same cadence as base_monthly_fee)
  description: string | null
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
  unit_type: string
  meter_id: string
  price_id: string
  subscription_item_id: string
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
