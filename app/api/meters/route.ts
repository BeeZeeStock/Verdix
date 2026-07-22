/**
 * GET  /api/meters  — list platform meters + caller org's registered meters
 * POST /api/meters  — 3PP SaaS org registers a new billing meter
 *
 * pull_auth_token is write-only — never returned in responses.
 * pull_auth_token_set (boolean) indicates whether one is configured.
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'

type RawMeter = {
  id:                string
  org_id:            string | null
  meter_key:         string
  display_name:      string
  unit_label:        string
  description:       string | null
  pull_endpoint_url: string | null
  pull_param_name:   string
  pull_auth_token:   string | null
  created_at:        string
}

function maskMeter(m: RawMeter) {
  const { pull_auth_token, ...rest } = m
  return { ...rest, pull_auth_token_set: Boolean(pull_auth_token) }
}

export async function GET() {
  let org
  try { org = await requireOrg('member') } catch (res) { return res as Response }

  const { data: meters, error } = await supabaseServer
    .from('billing_meters')
    .select('id, org_id, meter_key, display_name, unit_label, description, pull_endpoint_url, pull_param_name, pull_auth_token, created_at')
    .or(`org_id.is.null,org_id.eq.${org.orgId}`)
    .order('meter_key')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const all = (meters ?? []) as RawMeter[]
  return NextResponse.json({
    platform_meters: all.filter(m => m.org_id === null).map(maskMeter),
    org_meters:      all.filter(m => m.org_id !== null).map(maskMeter),
  })
}

export async function POST(req: NextRequest) {
  let org
  try { org = await requireOrg('member') } catch (res) { return res as Response }

  const body = await req.json() as {
    meter_key?:         string
    display_name?:      string
    unit_label?:        string
    description?:       string
    pull_endpoint_url?: string
    pull_param_name?:   string
    pull_auth_token?:   string
  }

  const meterKey    = body.meter_key?.trim().toLowerCase().replace(/\s+/g, '_')
  const displayName = body.display_name?.trim()
  const unitLabel   = body.unit_label?.trim()

  if (!meterKey || !displayName || !unitLabel) {
    return NextResponse.json(
      { error: 'meter_key, display_name, and unit_label are required' },
      { status: 400 },
    )
  }
  if (!/^[a-z][a-z0-9_]*$/.test(meterKey)) {
    return NextResponse.json(
      { error: 'meter_key must start with a letter and contain only lowercase letters, digits, and underscores' },
      { status: 400 },
    )
  }

  const row: Record<string, unknown> = {
    org_id:       org.orgId,
    meter_key:    meterKey,
    display_name: displayName,
    unit_label:   unitLabel,
    description:  body.description?.trim() || null,
    pull_param_name: body.pull_param_name?.trim() || 'billing_parameter',
  }
  if (body.pull_endpoint_url?.trim()) row.pull_endpoint_url = body.pull_endpoint_url.trim()
  if (body.pull_auth_token?.trim())   row.pull_auth_token   = body.pull_auth_token.trim()

  const { data, error } = await supabaseServer
    .from('billing_meters')
    .insert(row)
    .select('id, org_id, meter_key, display_name, unit_label, description, pull_endpoint_url, pull_param_name, pull_auth_token, created_at')
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: `Meter key '${meterKey}' is already registered for your organisation` }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ meter: maskMeter(data as RawMeter) }, { status: 201 })
}
