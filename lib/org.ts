import { auth } from './auth'
import { supabaseServer } from './supabase'

export type OrgRole = 'owner' | 'admin' | 'member'

export interface OrgContext {
  orgId: string
  orgName: string
  orgSlug: string
  role: OrgRole
  userEmail: string
}

const roleRank: Record<OrgRole, number> = { member: 0, admin: 1, owner: 2 }

async function fetchMembership(email: string): Promise<{ org_id: string; role: string; name: string; slug: string } | null> {
  const { data: members, error: memberErr } = await supabaseServer
    .from('org_memberships')
    .select('org_id, role')
    .eq('user_email', email)
    .eq('status', 'active')
    .order('created_at', { ascending: true })
    .limit(1)

  if (memberErr) console.error('[org] membership query error:', memberErr.message, 'email:', email)
  const member = members?.[0] ?? null
  if (!member) return null

  const { data: orgs, error: orgErr } = await supabaseServer
    .from('organizations')
    .select('name, slug')
    .eq('id', member.org_id)
    .limit(1)

  if (orgErr) console.error('[org] organizations query error:', orgErr.message, 'org_id:', member.org_id)
  const org = orgs?.[0] ?? null
  if (!org) return null

  return { org_id: member.org_id, role: member.role, name: org.name, slug: org.slug }
}

/**
 * Returns the active org for the current session.
 * If the user is authenticated but has no org, one is auto-created.
 * Returns null only when the user is not authenticated.
 */
export async function getActiveOrg(): Promise<OrgContext | null> {
  const session = await auth()
  if (!session?.user?.email) return null

  const email = session.user.email
  let data = await fetchMembership(email)

  if (!data) {
    // Auto-create org — handles new Google OAuth users and any missed signup paths
    const company = email.split('@')[1]?.split('.')[0] ?? email.split('@')[0]
    try {
      console.log('[org] no membership found for', email, '— auto-creating org')
      await createOrg(company, email)
      data = await fetchMembership(email)
    } catch (err) {
      console.error('[org] auto-create failed for', email, ':', err)
      return null
    }
  }

  if (!data) return null

  return {
    orgId: data.org_id,
    orgName: data.name,
    orgSlug: data.slug,
    role: data.role as OrgRole,
    userEmail: email,
  }
}

/** Returns OrgContext or throws a Response suitable for returning directly from a Route Handler. */
export async function requireOrg(minRole: OrgRole = 'member'): Promise<OrgContext> {
  const session = await auth()
  if (!session?.user?.email) {
    throw new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
  }

  const email = session.user.email
  let data = await fetchMembership(email)

  if (!data) {
    // Auto-create org so API routes also work for brand-new users
    const company = email.split('@')[1]?.split('.')[0] ?? email.split('@')[0]
    try {
      await createOrg(company, email)
      data = await fetchMembership(email)
    } catch {
      throw new Response(JSON.stringify({ error: 'No organization found' }), { status: 403 })
    }
  }

  if (!data) {
    throw new Response(JSON.stringify({ error: 'No organization found' }), { status: 403 })
  }

  const role = data.role as OrgRole
  if (roleRank[role] < roleRank[minRole]) {
    throw new Response(JSON.stringify({ error: 'Insufficient permissions' }), { status: 403 })
  }

  return {
    orgId: data.org_id,
    orgName: data.name,
    orgSlug: data.slug,
    role,
    userEmail: email,
  }
}

export function hasRole(userRole: OrgRole, minRole: OrgRole): boolean {
  return roleRank[userRole] >= roleRank[minRole]
}

/** Create an org and owner membership. Returns the new org id. */
export async function createOrg(name: string, ownerEmail: string): Promise<string> {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)

  const uniqueSlug = `${slug}-${Date.now().toString(36)}`

  const { data: org, error: orgErr } = await supabaseServer
    .from('organizations')
    .insert({ name, slug: uniqueSlug })
    .select('id')
    .single()

  if (orgErr || !org) throw new Error(`Failed to create org: ${orgErr?.message}`)

  const { error: memberErr } = await supabaseServer
    .from('org_memberships')
    .insert({ org_id: org.id, user_email: ownerEmail, role: 'owner', status: 'active' })

  if (memberErr) throw new Error(`Failed to create membership: ${memberErr.message}`)

  return org.id
}
