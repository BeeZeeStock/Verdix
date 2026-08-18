import { supabaseServer } from './supabase'

const BUCKET = 'verdix-files'

/**
 * Extracts the bucket-relative storage path from a stored file reference.
 * Stored values may be:
 *   (a) a raw storage path like "JOB_ID/contract.pdf" (new format)
 *   (b) a full Supabase signed URL (legacy format)
 * Returns null if `stored` isn't a recognizable reference to an object in
 * our bucket (e.g. some other external URL).
 */
function toStoragePath(stored: string): string | null {
  if (!stored.startsWith('http')) return stored
  try {
    const u = new URL(stored)
    const m = u.pathname.match(/\/storage\/v1\/object\/(?:sign|public|authenticated)\/[^/]+\/(.+)$/)
    return m ? decodeURIComponent(m[1]) : null
  } catch {
    return null
  }
}

/**
 * Permanently deletes the underlying object from Storage — deleting only the
 * database row that references a file (contract_pdf_url etc.) leaves the
 * actual document sitting in the bucket forever otherwise. Safe to call with
 * null/undefined (no-op) so call sites don't need their own guard.
 */
export async function removeStorageObject(stored: string | null | undefined): Promise<{ removed: boolean; path: string | null; error?: string }> {
  if (!stored) return { removed: false, path: null }
  const path = toStoragePath(stored)
  if (!path) return { removed: false, path: null, error: 'unrecognized storage reference' }

  const { error } = await supabaseServer.storage.from(BUCKET).remove([path])
  if (error) return { removed: false, path, error: error.message }
  return { removed: true, path }
}

/**
 * Resolves a stored file reference to a fetchable URL.
 *
 * Stored values may be:
 *   (a) a raw storage path like "JOB_ID/contract.pdf" (new format, never expires)
 *   (b) a full Supabase signed URL (legacy format, expires after 7 days)
 *
 * Returns a fresh 2-hour signed URL in both cases.
 */
export async function resolveStorageUrl(stored: string): Promise<string> {
  const storagePath = toStoragePath(stored) ?? stored

  try {
    const { data, error } = await supabaseServer.storage
      .from(BUCKET)
      .createSignedUrl(storagePath, 60 * 60 * 2)

    if (error || !data?.signedUrl) {
      console.error(`[storage] createSignedUrl failed for "${storagePath}":`, error?.message)
      return stored  // fall back to stored value
    }

    return data.signedUrl
  } catch (err) {
    console.error(`[storage] unexpected error for "${storagePath}":`, err)
    return stored  // fall back to stored value
  }
}
