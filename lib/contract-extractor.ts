import { writeFileSync } from 'fs'
import { ContractTerms, OverageTier, ServiceCredit, OneTimeFee, AdditionalRecurringFee } from './types'
import { buildLearningContext } from './learning-context'
import { getAIClient, AI_PROVIDER } from './ai-client'
import { parseBillabilityCondition, projectBillabilityConditionToExecutionFields } from './billability-condition'
import { isProvenanceResolved } from './commercial-rule-status'
import { deriveOneTimeFeeAmountProvenance } from './one-time-fee-provenance'
import { deriveOneTimeFeeBillabilityProvenance } from './one-time-fee-billability-provenance'
import { compileExecutableCommercialMechanisms } from './commercial-mechanism-compiler'

// Stays on the standard (Sonnet) client — a live A/B against TEST-PAY-002
// (2026-08-20/21) found extraction quality/source-completeness EQUIVALENT
// between Sonnet and the reasoning tier (getReasoningAIClient, Opus +
// adaptive thinking), at ~5-6x the latency/cost, with no accuracy gain
// measured for this pipeline. Revisit only if a new benchmark demonstrates
// a material advantage — the reasoning client stays fully implemented and
// available in lib/ai-client.ts for that comparison.
const client = getAIClient()
const DEBUG_EXTRACTION = process.env.DEBUG_EXTRACTION === 'true'

