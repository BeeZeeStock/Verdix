import { auth } from './auth'
import { supabaseServer } from './supabase'
import { isSelfServiceSignupEnabled, shouldAutoCreateOrg } from './feature-flags'

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
  // Check for active membership first
  const { data: activeMembers, error: memberErr } = await supabaseServer
    .from('org_memberships')
    .select('org_id, role')
    .eq('user_email', email)
    .eq('status', 'active')
    .order('created_at', { ascending: true })
    .limit(1)

  if (memberErr) console.error('[org] membership query error:', memberErr.message, 'email:', email)

  const member = activeMembers?.[0] ?? null

  // No active membership — check for pending invitations and activate them.
  // This covers Google OAuth users who never go through /signup, and any
  // invited user whose invite row wasn't activated at signup time.
  if (!member) {
    const { data: invites } = await supabaseServer
      .from('org_memberships')
      .select('org_id, role')
      .eq('user_email', email)
      .eq('status', 'invited')
      .order('created_at', { ascending: true })

    if (invites && invites.length > 0) {
      // Activate all pending invites for this user in one go
      await supabaseServer
        .from('org_memberships')
        .update({ status: 'active' })
        .eq('user_email', email)
        .eq('status', 'invited')

      const first = invites[0]
      const { data: orgs } = await supabaseServer
        .from('organizations')
        .select('name, slug')
        .eq('id', first.org_id)
        .limit(1)
      const org = orgs?.[0] ?? null
      if (org) {
        console.log('[org] activated invited membership for', email, '→ org', first.org_id)
        return { org_id: first.org_id, role: first.role, name: org.name, slug: org.slug }
      }
    }

    // No invite either — check domain-based auto-join (e.g. everyone @acme.com joins Acme org)
    const domain = email.split('@')[1]?.toLowerCase()
    if (domain) {
      const { data: domainOrgs } = await supabaseServer
        .from('organizations')
        .select('id, name, slug')
        .eq('allowed_domain', domain)
        .limit(1)

      const domainOrg = domainOrgs?.[0]
      if (domainOrg) {
        await supabaseServer
          .from('org_memberships')
          .upsert(
            { org_id: domainOrg.id, user_email: email, role: 'member', status: 'active' },
            { onConflict: 'org_id,user_email', ignoreDuplicates: true }
          )
        console.log('[org] domain auto-join for', email, '→ org', domainOrg.id)
        return { org_id: domainOrg.id, role: 'member', name: domainOrg.name, slug: domainOrg.slug }
      }
    }

    return null
  }

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

  if (shouldAutoCreateOrg(!!data, await isSelfServiceSignupEnabled())) {
    // Auto-create org — handles new Google OAuth users and any missed signup paths.
    // Only reachable while self-service signup is enabled; see shouldAutoCreateOrg.
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

  if (shouldAutoCreateOrg(!!data, await isSelfServiceSignupEnabled())) {
    // Auto-create org so API routes also work for brand-new users.
    // Only reachable while self-service signup is enabled; see shouldAutoCreateOrg.
    const company = email.split('@')[1]?.split('.')[0] ?? email.split('@')[0]
    try {
      await createOrg(company, email)
      data = await fetchMembership(email)
    } catch {
      throw new Response(JSON.stringify({ error: 'No organization found' }), { status: 403 })
    }
  }

  if (!data) {
    throw new Response(JSON.stringify({ error: 'Access by invitation only' }), { status: 403 })
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

/**
 * Create an org and an initial membership. Returns the new org id.
 * `opts` defaults preserve the original self-service behavior (owner, active)
 * for the two existing call sites; admin provisioning passes an explicit
 * `status: 'invited'` since the initial admin hasn't set a password yet.
 */
export async function createOrg(
  name: string,
  ownerEmail: string,
  opts: { status?: 'active' | 'invited'; role?: OrgRole; createdBy?: string; allowedDomain?: string | null } = {},
): Promise<string> {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)

  const uniqueSlug = `${slug}-${Date.now().toString(36)}`

  const { data: org, error: orgErr } = await supabaseServer
    .from('organizations')
    .insert({
      name,
      slug: uniqueSlug,
      ...(opts.createdBy ? { created_by: opts.createdBy } : {}),
      ...(opts.allowedDomain ? { allowed_domain: opts.allowedDomain } : {}),
    })
    .select('id')
    .single()

  if (orgErr || !org) throw new Error(`Failed to create org: ${orgErr?.message}`)

  const { error: memberErr } = await supabaseServer
    .from('org_memberships')
    .insert({
      org_id: org.id,
      user_email: ownerEmail,
      role: opts.role ?? 'owner',
      status: opts.status ?? 'active',
    })

  if (memberErr) throw new Error(`Failed to create membership: ${memberErr.message}`)

  return org.id
}
