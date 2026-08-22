import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg, type OrgContext } from '@/lib/org'
import { configureBilling } from '@/lib/billing-writer'
import { computeCommercialRuleWorkload } from '@/lib/commercial-rule-status'
import { detectRuleInteractionCandidates } from '@/lib/rule-interactions'
import { setCustomerVatConfig, getCustomerVatConfig } from '@/lib/vat-service'
import { unwrapEmbedded } from '@/lib/postgrest-helpers'
import type { ContractTerms } from '@/lib/types'
import type { OperationalEventEvidence, OperationalEventEvidenceSource } from '@/lib/operational-event-evidence'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let org: OrgContext
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id } = await params
  const body = await req.json()
  const { modifiedLineItems, billing_platform: billingPlatformOverride } = body

  const { data: job, error } = await supabaseServer
    .from('jobs')
    .select('id, name, currency, billing_customer_id, billing_platform, execute_status, contract_terms ( * ), line_items ( * )')
    .eq('id', id)
    .eq('org_id', org.orgId)
    .single()

  if (error || !job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  // Never silently fall back to {} — an empty ContractTerms would push a
  // contract with no base fee, no dates, nothing, to the real billing
  // platform. A job reaching Approve must already have real contract_terms;
  // if it doesn't, that's a real error to surface, not paper over.
  const terms = unwrapEmbedded(job.contract_terms as unknown as ContractTerms | ContractTerms[])
  if (!terms) return NextResponse.json({ error: 'No contract terms found for this job — re-run extraction first.' }, { status: 400 })
  const lineItems = (modifiedLineItems ?? job.line_items ?? []) as Array<{
    product_name: string; quantity: number; unit_price: number
    billing_period: string; total_amount: number; currency: string
  }>

  // Server-side mirror of the Configure page's Approve-button gate — the
  // client disables the button until every extracted usage metric has a
  // confirmed contract_meter_mappings row, but that's UI-only. Without this
  // check, a contract can be pushed to billing (base fee configured) while
  // its usage-based overage silently has no meter mapped to pull from —
  // real billing would then skip it every cycle with no visible error.
  const unitTypes = Array.from(new Set((terms.overage_tiers ?? []).map(t => t.unit_type).filter(Boolean)))
  let meterMappingWorkload = { total: 0, confirmed: 1 }
  if (unitTypes.length > 0) {
    const { data: mappings } = await supabaseServer
      .from('contract_meter_mappings')
      .select('contract_unit_type, confirmed')
      .eq('job_id', id)
    const confirmedTypes = new Set((mappings ?? []).filter(m => m.confirmed).map(m => m.contract_unit_type))
    const unconfirmed = unitTypes.filter(u => !confirmedTypes.has(u))
    meterMappingWorkload = { total: 1, confirmed: unconfirmed.length === 0 ? 1 : 0 }
    if (unconfirmed.length > 0) {
      return NextResponse.json(
        { error: `Confirm billing meter mappings before approving: ${unconfirmed.join(', ')}` },
        { status: 400 },
      )
    }
  }

  // VAT must be explicitly configured (rate or zero-rated) before push —
  // never inferred, never silently defaulted. Staged on the job itself
  // (jobs.pending_vat_mode) until a billing_customer_id exists; promoted
  // into customer_vat_config below once configureBilling creates one.
  // Checked here for BOTH a first push and a re-push — previously this was
  // only checked when no billing_customer_id existed yet, silently trusting
  // that customer_vat_config could never regress to unconfigured for an
  // already-approved job. Feeds computeCommercialRuleWorkload's vat field
  // below so this is the exact same canonical signal the client's
  // vatConfigured state and the Review Panel's VAT card are built from.
  const existingCustomerId = (job as unknown as Record<string, unknown>).billing_customer_id as string | undefined
  let vatConfigured: boolean
  if (existingCustomerId) {
    const treatment = await getCustomerVatConfig(org.orgId, existingCustomerId)
    vatConfigured = !!treatment && treatment.mode !== 'not_configured'
  } else {
    const { data: vatRow } = await supabaseServer.from('jobs').select('pending_vat_mode').eq('id', id).single()
    vatConfigured = !!vatRow?.pending_vat_mode && vatRow.pending_vat_mode !== 'not_configured'
  }

  // Server-side mirror of the Configure page's commercial-rule-workload gate
  // (lib/commercial-rule-status.ts) — a minimum-commitment/tier-calculation/
  // escalator/discount/service-credit/rule-interaction left genuinely
  // unresolved must block the push, not just show a client-side badge that
  // a race or a bypassed request could skip past. This is the actual
  // enforcement the "Do not push this invoice" requirement depends on.
  const unresolvedInteractions = detectRuleInteractionCandidates({
    service_credits: terms.service_credits, discounts: terms.discounts, escalators: terms.escalators,
  }).filter(cand => {
    const credit = (terms.service_credits ?? []).find(c => c.credit_rule_id === cand.creditId)
    return !!credit?.interpretation && !credit.interpretation.requires_confirmation && !credit.interpretation.interaction_note
  })

  // Step 13 — real operational_event_evidence rows for this job, so the
  // executionBlockers check below (and configureBilling, further down)
  // both see whichever event-conditioned fees already have satisfied,
  // trusted evidence — never re-derived, always the same rows.
  const { data: evidenceRows } = await supabaseServer
    .from('operational_event_evidence')
    .select('*')
    .eq('job_id', id)
    .eq('status', 'active')
  const operationalEventEvidence: OperationalEventEvidence[] = (evidenceRows ?? []).map(r => ({
    id: r.id, subjectId: r.subject_id, eventType: r.event_type,
    occurredAt: r.occurred_at, source: r.source as OperationalEventEvidenceSource,
    recordedAt: r.recorded_at, recordedBy: r.recorded_by, status: r.status,
  }))
  const asOf = new Date()

  const workload = computeCommercialRuleWorkload(
    terms, meterMappingWorkload, unresolvedInteractions.length, undefined, { configured: vatConfigured },
    undefined, operationalEventEvidence, asOf,
  )
  // Step 11 final correction, item 5 — execution_blocked (Rulebook
  // invariant violations, and now real OneTimeFee capability blockers —
  // lib/commercial-rule-status.ts's UnsupportedCommercialSemanticsBlocker)
  // must be checked EXPLICITLY and FIRST. It is NOT implied by
  // totalToConfirm > 0: a capability-blocked one-time fee (unresolved_kind:
  // 'unsupported_semantics') is deliberately never counted as an ordinary,
  // reviewer-resolvable item (see isOneTimeFeeUnresolved's own comment —
  // there is nothing for a reviewer to pick between), so without this
  // check a capability-blocked fee could silently reach configureBilling
  // below. A genuine engine contradiction or modeling-capability gap fails
  // closed regardless of how resolved every other item is.
  if (workload.executionBlockers.length > 0) {
    return NextResponse.json(
      { error: `Billing blocked: Verdix cannot safely determine a billing instruction for ${workload.executionBlockers.length} item(s) — see execution blockers.`, executionBlockers: workload.executionBlockers },
      { status: 400 },
    )
  }
  if (workload.totalToConfirm > 0 || workload.interactionsToConfirm > 0) {
    return NextResponse.json(
      { error: `Confirm all commercial rules before approving — ${workload.totalToConfirm + workload.interactionsToConfirm} decision(s) outstanding.` },
      { status: 400 },
    )
  }
  if (!workload.vat.configured) {
    return NextResponse.json(
      { error: 'Billing blocked: VAT treatment has not been confirmed for this customer/invoice.' },
      { status: 400 },
    )
  }

  // Step 13 final execution-state correction — the claim boundary, audited
  // from the Approve lifecycle itself (not copied from a UI array; UI
  // actionability and financial-side-effect eligibility are different
  // concepts). Confirmed by auditing lib/billing-writer.ts: Stripe's
  // invoice-write calls carry no idempotency key at all, and Remembill's
  // only survives a same-request retry, not a second Approve call (see the
  // catch block below) — so a billing attempt may NEVER be allowed to begin
  // twice for outcomes that are already known. Only two states represent
  // "a billing attempt has legitimately never yet been made for this job's
  // current configuration":
  //   - PENDING_HUMAN_REVIEW — the client's own promotion-to-READY_TO_APPROVE
  //     PATCH is a separate, non-atomic call the Approve button does not
  //     wait on, so a real request can legitimately arrive here first.
  //   - READY_TO_APPROVE — the canonical ready state.
  // COMPLETED is deliberately EXCLUDED, absolutely: it means a billing
  // attempt already succeeded once, and given the confirmed lack of
  // downstream idempotency, re-running configureBilling for it (the
  // previous "re-push to sync edited terms" behavior) risks a real
  // duplicate invoice — that capability is removed here, not preserved.
  // FAILED is deliberately EXCLUDED too: it means a PRIOR attempt occurred
  // whose external outcome may be genuinely uncertain (see the catch block)
  // — retrying it automatically, even via a normal Approve click, is
  // exactly the unsafe case this correction closes. A FAILED job can only
  // become re-approvable via the explicit, admin-only, audited action in
  // POST /api/jobs/[id]/authorize-billing-retry, which resets it to
  // READY_TO_APPROVE only after a human has verified the billing platform.
  // APPROVING itself is excluded because a claim is already in flight.
  //
  // Tried sequentially (not a single `.in()`) so a successful claim also
  // tells us exactly which state it came from — needed below to restore
  // the correct, real state on a pre-effect validation failure (item 3):
  // a deterministic failure with no external attempt must never land in
  // the same ambiguous FAILED state used for "the external call itself may
  // have partially executed." Each attempt is still a single atomic
  // conditional UPDATE, so two concurrent requests can still only ever
  // produce exactly one winner overall (Postgres serializes each
  // individual UPDATE ... WHERE regardless of which candidate value it
  // targets).
  async function claimForApproval(): Promise<'PENDING_HUMAN_REVIEW' | 'READY_TO_APPROVE' | null> {
    for (const from of ['PENDING_HUMAN_REVIEW', 'READY_TO_APPROVE'] as const) {
      const { data } = await supabaseServer
        .from('jobs')
        .update({ execute_status: 'APPROVING' })
        .eq('id', id)
        .eq('org_id', org.orgId)
        .eq('execute_status', from)
        .select('id')
      if (data && data.length > 0) return from
    }
    return null
  }

  const claimedFrom = await claimForApproval()
  if (!claimedFrom) {
    // Item 1/2/10 — a structured, specific reason, not a single generic
    // "in progress" message: read the job's current status (this read is
    // purely for an accurate message — the actual claim rejection above
    // was already atomic and race-safe regardless of what this shows).
    const { data: currentJobRow } = await supabaseServer.from('jobs').select('execute_status').eq('id', id).single()
    const currentStatus = currentJobRow?.execute_status
    if (currentStatus === 'COMPLETED') {
      return NextResponse.json(
        { error: 'This contract has already been configured for billing. Re-pushing is not permitted — Stripe/Remembill invoice creation is not safely repeatable.', code: 'billing_already_executed' },
        { status: 409 },
      )
    }
    if (currentStatus === 'FAILED') {
      return NextResponse.json(
        { error: 'A prior billing attempt for this job failed or had an uncertain outcome. Verify Stripe/Remembill, then use "Authorize billing retry" before approving again.', code: 'billing_retry_requires_verification' },
        { status: 409 },
      )
    }
    // Part B, item 10 — machine-readable `code`, matching revoke's own
    // convention, so a losing concurrent request (or a test) never has to
    // string-match the message, and never proceeds with the readiness
    // snapshot it computed before losing the claim.
    return NextResponse.json(
      { error: 'This job is already being approved by another request — please wait for it to finish.', code: 'billing_in_progress' },
      { status: 409 },
    )
  }

  try {
    // A job already configured on a platform must stay on it — repushing
    // (e.g. to sync edited terms) must never silently switch platforms.
    // detectOrgPlatform() inside configureBilling picks arbitrarily among an
    // org's active connectors when more than one is configured, which is
    // only safe to fall back on for a job that's never been pushed before.
    const existingPlatform = (job as unknown as Record<string, unknown>).billing_platform as string | null
    const platformToUse = billingPlatformOverride ?? existingPlatform ?? undefined

    // Item 6 — the authoritative billing boundary re-checks evidence FRESH,
    // immediately before the external side effect, rather than trusting the
    // snapshot computed for the gate above (which may now be seconds
    // stale). "No currently active matching evidence -> no event-based fee
    // reaches external billing" — enforced here, not just earlier in the
    // request.
    const { data: freshEvidenceRows } = await supabaseServer
      .from('operational_event_evidence')
      .select('*')
      .eq('job_id', id)
      .eq('status', 'active')
    const freshEvidence: OperationalEventEvidence[] = (freshEvidenceRows ?? []).map(r => ({
      id: r.id, subjectId: r.subject_id, eventType: r.event_type,
      occurredAt: r.occurred_at, source: r.source as OperationalEventEvidenceSource,
      recordedAt: r.recorded_at, recordedBy: r.recorded_by, status: r.status,
    }))
    const freshWorkload = computeCommercialRuleWorkload(
      terms, meterMappingWorkload, unresolvedInteractions.length, undefined, { configured: vatConfigured },
      undefined, freshEvidence, new Date(),
    )
    if (freshWorkload.executionBlockers.length > 0) {
      // Item 3 — no external attempt has happened yet at this point (the
      // only thing that could throw ahead of it, configureBilling, hasn't
      // been called), so no retry-ambiguity exists. Restoring the job to
      // whichever real state it was legitimately claimed FROM — never the
      // same 'FAILED' state used for a genuinely uncertain external
      // outcome — keeps those two failure classes visibly distinct and
      // lets the reviewer immediately retry from a normal, non-alarming
      // state once they've addressed whatever changed (e.g. re-recording
      // revoked evidence).
      await supabaseServer.from('jobs').update({ execute_status: claimedFrom }).eq('id', id).eq('execute_status', 'APPROVING')
      return NextResponse.json(
        { error: 'Billing blocked: operational evidence changed while this approval was in progress — please review and retry.', executionBlockers: freshWorkload.executionBlockers },
        { status: 400 },
      )
    }

    const result = await configureBilling(terms, lineItems, platformToUse, id, org.orgId, existingCustomerId ?? undefined, freshEvidence)

    // Promote the job's pending VAT treatment (set pre-approval, since no
    // billing_customer_id existed to key customer_vat_config on yet) into
    // the real customer_vat_config row now that configureBilling has
    // created one — every future invoice for this customer inherits it as
    // its standing default from here on. A re-push that already has a
    // customer (existingCustomerId was set) already has its VAT configured
    // via customer_vat_config directly and skips this. Deliberately BEFORE
    // the execute_status: 'COMPLETED' write below (and fails the whole
    // approval, via the catch block, if the promotion write errors) — a
    // job must never be marked COMPLETED with its confirmed VAT rate still
    // stuck in pending_vat_*, silently invisible to every real consumer
    // (invoice creation, Review Panel, Billing Summary). This used to run
    // AFTER the COMPLETED write with its error only logged, which is
    // exactly how a job could end up approved with an orphaned pending
    // value — GET /vat-config self-heals any pre-existing case of that
    // (lib/vat-service.ts's resolveEffectiveVatForJob), but new approvals
    // should never create a fresh one.
    if (!existingCustomerId) {
      const { data: vatRow } = await supabaseServer.from('jobs').select('pending_vat_mode, pending_vat_rate_pct').eq('id', id).single()
      if (vatRow?.pending_vat_mode && vatRow.pending_vat_mode !== 'not_configured') {
        const { error: vatError } = await setCustomerVatConfig(
          org.orgId, result.customerId,
          { mode: vatRow.pending_vat_mode, ratePct: vatRow.pending_vat_mode === 'rate' ? vatRow.pending_vat_rate_pct : null },
          org.userEmail,
        )
        if (vatError) throw new Error(`VAT promotion failed: ${vatError}`)
      }
    }

    await supabaseServer.from('jobs').update({
      execute_status: 'COMPLETED',
      billing_platform: result.platform,
      billing_subscription_id: result.subscriptionId,
      billing_customer_id: result.customerId,
    }).eq('id', id)

    // A job can no longer reach this point already COMPLETED (item 1 — the
    // claim only ever succeeds from PENDING_HUMAN_REVIEW/READY_TO_APPROVE),
    // so every successful configuration here is genuinely the first (or, if
    // it followed an explicit admin retry authorization after a FAILED
    // attempt, a deliberate, verified new one) — always worth a sync event.
    const { recordSync } = await import('@/lib/billing')
    await recordSync(org.orgId, id, 'contract_configure').catch(err => console.error('[approve] recordSync failed', err))

    return NextResponse.json({
      success: true,
      platform: result.platform,
      stripeSubscriptionId: result.subscriptionId,
      customerId: result.customerId,
      dashboardUrl: result.dashboardUrl,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Part B, item 8 — everything that reaches this catch block happens
    // AT OR AFTER the configureBilling() call: the only thing in the try
    // block before it is the freshWorkload re-check above, which returns
    // its own explicit 400 response directly and never throws. So a
    // failure here means the external Stripe/Remembill side effect may
    // already have partially or fully happened, even though this request
    // is reporting an error.
    //
    // Audited (not assumed) whether a blind retry would be safe:
    // lib/billing-writer.ts's configureStripe calls stripe.invoices.create/
    // invoiceItems.create/finalizeInvoice with NO idempotency key at all —
    // only customer creation has a soft, name-based dedup search. configure
    // Rememhill's invoice creation DOES send an `Idempotency-Key` header,
    // but it's built from `pushStamp = Date.now().toString(36)`, generated
    // fresh on every call to configureRememhill — so it does NOT protect a
    // genuine retry from a second Approve request (a new pushStamp means a
    // new key, which Remembill will not recognize as a duplicate); its row-
    // creation endpoint (POST /invoices/:id/rows) carries no idempotency
    // key at any layer. Neither platform's write path is provably safe to
    // blindly retry — so per item 8's "use the smallest existing failure/
    // manual-reconciliation state rather than pretending execution
    // definitely failed," this stays 'FAILED' (the only failure state this
    // app has — no new state invented), but the message makes the
    // ambiguity explicit rather than inviting an immediate reflexive retry.
    // Manual recovery — verify the platform, then POST
    // /api/jobs/[id]/authorize-billing-retry (item 5) — is the only
    // documented path back to an approvable state from here; the claim
    // boundary above now refuses to re-enter APPROVING from FAILED
    // directly, for exactly this reason.
    const ambiguousMessage = `Billing may have partially executed on the billing platform before this error — verify in Stripe/Remembill for a duplicate or partial invoice before retrying. Original error: ${message}`
    await supabaseServer.from('jobs').update({
      execute_status: 'FAILED',
      error_message: ambiguousMessage,
    }).eq('id', id)
    return NextResponse.json({ error: ambiguousMessage }, { status: 500 })
  }
}
