import { describe, it, expect } from 'vitest'
import { evaluateSourceManagementAuthorization, canSeeOrgSources } from './org-lifecycle'

describe('evaluateSourceManagementAuthorization — Step 17D, item 2/3/16', () => {
  it('an org admin manages their own org\'s sources regardless of lifecycle_stage', () => {
    for (const stage of ['design_partner', 'production_customer'] as const) {
      const authz = evaluateSourceManagementAuthorization({
        targetOrgId: 'org-1', targetOrgLifecycleStage: stage,
        actorIsPlatformAdmin: false, actorRoleInTargetOrg: 'admin',
      })
      expect(authz.canManageSources).toBe(true)
      expect(authz.canConfirmMapping).toBe(true)
    }
  })

  it('an org owner manages their own org\'s sources', () => {
    const authz = evaluateSourceManagementAuthorization({
      targetOrgId: 'org-1', targetOrgLifecycleStage: 'production_customer',
      actorIsPlatformAdmin: false, actorRoleInTargetOrg: 'owner',
    })
    expect(authz.canManageSources).toBe(true)
  })

  it('a plain member of the owning org can confirm mappings but never manage endpoint credentials', () => {
    const authz = evaluateSourceManagementAuthorization({
      targetOrgId: 'org-1', targetOrgLifecycleStage: 'production_customer',
      actorIsPlatformAdmin: false, actorRoleInTargetOrg: 'member',
    })
    expect(authz.canManageSources).toBe(false)
    expect(authz.canConfirmMapping).toBe(true)
  })

  it('Verdix platform admin CAN manage sources for a design_partner org', () => {
    const authz = evaluateSourceManagementAuthorization({
      targetOrgId: 'remembill-org', targetOrgLifecycleStage: 'design_partner',
      actorIsPlatformAdmin: true, actorRoleInTargetOrg: null,
    })
    expect(authz.canManageSources).toBe(true)
    expect(authz.canConfirmMapping).toBe(true)
  })

  it('Verdix platform admin CANNOT manage sources for a production_customer org — no ordinary cross-tenant authority', () => {
    const authz = evaluateSourceManagementAuthorization({
      targetOrgId: 'company-b', targetOrgLifecycleStage: 'production_customer',
      actorIsPlatformAdmin: true, actorRoleInTargetOrg: null,
    })
    expect(authz.canManageSources).toBe(false)
    expect(authz.canConfirmMapping).toBe(false)
  })

  it('an outside party with no relationship to the org and no platform-admin status gets nothing', () => {
    const authz = evaluateSourceManagementAuthorization({
      targetOrgId: 'remembill-org', targetOrgLifecycleStage: 'design_partner',
      actorIsPlatformAdmin: false, actorRoleInTargetOrg: null,
    })
    expect(authz.canManageSources).toBe(false)
    expect(authz.canConfirmMapping).toBe(false)
  })

  it('lifecycle transition design_partner -> production_customer immediately removes platform-admin elevated access — pure column-value change, same actor/org otherwise', () => {
    const before = evaluateSourceManagementAuthorization({
      targetOrgId: 'remembill-org', targetOrgLifecycleStage: 'design_partner',
      actorIsPlatformAdmin: true, actorRoleInTargetOrg: null,
    })
    const after = evaluateSourceManagementAuthorization({
      targetOrgId: 'remembill-org', targetOrgLifecycleStage: 'production_customer',
      actorIsPlatformAdmin: true, actorRoleInTargetOrg: null,
    })
    expect(before.canManageSources).toBe(true)
    expect(after.canManageSources).toBe(false)
  })

  it('the owning org\'s own admin is unaffected by the design_partner -> production_customer transition', () => {
    const before = evaluateSourceManagementAuthorization({
      targetOrgId: 'remembill-org', targetOrgLifecycleStage: 'design_partner',
      actorIsPlatformAdmin: false, actorRoleInTargetOrg: 'admin',
    })
    const after = evaluateSourceManagementAuthorization({
      targetOrgId: 'remembill-org', targetOrgLifecycleStage: 'production_customer',
      actorIsPlatformAdmin: false, actorRoleInTargetOrg: 'admin',
    })
    expect(before.canManageSources).toBe(true)
    expect(after.canManageSources).toBe(true)
  })
})

describe('canSeeOrgSources — item 3/16 (Company B must never see Remembill\'s meters)', () => {
  it('visible when either capability is granted', () => {
    expect(canSeeOrgSources({ canManageSources: true, canConfirmMapping: true, reason: '' })).toBe(true)
    expect(canSeeOrgSources({ canManageSources: false, canConfirmMapping: true, reason: '' })).toBe(true)
  })

  it('invisible when neither capability is granted — the Company B case', () => {
    expect(canSeeOrgSources({ canManageSources: false, canConfirmMapping: false, reason: '' })).toBe(false)
  })
})
