import { writeFileSync } from 'fs'
import { ContractTerms, OverageTier } from './types'
import { buildLearningContext } from './learning-context'
import { getAIClient, AI_PROVIDER } from './ai-client'

const client = getAIClient()
const DEBUG_EXTRACTION = process.env.DEBUG_EXTRACTION === 'true'

const SYSTEM_PROMPT = `You are a contract analysis specialist. Extract structured billing and commercial terms from SaaS contracts and order forms.

Output a single JSON object. All numeric fields must be numbers (not strings). Dates must be ISO 8601 (YYYY-MM-DD). Use null for any field you cannot determine with confidence.

Rules:
- base_monthly_fee: the PRIMARY recurring monthly fee component — the platform/base access fee only. When a contract has multiple SEPARATE named recurring fees (e.g. "Platform Fee: €4,500/mo" AND "Dedicated Support: €1,200/mo"), set base_monthly_fee to the platform/access fee ONLY (€4,500) and put the remaining components in additional_recurring_fees. NEVER sum distinct named fees into base_monthly_fee.
  QUARTERLY FEE RULE: If the primary recurring fee is stated as a quarterly amount (e.g. "SEK 75,000 per quarter", "invoiced quarterly in advance"), convert to monthly: base_monthly_fee = quarterly_amount / 3, and set billing_frequency = 'quarterly'. The system stores monthly equivalents internally regardless of invoicing cadence. Example: SEK 75,000/quarter → base_monthly_fee = 25000, billing_frequency = 'quarterly'. Similarly, a semi-annual fee of SEK 60,000 → base_monthly_fee = 10000, billing_frequency = 'semi-annual'.
- additional_recurring_fees: array of secondary recurring fee components that exist alongside base_monthly_fee. Each entry: { "fee_label": "<name>", "amount": <number>, "description": "<brief note or null>", "billing_frequency": "<cadence or null>" }. Use this when the contract explicitly lists multiple SEPARATE recurring line items with distinct names and amounts. The "amount" is the fee per billing period (whatever cadence the fee uses). Set "billing_frequency" on the entry when this fee bills at a different cadence than the main billing_frequency (e.g. main contract bills quarterly but this fee bills monthly). Example: if a contract has "Base Access: €4,500/mo" and "Premium Support: €1,200/mo", then base_monthly_fee=4500 and additional_recurring_fees=[{"fee_label":"Dedicated Premium Support - 2hr SLA Window","amount":1200,"description":"...","billing_frequency":null}]. Leave as [] when there is only one recurring fee.
  CRITICAL RULE for "base price × users" language: SaaS contracts commonly state additional user fees separately (e.g. "base platform fee: €456,987/yr + additional users at €2,500/user/yr"). In this pattern, base_monthly_fee or base_annual_fee = the platform fee alone (€456,987), and the user fees go into overage_tiers or a separate line. NEVER multiply the platform fee by the user count — that would be double-counting. The only time you multiply a rate by users is when the contract EXPLICITLY states a per-seat price (e.g. "€500/user/month for 10 users = €5,000/month total") where the stated per-seat figure is small and clearly a unit rate. A base annual platform fee in the hundreds of thousands is never a per-seat rate.
- base_annual_fee: annual fee if billed annually
- year_pricing: year-by-year fee schedule as {"year1": 50000, "year2": 55000, ...}. Each value is the INVOICE AMOUNT DUE IN THAT YEAR ONLY — never cumulative totals.
  CRITICAL RULE: Some contracts express multi-year pricing cumulatively, e.g. "Year 2 = Year 1 fee + base annual fee + user fees" or "Year 3 = Year 1 + Year 2 + new fees". This is describing Total Contract Value (TCV) building up over time, NOT what is invoiced in each year. You must extract what is actually INVOICED / OWED in each individual year:
    - year1 = the annual fee for Year 1 only (e.g. base after discount + Year 1 user fees)
    - year2 = the annual fee for Year 2 only (e.g. base + Year 2 user fees) — NOT Year 1 + Year 2 combined
    - year3 = the annual fee for Year 3 only (e.g. base + Year 3 user fees) — NOT Year 1 + Year 2 + Year 3 combined
  Example: contract says "Year 1: €436,288 | Year 2: Year 1 fee (€436,288) + base (€456,987) + 10 users × €2,500 | Year 3: Year 1 + Year 2 + base + 20 users × €2,500". Correct extraction: year1=436288, year2=481987, year3=506987. WRONG extraction: year1=436288, year2=918275, year3=1425262.
- ramp_schedule: use when the contract defines a step-up fee schedule tied to specific calendar date ranges (e.g. Month 1-6, Month 7-12, etc.). Each entry: { "start_date": "YYYY-MM-DD", "end_date": "YYYY-MM-DD", "monthly_fee": <number>, "label": "<optional short label>" }. When ramp_schedule is populated, set year_pricing to null and base_monthly_fee/base_annual_fee to null. Escalators are already baked into the ramp rates — do not also populate escalators.
- customer_address: full mailing address of the customer (street, city, country)
- customer_email: billing or invoice email address for the customer (e.g. "invoices@customer.com"). Extract from billing contact fields, "invoice address", "e-faktura" address, or any email address associated with the customer. Set to null if not stated.
- customer_org_number: company registration number / organisationsnummer / VAT number / CVR for the customer (e.g. "559999-9999" in Sweden, "123456789" in UK). Look for "org.nr", "organisationsnummer", "CVR-nr", "VAT reg.", "company number". Set to null if not found.
- billing_contact: billing contact email or name from the contract
- vendor_address: full mailing address of the vendor/supplier
- payment_terms_text: exact payment terms string e.g. "Net 30 days from invoice date"
- renewal_notice_days: the number of calendar days' notice required to prevent auto-renewal
- renewal_term_months: the LENGTH of each successive renewal period in months. This is OFTEN DIFFERENT from the initial contract term. Example: a 12-month contract that "automatically renews for successive six-month periods" → contract_term_months = 12, renewal_term_months = 6. Set to null only when the renewal period is not specified or explicitly equals the initial term.
- escalators: automatic price increases (CPI clauses, fixed % increases, etc.)
  CPI ESCALATOR RULE: For CPI-linked, inflation-linked, or index-linked price adjustments where the exact future rate is unknown at signing: set escalator_pct = null (the actual CPI rate cannot be known at contract time), set escalator_type = 'CPI_cap' when there is a maximum cap, set cap_pct = the stated maximum percentage cap, and set description = the complete escalation formula in plain English (e.g. 'CPI change + 2 percentage points, maximum 6% per 12-month period'). NEVER set escalator_pct = 0 for CPI clauses — a 0% rate means no price change, which misrepresents the contract. Use null to indicate the rate is variable and unknown at signing.
  INDEX NAME RULE: If the contract names a SPECIFIC index (e.g. "HICP", "RPI", "Consumer Price Index for Urban Consumers"), preserve that exact name verbatim inside description — never silently generalize a named index to "CPI". escalator_type still uses the closed 'CPI_cap' classification for any index-linked clause regardless of which specific index it names; the named index itself only ever appears in description's text, e.g. "HICP change, capped at 4% per annum, applied at renewal" (not "CPI change...") when the contract says HICP.
  RENEWAL-TIMING RULE: If the escalation is explicitly tied to renewal ("on renewal, the fee may be increased by...") rather than recurring automatically every 12 months during the original term, say so explicitly in description (e.g. include the words "applied at renewal"). Do not conflate a renewal-triggered step with an ordinary automatic annual escalator — they read differently to a human reviewer and must not be described identically.
  DISCRETION RULE: If the contract uses discretionary language ("may be increased", "is entitled to increase") rather than mandatory language ("shall be increased", "will increase"), include that discretion in description (e.g. "...the vendor MAY increase the fee, subject to..."). Do not drop the word "may"/"shall" when paraphrasing — a human reviewer needs to see whether the increase is automatic or requires a separate decision.
- discounts: introductory or volume discounts with explicit start/end dates
- overage_tiers: usage-based charges above included units. Each tier must have:
  - from_unit: the first unit in this tier's range (the cumulative usage count, NOT a billing-block denominator). E.g. for graduated API tiers priced per 1,000 calls: Tier 1 = from_unit:1, to_unit:10000; Tier 2 = from_unit:10001, to_unit:100000; Tier 3 = from_unit:100001, to_unit:null.
  - to_unit: last unit in range, null if open-ended
  - rate_per_unit: price PER SINGLE unit (e.g. price per 1 API call, or price per 1 seat). If the contract says "€2.40 per 1,000 calls", rate_per_unit = 0.0024 (divide by 1000). EXCEPTION: if unit_type explicitly contains "1,000" or "per block", keep the rate as stated and set unit_type accordingly.
  - unit_type: the measurable quantity, e.g. "API call", "user seat", "GB storage"
  - measurement_period: how often usage is accumulated and billed for this metric. Set to 'monthly', 'quarterly', 'semi-annual', or 'annual'. CRITICAL: this often DIFFERS from the contract's main billing_frequency. Examples: a contract may measure API usage monthly and invoice monthly, but measure validated invoice lines half-yearly and invoice half-yearly; or measure active-contract counts monthly but invoice quarterly in arrears. Always read the measurement/invoicing period stated for each specific metric. Set to null only when not separately stated (fall back to main billing_frequency).
  - reset_anchor: set to 'calendar' ONLY when the contract text explicitly ties this metric's measurement window to fixed calendar boundaries — the words "calendar quarter", "calendar year", "calendar half-year", or equivalent (e.g. "measured each calendar quarter (Jan–Mar, Apr–Jun, ...)"). Otherwise set to 'contract_start' (the default — windows reset on the contract's own start-date anniversary). NEVER infer 'calendar' from context or convenience; only an explicit calendar-boundary statement qualifies.
  - minimum_period_amount: if the contract states a guaranteed minimum payment per measurement period for this metric (a consumption floor), set this to the minimum amount per period. Example: "minimum SEK 30,000 per half-year for validated invoice lines" → minimum_period_amount: 30000 (with measurement_period: 'semi-annual'). This is a floor payment separate from the per-unit rate — the customer pays at least this amount even if usage is below the floor. Also populate minimum_commitment (below) alongside this field whenever a minimum is stated.
  - minimum_commitment: populate whenever the contract states ANY form of guaranteed minimum, floor, or take-or-pay commitment for this metric — a structured object: { "mode": "floor" | "additive" | "minimum_spend" | "prepaid_commitment" | "minimum_quantity", "amount": <number>, "currency": "<ISO code or null>", "period": "<cadence or null, defaults to measurement_period>", "included_allowance_interaction": "before_allowance" | "after_allowance" | "unclear", "rollover": <boolean or omit>, "prorate_partial_periods": true | false | "unclear", "applies_at_zero_usage": true | false | "unclear" | omit, "source_clause": "<verbatim or paraphrased clause, or null>", "requires_confirmation": <boolean>, "confirmation_reason": "<string or null>" }.
    - mode: 'floor' = pay max(usage charge, minimum). 'additive' = minimum is charged ON TOP of usage regardless. 'minimum_spend' = a spend commitment that usage draws against, with any shortfall billed as a true-up. 'prepaid_commitment' = the amount is paid up front and usage draws down from it. 'minimum_quantity' = a unit-quantity (take-or-pay) commitment, not a currency floor — the customer is billed for at least this many units even if actual usage is lower. Read the contract's actual mechanism; do not default to 'floor' when the text describes a different mechanism.
    - included_allowance_interaction: set to 'before_allowance' or 'after_allowance' ONLY when the contract text explicitly states whether the minimum applies before or after the included/free allowance is consumed. This is frequently NOT stated even when both a minimum and an included allowance exist on the same metric — in that case you MUST set this to 'unclear' rather than guessing. Do not resolve the ambiguity yourself.
    - applies_at_zero_usage: for mode 'floor'/'minimum_spend' only. Whether the minimum is still owed for a period with genuinely zero usage (as distinct from low-but-nonzero usage) is a separate question from whether the floor exists — set true or false ONLY when the contract text actually addresses this specific scenario (e.g. "the minimum applies regardless of usage, including nil usage" → true; "no charge applies if the service was not used during the period" → false). Omit the field entirely when the contract simply states a minimum without addressing the zero-usage case — do not infer an answer from the general existence of a minimum.
    - requires_confirmation: set to true whenever included_allowance_interaction is 'unclear' AND this metric also has a non-zero included_units/allowance, OR whenever prorate_partial_periods is 'unclear' and the contract has calendar-anchored cadence, OR whenever the mechanism itself (mode) is not clearly stated. Set to false only when the contract text leaves no reasonable ambiguity about how this minimum interacts with everything else on the metric. When in doubt, set true — a human reviewer resolves it, you must never guess and mark it resolved.
    - confirmation_reason: a short plain-English note on what specifically is ambiguous (e.g. "Contract states a SEK 5,000 minimum per line but does not say whether it applies before or after the 200 included lines"), or null when requires_confirmation is false.
  - For graduated/incremental tiers: each call falls into exactly one bracket and is billed at that bracket's rate. Encode as distinct non-overlapping from_unit/to_unit ranges.
  - For volume tiers (all-or-nothing): if the contract specifies a single rate that applies to the entire volume once a threshold is hit, set from_unit to the threshold and to_unit:null for each tier.
  - tier_calculation: REQUIRED whenever a metric has 2 or more paid (non-zero rate_per_unit) tiers — a rate table alone does not say HOW it is evaluated once usage spans more than one band, and graduated vs. volume can produce materially different totals from the identical table (example: tiers 1–100 @ 10 and 101–200 @ 8; at 150 units, graduated = 100×10 + 50×8 = 1,400, but volume/all-units = 150×8 = 1,200 because the whole quantity re-rates once the threshold is crossed). Populate the SAME structured object on every tier row for that metric: { "method": "graduated" | "volume" | "block" | "custom", "source_clause": "<verbatim or paraphrased clause, or null>", "requires_confirmation": <boolean>, "confirmation_reason": "<string or null>" }.
    - method: "graduated" when the contract language describes each bracket applying only to units within it ("for the first X units... for units above X..."). "volume" when the contract says the whole quantity is re-rated once a threshold is reached ("once volume exceeds X, all units are billed at..."). "block" when reaching a band charges one flat fee for that band rather than a per-unit rate. "custom" when the mechanism doesn't map cleanly onto any of the three.
    - requires_confirmation: set to true whenever the contract text does not clearly establish which method applies — this is the common case; graduated must NEVER be assumed as a silent default just because it is the more familiar convention. Set to false only when the contract text is unambiguous about the mechanism.
    - confirmation_reason: a short plain-English note on what's ambiguous (e.g. "Contract states tiered per-unit rates for API calls but does not specify whether crossing a threshold re-rates all units or only the units above it"), or null when requires_confirmation is false.
    - A metric with only ONE paid tier (a single flat rate) has no graduated-vs-volume distinction to make — omit tier_calculation (or set it to null) for single-tier metrics.
    - This exact same method vocabulary and ambiguity rule applies to tiered/volume DISCOUNTS (see discounts below) — do not use a different standard for discount tiers than for pricing tiers.
  - CRITICAL — rate_per_unit decimal parsing: rates written as "€0.0500", "€0.035", "€0.02" are NOT zero. They are decimal fractions: 0.0500 = 0.05, 0.035, 0.02. Extract the full numeric value including leading-zero decimals. NEVER set rate_per_unit to 0 when a non-zero rate is stated in the contract.
  - TIER LABEL RULE: tier_label must describe the volume range. NEVER label a paid tier "Base Allowance" or "Included Units" — these phrases imply the tier is free. Use descriptive range labels like "Lines 1–50,000", "Up to 50,000", "50,001–250,000". Only use "Base Allowance" or "Included" language when those units are genuinely charged at zero (free). If the first tier has a non-zero rate, all tiers are paid — label them accordingly.
- service_credits: ANY clause that reduces a future charge on a condition — SLA/availability credits, rebates, promotional credits, earned/usage credits, waived fees, capped credits. Do NOT confuse with discounts (a discount reduces the PRICE up front; a service credit is a conditional reduction triggered by an EVENT — a breach, a threshold, a promotion). Each entry: { "credit_type": "sla" | "rebate" | "promotional" | "earned" | "usage" | "waiver" | "other", "description": "<short label>", "source_clause": "<verbatim or paraphrased clause, or null>", "stated_pct": <number or null>, "stated_amount": <number or null> }.
  - credit_type: "sla" for availability/uptime/SLA-breach credits, "rebate" for a volume/performance rebate, "promotional" for a limited-time promotional credit, "earned" for a milestone-triggered credit, "usage" for a usage-linked credit, "waiver" for a clause that waives/forgives an otherwise-applicable fee on a condition (e.g. "the onboarding fee is waived if the initial term exceeds 24 months"), "other" when none of these fit.
  - stated_pct / stated_amount: the raw percentage or flat amount as stated in the contract — extract ONLY the literal number, do not resolve what it's a percentage OF (e.g. "10% of that month's platform subscription fee" → stated_pct: 10; do not attempt to determine whether that's the discounted or undiscounted fee — that is a human reviewer's interpretation, not an extraction task).
  - Do NOT populate an "interpretation" field — that is filled in only after human review. Leave service_credits as bare extracted facts.
  - Only extract clauses that actually reduce a charge. A clause that merely describes a service-level TARGET with no stated financial consequence (no credit, no refund, no reduction) is not a service credit — do not invent one.
  - Actively search for this clause type — it is frequently located in an "SLA", "Service Levels", or "Availability" section physically separate from the pricing/fees section, not necessarily adjacent to the discount or escalator clauses. Do not skip it just because it isn't near the other commercial terms.
  - PENALTY CLAUSES (opposite polarity — do NOT put these in service_credits): a clause that imposes an ADDITIONAL charge on a condition (e.g. a late-payment penalty, a breach penalty, an early-termination fee) is not a service credit — service_credits only ever represents a reduction. There is no structured field for a conditional additional charge yet. Never drop it silently: write a plain-English sentence describing it (trigger condition, amount/percentage, what it applies to) into extraction_notes so a human reviewer still sees it, e.g. "Penalty clause detected but not structured: a 1.5% monthly interest penalty applies to invoices unpaid after 30 days (§7.2) — needs manual review." If extraction_notes already has content, append this as a new sentence rather than replacing it.
- one_time_fees: non-recurring charges paid once (e.g. onboarding, implementation, setup, migration, professional services). Each entry: fee_label (short name), amount (number), due_date (ISO date or null), description (brief note or null), manual_trigger (boolean), metric_name (string or null), rate_per_unit (number or null).
  - Set manual_trigger=true when the fee cannot be invoiced until the service is delivered and confirmed (e.g. "professional services at €150/hour", "implementation services — billed on delivery", "training sessions"). These fees need human confirmation and a metric entry (hours, days, sessions) before the invoice is issued.
  - When manual_trigger=true, set metric_name to the unit of work (e.g. "hours", "days", "sessions", "units") and rate_per_unit to the per-unit rate. Set amount=0 when the total is variable/unknown at contract time.
  - Set manual_trigger=false (or omit it) for fixed-amount fees with a known amount and clear due date (e.g. "€5,000 onboarding fee due at contract start").
  - Do NOT include recurring fees here.
- contract_id: the contract reference, PO number, order number, or agreement ID printed on the document (e.g. "CLR-2024-0001", "PO-12345"). Use null if no reference number is found.
- field_sources: object mapping each extracted field to the section heading it was taken from (e.g. {"base_monthly_fee": "1.1 Base Platform Fee", "escalators": "1.2 Annual Price Escalator"})
- number_format: detect the decimal separator convention used in this contract.
  "dot"   = dot is the decimal separator (US/UK/Nordic digital format): "€0.0500", "€1,200.00", "1 234.50"
  "comma" = comma is the decimal separator (Continental European print format): "€0,0500", "€1.200,00", "1 234,50"
  Look at how amounts ≥ 1,000 are formatted to distinguish. "€4.500,00" → comma. "€4,500.00" → dot.
  CRITICAL: when number_format is "comma", "0,0500" means 0.05 (fifty thousandths) NOT 500. Always output rates as dot-decimal floats in JSON regardless of source notation.
- extraction_confidence: "high" if all core commercial terms are clear, "medium" if some ambiguity, "low" if significant gaps
- extraction_notes: brief note on what could not be determined
- LANGUAGE RULE: All extracted text fields must be written in British English, even if the source contract is in another language (Swedish, Danish, Norwegian, German, French, etc.). Specifically: payment_terms_text, tier_label, unit_type, description fields, extraction_notes must all be in English. Proper nouns (company names, addresses, person names), identifiers (contract IDs), and currency codes must be preserved verbatim from the source. Example: Swedish "Betalning ska ske senast trettio (30) dagar efter fakturadatum" → payment_terms_text: "Payment due within thirty (30) days of invoice date".
- CRITICAL DATE RULE: contract_end_date must be AFTER contract_start_date. For a multi-year contract, the end year will be start_year + contract_term_years. Example: 36-month contract starting Aug 1 2026 → contract_end_date = "2029-07-31", NOT "2026-07-31". Always verify: if contract_term_months is set, end_date ≈ start_date + contract_term_months. If the document's stated end date contradicts the term length, trust the term length and compute the correct end date.`

