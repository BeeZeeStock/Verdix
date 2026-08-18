/**
 * POST /api/usage/record
 *
 * Ingestion endpoint for the flexible metric ledger. Called by:
 *   - Verdix internally (via recordSync in lib/billing.ts) when a job completes
 *   - 3PP SaaS clients to report usage against any metric type
 *
 * Adding a new billing dimension requires no code change — POST with a new
 * metric_type and Verdix's billing engine will pick it up at invoice time,
 * provided a price is configured for that type in verdix_plans.metric_config.
 *
 * Body:
 *   job_id       — Verdix job UUID (required — resolves the org)
 *   metric_type  — billing dimension (default: "sync")
 *   quantity     — units to record (default: 1)
 *   unit_type    — legacy alias for metric_type (honoured if metric_type absent)
 *   occurred_at  — accepted but not stored (no per-event timestamps yet)
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'

export async function POST(req: NextRequest) {
  // Authenticated the same way as /api/v1/usage — a Bearer token matched
  // against org_subscriptions.ingest_api_key. Org is resolved from the KEY,
  // never trusted from the client-supplied job_id, which previously let any
  // caller inflate/zero another org's billable usage just by guessing a job id.
  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  if (!token) {
    return NextResponse.json({ error: 'Missing Authorization header' }, { status: 401 })
  }
  const { data: callerSub } = await supabaseServer
    .from('org_subscriptions')
    .select('org_id')
    .eq('ingest_api_key', token)
    .maybeSingle()
  if (!callerSub) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 })
  }

  const body = await req.json() as {
    job_id?:      string
    metric_type?: string
    unit_type?:   string
    quantity?:    number
    [key: string]: unknown
  }

  const { job_id } = body
  if (!job_id) {
    return NextResponse.json({ error: 'job_id is required' }, { status: 400 })
  }

  // Support legacy unit_type alias
  const metricType = (body.metric_type ?? body.unit_type ?? 'sync').trim()
  const quantity   = Math.max(1, Number(body.quantity ?? 1))

  // ── Resolve the job, then require it actually belongs to the authenticated org ──
  const { data: job, error: jobError } = await supabaseServer
    .from('jobs')
    .select('org_id')
    .eq('id', job_id)
    .eq('org_id', callerSub.org_id)
    .single()

  if (jobError || !job?.org_id) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  // ── Confirm org has a subscription row ────────────────────────────────────
  const { data: orgSub } = await supabaseServer
    .from('org_subscriptions')
    .select('org_id')
    .eq('org_id', job.org_id)
    .maybeSingle()

  if (!orgSub) {
    console.info(`[usage/record] job ${job_id}: org ${job.org_id} has no subscription row — hit not tracked`)
    return NextResponse.json({ ok: true })
  }

  // ── Write to counter cache + timestamped ledger ───────────────────────────
  const { error: rpcError } = await supabaseServer.rpc('record_usage', {
    org_id_param:      job.org_id,
    meter_key_param:   metricType,
    amount_param:      quantity,
    job_id_param:      job_id,
    occurred_at_param: new Date().toISOString(),
  })

  if (rpcError) {
    console.error('[usage/record] increment_usage_counter RPC failed:', rpcError)
  }

  return NextResponse.json({ ok: true })
}
