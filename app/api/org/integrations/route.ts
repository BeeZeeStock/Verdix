import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'

const ALLOWED_CONNECTORS = new Set([
  'stripe', 'chargebee', 'zuora', 'maxio', 'recurly', 'quickbooks', 'xero',
  'hubspot', 'salesforce', 'pipedrive', 'attio',
])

const CONNECTOR_TYPES: Record<string, 'billing' | 'crm'> = {
  stripe: 'billing', chargebee: 'billing', zuora: 'billing',
  maxio: 'billing', recurly: 'billing', quickbooks: 'billing', xero: 'billing',
  hubspot: 'crm', salesforce: 'crm', pipedrive: 'crm', attio: 'crm',
}

// GET /api/org/integrations — list connected integrations (omits config values)
export async function GET() {
  let org
  try { org = await requireOrg('member') } catch (res) { return res as Response }

  const { data, error } = await supabaseServer
    .from('org_integrations')
    .select('id, connector_type, connector_name, is_active, created_at')
    .eq('org_id', org.orgId)
    .order('created_at', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ integrations: data ?? [] })
}

// POST /api/org/integrations — save or update connector credentials (admin only)
export async function POST(req: NextRequest) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const body = await req.json()
  const { connector_name, config } = body

  if (!connector_name || !ALLOWED_CONNECTORS.has(connector_name)) {
    return NextResponse.json({ error: 'Unknown connector' }, { status: 400 })
  }
  if (!config || typeof config !== 'object') {
    return NextResponse.json({ error: 'config is required' }, { status: 400 })
  }

  const { error } = await supabaseServer
    .from('org_integrations')
    .upsert({
      org_id:         org.orgId,
      connector_type: CONNECTOR_TYPES[connector_name],
      connector_name,
      config,
      is_active:      true,
      updated_at:     new Date().toISOString(),
    }, { onConflict: 'org_id,connector_name' })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
