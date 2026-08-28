// Step 17D — the long-term authorization model for cross-tenant SOURCE
// (billing_meters) management, replacing lib/admin.ts's hard-coded
// isRemembillTeam() domain check. Audited first (this session):
// organizations had no lifecycle/design-partner/tier concept at all; the
// only real primitives that existed were organizations/org_memberships +
// lib/org.ts's OrgRole ('owner'|'admin'|'member') and lib/admin.ts's
// isAdminEmail (Verdix platform staff). This module adds exactly the one
// new fact (organizations.lifecycle_stage, supabase/migrations/
// 20260906000001_org_lifecycle_stage.sql) needed to express "Verdix admin
// may manage THIS org's sources" without a per-meter flag (item 3's
// explicit constraint) and without hard-coding a specific partner's email
// domain.
//
// Deliberately split pure decision logic (unit-testable, no DB) from the
// thin DB-touching resolver — same convention as lib/operational-input-
// binding.ts / lib/discount-component-targeting.ts throughout this
// codebase.
import { supabaseServer } from './supabase'
import { isAdminEmail } from './admin-identity'
import type { OrgRole } from './org'

export type OrgLifecycleStage = 'design_partner' | 'production_customer'

// What a given actor may do with a target organization's sources
// (billing_meters rows owned by that org). Three independent capabilities,
// not a single boolean — a member of the OWNING org can see and confirm
// mappings but never touch endpoint/credential fields (item 6); someone
// entirely outside the owning org (and without design-partner-scoped
// platform-admin access) gets none of the three, including visibility —
// see canSeeOrgSources' own doc below for why visibility is checked
// separately from the write capabilities.
export interface SourceManagementAuthorization {
  // Can create/edit a meter's endpoint, credentials, connector config —
  // the "Connect new meter" / endpoint-editing surface.
  canManageSources: boolean
  // Can view configured sources and confirm/select a mapping for a
  // contract, without editing endpoint/credential fields.
  canConfirmMapping: boolean
  reason: string
}

// Pure predicate — no DB access, fully unit-testable. Every parameter is
// already-resolved data; callers (resolveSourceManagementAuthorization
// below, or a route with its own already-fetched context) supply it.
export function evaluateSourceManagementAuthorization(params: {
  targetOrgId: string
  targetOrgLifecycleStage: OrgLifecycleStage
  actorIsPlatformAdmin: boolean
  // null when the actor has no membership in the target org at all —
  // NOT the same as 'member', which still grants read/confirm access.
  actorRoleInTargetOrg: OrgRole | null
}): SourceManagementAuthorization {
  const { targetOrgLifecycleStage, actorIsPlatformAdmin, actorRoleInTargetOrg } = params

  const isTargetOrgAdminOrOwner = actorRoleInTargetOrg === 'admin' || actorRoleInTargetOrg === 'owner'
  const isTargetOrgMember = actorRoleInTargetOrg !== null

  // The owning org's own admin/owner always has full control of their own
  // sources — never gated by lifecycle_stage, which only ever governs
  // Verdix's OWN cross-tenant reach, never the tenant's own authority over
  // itself.
  if (isTargetOrgAdminOrOwner) {
    return { canManageSources: true, canConfirmMapping: true, reason: 'org admin/owner of the owning organization' }
  }

  // Item 6/16 — a normal member of the owning org can see the source is
  // missing and confirm/select an existing mapping, but never configure
  // endpoint credentials.
  if (isTargetOrgMember) {
    return { canManageSources: false, canConfirmMapping: true, reason: 'member of the owning organization (read/confirm only)' }
  }

  // Item 3 — a Verdix platform admin gets elevated cross-tenant access
  // ONLY while the target org is flagged design_partner. Once transitioned
  // to production_customer, this branch stops matching immediately (a
  // pure column-value change — see the migration's own header for why
  // this never requires touching the org's actual meter rows) and platform
  // admins get NO ordinary management access to that org's sources,
  // exactly like any other outside party.
  if (actorIsPlatformAdmin && targetOrgLifecycleStage === 'design_partner') {
    return { canManageSources: true, canConfirmMapping: true, reason: 'Verdix platform admin, target org is a design partner' }
  }

  return { canManageSources: false, canConfirmMapping: false, reason: 'no relationship to the owning organization' }
}

// Item 3/16 — visibility is the strictest of the three: Company B must
// never see that Remembill's meter even EXISTS, not merely be blocked
// from editing it. This is deliberately narrower than canConfirmMapping
// alone would suggest in isolation — an actor needs SOME relationship to
// the owning org (membership, or platform-admin + design-partner) before
// a source is listed to them at all.
export function canSeeOrgSources(auth: SourceManagementAuthorization): boolean {
  return auth.canManageSources || auth.canConfirmMapping
}

// Thin DB-touching resolver — the one place real routes call. Looks up
// the target org's lifecycle_stage and the actor's membership role in
// that specific org, then defers entirely to the pure predicate above.
export async function resolveSourceManagementAuthorization(
  targetOrgId: string,
  actorEmail: string,
): Promise<SourceManagementAuthorization> {
  const [{ data: org }, { data: membership }] = await Promise.all([
    supabaseServer.from('organizations').select('lifecycle_stage').eq('id', targetOrgId).maybeSingle(),
    supabaseServer.from('org_memberships').select('role').eq('org_id', targetOrgId).eq('user_email', actorEmail).eq('status', 'active').maybeSingle(),
  ])

  const lifecycleStage = (org?.lifecycle_stage as OrgLifecycleStage | undefined) ?? 'production_customer'
  const actorRoleInTargetOrg = (membership?.role as OrgRole | undefined) ?? null

  return evaluateSourceManagementAuthorization({
    targetOrgId,
    targetOrgLifecycleStage: lifecycleStage,
    actorIsPlatformAdmin: isAdminEmail(actorEmail),
    actorRoleInTargetOrg,
  })
}
