import { NextRequest, NextResponse } from 'next/server'
import { requireOrg } from '@/lib/org'
import { supabaseServer } from '@/lib/supabase'

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ email: string }> }
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { email } = await params
  const decoded = decodeURIComponent(email)

  // Cannot remove yourself if you're the only owner
  if (decoded === org.userEmail && org.role === 'owner') {
    const { data: owners } = await supabaseServer
      .from('org_memberships')
      .select('id')
      .eq('org_id', org.orgId)
      .eq('role', 'owner')
      .eq('status', 'active')
    if ((owners?.length ?? 0) <= 1) {
      return NextResponse.json({ error: 'Cannot remove the only owner' }, { status: 400 })
    }
  }

  const { error } = await supabaseServer
    .from('org_memberships')
    .delete()
    .eq('org_id', org.orgId)
    .eq('user_email', decoded)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ email: string }> }
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { email } = await params
  const decoded = decodeURIComponent(email)
  const { role } = await req.json()

  if (!['admin', 'member'].includes(role))
    return NextResponse.json({ error: 'Invalid role' }, { status: 400 })

  const { error } = await supabaseServer
    .from('org_memberships')
    .update({ role })
    .eq('org_id', org.orgId)
    .eq('user_email', decoded)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
