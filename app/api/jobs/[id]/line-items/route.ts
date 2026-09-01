import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { computeReviewerCorrectedFieldsUpdate, checkLineItemCorrectionGate, STALE_LINE_ITEM_CORRECTION_MESSAGE } from '@/lib/line-items'
import { beginConfigurationMutationClaim, describeConfigurationMutationClaimRejection } from '@/lib/configuration-mutation-claim'
import { computeReviewerPatchHoldTransition, applyReconciliationHoldTransition } from '@/lib/reconciliation-hold-transition'
import type { BillingHold } from '@/lib/billing-hold'
import { AUTO_CONFIGURE_ONLY_MESSAGE } from '@/lib/auto-configure-guard'

// PATCH /api/jobs/[id]/line-items
// Body: {
//   itemId: string,
//   fields: Partial<{ product_name, unit_price, quantity, billing_period, total_amount, confidence_score }>,
//   markReviewerCorrectedFields?: string[]
// }
//
// Step 17H.4B0D2 — markReviewerCorrectedFields is a command, not a raw
// column write: the server owns reviewer_corrected_fields/reviewer_corrected_at
// entirely (see lib/line-items.ts's computeReviewerCorrectedFieldsUpdate for
// the validation/merge rules) — a caller can only ADD field names to it,
// and only for fields it is genuinely changing in THIS SAME request (never
// a bare claim). This is what lets a future reconciliation pass trust the
// array — a caller cannot mark a field as reviewer-corrected without
// actually correcting it here.
//
// Atomicity (item 16/17 of the D2 design pass): the value fields and the
// metadata fields are written in exactly one .update() call — never two
// separately-failable requests, so Verdix can never persist a reviewer's
// corrected value while failing to record that it was reviewer-authored.
//
// Step 17H.4B0D3B — this route deliberately still targets the BASE
// line_items table, never current_line_items, and MUST continue to: a
// correction has to be able to reach the exact physical row by id
// regardless of its currentness, so the route itself can distinguish
// "row does not exist" from "row exists but has been superseded" and
// return a truthful response for each — reading through current_line_items
// would collapse both into an indistinguishable not-found.
//
// Step 17H.4B0D4H1B3.1 — commercial fields (product_name/unit_price/
// quantity/billing_period/total_amount) now claim ownership BEFORE the
// row UPDATE, exactly like confirm-rule/reconcile-line-items: the
// scheduler must never be able to claim a stale schedule in the window
// between this write and a later hold write. A billing-neutral edit
// (confidence_score only) skips this entirely — H1B2's own row-lock
// protection (FOR UPDATE in the applier) already serializes it safely
// against any concurrent reconciliation, and it carries no commercial
// meaning that could make an existing schedule stale.
const COMMERCIAL_FIELDS = ['product_name', 'unit_price', 'quantity', 'billing_period', 'total_amount']

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id } = await params
  const { itemId, fields, markReviewerCorrectedFields } = await req.json()

  if (!itemId || !fields || Object.keys(fields).length === 0) {
    return NextResponse.json({ error: 'itemId and fields are required' }, { status: 400 })
  }

  const { data: ownedJob } = await supabaseServer
    .from('jobs')
    .select('id, module')
    .eq('id', id)
    .eq('org_id', org.orgId)
    .maybeSingle()
  if (!ownedJob) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  // Step 17H.4B0D4H1B4C — reviewer line-item correction is a Model B+
  // commercial-write surface (AUTO_CONFIGURE-only by design, per H1B4B's
  // audit). Checked here, before the stale-row read below, so a
  // BILLING_VERIFICATION/PARTNER_RECON job id can never distinguish
  // "row exists but superseded" from "row doesn't exist" through this
  // route at all — module rejection is uniform regardless of itemId, and
  // applies even to a confidence_score-only (billing-neutral) PATCH, since
  // this whole route is an AUTO_CONFIGURE surface, not just its commercial
  // fields.
  if (ownedJob.module !== 'AUTO_CONFIGURE') {
    return NextResponse.json({ error: AUTO_CONFIGURE_ONLY_MESSAGE }, { status: 400 })
  }

  // One read of the target row, before any write, serving two purposes:
  // (1) the stale-row guard below, (2) the reviewer_corrected_fields union
  // base for the metadata merge further down — avoids a second round-trip.
  // A row that genuinely does not exist (existing === null) is NOT treated
  // as stale here — that preserves this route's existing, pre-17H.4B0D3B
  // behavior of silently no-op'ing an update against a missing itemId
  // (unchanged, not something this pass introduces or relies on). This
  // stale-row gate stays FIRST, entirely unaffected by the new claim logic
  // below — a doomed request against a superseded row should never
  // acquire (and then have to release) a hold for nothing.
  const { data: existing } = await supabaseServer
    .from('line_items')
    .select('reviewer_corrected_fields, superseded_at')
    .eq('id', itemId)
    .eq('job_id', id)
    .maybeSingle()

  // Step 17H.4B0D3B — a superseded row is no longer part of current
  // commercial configuration; a correction against it (value OR mere
  // confidence-only confirmation) must never silently succeed. Zero
  // mutation: this returns before the allowed-field mapping, before any
  // reviewer_corrected_fields computation, before any .update() call.
  const gate = checkLineItemCorrectionGate(existing)
  if (gate.status === 'superseded') {
    return NextResponse.json({ error: STALE_LINE_ITEM_CORRECTION_MESSAGE }, { status: 409 })
  }

  // §20/§25 — a commercial edit is any request touching one of the five
  // billing-relevant fields; a request that ONLY touches confidence_score
  // is billing-neutral and never claims ownership at all (audited against
  // the actual persisted schema: these five are exactly REVIEWER_
  // CORRECTABLE_LINE_ITEM_FIELDS in lib/line-items.ts, the only fields
  // that ever feed buildLineItems'/the planner's own commercial output;
  // confidence_score/currency/stripe_price_id/etc. never do).
  const isCommercialEdit = Object.keys(fields).some(k => COMMERCIAL_FIELDS.includes(k))

  let claim: Awaited<ReturnType<typeof beginConfigurationMutationClaim>> | null = null
  if (isCommercialEdit) {
    // §21/§35, revised 17H.4B0D4H1B3.4 — claimed regardless of approval
    // status. A never-approved job now ALSO gets a real, durable temporary
    // hold (hasExistingBillingSchedule:false just means the eventual clean
    // transition below resolves to NULL instead of schedule_rebuild_
    // required) — not merely the EXTRACTING/APPROVING race protection this
    // comment used to describe as the claim's only effect for such a job.
    claim = await beginConfigurationMutationClaim(supabaseServer, id)
    if (!claim.claimed) {
      return NextResponse.json({ error: describeConfigurationMutationClaimRejection(claim) }, { status: 409 })
    }
  }

  const allowed = ['product_name', 'unit_price', 'quantity', 'billing_period', 'total_amount', 'confidence_score']
  const update: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) update[k] = v
  }

  if (markReviewerCorrectedFields !== undefined) {
    const metadataUpdate = computeReviewerCorrectedFieldsUpdate({
      requestedMarks: markReviewerCorrectedFields,
      fields,
      priorReviewerCorrectedFields: (existing?.reviewer_corrected_fields as string[] | null) ?? null,
      now: new Date().toISOString(),
    })
    if (metadataUpdate) Object.assign(update, metadataUpdate)
  }

  const { error } = await supabaseServer
    .from('line_items')
    .update(update)
    .eq('id', itemId)
    .eq('job_id', id)

  if (error) {
    // §23 — the row mutation failed before taking effect: restore the
    // claim rather than leave the job stuck under a temporary hold for a
    // correction that never actually happened.
    if (claim?.claimed) {
      await applyReconciliationHoldTransition(supabaseServer, id, claim.newBillingHold, claim.previousBillingHold).catch(() => {})
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // §22/§24/§29, revised 17H.4B0D4H1B3.4 — release the temporary claim
  // into its real outcome. Every AUTO_CONFIGURE commercial claim is real
  // now (regardless of hasExistingBillingSchedule), so this always runs
  // for a claimed commercial edit — no longer gated on approval status. A
  // starting hold of 'reconciliation_blocked' is released back to its
  // EXACT prior content (a single field edit doesn't prove the underlying
  // structural issue is resolved); 'clear' lands on schedule_rebuild_
  // required when an existing schedule may now be stale, or NULL when
  // there was never one to protect (a never-approved job); 'schedule_
  // rebuild_required' stays schedule_rebuild_required (never auto-cleared
  // to NULL by a bare PATCH — only rebuild-schedule/approve's own frozen
  // conditional-clear path may do that).
  let holdConflict = false
  if (claim?.claimed) {
    const startingKind: 'clear' | 'schedule_rebuild_required' | 'reconciliation_blocked' =
      claim.previousBillingHold === null ? 'clear' : (claim.previousBillingHold.reason as 'schedule_rebuild_required' | 'reconciliation_blocked')
    const nextHold: BillingHold | null = computeReviewerPatchHoldTransition({
      startingKind, originalHold: claim.previousBillingHold, hasExistingBillingSchedule: claim.hasExistingBillingSchedule, now: new Date().toISOString(),
    })
    const { applied } = await applyReconciliationHoldTransition(supabaseServer, id, claim.newBillingHold, nextHold)
    holdConflict = !applied
  }

  return NextResponse.json({ ok: true, ...(holdConflict ? { holdConflict: true } : {}) })
}
