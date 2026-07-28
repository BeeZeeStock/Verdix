import { NextRequest, NextResponse } from 'next/server'
import { getActiveOrg, requireOrg } from '@/lib/org'
import { supabaseServer } from '@/lib/supabase'

export async function GET() {
  const org = await getActiveOrg()
  if (!org) return NextResponse.json({ error: 'No organization — check server logs' }, { status: 401 })

  const [{ data: members }, { data: orgRow }] = await Promise.all([
    supabaseServer
      .from('org_memberships')
      .select('id, user_email, role, status, created_at')
      .eq('org_id', org.orgId)
      .order('created_at', { ascending: true }),
    supabaseServer
      .from('organizations')
      .select('allowed_domain')
      .eq('id', org.orgId)
      .single(),
  ])

  return NextResponse.json({
    orgId: org.orgId,
    orgName: org.orgName,
    orgSlug: org.orgSlug,
    role: org.role,
    allowedDomain: orgRow?.allowed_domain ?? null,
    members: members ?? [],
  })
}

export async function PATCH(req: NextRequest) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const body = await req.json()
  const updates: Record<string, unknown> = {}

  if (body.name !== undefined) {
    if (!body.name?.trim()) return NextResponse.json({ error: 'Name is required' }, { status: 400 })
    updates.name = body.name.trim()
  }

  if (body.allowedDomain !== undefined) {
    const domain = body.allowedDomain?.trim().toLowerCase() || null
    if (domain && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z]{2,})+$/.test(domain)) {
      return NextResponse.json({ error: 'Invalid domain format' }, { status: 400 })
    }
    updates.allowed_domain = domain
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }

  const { error } = await supabaseServer
    .from('organizations')
    .update(updates)
    .eq('id', org.orgId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