const SYSTEM_PROMPT = `You are a contract analysis specialist. Extract structured billing and commercial terms from SaaS contracts and order forms.

Output a single JSON object. All numeric fields must be numbers (not strings). Dates must be ISO 8601 (YYYY-MM-DD). Use null for any field you cannot determine with confidence.

Rules:
- APPENDIX/EXHIBIT CROSS-REFERENCE RULE — applies to every source_clause/description field below (base_fee_proration, discounts, additional_recurring_fees, overage_tiers, service_credits, one_time_fees, unsupported_commercial_mechanisms): when a clause governing one of these rules cross-references an appendix, exhibit, schedule, or "Bilaga" BY NAME (e.g. "see Bilaga 1", "enligt Bilaga 1", "per Appendix A", "as set out in Schedule 2"), and that appendix's content is present anywhere in the document text provided to you, the source_clause you write for that rule MUST include the substance of the referenced appendix section relevant to this specific rule as well — quoted or faithfully paraphrased, not merely a pointer like "see Bilaga 1" left standing on its own. Label which part came from which source when you combine them, e.g. "Main agreement, Section 3: ... | Bilaga 1: ...". This is the ONLY chance for that appendix content to ever reach a later human-review step — the full document text is not available again after this extraction pass, so a source_clause that only points at an appendix without capturing its relevant substance permanently loses that content for review purposes. Never fabricate appendix content that is not actually present in the document — if a clause references an appendix that genuinely is not included in the text you were given, say so plainly in source_clause (e.g. "References Bilaga 1, which was not included in the provided document") rather than silently omitting the cross-reference.
- base_monthly_fee: the PRIMARY recurring monthly fee component — the platform/base access fee only. When a contract has multiple SEPARATE named recurring fees (e.g. "Platform Fee: €4,500/mo" AND "Dedicated Support: €1,200/mo"), set base_monthly_fee to the platform/access fee ONLY (€4,500) and put the remaining components in additional_recurring_fees. NEVER sum distinct named fees into base_monthly_fee.
  COMMITTED-VOLUME FEE BAND RULE: when the base/platform fee is stated as a TABLE of bands keyed by a committed/contracted volume (e.g. "1–500 requests/mo: EUR 500 | 501–1,500: EUR 1,200 | 1,501–5,000: EUR 2,000"), and the contract separately states the customer's actual signed/committed volume (e.g. "Customer commits to 5,000 payment requests per month"): set base_monthly_fee to the SELECTED band's fee only (the one the committed volume falls into), AND ALSO populate base_fee_bands with the COMPLETE table — every row, not just the selected one: [{"from_unit":1,"to_unit":500,"monthly_fee":500}, {"from_unit":501,"to_unit":1500,"monthly_fee":1200}, {"from_unit":1501,"to_unit":5000,"monthly_fee":2000}], and base_fee_committed_volume with the stated committed volume (5000). Never flatten a banded fee into a bare base_monthly_fee number with the table discarded — the causal chain (which band, and the volume that selected it) must remain traceable. Leave base_fee_bands/base_fee_committed_volume null when the base fee is a single flat number with no band table.
    OPEN-ENDED / QUOTE-REQUIRED TOP BAND: some band tables state that volume above the top numbered band is priced separately/by negotiation rather than at a stated figure (e.g. "150,001+ requests/mo: Offereras" / "priced on request" / "contact us"). Encode this row exactly like any other — from_unit at its stated start, to_unit: null — but set its monthly_fee to null rather than 0 or the fee of an adjacent band. 0 would misrepresent a quote-required tier as a free one; copying a neighboring band's fee would fabricate a number the contract never states. Only use this when the contract text itself indicates the fee for that range is not a fixed stated amount (quoted, negotiated, "on request," "contact sales," etc.) — never for a band whose fee is simply absent from your reading by mistake.
  QUARTERLY FEE RULE: If the primary recurring fee is stated as a quarterly amount (e.g. "SEK 75,000 per quarter", "invoiced quarterly in advance"), convert to monthly: base_monthly_fee = quarterly_amount / 3, and set billing_frequency = 'quarterly'. The system stores monthly equivalents internally regardless of invoicing cadence. Example: SEK 75,000/quarter → base_monthly_fee = 25000, billing_frequency = 'quarterly'. Similarly, a semi-annual fee of SEK 60,000 → base_monthly_fee = 10000, billing_frequency = 'semi-annual'.
- additional_recurring_fees: array of secondary recurring fee components that exist alongside base_monthly_fee. Each entry: { "fee_label": "<name>", "amount": <number>, "description": "<brief note or null>", "billing_frequency": "<cadence or null>", "metric_name": "<string or null>", "rate_per_unit": <number or null>, "required_operational_inputs": <array of strings or null>, "unresolved_kind": "unsupported_semantics" | null, "charge_basis_input_key": "<string or null — see the charge_basis_input_key rule below>", "rate_schedule_bands": <array of {"from": <number>, "to": <number or null>, "rate_pct": <number>} objects, or null — see the rate_schedule_bands rule below>, "source_clause": "<verbatim or paraphrased, or null>", "source_sections": <array of {"exact_source_heading": "...", "display_label": "..."} objects, or null — see field_sources' MULTI-SECTION EVIDENCE rule; populate whenever this fee's evidence spans more than one heading> }. Use this when the contract explicitly lists multiple SEPARATE recurring line items with distinct names and amounts.
  FIXED vs. PER-UNIT/VARIABLE RULE — this is a common, high-cost failure mode: a recurring fee is either a FIXED amount charged every billing period regardless of usage, OR a RATE charged per unit of operational activity (per transaction, per request, per completed event) with the actual monthly total depending on volume that doesn't exist yet at extraction time. These are NOT the same shape, and confusing them causes a fee like "€0.38 per issued payment request" to be wrongly treated as a fixed €0.38/month charge multiplied by the contract's billing-cycle count — a number with no relationship to what will actually be owed.
    - FIXED: the contract states one amount per period regardless of activity (e.g. "Dedicated Support: SEK 1,200/mo"). Set amount to that number; leave metric_name/rate_per_unit null.
    - PER-UNIT/VARIABLE: the contract states a rate that multiplies by a count of events/units that only usage data can supply (e.g. "EUR 0.38 per issued payment request", "EUR 1.70 per completed payment", any "per X" language where X is an operational event, not a fixed quantity stated in the contract itself). Set amount to 0 (NEVER the per-unit rate itself, and NEVER the contract's term-length or billing-cycle count), set metric_name to a short label for the unit being counted (e.g. "issued_payment_request", "completed_payment"), and set rate_per_unit to the stated per-unit rate. The contract's own duration (months/years) is NEVER a usage quantity — do not let a term-length number end up multiplying a per-unit rate anywhere in your output.
    - required_operational_inputs: the distinct operational quantities THIS SPECIFIC fee's rate directly depends on — never a blanket list copied across every fee on the contract. A per-request fee depends only on the request count; a separate per-success fee depends only on the completed-event count; do not attach one fee's inputs to another's just because both appear in the same clause or table.
    - derived_metric: when a fee's rate is itself a metric COMPUTED from other raw inputs via a stated formula (e.g. "value-weighted payment rate = paid invoice value ÷ total invoice value", not a single per-event count) — set { "metric_name": "<short label for the computed rate>", "formula": "<the stated formula in plain terms>", "raw_inputs": [<every raw quantity the FORMULA itself needs>], "operation": "ratio" | null, "numerator_input_key": "<string or null>", "denominator_input_key": "<string or null>" }, and put in required_operational_inputs only whatever ADDITIONAL raw input this fee needs beyond that derived metric (e.g. the invoice-value base the rate is applied to). Do not duplicate the derived metric's own raw_inputs into required_operational_inputs — they belong to the formula, not to this fee's own direct dependency list. Leave derived_metric null for an ordinary single-metric per-unit fee.
      EXPLICIT OPERAND DIRECTION — raw_inputs' array ORDER is never treated as authority for which operand is the numerator vs. denominator (it exists purely to list every raw quantity the formula needs, for display/dependency purposes). For a two-operand ratio formula (numerator ÷ denominator), you MUST ALSO separately set "operation": "ratio", "numerator_input_key": "<the raw_inputs entry that is the numerator>", and "denominator_input_key": "<the raw_inputs entry that is the denominator>" — e.g. formula "paid invoice value ÷ total invoice value of issued requests" → raw_inputs: ["paid_invoice_value", "total_invoice_value_of_issued_requests"], operation: "ratio", numerator_input_key: "paid_invoice_value", denominator_input_key: "total_invoice_value_of_issued_requests". Both numerator_input_key and denominator_input_key MUST also appear somewhere in raw_inputs — never name an operand that isn't itself listed as a raw input of the formula. Leave operation/numerator_input_key/denominator_input_key null when the formula is not a simple two-operand ratio, or when direction is genuinely unclear from the contract text — never guess a direction merely to fill these fields in.
    - charge_basis_input_key: the SAME quantity you would otherwise put as this fee's ADDITIONAL raw dependency in required_operational_inputs (the monetary base amount the selected rate is applied TO, to compute the actual fee) — but stated here explicitly, as its own single string, not left to be inferred from required_operational_inputs' array shape. Still also populate required_operational_inputs with the same value (that array remains the display list of everything this fee depends on) — charge_basis_input_key is the separate, explicit, authoritative statement of specifically which one of those is the charge basis. Leave null when this fee has no derived_metric, or the contract does not make the charge basis clear.
    - rate_schedule_bands: when this fee's rate varies by an EXPLICIT numeric percentage-rate TABLE keyed off the derived_metric's own computed ratio (e.g. "0% below 5% payment rate, 0.20% at 5%, 0.40% at 10%, ..., 4.50% at 100%"), populate rate_schedule_bands with the COMPLETE table, every row, verbatim from the contract: [{"from": 0, "to": 5, "rate_pct": 0}, {"from": 5, "to": 10, "rate_pct": 0.20}, ...], using a half-open [from, to) interval per row (a row covering "5–<10%" is {"from": 5, "to": 10, ...}) and to: null only on the table's final, open-ended row. Never invent or interpolate rows that are not explicitly stated — if the contract only describes the schedule narratively without a row-by-row numeric table, leave rate_schedule_bands null (the narrative still belongs in source_clause). Leave null whenever derived_metric is null or the fee's rate is not schedule-based.
    - unresolved_kind: set to "unsupported_semantics" only when THIS FEE's own pricing MECHANISM has no way to be expressed by amount/metric_name/rate_per_unit/derived_metric at all — e.g. a rate that varies by a percentage SCHEDULE (e.g. "0.20% rising to 4.50% depending on payment rate, rounded to the nearest 5-point step"). In this case set amount to 0, still populate fee_label/description/source_clause/required_operational_inputs/rate_schedule_bands as completely as you can from the contract text (never drop the clause just because you cannot structure its mechanism), and leave metric_name/rate_per_unit null. Do NOT set unresolved_kind merely because a fee is an ordinary single per-unit rate — that case (metric_name + rate_per_unit populated) is a fully supported shape, just not yet invoiceable without usage data. A rule that RECALCULATES a fee/rate/band over time based on a rolling average of some OTHER operational quantity (e.g. "if the three-month average of issued requests exceeds the agreed volume, the fee band migrates to the next level", or "the rate transitions to a rolling three-month average after the initial period") is NOT itself a fee — it never gets its own additional_recurring_fees entry; extract it into unsupported_commercial_mechanisms instead (below). Read the clause carefully for WHICH quantity is actually being averaged — a volume-migration rule averages a request/event COUNT (required_operational_inputs: the count metric, e.g. ["issued_payment_request_count"]), which is a completely different dependency from a rate-migration rule that averages a VALUE RATIO (e.g. paid/total invoice value). Never assume a rolling-average mechanism shares inputs with a nearby percentage-rate fee just because both mention "rolling"/"three-month average" — each must list only the quantity its OWN clause actually says is averaged.
    - source_clause: the verbatim (or lightly paraphrased) sentence(s) stating this fee's own rate/formula — same completeness discipline as service_credits' SOURCE_CLAUSE COMPLETENESS RULE below: include the trigger, the rate/percentage/schedule, and any stated calculation basis, never truncated to just the headline number.
- unsupported_commercial_mechanisms: array of commercial MECHANISMS the contract states that are not themselves billable fees — they instead govern HOW another fee's rate or basis changes over time (e.g. a rolling multi-month average repricing transition, a tier-migration rule). Each entry: { "kind": "<short snake_case slug you choose to describe this mechanism, e.g. rolling_volume_pricing_transition>", "description": "<what it does, in plain terms>", "source_clause": "<verbatim or paraphrased, or null>", "source_sections": <array of {"exact_source_heading": "...", "display_label": "..."} objects, or null — see field_sources' MULTI-SECTION EVIDENCE rule; populate whenever this mechanism's evidence spans more than one heading>, "required_operational_inputs": <array of strings or null>, "rolling_input_key": "<string or null — see the rolling_input_key rule below>", "rolling_window_count": <number or null — see the rolling_window_count rule below>, "notice_required": <true | false | null — see the notice_required rule below>, "execution_status": "unsupported" }. Use this instead of inventing a fake additional_recurring_fees entry for a rule that has no fee amount/rate of its own. Leave as [] when the contract has no such mechanism.
  rolling_input_key: the SAME quantity you would otherwise put as this mechanism's dependency in required_operational_inputs (the count/quantity actually being averaged) — but stated here explicitly, as its own single string, not left to be inferred from required_operational_inputs' array shape. Still also populate required_operational_inputs with the same value. Leave null when this is not a rolling-average mechanism, or the averaged quantity is genuinely not clear from the contract text.
  rolling_window_count: for a rolling-average band-migration mechanism, the NUMBER of billing periods the clause states are averaged (e.g. 3 for "three-month average", "rolling 3-month average", "the average of the preceding three (3) months"). Set to null when the mechanism is not a rolling-average one, or the period count is genuinely not stated. Never guess a count merely because the word "rolling" appears without a stated number.
  notice_required: true only when the clause explicitly requires advance notice before the transition takes effect (e.g. "after advance notice", "following written notice to Customer"); false only when the clause explicitly states no notice is required; null when the clause doesn't address notice at all for this mechanism. Never defaulted to true or false when the contract is silent on it.
  DO NOT DROP THIS — A COMMON MISS: a contract that has a percentage-schedule/derived-rate fee (captured via additional_recurring_fees[].unresolved_kind: "unsupported_semantics", per the rule above) frequently ALSO has a SEPARATE rolling-average volume/band-migration clause elsewhere (e.g. "if the rolling three-month average of issued requests exceeds the agreed volume, the fee moves to the next band from the next contract period"). These are TWO INDEPENDENT things extraction must capture SEPARATELY — one goes in additional_recurring_fees (a fee whose rate mechanism is unsupported), the other goes HERE in unsupported_commercial_mechanisms (a mechanism with no fee/rate of its own). Finding one must never stop you looking for the other; a contract can and often does have both. Do not merge them into a single entry, and do not skip this one just because you already logged the other. Read the whole document for BOTH before finalizing this array — a mid-document or end-of-section clause about volume-based band migration is exactly as real as one appearing near the main fee table.
  A rolling/band-migration mechanism is frequently stated PARTLY in the main agreement (a short cross-reference sentence) and PARTLY in an appendix (the actual mechanics) — that is TWO real, independently-navigable locations, not one. Populate source_sections with BOTH real headings. Concrete worked example from a real Swedish contract: the main agreement's heading "4. Avtalad volym" contains a short cross-reference to the appendix, and Bilaga 1's heading "4. Fast plattform efter avtalad volym" states the actual migration rule — source_sections must be exactly [{"exact_source_heading": "4. Avtalad volym", "display_label": "Main agreement"}, {"exact_source_heading": "4. Fast plattform efter avtalad volym", "display_label": "Bilaga 1"}].
  WHICH QUANTITY IS AVERAGED — read carefully, never assume: a volume/band-migration rule (moves to a different pricing band based on a rolling average of a COUNT, e.g. issued requests) has required_operational_inputs naming only that count metric (e.g. ["issued_payment_request_count"]) — a completely different dependency from a nearby derived-rate fee that averages a VALUE RATIO (e.g. paid ÷ total invoice value). Never assume the two share inputs merely because both clauses use words like "rolling" or "three-month average" — each mechanism's required_operational_inputs must reflect only what its OWN clause actually says is being averaged.
  Set "billing_frequency" on the entry when this fee bills at a different cadence than the main billing_frequency (e.g. main contract bills quarterly but this fee bills monthly). Example: if a contract has "Base Access: €4,500/mo" and "Premium Support: €1,200/mo", then base_monthly_fee=4500 and additional_recurring_fees=[{"fee_label":"Dedicated Premium Support - 2hr SLA Window","amount":1200,"description":"...","billing_frequency":null}]. Leave as [] when there is only one recurring fee.
- base_fee_proration (on base_monthly_fee/base_annual_fee) and each additional_recurring_fees[].proration: populate for EITHER of two genuinely separate triggers, never conflated:
  (a) the contract's start date falls MID-CYCLE relative to a fee that resets on fixed CALENDAR boundaries (e.g. contract starts 17 Aug but the fee is described as billing "each calendar month" or "each calendar quarter", not simply anchored to the contract's own start-date anniversary — most contracts use the latter, which has no partial-period question at all from THIS trigger).
  (b) a discount/waiver on this same fee (see discounts[]) has its OWN stated expiry (e.g. a day-stated pilot/introductory period) that does not land on a clean boundary of the fee's normal billing cadence — the fee resumes mid-cycle relative to its OWN normal periods, a partial-period question exactly as real as trigger (a), just created by the waiver's expiry rather than by calendar/contract-start misalignment. reset_anchor still describes the fee's own normal cadence anchor truthfully (e.g. "contract_start" if that's genuinely how the fee's periods run) — it is NOT restricted to "calendar" just because this trigger is in play; only prorate_partial_periods/requires_confirmation describe the actual open question.
    TRIGGER (b) IS A COMMON MISS — CHECK IT EXPLICITLY, DO NOT SKIP: whenever a discount/waiver targets this fee (affected_components or possibly_affected_components includes the fee's component, e.g. "base_recurring_fee") AND states a day-count duration (duration_days), you MUST actually add contract_start_date + duration_days and check whether that landing date is the LAST day of a calendar month. It almost never is, because calendar months are not 30/60/90/etc. days long — e.g. a 90-day pilot starting 2026-10-01 expires 2026-12-30 (31 days in October + 30 in November + 29 of December = 90), which is TWO DAYS SHORT of the next full month boundary (2027-01-01), even though 90 days "sounds like" 3 clean months. Do not skip this arithmetic just because the duration is a round number of days (90, 60, 30) or looks like it should equal whole months — verify it. If the landing date is not a clean month-end, base_fee_proration MUST be populated with requires_confirmation: true (per the schema above) — this holds regardless of whether trigger (a) also applies, and regardless of what day of the month the contract itself starts on.
  When either applies: { "reset_anchor": "contract_start"|"calendar", "prorate_partial_periods": true|false|"unclear", "requires_confirmation": <boolean>, "confirmation_reason": "<string or null>", "source_clause": "<verbatim or paraphrased, or null>" }. Whether a partial period bills in full or prorated is very rarely stated explicitly — unless the contract text actually says so, set prorate_partial_periods to "unclear" and requires_confirmation to true. NEVER default to full-charge or to proration as a "reasonable assumption" — this mirrors the exact discipline already required for a metric minimum commitment's own prorate_partial_periods field, generalized to the base/recurring fees themselves. Leave proration null/omitted entirely when NEITHER trigger applies (the common case: contract-start-anchored billing with no mid-cycle-expiring waiver on this fee).
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
- customer_org_number: company registration number / organisationsnummer / VAT number / CVR for the customer (e.g. "559999-9999" in Sweden, "123456789" in UK). Look for "org.nr", "organisationsnummer", "CVR-nr", "VAT reg.", "company number". Set to null if not found. If the actual value has been replaced by a PII privacy token (e.g. "[ORGANIZATION_IDENTIFIER_1]") in the text below because this document has PII masking active, copy that token into this field EXACTLY as written — a bracketed token next to "org.nr"/"organisationsnummer" IS the value for this field, not a reason to leave it null. Never leave customer_org_number null merely because you cannot see literal digits.
- billing_contact: billing contact email or name from the contract
- vendor_address: full mailing address of the vendor/supplier
- payment_terms_text: exact payment terms string e.g. "Net 30 days from invoice date"
- renewal_notice_days / renewal_notice_months: the notice period required to prevent auto-renewal, PRESERVED IN THE UNIT THE CONTRACT ACTUALLY STATES — set renewal_notice_days when the contract states a day count, or renewal_notice_months when it states a month count (e.g. "three (3) months' written notice" → renewal_notice_months: 3, renewal_notice_days: null). NEVER convert one unit into the other (a stated month count must not become an approximate day count, or vice versa) — set only the field matching the contract's own words, leave the other null. This field is easy to miss when the renewal/notice clause is a short, standalone sentence far from the main fee terms (often near the auto-renewal/term clause, not the pricing section) — actively look for it rather than only noting it if it happens to appear near other fields you're extracting. Swedish contracts commonly state this as "uppsägning" with a month or day count, e.g. "avtalet förlängs automatiskt om det inte sägs upp med tre (3) månaders varsel" → renewal_notice_months: 3.
- renewal_term_months: the LENGTH of each successive renewal period in months. This is OFTEN DIFFERENT from the initial contract term. Example: a 12-month contract that "automatically renews for successive six-month periods" → contract_term_months = 12, renewal_term_months = 6. Set to null only when the renewal period is not specified or explicitly equals the initial term.
- escalators: automatic price increases (CPI clauses, fixed % increases, etc.)
  CPI ESCALATOR RULE: For CPI-linked, inflation-linked, or index-linked price adjustments where the exact future rate is unknown at signing: set escalator_pct = null (the actual CPI rate cannot be known at contract time), set escalator_type = 'CPI_cap' when there is a maximum cap, set cap_pct = the stated maximum percentage cap, and set description = the complete escalation formula in plain English (e.g. 'CPI change + 2 percentage points, maximum 6% per 12-month period'). NEVER set escalator_pct = 0 for CPI clauses — a 0% rate means no price change, which misrepresents the contract. Use null to indicate the rate is variable and unknown at signing.
  INDEX NAME RULE: If the contract names a SPECIFIC index (e.g. "HICP", "RPI", "Consumer Price Index for Urban Consumers"), preserve that exact name verbatim inside description — never silently generalize a named index to "CPI". escalator_type still uses the closed 'CPI_cap' classification for any index-linked clause regardless of which specific index it names; the named index itself only ever appears in description's text, e.g. "HICP change, capped at 4% per annum, applied at renewal" (not "CPI change...") when the contract says HICP.
  RENEWAL-TIMING RULE: If the escalation is explicitly tied to renewal ("on renewal, the fee may be increased by...") rather than recurring automatically every 12 months during the original term, say so explicitly in description (e.g. include the words "applied at renewal"). Do not conflate a renewal-triggered step with an ordinary automatic annual escalator — they read differently to a human reviewer and must not be described identically.
  DISCRETION RULE: If the contract uses discretionary language ("may be increased", "is entitled to increase") rather than mandatory language ("shall be increased", "will increase"), include that discretion in description (e.g. "...the vendor MAY increase the fee, subject to..."). Do not drop the word "may"/"shall" when paraphrasing — a human reviewer needs to see whether the increase is automatic or requires a separate decision.
- discounts: introductory or volume discounts with explicit start/end dates.
  DAY-STATED DURATION RULE: when the contract states the discount/waiver's duration in DAYS (e.g. "a 90-day pilot period with no platform fee") rather than a whole month count, set duration_days to that number (90) and leave duration_months null — do NOT invent a month-aligned end_date by guessing how many whole billing months the day count covers (a 90-day window from an arbitrary contract-start date essentially never lands on a clean month boundary, and the difference materially changes what gets billed). Only set start_date/end_date when the contract itself states or clearly implies exact calendar dates, or when duration_months (a genuine month count) is what's stated.
  HYBRID-FEE SCOPE RULE: when a discount/waiver names only ONE component of a fee that has multiple components (e.g. "no platform fee during the pilot" where the platform charge is itself a hybrid of a fixed component AND a separate performance/variable component BILLED TOGETHER UNDER THAT SAME NAMED CHARGE), applies_to must name exactly the component the clause's own words cover (e.g. "fixed platform fee") — never expand it to "the entire platform charge" unless the contract text says so explicitly. Whether the waiver also covers the OTHER component(s) OF THAT SAME HYBRID CHARGE is a genuine, separate question the clause may leave unanswered — do not resolve it yourself; that ambiguity is exactly what the review/interpretation step (not extraction) exists to surface as Decision Required.
    WORDING DISCIPLINE — applies_to must never assert a scope conclusion the typed fields themselves leave open: when possibly_affected_components (below) will be non-empty for this discount, applies_to may name WHICH component the clause's words are ABOUT (e.g. "fixed platform fee"), but must never use certainty language like "explicitly covers only", "solely", "exclusively", or "only" to describe that scope — those words assert the OTHER component is definitely excluded, which is precisely the question still open. A reviewer reading applies_to and a reviewer reading possibly_affected_components must never be told two different things about the same discount. If you would otherwise write "explicitly covers only the fixed platform fee", write "fixed platform fee" instead (the component named by the clause) and let possibly_affected_components carry the open question — never let free text quietly overstate what the typed, reviewer-facing scope decision has NOT yet resolved.
    SCOPE BOUNDARY — do not over-generalize: this ambiguity is strictly limited to components that are part of the SAME hybrid charge the clause is talking about (e.g. a "platform fee" that combines a fixed component and a performance-based component under one commercial umbrella). It NEVER extends to a separately-named, independently-metered fee billed under its own distinct trigger — e.g. a per-request fee (triggered by each issued request) and a per-success fee (triggered by each completed payment) are their OWN independent fees, not components of "the platform fee," even if they appear in a nearby clause or the same fee table. A waiver naming only "the fixed platform fee" creates NO open question at all about those other, independently-triggered fees — do not add them to possibly_affected_components, and do not describe them as possibly waived anywhere in your output. Ask yourself concretely: is this OTHER charge described as PART OF the same named hybrid charge the clause waives (real ambiguity — add it to possibly_affected_components), or is it a SEPARATE fee with its own name, its own trigger, and its own rate (no ambiguity at all — never mention it in connection with this waiver)?
  TYPED COMPONENT TARGETING RULE: applies_to (above) is free text for human display only — calculation code never reads it. Alongside it, also populate affected_components: <array of short snake_case component-key strings, e.g. ["base_recurring_fee"]> naming every component the discount's stated rate/amount DEFINITELY covers regardless of how any remaining scope ambiguity resolves (use "base_recurring_fee" for the primary fixed/base/platform recurring fee; "performance_fee", "usage_fee", "overage_fee" or another short, clear key matching how the contract itself names a distinct component). When the HYBRID-FEE SCOPE RULE above identifies a genuinely open "does this also cover component X" question, add X to possibly_affected_components instead (never to affected_components, and never invent a resolution) — and per the SCOPE BOUNDARY immediately above, X must be a component of the SAME hybrid charge, never an unrelated separately-metered fee. A component belongs to exactly one of the two arrays, never both. Leave both null when the discount is a simple single-component discount with nothing else to distinguish. Worked example matching a real contract shape: "90-day pilot period with no fixed platform fee. Hybrid platform charge separately includes a performance-based component" alongside independent "EUR 0.38 per issued payment request" and "EUR 1.70 per completed payment" fees elsewhere in the contract → affected_components: ["base_recurring_fee"], possibly_affected_components: ["performance_fee"] ONLY — the per-request and per-success fees are never candidates, because they are separately-named, independently-triggered fees, not components of the platform charge being waived.
- overage_tiers: usage-based charges above included units. Each tier must have:
  - from_unit: the first unit in this tier's range (the cumulative usage count, NOT a billing-block denominator). E.g. for graduated API tiers priced per 1,000 calls: Tier 1 = from_unit:1, to_unit:10000; Tier 2 = from_unit:10001, to_unit:100000; Tier 3 = from_unit:100001, to_unit:null.
    ADDITIVE-OVERAGE-ABOVE-INCLUDED-VOLUME RULE: a common, distinct shape from the graduated example above — the contract charges a SEPARATE flat per-unit fee (or a fixed base fee, populated elsewhere in base_monthly_fee/additional_recurring_fees) for every unit from 1 up to a stated included/contracted volume N, PLUS an additional per-unit surcharge that applies ONLY to usage EXCEEDING N (e.g. "0.60 EUR per payment request above the contracted volume of 5,000"). This is not a graduated table covering the full range from unit 1 — it is a single additive tier covering only the excess. In this shape, from_unit MUST be N+1 (the first unit actually charged at the excess rate), never 1 — e.g. contracted/included volume 5,000 → from_unit: 5001, to_unit: null. Setting from_unit to 1 for an excess-only surcharge would misrepresent every one of the first N units as being charged at the overage rate as well as the base rate, which the contract does not say. Also set included_units to N (the volume the excess is measured above) when the contract states it as a single committed/contracted volume figure.
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
- service_credits: ANY clause that reduces a future charge on a condition — availability credits, rebates, milestone/conditional credits, promotional credits, waived fees, capped credits. Do NOT confuse with discounts (a discount reduces the PRICE up front; a service credit is a conditional reduction triggered by an EVENT — a breach, a threshold, a promotion). Each entry: { "credit_type": "service_credit" | "rebate" | "conditional_credit" | "promotional" | "earned" | "usage" | "waiver" | "other", "description": "<short label>", "source_clause": "<the COMPLETE relevant provision — see SOURCE_CLAUSE COMPLETENESS RULE immediately below>", "stated_pct": <number or null>, "stated_amount": <number or null> }.
  - SOURCE_CLAUSE COMPLETENESS RULE — this is a common, high-cost failure mode: a service-credit/rebate provision is frequently NOT one sentence. It typically spans several sentences covering the trigger, the rate/amount, the calculation basis, WHAT future charges the resulting credit may be applied against (its eligible application scope), any stated exclusions, settlement/credit timing, and carry-forward/repeatability language — sometimes across an entire paragraph or several short paragraphs under the same heading. source_clause MUST include every one of these sentences VERBATIM wherever the contract states them, in the order they appear — never truncate after just the trigger/rate sentence, even when the remaining sentences follow later in the same clause/section. In particular, ALWAYS include any sentence containing eligibility/exclusion language equivalent to "applies only to", "does not apply to", "excluding", or "excludes" — these determine which invoice components the resulting credit may offset and are never decorative or safely summarizable away; dropping them silently converts an explicit contractual answer into a false "the contract doesn't say" for the human reviewer downstream. "or paraphrased" below means light rewording only when the original phrasing is awkward to read standalone (e.g. resolving a mid-sentence cross-reference) — it does NOT license shortening, summarizing, or omitting any sentence that states a fact about this provision. If in doubt whether a nearby sentence belongs to the same provision, include it rather than cut the clause short.
  - credit_type — three most common types, distinguish carefully, they are NOT interchangeable:
    - "rebate": a PERIOD-BASED, typically RETROACTIVE reduction computed as a percentage or amount of fees already charged over some period once a volume/performance threshold is met (e.g. "if annual transaction volume exceeds 2,000,000, Customer receives a rebate of 5% of transaction-processing fees paid during that period"). Usually calculated only after the period ends.
    - "conditional_credit": a MILESTONE or MULTI-PERIOD-THRESHOLD credit — earned once a condition is satisfied (often across several consecutive periods, e.g. "exceeding 300,000 transactions in each of 3 consecutive calendar months"), which may be one-time or repeatable, and which then applies against FUTURE charges going forward (not a retroactive percentage of past fees the way a rebate is).
    - "service_credit": an availability/uptime/SLA-breach credit — a fixed amount or rate (e.g. "SEK 5,500 per hour of excess unavailability") tied to a service-level failure in a specific period, often capped per period.
    - Remaining values for anything that doesn't fit the three above: "promotional" for a limited-time promotional credit, "earned" for a milestone-triggered credit that doesn't fit "conditional_credit"'s multi-period-threshold shape, "usage" for a usage-linked credit, "waiver" for a clause that waives/forgives an otherwise-applicable fee on a condition (e.g. "the onboarding fee is waived if the initial term exceeds 24 months"), "other" when none of these fit.
    - Never label all service-credit-shaped clauses with the same credit_type just because they all reduce a future charge — a contract can and often does contain more than one of these three, each with genuinely different timing/basis/application mechanics, and the review UI shows different labels and asks different questions depending on which one it is.
  - stated_pct / stated_amount: the raw percentage or flat amount as stated in the contract — extract ONLY the literal number, do not resolve what it's a percentage OF (e.g. "10% of that month's platform subscription fee" → stated_pct: 10; do not attempt to determine whether that's the discounted or undiscounted fee — that is a human reviewer's interpretation, not an extraction task).
  - Do NOT populate an "interpretation" field — that is filled in only after human review. Leave service_credits as bare extracted facts.
  - Only extract clauses that actually reduce a charge. A clause that merely describes a service-level TARGET with no stated financial consequence (no credit, no refund, no reduction) is not a service credit — do not invent one.
  - Actively search for this clause type — it is frequently located in an "SLA", "Service Levels", or "Availability" section physically separate from the pricing/fees section, not necessarily adjacent to the discount or escalator clauses. Do not skip it just because it isn't near the other commercial terms.
  - PENALTY CLAUSES (opposite polarity — do NOT put these in service_credits): a clause that imposes an ADDITIONAL charge on a condition (e.g. a late-payment penalty, a breach penalty, an early-termination fee) is not a service credit — service_credits only ever represents a reduction. There is no structured field for a conditional additional charge yet. Never drop it silently: write a plain-English sentence describing it (trigger condition, amount/percentage, what it applies to) into extraction_notes so a human reviewer still sees it, e.g. "Penalty clause detected but not structured: a 1.5% monthly interest penalty applies to invoices unpaid after 30 days (§7.2) — needs manual review." If extraction_notes already has content, append this as a new sentence rather than replacing it.
- one_time_fees: non-recurring charges paid once (e.g. onboarding, implementation, setup, migration, professional services). Each entry: fee_label (short name), amount (number), due_date (ISO date or null), description (brief note or null), source_clause (the sentence(s) stating THIS fee's own amount, verbatim or lightly paraphrased, or null if the amount is not stated explicitly in the text — used to verify the extracted amount against the contract, never invent or summarize a number that isn't there), manual_trigger (boolean), metric_name (string or null), rate_per_unit (number or null), billability_condition (structured object, see below).
  - Set manual_trigger=true when the fee is priced per unit of variable work and cannot be invoiced until that work is delivered and confirmed (e.g. "professional services at €150/hour", "training sessions" — genuinely variable-quantity work, not a fixed one-time amount). These fees need human confirmation and a metric entry (hours, days, sessions) before the invoice is issued. Do NOT set manual_trigger=true merely because a FIXED-amount fee's billing timing depends on an event (e.g. "SEK 100,000 upon customer acceptance") — that is a billability_condition (event), not a manual_trigger fee; see below.
  - When manual_trigger=true, set metric_name to the unit of work (e.g. "hours", "days", "sessions", "units") and rate_per_unit to the per-unit rate. Set amount=0 when the total is variable/unknown at contract time.
  - Set manual_trigger=false (or omit it) for fixed-amount fees — this includes fees gated on a contractual event (billability_condition.kind = "event"), not just fees with a clear calendar due date.
  - billability_condition — REQUIRED for every fixed-amount (non-manual_trigger) one_time_fees entry: the contractual condition that makes THIS fee billable, one of:
    {"kind": "fixed_date", "date": "YYYY-MM-DD"} — the contract ties the fee to a specific calendar date. Use this for "on/as of the agreement's Effective Date" (e.g. "billable on the Effective Date", "due at contract commencement") — use the SAME date you extract as contract_start_date — ONLY when the clause's own words actually name the Effective Date/commencement ("Effective Date", "commencement", "contract start"); never merely because a start date happens to be extractable elsewhere in the document while the clause itself says something else (e.g. "immediately", "upon signing"). EXECUTION-SAFETY RULE for the genuine Effective-Date case: Verdix may process this contract before its Effective Date arrives, and "immediate" below has no way to hold the fee back until then — so a clause that DOES name the Effective Date must resolve to fixed_date with that concrete date, never to "immediate". This also covers any other explicitly separate milestone date the contract states, distinct from both signing and the Effective Date. "Effective Date" is the date the agreement's OBLIGATIONS begin — a distinct legal concept from the act of signing (see contract_signature below), even in the common case where the two dates happen to be the same calendar date in a given contract.
    {"kind": "immediate"} — the clause states the fee is due/payable immediately, with NO reference to the Effective Date/commencement AND no reference to signing/execution either (those are fixed_date and contract_signature above/below, respectively) — e.g. "payable immediately", "due upon invoicing", or similar language naming neither anchor. Do NOT use "immediate" merely because no due date is stated elsewhere — see the null case below. Do NOT default bare "immediately" language toward fixed_date(contract_start_date) either, absent the clause actually naming the Effective Date — that guess is exactly as unsafe as defaulting toward "immediate": both silently pick a commercial meaning the clause's own words don't establish. Match only what the clause actually says.
    {"kind": "event", "event_type": "contract_signature"|"delivery"|"customer_acceptance"|"final_acceptance"|"change_order_signature"} — the fee becomes billable only once a specific contractual EVENT occurs, not a calendar date and not the agreement taking effect.
      - "contract_signature": specifically "upon signing" / "upon execution of this Agreement" / "upon countersignature" / "immediately upon execution of this Agreement" — the act of the parties signing, INCLUDING when "immediately" modifies the signing/execution language itself (the anchor is still the signing act, not a bare unconditional "immediate" — do not extract this as "immediate" merely because the word "immediately" appears). Use this ONLY when the clause's own language ties billability to the signing act itself. CRITICAL, and the single most common failure mode to avoid: do NOT use "contract_signature" for a clause that instead says "on/as of the Effective Date" — Effective Date and signature date are different commercial concepts even when their calendar values coincide in a given contract; a clause naming "the Effective Date" belongs under "fixed_date" above (using the Effective Date's own value), never here, regardless of whether a signature date is also extractable elsewhere in the document. Conversely, do not collapse an actual "upon signing" clause into "fixed_date"/"immediate" just because a start date happens to be extractable elsewhere — the two failure modes are mirror images of each other; always match the clause's OWN stated trigger word ("signing"/"execution" vs "Effective Date" vs neither).
      - "delivery": "upon delivery" / "upon completion of the Services" — distinct from acceptance; do not use this for language that instead describes a customer sign-off/approval step.
      - "customer_acceptance": "upon Customer's acceptance" / "upon written acceptance of the deliverables".
      - "final_acceptance": ONLY when the contract itself explicitly distinguishes an earlier/interim acceptance from a separate, later FINAL acceptance milestone — otherwise use "customer_acceptance".
      - "change_order_signature": "upon execution of a signed Change Order" — note for aggregation purposes elsewhere in this pipeline: a fee gated on a Change Order is inherently conditional/optional (the Change Order may never be executed), unlike every other event type above, which are all events within the current agreement's own guaranteed lifecycle.
      - COUNTEREXAMPLE: if the contract explicitly states an equivalence such as "delivery shall constitute acceptance", use event_type "delivery" (the contract's own stated trigger) — do not invent a general rule that delivery always equals acceptance for other fees where the contract does not say this.
    null — the contract does not state any determinable billing timing or triggering condition for this fee. NEVER default to "immediate" merely because no date/event is stated — that silence must stay null. NEVER force a condition that doesn't clearly fit one of the five events above into the closest-sounding category (e.g. a "deemed accepted after 10 business days unless rejected" clause, or a partial-now/partial-on-milestone retention split) — leave billability_condition null for these and note the complication in description; a human will review it.
  - due_date should be kept consistent with billability_condition when you set one: fixed_date -> due_date = billability_condition.date; event or immediate -> due_date = null. Verdix's own normalization is the actual source of truth for due_date, so this consistency matters less than getting billability_condition itself right.
  - Do NOT include recurring fees here.
- contract_id: the contract reference, PO number, order number, or agreement ID printed on the document (e.g. "CLR-2024-0001", "PO-12345"). Use null if no reference number is found.
- field_sources: object mapping each extracted field to the section heading it was taken from (e.g. {"base_monthly_fee": "1.1 Base Platform Fee", "escalators": "1.2 Annual Price Escalator"}). This is used to jump to and highlight the exact clause in the original PDF — a wrong or missing heading here means that navigation silently fails or lands on the wrong text, so populate it for every field you can, using the heading EXACTLY as printed (verbatim, including its number).
  VERBATIM ONLY — NEVER INVENT "Section N": a confirmed, common, high-cost failure mode is writing a fabricated compound label like "Bilaga 1 – Pris och kommersiell modell, Section 2" or "Section 4. Avtalad volym" instead of copying the heading exactly as the document prints it. The word "Section" (or any translation of it) must NEVER appear in a field_sources or source_sections value unless the document's own heading literally contains that word — a PDF viewer searches the ORIGINAL document's text layer for this exact string, so any word you add that the document doesn't actually print (in whatever language the document uses) guarantees the search fails and no clause can ever be located or highlighted. Copy the heading precisely as printed: its own number, its own punctuation, its own language — nothing translated, nothing prefixed, nothing appended. Concrete example from a real Swedish contract: the document prints "4. Avtalad volym" as a heading — field_sources for whatever field this heading supports must be exactly "4. Avtalad volym", never "Section 4. Avtalad volym", never "4. Avtalad volym (Agreed Volume)", never "Avtalad volym-sektionen".
  MULTI-SECTION EVIDENCE — do not concatenate into one string: when a single additional_recurring_fees[] entry or unsupported_commercial_mechanisms[] entry combines evidence from MORE THAN ONE section (e.g. a performance-share fee whose rate is stated in one section, its calculation formula in another, and its rate schedule/table in a third — a common shape for evidence spread across a Bilaga/appendix), do NOT invent one combined heading (e.g. "Section 2 / Section 3", or just "Bilaga 1") standing in for all of them — that produces exactly one non-functional or misleading source link for what is really several distinct, independently-navigable clauses. Instead, populate that entry's own source_sections: [{"exact_source_heading": "<verbatim heading 1>", "display_label": "<optional short human caption, or omit>"}, {"exact_source_heading": "<verbatim heading 2>", ...}, ...], one object per section, in the order the evidence appears in source_clause. exact_source_heading follows the exact same VERBATIM ONLY rule as field_sources above — display_label (optional) may use a friendlier phrasing for human display (e.g. "Bilaga 1, Source 2") but is NEVER itself used to locate anything in the PDF. Leave source_sections absent/null when the entry's evidence genuinely came from a single section (the common case) — field_sources (this field, keyed by the field name) remains authoritative for every other field on the contract. Concrete worked example from a real Swedish contract, where Bilaga 1's actual headings are "2. Pilot och affärsmodell", "3. Modellen i korthet", and "5. Resultatdel efter värdeviktad betalgrad": source_sections must be exactly [{"exact_source_heading": "2. Pilot och affärsmodell"}, {"exact_source_heading": "3. Modellen i korthet"}, {"exact_source_heading": "5. Resultatdel efter värdeviktad betalgrad"}] — never [{"exact_source_heading": "Bilaga 1, Section 2"}, ...] or any other paraphrase.
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
  "discounts": [{"discount_pct": 20, "discount_amount": null, "discount_type": "introductory", "start_date": "2024-02-01", "end_date": "2024-07-31", "duration_months": 6, "applies_to": "base subscription", "description": "20% introductory discount months 1-6", "affected_components": ["base_recurring_fee"], "possibly_affected_components": null}],
  "service_credits": [{"credit_type": "service_credit", "description": "Service credit for platform availability below 99.5%", "source_clause": "If monthly platform availability falls below 99.5%, Customer receives a service credit equal to 10% of that month's platform subscription fee. Total credits in any calendar month shall not exceed 25% of that month's platform subscription fee. Credits are applied against the next invoice and are not redeemable for cash.", "stated_pct": 10, "stated_amount": null}],
  "overage_tiers": [
    {"tier_label": "Calls 1–10,000", "from_unit": 1, "to_unit": 10000, "rate_per_unit": 0.02, "unit_type": "API call", "measurement_period": "monthly", "minimum_period_amount": null, "tier_calculation": {"method": "graduated", "source_clause": null, "requires_confirmation": true, "confirmation_reason": "Contract states per-call rates for each tier but does not specify whether crossing a threshold re-rates all calls or only the calls above it."}},
    {"tier_label": "Calls 10,001–100,000", "from_unit": 10001, "to_unit": 100000, "rate_per_unit": 0.015, "unit_type": "API call", "measurement_period": "monthly", "minimum_period_amount": null, "tier_calculation": {"method": "graduated", "source_clause": null, "requires_confirmation": true, "confirmation_reason": "Contract states per-call rates for each tier but does not specify whether crossing a threshold re-rates all calls or only the calls above it."}},
    {"tier_label": "Calls 100,001+", "from_unit": 100001, "to_unit": null, "rate_per_unit": 0.01, "unit_type": "API call", "measurement_period": "monthly", "minimum_period_amount": null, "tier_calculation": {"method": "graduated", "source_clause": null, "requires_confirmation": true, "confirmation_reason": "Contract states per-call rates for each tier but does not specify whether crossing a threshold re-rates all calls or only the calls above it."}}
  ],
  "additional_recurring_fees": [],
  "one_time_fees": [{"fee_label": "Onboarding fee", "amount": 5000, "due_date": "2024-02-01", "description": "One-time onboarding and implementation fee due at contract start", "source_clause": null, "billability_condition": {"kind": "fixed_date", "date": "2024-02-01"}}],
  "unsupported_commercial_mechanisms": [],
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
    return applyExtractionSafetyNets(await extractFromChunk(chunks[0], learningContext, piiMasked), chunks[0])
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
    // Reasoning-tier call (adaptive thinking) — max_tokens caps thinking +
    // text combined, not just the final JSON. 4096 was sized for a
    // non-thinking call and was confirmed live to truncate mid-thinking
    // before any text output on a real full-contract extraction, leaving
    // an empty content array. 16384 leaves real headroom for both.
    max_tokens: 16384,
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
      // Reasoning-tier call — see extractFromChunk's identical comment.
      max_tokens: 2048,
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
// Step 17B0.1, items 1/4/5/6/7 — root cause found live: `base` (below) is a
// SINGLE chunk's full result, picked only by scoreCompleteness's narrow
// criteria (customer_name/base fee/dates/currency/escalators/discounts/
// overage_tiers). Every OTHER field that scoreCompleteness doesn't score —
// customer_org_number, renewal_notice_months, base_fee_proration,
// vendor/billing contact fields, etc. — used to come ONLY from that one
// winning chunk, silently discarding the same field's real value the
// moment it was extracted from a DIFFERENT chunk instead. A real,
// multi-chunk Remembill extraction confirmed this: the chunk containing
// the fee table won as `base` (it scores highest), while the org number,
// renewal-notice clause, and base_fee_proration — extracted correctly
// from a LATER chunk — were silently dropped because nothing coalesced
// them back in. Takes the first genuinely non-null value across ALL
// chunks, in chunk order, rather than trusting whichever chunk happened
// to score highest on unrelated criteria.
function coalesceScalar<K extends keyof ContractTerms>(results: ContractTerms[], key: K): ContractTerms[K] {
  for (const r of results) {
    const v = r[key]
    if (v != null) return v
  }
  return results[0][key]
}

export function mergeExtractions(results: ContractTerms[]): ContractTerms {
  // Take the most complete result as base, then merge arrays from all chunks
  const base = results.reduce((best, curr) => {
    const bestScore = scoreCompleteness(best)
    const currScore = scoreCompleteness(curr)
    return currScore > bestScore ? curr : best
  })

  const merged: ContractTerms = {
    ...base,
    contract_id: coalesceScalar(results, 'contract_id'),
    crm_id: coalesceScalar(results, 'crm_id'),
    customer_address: coalesceScalar(results, 'customer_address'),
    billing_contact: coalesceScalar(results, 'billing_contact'),
    vendor_address: coalesceScalar(results, 'vendor_address'),
    order_date: coalesceScalar(results, 'order_date'),
    auto_renews: coalesceScalar(results, 'auto_renews'),
    renewal_notice_days: coalesceScalar(results, 'renewal_notice_days'),
    renewal_notice_months: coalesceScalar(results, 'renewal_notice_months'),
    customer_email: coalesceScalar(results, 'customer_email'),
    customer_org_number: coalesceScalar(results, 'customer_org_number'),
    renewal_term_months: coalesceScalar(results, 'renewal_term_months'),
    payment_terms_days: coalesceScalar(results, 'payment_terms_days'),
    payment_terms_text: coalesceScalar(results, 'payment_terms_text'),
    included_units: coalesceScalar(results, 'included_units'),
    included_unit_type: coalesceScalar(results, 'included_unit_type'),
    base_fee_bands: coalesceScalar(results, 'base_fee_bands'),
    base_fee_committed_volume: coalesceScalar(results, 'base_fee_committed_volume'),
    base_fee_proration: coalesceScalar(results, 'base_fee_proration'),
    escalators: dedupe([...results.flatMap(r => r.escalators)], 'description'),
    discounts: dedupe([...results.flatMap(r => r.discounts)], 'description'),
    service_credits: dedupe([...results.flatMap(r => r.service_credits ?? [])], 'description'),
    overage_tiers: dedupe([...results.flatMap(r => r.overage_tiers)], 'tier_label'),
    one_time_fees: dedupe([...results.flatMap(r => r.one_time_fees ?? [])], 'fee_label'),
    additional_recurring_fees: dedupe([...results.flatMap(r => r.additional_recurring_fees ?? [])], 'fee_label'),
    unsupported_commercial_mechanisms: dedupe([...results.flatMap(r => r.unsupported_commercial_mechanisms ?? [])], 'kind'),
    // Step 17B0.2, item 6 — field_sources (the PDF-locator heading per
    // field) had exactly the same "only from the winning chunk" bug as
    // every field above: a field whose VALUE was correctly coalesced from
    // a losing chunk could still end up with either no field_sources entry
    // at all, or (worse) one silently inherited from `base` that names the
    // WRONG section — the "View source" link would then either show
    // nothing or navigate to unrelated text. Union every chunk's
    // field_sources, keyed per field, first-non-empty-value-wins — same
    // per-key coalescing principle as coalesceScalar, applied to an object
    // instead of a single field.
    field_sources: results.reduce<Record<string, string>>((acc, r) => {
      for (const [key, value] of Object.entries(r.field_sources ?? {})) {
        if (value && !acc[key]) acc[key] = value
      }
      return acc
    }, {}),
    // Use 'comma' if ANY chunk detected comma notation (more specific detection wins)
    number_format: results.some(r => r.number_format === 'comma') ? 'comma' : 'dot',
  }

  return applyExtractionSafetyNets(merged)
}

// The post-processing every extraction result must go through regardless of
// how many chunks it came from — this used to run only inside
// mergeExtractions, which the single-chunk path (the common case for a
// contract under ~12,000 chars) never calls at all, so a short contract's
// discounts/service_credits came back with NO discount_rule_id/
// credit_rule_id whatsoever (nothing to address them by — confirm-rule,
// propose-rule, and lib/commercial-rule-status.ts's workload count all
// silently skip an item with no id, which is exactly how a real, correctly
// -extracted credit like TEST-PAY-002's Annual Rebate/Growth Credit/Service
// Availability Credit went completely invisible to review). Applied exactly
// once, after chunking/merging is fully resolved either way.
// contractText is optional (the merge/multi-chunk path at mergeExtractions
// doesn't have a single contiguous raw text to pass) — when present (the
// common single-chunk case, i.e. every contract under ~12,000 chars),
// enables preserveExclusionLanguage's deterministic backstop below.
export function applyExtractionSafetyNets(terms: ContractTerms, contractText?: string): ContractTerms {
  // Guard: end_date must be after start_date. If the model extracted a wrong year
  // (e.g. "2026-07-31" for a 36-month contract starting 2026-08-01), auto-correct
  // using contract_term_months when available.
  if (terms.contract_start_date && terms.contract_end_date && terms.contract_term_months) {
    const start = new Date(terms.contract_start_date)
    const end   = new Date(terms.contract_end_date)
    if (end <= start) {
      const corrected = new Date(start)
      corrected.setMonth(corrected.getMonth() + terms.contract_term_months)
      corrected.setDate(corrected.getDate() - 1) // last day of term
      terms.contract_end_date = corrected.toISOString().slice(0, 10)
    }
  }

  terms.overage_tiers = flagAmbiguousMinimumCommitments(terms.overage_tiers)
  terms.overage_tiers = flagAmbiguousTierCalculation(terms.overage_tiers)
  terms.additional_recurring_fees = enforceVariableRateFeeShape(terms.additional_recurring_fees)
  terms.discounts = assignDiscountRuleIds(terms.discounts)
  terms.service_credits = assignServiceCreditRuleIds(terms.service_credits ?? [])
  terms.one_time_fees = flagAmbiguousOneTimeFees(terms.one_time_fees ?? [], terms.currency)
  terms.one_time_fees = normalizeBillabilityCondition(terms.one_time_fees ?? [], terms.contract_start_date)
  flagAmbiguousBaseFeeProration(terms, contractText)
  if (contractText) preserveExclusionLanguage(terms, contractText)

  // Step 17C.3 (hardened 17C.3a) — attempt to compile the performance-
  // share/rolling-band mechanisms into their existing 17C.1/17C.2 typed
  // executable configs, from the EXPLICIT structured fields extraction
  // stated (numerator_input_key/denominator_input_key/
  // charge_basis_input_key/rolling_input_key/rate_schedule_bands/
  // rolling_window_count/notice_required) — never from raw_inputs'/
  // required_operational_inputs' array position or ordering. Fails closed
  // per mechanism, leaving required_operational_inputs/raw_inputs/
  // source_clause exactly as extracted either way — see
  // lib/commercial-mechanism-compiler.ts's own header.
  terms = compileExecutableCommercialMechanisms(terms)

  return terms
}

// Step 17A, item 7 — deterministic structural enforcement, independent of
// whether the model actually follows the FIXED vs. PER-UNIT/VARIABLE
// prompt guidance above: a fee the model itself marked as per-unit
// (metric_name AND rate_per_unit both populated) can never ALSO carry a
// non-zero fixed `amount` — that combination is exactly the shape that let
// a per-event rate get multiplied by the contract's billing-cycle count as
// if it were a fixed subscription price. Forces amount to 0 whenever both
// are set, regardless of what the model put there; never touches
// metric_name/rate_per_unit themselves, and never touches a fee that
// wasn't marked per-unit at all (an ordinary fixed fee is untouched).
function enforceVariableRateFeeShape(fees: AdditionalRecurringFee[] | null): AdditionalRecurringFee[] | null {
  if (!fees) return fees
  return fees.map(fee => {
    if (fee.metric_name && typeof fee.rate_per_unit === 'number' && fee.rate_per_unit > 0 && fee.amount) {
      return { ...fee, amount: 0 }
    }
    return fee
  })
}

// Sentences equivalent to "applies only to X", "applied only against X",
// "does not apply to Y", "may not be applied against Y", "excluding Z",
// "excludes W" state a service credit's eligible application scope (which
// future invoice components it may offset) — high-value billing semantics,
// never safe to lose to summarization. The SOURCE_CLAUSE COMPLETENESS RULE
// in SYSTEM_PROMPT above asks the model not to drop these; this is a
// deterministic backstop for when it does anyway, independent of the model
// noticing. Covers both "to"/"against" phrasing — TEST-PAY-002 itself uses
// both ("applies only to transaction-processing fees" for the Rebate,
// "applied only against future transaction-processing fees" for the Growth
// Credit) — extend this list as new real-world phrasings turn up.
const EXCLUSION_LANGUAGE_RE = /\bapplies?\s+only\s+to\b|\bapplied\s+only\s+against\b|\bdoes\s+not\s+apply\s+to\b|\bmay\s+not\s+be\s+applied\s+against\b|\bexcluding\b|\bexcludes\b/i

// Pulls candidate anchor numbers out of a credit's own description —
// multi-digit figures (a trigger threshold, a flat amount) are far less
// likely to collide elsewhere in a typical commercial contract than a bare
// one-digit percentage, so longer numbers are tried first.
function extractAnchorCandidates(description: string): string[] {
  const matches = description.match(/\d[\d,]{2,}/g) ?? []
  return [...new Set(matches)].sort((a, b) => b.replace(/,/g, '').length - a.replace(/,/g, '').length)
}

// Line-based, not sentence-based: an exclusion clause is frequently phrased
// as an introductory line ending in ":" followed by a bulleted list (e.g.
// "The rebate does not apply to:\n• platform fees;\n• chargeback fees;").
// The regex only matches the introductory line, but the actual billing-
// relevant content (WHICH components) is in the bullets that follow — so a
// matched line pulls in every immediately-following bullet/numbered line,
// stopping at the first line that isn't one. Not a general-purpose
// sentence tokenizer; scoped to exactly this list-after-colon shape.
function extractExclusionSpans(window: string): string[] {
  const lines = window.split('\n').map(l => l.trim()).filter(Boolean)
  const spans: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!EXCLUSION_LANGUAGE_RE.test(lines[i])) continue
    const spanLines = [lines[i]]
    let j = i + 1
    while (j < lines.length && /^[•\-*]|^\d+[.)]/.test(lines[j])) {
      spanLines.push(lines[j])
      j++
    }
    spans.push(spanLines.join(' '))
    i = j - 1
  }
  return spans
}

// Deterministic, heuristic backstop — not a general clause-boundary parser.
// For each service credit, locates roughly where its own provision begins
// in the raw contract text (via a distinctive multi-digit number pulled
// from its description), bounds a scan window to the nearest neighbouring
// credit's own anchor (so one credit's exclusion sentence is never
// misattributed to a different credit sitting nearby in the document), and
// appends any exclusion-language sentence found in that window that isn't
// already present in source_clause. Silently no-ops (never throws, never
// invents a match) when an anchor can't be found — a missed anchor leaves
// source_clause exactly as the model produced it, same as before this
// function existed, rather than guessing.
function preserveExclusionLanguage(terms: ContractTerms, contractText: string): void {
  const credits = terms.service_credits ?? []
  if (credits.length === 0) return

  const anchored = credits
    .map(credit => {
      for (const candidate of extractAnchorCandidates(credit.description ?? '')) {
        const pos = contractText.indexOf(candidate)
        if (pos !== -1) return { credit, pos }
      }
      return null
    })
    .filter((a): a is { credit: ServiceCredit; pos: number } => a !== null)
    .sort((a, b) => a.pos - b.pos)

  const MAX_WINDOW = 1200
  const BACK_BUFFER = 200 // the anchor number can sit mid-clause, not just at its start
  for (let i = 0; i < anchored.length; i++) {
    const { credit, pos } = anchored[i]
    const nextPos = i + 1 < anchored.length ? anchored[i + 1].pos : contractText.length
    const windowStart = Math.max(0, pos - BACK_BUFFER)
    const windowEnd = Math.min(pos + MAX_WINDOW, nextPos)
    const window = contractText.slice(windowStart, windowEnd)
    const currentClause = credit.source_clause ?? ''
    const normalizedCurrent = normalizeForComparison(currentClause)
    const missing = extractExclusionSpans(window).filter(s => {
      const normalizedSpan = normalizeForComparison(s)
      return !normalizedCurrent.includes(normalizedSpan.slice(0, Math.min(40, normalizedSpan.length)))
    })
    if (missing.length > 0) {
      credit.source_clause = [currentClause, ...missing].filter(Boolean).join(' ').trim()
    }
  }
}

// The model's own source_clause frequently re-flows raw text into prose —
// dropping bullet markers ("•"), collapsing internal whitespace, changing
// word order slightly ("applied only against" vs "only applied against") —
// while still preserving the exact substance. A literal substring check
// against the RAW (bulleted) window text would then see this as "missing"
// and duplicate content the model already captured correctly, purely
// because of formatting, not because information is actually absent.
// Normalizing away bullet markers and whitespace before comparing (and
// comparing a longer, more distinctive slice) makes the dedup check robust
// to this without needing exact verbatim matching.
function normalizeForComparison(s: string): string {
  return s.replace(/[•\-*]\s*/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
}

// base_fee_proration/AdditionalRecurringFee.proration are only ever
// populated by the extraction PROMPT when the contract explicitly ties a
// fee to calendar boundaries ("billed each calendar month") — deliberately
// left null for the far more common contract-start-anchored case, per the
// prompt's own rule. But that rule has a real gap: a fee that just says
// "billed monthly" with NO anchor language at all (TEST-PAY-002's actual
// §2: "SEK 38,500 per month... billed monthly in advance", nothing more)
// is genuinely silent on the question, not evidence that contract-start
// anchoring applies — silently defaulting to "no partial period" here is
// exactly the kind of unreviewed assumption this whole pipeline exists to
// prevent. This safety net catches it deterministically: whenever the
// contract starts mid-month (or mid-quarter/year, per billing_frequency)
// and extraction found no explicit anchor statement, the fee is flagged as
// requiring a reviewer decision — never silently billed either way. Uses
// the SAME partial-period confirm-rule flow (reset_anchor stays 'calendar'
// once a reviewer resolves it, matching how confirm-rule's
// buildPeriodProrationRule already defaults) rather than inventing a
// separate "unknown anchor" state through the billing engine.
// Given a section heading exactly as it appears in field_sources (e.g.
// "2. Platform Fee" — the model already extracts this per-field), pulls the
// verbatim contract text between that heading and the next numbered
// heading. flagAmbiguousBaseFeeProration below is a purely structural check
// (day-of-month) with no clause-level reasoning of its own — this is how it
// gets a REAL source_clause instead of null, without inventing one.
// Degrades to null (never throws) if the heading can't be found verbatim —
// e.g. a contract whose extraction didn't populate field_sources, or where
// section numbering doesn't match this heuristic — same as the pre-existing
// behavior for those cases.
function extractSectionClause(contractText: string, heading: string): string | null {
  const lines = contractText.split('\n')
  const headingIdx = lines.findIndex(l => l.trim() === heading.trim())
  if (headingIdx === -1) return null
  const body: string[] = []
  for (let i = headingIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (/^\d+\.\s+\S/.test(line)) break // next numbered heading
    if (line) body.push(line)
  }
  return body.length > 0 ? body.join(' ') : null
}

function flagAmbiguousBaseFeeProration(terms: ContractTerms, contractText?: string): void {
  // Trigger (a): calendar/contract-start mismatch — only a real question
  // when the contract starts mid-period; a contract starting on the 1st
  // has no such question under EITHER anchor reading, so this branch has
  // nothing to add for it. Independent of trigger (b) below — a contract
  // starting cleanly on the 1st (this early return) can still have an
  // open trigger-(b) question, so trigger (b) must never be gated by it.
  if (terms.contract_start_date) {
    const startDay = new Date(terms.contract_start_date + 'T00:00:00').getDate()
    if (startDay !== 1) {
      const reason = 'The contract does not state whether this fee resets on the contract’s own start-date anniversary or on calendar boundaries, and the agreement begins mid-period.'

      if ((terms.base_monthly_fee || terms.base_annual_fee) && !terms.base_fee_proration) {
        const heading = terms.field_sources?.base_monthly_fee ?? terms.field_sources?.base_annual_fee
        const sourceClause = (contractText && heading) ? extractSectionClause(contractText, heading) : null
        terms.base_fee_proration = {
          reset_anchor: 'calendar', prorate_partial_periods: 'unclear',
          requires_confirmation: true, confirmation_reason: reason, source_clause: sourceClause,
        }
      }
      for (const fee of terms.additional_recurring_fees ?? []) {
        if (fee.amount && !fee.proration) {
          fee.proration = {
            reset_anchor: 'calendar', prorate_partial_periods: 'unclear',
            requires_confirmation: true, confirmation_reason: reason, source_clause: null,
          }
        }
      }
    }
  }

  flagAmbiguousWaiverExpiryProration(terms)
}

// Step 17B0.1, item 1 — deterministic backstop for the prompt's own
// base_fee_proration trigger (b): a discount/waiver on the base fee has a
// stated duration_days expiry that doesn't land on a clean calendar-month
// boundary. Confirmed live: a real extraction of the actual Remembill
// contract omitted base_fee_proration entirely for exactly this shape (a
// 90-day pilot from 2026-10-01 expires 2026-12-30, two days short of the
// next month boundary) — the model is asked to catch this itself (see the
// prompt's own rule (b)), but nothing forced it to, so buildLineItems then
// had nothing to withhold on and silently materialized a confident
// multi-period schedule. This never overrides an existing structured
// answer (mirrors trigger (a)'s own `!terms.base_fee_proration` guard
// above) — only fills the gap when the model produced NOTHING at all, so
// a genuinely-resolved reading the model correctly derived from explicit
// contract text is never fought.
function flagAmbiguousWaiverExpiryProration(terms: ContractTerms): void {
  if (terms.base_fee_proration) return // model already produced a structured answer — never override it
  if (!terms.contract_start_date) return
  if (!(terms.base_monthly_fee || terms.base_annual_fee)) return

  // UTC millisecond arithmetic, not local-timezone Date methods — a plain
  // 'YYYY-MM-DD' date has no time-of-day/timezone component at all, and
  // repeated local setDate() calls across a DST transition (Sweden's own
  // October changeover falls squarely inside this contract's own term) can
  // silently shift the computed calendar date by a day. UTC has no DST, so
  // this stays correct regardless of the server's runtime timezone.
  const [y, m, d] = terms.contract_start_date.split('-').map(Number)
  const contractStartMs = Date.UTC(y, m - 1, d)
  const DAY_MS = 86_400_000

  for (const discount of terms.discounts ?? []) {
    if (discount.duration_days == null) continue
    const targetsBaseFee = discount.affected_components?.includes('base_recurring_fee')
      || discount.possibly_affected_components?.includes('base_recurring_fee')
    if (!targetsBaseFee) continue

    // expiryMs is the FIRST day the waiver no longer applies (the fee
    // resumes) — a duration_days-long waiver starting on contractStart
    // covers exactly that many days, so the fee resumes on day
    // contractStart + duration_days. If that landing day is itself the
    // 1st of a month, the fee's normal cadence resumes with no partial
    // stretch at all — a genuinely clean boundary, nothing to flag.
    const expiryMs = contractStartMs + discount.duration_days * DAY_MS
    const expiryDate = new Date(expiryMs)
    if (expiryDate.getUTCDate() === 1) continue

    terms.base_fee_proration = {
      reset_anchor: 'contract_start',
      prorate_partial_periods: 'unclear',
      requires_confirmation: true,
      confirmation_reason: `A waiver on the fixed platform fee (${discount.duration_days}-day duration from ${terms.contract_start_date}) expires ${expiryDate.toISOString().slice(0, 10)}, which does not land on a clean boundary of the fee's normal billing cadence — the contract does not state whether the resumed fee is prorated for the remainder of that period or begins in full from the next full billing period.`,
      source_clause: discount.description ?? null,
    }
    return // one flag is enough
  }
}

