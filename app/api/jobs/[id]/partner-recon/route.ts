import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import {
  extractPartnerAgreement,
  extractPartnerInvoice,
  reconcilePartner,
  aiReconcile,
} from '@/lib/partner-reconciler'
import { resolveStorageUrl } from '@/lib/storage'

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let org
  try { org = await requireOrg() } catch (res) { return res as Response }

  const { id } = await params

  const { data: job, error: jobError } = await supabaseServer
    .from('jobs')
    .select('id, name, currency, contract_pdf_url, billing_csv_url, execute_status')
    .eq('id', id)
    .eq('org_id', org.orgId)
    .single()

  if (jobError || !job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  if (job.execute_status === 'PROCESSING' || job.execute_status === 'EXTRACTING') {
    return NextResponse.json({ jobId: id, status: job.execute_status })
  }

  // Clear previous data on any rerun (failed or completed with stale data)
  await Promise.all([
    supabaseServer.from('partner_findings').delete().eq('job_id', id),
    supabaseServer.from('partner_invoices').delete().eq('job_id', id),
  ])

  await supabaseServer.from('jobs').update({ execute_status: 'PROCESSING', error_message: null }).eq('id', id)

  runPartnerReconPipeline(id, job.contract_pdf_url, job.billing_csv_url, job.currency).catch(
    async (err) => {
      await supabaseServer
        .from('jobs')
        .update({
          execute_status: 'FAILED',
          error_message: err instanceof Error ? err.message : String(err),
        })
        .eq('id', id)
    }
  )

  return NextResponse.json({ jobId: id, status: 'PROCESSING' })
}

async function runPartnerReconPipeline(
  jobId: string,
  agreementUrl: string | null,
  invoiceUrl: string | null,
  currency: string
) {
  if (!agreementUrl || !invoiceUrl) throw new Error('Missing agreement or invoice file')

  const [resolvedAgreementUrl, resolvedInvoiceUrl] = await Promise.all([
    resolveStorageUrl(agreementUrl),
    resolveStorageUrl(invoiceUrl),
  ])

  const [agreementBuffer, invoiceBuffer] = await Promise.all([
    fetchBuffer(resolvedAgreementUrl),
    fetchBuffer(resolvedInvoiceUrl),
  ])

  const [agreementText, invoiceText] = await Promise.all([
    extractText(agreementBuffer, resolvedAgreementUrl),
    extractText(invoiceBuffer, resolvedInvoiceUrl),
  ])

  // Extract invoice first (in parallel is fine — agreement extraction doesn't need volume)
  const [agreement, invoiceLines] = await Promise.all([
    extractPartnerAgreement(agreementText),
    extractPartnerInvoice(invoiceText),
  ])

  // AI reconciliation: passes the full agreement text so Claude can reason about
  // tiered pricing, volume-based waivers, blended rates, etc. Deterministic
  // detectors alone can't handle these cases reliably.
  const aiFindings = await aiReconcile(agreementText, invoiceLines, agreement.currency ?? currency)

  // Fall back to deterministic detectors for any findings AI might have missed
  const deterministicFindings = reconcilePartner(agreement, invoiceLines)

  // Merge: prefer AI findings; add deterministic ones only if type not already covered
  const coveredTypes = new Set(aiFindings.map(f => f.finding_type))
  const extraFindings = deterministicFindings.filter(f => !coveredTypes.has(f.finding_type))
  const findings = [...aiFindings, ...extraFindings]

  const invoiceAmount = invoiceLines.reduce((s, l) => s + l.amount_billed, 0)
  const invoiceRef =
    invoiceLines.find((l) => l.reference)?.reference ?? `INV-${Date.now()}`
  const invoiceCurrency = invoiceLines[0]?.currency ?? agreement.currency ?? currency
  const totalDiscrepancy = findings.reduce((s, f) => s + f.discrepancy, 0)

  const { data: savedInvoice } = await supabaseServer
    .from('partner_invoices')
    .insert({
      job_id: jobId,
      invoice_reference: invoiceRef,
      partner_name: agreement.partner_name ?? 'Unknown partner',
      invoice_amount: invoiceAmount,
      currency: invoiceCurrency,
      dispute_amount: totalDiscrepancy,
      status: findings.length > 0 ? 'pending' : 'approved',
    })
    .select('id')
    .single()

  if (findings.length > 0) {
    const { error: findingsError } = await supabaseServer.from('partner_findings').insert(
      findings.map((f) => ({
        job_id: jobId,
        finding_type: f.finding_type,
        description: f.description,
        agreed_amount: f.agreed_amount,
        billed_amount: f.billed_amount,
        discrepancy: f.discrepancy,
        evidence: f.evidence,
        status: f.status,
      }))
    )
    if (findingsError) throw new Error(`Failed to save findings: ${findingsError.message}`)
  }

  await supabaseServer
    .from('jobs')
    .update({
      execute_status: 'COMPLETED',
      status: 'COMPLETED',
      total_leakage: totalDiscrepancy,
      findings_count: findings.length,
    })
    .eq('id', jobId)
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch file: ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

async function extractText(buffer: Buffer, url: string): Promise<string> {
  const pathname = new URL(url).pathname
  if (pathname.includes('.pdf') || pathname.includes('%2Epdf')) {
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    const client = new Anthropic()
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: buffer.toString('base64'),
              },
            },
            {
              type: 'text',
              text: 'Extract all text from this document. Preserve structure including section numbers, tables, amounts, and dates. Output plain text only.',
            },
          ],
        },
      ],
    })
    const c = response.content[0]
    return c.type === 'text' ? c.text : ''
  }
  return buffer.toString('utf-8')
}
