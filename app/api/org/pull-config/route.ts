/**
 * GET  /api/org/pull-config — returns which config fields are set (never values)
 * POST /api/org/pull-config — upserts pull_config on the org
 * DELETE /api/org/pull-config — clears pull_config
 *
 * pull_config shape stored in organizations.pull_config:
 *   { client_usage_url: string, client_read_api_key?: string }
 *
 * Security: client_read_api_key follows the same masked pattern as Stripe credentials.
 * The plain-text key is written once and never returned to any browser context.
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'

type PullConfigRow = { client_usage_url: string; client_read_api_key?: string }

export async function GET() {
  let org
  try { org = await requireOrg('member') } catch (res) { return res as Response }

  const { data, error } = await supabaseServer
    .from('organizations')
    .select('pull_config')
    .eq('id', org.orgId)
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const config = (data?.pull_config ?? {}) as Partial<PullConfigRow>
  return NextResponse.json({
    configured:  !!(config.client_usage_url),
    config_keys: Object.keys(config).filter(k => !!(config as Record<string, unknown>)[k]),
  })
}

export async function POST(req: NextRequest) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const body = await req.json() as Partial<PullConfigRow>
  const { client_usage_url, client_read_api_key } = body

  if (!client_usage_url || typeof client_usage_url !== 'string') {
    return NextResponse.json({ error: 'client_usage_url is required' }, { status: 400 })
  }

  // If no new key is provided, preserve the existing one so the operator can
  // update the URL without re-entering the secret.
  let resolvedKey = client_read_api_key?.trim() || undefined
  if (!resolvedKey) {
    const { data: existing } = await supabaseServer
      .from('organizations')
      .select('pull_config')
      .eq('id', org.orgId)
      .single()
    resolvedKey = ((existing?.pull_config ?? {}) as Partial<PullConfigRow>).client_read_api_key
  }

  const config: PullConfigRow = { client_usage_url: client_usage_url.trim() }
  if (resolvedKey) config.client_read_api_key = resolvedKey

  const { error } = await supabaseServer
    .from('organizations')
    .update({ pull_config: config })
    .eq('id', org.orgId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE() {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { error } = await supabaseServer
    .from('organizations')
    .update({ pull_config: null })
    .eq('id', org.orgId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
