/**
 * POST /api/jobs/[id]/remembill-probe
 * Diagnostic endpoint: creates a real Remembill draft invoice for this job's
 * customer, tries several candidate row-field combinations, then deletes the
 * invoice so nothing is left in Remembill. Returns the full request/response
 * for every attempt so we can see which field names Remembill actually accepts.
 *
 * Call once from the browser console or curl — remove this file after use.
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
    .select('org_id, billing_customer_id, contract_terms(currency, payment_terms_days)')
    .eq('id', jobId)
    .eq('org_id', org.orgId)
    .single()

  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  if (!job.billing_customer_id) return NextResponse.json({ error: 'No billing_customer_id on this job' }, { status: 400 })

  const { data: rbIntegration } = await supabaseServer
    .from('org_integrations')
    .select('config')
    .eq('org_id', org.orgId)
    .eq('connector_name', 'remembill')
    .eq('is_active', true)
    .maybeSingle()

  const rbKey = (rbIntegration?.config as Record<string, string>)?.api_key ?? process.env.REMEMBILL_API_KEY!
  const h = remembillHeaders(rbKey)

  const termsArr = job.contract_terms as unknown as Array<{ currency?: string; payment_terms_days?: number | null }>
  const terms = termsArr?.[0] ?? {}
  const cur = (terms.currency ?? 'SEK').toUpperCase()
  const today = new Date().toISOString().slice(0, 10)
  const due   = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)

  // 1. Create a temporary draft invoice
  const invRes = await fetch(`${REMEMBILL_BASE}/invoices`, {
    method: 'POST', headers: h,
    body: JSON.stringify({
      customer_id: job.billing_customer_id,
      currency:    cur,
      issue_date:  today,
      due_date:    due,
      payment_terms: 'Net 30',
    }),
  })
  const invBody = await invRes.text()
  if (!invRes.ok) {
    return NextResponse.json({ step: 'invoice_create', status: invRes.status, body: invBody }, { status: 502 })
  }
  const invJson = JSON.parse(invBody) as Record<string, unknown>
  const invObj  = (invJson.invoice ?? invJson.data ?? invJson) as Record<string, unknown>
  const invoiceId = invObj.id as string
  if (!invoiceId) {
    return NextResponse.json({ step: 'invoice_create', error: 'could not extract id', body: invBody }, { status: 502 })
  }

  // 2. Try several candidate row-body combinations and collect results
  const candidates = [
    { label: 'unit_price öre + vat_rate 0',   body: { description: 'Probe row', quantity: 1, unit_price: 100_00, vat_rate: 0 } },
    { label: 'unit_price öre, no vat_rate',    body: { description: 'Probe row', quantity: 1, unit_price: 100_00 } },
    { label: 'price öre + vat_rate 0',         body: { description: 'Probe row', quantity: 1, price: 100_00, vat_rate: 0 } },
    { label: 'price öre, no vat_rate',         body: { description: 'Probe row', quantity: 1, price: 100_00 } },
    { label: 'amount öre (no quantity)',        body: { description: 'Probe row', amount: 100_00 } },
    { label: 'unit_price kronor (100.00)',      body: { description: 'Probe row', quantity: 1, unit_price: 100.00, vat_rate: 0 } },
    { label: 'price kronor (100.00)',           body: { description: 'Probe row', quantity: 1, price: 100.00, vat_rate: 0 } },
    { label: 'unit_amount öre + vat_rate 0',   body: { description: 'Probe row', quantity: 1, unit_amount: 100_00, vat_rate: 0 } },
  ]

  const results: Array<{ label: string; reqBody: unknown; status: number; resBody: string }> = []

  for (const c of candidates) {
    const r = await fetch(`${REMEMBILL_BASE}/invoices/${invoiceId}/rows`, {
      method: 'POST', headers: h,
      body: JSON.stringify(c.body),
    })
    const rb = await r.text()
    results.push({ label: c.label, reqBody: c.body, status: r.status, resBody: rb })
    // Stop at first success so we don't add duplicate rows
    if (r.ok) break
  }

  // 3. Inspect the invoice after row attempts to see what it contains
  const getRes = await fetch(`${REMEMBILL_BASE}/invoices/${invoiceId}`, { headers: h })
  const getBody = await getRes.text()

  // 4. Delete the test invoice
  await fetch(`${REMEMBILL_BASE}/invoices/${invoiceId}`, { method: 'DELETE', headers: h })

  return NextResponse.json({
    invoiceId,
    invoiceCreateResponse: invBody,
    rowAttempts: results,
    invoiceAfterRows: getBody,
  })
}
