import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { extractContractTerms } from '@/lib/contract-extractor'
import { resolveStorageUrl } from '@/lib/storage'
import { maskText, restoreTokensInObject } from '@/lib/pii-detector'
import { buildLineItems } from '@/lib/line-items'
import { extractDocumentText, isAIInfraError, AI_INFRA_ERROR_PREFIX } from '@/lib/ai-client'
import { preserveStableRuleIds, preserveOneTimeFeeIdentity } from '@/lib/rule-id-stability'
import type { Discount, ServiceCredit, OneTimeFee } from '@/lib/types'


// runExecutePipeline's real worst case is two AI-client tiers stacked
// sequentially, not one: when pending_extracted_text is absent (every
// retry of a job whose first attempt already consumed and nulled it — see
// runExecutePipeline below — plus any job that never went through
// detect-pii's PII-review step), this route falls back to re-downloading
// and re-running document extraction itself
// (AI_DOCUMENT_EXTRACTION_TIMEOUT_MS: 170s x 1 attempt) before
// extractContractTerms's own worst case (AI_CLIENT_TIMEOUT_MS: 60s x up to
// 3 attempts = 180s) even starts — 350s combined. The previous 300s budget
// only ever covered the second half; a route killed by the PLATFORM before
// its own .catch() below can run never gets to write
// execute_status: 'FAILED', leaving the job stuck at 'EXTRACTING' forever
// with no error surfaced —
// the exact failure mode already documented and fixed once for
// detect-pii/route.ts (same reasoning, same >=30s headroom convention).
export const maxDuration = 380

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

  // Atomic claim — a second POST while extraction is already in flight (an
  // accidental double-click, a race between two tabs, a Retry fired twice)
  // must not launch a second concurrent runExecutePipeline for the same
  // job: two background pipelines racing on the same contract_terms upsert
  // and the same pending_extracted_text handoff could corrupt both. The
  // conditional .neq guard plus an empty-result check makes the claim
  // atomic — no separate read-then-write race window.
  const { data: claimed } = await supabaseServer
    .from('jobs')
    .update({ execute_status: 'EXTRACTING' })
    .eq('id', id)
    .eq('org_id', org.orgId)
    .neq('execute_status', 'EXTRACTING')
    .select('id')

  if (!claimed || claimed.length === 0) {
    return NextResponse.json({ error: 'Extraction is already in progress for this job.' }, { status: 409 })
  }

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

// Build tokenMap/reverseMap from approved PII entities in DB.
// Loads org-level approved library + any entity linked to this job (including manual additions).
// Falls back to auto-detecting if no entities exist yet.
//
// Hardening item 1 (second pass) — a canonical organisation and its
// alias(es) are DISTINCT entities with DISTINCT tokens, linked via
// pii_entities.alias_of_entity_id (see migration
// 20260901000001_pii_entity_alias.sql), never a shared token. Each
// entity's OWN token is what goes into tokenMap, and reverseMap is a
// plain, unambiguous token -> original_value mapping per entity, so
// restoration always recovers the EXACT original source string (e.g. a
// clause that actually said "Remembill" restores to "Remembill", never to
// "CoAccept AB").
//
// Hardening item 2 (review pass 3) — approval is GROUP-CONSISTENT in both
// directions: approving the canonical masks its alias(es) (as before), and
// approving an alias directly ALSO masks its canonical, because both rows
// represent the same real-world organisation identity — never leave one
// exposed because the reviewer happened to approve the other one. Uses
// lib/pii-detector.ts's aliasGroupRoot (one-hop grouping) so this is a
// single, symmetric containment check rather than two separate directional
// branches.
//
// NOTE — deployment ordering: alias_of_entity_id does not exist until
// migration 20260901000001_pii_entity_alias.sql is applied (deliberately
// left unapplied this session); this function will fail against the
// current live schema until it is.
async function buildMaskFromDB(jobId: string, orgId: string, contractText: string) {
  // Entities linked to this specific job (approved or manually added)
  const { data: jobEntities } = await supabaseServer
    .from('job_pii_occurrences')
    .select(`pii_entity:pii_entities(id, original_value, token, approved, alias_of_entity_id)`)
    .eq('job_id', jobId)

  // Org-level approved entities not already in this job
  const { data: orgEntities } = await supabaseServer
    .from('pii_entities')
    .select('id, original_value, token, approved, alias_of_entity_id')
    .eq('org_id', orgId)
    .eq('approved', true)

  type EntityRow = { id: string; original_value: string; token: string; approved: boolean; alias_of_entity_id: string | null }
  const approvedIds = new Set<string>()
  for (const row of jobEntities ?? []) {
    // Supabase returns foreign-key joins as an object (not array) when the FK is many-to-one
    const e = (row.pii_entity as unknown) as EntityRow | null
    if (e?.approved) approvedIds.add(e.id)
  }
  for (const e of (orgEntities as EntityRow[] | null) ?? []) approvedIds.add(e.id)

  const tokenMap   = new Map<string, string>()
  const reverseMap = new Map<string, string>()

  if (approvedIds.size > 0) {
    const { aliasGroupRoot } = await import('@/lib/pii-detector')
    // Full org entity set (not filtered by approved) so the whole alias
    // group gets included in the mask even when only one member — canonical
    // OR alias — was independently approved.
    const { data: allOrgEntities } = await supabaseServer
      .from('pii_entities')
      .select('id, original_value, token, alias_of_entity_id')
      .eq('org_id', orgId)

    const entities = (allOrgEntities as Pick<EntityRow, 'id' | 'original_value' | 'token' | 'alias_of_entity_id'>[] | null) ?? []
    const rootById = new Map(entities.map(e => [e.id, aliasGroupRoot(e)]))
    const approvedRoots = new Set<string>()
    for (const id of approvedIds) {
      const root = rootById.get(id) ?? id // approved entity outside this select (shouldn't happen, same org) still counts as its own root
      approvedRoots.add(root)
    }

    for (const e of entities) {
      if (!approvedRoots.has(aliasGroupRoot(e))) continue
      // Each entity keeps its own token/original_value pair — no grouping
      // at the token level, so restoration is always exact.
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
