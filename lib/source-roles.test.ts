import { describe, it, expect } from 'vitest'
import { isValidSourceRoleKey, RESERVED_SOURCE_ROLE_KEY } from './source-roles'

describe('isValidSourceRoleKey', () => {
  it('accepts the real OS-2026-09 roles — crm, enrichment, calendar, conferencing, portal, public_materials, reviewer_attestation', () => {
    for (const key of ['crm', 'enrichment', 'calendar', 'conferencing', 'portal', 'public_materials', RESERVED_SOURCE_ROLE_KEY]) {
      expect(isValidSourceRoleKey(key)).toBe(true)
    }
  })

  it('accepts an arbitrary, previously-unseen role for a different contract — no code change required to add erp/helpdesk/logistics/claims', () => {
    for (const key of ['erp', 'helpdesk', 'logistics', 'claims', 'agent_logs']) {
      expect(isValidSourceRoleKey(key)).toBe(true)
    }
  })

  it('rejects anything that is not a plain lowercase identifier', () => {
    expect(isValidSourceRoleKey('CRM')).toBe(false)
    expect(isValidSourceRoleKey('crm system')).toBe(false)
    expect(isValidSourceRoleKey('crm; DROP TABLE x')).toBe(false)
    expect(isValidSourceRoleKey('1crm')).toBe(false)
    expect(isValidSourceRoleKey('')).toBe(false)
    expect(isValidSourceRoleKey('a')).toBe(false)
  })
})
