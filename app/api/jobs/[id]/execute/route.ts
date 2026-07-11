import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { extractContractTerms } from '@/lib/contract-extractor'
import { resolveStorageUrl } from '@/lib/storage'

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let org
  try { org = await requireOrg() } catch (res) { return res as Response }

  const { id } = await params

  const { data: job, error: jobError } = await supabaseServer
    .from('jobs')
    .select('id, name, currency, contract_pdf_url')
    .eq('id', id)
    .eq('org_id', org.orgId)
    .single()

  if (jobError || !job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  await supabaseServer.from('jobs').update({ execute_status: 'EXTRACTING' }).eq('id', id)

  runExecutePipeline(id, job.contract_pdf_url, job.currency).catch(async (err) => {
    await supabaseServer.from('jobs').update({
      execute_status: 'FAILED',
      error_message: err instanceof Error ? err.message : String(err),
    }).eq('id', id)
  })

  return NextResponse.json({ jobId: id, status: 'EXTRACTING' })
}

async function runExecutePipeline(jobId: string, contractUrl: string | null, currency: string) {
  if (!contractUrl) throw new Error('Missing contract file')

  const resolvedUrl = await resolveStorageUrl(contractUrl)
  const res = await fetch(resolvedUrl)
  if (!res.ok) throw new Error(`Failed to download contract`)
  const buffer = Buffer.from(await res.arrayBuffer())

  const contractText = await extractPDFText(buffer, resolvedUrl)
  const terms = await extractContractTerms(contractText)

  // Build proposed line items from contract terms
  const lineItems = buildLineItems(terms, currency)

  // Save contract terms — pick only known schema columns explicitly so any
  // novel LLM-extracted field (e.g. ramp_schedule) doesn't break the insert.
  // The full raw extraction is stored in raw_extraction for auditability.
  const { data: savedTerms, error: termsError } = await supabaseServer
    .from('contract_terms')
    .insert({
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
      // Structured arrays
      escalators:           terms.escalators   ?? [],
      discounts:            terms.discounts    ?? [],
      overage_tiers:        terms.overage_tiers ?? [],
      one_time_fees:        terms.one_time_fees ?? [],
      // Metadata
      field_sources:        terms.field_sources ?? {},
      extraction_confidence: terms.extraction_confidence,
      extraction_notes:     terms.extraction_notes,
      // Full LLM output preserved for future fields
      raw_extraction:       terms,
    })
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

  await supabaseServer.from('jobs').update({
    execute_status: needsReview ? 'PENDING_HUMAN_REVIEW' : 'READY_TO_APPROVE',
    contract_terms_id: savedTerms?.id,
  }).eq('id', jobId)
}

function buildLineItems(terms: import('@/lib/types').ContractTerms, currency: string) {
  const items = []
  const cur = terms.currency || currency
  const src = terms.field_sources ?? {}
  const conf = terms.extraction_confidence === 'high' ? 0.97 : terms.extraction_confidence === 'medium' ? 0.82 : 0.62

  if (terms.base_monthly_fee) {
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

  if (terms.year_pricing) {
    Object.entries(terms.year_pricing).forEach(([year, price]) => {
      items.push({
        product_name: `${year} pricing`,
        quantity: 1,
        unit_price: price,
        billing_period: 'annual',
        total_amount: price,
        currency: cur,
        confidence_score: 0.95,
        source_section: src.year_pricing ?? src.base_monthly_fee ?? null,
      })
    })
  }

  for (const tier of terms.overage_tiers ?? []) {
    items.push({
      product_name: `${tier.tier_label} — overage`,
      quantity: 0,
      unit_price: tier.rate_per_unit,
      billing_period: 'monthly',
      total_amount: 0,
      currency: cur,
      confidence_score: 0.88,
      source_section: src.overage_tiers ?? null,
    })
  }

  for (const fee of terms.one_time_fees ?? []) {
    items.push({
      product_name: fee.fee_label,
      quantity: 1,
      unit_price: fee.amount,
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

async function extractPDFText(buffer: Buffer, url: string): Promise<string> {
  const pathname = new URL(url).pathname
  if (pathname.endsWith('.pdf')) {
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    const client = new Anthropic()
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      messages: [{
        role: 'user',
        content: [{
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') },
        }, {
          type: 'text',
          text: 'Extract all text from this contract. Output plain text, preserving section structure and all commercial terms, dates, and amounts.',
        }],
      }],
    })
    const c = response.content[0]
    return c.type === 'text' ? c.text : ''
  }
  return buffer.toString('utf-8')
}
