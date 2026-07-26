/**
 * POST /api/v1/usage
 *
 * Public ingest endpoint for enterprise customers to push usage events.
 * Authenticated by Bearer token matching org_subscriptions.ingest_api_key.
 *
 * Body: { meter_key: string, quantity?: number, occurred_at?: string }
 * Returns: { ok: true, id: uuid }
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'

export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''

  if (!token) {
    return NextResponse.json({ error: 'Missing Authorization header' }, { status: 401 })
  }

  const { data: sub } = await supabaseServer
    .from('org_subscriptions')
    .select('org_id')
    .eq('ingest_api_key', token)
    .maybeSingle()

  if (!sub) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 })
  }

  let body: { meter_key?: string; quantity?: number; occurred_at?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const meterKey = body.meter_key?.trim()
  if (!meterKey) {
    return NextResponse.json({ error: 'meter_key is required' }, { status: 400 })
  }

  const quantity    = Math.max(1, Number(body.quantity ?? 1))
  const occurredAt  = body.occurred_at ? new Date(body.occurred_at).toISOString() : new Date().toISOString()

  // Validate meter_key belongs to this org (or is a platform meter)
  const { data: meter } = await supabaseServer
    .from('billing_meters')
    .select('id')
    .or(`org_id.is.null,org_id.eq.${sub.org_id}`)
    .eq('meter_key', meterKey)
    .maybeSingle()

  if (!meter) {
    return NextResponse.json({ error: `Unknown meter_key '${meterKey}'. Register it first.` }, { status: 400 })
  }

  const { data: row, error } = await supabaseServer
    .from('usage_ledger')
    .insert({
      org_id:       sub.org_id,
      meter_key:    meterKey,
      quantity,
      occurred_at:  occurredAt,
      is_simulated: false,
    })
    .select('id')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, id: row.id }, { status: 201 })
}