const FEW_SHOT_EXAMPLE = `<example>
RULES REMINDER before you read the example:
1. year_pricing values = what is invoiced in THAT year alone, never cumulative. {"year1": 436288, "year2": 481987} means €436k is the Year 1 invoice and €481k is the Year 2 invoice — even if the contract phrases it as "Year 2 = Year 1 fee + new fees".
2. base_annual_fee / base_monthly_fee = the platform fee total. Never multiply it by user count. User fees are separate line items.

Input: "Order Form CLR-2024-0001. Vendor: Verdix Corp, 123 Main St, Oslo, Norway. Customer: Acme Inc, 14 Innovation Drive, Stockholm, Sweden. Billing contact: finance@acme.com. Contract term: 36 months, Feb 1 2024 – Jan 31 2027, auto-renewing with 90 days notice. Section 1.1 Base Platform Fee: 100 seats at $4,200/month. Year 1: $50,400, Year 2: $52,000. Section 1.2 Price Escalator: 5% fixed annually. Section 1.3 Introductory Discount: 20% off months 1-6. Section 1.4 Service Credit: If monthly platform availability falls below 99.5%, Customer receives a service credit equal to 10% of that month's platform subscription fee. Total credits in any calendar month shall not exceed 25% of that month's platform subscription fee. Credits are applied against the next invoice and are not redeemable for cash. Payment: Net 30 days from invoice date. Section 2: API overages at $0.02/call."

Output:
{
  "contract_id": "CLR-2024-0001",
  "customer_name": "Acme Inc",
  "customer_address": "14 Innovation Drive, Stockholm, Sweden",
  "customer_email": null,
  "customer_org_number": null,
  "billing_contact": "finance@acme.com",
  "vendor_name": "Verdix Corp",
  "vendor_address": "123 Main St, Oslo, Norway",
  "order_date": null,
  "contract_start_date": "2024-02-01",
  "contract_end_date": "2027-01-31",
  "contract_term_months": 36,
  "auto_renews": true,
  "renewal_notice_days": 90,
  "renewal_term_months": null,
  "currency": "USD",
  "base_monthly_fee": 4200,
  "base_annual_fee": 50400,
  "billing_frequency": "monthly",
  "payment_terms_days": 30,
  "payment_terms_text": "Net 30 days from invoice date",
  "included_units": null,
  "included_unit_type": null,
  "year_pricing": {"year1": 50400, "year2": 52000},
  "escalators": [{"escalator_pct": 5, "escalator_type": "fixed_pct", "applies_from_year": 2, "effective_date": "2025-02-01", "cap_pct": null, "description": "5% fixed annual price increase"}],
  "discounts": [{"discount_pct": 20, "discount_amount": null, "discount_type": "introductory", "start_date": "2024-02-01", "end_date": "2024-07-31", "duration_months": 6, "applies_to": "base subscription", "description": "20% introductory discount months 1-6"}],
  "service_credits": [{"credit_type": "sla", "description": "Service credit for platform availability below 99.5%", "source_clause": "If monthly platform availability falls below 99.5%, Customer receives a service credit equal to 10% of that month's platform subscription fee. Total credits in any calendar month shall not exceed 25% of that month's platform subscription fee. Credits are applied against the next invoice and are not redeemable for cash.", "stated_pct": 10, "stated_amount": null}],
  "overage_tiers": [
    {"tier_label": "Calls 1–10,000", "from_unit": 1, "to_unit": 10000, "rate_per_unit": 0.02, "unit_type": "API call", "measurement_period": "monthly", "minimum_period_amount": null, "tier_calculation": {"method": "graduated", "source_clause": null, "requires_confirmation": true, "confirmation_reason": "Contract states per-call rates for each tier but does not specify whether crossing a threshold re-rates all calls or only the calls above it."}},
    {"tier_label": "Calls 10,001–100,000", "from_unit": 10001, "to_unit": 100000, "rate_per_unit": 0.015, "unit_type": "API call", "measurement_period": "monthly", "minimum_period_amount": null, "tier_calculation": {"method": "graduated", "source_clause": null, "requires_confirmation": true, "confirmation_reason": "Contract states per-call rates for each tier but does not specify whether crossing a threshold re-rates all calls or only the calls above it."}},
    {"tier_label": "Calls 100,001+", "from_unit": 100001, "to_unit": null, "rate_per_unit": 0.01, "unit_type": "API call", "measurement_period": "monthly", "minimum_period_amount": null, "tier_calculation": {"method": "graduated", "source_clause": null, "requires_confirmation": true, "confirmation_reason": "Contract states per-call rates for each tier but does not specify whether crossing a threshold re-rates all calls or only the calls above it."}}
  ],
  "additional_recurring_fees": [],
  "one_time_fees": [{"fee_label": "Onboarding fee", "amount": 5000, "due_date": "2024-02-01", "description": "One-time onboarding and implementation fee due at contract start"}],
  "field_sources": {
    "base_monthly_fee": "1.1 Base Platform Fee",
    "year_pricing": "1.1 Base Platform Fee",
    "escalators": "1.2 Price Escalator",
    "discounts": "1.3 Introductory Discount",
    "service_credits": "1.4 Service Credit",
    "payment_terms_text": "Payment Terms",
    "overage_tiers": "2. API Overages",
    "one_time_fees": "3. One-Time Fees"
  },
  "extraction_confidence": "high",
  "extraction_notes": null
}
</example>`

