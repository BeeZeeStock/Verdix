import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'

export async function GET() {
  let org
  try { org = await requireOrg() } catch (res) { return res as Response }

  const { data, error } = await supabaseServer
    .from('jobs')
    .select('id, name, module, status, execute_status, currency, created_at, updated_at')
    .eq('org_id', org.orgId)
    .order('created_at', { ascending: false })
    .limit(100)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function POST(req: NextRequest) {
  let org
  try { org = await requireOrg('member') } catch (res) { return res as Response }

  const body = await req.json()
  const { name, module, currency = 'USD' } = body

  if (!name || !module) {
    return NextResponse.json({ error: 'name and module are required' }, { status: 400 })
  }

  const { data, error } = await supabaseServer
    .from('jobs')
    .insert({
      name,
      module,
      currency,
      status: 'PENDING',
      execute_status: 'PENDING',
      user_id: org.userEmail,
      org_id: org.orgId,
    })
    .select('id')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ jobId: data.id }, { status: 201 })
}
