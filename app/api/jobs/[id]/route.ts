import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id } = await params

  const { data: job } = await supabaseServer
    .from('jobs').select('org_id').eq('id', id).single()
  if (!job || job.org_id !== org.orgId)
    return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Delete child rows first in case DB lacks cascade rules
  await supabaseServer.from('partner_findings').delete().eq('job_id', id)
  await supabaseServer.from('partner_invoices').delete().eq('job_id', id)
  await supabaseServer.from('leakage_findings').delete().eq('job_id', id)
  await supabaseServer.from('line_items').delete().eq('job_id', id)
  await supabaseServer.from('contract_terms').delete().eq('job_id', id)

  const { error } = await supabaseServer.from('jobs').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let org
  try { org = await requireOrg() } catch (res) { return res as Response }

  const { id } = await params

  const { data: job, error } = await supabaseServer
    .from('jobs')
    .select(`
      id, name, module, status, execute_status, currency, error_message, contract_pdf_url, created_at, updated_at, billing_subscription_id, billing_platform, billing_customer_id,
      contract_terms ( * ),
      line_items ( * ),
      leakage_findings ( * ),
      partner_invoices ( * ),
      partner_findings ( * )
    `)
    .eq('id', id)
    .eq('org_id', org.orgId)
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 404 })
  return NextResponse.json(job)
}
