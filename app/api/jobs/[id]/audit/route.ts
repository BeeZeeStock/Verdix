import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { extractContractTerms } from '@/lib/contract-extractor'
import { parseBillingCSV } from '@/lib/billing-parser'
import { reconcile } from '@/lib/reconciler'
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
    .select('id, name, currency, contract_pdf_url, billing_csv_url')
    .eq('id', id)
    .eq('org_id', org.orgId)
    .single()

  if (jobError || !job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  await supabaseServer.from('jobs').update({ status: 'PROCESSING' }).eq('id', id)

  // Run pipeline asynchronously — respond immediately
  runAuditPipeline(id, job.contract_pdf_url, job.billing_csv_url, job.currency).catch(async (err) => {
    await supabaseServer.from('jobs').update({
      status: 'FAILED',
      error_message: err instanceof Error ? err.message : String(err),
    }).eq('id', id)
  })

  return NextResponse.json({ jobId: id, status: 'PROCESSING' })
}

async function runAuditPipeline(
  jobId: string,
  contractUrl: string | null,
  billingUrl: string | null,
  currency: string
) {
  if (!contractUrl || !billingUrl) throw new Error('Missing contract or billing file')

  // Resolve storage paths / expired signed URLs to fresh fetchable URLs
  const [resolvedContractUrl, resolvedBillingUrl] = await Promise.all([
    resolveStorageUrl(contractUrl),
    resolveStorageUrl(billingUrl),
  ])

  // Download files from Supabase storage
  const [contractBuffer, billingBuffer] = await Promise.all([
    fetchFile(resolvedContractUrl),
    fetchFile(resolvedBillingUrl),
  ])

  const contractText = await extractTextFromBuffer(contractBuffer, resolvedContractUrl)
  const billingText = billingBuffer.toString('utf-8')

  // Extract contract terms
  const contractTerms = await extractContractTerms(contractText)

  // Save contract terms
  const { data: savedTerms } = await supabaseServer
    .from('contract_terms')
    .insert({ job_id: jobId, ...contractTerms })
    .select('id')
    .single()

  // Parse billing records
  const billingRecords = parseBillingCSV(billingText)

  // Reconcile
  const findings = reconcile(contractTerms, billingRecords)
  const totalLeakage = findings.reduce((s, f) => s + f.leakage_amount, 0)

  // Save findings
  if (findings.length > 0) {
    await supabaseServer.from('leakage_findings').insert(
      findings.map(f => ({ ...f, job_id: jobId }))
    )
  }

  // Update job status
  await supabaseServer.from('jobs').update({
    status: 'COMPLETED',
    total_leakage: totalLeakage,
    findings_count: findings.length,
    contract_terms_id: savedTerms?.id,
  }).eq('id', jobId)
}

async function fetchFile(url: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch file: ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

async function extractTextFromBuffer(buffer: Buffer, url: string): Promise<string> {
  // For PDF files, use Claude's vision capability via base64
  const pathname = new URL(url).pathname
  if (pathname.endsWith('.pdf')) {
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    const client = new Anthropic()
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      messages: [{
        role: 'user',
        content: [{
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: buffer.toString('base64'),
          },
        }, {
          type: 'text',
          text: 'Extract all text from this contract document. Preserve structure including section numbers, tables, and dates. Output plain text only.',
        }],
      }],
    })
    const content = response.content[0]
    return content.type === 'text' ? content.text : ''
  }
  return buffer.toString('utf-8')
}
