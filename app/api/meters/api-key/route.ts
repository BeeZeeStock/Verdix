/**
 * GET  /api/meters/api-key  — return (or generate) the org's ingest API key
 * POST /api/meters/api-key  — { action: 'regenerate' } rotates the key
 *
 * The key is returned in full on GET so the user can copy it.
 * After regeneration the old key stops working immediately.
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'

function generateKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  const hex   = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
  return `sk_verdix_${hex}`
}

async function getOrCreateKey(orgId: string): Promise<string> {
  const { data } = await supabaseServer
    .from('org_subscriptions')
    .select('ingest_api_key')
    .eq('org_id', orgId)
    .maybeSingle()

  if (data?.ingest_api_key) return data.ingest_api_key

  const key = generateKey()
  await supabaseServer
    .from('org_subscriptions')
    .update({ ingest_api_key: key, updated_at: new Date().toISOString() })
    .eq('org_id', orgId)

  return key
}

export async function GET() {
  let org
  try { org = await requireOrg('member') } catch (res) { return res as Response }

  const key = await getOrCreateKey(org.orgId)
  return NextResponse.json({ api_key: key })
}

export async function POST(req: NextRequest) {
  let org
  try { org = await requireOrg('member') } catch (res) { return res as Response }

  const body = await req.json() as { action?: string }
  if (body.action !== 'regenerate') {
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  }

  const key = generateKey()
  await supabaseServer
    .from('org_subscriptions')
    .update({ ingest_api_key: key, updated_at: new Date().toISOString() })
    .eq('org_id', org.orgId)

  return NextResponse.json({ api_key: key })
}
