/**
 * GET    /api/org/rulebook/[id]  — single rule detail (Step 5D item 11's
 *                                   "View policy" flow).
 * PATCH  /api/org/rulebook/[id]  — cosmetic-only edit (description). Never
 *                                   accepts target_field/value/match
 *                                   conditions/status/version — a semantic
 *                                   change must go through /supersede
 *                                   instead (item 9).
 *
 * Security (item 13): [id] is a client-supplied path segment, but it is
 * NEVER trusted as proof of ownership — getOrganizationRule/
 * updateOrganizationRuleDescription both filter by requireOrg()'s trusted
 * org.orgId, so a ruleId belonging to another organization simply returns
 * "not found", never that organization's data.
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireOrg } from '@/lib/org'
import { getOrganizationRule, updateOrganizationRuleDescription } from '@/lib/rulebook/organization-rules-service'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }
  const { id } = await params

  const rule = await getOrganizationRule(org.orgId, id)
  if (!rule) return NextResponse.json({ error: 'Rule not found' }, { status: 404 })
  return NextResponse.json({ rule })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }
  const { id } = await params

  const body = await req.json() as { description?: string | null }
  if (body.description === undefined) {
    return NextResponse.json({ error: 'description is required' }, { status: 400 })
  }

  try {
    const rule = await updateOrganizationRuleDescription(org.orgId, id, body.description)
    return NextResponse.json({ rule })
  } catch {
    return NextResponse.json({ error: 'Rule not found' }, { status: 404 })
  }
}
