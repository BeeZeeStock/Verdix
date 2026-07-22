/**
 * GET  /api/admin/meters — all meters (platform + all org-registered), admin only
 * POST /api/admin/meters — add/update/delete meters (admin only)
 *   action='add'    — create a new meter (platform if no org_id)
 *   action='update' — edit fields; pull_auth_token only updated when explicitly provided
 *   action='delete' — remove (blocked if active org_billing_config references it)
 *
 * pull_auth_token is write-only — never returned in responses.
 * pull_auth_token_set (boolean) indicates whether one is configured.
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin'
import { supabaseServer } from '@/lib/supabase'

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

function maskMeter(m: RawMeter & { org_name?: string | null }) {
  const { pull_auth_token, ...rest } = m
  return { ...rest, pull_auth_token_set: Boolean(pull_auth_token) }
}

export async function GET() {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }

  const [metersRes, orgsRes] = await Promise.all([
    supabaseServer
      .from('billing_meters')
      .select('id, org_id, meter_key, display_name, unit_label, description, pull_endpoint_url, pull_param_name, pull_auth_token, created_at')
      .order('org_id', { nullsFirst: true })
      .order('meter_key'),
    supabaseServer
      .from('organizations')
      .select('id, name'),
  ])

  const orgMap = new Map((orgsRes.data ?? []).map((o: { id: string; name: string }) => [o.id, o.name]))

  const meters = (metersRes.data ?? []).map((m: RawMeter) =>
    maskMeter({ ...m, org_name: m.org_id ? (orgMap.get(m.org_id) ?? m.org_id) : null }),
  )

  return NextResponse.json({ meters })
}

export async function POST(req: NextRequest) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }

  const body = await req.json() as {
    action:             'add' | 'update' | 'delete'
    id?:                string
    org_id?:            string | null
    meter_key?:         string
    display_name?:      string
    unit_label?:        string
    description?:       string
    pull_endpoint_url?: string
    pull_param_name?:   string
    pull_auth_token?:   string   // present = update; absent = leave unchanged
    clear_auth_token?:  boolean  // explicit null-out
  }

  // ── Add meter ─────────────────────────────────────────────────────────────────
  if (body.action === 'add') {
    const meterKey    = body.meter_key?.trim().toLowerCase().replace(/\s+/g, '_')
    const displayName = body.display_name?.trim()
    const unitLabel   = body.unit_label?.trim()

    if (!meterKey || !displayName || !unitLabel) {
      return NextResponse.json({ error: 'meter_key, display_name, and unit_label are required' }, { status: 400 })
    }
    if (!/^[a-z][a-z0-9_]*$/.test(meterKey)) {
      return NextResponse.json({ error: 'meter_key must be lowercase letters, digits, and underscores' }, { status: 400 })
    }

    const row: Record<string, unknown> = {
      org_id:          body.org_id ?? null,
      meter_key:       meterKey,
      display_name:    displayName,
      unit_label:      unitLabel,
      description:     body.description?.trim() || null,
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
      if (error.code === '23505') return NextResponse.json({ error: `Meter '${meterKey}' already exists` }, { status: 409 })
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ meter: maskMeter(data as RawMeter) }, { status: 201 })
  }

  // ── Update meter ──────────────────────────────────────────────────────────────
  if (body.action === 'update') {
    if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 })

    const patch: Record<string, unknown> = {}
    if (body.display_name?.trim())      patch.display_name    = body.display_name.trim()
    if (body.unit_label?.trim())        patch.unit_label      = body.unit_label.trim()
    if (body.description !== undefined) patch.description     = body.description?.trim() || null
    if (body.pull_endpoint_url !== undefined) patch.pull_endpoint_url = body.pull_endpoint_url?.trim() || null
    if (body.pull_param_name?.trim())   patch.pull_param_name = body.pull_param_name.trim()
    // Token: only update if explicitly provided; clear if clear_auth_token flag set
    if (body.clear_auth_token)          patch.pull_auth_token = null
    else if (body.pull_auth_token?.trim()) patch.pull_auth_token = body.pull_auth_token.trim()

    const { data, error } = await supabaseServer
      .from('billing_meters')
      .update(patch)
      .eq('id', body.id)
      .select('id, org_id, meter_key, display_name, unit_label, description, pull_endpoint_url, pull_param_name, pull_auth_token, created_at')
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ meter: maskMeter(data as RawMeter) })
  }

  // ── Delete meter ──────────────────────────────────────────────────────────────
  if (body.action === 'delete') {
    if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 })

    const { data: meter } = await supabaseServer
      .from('billing_meters')
      .select('meter_key')
      .eq('id', body.id)
      .single()

    if (meter) {
      const { count } = await supabaseServer
        .from('org_billing_config')
        .select('id', { count: 'exact', head: true })
        .eq('meter_key', (meter as { meter_key: string }).meter_key)
        .eq('active', true)

      if ((count ?? 0) > 0) {
        return NextResponse.json(
          { error: `Cannot delete — ${count} active billing config(s) reference this meter. Deactivate them first.` },
          { status: 409 },
        )
      }
    }

    const { error } = await supabaseServer.from('billing_meters').delete().eq('id', body.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
