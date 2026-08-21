/**
 * POST /api/org/rulebook/[id]/discard
 *
 * Discards a never-activated draft — e.g. a promoted draft the admin
 * decides not to pursue, or the "Cancel" action on the overlap-conflict
 * screen (item 8). Restricted to status = 'draft' at the service layer
 * (discardDraftOrganizationRule) — an ACTIVE rule can only ever be retired
 * through the atomic supersession/activation path, never through this
 * route, so a real, historically-resolving policy can never be silently
 * removed from matching here.
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireOrg } from '@/lib/org'
import { discardDraftOrganizationRule } from '@/lib/rulebook/organization-rules-service'

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }
  const { id } = await params

  try {
    await discardDraftOrganizationRule(org.orgId, id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed to discard draft' }, { status: 400 })
  }
}
