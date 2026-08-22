import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { extractContractTerms } from '@/lib/contract-extractor'
import { resolveStorageUrl } from '@/lib/storage'
import { maskText, restoreTokensInObject } from '@/lib/pii-detector'
import { computeMonthlyBaseRate, computeEscalatorMultiplier, computeDiscountMultiplier, monthCursor } from '@/lib/billing-writer'
import { billingInterval } from '@/lib/stripe-meter'
import { extractDocumentText, isAIInfraError, AI_INFRA_ERROR_PREFIX } from '@/lib/ai-client'
import { preserveStableRuleIds, preserveOneTimeFeeIdentity } from '@/lib/rule-id-stability'
import type { Discount, ServiceCredit, OneTimeFee } from '@/lib/types'


// Allow up to 5 minutes — PDF extraction + two Anthropic calls can exceed the default 10s limit
export const maxDuration = 300

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let org
  try { org = await requireOrg() } catch (res) { return res as Response }

  const { id } = await params

  const { data: job, error: jobError } = await supabaseServer
    .from('jobs')
    .select('id, name, currency, contract_pdf_url, contract_terms_id')
    .eq('id', id)
    .eq('org_id', org.orgId)
    .single()

  if (jobError || !job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  await supabaseServer.from('jobs').update({ execute_status: 'EXTRACTING' }).eq('id', id)

  waitUntil(
    runExecutePipeline(id, org.orgId, job.contract_pdf_url, job.currency, job.contract_terms_id).catch(async (err) => {
      const rawMessage = err instanceof Error ? err.message : String(err)
      // AI-infra failures (out of Anthropic credit, rate-limited, timed out,
      // etc.) are an admin problem to fix, not something a customer can act
      // on — prefix so the GET /api/jobs/[id] handler can show the real
      // detail to admins only and a generic "contact us" message to everyone
      // else, without needing a schema change to track it separately.
      const message = isAIInfraError(err) ? `${AI_INFRA_ERROR_PREFIX}${rawMessage}` : rawMessage
      await supabaseServer.from('jobs').update({
        execute_status: 'FAILED',
        error_message: message,
      }).eq('id', id)
    })
  )

  return NextResponse.json({ jobId: id, status: 'EXTRACTING' })
}