export async function extractContractTerms(
  contractText: string,
  customerName?: string,
  piiMasked = false,
): Promise<ContractTerms> {
  const learningContext = await buildLearningContext(customerName)

  const chunks = splitIntoChunks(contractText, 12000)
  if (chunks.length === 1) {
    return extractFromChunk(chunks[0], learningContext, piiMasked)
  }

  // Map-reduce for long contracts
  const partialResults = await Promise.all(
    chunks.map(chunk => extractFromChunk(chunk, learningContext, piiMasked))
  )
  return mergeExtractions(partialResults)
}

const PII_MASK_NOTE = `
IMPORTANT — PII MASKING ACTIVE: Certain names and identifiers in this contract have been replaced with privacy tokens (e.g. [PERSON_1], [ORG_1], [EMAIL_1]). These tokens are placeholders for real values.
- Use the role labels in the contract text (words like "Customer", "Vendor", "Provider", "Supplier", "Licensor", "Licensee") to determine which token belongs in which field.
- For example, if the contract says "between [ORG_2] (the Customer) and [ORG_1] (the Vendor)", then customer_name = "[ORG_2]" and vendor_name = "[ORG_1]".
- Copy the token exactly as it appears (e.g. "[ORG_2]") into the relevant JSON field — do not guess or substitute a different token.
- Do NOT leave fields null just because the value is a token — a token is a valid extracted value.`

