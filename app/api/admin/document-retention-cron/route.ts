import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { removeStorageObject } from '@/lib/storage'
import { logDeletion } from '@/lib/deletion-log'
import { isAuthorizedCronRequest } from '@/lib/cron-auth'

// GET /api/admin/document-retention-cron
// Called daily by Vercel Cron. Protected by x-cron-secret header, same
// pattern as the other admin/*-cron routes.
//
// Enforces the Privacy Policy's "uploaded contract documents are retained
// for 90 days after job completion, then permanently deleted" claim, which
// nothing in the codebase previously implemented.
//
// Retention-policy ambiguity, flagged rather than silently resolved: the
// policy says "90 days after job completion" but doesn't define what happens
// to a job that never completed (still processing, or execute_status
// FAILED). Rather than special-case those (and risk a stuck/failed job's
// document being retained indefinitely because it never reaches a
// "completed" timestamp), this cron applies the 90-day window uniformly to
// jobs.updated_at regardless of status — no document outlives 90 days of
// inactivity. If the intended policy is narrower (only ever-completed jobs),
// tighten the filter below once that's confirmed.
//
// DRY-RUN BY DEFAULT. This performs zero deletions and zero writes unless
// RETENTION_DELETE_ENABLED=true is explicitly set — the treatment of
// failed/incomplete jobs above is still an open question, so this ships as a
// reporting-only job (candidate count + status breakdown, logged and
// returned) until that's reviewed and deletion is deliberately turned on.
export const maxDuration = 120

const RETENTION_DAYS = 90
const DELETE_ENABLED = process.env.RETENTION_DELETE_ENABLED === 'true'

export async function GET(req: NextRequest) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const { data: candidates, error } = await supabaseServer
    .from('jobs')
    .select('id, org_id, contract_pdf_url, billing_csv_url, updated_at, execute_status')
    .lt('updated_at', cutoff)
    .is('document_deleted_at', null)
    .limit(200) // bounded per run; next day's run picks up whatever's left

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Filtered in code rather than a PostgREST `.or()` string — simpler to get
  // right than a hand-built or-filter expression, and this table isn't large
  // enough for it to matter.
  const dueJobs = (candidates ?? []).filter(j => j.contract_pdf_url || j.billing_csv_url)
  const alreadyClear = (candidates ?? []).filter(j => !j.contract_pdf_url && !j.billing_csv_url)

  const statusBreakdown: Record<string, number> = {}
  for (const j of dueJobs) {
    const status = j.execute_status ?? 'UNKNOWN'
    statusBreakdown[status] = (statusBreakdown[status] ?? 0) + 1
  }

  if (!DELETE_ENABLED) {
    const summary = {
      dry_run: true,
      cutoff,
      candidate_count: dueJobs.length,
      candidate_status_breakdown: statusBreakdown,
      already_clear_would_stamp: alreadyClear.length,
      candidates: dueJobs.map(j => ({ job_id: j.id, org_id: j.org_id, execute_status: j.execute_status, updated_at: j.updated_at })),
    }
    console.log('[document-retention-cron] DRY RUN —', JSON.stringify({ ...summary, candidates: undefined }))
    return NextResponse.json(summary)
  }

  // Nothing to delete for these, but stamp document_deleted_at anyway so
  // they stop being re-fetched as candidates on every future run.
  if (alreadyClear.length > 0) {
    await supabaseServer
      .from('jobs')
      .update({ document_deleted_at: new Date().toISOString() })
      .in('id', alreadyClear.map(j => j.id))
  }

  if (dueJobs.length === 0) return NextResponse.json({ dry_run: false, processed: 0, cleared_empty: alreadyClear.length, results: [] })

  const results: Array<{ job_id: string; ok: boolean; error?: string }> = []

  for (const job of dueJobs) {
    try {
      for (const [objectType, stored] of [
        ['contract_pdf', job.contract_pdf_url],
        ['billing_csv', job.billing_csv_url],
      ] as const) {
        if (!stored) continue
        const result = await removeStorageObject(stored)
        await logDeletion({
          objectId: result.path ?? stored,
          objectType,
          orgId: job.org_id,
          reason: 'retention_expired',
          scheduledFor: cutoff,
          storageRemoved: result.removed,
          error: result.error ?? null,
        })
      }

      await supabaseServer
        .from('jobs')
        .update({
          contract_pdf_url: null,
          billing_csv_url: null,
          document_deleted_at: new Date().toISOString(),
        })
        .eq('id', job.id)

      results.push({ job_id: job.id, ok: true })
    } catch (err) {
      console.error(`[document-retention-cron] failed for job ${job.id}:`, err)
      results.push({ job_id: job.id, ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  return NextResponse.json({ dry_run: false, processed: results.length, cleared_empty: alreadyClear.length, results })
}