async function runExecutePipeline(jobId: string, orgId: string, contractUrl: string | null, currency: string, existingContractTermsId: string | null) {
  if (!contractUrl) throw new Error('Missing contract file')

  // Reuse detect-pii's extraction if this job already went through PII
  // detection — avoids a second identical Bedrock call re-extracting the
  // same PDF, and (when present) skips re-downloading the file too.
  const { data: pendingRow } = await supabaseServer
    .from('jobs')
    .select('pending_extracted_text')
    .eq('id', jobId)
    .maybeSingle()

  let contractText: string
  if (pendingRow?.pending_extracted_text) {
    contractText = pendingRow.pending_extracted_text
    await supabaseServer.from('jobs').update({ pending_extracted_text: null }).eq('id', jobId)
  } else {
    const resolvedUrl = await resolveStorageUrl(contractUrl)
    const res = await fetch(resolvedUrl)
    if (!res.ok) throw new Error(`Failed to download contract`)
    const buffer = Buffer.from(await res.arrayBuffer())
    contractText = await extractPDFText(buffer, resolvedUrl)
  }

  // PII masking is a baseline control for every org, not a paid add-on — use
  // approved entities from DB (set during PII review step), falling back to
  // auto-detection if no reviewed entities exist yet for this job/org.
  const { tokenMap, reverseMap } = await buildMaskFromDB(jobId, orgId, contractText)
  const textToExtract = maskText(contractText, tokenMap)

  const rawTerms = await extractContractTerms(textToExtract, undefined, tokenMap.size > 0)

  // Restore PII tokens in string fields so the saved record has real values.
  const terms = restoreTokensInObject(rawTerms, reverseMap)

  // Re-extraction must not reassign discount_rule_id/credit_rule_id for
  // items that already existed — that would orphan any reviewer-confirmed
  // .interpretation and the commercial_rule_interpretations audit rows that
  // address it by that id. Match by description against whatever this job's
  // prior contract_terms row had (if any) and carry the id + interpretation
  // forward; a genuinely new item still gets a fresh id via
  // assignDiscountRuleIds/assignServiceCreditRuleIds inside extraction.
  if (existingContractTermsId) {
    const { data: priorTerms } = await supabaseServer
      .from('contract_terms')
      .select('discounts, service_credits, one_time_fees')
      .eq('id', existingContractTermsId)
      .maybeSingle()
    if (priorTerms) {
      terms.discounts = preserveStableRuleIds(
        (priorTerms.discounts ?? []) as Discount[], terms.discounts ?? [], 'discount_rule_id',
      )
      terms.service_credits = preserveStableRuleIds(
        (priorTerms.service_credits ?? []) as ServiceCredit[], terms.service_credits ?? [], 'credit_rule_id',
      )
      // Step 13 final amendment — same identity-preservation requirement,
      // for OneTimeFee.fee_id (see lib/rule-id-stability.ts's own comment
      // for the full rationale — this is what keeps operational_event_
      // evidence rows from being silently orphaned by a re-extraction).
      // Must run BEFORE applyExtractionSafetyNets's own normalization
      // inside extractContractTerms already ran — it did, above, on the raw
      // freshly-extracted terms; this preservation pass now retroactively
      // restores the PRIOR fee_id/reviewed-state onto whichever freshly-
      // normalized fee matches by description, so a stable identity is
      // never lost merely because normalizeBillabilityCondition already
      // assigned a new one moments earlier in this same request.
      terms.one_time_fees = preserveOneTimeFeeIdentity(
        (priorTerms.one_time_fees ?? []) as OneTimeFee[], terms.one_time_fees ?? [],
      )
    }
  }

  // Build proposed line items from contract terms
  const lineItems = buildLineItems(terms, currency)

  // Save contract terms — pick only known schema columns explicitly so any
  // novel LLM-extracted field (e.g. ramp_schedule) doesn't break the write.
  // The full raw extraction is stored in raw_extraction for auditability.
  // Upsert on job_id (contract_terms_job_id_unique) rather than insert —
  // contract_terms is one canonical row per job; a plain insert on
  // re-extraction used to silently create a second row, breaking confirm-rule
  // and letting other routes read stale data.
  const { data: savedTerms, error: termsError } = await supabaseServer
    .from('contract_terms')
    .upsert({
      job_id:               jobId,
      // Identity
      contract_id:          terms.contract_id,
      customer_name:        terms.customer_name,
      customer_address:     terms.customer_address,
      billing_contact:      terms.billing_contact,
      vendor_name:          terms.vendor_name,
      vendor_address:       terms.vendor_address,
      // Dates & term
      order_date:           terms.order_date,
      contract_start_date:  terms.contract_start_date,
      contract_end_date:    terms.contract_end_date,
      contract_term_months: terms.contract_term_months,
      auto_renews:          terms.auto_renews,
      renewal_notice_days:  terms.renewal_notice_days,
      // Pricing
      currency:             terms.currency,
      base_monthly_fee:     terms.base_monthly_fee,
      base_annual_fee:      terms.base_annual_fee,
      billing_frequency:    terms.billing_frequency,
      payment_terms_days:   terms.payment_terms_days,
      payment_terms_text:   terms.payment_terms_text,
      included_units:       terms.included_units,
      included_unit_type:   terms.included_unit_type,
      year_pricing:         terms.year_pricing,
      base_fee_proration:   terms.base_fee_proration ?? null,
      ramp_schedule:        terms.ramp_schedule ?? null,
      // Structured arrays
      escalators:                terms.escalators                ?? [],
      discounts:                 terms.discounts                 ?? [],
      service_credits:           terms.service_credits           ?? [],
      overage_tiers:             terms.overage_tiers             ?? [],
      one_time_fees:             terms.one_time_fees             ?? [],
      additional_recurring_fees: terms.additional_recurring_fees ?? [],
      billing_metered_items:     terms.billing_metered_items     ?? [],
      // Metadata
      field_sources:        terms.field_sources ?? {},
      extraction_confidence: terms.extraction_confidence,
      extraction_notes:     terms.extraction_notes,
      number_format:        terms.number_format ?? 'dot',
      // Full LLM output preserved for future fields
      raw_extraction:       terms,
    }, { onConflict: 'job_id' })
    .select('id')
    .single()
  if (termsError) throw new Error(`Failed to save contract terms: ${termsError.message}`)

  // Save line items
  if (lineItems.length > 0) {
    await supabaseServer.from('line_items').insert(
      lineItems.map(item => ({ ...item, job_id: jobId }))
    )
  }

  const needsReview = lineItems.some(i => i.confidence_score < 0.95)

  // currency is included here too, not just on contract_terms —
  // jobs.currency is what the agreement-list pages actually display, and
  // it was otherwise left at its creation-time placeholder ('USD') forever,
  // silently diverging from the real extracted currency on contract_terms.
  // Only overwritten when extraction actually found a currency — never
  // clobber a good prior value with null.
  await supabaseServer.from('jobs').update({
    execute_status: needsReview ? 'PENDING_HUMAN_REVIEW' : 'READY_TO_APPROVE',
    contract_terms_id: savedTerms?.id,
    ...(terms.currency ? { currency: terms.currency } : {}),
  }).eq('id', jobId)
}

