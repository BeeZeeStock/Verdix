import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { beginConfigurationMutationClaim, describeConfigurationMutationClaimRejection } from './configuration-mutation-claim'

function mockSupabase(data: unknown, error: unknown = null): SupabaseClient {
  return { rpc: vi.fn().mockResolvedValue({ data, error }) } as unknown as SupabaseClient
}

describe('beginConfigurationMutationClaim', () => {
  it('maps a successful claim, has an existing billing schedule', async () => {
    const client = mockSupabase({
      claimed: true,
      previous_billing_hold: { reason: 'schedule_rebuild_required', started_at: 'x' },
      new_billing_hold: { reason: 'reexecution', started_at: 'y' },
      has_existing_billing_schedule: true,
    })
    const result = await beginConfigurationMutationClaim(client, 'job-1', 'y')
    expect(result).toEqual({
      claimed: true,
      previousBillingHold: { reason: 'schedule_rebuild_required', started_at: 'x' },
      newBillingHold: { reason: 'reexecution', started_at: 'y' },
      hasExistingBillingSchedule: true,
    })
  })

  // Step 17H.4B0D4H1B3.4 — a never-approved AUTO_CONFIGURE job now STILL
  // gets a real, durable temporary hold (newBillingHold non-null) — only
  // hasExistingBillingSchedule is false. Previously (H1B3.1) this case
  // returned newBillingHold:null too; that was the exact gap this pass
  // closed.
  it('maps a successful claim, no existing billing schedule: still gets a real durable hold', async () => {
    const client = mockSupabase({
      claimed: true,
      previous_billing_hold: null,
      new_billing_hold: { reason: 'reexecution', started_at: 'y' },
      has_existing_billing_schedule: false,
    })
    const result = await beginConfigurationMutationClaim(client, 'job-1')
    expect(result).toEqual({
      claimed: true,
      previousBillingHold: null,
      newBillingHold: { reason: 'reexecution', started_at: 'y' },
      hasExistingBillingSchedule: false,
    })
  })

  it('maps a status_conflict rejection', async () => {
    const client = mockSupabase({ claimed: false, reason: 'status_conflict', current_execute_status: 'EXTRACTING' })
    const result = await beginConfigurationMutationClaim(client, 'job-1')
    expect(result).toEqual({ claimed: false, reason: 'status_conflict', currentExecuteStatus: 'EXTRACTING' })
  })

  it('maps a configuration_mutation_in_progress rejection', async () => {
    const client = mockSupabase({ claimed: false, reason: 'configuration_mutation_in_progress' })
    const result = await beginConfigurationMutationClaim(client, 'job-1')
    expect(result).toEqual({ claimed: false, reason: 'configuration_mutation_in_progress' })
  })

  it('maps a malformed_hold rejection', async () => {
    const client = mockSupabase({ claimed: false, reason: 'malformed_hold' })
    const result = await beginConfigurationMutationClaim(client, 'job-1')
    expect(result).toEqual({ claimed: false, reason: 'malformed_hold' })
  })

  it('maps an RPC infrastructure error without throwing', async () => {
    const client = mockSupabase(null, { message: 'connection reset' })
    const result = await beginConfigurationMutationClaim(client, 'job-1')
    expect(result).toEqual({ claimed: false, reason: 'error', message: 'connection reset' })
  })
})

describe('describeConfigurationMutationClaimRejection', () => {
  it('distinguishes APPROVING from EXTRACTING in the status_conflict message', () => {
    expect(describeConfigurationMutationClaimRejection({ claimed: false, reason: 'status_conflict', currentExecuteStatus: 'APPROVING' })).toMatch(/being approved/)
    expect(describeConfigurationMutationClaimRejection({ claimed: false, reason: 'status_conflict', currentExecuteStatus: 'EXTRACTING' })).toMatch(/re-executed/)
  })
  it('has a message for every rejection reason', () => {
    for (const reason of ['malformed_hold', 'configuration_mutation_in_progress', 'not_found'] as const) {
      expect(describeConfigurationMutationClaimRejection({ claimed: false, reason })).toBeTruthy()
    }
    expect(describeConfigurationMutationClaimRejection({ claimed: false, reason: 'error', message: 'x' })).toContain('x')
  })
})
