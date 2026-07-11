import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'

const BUCKET = 'verdix-files'
const EXPIRY = 60 * 60 * 2  // 2 hours

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let org
  try { org = await requireOrg() } catch (res) { return res as Response }

  const { id } = await params

  // Verify the job belongs to this org
  const { data: job } = await supabaseServer
    .from('jobs')
    .select('contract_pdf_url, org_id')
    .eq('id', id)
    .eq('org_id', org.orgId)
    .single()

  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!job.contract_pdf_url) return NextResponse.json({ error: 'No PDF attached' }, { status: 404 })

  // ── Strategy 1: list files in the job's storage folder ────────────────────
  // This is reliable for ALL contracts regardless of how contract_pdf_url was stored.
  try {
    const { data: files } = await supabaseServer.storage
      .from(BUCKET)
      .list(id, { limit: 20, search: 'contract' })

    const match = files?.find(f => /^contract\./i.test(f.name))
    if (match) {
      const path = `${id}/${match.name}`
      const { data, error } = await supabaseServer.storage.from(BUCKET).createSignedUrl(path, EXPIRY)
      if (!error && data?.signedUrl) {
        return NextResponse.json({ url: data.signedUrl })
      }
    }
  } catch (err) {
    console.error('[pdf-url] storage list failed:', err)
  }

  // ── Strategy 2: extract path from stored URL (legacy signed URL format) ──
  if (job.contract_pdf_url.startsWith('http')) {
    try {
      const u = new URL(job.contract_pdf_url)
      const m = u.pathname.match(/\/storage\/v1\/object\/(?:sign|public|authenticated)\/[^/]+\/(.+)$/)
      if (m) {
        const storagePath = decodeURIComponent(m[1])
        const { data, error } = await supabaseServer.storage.from(BUCKET).createSignedUrl(storagePath, EXPIRY)
        if (!error && data?.signedUrl) {
          return NextResponse.json({ url: data.signedUrl })
        }
        console.error('[pdf-url] strategy 2 createSignedUrl failed:', error?.message, 'path:', storagePath)
      }
    } catch (err) {
      console.error('[pdf-url] strategy 2 URL parse failed:', err)
    }
  }

  // ── Strategy 3: stored value is already a raw path ─────────────────────────
  if (!job.contract_pdf_url.startsWith('http')) {
    try {
      const { data, error } = await supabaseServer.storage
        .from(BUCKET)
        .createSignedUrl(job.contract_pdf_url, EXPIRY)
      if (!error && data?.signedUrl) {
        return NextResponse.json({ url: data.signedUrl })
      }
    } catch { /* ignore */ }
  }

  // ── Fallback: return the stored value as-is ────────────────────────────────
  // PDFViewer will show its own error if the URL is expired.
  console.warn('[pdf-url] all strategies failed, returning stored URL for job', id)
  return NextResponse.json({ url: job.contract_pdf_url })
}