// Step 11 — a narrow, deterministic safety net for the ONE real risk found
// by auditing OneTimeFee's actual production lifecycle (lib/rulebook/
// MILESTONE_BILLING_FINDINGS.md): a fee with manual_trigger falsy, a
// positive amount, and NO due_date is currently invoiced immediately, with
// zero fee-level human review, the moment a job is approved — due_date:
// null is treated as "due now" (lib/billing-writer.ts's `isDue = !feeDueDate
// || feeDueDate <= now`). This is genuinely ambiguous (unlike manual_trigger:
// true, which correctly waits for confirmation, or a stated due_date, which
// correctly bills on schedule) — there is no basis for treating "now" as the
// right moment. Deliberately does NOT flag every one-time fee — a plain,
// clearly-scheduled or clearly-manual fee is already handled correctly and
// must not gain a spurious review requirement (item 5: field-requiredness-
// aware, never a blanket presence check). Never touches manual_trigger,
// amount, or due_date themselves — this only ever ADDS confirmation
// metadata, never changes what would actually get billed.
//
// Step 11 amendment — a SEPARATE, independent pass sets billability_
// provenance explicitly to null (evaluated, genuinely unresolved — see
// that field's own doc comment in lib/types.ts for the undefined/null/
// resolved three-state discriminator) for every fee where the automatic-
// execution timing decision actually matters: manual_trigger falsy, i.e.
// the exact shape lib/billing-writer.ts will auto-invoice once due,
// REGARDLESS of whether due_date happens to be set — item 3's core
// doctrine: "concrete value + missing provenance != source-derived", so a
// stated due_date alone is never treated as sufficient evidence. Extraction
// has no per-field source-grounding signal for this yet (unlike, say,
// isServiceCreditFullySourceResolved's textual-marker heuristic for
// service credits), so this never auto-assigns 'contract_derived' —
// resolving billability stays exclusively a reviewer action
// (lib/one-time-fee.ts's buildOneTimeFeeConfirmation) until a real
// source-grounding signal exists. manual_trigger: true fees are
// deliberately left untouched (billability_provenance stays undefined) —
// item 6: execution is already safely held for that shape (a human must
// take a deliberate, separate parked-invoice action; there is no automatic
// timing decision to gate), so this field simply isn't load-bearing there.
//
// Final correction — the SAME treatment, symmetrically, for
// amount_provenance: every fee with a real, positive amount that has never
// been evaluated (amount_provenance === undefined) gets it explicitly
// evaluated here, REGARDLESS of whether the narrower requires_confirmation
// ambiguity flag below also fires. requires_confirmation keeps its
// original, narrower meaning (UI/workflow metadata for the one
// genuinely-ambiguous shape — item 1: "may remain UI/workflow metadata,
// but must not substitute for provenance"); amount_provenance is what
// lib/commercial-rule-status.ts's isOneTimeFeeUnresolved actually gates
// readiness on once a record has entered this lifecycle.
//
// Contract B acceptance amendment — "evaluated" for amount_provenance is
// no longer unconditionally null. lib/one-time-fee-provenance.ts's
// deriveOneTimeFeeAmountProvenance runs a small, deterministic check
// against THIS fee's own source_clause (never AI confidence, never model
// reasoning, never the whole contract) and mints 'contract_derived' when
// the contract explicitly, unambiguously states this exact amount in the
// agreement's own currency — e.g. "Customer will pay a one-time launch fee
// of SEK 20,000" grounds amount 20000 when currency is SEK. Any
// incomplete/ambiguous case (no stated amount, a range, a currency
// mismatch, a stated figure that disagrees with the extracted value) falls
// back to null exactly as before — this never guesses.
//
// Billability provenance ordering amendment — this function no longer
// writes billability_provenance at all (it used to stamp undefined -> null
// here, gated on the model's RAW, not-yet-validated manual_trigger). Two
// writers of a "fresh" field is exactly the bug class this whole module
// exists to prevent: normalizeBillabilityCondition (below, which runs
// immediately after this function — see applyExtractionSafetyNets) is now
// the SOLE authority for finalizing a fresh billability_provenance, because
// it is the only place that has the VALIDATED canonical BillabilityCondition
// (via parseBillabilityCondition) to ground against — this function only
// ever sees the model's raw, unvalidated JSON. Billability grounding itself
// (lib/one-time-fee-billability-provenance.ts) is scoped narrowly today —
// see normalizeBillabilityCondition's own comment for exactly which class.
function flagAmbiguousOneTimeFees(fees: OneTimeFee[], agreementCurrency: string | null | undefined): OneTimeFee[] {
  return fees.map(fee => {
    let next = fee
    if (next.amount > 0 && next.amount_provenance === undefined) {
      next = { ...next, amount_provenance: deriveOneTimeFeeAmountProvenance(next, agreementCurrency) }
    }
    if (next.manual_trigger) return next
    if (next.due_date) return next
    if (!(next.amount > 0)) return next
    if (next.requires_confirmation) return next // already flagged (e.g. re-extraction preserving a prior confirmation state — see mergeExtractions)
    return {
      ...next,
      requires_confirmation: true,
      unresolved_kind: 'needs_review' as const,
      confirmation_reason: 'This fee has no stated due date and is not gated on manual delivery confirmation — the contract does not establish when it becomes billable.',
    }
  })
}

