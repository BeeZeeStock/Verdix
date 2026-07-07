import Anthropic from '@anthropic-ai/sdk'
import { ContractTerms } from './types'
import { buildLearningContext } from './learning-context'

const client = new Anthropic()

const SYSTEM_PROMPT = `You are a contract analysis specialist. Extract structured billing and commercial terms from SaaS contracts and order forms.

Output a single JSON object. All numeric fields must be numbers (not strings). Dates must be ISO 8601 (YYYY-MM-DD). Use null for any field you cannot determine with confidence.

Rules:
- base_monthly_fee: recurring monthly fee for the base subscription (not overage)
- base_annual_fee: annual fee if billed annually
- year_pricing: year-by-year fee schedule as {"year1": 50000, "year2": 55000, ...}. Use ONLY when the contract specifies distinct totals per contract year with no intermediate dates. If the fee changes on specific calendar dates (a "ramp schedule"), use ramp_schedule instead and set year_pricing to null.
- ramp_schedule: use when the contract defines a step-up fee schedule tied to specific calendar date ranges (e.g. Month 1-6, Month 7-12, etc.). Each entry: { "start_date": "YYYY-MM-DD", "end_date": "YYYY-MM-DD", "monthly_fee": <number>, "label": "<optional short label>" }. When ramp_schedule is populated, set year_pricing to null and base_monthly_fee/base_annual_fee to null. Escalators are already baked into the ramp rates — do not also populate escalators.
- customer_address: full mailing address of the customer (street, city, country)
- billing_contact: billing contact email or name from the contract
- vendor_address: full mailing address of the vendor/supplier
- payment_terms_text: exact payment terms string e.g. "Net 30 days from invoice date"
- escalators: automatic price increases (CPI clauses, fixed % increases, etc.)
- discounts: introductory or volume discounts with explicit start/end dates
- overage_tiers: usage-based charges above included units. Each tier must have:
  - from_unit: the first unit in this tier's range (the cumulative usage count, NOT a billing-block denominator). E.g. for graduated API tiers priced per 1,000 calls: Tier 1 = from_unit:1, to_unit:10000; Tier 2 = from_unit:10001, to_unit:100000; Tier 3 = from_unit:100001, to_unit:null.
  - to_unit: last unit in range, null if open-ended
  - rate_per_unit: price PER SINGLE unit (e.g. price per 1 API call, or price per 1 seat). If the contract says "€2.40 per 1,000 calls", rate_per_unit = 0.0024 (divide by 1000). EXCEPTION: if unit_type explicitly contains "1,000" or "per block", keep the rate as stated and set unit_type accordingly.
  - unit_type: the measurable quantity, e.g. "API call", "user seat", "GB storage"
  - For graduated/incremental tiers: each call falls into exactly one bracket and is billed at that bracket's rate. Encode as distinct non-overlapping from_unit/to_unit ranges.
  - For volume tiers (all-or-nothing): if the contract specifies a single rate that applies to the entire volume once a threshold is hit, set from_unit to the threshold and to_unit:null for each tier.
- one_time_fees: non-recurring charges paid once (e.g. onboarding, implementation, setup, migration, professional services fees). Each entry: fee_label (short name), amount (number), due_date (ISO date or null), description (brief note or null). Do NOT include recurring fees here.
- field_sources: object mapping each extracted field to the section heading it was taken from (e.g. {"base_monthly_fee": "1.1 Base Platform Fee", "escalators": "1.2 Annual Price Escalator"})
- extraction_confidence: "high" if all core commercial terms are clear, "medium" if some ambiguity, "low" if significant gaps
- extraction_notes: brief note on what could not be determined`

