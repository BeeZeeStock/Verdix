/**
 * POST /api/jobs/[id]/remembill-probe
 * Diagnostic endpoint — remove after confirming correct row format.
 * Now tests "name" (not "description") as the required label field.
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { REMEMBILL_BASE, remembillHeaders } from '@/lib/billing-writer'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id: jobId } = await params

  const { data: job } = await supabaseServer
    .from('jobs')
    .select('org_id, billing_customer_id, contract_terms(currency)')
    .eq('id', jobId)
    .eq('org_id', org.orgId)
    .single()

  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  if (!job.billing_customer_id) return NextResponse.json({ error: 'No billing_customer_id on this job' }, { status: 400 })

  const { data: rbIntegration } = await supabaseServer
    .from('org_integrations').select('config')
    .eq('org_id', org.orgId).eq('connector_name', 'remembill').eq('is_active', true).maybeSingle()

  const rbKey = (rbIntegration?.config as Record<string, string>)?.api_key ?? process.env.REMEMBILL_API_KEY!
  const h = remembillHeaders(rbKey)

  const termsArr = job.contract_terms as unknown as Array<{ currency?: string }>
  const cur = ((termsArr?.[0]?.currency) ?? 'SEK').toUpperCase()
  const today = new Date().toISOString().slice(0, 10)
  const due   = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)

  // Create a fresh draft invoice for the test
  const invRes  = await fetch(`${REMEMBILL_BASE}/invoices`, {
    method: 'POST', headers: h,
    body: JSON.stringify({ customer_id: job.billing_customer_id, currency: cur, issue_date: today, due_date: due, payment_terms: 'Net 30' }),
  })
  const invBody = await invRes.text()
  if (!invRes.ok) return NextResponse.json({ step: 'invoice_create_failed', status: invRes.status, body: invBody }, { status: 502 })

  const invJson  = JSON.parse(invBody) as Record<string, unknown>
  const invoiceId = ((invJson.invoice ?? invJson.data ?? invJson) as Record<string, unknown>).id as string
  if (!invoiceId) return NextResponse.json({ step: 'no_id', body: invBody }, { status: 502 })

  // All candidates now use "name" — vary the amount field and units
  const ORE    = 10000     // 100.00 SEK in öre
  const KRONOR = 100.00    // 100.00 SEK in kronor

  const candidates = [
    { label: 'name + unit_price öre',    body: { name: 'Probe row', quantity: 1, unit_price: ORE,    vat_rate: 0 } },
    { label: 'name + unit_price kronor', body: { name: 'Probe row', quantity: 1, unit_price: KRONOR, vat_rate: 0 } },
    { label: 'name + price öre',         body: { name: 'Probe row', quantity: 1, price: ORE,         vat_rate: 0 } },
    { label: 'name + price kronor',      body: { name: 'Probe row', quantity: 1, price: KRONOR,      vat_rate: 0 } },
    { label: 'name + amount öre',        body: { name: 'Probe row', amount: ORE } },
    { label: 'name + amount kronor',     body: { name: 'Probe row', amount: KRONOR } },
    { label: 'name only (no amount)',    body: { name: 'Probe row', quantity: 1 } },
  ]

  const results: Array<{ label: string; reqBody: unknown; status: number; resBody: string; ok: boolean }> = []
  for (const c of candidates) {
    const r  = await fetch(`${REMEMBILL_BASE}/invoices/${invoiceId}/rows`, { method: 'POST', headers: h, body: JSON.stringify(c.body) })
    const rb = await r.text()
    results.push({ label: c.label, reqBody: c.body, status: r.status, resBody: rb, ok: r.ok })
    if (r.ok) break
  }

  const getBody = await fetch(`${REMEMBILL_BASE}/invoices/${invoiceId}`, { headers: h }).then(r => r.text())
  await fetch(`${REMEMBILL_BASE}/invoices/${invoiceId}`, { method: 'DELETE', headers: h })

  const winner = results.find(r => r.ok)
  const loser  = results.find(r => !r.ok)

  return NextResponse.json({
    invoiceId,
    winner: winner ? { label: winner.label, reqBody: winner.reqBody, resBody: winner.resBody } : null,
    firstFailure: loser ? { label: loser.label, status: loser.status, resBody: loser.resBody } : null,
    allStatuses: results.map(r => `${r.label} → HTTP ${r.status}${r.ok ? ' ✓' : ''}`),
    invoiceAfterRows: getBody,
  })
}
