/**
 * POST /api/jobs/[id]/remembill-probe
 * Diagnostic endpoint — remove after use.
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

  // ── Step A: fetch available number series ──────────────────────────────────
  const nsRes  = await fetch(`${REMEMBILL_BASE}/number-series`, { headers: h })
  const nsBody = await nsRes.text()
  let numberSeriesId: string | null = null
  try {
    const nsJson = JSON.parse(nsBody) as Record<string, unknown>
    const list   = (nsJson.data ?? nsJson) as Array<Record<string, unknown>>
    const def    = Array.isArray(list) ? list.find(s => s.is_default) ?? list[0] : null
    numberSeriesId = def?.id as string ?? null
  } catch { /* ignore */ }

  // ── Step B: create draft invoice — with and without number_series_id ───────
  const invoiceBody1 = {
    customer_id: job.billing_customer_id,
    currency: cur, issue_date: today, due_date: due, payment_terms: 'Net 30',
    ...(numberSeriesId ? { number_series_id: numberSeriesId } : {}),
  }
  const inv1Res  = await fetch(`${REMEMBILL_BASE}/invoices`, { method: 'POST', headers: h, body: JSON.stringify(invoiceBody1) })
  const inv1Body = await inv1Res.text()

  if (!inv1Res.ok) {
    return NextResponse.json({
      numberSeries: nsBody,
      step: 'invoice_create_failed',
      invoiceReqBody: invoiceBody1,
      invoiceStatus: inv1Res.status,
      invoiceBody: inv1Body,
    }, { status: 502 })
  }

  const inv1Json = JSON.parse(inv1Body) as Record<string, unknown>
  const inv1Obj  = (inv1Json.invoice ?? inv1Json.data ?? inv1Json) as Record<string, unknown>
  const invoiceId = inv1Obj.id as string

  // ── Step C: try every plausible row-body format ───────────────────────────
  const AMOUNT_ORE    = 10000   // = 100.00 SEK in öre
  const AMOUNT_KRONOR = 100.00  // = 100.00 SEK in kronor

  const candidates = [
    // ── snake_case unit_price variants ──
    { label: '1: unit_price öre, vat_rate 0',        body: { description: 'Probe', quantity: 1, unit_price: AMOUNT_ORE,    vat_rate: 0 } },
    { label: '2: unit_price öre, no vat',            body: { description: 'Probe', quantity: 1, unit_price: AMOUNT_ORE } },
    { label: '3: unit_price kronor, vat_rate 0',     body: { description: 'Probe', quantity: 1, unit_price: AMOUNT_KRONOR, vat_rate: 0 } },
    { label: '4: unit_price kronor, no vat',         body: { description: 'Probe', quantity: 1, unit_price: AMOUNT_KRONOR } },
    // ── price variants ──
    { label: '5: price öre, vat_rate 0',             body: { description: 'Probe', quantity: 1, price: AMOUNT_ORE,         vat_rate: 0 } },
    { label: '6: price öre, no vat',                 body: { description: 'Probe', quantity: 1, price: AMOUNT_ORE } },
    { label: '7: price kronor, vat_rate 0',          body: { description: 'Probe', quantity: 1, price: AMOUNT_KRONOR,      vat_rate: 0 } },
    { label: '8: price kronor, no vat',              body: { description: 'Probe', quantity: 1, price: AMOUNT_KRONOR } },
    // ── amount / unit_amount variants ──
    { label: '9: amount öre only',                   body: { description: 'Probe', amount: AMOUNT_ORE } },
    { label: '10: amount kronor only',               body: { description: 'Probe', amount: AMOUNT_KRONOR } },
    { label: '11: unit_amount öre, vat_rate 0',      body: { description: 'Probe', quantity: 1, unit_amount: AMOUNT_ORE,   vat_rate: 0 } },
    // ── with vat as object ──
    { label: '12: unit_price öre, vat as object',    body: { description: 'Probe', quantity: 1, unit_price: AMOUNT_ORE,    vat: { rate: 0 } } },
    // ── Swedish field names ──
    { label: '13: pris öre (Swedish)',               body: { description: 'Probe', antal: 1, pris: AMOUNT_ORE } },
    // ── total only ──
    { label: '14: total_amount öre',                 body: { description: 'Probe', total_amount: AMOUNT_ORE } },
    { label: '15: line_total öre',                   body: { description: 'Probe', quantity: 1, line_total: AMOUNT_ORE } },
  ]

  const results: Array<{ label: string; reqBody: unknown; status: number; resBody: string; ok: boolean }> = []

  for (const c of candidates) {
    const r  = await fetch(`${REMEMBILL_BASE}/invoices/${invoiceId}/rows`, {
      method: 'POST', headers: h, body: JSON.stringify(c.body),
    })
    const rb = await r.text()
    results.push({ label: c.label, reqBody: c.body, status: r.status, resBody: rb, ok: r.ok })
    if (r.ok) break
  }

  // ── Step D: GET the invoice to see its state after row attempts ────────────
  const getRes  = await fetch(`${REMEMBILL_BASE}/invoices/${invoiceId}`, { headers: h })
  const getBody = await getRes.text()

  // ── Step E: clean up ───────────────────────────────────────────────────────
  await fetch(`${REMEMBILL_BASE}/invoices/${invoiceId}`, { method: 'DELETE', headers: h })

  // Build a human-readable summary so the first attempt detail is easy to read
  const firstFail   = results.find(r => !r.ok)
  const firstSuccess = results.find(r => r.ok)

  return NextResponse.json({
    numberSeriesId,
    numberSeriesBody: nsBody,
    invoiceId,
    invoiceCreatedWithNumberSeries: !!numberSeriesId,
    summary: {
      firstSuccess: firstSuccess ? { label: firstSuccess.label, status: firstSuccess.status, resBody: firstSuccess.resBody } : null,
      firstFailure: firstFail    ? { label: firstFail.label,    status: firstFail.status,    resBody: firstFail.resBody }    : null,
      allStatuses: results.map(r => `${r.label} → ${r.status}`),
    },
    rowAttempts: results,
    invoiceAfterRows: getBody,
  })
}
