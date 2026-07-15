import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import type { PIIEntityType } from '@/lib/pii-detector'

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
        id, entity_type, original_value, token, approved, ignored
      )
    `)
    .eq('job_id', id)
    .filter('pii_entity.ignored', 'eq', false)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data ?? [])
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
    .from('pii_entities').select('org_id').eq('id', entityId).single()
  if (!entity || entity.org_id !== org.orgId)
    return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (action === 'approve') {
    await supabaseServer
      .from('pii_entities')
      .update({ approved: true, updated_at: new Date().toISOString() })
      .eq('id', entityId)
  } else if (action === 'reject') {
    // Remove from this job only; entity stays in library with approved=false for future review
    await supabaseServer
      .from('job_pii_occurrences')
      .delete()
      .eq('job_id', id)
      .eq('pii_entity_id', entityId)
  } else if (action === 'ignore') {
    // Permanently whitelist: mark ignored=true so detect-pii never surfaces it again
    await supabaseServer
      .from('pii_entities')
      .update({ approved: false, ignored: true, updated_at: new Date().toISOString() })
      .eq('id', entityId)
    await supabaseServer
      .from('job_pii_occurrences')
      .delete()
      .eq('job_id', id)
      .eq('pii_entity_id', entityId)
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
