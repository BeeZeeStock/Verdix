/**
 * GET  /api/admin/meters — meters Verdix platform admins may see: their
 *                          own org's, plus any design-partner org's
 * POST /api/admin/meters — add/update/delete meters, Verdix-admin path
 *   action='add'    — create a meter owned by a TARGET org (body.target_org_id)
 *   action='update' — edit fields; pull_auth_token only updated when explicitly provided
 *   action='delete' — remove (blocked if active org_billing_config references it)
 *
 * pull_auth_token is write-only — never returned in responses.
 * pull_auth_token_set (boolean) indicates whether one is configured.
 *
 * Step 17D/17D.1, item 3/6/16 — replaces the old blanket requireAdmin()-
 * only gate. A Verdix platform admin may only manage a target org's
 * sources while that org's lifecycle_stage is 'design_partner'
 * (lib/org-lifecycle.ts) — for a production customer, platform-admin
 * status alone grants NO ordinary cross-tenant management here. The
 * target org is validated server-side against this authorization model on
 * every call — never trusted from the request body alone ("not arbitrary
 * request data"). billing_meters.org_id (audited, item A of 17D.1) IS the
 * ownership authority — no separate owner_org_id column.
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin'
import { supabaseServer } from '@/lib/supabase'
import { resolveSourceManagementAuthorization } from '@/lib/org-lifecycle'

type RawMeter = {
  id:                  string
  org_id:              string | null
  is_platform_meter:   boolean
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

const METER_SELECT = 'id, org_id, is_platform_meter, meter_key, display_name, unit_label, description, semantic_input_key, pull_endpoint_url, pull_param_name, pull_auth_token, mode, test_usage_value, connector, response_metric_key, created_at'
const SUPPORTED_CONNECTORS = new Set<string | null>(['remembill', null])

function maskMeter(m: RawMeter & { org_name?: string | null }) {
  const { pull_auth_token, ...rest } = m
  return { ...rest, pull_auth_token_set: Boolean(pull_auth_token) }
}

export async function GET() {
  let adminEmail: string
  try { adminEmail = await requireAdmin() } catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }

  const [metersRes, orgsRes] = await Promise.all([
    supabaseServer.from('billing_meters').select(METER_SELECT).order('org_id').order('meter_key'),
    supabaseServer.from('organizations').select('id, name, lifecycle_stage'),
  ])

  const orgs = (orgsRes.data ?? []) as Array<{ id: string; name: string; lifecycle_stage: string }>
  const orgMap = new Map(orgs.map(o => [o.id, o]))
  // Step 17D, item 3/6 — a platform admin's OWN org is always visible (they
  // manage their own Verdix-owned meters normally); a design_partner org's
  // meters are visible for testing/support; a production customer's are
  // NOT, even to a platform admin, unless they also happen to be a real
  // member of that org (not checked here — this route is the elevated-
  // access path specifically, member access goes through /api/meters).
  const { data: adminMembership } = await supabaseServer
    .from('org_memberships').select('org_id').eq('user_email', adminEmail).eq('status', 'active')
  const adminOwnOrgIds = new Set((adminMembership ?? []).map(m => m.org_id as string))

  const visibleOrgIds = new Set(
    orgs.filter(o => o.lifecycle_stage === 'design_partner' || adminOwnOrgIds.has(o.id)).map(o => o.id),
  )

  // Step 17D.2, item A — a genuine platform-system meter (is_platform_meter
  // true, org_id null) is never in visibleOrgIds at all (it belongs to no
  // org), so the plain org-membership filter below would silently drop
  // sync/api_call/user from THIS Verdix-admin-only surface entirely — the
  // one place they're legitimately supposed to remain manageable (their
  // own pull-endpoint configuration). Included via a separate, explicit
  // is_platform_meter check, never by loosening the org-based filter
  // itself — this route is still requireAdmin()-gated end to end, so a
  // customer-org admin can never reach this branch regardless.
  const meters = ((metersRes.data ?? []) as RawMeter[])
    .filter(m => m.is_platform_meter || (m.org_id != null && visibleOrgIds.has(m.org_id)))
    .map(m => maskMeter({ ...m, org_name: m.org_id ? (orgMap.get(m.org_id)?.name ?? m.org_id) : null }))

  return NextResponse.json({ meters })
}

export async function POST(req: NextRequest) {
  let adminEmail: string
  try { adminEmail = await requireAdmin() } catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }

  const body = await req.json() as {
    action:               'add' | 'update' | 'delete'
    id?:                  string
    target_org_id?:       string
    meter_key?:           string
    display_name?:        string
    unit_label?:          string
    description?:         string
    semantic_input_key?:  string
    connector?:           string | null
    response_metric_key?: string
    pull_endpoint_url?:   string
    pull_param_name?:     string
    pull_auth_token?:     string
    clear_auth_token?:    boolean
    mode?:                'test' | 'live'
    test_usage_value?:    number | null
  }

  // ── Add meter ─────────────────────────────────────────────────────────────────
  if (body.action === 'add') {
    if (!body.target_org_id) {
      return NextResponse.json({ error: 'target_org_id is required — a source must always belong to a real customer organization' }, { status: 400 })
    }
    // Step 17D, item 7 — the target org is VALIDATED against the real
    // authorization model here, not merely accepted because a platform
    // admin sent it in the request body.
    const authz = await resolveSourceManagementAuthorization(body.target_org_id, adminEmail)
    if (!authz.canManageSources) {
      return NextResponse.json({ error: `Not authorized to manage sources for this organization (${authz.reason})` }, { status: 403 })
    }

    const meterKey    = body.meter_key?.trim().toLowerCase().replace(/\s+/g, '_')
    const displayName = body.display_name?.trim()
    const unitLabel   = body.unit_label?.trim()

    if (!meterKey || !displayName || !unitLabel) {
      return NextResponse.json({ error: 'meter_key, display_name, and unit_label are required' }, { status: 400 })
    }
    if (!/^[a-z][a-z0-9_]*$/.test(meterKey)) {
      return NextResponse.json({ error: 'meter_key must be lowercase letters, digits, and underscores' }, { status: 400 })
    }

    const connector = body.connector?.trim() || null
    if (!SUPPORTED_CONNECTORS.has(connector)) {
      return NextResponse.json({ error: `connector '${connector}' is not supported — use 'remembill' or omit for a generic HTTP-pulled meter` }, { status: 400 })
    }
    if (connector === 'remembill' && !body.response_metric_key?.trim()) {
      return NextResponse.json({ error: 'response_metric_key is required for a remembill-connector meter' }, { status: 400 })
    }

    const row: Record<string, unknown> = {
      org_id:              body.target_org_id,
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
      if (error.code === '23505') return NextResponse.json({ error: `Meter '${meterKey}' already exists` }, { status: 409 })
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ meter: maskMeter(data as RawMeter) }, { status: 201 })
  }

  // ── Update meter ──────────────────────────────────────────────────────────────
  if (body.action === 'update') {
    if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 })

    const { data: target } = await supabaseServer.from('billing_meters').select('org_id, is_platform_meter, pull_endpoint_url, connector').eq('id', body.id).maybeSingle()
    if (!target) return NextResponse.json({ error: 'Meter not found' }, { status: 404 })

    // Step 17D.2, item A — a genuine platform-system meter has no owning
    // org to check tenant authorization against at all (resolveSource
    // ManagementAuthorization would otherwise default a null org_id's
    // lifecycle to 'production_customer' and reject even a real Verdix
    // admin). This route is already requireAdmin()-gated end to end, so
    // any admin who reaches here may manage it directly — never reachable
    // by a customer-org admin, who never passes requireAdmin().
    if (!target.is_platform_meter) {
      const authz = await resolveSourceManagementAuthorization(target.org_id as string, adminEmail)
      if (!authz.canManageSources) {
        return NextResponse.json({ error: `Not authorized to manage sources for this organization (${authz.reason})` }, { status: 403 })
      }
    }

    const patch: Record<string, unknown> = {}
    if (body.display_name?.trim())      patch.display_name    = body.display_name.trim()
    if (body.unit_label?.trim())        patch.unit_label      = body.unit_label.trim()
    if (body.description !== undefined) patch.description     = body.description?.trim() || null
    if (body.semantic_input_key !== undefined) patch.semantic_input_key = body.semantic_input_key?.trim() || null
    if (body.response_metric_key !== undefined) patch.response_metric_key = body.response_metric_key?.trim() || null
    if (body.pull_endpoint_url !== undefined) patch.pull_endpoint_url = body.pull_endpoint_url?.trim() || null
    if (body.pull_param_name?.trim())   patch.pull_param_name = body.pull_param_name.trim()
    if (body.clear_auth_token)          patch.pull_auth_token = null
    else if (body.pull_auth_token?.trim()) patch.pull_auth_token = body.pull_auth_token.trim()
    if (body.test_usage_value !== undefined) {
      patch.test_usage_value      = body.test_usage_value
      patch.test_usage_updated_at = new Date().toISOString()
    }

    if (body.mode) {
      if (body.mode === 'live') {
        if (!target.connector) {
          const endpointAfterPatch = (patch.pull_endpoint_url as string | undefined) ?? target.pull_endpoint_url
          if (!endpointAfterPatch) {
            return NextResponse.json({ error: 'Cannot go live without a pull endpoint URL configured' }, { status: 400 })
          }
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

  // ── Delete meter ──────────────────────────────────────────────────────────────
  if (body.action === 'delete') {
    if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 })

    const { data: meter } = await supabaseServer.from('billing_meters').select('meter_key, org_id, is_platform_meter').eq('id', body.id).single()
    if (!meter) return NextResponse.json({ error: 'Meter not found' }, { status: 404 })

    // Step 17D.2, item A — see the identical branch in the update path above.
    if (!meter.is_platform_meter) {
      const authz = await resolveSourceManagementAuthorization(meter.org_id as string, adminEmail)
      if (!authz.canManageSources) {
        return NextResponse.json({ error: `Not authorized to manage sources for this organization (${authz.reason})` }, { status: 403 })
      }
    }

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

    const { error } = await supabaseServer.from('billing_meters').delete().eq('id', body.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
