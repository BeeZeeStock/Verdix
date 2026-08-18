import { supabaseServer } from './supabase'

/**
 * Records that a document/object was (or attempted to be) deleted — never
 * pass document content here, only identifiers. Best-effort: a logging
 * failure must never block or reverse the deletion itself, so callers should
 * not await this in a way that fails the request — call and let it settle.
 */
export async function logDeletion(entry: {
  objectId: string
  objectType: 'contract_pdf' | 'billing_csv' | 'job'
  orgId: string | null
  reason: 'manual_delete' | 'retention_expired'
  scheduledFor?: string | null
  storageRemoved: boolean
  error?: string | null
}): Promise<void> {
  const { error } = await supabaseServer.from('deletion_log').insert({
    object_id:       entry.objectId,
    object_type:     entry.objectType,
    org_id:          entry.orgId,
    reason:          entry.reason,
    scheduled_for:   entry.scheduledFor ?? null,
    storage_removed: entry.storageRemoved,
    error:           entry.error ?? null,
  })
  if (error) console.error('[deletion-log] failed to record deletion:', error.message)
}
