import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'

// PATCH /api/jobs/[id]/line-items
// Body: { itemId: string, fields: Partial<{ product_name, unit_price, quantity, billing_period }> }
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id } = await params
  const { itemId, fields } = await req.json()

  if (!itemId || !fields || Object.keys(fields).length === 0) {
    return NextResponse.json({ error: 'itemId and fields are required' }, { status: 400 })
  }

  const { data: ownedJob } = await supabaseServer
    .from('jobs')
    .select('id')
    .eq('id', id)
    .eq('org_id', org.orgId)
    .maybeSingle()
  if (!ownedJob) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  const allowed = ['product_name', 'unit_price', 'quantity', 'billing_period', 'total_amount', 'confidence_score']
  const update: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) update[k] = v
  }

  const { error } = await supabaseServer
    .from('line_items')
    .update(update)
    .eq('id', itemId)
    .eq('job_id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