async function extractFromChunk(text: string, learningContext: string, piiMasked = false): Promise<ContractTerms> {
  const userContent = piiMasked
    ? `${PII_MASK_NOTE}\n\nExtract contract terms from this document:\n\n<contract>\n${text}\n</contract>\n\nIMPORTANT: Your entire response must be a single valid JSON object. Do not include any explanation, reasoning, markdown, or text before or after the JSON.`
    : `Extract contract terms from this document:\n\n<contract>\n${text}\n</contract>\n\nIMPORTANT: Your entire response must be a single valid JSON object. Do not include any explanation, reasoning, markdown, or text before or after the JSON.`

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: SYSTEM_PROMPT + '\n\n' + FEW_SHOT_EXAMPLE + learningContext,
    messages: [{ role: 'user', content: userContent }],
  })

  const content = response.content[0]
  if (content.type !== 'text') throw new Error('Unexpected response type from Claude')

  // Extract the JSON object — handles cases where model emits reasoning before/after
  const jsonMatch = content.text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error(`Failed to parse extraction response: ${content.text.slice(0, 200)}`)

  try {
    const parsed = JSON.parse(jsonMatch[0]) as ContractTerms

    // Zero-rate recovery: if any overage tiers extracted as 0, do a targeted
    // second pass asking the model specifically about those tiers.
    const zeroTiers = (parsed.overage_tiers ?? []).filter(t => (t.rate_per_unit ?? 0) === 0)
    if (zeroTiers.length > 0) {
      const numberFormat = (parsed.number_format ?? 'dot') as 'dot' | 'comma'
      const recovered = await recoverZeroRates(text, zeroTiers, numberFormat)
      if (recovered.length > 0) {
        const recoveryMap = new Map(recovered.map(r => [r.tier_label, r.rate_per_unit]))
        parsed.overage_tiers = (parsed.overage_tiers ?? []).map(t =>
          recoveryMap.has(t.tier_label) ? { ...t, rate_per_unit: recoveryMap.get(t.tier_label)! } : t
        )
      }
    }

    if (DEBUG_EXTRACTION) {
      const ts        = new Date().toISOString().replace(/[:.]/g, '-')
      const provider  = AI_PROVIDER.replace(/[^a-z0-9]/gi, '_')
      const logPath   = `/tmp/extraction_${provider}_${ts}.json`
      const logData   = {
        provider:   AI_PROVIDER,
        timestamp:  new Date().toISOString(),
        raw_response: content.text,
        parsed,
      }
      writeFileSync(logPath, JSON.stringify(logData, null, 2))
      console.log(`[extraction debug] written to ${logPath}`)
    }

    return parsed
  } catch {
    throw new Error(`Failed to parse extraction response: ${content.text.slice(0, 200)}`)
  }
}

