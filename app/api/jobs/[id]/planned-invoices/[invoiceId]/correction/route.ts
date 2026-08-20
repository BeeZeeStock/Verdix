/**
 * POST /api/jobs/[id]/planned-invoices/[invoiceId]/correction
 *   Cancels or corrects an already-issued (sent/paid) invoice via
 *   Remembill's POST /invoices/{id}/credit. See lib/invoice-correction.ts.
 *   body: { action: 'cancellation' | 'correction', reason?: string }
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireOrg } from '@/lib/org'
import { requestInvoiceCorrection, type CorrectionAction } from '@/lib/invoice-correction'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; invoiceId: string }> },
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id: jobId, invoiceId } = await params
  const body = await req.json() as { action: CorrectionAction; reason?: string }
  if (body.action !== 'cancellation' && body.action !== 'correction') {
    return NextResponse.json({ error: "action must be 'cancellation' or 'correction'" }, { status: 400 })
  }

  const result = await requestInvoiceCorrection({
    jobId, orgId: org.orgId, plannedInvoiceId: invoiceId,
    action: body.action, reason: body.reason ?? null, requestedBy: org.userEmail,
  })

  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 400 })
  return NextResponse.json(result)
}