const FEW_SHOT_EXAMPLE = `<example>
Input: "Order Form CLR-2024-0001. Vendor: Verdix Corp, 123 Main St, Oslo, Norway. Customer: Acme Inc, 14 Innovation Drive, Stockholm, Sweden. Billing contact: finance@acme.com. Contract term: 36 months, Feb 1 2024 – Jan 31 2027, auto-renewing with 90 days notice. Section 1.1 Base Platform Fee: 100 seats at $4,200/month. Year 1: $50,400, Year 2: $52,000. Section 1.2 Price Escalator: 5% fixed annually. Section 1.3 Introductory Discount: 20% off months 1-6. Payment: Net 30 days from invoice date. Section 2: API overages at $0.02/call."

Output:
{
  "contract_id": "CLR-2024-0001",
  "customer_name": "Acme Inc",
  "customer_address": "14 Innovation Drive, Stockholm, Sweden",
  "billing_contact": "finance@acme.com",
  "vendor_name": "Verdix Corp",
  "vendor_address": "123 Main St, Oslo, Norway",
  "order_date": null,
  "contract_start_date": "2024-02-01",
  "contract_end_date": "2027-01-31",
  "contract_term_months": 36,
  "auto_renews": true,
  "renewal_notice_days": 90,
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
  "overage_tiers": [
    {"tier_label": "API Tier 1", "from_unit": 1, "to_unit": 10000, "rate_per_unit": 0.02, "unit_type": "API call"},
    {"tier_label": "API Tier 2", "from_unit": 10001, "to_unit": 100000, "rate_per_unit": 0.015, "unit_type": "API call"},
    {"tier_label": "API Tier 3", "from_unit": 100001, "to_unit": null, "rate_per_unit": 0.01, "unit_type": "API call"}
  ],
  "one_time_fees": [{"fee_label": "Onboarding fee", "amount": 5000, "due_date": "2024-02-01", "description": "One-time onboarding and implementation fee due at contract start"}],
  "field_sources": {
    "base_monthly_fee": "1.1 Base Platform Fee",
    "year_pricing": "1.1 Base Platform Fee",
    "escalators": "1.2 Price Escalator",
    "discounts": "1.3 Introductory Discount",
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
  customerName?: string
): Promise<ContractTerms> {
  const learningContext = await buildLearningContext(customerName)

  const chunks = splitIntoChunks(contractText, 12000)
  if (chunks.length === 1) {
    return extractFromChunk(chunks[0], learningContext)
  }

  // Map-reduce for long contracts
  const partialResults = await Promise.all(
    chunks.map(chunk => extractFromChunk(chunk, learningContext))
  )
  return mergeExtractions(partialResults)
}

async function extractFromChunk(text: string, learningContext: string): Promise<ContractTerms> {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: SYSTEM_PROMPT + '\n\n' + FEW_SHOT_EXAMPLE + learningContext,
    messages: [
      {
        role: 'user',
        content: `Extract contract terms from this document:\n\n<contract>\n${text}\n</contract>\n\nReturn only valid JSON, no markdown, no explanation.`,
      },
      {
        role: 'assistant',
        content: '{',
      },
    ],
  })

  const content = response.content[0]
  if (content.type !== 'text') throw new Error('Unexpected response type from Claude')

  try {
    // Model response continues from the pre-filled '{' — prepend it back
    const raw = ('{' + content.text).trim()
    // Strip any markdown fences or leading prose, then extract the JSON object
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('No JSON object found in response')
    return JSON.parse(jsonMatch[0]) as ContractTerms
  } catch {
    throw new Error(`Failed to parse extraction response: ${content.text.slice(0, 200)}`)
  }
}

function mergeExtractions(results: ContractTerms[]): ContractTerms {
  // Take the most complete result as base, then merge arrays from all chunks
  const base = results.reduce((best, curr) => {
    const bestScore = scoreCompleteness(best)
    const currScore = scoreCompleteness(curr)
    return currScore > bestScore ? curr : best
  })

  return {
    ...base,
    escalators: dedupe([...results.flatMap(r => r.escalators)], 'description'),
    discounts: dedupe([...results.flatMap(r => r.discounts)], 'description'),
    overage_tiers: dedupe([...results.flatMap(r => r.overage_tiers)], 'tier_label'),
    one_time_fees: dedupe([...results.flatMap(r => r.one_time_fees ?? [])], 'fee_label'),
  }
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
