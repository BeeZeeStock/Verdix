import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { extractContractTerms } from '@/lib/contract-extractor'
import { parseBillingCSV } from '@/lib/billing-parser'
import { reconcile } from '@/lib/reconciler'
import { resolveStorageUrl } from '@/lib/storage'
import { extractDocumentText } from '@/lib/ai-client'
import { preserveStableRuleIds, preserveOneTimeFeeIdentity } from '@/lib/rule-id-stability'
import type { Discount, ServiceCredit, OneTimeFee } from '@/lib/types'

// extractContractTerms now routes through the reasoning tier (Opus +
// adaptive thinking) — see lib/ai-client.ts's AI_REASONING_CLIENT_TIMEOUT_MS
// (280s per attempt, no retries). Explicit rather than relying on the
// platform default staying above that.
export const maxDuration = 290

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let org
  try { org = await requireOrg() } catch (res) { return res as Response }

  const { id } = await params

  const { data: job, error: jobError } = await supabaseServer
    .from('jobs')
    .select('id, name, module, currency, contract_pdf_url, billing_csv_url, contract_terms_id')
    .eq('id', id)
    .eq('org_id', org.orgId)
    .single()

  if (jobError || !job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  // Step 17H.4B0D4H1B3.2 §16-18 — this route's own contract_terms.upsert()
  // below (line ~104) writes to the SAME table, keyed only by job_id, that
  // AUTO_CONFIGURE's execute/confirm-rule/terms-PATCH pipeline treats as
  // authoritative commercial truth — and, before this check, nothing
  // anywhere (not this route, not a DB constraint) stopped it from being
  // invoked against an AUTO_CONFIGURE job's id. Audited: this route uses
  // `jobs.status` (PROCESSING/FAILED/COMPLETED) and billing_csv_url — both
  // exclusively BILLING_VERIFICATION concepts, per lib/reconciler.ts's own
  // module description — never execute_status/current_line_items/
  // billing_hold/billing_customer_id, none of which this route reads or
  // writes anywhere. The prior separation from AUTO_CONFIGURE jobs relied
  // entirely on the dashboard only surfacing this action on /verify pages
  // — a UI convention, not a server-enforced boundary. This is the hard
  // boundary: any job whose module isn't BILLING_VERIFICATION is refused
  // outright, before any read/write below.
  if (job.module !== 'BILLING_VERIFICATION') {
    return NextResponse.json({ error: 'This job is not a Billing Verification job — audit is not available for it.' }, { status: 400 })
  }

  await supabaseServer.from('jobs').update({ status: 'PROCESSING' }).eq('id', id)

  // Run pipeline asynchronously — respond immediately
  runAuditPipeline(id, job.contract_pdf_url, job.billing_csv_url, job.currency, org.orgId, job.contract_terms_id).catch(async (err) => {
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
  currency: string,
  orgId: string,
  existingContractTermsId: string | null,
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

  // Same identity-preservation requirement as execute/route.ts — see comment
  // there for why this matters (orphaned interpretations/audit rows on
  // re-extraction otherwise).
  if (existingContractTermsId) {
    const { data: priorTerms } = await supabaseServer
      .from('contract_terms')
      .select('discounts, service_credits, one_time_fees')
      .eq('id', existingContractTermsId)
      .maybeSingle()
    if (priorTerms) {
      contractTerms.discounts = preserveStableRuleIds(
        (priorTerms.discounts ?? []) as Discount[], contractTerms.discounts ?? [], 'discount_rule_id',
      )
      contractTerms.service_credits = preserveStableRuleIds(
        (priorTerms.service_credits ?? []) as ServiceCredit[], contractTerms.service_credits ?? [], 'credit_rule_id',
      )
      // Step 13 final amendment — see lib/rule-id-stability.ts's
      // preserveOneTimeFeeIdentity for the full rationale.
      contractTerms.one_time_fees = preserveOneTimeFeeIdentity(
        (priorTerms.one_time_fees ?? []) as OneTimeFee[], contractTerms.one_time_fees ?? [],
      )
    }
  }

  // Save contract terms — upsert on job_id, see execute/route.ts for why.
  const { data: savedTerms } = await supabaseServer
    .from('contract_terms')
    .upsert({ job_id: jobId, ...contractTerms }, { onConflict: 'job_id' })
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

  // Update job status. currency is included here too, not just on
  // contract_terms — jobs.currency is what the agreement-list pages
  // actually display, and it was otherwise left at its creation-time
  // placeholder ('USD') forever, silently diverging from the real
  // extracted currency on contract_terms. Only overwritten when extraction
  // actually found a currency — never clobber a good prior value with null.
  await supabaseServer.from('jobs').update({
    status: 'COMPLETED',
    total_leakage: totalLeakage,
    findings_count: findings.length,
    contract_terms_id: savedTerms?.id,
    ...(contractTerms.currency ? { currency: contractTerms.currency } : {}),
  }).eq('id', jobId)

  const { recordSync } = await import('@/lib/billing')
  await recordSync(orgId, jobId, 'billing_audit').catch(err => console.error('[audit] recordSync failed', err))
}

async function fetchFile(url: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch file: ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

async function extractTextFromBuffer(buffer: Buffer, url: string): Promise<string> {
  const pathname = new URL(url).pathname
  return extractDocumentText(
    buffer,
    pathname.endsWith('.pdf'),
    'Extract all text from this contract document. Preserve structure including section numbers, tables, and dates. Output plain text only.',
  )
}
