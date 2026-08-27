import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { resolveStorageUrl } from '@/lib/storage'
import { extractDocumentText, isAIInfraError, AI_INFRA_ERROR_PREFIX } from '@/lib/ai-client'
import { isAdminEmail } from '@/lib/admin'
import type { PIIEntity } from '@/lib/pii-detector'

const GENERIC_INFRA_ERROR = 'This contract couldn’t be processed right now due to a temporary system issue. Please contact bilal@lynoraai.com for help.'

// 120s was too tight: extractDocumentText's underlying client had a real
// worst case of 60s per attempt x up to 3 attempts (1 + 2 retries) = 180s,
// before this route's own PDF download / local PII detection / DB writes
// were even counted. A route killed by the PLATFORM at 120s never reaches
// this file's own try/catch, so no error_message is ever written — the job
// is left stuck in 'DETECTING_PII' forever and the caller only sees a raw
// platform timeout, not a real error (confirmed live: two production jobs
// got stuck exactly this way).
//
// extractDocumentText now uses its own dedicated document-extraction tier
// (lib/ai-client.ts's AI_DOCUMENT_EXTRACTION_TIMEOUT_MS: 170s x 1 attempt,
// no retries — a second production incident confirmed even 60s x 3 wasn't
// enough for a legitimately slow non-streaming Bedrock response, and
// retrying at the same timeout only repeats the same failure). 200s here
// still gives >=30s of headroom over that 170s worst case, same reasoning
// as execute/route.ts's 300s and audit/route.ts's 290s budgets for their
// own AI-client worst cases.
export const maxDuration = 200

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

    // Step 17A, item 6 — a real, separately-observable phase transition:
    // the slow Bedrock-backed extraction above has genuinely finished and
    // the fast, local, non-AI PII pass is about to start. The upload page
    // polls GET /api/jobs/[id] and maps this exact value to its
    // "Checking sensitive information" stage — never inferred client-side
    // from timing/fetch-call boundaries.
    await supabaseServer.from('jobs').update({ execute_status: 'CHECKING_PII' }).eq('id', id)

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
  // Item 3 (and hardening item 1, second pass) — detectPII() always emits
  // a canonical org's alias entities AFTER the canonical entity itself in
  // the same array (see lib/pii-detector.ts's Pass 5), so this map is
  // always populated with the canonical's real, persisted DB id by the
  // time an alias is processed. Each entity keeps its OWN token (see
  // lib/pii-detector.ts's addEntity) — the alias relationship is tracked
  // separately via pii_entities.alias_of_entity_id (see migration
  // 20260901000001_pii_entity_alias.sql), never by sharing a token.
  //
  // NOTE — deployment ordering: this column does not exist until that
  // migration is applied (deliberately left unapplied this session). This
  // route will fail against the current live schema until it is. Per
  // instruction, the migration must be applied BEFORE this code is
  // deployed; nothing here is committed/deployed this session.
  const dbIdByValue = new Map<string, string>()

  for (const entity of entities) {
    // If the entity already exists (e.g. approved from a previous contract), leave it untouched.
    const { data: existing } = await supabaseServer
      .from('pii_entities')
      .select('id, entity_type, original_value, token, approved, ignored, alias_of_entity_id')
      .eq('org_id', orgId)
      .eq('original_value', entity.value)
      .maybeSingle()

    // Skip entities the user has permanently whitelisted as not-PII
    if (existing?.ignored) continue

    // Best-effort resolution of the canonical entity's real DB id — an
    // alias whose canonical org this run never actually persisted (e.g. it
    // was itself skipped as ignored) simply has no association, never an
    // invented/guessed one.
    //
    // Hardening item 3 (review pass 3) — application-layer defense in
    // depth alongside the DB trigger (enforce_pii_entity_alias_integrity,
    // migration 20260901000001_pii_entity_alias.sql): org_id can't
    // actually mismatch here (every insert in this function uses the same
    // `orgId` parameter — there's no code path within a single
    // savePIIEntities call that could construct a cross-org link), but
    // entity_type is independently re-checked against the in-memory
    // detection result rather than assumed, so a future change to Pass 5's
    // alias-detection logic that ever paired a non-ORG alias with an ORG
    // canonical (or vice versa) fails loudly here instead of silently
    // relying on the DB trigger to catch it first.
    const canonicalEntity = entity.aliasOf ? entities.find(e => e.value === entity.aliasOf) : undefined
    const aliasOfEntityId = (entity.aliasOf && canonicalEntity?.type === entity.type)
      ? dbIdByValue.get(entity.aliasOf) ?? null
      : null

    let saved = existing
    if (!existing) {
      // Generate a globally unique token for this org + entity type. Every
      // entity — canonical or alias — gets its OWN token; detectPII()
      // resets its counter per run, so its token numbers can clash across
      // contracts, hence recomputing from the org-level count here.
      const { count } = await supabaseServer
        .from('pii_entities')
        .select('*', { count: 'exact', head: true })
        .eq('org_id', orgId)
        .eq('entity_type', entity.type)
      const token = `[${entity.type}_${(count ?? 0) + 1}]`

      const { data: inserted } = await supabaseServer
        .from('pii_entities')
        .insert({
          org_id:             orgId,
          entity_type:        entity.type,
          original_value:     entity.value,
          token,
          approved:           false,
          source_job_id:      jobId,
          alias_of_entity_id: aliasOfEntityId,
        })
        .select('id, entity_type, original_value, token, approved, ignored, alias_of_entity_id')
        .single()
      saved = inserted
    } else if (aliasOfEntityId && !existing.alias_of_entity_id) {
      // A previously-detected entity newly recognized as an alias (e.g.
      // the alias-detection pattern is new as of this pass) — backfill the
      // association without touching anything else about the row
      // (approval state, and crucially its OWN token, preserved).
      const { data: updated } = await supabaseServer
        .from('pii_entities')
        .update({ alias_of_entity_id: aliasOfEntityId })
        .eq('id', existing.id)
        .select('id, entity_type, original_value, token, approved, ignored, alias_of_entity_id')
        .single()
      saved = updated ?? existing
    }

    if (!saved) continue
    dbIdByValue.set(entity.value, saved.id)
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

  // Step 17A hardening (review pass 8) — self-heal group approved/ignored
  // consistency in the DB itself, not just at display time (see the GET
  // handler's own group derivation, app/api/jobs/[id]/pii/route.ts).
  // pii_entities.approved/ignored are intentionally org-scoped, REUSED
  // flags (the same "CoAccept AB" row is shared across every contract
  // that mentions it — see CLAUDE.md) — so a canonical already approved
  // from an EARLIER job and an alias newly discovered in THIS job's
  // document can otherwise persist as a split state indefinitely. Reuses
  // the exact same group-resolution/derivation helpers the PATCH route
  // already uses for explicit reviewer actions — never a new, separate
  // merge rule.
  if (results.length > 0) {
    const { resolveGroupMemberIds, deriveGroupReviewState } = await import('@/lib/pii-detector')
    const { data: allOrgEntities } = await supabaseServer
      .from('pii_entities')
      .select('id, alias_of_entity_id, approved, ignored')
      .eq('org_id', orgId)
    const orgEntities = allOrgEntities ?? []
    const touchedIds = new Set(results.map(r => r.id))
    const processedRoots = new Set<string>()
    for (const row of orgEntities) {
      if (!touchedIds.has(row.id)) continue
      const root = row.alias_of_entity_id ?? row.id
      if (processedRoots.has(root)) continue
      processedRoots.add(root)
      const groupIds = resolveGroupMemberIds(root, orgEntities)
      if (groupIds.length < 2) continue // no group to sync
      const groupRows = orgEntities.filter(e => groupIds.includes(e.id))
      const derived = deriveGroupReviewState(groupRows)
      for (const memberId of groupIds) {
        const target = derived.get(memberId)
        const current = orgEntities.find(e => e.id === memberId)
        if (!target || !current) continue
        if (current.approved !== target.approved || current.ignored !== target.ignored) {
          await supabaseServer
            .from('pii_entities')
            .update({ approved: target.approved, ignored: target.ignored, updated_at: new Date().toISOString() })
            .eq('id', memberId)
        }
      }
    }
  }

  return results
}