function buildLineItems(terms: import('@/lib/types').ContractTerms, currency: string) {
  const items = []
  const cur = terms.currency || currency
  const src = terms.field_sources ?? {}
  const conf = terms.extraction_confidence === 'high' ? 0.97 : terms.extraction_confidence === 'medium' ? 0.82 : 0.62

  // Recurring base fee — one line item per distinct rate block, on the
  // contract's *actual* billing cadence (monthly/quarterly/...), not always
  // bucketed by calendar year regardless of whether the rate changed within
  // it. Rate logic (ramp schedule → year pricing → flat fee, with compound
  // escalation and any dated discount) mirrors computeBillingSchedule
  // (lib/billing-writer.ts) — the same function real billing (Stripe/
  // Remembill) uses to generate actual invoices — so this display can never
  // disagree with what's really charged (previously it ignored discounts
  // entirely, so a contract with an intro discount showed a higher Base TCV
  // than what actually got billed). Consecutive periods at the same rate
  // collapse into one row; a new row starts wherever the rate actually
  // changes (an escalator/ramp step, or a discount window's edge), so a
  // flat-rate contract shows a single "12 × monthly" row instead of one
  // "Year 1" row per calendar year. quantity stays the number of cycles and
  // unit_price the per-cycle rate (not pre-multiplied) — several billing
  // connectors (e.g. Chargebee) read these fields as literal per-cycle
  // subscription quantities, so only total_amount should ever hold the
  // full-term figure. Falls back to a single flat item when contract dates
  // are missing and a schedule can't be computed.
  const contractStart = terms.contract_start_date ? new Date(terms.contract_start_date + 'T00:00:00') : null
  let termMonths = terms.contract_term_months ?? 0
  if (!termMonths && contractStart && terms.contract_end_date) {
    const ce = new Date(terms.contract_end_date + 'T00:00:00')
    termMonths = (ce.getFullYear() - contractStart.getFullYear()) * 12 + (ce.getMonth() - contractStart.getMonth()) + 1
  }
  const hasRecurringBase = !!(terms.base_monthly_fee || terms.base_annual_fee || terms.ramp_schedule?.length || terms.year_pricing)

  if (hasRecurringBase && contractStart && termMonths > 0) {
    const { interval, intervalCount } = billingInterval(terms.billing_frequency)
    const monthsPerPeriod = interval === 'year' ? 12 * intervalCount : intervalCount
    const freq = terms.billing_frequency ?? 'monthly'

    const periodAmounts: number[] = []
    let monthsUsed = 0
    while (monthsUsed < termMonths) {
      const monthsInThisPeriod = Math.min(monthsPerPeriod, termMonths - monthsUsed)
      let amount = 0
      for (let mi = 0; mi < monthsInThisPeriod; mi++) {
        const globalMonthIdx = monthsUsed + mi
        const d = monthCursor(contractStart, globalMonthIdx)
        amount += computeMonthlyBaseRate(terms, globalMonthIdx, d) * computeEscalatorMultiplier(terms, d) * computeDiscountMultiplier(terms, d)
      }
      periodAmounts.push(amount)
      monthsUsed += monthsInThisPeriod
    }

    let i = 0
    while (i < periodAmounts.length) {
      const rate = periodAmounts[i]
      let j = i
      while (j < periodAmounts.length && Math.abs(periodAmounts[j] - rate) < 0.005) j++
      const periodCount = j - i
      if (rate > 0) {
        const rounded = Math.round(rate * 100) / 100
        items.push({
          product_name: periodCount === periodAmounts.length ? 'Recurring base fee' : `Recurring base fee (periods ${i + 1}–${j})`,
          quantity: periodCount,
          unit_price: rounded,
          billing_period: freq,
          total_amount: Math.round(rate * periodCount * 100) / 100,
          currency: cur,
          confidence_score: conf,
          source_section: src.base_monthly_fee ?? src.year_pricing ?? src.ramp_schedule ?? null,
        })
      }
      i = j
    }
  } else if (terms.base_monthly_fee) {
    items.push({
      product_name: 'Base subscription',
      quantity: 1,
      unit_price: terms.base_monthly_fee,
      billing_period: 'monthly',
      total_amount: terms.base_monthly_fee,
      currency: cur,
      confidence_score: conf,
      source_section: src.base_monthly_fee ?? null,
    })
  }

  // Additional recurring fees (e.g. support tier, add-on modules billed
  // separately) — represented the same way as the base fee above: quantity
  // is the number of billing cycles over the term, unit_price the flat
  // per-cycle amount (not escalated — matches the existing display
  // convention), and total_amount their full contribution to TCV.
  for (const fee of terms.additional_recurring_fees ?? []) {
    if (!fee.amount) continue
    const feeFreq = terms.billing_frequency ?? 'monthly'
    const { interval, intervalCount } = billingInterval(feeFreq)
    const feeMonthsPerPeriod = interval === 'year' ? 12 * intervalCount : intervalCount
    const periodCount = termMonths > 0 && feeMonthsPerPeriod > 0 ? Math.ceil(termMonths / feeMonthsPerPeriod) : 1
    items.push({
      product_name: fee.fee_label,
      quantity: periodCount,
      unit_price: fee.amount,
      billing_period: feeFreq,
      total_amount: Math.round(fee.amount * periodCount * 100) / 100,
      currency: cur,
      confidence_score: conf,
      source_section: src.additional_recurring_fees ?? src.base_monthly_fee ?? null,
    })
  }

  for (const tier of terms.overage_tiers ?? []) {
    items.push({
      // tier_label already fully describes the tier per the extraction
      // prompt's own rules (e.g. "SMS reminders 501–2,000" or "... —
      // included in base fee") — appending "— overage" here duplicated that
      // description instead of adding information ("... — overage —
      // overage", "... — included in base fee — overage").
      product_name: tier.tier_label,
      quantity: 0,
      unit_price: tier.rate_per_unit,
      // A tier can be measured/charged on its own cadence, distinct from the
      // contract's overall billing_frequency (e.g. a quarterly-measured
      // metric inside a monthly-invoiced contract) — show that cadence, not
      // a hardcoded 'monthly' that silently disagreed with the contract text.
      billing_period: tier.measurement_period ?? terms.billing_frequency ?? 'monthly',
      total_amount: 0,
      currency: cur,
      // Previously hardcoded to 0.88 regardless of how explicitly the
      // contract stated the rate — an unambiguous per-unit price (e.g.
      // "SEK 195 per chargeback") was flagged "Needs confirmation" purely
      // because 0.88 < the 0.95 review threshold. Use the same
      // extraction-confidence signal as every other line item kind above.
      confidence_score: conf,
      source_section: src.overage_tiers ?? null,
    })
  }

  for (const fee of (terms.one_time_fees ?? []) as Array<typeof terms.one_time_fees[0] & { manual_trigger?: boolean; rate_per_unit?: number | null; metric_name?: string | null }>) {
    const isParked = fee.manual_trigger && fee.amount === 0
    items.push({
      product_name: fee.fee_label,
      quantity: isParked ? 0 : 1,
      unit_price: isParked ? (fee.rate_per_unit ?? 0) : fee.amount,
      billing_period: 'one_time',
      total_amount: fee.amount,
      currency: cur,
      confidence_score: conf,
      source_section: src.one_time_fees ?? null,
    })
  }

  for (const escalator of terms.escalators ?? []) {
    items.push({
      product_name: `Price escalator (${escalator.escalator_pct ?? ''}% ${escalator.escalator_type})`,
      quantity: 1,
      unit_price: 0,
      billing_period: 'annual',
      total_amount: 0,
      currency: cur,
      confidence_score: conf > 0.9 ? 0.94 : 0.72,
      source_section: src.escalators ?? null,
    })
  }

  return items
}

