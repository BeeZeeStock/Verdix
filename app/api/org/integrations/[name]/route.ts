import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'

// PATCH /api/org/integrations/[name] — merge config keys without disconnecting (admin only)
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { name } = await params
  const { config } = await req.json() as { config: Record<string, string> }
  if (!config || typeof config !== 'object') {
    return NextResponse.json({ error: 'config is required' }, { status: 400 })
  }

  const { data: existing } = await supabaseServer
    .from('org_integrations')
    .select('config')
    .eq('org_id', org.orgId)
    .eq('connector_name', name)
    .eq('is_active', true)
    .maybeSingle()

  if (!existing) return NextResponse.json({ error: 'Integration not found' }, { status: 404 })

  const merged = { ...(existing.config as object ?? {}), ...config }

  const { error } = await supabaseServer
    .from('org_integrations')
    .update({ config: merged, updated_at: new Date().toISOString() })
    .eq('org_id', org.orgId)
    .eq('connector_name', name)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

// DELETE /api/org/integrations/[name] — disconnect a connector (admin only)
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { name } = await params

  // Delete the auto-registered webhook from the org's Stripe account on disconnect.
  if (name === 'stripe') {
    const { data: integration } = await supabaseServer
      .from('org_integrations')
      .select('config')
      .eq('org_id', org.orgId)
      .eq('connector_name', 'stripe')
      .eq('is_active', true)
      .maybeSingle()

    const cfg = (integration?.config ?? {}) as Record<string, string>
    if (cfg.webhook_endpoint_id && cfg.secret_key) {
      try {
        const { default: Stripe } = await import('stripe')
        const stripe = new Stripe(cfg.secret_key, { apiVersion: '2026-06-24.dahlia' })
        await stripe.webhookEndpoints.del(cfg.webhook_endpoint_id).catch(() => null)
      } catch { /* best-effort */ }
    }
  }

  const { error } = await supabaseServer
    .from('org_integrations')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('org_id', org.orgId)
    .eq('connector_name', name)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