async function recoverZeroRates(
  contractText: string,
  zeroTiers: OverageTier[],
  numberFormat: 'dot' | 'comma',
): Promise<Array<{ tier_label: string; rate_per_unit: number }>> {
  const tierList = zeroTiers.map(t => `- "${t.tier_label}" (unit: ${t.unit_type})`).join('\n')
  const notationNote = numberFormat === 'comma'
    ? 'This contract uses COMMA as the decimal separator (Continental European format). "0,0500" means 0.05 (fifty thousandths). Always output rates as dot-decimal floats.'
    : 'This contract uses DOT as the decimal separator. "0.0500" means 0.05.'

  const prompt = `The following overage pricing tiers were extracted from this contract but their rates appear as 0, which is likely an extraction error. Find the actual per-unit rate for each tier.

${notationNote}

Tiers needing their rate recovered:
${tierList}

Return ONLY a JSON array — no other text:
[{"tier_label": "<exact label>", "rate_per_unit": <dot-decimal float>}]

Rules:
- Only include entries where you found a clear non-zero rate in the contract
- If the contract says "€0.0500 per unit" → rate_per_unit: 0.05
- If the contract says "€0,0500 per unit" (comma notation) → rate_per_unit: 0.05
- Return 0 ONLY if the contract explicitly says the service is free or €0

Contract text:
<contract>
${contractText.slice(0, 10000)}
</contract>`

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    })
    const content = response.content[0]
    if (content.type !== 'text') return []
    const jsonMatch = content.text.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return []
    const recovered = JSON.parse(jsonMatch[0]) as Array<{ tier_label: string; rate_per_unit: number }>
    return recovered.filter(r => typeof r.rate_per_unit === 'number' && r.rate_per_unit > 0)
  } catch {
    return []
  }
}

