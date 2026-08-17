import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin'
import { supabaseServer } from '@/lib/supabase'
import { createOrg, type OrgRole } from '@/lib/org'
import { provisionAndInviteUser } from '@/lib/invite'

// GET /api/admin/customers — all orgs with subscription + membership details
export async function GET() {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }

  const { data: orgs } = await supabaseServer
    .from('organizations')
    .select('id, name, slug, created_at, allowed_domain')
    .order('created_at', { ascending: false })

  if (!orgs?.length) return NextResponse.json([])

  const { data: subs } = await supabaseServer
    .from('org_subscriptions')
    .select('*')
    .in('org_id', orgs.map(o => o.id))

  const subMap = Object.fromEntries((subs ?? []).map(s => [s.org_id, s]))

  const { data: membersData } = await supabaseServer
    .from('org_memberships')
    .select('org_id, user_email, role, status, invited_by, invite_last_sent_at, created_at')
    .in('org_id', orgs.map(o => o.id))

  const members = membersData ?? []
  const membersByOrg: Record<string, typeof members> = {}
  for (const m of members) {
    (membersByOrg[m.org_id] ??= []).push(m)
  }

  const memberMap: Record<string, number> = {}
  for (const m of members) {
    if (m.status === 'active') memberMap[m.org_id] = (memberMap[m.org_id] ?? 0) + 1
  }

  return NextResponse.json(orgs.map(o => {
    const orgMembers = membersByOrg[o.id] ?? []
    const status = orgMembers.some(m => m.status === 'active')
      ? 'active'
      : orgMembers.some(m => m.status === 'invited')
        ? 'setup_pending'
        : 'no_members'
    return {
      ...o,
      subscription: subMap[o.id] ?? { plan_id: 'trial', syncs_used: 0, status: 'active' },
      member_count: memberMap[o.id] ?? 0,
      status,
      members: orgMembers,
    }
  }))
}

// POST /api/admin/customers — provision a brand-new organization + its initial admin
export async function POST(req: NextRequest) {
  let adminEmail: string
  try { adminEmail = await requireAdmin() } catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }

  const { name, initialAdminEmail, role = 'admin', allowedDomain: rawAllowedDomain } = await req.json() as {
    name: string; initialAdminEmail: string; role?: OrgRole; allowedDomain?: string
  }
  if (!name?.trim()) return NextResponse.json({ error: 'Organization name is required' }, { status: 400 })
  if (!initialAdminEmail?.trim()) return NextResponse.json({ error: 'Initial admin email is required' }, { status: 400 })
  if (!['owner', 'admin', 'member'].includes(role)) return NextResponse.json({ error: 'Invalid role' }, { status: 400 })

  const allowedDomain = rawAllowedDomain?.trim().toLowerCase() || null
  if (allowedDomain && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z]{2,})+$/.test(allowedDomain)) {
    return NextResponse.json({ error: 'Invalid domain format' }, { status: 400 })
  }

  let orgId: string
  try {
    orgId = await createOrg(name.trim(), initialAdminEmail, { status: 'invited', role, createdBy: adminEmail, allowedDomain })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed to create organization' }, { status: 500 })
  }

  try {
    await provisionAndInviteUser({ orgId, orgName: name.trim(), email: initialAdminEmail, role, invitedByEmail: adminEmail })
  } catch (err) {
    console.error('[admin/customers] invite failed after org creation:', err)
    return NextResponse.json({
      ok: true, orgId, warning: 'Organization created, but the invitation email failed to send. Use Resend from the org detail view.',
    })
  }

  return NextResponse.json({ ok: true, orgId })
}

// PATCH /api/admin/customers — update org subscription (plan, trial limit override) and/or org fields (allowed_domain)
export async function PATCH(req: NextRequest) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }

  const { org_id, plan_id, trial_sync_limit_override, allowedDomain: rawAllowedDomain } = await req.json()
  if (!org_id) return NextResponse.json({ error: 'org_id required' }, { status: 400 })

  if (plan_id !== undefined || trial_sync_limit_override !== undefined) {
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (plan_id !== undefined) update.plan_id = plan_id
    if (trial_sync_limit_override !== undefined) update.trial_sync_limit_override = trial_sync_limit_override

    const { error } = await supabaseServer
      .from('org_subscriptions')
      .upsert({ org_id, ...update }, { onConflict: 'org_id' })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (rawAllowedDomain !== undefined) {
    const allowedDomain = rawAllowedDomain?.trim().toLowerCase() || null
    if (allowedDomain && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z]{2,})+$/.test(allowedDomain)) {
      return NextResponse.json({ error: 'Invalid domain format' }, { status: 400 })
    }
    const { error } = await supabaseServer
      .from('organizations')
      .update({ allowed_domain: allowedDomain })
      .eq('id', org_id)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
