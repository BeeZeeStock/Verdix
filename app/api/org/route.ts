import { NextRequest, NextResponse } from 'next/server'
import { getActiveOrg, requireOrg } from '@/lib/org'
import { supabaseServer } from '@/lib/supabase'

export async function GET() {
  const org = await getActiveOrg()
  if (!org) return NextResponse.json({ error: 'No organization — check server logs' }, { status: 401 })

  const { data: members } = await supabaseServer
    .from('org_memberships')
    .select('id, user_email, role, status, created_at')
    .eq('org_id', org.orgId)
    .order('created_at', { ascending: true })

  return NextResponse.json({
    orgId: org.orgId,
    orgName: org.orgName,
    orgSlug: org.orgSlug,
    role: org.role,
    members: members ?? [],
  })
}

export async function PATCH(req: NextRequest) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { name } = await req.json()
  if (!name?.trim()) return NextResponse.json({ error: 'Name is required' }, { status: 400 })

  const { error } = await supabaseServer
    .from('organizations')
    .update({ name: name.trim() })
    .eq('id', org.orgId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
