import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { deriveGroupReviewState, type PIIEntityType } from '@/lib/pii-detector'

// GET — return all PII entities detected for this job
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let org
  try { org = await requireOrg() } catch (res) { return res as Response }

  const { id } = await params

  // Verify job belongs to org
  const { data: job } = await supabaseServer
    .from('jobs').select('org_id').eq('id', id).single()
  if (!job || job.org_id !== org.orgId)
    return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data, error } = await supabaseServer
    .from('job_pii_occurrences')
    .select(`
      id,
      detection_source,
      confidence_pct,
      pii_entity:pii_entities (
        id, entity_type, original_value, token, approved, ignored, alias_of_entity_id
      )
    `)
    .eq('job_id', id)
    .filter('pii_entity.ignored', 'eq', false)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const occurrences = data ?? []

  // Hardening item 1 (second pass) — surface alias grouping to the review
  // UI via the explicit alias_of_entity_id relationship (not shared
  // tokens — each entity keeps its own token/original_value). Attach each
  // occurrence's alias siblings (org-wide, not just within this job) so
  // the UI can show "Alias: Remembill" under the canonical row and make
  // clear that approving the canonical covers the alias too.
  const { data: orgEntities } = await supabaseServer
    .from('pii_entities')
    .select('id, original_value, alias_of_entity_id')
    .eq('org_id', org.orgId)

  const byId = new Map((orgEntities ?? []).map(e => [e.id, e]))
  const aliasesByCanonicalId = new Map<string, string[]>()
  for (const e of orgEntities ?? []) {
    if (!e.alias_of_entity_id) continue
    const list = aliasesByCanonicalId.get(e.alias_of_entity_id) ?? []
    list.push(e.original_value)
    aliasesByCanonicalId.set(e.alias_of_entity_id, list)
  }

  // Hardening item (review pass 8) — pii_entities.approved is an
  // intentionally org-scoped, reused flag (the same "CoAccept AB" row is
  // shared across every contract that mentions it — see CLAUDE.md), so a
  // canonical approved in an EARLIER job can legitimately differ from an
  // alias just detected for the FIRST time in THIS job, even though
  // masking already treats them as one identity. Never display that raw,
  // possibly-split state — derive it group-consistently from this job's
  // own occurrence set (not a blind org-wide/global inheritance) so the
  // review UI can never show "CoAccept AB: Approved / Remembill: Pending"
  // for the same underlying organisation.
  type OccurrenceEntity = { id: string; alias_of_entity_id: string | null; approved: boolean; ignored: boolean }
  const jobEntities = occurrences
    .map(occ => (occ.pii_entity as unknown) as OccurrenceEntity | null)
    .filter((e): e is OccurrenceEntity => !!e)
  const groupState = deriveGroupReviewState(jobEntities)

  const enriched = occurrences.map(occ => {
    const e = (occ.pii_entity as unknown) as OccurrenceEntity | null
    if (!e) return occ
    const canonical = e.alias_of_entity_id ? byId.get(e.alias_of_entity_id) : null
    const derived = groupState.get(e.id)
    return {
      ...occ,
      pii_entity: {
        ...occ.pii_entity,
        approved: derived?.approved ?? e.approved,
        aliases: canonical ? [] : (aliasesByCanonicalId.get(e.id) ?? []),
        aliasOf: canonical ? canonical.original_value : null,
      },
    }
  })

  return NextResponse.json(enriched)
}