// Exported so the merge/dedupe/safety-net logic (which has zero AI-call
// dependency of its own — it only ever operates on already-parsed
// ContractTerms objects) is directly unit-testable without mocking Claude.
export function mergeExtractions(results: ContractTerms[]): ContractTerms {
  // Take the most complete result as base, then merge arrays from all chunks
  const base = results.reduce((best, curr) => {
    const bestScore = scoreCompleteness(best)
    const currScore = scoreCompleteness(curr)
    return currScore > bestScore ? curr : best
  })

  const merged: ContractTerms = {
    ...base,
    escalators: dedupe([...results.flatMap(r => r.escalators)], 'description'),
    discounts: dedupe([...results.flatMap(r => r.discounts)], 'description'),
    service_credits: dedupe([...results.flatMap(r => r.service_credits ?? [])], 'description'),
    overage_tiers: dedupe([...results.flatMap(r => r.overage_tiers)], 'tier_label'),
    one_time_fees: dedupe([...results.flatMap(r => r.one_time_fees ?? [])], 'fee_label'),
    // Use 'comma' if ANY chunk detected comma notation (more specific detection wins)
    number_format: results.some(r => r.number_format === 'comma') ? 'comma' : 'dot',
  }

  // Guard: end_date must be after start_date. If the model extracted a wrong year
  // (e.g. "2026-07-31" for a 36-month contract starting 2026-08-01), auto-correct
  // using contract_term_months when available.
  if (merged.contract_start_date && merged.contract_end_date && merged.contract_term_months) {
    const start = new Date(merged.contract_start_date)
    const end   = new Date(merged.contract_end_date)
    if (end <= start) {
      const corrected = new Date(start)
      corrected.setMonth(corrected.getMonth() + merged.contract_term_months)
      corrected.setDate(corrected.getDate() - 1) // last day of term
      merged.contract_end_date = corrected.toISOString().slice(0, 10)
    }
  }

  merged.overage_tiers = flagAmbiguousMinimumCommitments(merged.overage_tiers)
  merged.overage_tiers = flagAmbiguousTierCalculation(merged.overage_tiers)
  merged.discounts = assignDiscountRuleIds(merged.discounts)
  merged.service_credits = assignServiceCreditRuleIds(merged.service_credits)

  return merged
}

