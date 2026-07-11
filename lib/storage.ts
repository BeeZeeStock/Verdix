import { supabaseServer } from './supabase'

const BUCKET = 'verdix-files'

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
  let storagePath: string

  if (!stored.startsWith('http')) {
    // New format: raw path
    storagePath = stored
  } else {
    // Legacy format: extract path from signed URL
    // e.g. https://xxx.supabase.co/storage/v1/object/sign/verdix-files/JOB/file.pdf?token=...
    try {
      const u = new URL(stored)
      const m = u.pathname.match(/\/storage\/v1\/object\/(?:sign|public|authenticated)\/[^/]+\/(.+)$/)
      if (!m) return stored  // not a Supabase storage URL — use as-is
      storagePath = decodeURIComponent(m[1])
    } catch {
      return stored
    }
  }

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