// Step 17A hardening (review pass 5), item 3 — an alias and its canonical
// represent the SAME organisation identity. Masking already treats
// approving either as approving the whole group (see execute/route.ts's
// buildMaskFromDB); this resolves the identical group at the WRITE path so
// the persisted DECISION (approved/rejected/ignored) can never contradict
// itself across the group's rows — "approve CoAccept AB, then reject
// Remembill" must not be a representable state. One-hop only, matching the
// migration's own invariant (20260901000001_pii_entity_alias.sql): the
// group is simply {canonical} ∪ {every row whose alias_of_entity_id is the
// canonical's id}. Distinct tokens/original_value per row are untouched —
// only approved/ignored state is applied group-wide.
async function resolveAliasGroupIds(entityId: string, orgId: string, aliasOfEntityId: string | null): Promise<string[]> {
  const { resolveGroupMemberIds } = await import('@/lib/pii-detector')
  const canonicalId = aliasOfEntityId ?? entityId
  const { data: orgEntities } = await supabaseServer
    .from('pii_entities')
    .select('id, alias_of_entity_id')
    .eq('org_id', orgId)
  const ids = resolveGroupMemberIds(canonicalId, orgEntities ?? [])
  return ids.length > 0 ? ids : [entityId]
}

// PATCH — approve, reject, or update an entity for this job
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let org
  try { org = await requireOrg() } catch (res) { return res as Response }

  const { id } = await params
  const body = await req.json()
  const { action, entityId } = body as { action: 'approve' | 'reject' | 'ignore'; entityId: string }

  // Verify entity belongs to this org
  const { data: entity } = await supabaseServer
    .from('pii_entities').select('org_id, alias_of_entity_id').eq('id', entityId).single()
  if (!entity || entity.org_id !== org.orgId)
    return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const groupIds = await resolveAliasGroupIds(entityId, org.orgId, entity.alias_of_entity_id)

  if (action === 'approve') {
    await supabaseServer
      .from('pii_entities')
      .update({ approved: true, updated_at: new Date().toISOString() })
      .in('id', groupIds)
  } else if (action === 'reject') {
    // Remove from this job only; entities stay in the library with
    // approved=false for future review — group-wide, so a reviewer can
    // never leave one member of the identity approved and the other still
    // pending/exposed within this same job.
    await supabaseServer
      .from('job_pii_occurrences')
      .delete()
      .eq('job_id', id)
      .in('pii_entity_id', groupIds)
  } else if (action === 'ignore') {
    // Permanently whitelist: mark ignored=true so detect-pii never surfaces it again
    await supabaseServer
      .from('pii_entities')
      .update({ approved: false, ignored: true, updated_at: new Date().toISOString() })
      .in('id', groupIds)
    await supabaseServer
      .from('job_pii_occurrences')
      .delete()
      .eq('job_id', id)
      .in('pii_entity_id', groupIds)
  }

  return NextResponse.json({ ok: true })
}

// POST — manually add a PII entity for this job
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let org
  try { org = await requireOrg() } catch (res) { return res as Response }

  const { id } = await params
  const body = await req.json()
  const { entity_type, original_value } = body as { entity_type: PIIEntityType; original_value: string }

  if (!entity_type || !original_value?.trim())
    return NextResponse.json({ error: 'entity_type and original_value required' }, { status: 400 })

  // Generate a token for the new entity
  const { count } = await supabaseServer
    .from('pii_entities')
    .select('*', { count: 'exact', head: true })
    .eq('org_id', org.orgId)
    .eq('entity_type', entity_type)

  const token = `[${entity_type}_${(count ?? 0) + 1}]`

  const { data: saved, error } = await supabaseServer
    .from('pii_entities')
    .upsert(
      {
        org_id:         org.orgId,
        entity_type,
        original_value: original_value.trim(),
        token,
        approved:       true, // manually added = auto-approved
        source_job_id:  id,
        updated_at:     new Date().toISOString(),
      },
      { onConflict: 'org_id,original_value', ignoreDuplicates: false }
    )
    .select('id, entity_type, original_value, token, approved')
    .single()

  if (error || !saved) return NextResponse.json({ error: error?.message ?? 'Failed' }, { status: 500 })

  await supabaseServer
    .from('job_pii_occurrences')
    .upsert(
      {
        job_id:           id,
        pii_entity_id:    saved.id,
        detection_source: 'manual',
        confidence_pct:   100,
        was_masked:       false,
      },
      { onConflict: 'job_id,pii_entity_id', ignoreDuplicates: true }
    )

  return NextResponse.json(saved)
}