// Step 12 final lifecycle correction — a genuinely pre-existing, unrelated
// pricing mechanism: variable/per-unit professional-services billing
// (an hourly/per-session rate applied to a quantity only known at delivery
// time). This is NOT a "fixed OneTimeFee awaiting a billability condition"
// — the BillabilityCondition ontology was never meant to normalize per-unit
// pricing at all (out of scope from the original Step 12 spec, same as
// milestone scheduling or retention). Structural, based on the fee's
// EXISTING extracted shape — never manual_trigger (which a fixed-amount fee
// can also carry, e.g. item 4's regression case below, and which must never
// by itself exempt anything from canonical semantics).
export function isExistingVariableRateFeeShape(fee: OneTimeFee): boolean {
  return !!fee.metric_name && typeof fee.rate_per_unit === 'number' && fee.rate_per_unit > 0 && !(fee.amount > 0)
}

// Step 12 final lifecycle correction — populates/normalizes
// billability_condition from the model's raw output and applies the ONE
// deterministic projection onto due_date/manual_trigger
// (lib/billability-condition.ts's projectBillabilityConditionToExecutionFields)
// so the two representations can never silently disagree (item 15). Runs
// after flagAmbiguousOneTimeFees, which has already set the
// amount_provenance/billability_provenance/requires_confirmation baseline
// this function builds on.
//
// THE LIFECYCLE DISCRIMINATOR is NEVER manual_trigger (items 1-4, all three
// amendment rounds). A prior draft had `if (fee.manual_trigger) return fee`
// as its first check, letting a model-emitted legacy execution flag bypass
// the closed-union parser entirely for any fee that also happened to carry
// it. A later draft fixed that but still let `rawCondition === undefined`
// alone mean "legacy" — which conflated two different things: a genuinely
// historical PERSISTED record that never passed through this function at
// all, versus a FRESH extraction where the model simply omitted the field.
// The latter has, by definition, been evaluated by this pipeline just now,
// and "the model omitted it" is never, by itself, evidence of intentional
// manual/discretionary billing (item 3/5) — so it must canonicalize to
// `null` (evaluated, unresolved), not stay `undefined`.
//
// The ONLY narrow exemption from that canonicalization is
// isExistingVariableRateFeeShape (above) — checked ONLY once no valid
// condition was parsed (item 1: a valid condition always wins, even for a
// fee that otherwise looks rate-based), and ONLY when the raw key was
// genuinely absent (`rawCondition === undefined`, not an explicit `null`
// and not a malformed value the model attempted and got wrong — item 4's
// "do not use the exemption to hide malformed Step-12 semantics"). A
// fixed-amount fee with manual_trigger:true and no condition does NOT
// qualify for this exemption (isExistingVariableRateFeeShape requires
// metric_name + a positive rate_per_unit + no positive amount) — it
// canonicalizes to null like any other unanswered fixed fee.
//
// `undefined` is therefore reserved EXCLUSIVELY for (a) a genuine
// historical record that never passed through this function, and (b) the
// narrow variable-rate-shape exemption — a persistence/shape distinction,
// never a "the model didn't answer" distinction.
//
// Never re-normalizes a fee whose billability is already reviewer/contract
// resolved (isProvenanceResolved(billability_provenance)) — re-extraction
// must not silently overwrite a human's prior confirmation or a genuine
// contract_derived resolution.
//
// Acceptance-test fix round — a fee described as "billable immediately on
// the Effective Date" is not safely representable as `immediate` (it
// projects to due_date: null, which lib/billing-execution-plan.ts's due-now
// check reads as "due whenever this next runs," with no awareness of the
// Effective Date — see lib/billing-execution-plan.test.ts's execution-safety
// regression). The FIX for that lives entirely in the extraction PROMPT
// above (billability_condition's fixed_date/immediate guidance): the model
// reads the actual clause and is instructed to emit fixed_date(contract_
// start_date) directly whenever the clause names the Effective Date/
// commencement, reserving immediate for wording with no such reference.
//
// A prior draft of this function ALSO rewrote every `kind: 'immediate'` to
// `fixed_date(contractStartDate)` here, unconditionally, whenever a start
// date was known — deliberately removed. This function has no access to the
// source clause text, only the model's already-chosen `kind` — it cannot
// tell "Customer shall pay the onboarding fee immediately [upon execution]"
// (genuinely tied to signing, wrongly extracted as immediate rather than
// event/contract_signature — a different bug) apart from "billable
// immediately on the Effective Date" (genuinely Effective-Date-tied). Since
// a contract almost always HAS a start date, that rewrite would have fired
// on every immediate fee regardless of what the clause actually says,
// silently changing a signing-anchored fee's commercial meaning to an
// Effective-Date-anchored one whenever the two dates differ (e.g. signed 1
// September, Effective Date 1 October). Reinterpreting contract meaning
// from a field this function cannot ground in source text is worse than the
// residual risk it would have closed — the correct fix is upstream, in what
// the model is told to extract, not a downstream structural guess.
//
// Billability provenance amendment — this IS now the sole authority that
// finalizes a fresh billability_provenance (flagAmbiguousOneTimeFees no
// longer writes it at all — see that function's own comment for why two
// writers of the same fresh field was the actual bug). It's the right,
// and only, place this can safely happen: it's the one point in the
// pipeline holding a VALIDATED canonical BillabilityCondition (via
// parseBillabilityCondition just above) to ground against — grounding off
// the model's raw, unvalidated JSON would be exactly the kind of trust
// this module exists to refuse. lib/one-time-fee-billability-provenance.ts's
// deriveOneTimeFeeBillabilityProvenance runs a small, deterministic check
// — never AI confidence — and mints 'contract_derived' ONLY for the single
// narrowest, safest class: a fixed_date condition whose date equals the
// agreement's own contract_start_date, where the fee's own source_clause
// explicitly names the Effective Date/commencement as the anchor and
// states no competing trigger. Every other class (event conditions, a
// literal non-Effective-Date calendar date, 'immediate') still always
// evaluates to null here, unchanged — a separate, later, per-class audit,
// not a mechanical extension of this one.
function normalizeBillabilityCondition(fees: OneTimeFee[], contractStartDate: string | null | undefined): OneTimeFee[] {
  return fees.map(fee => {
    if (isProvenanceResolved(fee.billability_provenance)) return fee

    const rawCondition = (fee as unknown as { billability_condition?: unknown }).billability_condition
    const parsed = parseBillabilityCondition(rawCondition)

    if (parsed) {
      let next: OneTimeFee = { ...fee, billability_condition: parsed }
      // Step 13 — stable subject identity, assigned once, the moment a fee
      // genuinely enters the Step-12 lifecycle (never for the exempted
      // variable-rate shape, never re-assigned once present — see
      // lib/types.ts's OneTimeFee.fee_id for the full rationale, including
      // why fee_label alone was rejected as the evidence-table subject key).
      if (!next.fee_id) next = { ...next, fee_id: crypto.randomUUID() }
      const projection = projectBillabilityConditionToExecutionFields(parsed)
      next = { ...next, due_date: projection.due_date, manual_trigger: projection.manual_trigger }
      if (next.billability_provenance === undefined) {
        next = { ...next, billability_provenance: deriveOneTimeFeeBillabilityProvenance(next, parsed, contractStartDate) }
      }
      // flagAmbiguousOneTimeFees (which already ran) stamps a generic "no
      // stated due date" confirmation_reason for any due_date:null fee,
      // including 'immediate'/'event' conditions whose due_date is
      // legitimately null BY DESIGN (item 15's own projection). That
      // wording is stale/misleading once a real condition has been
      // identified — replace it with condition-aware text describing what
      // actually needs confirming, without changing WHETHER confirmation
      // is required (unresolved_kind/requires_confirmation themselves are
      // untouched — only the human-facing reason string).
      if (next.requires_confirmation && next.unresolved_kind === 'needs_review') {
        next = {
          ...next,
          confirmation_reason: parsed.kind === 'event'
            ? `The contract ties billability to a "${parsed.event_type.replace(/_/g, ' ')}" event — confirm this interpretation is correct.`
            : parsed.kind === 'immediate'
              ? 'The contract states this fee is payable immediately — confirm this interpretation is correct.'
              : `The contract states a fixed billing date (${parsed.date}) — confirm this interpretation is correct.`,
        }
      }
      return next
    }

    // No valid condition. The one narrow, shape-based exemption.
    if (rawCondition === undefined && isExistingVariableRateFeeShape(fee)) return fee

    // Everything else — genuine explicit silence, a malformed/rejected
    // model answer, OR a fixed-amount fee that simply never got asked
    // (item 5: fail closed rather than let omission read as a semantic
    // decision) — canonicalizes to null. due_date/manual_trigger are reset
    // to the safe/held projection (null/true) rather than left as whatever
    // the model separately produced — belt-and-suspenders alongside the
    // real enforcement point (billability_provenance staying unresolved
    // keeps this fee blocking via isOneTimeFeeBillabilityUnresolved/
    // computeCommercialRuleWorkload regardless), so a stray "due now" or
    // "safe legacy" shaped pair can never survive as competing meaning on
    // a newly-governed record.
    let next: OneTimeFee = { ...fee, billability_condition: null, due_date: null, manual_trigger: true }
    if (!next.fee_id) next = { ...next, fee_id: crypto.randomUUID() } // Step 13 — see the `parsed` branch's identical comment
    if (next.billability_provenance === undefined) next = { ...next, billability_provenance: null }
    if (next.amount > 0 && !next.requires_confirmation) {
      next = {
        ...next,
        requires_confirmation: true,
        unresolved_kind: next.unresolved_kind ?? 'needs_review',
        confirmation_reason: next.confirmation_reason
          ?? 'This fee has no stated billing condition Verdix can normalize — the contract does not establish when it becomes billable.',
      }
    }
    return next
  })
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
