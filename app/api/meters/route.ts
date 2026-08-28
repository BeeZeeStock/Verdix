/**
 * GET   /api/meters — list the caller's own organization's sources
 *                     (billing_meters where org_id = caller's org)
 * POST  /api/meters — org admin/owner registers a new billing meter,
 *                     optionally connector-backed (Step 17D, item 7)
 * PATCH /api/meters — org admin/owner edits an existing meter's config
 *
 * pull_auth_token is write-only — never returned in responses.
 * pull_auth_token_set (boolean) indicates whether one is configured.
 *
 * Step 17D.1, item A — billing_meters.org_id IS the ownership authority
 * (audited: no separate owner_org_id column — org_id already meant "the
 * owning organization"; NULL was only the legacy platform-catalog
 * convention, now retired and NOT NULL). The caller's organization always
 * comes from requireOrg()'s own session resolution; nothing in the
 * request body can name a different org_id (item E's explicit
 * constraint). A Verdix admin operating on behalf of a design-partner org
 * (e.g. Remembill) uses the SEPARATE app/api/admin/meters/route.ts, which
 * explicitly resolves and validates that target org rather than trusting
 * arbitrary request data.
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'

type RawMeter = {
  id:                  string
  org_id:              string
  meter_key:           string
  display_name:        string
  unit_label:          string
  description:         string | null
  semantic_input_key:  string | null
  pull_endpoint_url:   string | null
  pull_param_name:     string
  pull_auth_token:     string | null
  mode:                'test' | 'live'
  test_usage_value:    number | null
  connector:           string | null
  response_metric_key: string | null
  created_at:          string
}

const METER_SELECT = 'id, org_id, meter_key, display_name, unit_label, description, semantic_input_key, pull_endpoint_url, pull_param_name, pull_auth_token, mode, test_usage_value, connector, response_metric_key, created_at'

// Step 17D, item 7/17 — no new connector types in this step. A meter is
// either the hard-coded Remembill client (connector: 'remembill') or the
// existing generic pull_endpoint_url mechanism (connector: null) — never
// an arbitrary string, which would silently create an unreachable meter.
const SUPPORTED_CONNECTORS = new Set<string | null>(['remembill', null])

function maskMeter(m: RawMeter) {
  const { pull_auth_token, ...rest } = m
  return { ...rest, pull_auth_token_set: Boolean(pull_auth_token) }
}

export async function GET() {
  let org
  try { org = await requireOrg('member') } catch (res) { return res as Response }

  // Step 17D.1, item A/2/3 — Company B must never see Remembill's meters,
  // and vice versa. org_id is the sole visibility boundary for this
  // route — no more platform-global org_id IS NULL catalog, no more
  // isRemembillTeam()/isAdmin() domain-based carve-outs. Once the 5
  // Remembill meters are migrated to org_id = CoAccept's org (item 15), a
  // CoAccept member sees them through this exact same query, with no
  // special-casing needed at all.
  // Step 17D.2, item A — is_platform_meter=false is explicit, not merely
  // implied by the org_id match: a genuine internal Verdix system meter
  // (sync/api_call/user) must never appear in a customer's Meter GUI even
  // in principle, so this route states that boundary directly rather than
  // relying on the coincidence that today's platform meters happen to
  // carry org_id IS NULL.
  const { data: meters, error } = await supabaseServer
    .from('billing_meters')
    .select(METER_SELECT)
    .eq('org_id', org.orgId)
    .eq('is_platform_meter', false)
    .order('meter_key')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ meters: ((meters ?? []) as RawMeter[]).map(maskMeter) })
}

export async function PATCH(req: NextRequest) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const body = await req.json() as {
    id:                   string
    pull_endpoint_url?:   string | null
    pull_auth_token?:     string
    clear_auth_token?:    boolean
    pull_param_name?:     string
    mode?:                'test' | 'live'
    test_usage_value?:    number | null
    semantic_input_key?:  string | null
    response_metric_key?: string | null
  }

  if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  // Step 17D, item 6 — org admin/owner only (requireOrg('admin') above);
  // a plain member can view/confirm mappings elsewhere but never reaches
  // this route to edit endpoint/credential fields.
  // Step 17D.2, item A — is_platform_meter=false, explicit: a customer-org
  // admin must never be able to edit a genuine Verdix system meter, even
  // in the (constraint-permitted but never actually used) edge case where
  // one somehow also carried a real org_id.
  const { data: existing } = await supabaseServer
    .from('billing_meters')
    .select('id, org_id, pull_endpoint_url')
    .eq('id', body.id)
    .eq('org_id', org.orgId)
    .eq('is_platform_meter', false)
    .maybeSingle()

  if (!existing) return NextResponse.json({ error: 'Meter not found' }, { status: 404 })

  const patch: Record<string, unknown> = {}
  if (body.pull_endpoint_url !== undefined) patch.pull_endpoint_url = body.pull_endpoint_url?.trim() || null
  if (body.pull_param_name?.trim())         patch.pull_param_name   = body.pull_param_name.trim()
  if (body.clear_auth_token)                patch.pull_auth_token   = null
  else if (body.pull_auth_token?.trim())    patch.pull_auth_token   = body.pull_auth_token.trim()
  if (body.test_usage_value !== undefined) {
    patch.test_usage_value      = body.test_usage_value
    patch.test_usage_updated_at = new Date().toISOString()
  }
  if (body.semantic_input_key !== undefined) patch.semantic_input_key = body.semantic_input_key?.trim() || null
  if (body.response_metric_key !== undefined) patch.response_metric_key = body.response_metric_key?.trim() || null

  if (body.mode) {
    if (body.mode === 'live') {
      const endpointAfterPatch = (patch.pull_endpoint_url as string | undefined) ?? existing.pull_endpoint_url
      if (!endpointAfterPatch) {
        return NextResponse.json({ error: 'Cannot go live without a pull endpoint URL configured' }, { status: 400 })
      }
    }
    patch.mode = body.mode
  }

  const { data, error } = await supabaseServer
    .from('billing_meters')
    .update(patch)
    .eq('id', body.id)
    .select(METER_SELECT)
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ meter: maskMeter(data as RawMeter) })
}

export async function POST(req: NextRequest) {
  // Step 17D, item 6 — meter creation (endpoint/credential configuration)
  // requires org admin/owner, not merely 'member'. A member can still see
  // that a source is missing and confirm an existing mapping via the
  // meter-mappings route — never reaches this route.
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const body = await req.json() as {
    meter_key?:           string
    display_name?:        string
    unit_label?:          string
    description?:         string
    semantic_input_key?:  string
    connector?:            string | null
    response_metric_key?: string
    pull_endpoint_url?:   string
    pull_param_name?:     string
    pull_auth_token?:     string
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

  const connector = body.connector?.trim() || null
  if (!SUPPORTED_CONNECTORS.has(connector)) {
    return NextResponse.json({ error: `connector '${connector}' is not supported — use 'remembill' or omit for a generic HTTP-pulled meter` }, { status: 400 })
  }
  if (connector === 'remembill' && !body.response_metric_key?.trim()) {
    return NextResponse.json({ error: 'response_metric_key is required for a remembill-connector meter' }, { status: 400 })
  }

  const row: Record<string, unknown> = {
    // Step 17D.1, item E — org_id is ALWAYS the caller's own resolved org
    // (requireOrg above), never taken from the request body.
    org_id:              org.orgId,
    meter_key:           meterKey,
    display_name:        displayName,
    unit_label:          unitLabel,
    description:         body.description?.trim() || null,
    semantic_input_key:  body.semantic_input_key?.trim() || null,
    connector,
    response_metric_key: body.response_metric_key?.trim() || null,
    pull_param_name:     body.pull_param_name?.trim() || 'billing_parameter',
  }
  if (body.pull_endpoint_url?.trim()) row.pull_endpoint_url = body.pull_endpoint_url.trim()
  if (body.pull_auth_token?.trim())   row.pull_auth_token   = body.pull_auth_token.trim()

  const { data, error } = await supabaseServer
    .from('billing_meters')
    .insert(row)
    .select(METER_SELECT)
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: `Meter key '${meterKey}' is already registered for your organisation` }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ meter: maskMeter(data as RawMeter) }, { status: 201 })
}

export async function DELETE(req: NextRequest) {
  // Step 17D.1, item E — org admin/owner can remove their own org's meter
  // directly, without needing the separate Verdix-admin design-partner
  // path (app/api/admin/meters/route.ts), which requireAdmin()-gates and
  // is not reachable by an ordinary org admin at all.
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const { data: meter } = await supabaseServer
    .from('billing_meters')
    .select('id, meter_key')
    .eq('id', id)
    .eq('org_id', org.orgId)
    .eq('is_platform_meter', false)
    .maybeSingle()
  if (!meter) return NextResponse.json({ error: 'Meter not found' }, { status: 404 })

  const { count } = await supabaseServer
    .from('org_billing_config')
    .select('id', { count: 'exact', head: true })
    .eq('meter_key', meter.meter_key)
    .eq('active', true)

  if ((count ?? 0) > 0) {
    return NextResponse.json(
      { error: `Cannot delete — ${count} active billing config(s) reference this meter. Deactivate them first.` },
      { status: 409 },
    )
  }

  const { error } = await supabaseServer.from('billing_meters').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
