/**
 * POST /api/jobs/[id]/planned-invoices/[invoiceId]/requeue
 *   Safe, explicit recovery for a FAILED ordinary period/terminal-
 *   settlement invoice — moves it back into the existing 'scheduled'
 *   lifecycle and requests a targeted readiness recheck. Never sends the
 *   invoice directly; the existing scheduler/claim/execution-payload
 *   machinery remains the sole issuer. See lib/invoice-requeue.ts for the
 *   full safety audit (eligibility rules, billing_hold gate, idempotency).
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireOrg } from '@/lib/org'
import { requeueFailedInvoice } from '@/lib/invoice-requeue'

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; invoiceId: string }> },
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id: jobId, invoiceId } = await params

  const result = await requeueFailedInvoice({
    jobId, orgId: org.orgId, plannedInvoiceId: invoiceId, requestedBy: org.userEmail,
  })

  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: result.status })
  return NextResponse.json({ requeued: true, invoiceId: result.invoiceId, recheck: result.recheck })
}
