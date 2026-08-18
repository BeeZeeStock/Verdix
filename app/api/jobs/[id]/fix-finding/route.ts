import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id } = await params
  const { findingId, fixType, note } = await req.json()

  if (!findingId) return NextResponse.json({ error: 'findingId required' }, { status: 400 })

  const { data: ownedJob } = await supabaseServer
    .from('jobs')
    .select('id')
    .eq('id', id)
    .eq('org_id', org.orgId)
    .maybeSingle()
  if (!ownedJob) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  const { error } = await supabaseServer
    .from('leakage_findings')
    .update({
      status: fixType === 'dismiss' ? 'dismissed' : 'fix_queued',
      fix_note: note ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', findingId)
    .eq('job_id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, findingId, fixType })
}
