import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'

// DELETE /api/org/integrations/[name] — disconnect a connector (admin only)
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { name } = await params

  const { error } = await supabaseServer
    .from('org_integrations')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('org_id', org.orgId)
    .eq('connector_name', name)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