// Every discount must be independently addressable (review, interpretation,
// audit trail) rather than only ever reachable via array position — assigned
// once at extraction time so it's stable for the lifetime of the job.
function assignDiscountRuleIds<T extends { discount_rule_id?: string }>(discounts: T[]): T[] {
  return discounts.map(d => d.discount_rule_id ? d : { ...d, discount_rule_id: crypto.randomUUID().slice(0, 8) })
}

// Same addressability pattern as assignDiscountRuleIds — a contract can have
// several independent credit clauses (an SLA credit AND a separate
// promotional credit), each needing its own stable id for review/audit.
// No flagAmbiguous*-style safety net is needed alongside this one: unlike
// minimum_commitment/tier_calculation, ServiceCredit.interpretation is never
// populated at extraction time at all (see the service_credits prompt rule
// above) — there is no "model marked it resolved when it wasn't" failure
// mode to guard against, because nothing is ever extracted as resolved in
// the first place.
export function assignServiceCreditRuleIds<T extends { credit_rule_id?: string }>(credits: T[]): T[] {
  return credits.map(c => c.credit_rule_id ? c : { ...c, credit_rule_id: crypto.randomUUID().slice(0, 8) })
}

// Safety net: force requires_confirmation=true whenever a metric has 2+ paid
// tiers and the model didn't explicitly populate tier_calculation — a rate
// table's graduated-vs-volume-vs-block evaluation is never inferred from the
// mere presence of a table, same principle as flagAmbiguousMinimumCommitments
// just above. A single-tier metric is excluded: one flat rate has no
// graduated/volume distinction to make.
function flagAmbiguousTierCalculation(tiers: OverageTier[]): OverageTier[] {
  const paidTierCountByMetric = new Map<string, number>()
  for (const t of tiers) {
    if ((t.rate_per_unit ?? 0) > 0) {
      paidTierCountByMetric.set(t.unit_type, (paidTierCountByMetric.get(t.unit_type) ?? 0) + 1)
    }
  }
  return tiers.map(t => {
    if ((t.rate_per_unit ?? 0) <= 0) return t
    if ((paidTierCountByMetric.get(t.unit_type) ?? 0) < 2) return t
    if (t.tier_calculation) return t
    return {
      ...t,
      tier_calculation: {
        method: 'graduated' as const,
        source_clause: null,
        requires_confirmation: true,
        confirmation_reason: 'This metric has more than one price tier but the extraction did not determine whether crossing a threshold re-rates all units or only the units above it.',
      },
    }
  })
}

