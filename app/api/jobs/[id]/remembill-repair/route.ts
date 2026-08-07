/**
 * POST /api/jobs/[id]/remembill-repair
 *
 * Diagnostic + repair: finds sent planned_invoices (including those with null
 * stripe_invoice_id), attempts to create/fix the Remembill invoice using multiple
 * strategies, and returns full raw API responses for debugging.
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { REMEMBILL_BASE, remembillHeaders, remembillAppUrl, safeHeaderValue } from '@/lib/billing-writer'

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id: jobId } = await params

  const { data: job } = await supabaseServer
    .from('jobs')
    .select('org_id, billing_platform, billing_customer_id, contract_terms(currency, payment_terms_days)')
    .eq('id', jobId)
    .eq('org_id', org.orgId)
    .single()

  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  if (job.billing_platform !== 'remembill') return NextResponse.json({ error: 'Not a Remembill job' }, { status: 400 })

  const { data: rbInt } = await supabaseServer
    .from('org_integrations')
    .select('config')
    .eq('org_id', org.orgId)
    .eq('connector_name', 'remembill')
    .eq('is_active', true)
    .maybeSingle()

  const apiKey = (rbInt?.config as Record<string, string>)?.api_key ?? process.env.REMEMBILL_API_KEY!
  const h = remembillHeaders(apiKey)

  const termsArr = job.contract_terms as unknown as Array<{ currency?: string; payment_terms_days?: number | null }>
  const terms    = termsArr?.[0] ?? {}
  const cur      = (terms.currency ?? 'SEK').toUpperCase()
  const netDays  = terms.payment_terms_days ?? 30

  const fmtDate = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

  const { data: rows } = await supabaseServer
    .from('planned_invoices')
    .select('id, stripe_invoice_id, fee_label, base_amount, period_start, invoice_type, quantity, unit_price, overage_line_items')
    .eq('job_id', jobId)
    .eq('status', 'sent')

  if (!rows || rows.length === 0) {
    return NextResponse.json({ message: 'No sent invoices found for this job', fixed: [] })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const results: any[] = []

  for (const row of rows) {
    const existingInvId = row.stripe_invoice_id as string | null
    const feeLabel      = row.fee_label as string | null
    const baseAmount    = row.base_amount as number
    const periodStart   = row.period_start as string
    const overageItems  = (row.overage_line_items ?? []) as Array<{ description: string; amount: number }>

    // Real per-unit breakdown (from the approved line_items row) when one was
    // captured at push/parked-confirm time — same fallback as invoice-scheduler.
    const rowQuantity  = row.quantity   != null ? Number(row.quantity)   : null
    const rowUnitPrice = row.unit_price != null ? Number(row.unit_price) : null
    const hasBreakdown = rowQuantity != null && rowUnitPrice != null && rowQuantity > 0 && rowUnitPrice > 0

    const description = feeLabel ?? 'Subscription fee'
    const issueDate   = new Date(periodStart + 'T00:00:00')
    const dueDate     = new Date(issueDate.getTime() + netDays * 86_400_000)

    // price in öre: 1 SEK = 100 öre
    const priceOere  = Math.round(baseAmount * 100)
    const rowPayload = hasBreakdown
      ? { name: description, quantity: rowQuantity!, price: Math.round(rowUnitPrice! * 100), vat: 0 }
      : { name: description, quantity: 1, price: priceOere, vat: 0 }

    const entry: Record<string, unknown> = {
      rowId: row.id, feeLabel, baseAmount, priceOere, hasBreakdown,
      existingInvId,
    }

    // ── Delete existing invoice if we have its ID ────────────────────────────
    if (existingInvId) {
      const delRes = await fetch(`${REMEMBILL_BASE}/invoices/${existingInvId}`, { method: 'DELETE', headers: h })
      entry.deleteStatus = delRes.status
    }

    // ── Create new invoice with rows[] in body (Strategy A) ──────────────────
    const invoiceBodyA = {
      customer_id:   job.billing_customer_id as string,
      currency:      cur,
      issue_date:    fmtDate(issueDate),
      due_date:      fmtDate(dueDate),
      payment_terms: `Net ${netDays}`,
      rows:          [rowPayload],
    }
    const idempKey = safeHeaderValue(`verdix-repair2-${jobId}-${row.id}-${Date.now()}`)
    const createRes  = await fetch(`${REMEMBILL_BASE}/invoices`, {
      method: 'POST',
      headers: { ...h, 'Idempotency-Key': idempKey },
      body: JSON.stringify(invoiceBodyA),
    })
    const createBody = await createRes.text()
    entry.strategyA = { sentBody: invoiceBodyA, status: createRes.status, responseBody: createBody }

    if (!createRes.ok) {
      results.push({ ...entry, action: 'create failed' })
      continue
    }

    const cj    = JSON.parse(createBody) as Record<string, unknown>
    const cInv  = (cj.invoice ?? cj.data ?? cj) as Record<string, unknown>
    const newId = cInv.id as string | undefined

    if (!newId) {
      results.push({ ...entry, action: 'could not extract invoice id', rawCreate: createBody })
      continue
    }
    entry.newId = newId

    // ── GET invoice to verify rows attached ───────────────────────────────────
    const getRes  = await fetch(`${REMEMBILL_BASE}/invoices/${newId}`, { headers: h })
    const getBody = await getRes.text()
    entry.getAfterCreate = { status: getRes.status, responseBody: getBody }

    let hasRows = false
    try {
      const gj   = JSON.parse(getBody) as Record<string, unknown>
      const gInv = (gj.invoice ?? gj.data ?? gj) as Record<string, unknown>
      const gr   = (gInv.rows ?? gInv.line_items ?? gInv.invoice_rows ?? []) as unknown[]
      hasRows    = Array.isArray(gr) && gr.length > 0
      entry.parsedRows = gr
    } catch { /* ignore */ }

    // ── Strategy B: PUT /invoices/:id with rows[] ─────────────────────────────
    const putRes  = await fetch(`${REMEMBILL_BASE}/invoices/${newId}`, {
      method: 'PUT', headers: h,
      body: JSON.stringify({ rows: [rowPayload] }),
    })
    const putBody = await putRes.text()
    entry.strategyB = { status: putRes.status, responseBody: putBody }

    // ── Strategy C: POST /invoices/:id/rows ───────────────────────────────────
    const rowRes  = await fetch(`${REMEMBILL_BASE}/invoices/${newId}/rows`, {
      method: 'POST', headers: h,
      body: JSON.stringify(rowPayload),
    })
    const rowBody = await rowRes.text()
    entry.strategyC = { sentBody: rowPayload, status: rowRes.status, responseBody: rowBody }

    // ── Overage rows (dropped otherwise, since we deleted the original invoice) ─
    if (overageItems.length > 0) {
      entry.overageRows = []
      for (const item of overageItems) {
        const overagePayload = { name: item.description, quantity: 1, price: Math.round(item.amount * 100), vat: 0 }
        const overageRes  = await fetch(`${REMEMBILL_BASE}/invoices/${newId}/rows`, {
          method: 'POST', headers: h,
          body: JSON.stringify(overagePayload),
        })
        ;(entry.overageRows as unknown[]).push({ sentBody: overagePayload, status: overageRes.status })
      }
    }

    // ── GET again to see final state ──────────────────────────────────────────
    const getRes2  = await fetch(`${REMEMBILL_BASE}/invoices/${newId}`, { headers: h })
    const getBody2 = await getRes2.text()
    entry.getAfterStrategies = { status: getRes2.status, responseBody: getBody2 }

    try {
      const gj2   = JSON.parse(getBody2) as Record<string, unknown>
      const gInv2 = (gj2.invoice ?? gj2.data ?? gj2) as Record<string, unknown>
      const gr2   = (gInv2.rows ?? gInv2.line_items ?? gInv2.invoice_rows ?? []) as unknown[]
      hasRows     = Array.isArray(gr2) && gr2.length > 0
      entry.parsedRowsAfterStrategies = gr2
    } catch { /* ignore */ }

    // ── Send via email regardless ─────────────────────────────────────────────
    const emailRes = await fetch(`${REMEMBILL_BASE}/invoices/${newId}/email`, {
      method: 'POST', headers: h, body: JSON.stringify({}),
    })
    entry.emailStatus = emailRes.status

    // ── Update DB ─────────────────────────────────────────────────────────────
    await supabaseServer
      .from('planned_invoices')
      .update({ stripe_invoice_id: newId, stripe_invoice_url: remembillAppUrl(''), sent_at: new Date().toISOString() })
      .eq('id', row.id)

    entry.action     = hasRows ? 'repaired — rows confirmed' : 'invoice created + sent but rows STILL missing — check debug output'
    entry.hasRows    = hasRows
    results.push(entry)
  }

  // Count repaired (for the UI badge count)
  const repairedCount = results.filter(r => r.action?.includes('repaired') || r.action?.includes('created')).length
  return NextResponse.json({ fixed: results, repairedCount })
}
