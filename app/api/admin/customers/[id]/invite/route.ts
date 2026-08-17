import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin'
import { supabaseServer } from '@/lib/supabase'
import { type OrgRole } from '@/lib/org'
import { provisionAndInviteUser } from '@/lib/invite'

async function getOrgName(orgId: string): Promise<string | null> {
  const { data } = await supabaseServer.from('organizations').select('name').eq('id', orgId).maybeSingle()
  return data?.name ?? null
}

// POST /api/admin/customers/[id]/invite — invite a user into an existing org
// (also used as "resend": same body, upsert + fresh link supersede any stale one)
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: orgId } = await params
  let adminEmail: string
  try { adminEmail = await requireAdmin() } catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }

  const { email, role = 'member' } = await req.json() as { email: string; role?: OrgRole }
  if (!email?.trim()) return NextResponse.json({ error: 'Email is required' }, { status: 400 })
  if (!['owner', 'admin', 'member'].includes(role)) return NextResponse.json({ error: 'Invalid role' }, { status: 400 })

  const orgName = await getOrgName(orgId)
  if (!orgName) return NextResponse.json({ error: 'Organization not found' }, { status: 404 })

  try {
    const result = await provisionAndInviteUser({ orgId, orgName, email, role, invitedByEmail: adminEmail })
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed to invite user' }, { status: 500 })
  }
}

// PATCH /api/admin/customers/[id]/invite — change role or disable/re-enable a member
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: orgId } = await params
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }

  const { email, role, status } = await req.json() as { email: string; role?: OrgRole; status?: 'active' | 'disabled' }
  if (!email?.trim()) return NextResponse.json({ error: 'Email is required' }, { status: 400 })

  const update: Record<string, unknown> = {}
  if (role) {
    if (!['owner', 'admin', 'member'].includes(role)) return NextResponse.json({ error: 'Invalid role' }, { status: 400 })
    update.role = role
  }
  if (status) {
    if (!['active', 'disabled'].includes(status)) return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
    update.status = status
  }
  if (Object.keys(update).length === 0) return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })

  const { error } = await supabaseServer
    .from('org_memberships')
    .update(update)
    .eq('org_id', orgId)
    .eq('user_email', email.toLowerCase().trim())

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

// DELETE /api/admin/customers/[id]/invite?email=... — revoke a still-pending invitation
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: orgId } = await params
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }

  const email = req.nextUrl.searchParams.get('email')
  if (!email) return NextResponse.json({ error: 'email query param is required' }, { status: 400 })

  const { error } = await supabaseServer
    .from('org_memberships')
    .delete()
    .eq('org_id', orgId)
    .eq('user_email', email.toLowerCase().trim())
    .eq('status', 'invited')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