// Safety net: force requires_confirmation=true whenever a metric structurally
// has both an included/free allowance (a same-unit_type tier priced at 0)
// AND a minimum commitment, but the model's own included_allowance_interaction
// wasn't explicitly set — never trust a single extraction pass to self-report
// its own uncertainty consistently; re-derive the same rule the prompt asks
// for as a hard check rather than a suggestion.
function flagAmbiguousMinimumCommitments(tiers: OverageTier[]): OverageTier[] {
  const metricsWithAllowance = new Set(
    tiers.filter(t => (t.rate_per_unit ?? 0) === 0).map(t => t.unit_type),
  )
  return tiers.map(t => {
    if (!t.minimum_commitment) return t
    const interactionUnclear = !t.minimum_commitment.included_allowance_interaction
      || t.minimum_commitment.included_allowance_interaction === 'unclear'
    if (interactionUnclear && metricsWithAllowance.has(t.unit_type) && !t.minimum_commitment.requires_confirmation) {
      return {
        ...t,
        minimum_commitment: {
          ...t.minimum_commitment,
          included_allowance_interaction: 'unclear' as const,
          requires_confirmation: true,
          confirmation_reason: t.minimum_commitment.confirmation_reason
            ?? 'This metric has both an included allowance and a minimum commitment; the contract does not state whether the minimum applies before or after the allowance.',
        },
      }
    }
    return t
  })
}

function scoreCompleteness(t: ContractTerms): number {
  let score = 0
  if (t.customer_name) score++
  if (t.base_monthly_fee || t.base_annual_fee) score++
  if (t.contract_start_date) score++
  if (t.contract_term_months) score++
  if (t.currency) score++
  if (t.escalators?.length) score++
  if (t.discounts?.length) score++
  if (t.overage_tiers?.length) score++
  return score
}

function dedupe<T>(arr: T[], key: keyof T): T[] {
  const seen = new Set<unknown>()
  return arr.filter(item => {
    const k = item[key]
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

function splitIntoChunks(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text]
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    let end = start + maxChars
    if (end < text.length) {
      const boundary = text.lastIndexOf('\n', end)
      if (boundary > start) end = boundary
    }
    chunks.push(text.slice(start, end))
    start = end
  }
  return chunks
}
