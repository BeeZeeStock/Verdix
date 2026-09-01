// Step 17H.4B0D4H1B3.1 — the shared ownership-claim wrapper around
// begin_job_configuration_mutation (supabase/migrations/20260914000001_
// reexecution_claim_and_hold_transition.sql), used by every non-execute
// commercial-mutation surface (confirm-rule, reconcile-line-items, the
// reviewer line-items PATCH). Mirrors the shape of execute's own
// begin_job_reexecution wrapper deliberately — same claim/restore/
// transition pattern, different RPC (this one never touches
// execute_status). Centralizing this here is what lets three routes share
// ownership mechanics while keeping their own mutation-specific policy
// (what "clean" means, what the next hold should be) separate.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { BillingHold } from './billing-hold'

// Step 17H.4B0D4H1B3.4 — renamed from previouslyApproved. Same underlying
// fact (billing_customer_id IS NOT NULL), but its ONLY remaining job is
// deciding a CLEAN outcome's target (schedule_rebuild_required when a
// schedule already exists to go stale; NULL when there was never one) —
// it no longer decides whether ownership/reconciliation-safety applies at
// all. newBillingHold is now non-null for EVERY successful AUTO_CONFIGURE
// claim (H1B3.4), never conditional on this flag — a never-approved job
// still gets real, durable ownership beyond this RPC call's own
// transaction, and a real place to record an unresolved reconciliation
// blocker so Approve's own billing_hold gate can refuse first approval.
export interface ConfigurationMutationClaim {
  claimed: true
  previousBillingHold: BillingHold | null
  newBillingHold: BillingHold | null
  hasExistingBillingSchedule: boolean
}

export type BeginConfigurationMutationResult =
  | ConfigurationMutationClaim
  | { claimed: false; reason: 'not_found' | 'malformed_hold' | 'configuration_mutation_in_progress' }
  | { claimed: false; reason: 'status_conflict'; currentExecuteStatus: string }

interface RawBeginConfigurationMutationResult {
  claimed: boolean
  reason?: 'not_found' | 'malformed_hold' | 'configuration_mutation_in_progress' | 'status_conflict'
  current_execute_status?: string
  previous_billing_hold?: BillingHold | null
  new_billing_hold?: BillingHold | null
  has_existing_billing_schedule?: boolean
}

export async function beginConfigurationMutationClaim(
  supabase: SupabaseClient, jobId: string, startedAt: string = new Date().toISOString(),
): Promise<BeginConfigurationMutationResult | { claimed: false; reason: 'error'; message: string }> {
  const { data, error } = await supabase.rpc('begin_job_configuration_mutation', { p_job_id: jobId, p_started_at: startedAt })
  if (error) return { claimed: false, reason: 'error', message: error.message }
  const raw = data as RawBeginConfigurationMutationResult
  if (!raw.claimed) {
    if (raw.reason === 'status_conflict') {
      return { claimed: false, reason: 'status_conflict', currentExecuteStatus: raw.current_execute_status ?? 'UNKNOWN' }
    }
    return { claimed: false, reason: raw.reason ?? 'not_found' }
  }
  return {
    claimed: true,
    previousBillingHold: raw.previous_billing_hold ?? null,
    newBillingHold: raw.new_billing_hold ?? null,
    hasExistingBillingSchedule: !!raw.has_existing_billing_schedule,
  }
}

// A human-readable message for the 409 response, shared verbatim across
// every route that surfaces a rejected claim — one wording, not three
// slightly different ones.
export function describeConfigurationMutationClaimRejection(
  result: Exclude<BeginConfigurationMutationResult, ConfigurationMutationClaim> | { claimed: false; reason: 'error'; message: string },
): string {
  if (result.reason === 'status_conflict') {
    return result.currentExecuteStatus === 'APPROVING'
      ? 'This contract is currently being approved — please wait for it to finish before making this change.'
      : 'This contract is currently being re-executed — please wait for it to finish before making this change.'
  }
  if (result.reason === 'malformed_hold') {
    return 'Billing configuration hold could not be read safely. Refusing this change until it is resolved.'
  }
  if (result.reason === 'configuration_mutation_in_progress') {
    return 'Another commercial configuration change is already in progress for this job — please wait for it to finish.'
  }
  if (result.reason === 'error') {
    return `Failed to start this change: ${result.message}`
  }
  return 'This job could not be found.'
}
