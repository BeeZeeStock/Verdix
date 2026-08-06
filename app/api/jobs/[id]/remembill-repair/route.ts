/**
 * POST /api/jobs/[id]/remembill-repair
 *
 * Finds Remembill invoices for this job that are missing rows (empty amount),
 * deletes them, and recreates each with rows[] included in the creation body.
 * Useful for fixing invoices that were pushed before the row-in-creation-body
 * strategy was deployed.
 *
 * Returns a summary of what was fixed.
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

  const termsArr  = job.contract_terms as unknown as Array<{ currency?: string; payment_terms_days?: number | null }>
  const terms     = termsArr?.[0] ?? {}
  const cur       = (terms.currency ?? 'SEK').toUpperCase()
  const netDays   = terms.payment_terms_days ?? 30

  const fmtDate = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

  // Fetch all sent planned_invoices with a Remembill ID
  const { data: rows } = await supabaseServer
    .from('planned_invoices')
    .select('id, stripe_invoice_id, fee_label, base_amount, period_start, invoice_type')
    .eq('job_id', jobId)
    .eq('status', 'sent')
    .not('stripe_invoice_id', 'is', null)

  if (!rows || rows.length === 0) {
    return NextResponse.json({ message: 'No sent invoices found for this job', fixed: [] })
  }

  const results: { invoiceId: string; feeLabel: string | null; action: string; newId?: string }[] = []

  for (const row of rows) {
    const invId      = row.stripe_invoice_id as string
    const feeLabel   = row.fee_label as string | null
    const baseAmount = row.base_amount as number
    const periodStart = row.period_start as string

    // GET the invoice from Remembill to check if it has rows
    const getRes  = await fetch(`${REMEMBILL_BASE}/invoices/${invId}`, { headers: h })
    if (!getRes.ok) {
      results.push({ invoiceId: invId, feeLabel, action: `GET failed (${getRes.status})` })
      continue
    }
    const getJson = await getRes.json() as Record<string, unknown>
    const inv = (getJson.invoice ?? getJson.data ?? getJson) as Record<string, unknown>
    const invRows = (inv.rows ?? inv.line_items ?? []) as unknown[]

    if (Array.isArray(invRows) && invRows.length > 0) {
      results.push({ invoiceId: invId, feeLabel, action: 'already has rows — skipped' })
      continue
    }

    // No rows — delete and recreate
    await fetch(`${REMEMBILL_BASE}/invoices/${invId}`, { method: 'DELETE', headers: h })
      .catch(err => console.error('[repair] delete failed', invId, err))

    const description = feeLabel ?? 'Subscription fee'
    const issueDate   = new Date(periodStart + 'T00:00:00')
    const dueDate     = new Date(issueDate.getTime() + netDays * 86_400_000)

    const row_ = { name: description, quantity: 1, price: Math.round(baseAmount * 100), vat: 0 }
    const invoiceBody = {
      customer_id:   job.billing_customer_id as string,
      currency:      cur,
      issue_date:    fmtDate(issueDate),
      due_date:      fmtDate(dueDate),
      payment_terms: `Net ${netDays}`,
      rows:          [row_],
    }

    const idempKey = safeHeaderValue(`verdix-repair-${jobId}-${invId}`)
    const createRes  = await fetch(`${REMEMBILL_BASE}/invoices`, {
      method: 'POST',
      headers: { ...h, 'Idempotency-Key': idempKey },
      body: JSON.stringify(invoiceBody),
    })
    const createBody = await createRes.text()
    console.log('[repair] create invoice response', createRes.status, createBody)

    if (!createRes.ok) {
      results.push({ invoiceId: invId, feeLabel, action: `recreate failed (${createRes.status}): ${createBody}` })
      continue
    }

    const createJson = JSON.parse(createBody) as Record<string, unknown>
    const newInv     = (createJson.invoice ?? createJson.data ?? createJson) as Record<string, unknown>
    const newId      = newInv.id as string | undefined
    if (!newId) {
      results.push({ invoiceId: invId, feeLabel, action: `recreate: could not extract id from: ${createBody}` })
      continue
    }

    // Verify rows on the new invoice
    const verifyRes  = await fetch(`${REMEMBILL_BASE}/invoices/${newId}`, { headers: h })
    const verifyBody = await verifyRes.text()
    console.log('[repair] verify invoice response', verifyRes.status, verifyBody)
    let verifyHasRows = false
    try {
      const vj = JSON.parse(verifyBody) as Record<string, unknown>
      const vi = (vj.invoice ?? vj.data ?? vj) as Record<string, unknown>
      const vr = (vi.rows ?? vi.line_items ?? []) as unknown[]
      verifyHasRows = Array.isArray(vr) && vr.length > 0
    } catch { /* ignore */ }

    if (!verifyHasRows) {
      // Try POST /rows as last resort
      const rowFallbackRes = await fetch(`${REMEMBILL_BASE}/invoices/${newId}/rows`, {
        method: 'POST', headers: h, body: JSON.stringify(row_),
      })
      console.log('[repair] POST /rows fallback', rowFallbackRes.status, await rowFallbackRes.text())
    }

    // Deliver via email
    await fetch(`${REMEMBILL_BASE}/invoices/${newId}/email`, {
      method: 'POST', headers: h, body: JSON.stringify({}),
    }).catch(err => console.error('[repair] email delivery failed', err))

    // Update planned_invoices with new ID
    await supabaseServer
      .from('planned_invoices')
      .update({
        stripe_invoice_id:  newId,
        stripe_invoice_url: remembillAppUrl(''),
        sent_at:            new Date().toISOString(),
      })
      .eq('id', row.id)

    results.push({ invoiceId: invId, feeLabel, action: 'recreated with rows + re-sent', newId })
  }

  return NextResponse.json({ fixed: results })
}
