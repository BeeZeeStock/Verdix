/**
 * POST /api/jobs/[id]/operational-events/attest
 *
 * Step 13 — records that a required real-world billability event actually
 * happened. Deliberately NOT part of confirm-rule (that route confirms
 * commercial INTERPRETATION — what the contract means; this route records
 * an operational FACT — what actually occurred). See lib/operational-
 * event-evidence.ts's module header for why these stay two separate
 * ontologies with two separate audit trails.
 *
 * The browser submits only { subjectId, occurredAt } — a component
 * reference and a timestamp. It cannot choose eventType (server derives it
 * from the persisted OneTimeFee's billability_condition), evidence source
 * (server always mints 'reviewer_attestation' — no route accepts a source
 * value from a caller), or commercial provenance (this route never touches
 * billability_provenance/billability_condition at all).
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { auth } from '@/lib/auth'
import { isProvenanceResolved } from '@/lib/commercial-rule-status'
import { getBillabilityExecutionCapability } from '@/lib/billability-condition'
import type { OneTimeFee } from '@/lib/types'
import type { OperationalEventEvidenceSource } from '@/lib/operational-event-evidence'
import { AUTO_CONFIGURE_ONLY_MESSAGE } from '@/lib/auto-configure-guard'

type Body = {
  subjectId: string
  occurredAt: string
}

type EvidenceRow = {
  id: string
  subject_id: string
  event_type: string
  occurred_at: string
  source: OperationalEventEvidenceSource
  recorded_at: string
  recorded_by: string
  status: 'active' | 'revoked'
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id: jobId } = await params
  const body = await req.json() as Body
  const { subjectId, occurredAt } = body

  if (!subjectId || typeof subjectId !== 'string') {
    return NextResponse.json({ error: 'subjectId is required' }, { status: 400 })
  }
  if (!occurredAt || typeof occurredAt !== 'string' || Number.isNaN(new Date(occurredAt).getTime())) {
    return NextResponse.json({ error: 'occurredAt must be a valid date/time' }, { status: 400 })
  }

  const { data: job } = await supabaseServer
    .from('jobs')
    .select('id, module, contract_terms_id')
    .eq('id', jobId)
    .eq('org_id', org.orgId)
    .maybeSingle()
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  // Step 17H.4B0D4H1B4D1 §9/§10 — one_time_fees/billability_condition are
  // AUTO_CONFIGURE-only Model B+ concepts (only ever populated/interpreted
  // via execute + confirm-rule, both AUTO_CONFIGURE-only). Rejected before
  // the contract_terms read below and before the evidence insert — this
  // route writes only to operational_event_evidence, never contract_terms,
  // but that evidence must never be able to affect AUTO_CONFIGURE billing
  // via a cross-module subjectId/job pairing.
  if (job.module !== 'AUTO_CONFIGURE') {
    return NextResponse.json({ error: AUTO_CONFIGURE_ONLY_MESSAGE }, { status: 400 })
  }
  if (!job.contract_terms_id) return NextResponse.json({ error: 'No contract terms found for this job' }, { status: 400 })

  const { data: termsRow } = await supabaseServer
    .from('contract_terms')
    .select('id, one_time_fees')
    .eq('id', job.contract_terms_id)
    .maybeSingle()
  if (!termsRow) return NextResponse.json({ error: 'No contract terms found for this job' }, { status: 400 })

  const fees = (termsRow.one_time_fees ?? []) as OneTimeFee[]
  const fee = fees.find(f => f.fee_id === subjectId)
  if (!fee) return NextResponse.json({ error: 'One-time fee not found for this subjectId' }, { status: 404 })

  // eventType is ALWAYS derived server-side from the persisted condition —
  // item 8, no client-supplied eventType can ever change which event is
  // being attested.
  const capability = getBillabilityExecutionCapability(fee.billability_condition)
  if (capability.executable || capability.reason !== 'requires_operational_event') {
    return NextResponse.json({
      error: 'This fee\'s billability condition does not require operational event evidence.',
      code: 'no_operational_event_required',
    }, { status: 409 })
  }
  const eventType = capability.event_type

  // Item 9 — operational evidence must never resolve, or be accepted ahead
  // of, the contractual interpretation. Fails closed.
  if (!isProvenanceResolved(fee.billability_provenance)) {
    return NextResponse.json({
      error: 'The contractual billability condition has not been confirmed yet — confirm the interpretation before recording that the event occurred.',
      code: 'commercial_interpretation_unresolved',
    }, { status: 409 })
  }

  // Item 6 — a future occurrence can never satisfy a currently-required
  // event. Validated against the server's own clock, not trusted from the
  // client beyond the raw timestamp value itself.
  const now = new Date()
  if (new Date(occurredAt).getTime() > now.getTime()) {
    return NextResponse.json({ error: 'occurredAt cannot be in the future', code: 'occurred_at_in_future' }, { status: 400 })
  }

  // Item 15 — idempotency. A pre-existing active record for this exact
  // (job, subject, event) is returned as-is rather than duplicated; the
  // database's partial unique index (job_id, subject_id, event_type) WHERE
  // status='active' is the authoritative backstop for the concurrent
  // double-click case this SELECT-then-INSERT can't fully close on its own.
  const { data: existing } = await supabaseServer
    .from('operational_event_evidence')
    .select('*')
    .eq('job_id', jobId)
    .eq('subject_id', subjectId)
    .eq('event_type', eventType)
    .eq('status', 'active')
    .maybeSingle()
  if (existing) {
    return NextResponse.json({ evidence: toEvidenceResponse(existing as EvidenceRow), alreadyRecorded: true })
  }

  const session = await auth()
  const reviewerEmail = session?.user?.email ?? org.userEmail ?? 'unknown'

  const { data: created, error } = await supabaseServer
    .from('operational_event_evidence')
    .insert({
      org_id: org.orgId,
      job_id: jobId,
      subject_id: subjectId,
      event_type: eventType,
      occurred_at: occurredAt,
      source: 'reviewer_attestation' satisfies OperationalEventEvidenceSource,
      recorded_by: reviewerEmail,
      status: 'active',
    })
    .select('*')
    .single()

  if (error) {
    // Unique-violation race: a concurrent request won first. Re-fetch and
    // return the now-existing active row rather than surfacing a raw DB
    // conflict to the client — same idempotent outcome as the pre-check above.
    if (error.code === '23505') {
      const { data: raced } = await supabaseServer
        .from('operational_event_evidence')
        .select('*')
        .eq('job_id', jobId).eq('subject_id', subjectId).eq('event_type', eventType).eq('status', 'active')
        .maybeSingle()
      if (raced) return NextResponse.json({ evidence: toEvidenceResponse(raced as EvidenceRow), alreadyRecorded: true })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ evidence: toEvidenceResponse(created as EvidenceRow), alreadyRecorded: false }, { status: 201 })
}

function toEvidenceResponse(row: EvidenceRow) {
  return {
    id: row.id,
    subjectId: row.subject_id,
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    source: row.source,
    recordedAt: row.recorded_at,
    recordedBy: row.recorded_by,
    status: row.status,
  }
}