// Build tokenMap/reverseMap from approved PII entities in DB.
// Loads org-level approved library + any entity linked to this job (including manual additions).
// Falls back to auto-detecting if no entities exist yet.
async function buildMaskFromDB(jobId: string, orgId: string, contractText: string) {
  // Entities linked to this specific job (approved or manually added)
  const { data: jobEntities } = await supabaseServer
    .from('job_pii_occurrences')
    .select(`pii_entity:pii_entities(id, original_value, token, approved)`)
    .eq('job_id', jobId)

  // Org-level approved entities not already in this job
  const { data: orgEntities } = await supabaseServer
    .from('pii_entities')
    .select('id, original_value, token, approved')
    .eq('org_id', orgId)
    .eq('approved', true)

  const tokenMap   = new Map<string, string>()
  const reverseMap = new Map<string, string>()

  // Job-level first (includes manual adds, rejected entities excluded at review step)
  for (const row of jobEntities ?? []) {
    // Supabase returns foreign-key joins as an object (not array) when the FK is many-to-one
    const e = (row.pii_entity as unknown) as { original_value: string; token: string; approved: boolean } | null
    if (!e || !e.approved) continue
    tokenMap.set(e.original_value, e.token)
    reverseMap.set(e.token, e.original_value)
  }

  // Org-level approved (add any not already covered)
  for (const e of orgEntities ?? []) {
    if (!tokenMap.has(e.original_value)) {
      tokenMap.set(e.original_value, e.token)
      reverseMap.set(e.token, e.original_value)
    }
  }

  // If no reviewed entities exist, fall back to auto-detection (new job, PII not yet reviewed)
  if (tokenMap.size === 0) {
    const { detectPII } = await import('@/lib/pii-detector')
    const { tokenMap: detected, reverseMap: detectedReverse } = detectPII(contractText)
    return { tokenMap: detected, reverseMap: detectedReverse }
  }

  return { tokenMap, reverseMap }
}

async function extractPDFText(buffer: Buffer, url: string): Promise<string> {
  const pathname = new URL(url).pathname
  return extractDocumentText(
    buffer,
    pathname.endsWith('.pdf'),
    'Extract all text from this contract. Output plain text, preserving section structure and all commercial terms, dates, and amounts.',
  )
}
