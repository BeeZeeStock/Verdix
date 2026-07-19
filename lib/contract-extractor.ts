import { writeFileSync } from 'fs'
import { ContractTerms } from './types'
import { buildLearningContext } from './learning-context'
import { getAIClient, AI_PROVIDER } from './ai-client'

const client = getAIClient()
const DEBUG_EXTRACTION = process.env.DEBUG_EXTRACTION === 'true'

const SYSTEM_PROMPT = `You are a contract analysis specialist. Extract structured billing and commercial terms from SaaS contracts and order forms.

Output a single JSON object. All numeric fields must be numbers (not strings). Dates must be ISO 8601 (YYYY-MM-DD). Use null for any field you cannot determine with confidence.

Rules:
- base_monthly_fee: the PRIMARY recurring monthly fee component — the platform/base access fee only. When a contract has multiple SEPARATE named recurring fees (e.g. "Platform Fee: €4,500/mo" AND "Dedicated Support: €1,200/mo"), set base_monthly_fee to the platform/access fee ONLY (€4,500) and put the remaining components in additional_recurring_fees. NEVER sum distinct named fees into base_monthly_fee.
- additional_recurring_fees: array of secondary recurring fee components that exist alongside base_monthly_fee. Each entry: { "fee_label": "<name>", "amount": <number>, "description": "<brief note or null>" }. Use this when the contract explicitly lists multiple SEPARATE recurring line items with distinct names and amounts. Example: if a contract has "Base Access: €4,500/mo" and "Premium Support: €1,200/mo", then base_monthly_fee=4500 and additional_recurring_fees=[{"fee_label":"Dedicated Premium Support - 2hr SLA Window","amount":1200,"description":"..."}]. Leave as [] when there is only one recurring fee.
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
  - CRITICAL — rate_per_unit decimal parsing: rates written as "€0.0500", "€0.035", "€0.02" are NOT zero. They are decimal fractions: 0.0500 = 0.05, 0.035, 0.02. Extract the full numeric value including leading-zero decimals. NEVER set rate_per_unit to 0 when a non-zero rate is stated in the contract. Also: tier_label must be the DESCRIPTIVE NAME (e.g. "Tier 2 (Overage Step 1)"), never the rate value itself.
- one_time_fees: non-recurring charges paid once (e.g. onboarding, implementation, setup, migration, professional services fees). Each entry: fee_label (short name), amount (number), due_date (ISO date or null), description (brief note or null). Do NOT include recurring fees here.
- contract_id: the contract reference, PO number, order number, or agreement ID printed on the document (e.g. "CLR-2024-0001", "PO-12345"). Use null if no reference number is found.
- field_sources: object mapping each extracted field to the section heading it was taken from (e.g. {"base_monthly_fee": "1.1 Base Platform Fee", "escalators": "1.2 Annual Price Escalator"})
- number_format: detect the decimal separator convention used in this contract.
  "dot"   = dot is the decimal separator (US/UK/Nordic digital format): "€0.0500", "€1,200.00", "1 234.50"
  "comma" = comma is the decimal separator (Continental European print format): "€0,0500", "€1.200,00", "1 234,50"
  Look at how amounts ≥ 1,000 are formatted to distinguish. "€4.500,00" → comma. "€4,500.00" → dot.
  CRITICAL: when number_format is "comma", "0,0500" means 0.05 (fifty thousandths) NOT 500. Always output rates as dot-decimal floats in JSON regardless of source notation.
- extraction_confidence: "high" if all core commercial terms are clear, "medium" if some ambiguity, "low" if significant gaps
- extraction_notes: brief note on what could not be determined
- CRITICAL DATE RULE: contract_end_date must be AFTER contract_start_date. For a multi-year contract, the end year will be start_year + contract_term_years. Example: 36-month contract starting Aug 1 2026 → contract_end_date = "2029-07-31", NOT "2026-07-31". Always verify: if contract_term_months is set, end_date ≈ start_date + contract_term_months. If the document's stated end date contradicts the term length, trust the term length and compute the correct end date.`

const FEW_SHOT_EXAMPLE = `<example>
RULES REMINDER before you read the example:
1. year_pricing values = what is invoiced in THAT year alone, never cumulative. {"year1": 436288, "year2": 481987} means €436k is the Year 1 invoice and €481k is the Year 2 invoice — even if the contract phrases it as "Year 2 = Year 1 fee + new fees".
2. base_annual_fee / base_monthly_fee = the platform fee total. Never multiply it by user count. User fees are separate line items.

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
  zeroTiers: import('./types').OverageTier[],
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

function mergeExtractions(results: ContractTerms[]): ContractTerms {
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

  return merged
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
