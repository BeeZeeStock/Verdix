/**
 * POST /api/jobs/[id]/remembill-probe  — remove after use.
 * Tests three strategies for getting rows onto a Remembill invoice:
 *   A) rows[] included in the invoice creation body
 *   B) PUT /invoices/:id with rows[]
 *   C) POST /invoices/:id/rows (existing approach, now with name field)
 * Also surfaces the raw URL and body sent so we can confirm what's going out.
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
    .eq('id', jobId).eq('org_id', org.orgId).single()

  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  if (!job.billing_customer_id) return NextResponse.json({ error: 'No billing_customer_id' }, { status: 400 })

  const { data: rbInt } = await supabaseServer
    .from('org_integrations').select('config')
    .eq('org_id', org.orgId).eq('connector_name', 'remembill').eq('is_active', true).maybeSingle()

  const rbKey = (rbInt?.config as Record<string, string>)?.api_key ?? process.env.REMEMBILL_API_KEY!
  const h = remembillHeaders(rbKey)
  const termsArr = job.contract_terms as unknown as Array<{ currency?: string }>
  const cur = ((termsArr?.[0]?.currency) ?? 'SEK').toUpperCase()
  // Use tomorrow as issue date to avoid any idempotency collision with previous probe runs
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
  const due      = new Date(Date.now() + 31 * 86_400_000).toISOString().slice(0, 10)

  const row1 = { name: 'Base subscription', quantity: 1, unit_price: 10000, vat_rate: 0 }
  const row2 = { name: 'Base subscription', quantity: 1, price: 10000,      vat_rate: 0 }

  // ── Strategy A: create invoice WITH rows in the body, then GET to confirm ──
  const bodyA = { customer_id: job.billing_customer_id, currency: cur, issue_date: tomorrow, due_date: due, payment_terms: 'Net 30', rows: [row1] }
  const resA  = await fetch(`${REMEMBILL_BASE}/invoices`, { method: 'POST', headers: h, body: JSON.stringify(bodyA) })
  const rawA  = await resA.text()
  let invoiceA_id: string | null = null
  let invoiceA_get: string | null = null
  if (resA.ok) {
    const j = JSON.parse(rawA) as Record<string, unknown>
    invoiceA_id = ((j.invoice ?? j.data ?? j) as Record<string, unknown>).id as string ?? null
    if (invoiceA_id) {
      const getA = await fetch(`${REMEMBILL_BASE}/invoices/${invoiceA_id}`, { headers: h })
      invoiceA_get = await getA.text()
    }
  }

  // ── Strategy B: create plain invoice then PUT with rows ────────────────────
  const bodyB0 = { customer_id: job.billing_customer_id, currency: cur, issue_date: tomorrow, due_date: due, payment_terms: 'Net 30' }
  const resB0  = await fetch(`${REMEMBILL_BASE}/invoices`, { method: 'POST', headers: h, body: JSON.stringify(bodyB0) })
  const rawB0  = await resB0.text()
  let stratB: { putStatus?: number; putBody?: string } = {}
  if (resB0.ok) {
    const j = JSON.parse(rawB0) as Record<string, unknown>
    const id = ((j.invoice ?? j.data ?? j) as Record<string, unknown>).id as string
    if (id) {
      const putBody = { rows: [row1] }
      const resB1  = await fetch(`${REMEMBILL_BASE}/invoices/${id}`, { method: 'PUT', headers: h, body: JSON.stringify(putBody) })
      stratB = { putStatus: resB1.status, putBody: await resB1.text() }
      await fetch(`${REMEMBILL_BASE}/invoices/${id}`, { method: 'DELETE', headers: h })
    }
  }

  // ── Strategy C: create plain invoice then POST /rows with many field variants ──
  const bodyC = { customer_id: job.billing_customer_id, currency: cur, issue_date: tomorrow, due_date: due, payment_terms: 'Net 30' }
  const resC  = await fetch(`${REMEMBILL_BASE}/invoices`, { method: 'POST', headers: h, body: JSON.stringify(bodyC) })
  const rawC  = await resC.text()
  const stratC: { url: string; sentBody: unknown; status: number; resBody: string }[] = []
  if (resC.ok) {
    const j = JSON.parse(rawC) as Record<string, unknown>
    const id = ((j.invoice ?? j.data ?? j) as Record<string, unknown>).id as string
    if (id) {
      const url = `${REMEMBILL_BASE}/invoices/${id}/rows`
      const rowVariants = [
        row1,
        row2,
        // wrapped in root key (some APIs expect {row:{...}})
        { row: { name: 'Base subscription', quantity: 1, unit_price: 10000, vat_rate: 0 } } as unknown as typeof row1,
        // different label field names
        { title: 'Base subscription',       quantity: 1, unit_price: 10000, vat_rate: 0 },
        { label: 'Base subscription',       quantity: 1, unit_price: 10000, vat_rate: 0 },
        { description: 'Base subscription', quantity: 1, unit_price: 10000, vat_rate: 0 },
        // article-based lookup
        { article_number: '001', quantity: 1, unit_price: 10000, vat_rate: 0 },
        { article_number: '001', name: 'Base subscription', quantity: 1, unit_price: 10000, vat_rate: 0 },
      ]
      for (const body of rowVariants) {
        const jsonStr = JSON.stringify(body)
        const r  = await fetch(url, { method: 'POST', headers: h, body: jsonStr })
        const rb = await r.text()
        stratC.push({ url, sentBody: body, status: r.status, resBody: rb })
        if (r.ok) break
      }
      // GET to see rows on invoice
      const getR = await fetch(`${REMEMBILL_BASE}/invoices/${id}`, { headers: h })
      const getB = await getR.text()
      stratC.push({ url: `GET ${REMEMBILL_BASE}/invoices/${id}`, sentBody: null, status: getR.status, resBody: getB })
      await fetch(`${REMEMBILL_BASE}/invoices/${id}`, { method: 'DELETE', headers: h })
    }
  }

  // ── Strategy E: top-level /rows resource (invoice_id in body) ────────────
  const bodyE0 = { customer_id: job.billing_customer_id, currency: cur, issue_date: tomorrow, due_date: due, payment_terms: 'Net 30' }
  const resE0  = await fetch(`${REMEMBILL_BASE}/invoices`, { method: 'POST', headers: h, body: JSON.stringify(bodyE0) })
  const rawE0  = await resE0.text()
  const stratE: { topLevelRowStatus?: number; topLevelRowBody?: string; numberSeriesStatus?: number; numberSeriesBody?: string } = {}
  if (resE0.ok) {
    const ej = JSON.parse(rawE0) as Record<string, unknown>
    const eid = ((ej.invoice ?? ej.data ?? ej) as Record<string, unknown>).id as string
    if (eid) {
      const rowE = { invoice_id: eid, name: 'Base subscription', quantity: 1, unit_price: 10000, vat_rate: 0 }
      const resE1 = await fetch(`${REMEMBILL_BASE}/rows`, { method: 'POST', headers: h, body: JSON.stringify(rowE) })
      stratE.topLevelRowStatus = resE1.status
      stratE.topLevelRowBody   = await resE1.text()
      await fetch(`${REMEMBILL_BASE}/invoices/${eid}`, { method: 'DELETE', headers: h })
    }
  }
  // check what number-series options exist
  const resNS = await fetch(`${REMEMBILL_BASE}/number-series`, { headers: h })
  stratE.numberSeriesStatus = resNS.status
  stratE.numberSeriesBody   = await resNS.text()

  // ── Strategy D: discover articles catalog ────────────────────────────────
  const resArticles = await fetch(`${REMEMBILL_BASE}/articles`, { headers: h })
  const rawArticles = await resArticles.text()
  // If articles exist, try creating a row with article_id
  let stratD: { articlesStatus: number; articlesBody: string; rowWithArticleStatus?: number; rowWithArticleBody?: string } = {
    articlesStatus: resArticles.status, articlesBody: rawArticles,
  }
  if (resArticles.ok) {
    let articleId: string | null = null
    try {
      const aj = JSON.parse(rawArticles) as Record<string, unknown>
      const list = (aj.data ?? aj.articles ?? aj) as Array<Record<string, unknown>>
      articleId = Array.isArray(list) && list.length > 0 ? (list[0].id as string) : null
    } catch { /* ignore */ }
    if (articleId) {
      const bodyD0 = { customer_id: job.billing_customer_id, currency: cur, issue_date: tomorrow, due_date: due, payment_terms: 'Net 30' }
      const resD0  = await fetch(`${REMEMBILL_BASE}/invoices`, { method: 'POST', headers: h, body: JSON.stringify(bodyD0) })
      if (resD0.ok) {
        const dj = await resD0.json() as Record<string, unknown>
        const did = ((dj.invoice ?? dj.data ?? dj) as Record<string, unknown>).id as string
        if (did) {
          const rowD = { article_id: articleId, quantity: 1, unit_price: 10000 }
          const resD1 = await fetch(`${REMEMBILL_BASE}/invoices/${did}/rows`, { method: 'POST', headers: h, body: JSON.stringify(rowD) })
          stratD = { ...stratD, rowWithArticleStatus: resD1.status, rowWithArticleBody: await resD1.text() }
          await fetch(`${REMEMBILL_BASE}/invoices/${did}`, { method: 'DELETE', headers: h })
        }
      }
    }
  }

  // Clean up invoice A
  if (invoiceA_id) await fetch(`${REMEMBILL_BASE}/invoices/${invoiceA_id}`, { method: 'DELETE', headers: h })

  return NextResponse.json({
    strategyA_createWithRows:   { status: resA.status, reqBody: bodyA, createResBody: rawA, getResBody: invoiceA_get },
    strategyB_putRows:          { invoiceCreateStatus: resB0.status, ...stratB },
    strategyC_postRows:         stratC,
    strategyD_articles:         stratD,
    strategyE_topLevelAndSeries: stratE,
  })
}
