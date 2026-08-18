import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { resolveStorageUrl } from '@/lib/storage'
import { extractDocumentText, isAIInfraError, AI_INFRA_ERROR_PREFIX } from '@/lib/ai-client'
import { isAdminEmail } from '@/lib/admin'
import type { PIIEntity } from '@/lib/pii-detector'

const GENERIC_INFRA_ERROR = 'This contract couldn’t be processed right now due to a temporary system issue. Please contact bilal@lynoraai.com for help.'

export const maxDuration = 120

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let org
  try { org = await requireOrg() } catch (res) { return res as Response }

  const { id } = await params

  const { data: job, error: jobError } = await supabaseServer
    .from('jobs')
    .select('id, contract_pdf_url, org_id')
    .eq('id', id)
    .eq('org_id', org.orgId)
    .single()

  if (jobError || !job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  if (!job.contract_pdf_url) return NextResponse.json({ error: 'No contract file uploaded' }, { status: 400 })

  // PII masking is a baseline security control for every org — no plan gate.
  await supabaseServer.from('jobs').update({ execute_status: 'DETECTING_PII' }).eq('id', id)

  try {
    // Extract text from PDF
    const resolvedUrl = await resolveStorageUrl(job.contract_pdf_url)
    const res = await fetch(resolvedUrl)
    if (!res.ok) throw new Error('Failed to download contract')
    const buffer = Buffer.from(await res.arrayBuffer())

    const contractText = await extractPDFText(buffer, resolvedUrl)

    // Hand off the extracted text to execute/route.ts so it doesn't pay for
    // a second identical Bedrock call re-extracting the same PDF. Cleared
    // once execute consumes it (or by the retention cron / job deletion if
    // it never gets consumed) — a short-lived pipeline handoff, not a second
    // permanent store of raw unmasked contract text.
    await supabaseServer.from('jobs').update({ pending_extracted_text: contractText }).eq('id', id)

    // Run local PII detection (dynamic import keeps compromise out of module init)
    const { detectPII } = await import('@/lib/pii-detector')
    const { entities } = detectPII(contractText)

    // Save to DB and collect saved records
    const saved = await savePIIEntities(id, org.orgId, entities)

    await supabaseServer.from('jobs').update({ execute_status: 'PENDING_PII_REVIEW' }).eq('id', id)

    return NextResponse.json({ entities: saved })
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err)
    const isInfra = isAIInfraError(err)
    // Same reasoning as execute/route.ts: an AI-infra failure (out of
    // Anthropic credit, rate-limited, timed out) is an admin problem, not
    // something the caller can act on — store the real detail prefixed for
    // admins, but never hand it back in the immediate response to a
    // non-admin caller either.
    await supabaseServer.from('jobs').update({
      execute_status: 'FAILED',
      error_message: isInfra ? `${AI_INFRA_ERROR_PREFIX}${rawMessage}` : rawMessage,
    }).eq('id', id)
    const responseMessage = isInfra && !isAdminEmail(org.userEmail) ? GENERIC_INFRA_ERROR : rawMessage
    return NextResponse.json({ error: responseMessage }, { status: 500 })
  }
}

async function extractPDFText(buffer: Buffer, url: string): Promise<string> {
  const pathname = new URL(url).pathname
  return extractDocumentText(
    buffer,
    pathname.endsWith('.pdf'),
    'Extract all text from this contract. Output plain text, preserving section structure and all commercial terms, dates, and amounts.',
  )
}

async function savePIIEntities(jobId: string, orgId: string, entities: PIIEntity[]) {
  const results = []

  for (const entity of entities) {
    // If the entity already exists (e.g. approved from a previous contract), leave it untouched.
    // ignoreDuplicates: true skips the upsert on conflict, preserving the existing approved state.
    const { data: existing } = await supabaseServer
      .from('pii_entities')
      .select('id, entity_type, original_value, token, approved, ignored')
      .eq('org_id', orgId)
      .eq('original_value', entity.value)
      .maybeSingle()

    // Skip entities the user has permanently whitelisted as not-PII
    if (existing?.ignored) continue

    let saved = existing
    if (!existing) {
      // Generate a globally unique token for this org + entity type.
      // detectPII() resets its counter per run, so its token numbers can clash
      // across contracts. Count existing org-level entities of this type instead.
      const { count } = await supabaseServer
        .from('pii_entities')
        .select('*', { count: 'exact', head: true })
        .eq('org_id', orgId)
        .eq('entity_type', entity.type)
      const token = `[${entity.type}_${(count ?? 0) + 1}]`

      const { data: inserted } = await supabaseServer
        .from('pii_entities')
        .insert({
          org_id:         orgId,
          entity_type:    entity.type,
          original_value: entity.value,
          token,
          approved:       false,
          source_job_id:  jobId,
        })
        .select('id, entity_type, original_value, token, approved, ignored')
        .single()
      saved = inserted
    }

    if (!saved) continue
    results.push({ ...saved, confidence: entity.confidence, source: entity.source })

    await supabaseServer
      .from('job_pii_occurrences')
      .upsert(
        {
          job_id:           jobId,
          pii_entity_id:    saved.id,
          detection_source: entity.source,
          confidence_pct:   entity.confidence,
          was_masked:       false, // not yet masked — pending review
        },
        { onConflict: 'job_id,pii_entity_id', ignoreDuplicates: true }
      )
  }

  return results
}
