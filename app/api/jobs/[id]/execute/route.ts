import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { extractContractTerms } from '@/lib/contract-extractor'
import { resolveStorageUrl } from '@/lib/storage'
import { maskText, restoreTokensInObject } from '@/lib/pii-detector'
import { buildLineItems } from '@/lib/line-items'
import { extractDocumentText, isAIInfraError, AI_INFRA_ERROR_PREFIX } from '@/lib/ai-client'
import { preserveStableRuleIds, preserveOneTimeFeeIdentity, preserveTierIdentity, preserveTierCalculationReviewState, preserveRecurringFeeIdentity, type TierCalculationAuditRow } from '@/lib/rule-id-stability'
import { mergeBaseFeeProrationDecision, mergeFixedFeeBillingTimingDecision, mergeVariableInvoiceTimingForFees, mergeRecurringFeeProrationForFees, preserveDiscountIdentity, type CurrentRuleAuditRow } from '@/lib/contract-terms-merge'
import { buildContractTermsUpsertPayload } from '@/lib/contract-terms-persistence'
import type { Discount, ServiceCredit, OneTimeFee, OverageTier, AdditionalRecurringFee } from '@/lib/types'
import type { BillingHold } from '@/lib/billing-hold'
import { reconcileCurrentLineItemsForJob, type ReconciliationOrchestrationResult } from '@/lib/current-line-item-reconciliation-orchestration'
import { computeReconciliationHoldTransition, buildReconciliationBlockerDiagnostic, isReconciliationOutcomeClean, applyReconciliationHoldTransition } from '@/lib/reconciliation-hold-transition'
import { establishInitialCommercialSnapshot } from '@/lib/initial-commercial-snapshot'

// Step 17H.4B0D4H1B3 — the JSON shape begin_job_reexecution (supabase/
// migrations/20260914000001_reexecution_claim_and_hold_transition.sql)
// returns. previous_billing_hold/new_billing_hold are trusted as
// already-validated BillingHold|null here — the RPC itself refuses the
// claim outright (claimed:false, reason:'malformed_hold') for any
// unreadable prior hold, so a claimed:true result can never carry a
// malformed value in either field.
type BeginJobReexecutionResult =
  | { claimed: false; reason: 'not_found' | 'malformed_hold' | 'wrong_module' }
  | { claimed: false; reason: 'status_conflict'; current_execute_status: string }
  | {
      claimed: true
      previous_execute_status: string
      previous_billing_hold: BillingHold | null
      new_billing_hold: BillingHold | null
      has_existing_billing_schedule: boolean
    }


// runExecutePipeline's real worst case is two AI-client tiers stacked
// sequentially, not one: when pending_extracted_text is absent (every
// retry of a job whose first attempt already consumed and nulled it — see
// runExecutePipeline below — plus any job that never went through
// detect-pii's PII-review step), this route falls back to re-downloading
// and re-running document extraction itself
// (AI_DOCUMENT_EXTRACTION_TIMEOUT_MS: 170s x 1 attempt) before
// extractContractTerms's own worst case (AI_CLIENT_TIMEOUT_MS: 60s x up to
// 3 attempts = 180s) even starts — 350s combined. The previous 300s budget
// only ever covered the second half; a route killed by the PLATFORM before
// its own .catch() below can run never gets to write
// execute_status: 'FAILED', leaving the job stuck at 'EXTRACTING' forever
// with no error surfaced —
// the exact failure mode already documented and fixed once for
// detect-pii/route.ts (same reasoning, same >=30s headroom convention).
export const maxDuration = 380

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let org
  try { org = await requireOrg() } catch (res) { return res as Response }

  const { id } = await params

  const { data: job, error: jobError } = await supabaseServer
    .from('jobs')
    .select('id, name, module, currency, contract_pdf_url, contract_terms_id')
    .eq('id', id)
    .eq('org_id', org.orgId)
    .single()

  if (jobError || !job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  // Step 17H.4B0D4H1B3.3 — hard module boundary, mirroring audit/route.ts's
  // own BILLING_VERIFICATION-only guard from the other direction. Before
  // this, nothing (not this route, not begin_job_reexecution, not a DB
  // constraint) stopped a BILLING_VERIFICATION or PARTNER_RECON job's id
  // from being POSTed here and launching the AUTO_CONFIGURE extraction
  // pipeline against it — the separation was UI convention only. Checked
  // BEFORE any side effect: before begin_job_reexecution, before
  // execute_status/billing_hold change, before any extraction work.
  if (job.module !== 'AUTO_CONFIGURE') {
    return NextResponse.json({ error: 'This operation is only available for auto-configuration jobs.' }, { status: 400 })
  }

  // Step 17H.4B0D4H1B3 — atomic claim + billing_hold establishment, ONE
  // RPC call. Previously this route claimed execute_status='EXTRACTING' in
  // its own UPDATE and a LATER, separate step established billing_hold —
  // leaving a real, externally-observable window where the job read as
  // EXTRACTING with billing_hold still NULL, during which the scheduler's
  // hold-aware claim (jobs FOR SHARE) could incorrectly proceed against
  // commercial state a re-execution had already started overwriting.
  // begin_job_reexecution closes that window by making both changes commit
  // together, and also closes the APPROVING race the old `.neq('execute_
  // status','EXTRACTING')` guard never covered — a re-execution could
  // previously begin while an Approve request was still in flight for the
  // job's CURRENT commercial terms.
  const startedAt = new Date().toISOString()
  const { data: beginResult, error: beginError } = await supabaseServer.rpc('begin_job_reexecution', {
    p_job_id: id, p_started_at: startedAt,
  })
  if (beginError) {
    return NextResponse.json({ error: `Failed to start extraction: ${beginError.message}` }, { status: 500 })
  }
  const begin = beginResult as BeginJobReexecutionResult
  if (!begin.claimed) {
    if (begin.reason === 'status_conflict' && begin.current_execute_status === 'APPROVING') {
      return NextResponse.json({ error: 'This contract is currently being approved — please wait for it to finish before re-running extraction.' }, { status: 409 })
    }
    if (begin.reason === 'malformed_hold') {
      return NextResponse.json({ error: 'Billing configuration hold could not be read safely. Refusing to start extraction until it is resolved.' }, { status: 409 })
    }
    // Defense-in-depth only — the route-level module guard above already
    // rejects this case before the RPC is ever called; reaching this
    // branch would mean that guard was somehow bypassed.
    if (begin.reason === 'wrong_module') {
      return NextResponse.json({ error: 'This operation is only available for auto-configuration jobs.' }, { status: 400 })
    }
    return NextResponse.json({ error: 'Extraction is already in progress for this job.' }, { status: 409 })
  }

  waitUntil(
    runExecutePipeline(id, org.orgId, job.contract_pdf_url, job.currency, job.contract_terms_id, begin).catch(async (err) => {
      const rawMessage = err instanceof Error ? err.message : String(err)
      // AI-infra failures (out of Anthropic credit, rate-limited, timed out,
      // etc.) are an admin problem to fix, not something a customer can act
      // on — prefix so the GET /api/jobs/[id] handler can show the real
      // detail to admins only and a generic "contact us" message to everyone
      // else, without needing a schema change to track it separately.
      const message = isAIInfraError(err) ? `${AI_INFRA_ERROR_PREFIX}${rawMessage}` : rawMessage
      await supabaseServer.from('jobs').update({
        execute_status: 'FAILED',
        error_message: message,
      }).eq('id', id)
    })
  )

  return NextResponse.json({ jobId: id, status: 'EXTRACTING' })
}

async function runExecutePipeline(
  jobId: string, orgId: string, contractUrl: string | null, currency: string, existingContractTermsId: string | null,
  begin: Extract<BeginJobReexecutionResult, { claimed: true }>,
) {
  if (!contractUrl) throw new Error('Missing contract file')

  // Step 17H.4B0D4H1B3 — tracks the ONE load-bearing boundary for billing_
  // hold restoration: whether fresh contract_terms has committed yet. A
  // failure BEFORE this point means Generation N's commercial truth is
  // still fully intact — billing may safely resume under whatever hold
  // predated this re-execution attempt. A failure AT OR AFTER this point
  // means Generation N+1 is now live and (for a previously-approved job)
  // may not yet be safely reconciled against current_line_items — billing
  // must remain held regardless of how the rest of this pipeline fails.
  let termsCommitted = false

  try {
  // Reuse detect-pii's extraction if this job already went through PII
  // detection — avoids a second identical Bedrock call re-extracting the
  // same PDF, and (when present) skips re-downloading the file too.
  const { data: pendingRow } = await supabaseServer
    .from('jobs')
    .select('pending_extracted_text')
    .eq('id', jobId)
    .maybeSingle()

  let contractText: string
  if (pendingRow?.pending_extracted_text) {
    contractText = pendingRow.pending_extracted_text
    await supabaseServer.from('jobs').update({ pending_extracted_text: null }).eq('id', jobId)
  } else {
    const resolvedUrl = await resolveStorageUrl(contractUrl)
    const res = await fetch(resolvedUrl)
    if (!res.ok) throw new Error(`Failed to download contract`)
    const buffer = Buffer.from(await res.arrayBuffer())
    contractText = await extractPDFText(buffer, resolvedUrl)
  }

  // PII masking is a baseline control for every org, not a paid add-on — use
  // approved entities from DB (set during PII review step), falling back to
  // auto-detection if no reviewed entities exist yet for this job/org.
  const { tokenMap, reverseMap } = await buildMaskFromDB(jobId, orgId, contractText)
  const textToExtract = maskText(contractText, tokenMap)

  const rawTerms = await extractContractTerms(textToExtract, undefined, tokenMap.size > 0)

  // Restore PII tokens in string fields so the saved record has real values.
  const terms = restoreTokensInObject(rawTerms, reverseMap)

  // Re-extraction must not reassign discount_rule_id/credit_rule_id for
  // items that already existed — that would orphan any reviewer-confirmed
  // .interpretation and the commercial_rule_interpretations audit rows that
  // address it by that id. Match by description against whatever this job's
  // prior contract_terms row had (if any) and carry the id + interpretation
  // forward; a genuinely new item still gets a fresh id via
  // assignDiscountRuleIds/assignServiceCreditRuleIds inside extraction.
  if (existingContractTermsId) {
    // Step 17H.4B0D4B1A — overage_tiers added to this read. Previously
    // (17H.4B0A's own audit finding) this prior-terms load covered
    // discounts/service_credits/one_time_fees only — overage_tiers (and
    // escalators, still not covered) were replaced wholesale by every
    // re-extraction with no identity continuity at all.
    const { data: priorTerms } = await supabaseServer
      .from('contract_terms')
      .select('discounts, service_credits, one_time_fees, overage_tiers, additional_recurring_fees')
      .eq('id', existingContractTermsId)
      .maybeSingle()
    if (priorTerms) {
      // Step 17H.4B0D4H1B4E3.3 §12/§13 — replaces preserveStableRuleIds'
      // raw-description-text matching for discounts specifically with a
      // typed structural fingerprint (lib/contract-terms-merge.ts's
      // preserveDiscountIdentity) — description text is LLM-generated
      // prose that can drift between extractions of the identical source
      // (§11), which is exactly what orphaned a real confirmed discount
      // interpretation in the E3 fresh-extraction acceptance pass.
      // service_credits keeps the original description-matched
      // preserveStableRuleIds unchanged — not implicated in Finding #2,
      // out of this pass's scope (§41, no scope creep).
      terms.discounts = preserveDiscountIdentity(
        (priorTerms.discounts ?? []) as Discount[], terms.discounts ?? [],
      )
      terms.service_credits = preserveStableRuleIds(
        (priorTerms.service_credits ?? []) as ServiceCredit[], terms.service_credits ?? [], 'credit_rule_id',
      )
      // Step 13 final amendment — same identity-preservation requirement,
      // for OneTimeFee.fee_id (see lib/rule-id-stability.ts's own comment
      // for the full rationale — this is what keeps operational_event_
      // evidence rows from being silently orphaned by a re-extraction).
      // Must run BEFORE applyExtractionSafetyNets's own normalization
      // inside extractContractTerms already ran — it did, above, on the raw
      // freshly-extracted terms; this preservation pass now retroactively
      // restores the PRIOR fee_id/reviewed-state onto whichever freshly-
      // normalized fee matches by description, so a stable identity is
      // never lost merely because normalizeBillabilityCondition already
      // assigned a new one moments earlier in this same request.
      terms.one_time_fees = preserveOneTimeFeeIdentity(
        (priorTerms.one_time_fees ?? []) as OneTimeFee[], terms.one_time_fees ?? [],
      )
      // Step 17H.4B0D4B1A — tier_id preservation, structurally fingerprinted
      // (see lib/rule-id-stability.ts's preserveTierIdentity for the full
      // doctrine). extractContractTerms's own post-processing already ran
      // assignTierIds above (assigning a fresh id to every tier that didn't
      // already have one from this raw extraction pass) — this retroactively
      // restores the PRIOR tier_id onto whichever freshly-extracted tier
      // structurally matches it 1:1, exactly mirroring the one-time-fee
      // pattern immediately above.
      terms.overage_tiers = preserveTierIdentity(
        (priorTerms.overage_tiers ?? []) as OverageTier[], terms.overage_tiers ?? [],
      )
      // Step 17H.4B0D4B1B0D — tier_calculation reviewer-state preservation.
      // A DIFFERENT identity question from tier_id immediately above (see
      // lib/rule-id-stability.ts's preserveTierCalculationReviewState for
      // the full doctrine): whether a prior confirm-rule action explicitly
      // approved this metric's graduated/volume/block/custom reading, keyed
      // by exact unit_type, corroborated only by a CURRENT
      // commercial_rule_interpretations row — never by the prior JSONB's
      // requires_confirmation value alone, which cannot distinguish
      // reviewer-confirmed from merely extractor-confident.
      //
      // A query failure here must not be silently treated as "no reviewer
      // evidence" — that would downgrade an infrastructure read failure into
      // a false conclusion that nothing was ever reviewed, incorrectly
      // reopening metrics a human already confirmed. Fail the whole
      // extraction pass (existing .catch() at the route's call site already
      // marks the job FAILED) rather than continue with an unreliable empty
      // evidence set.
      const { data: currentTierCalculationAudit, error: tierCalculationAuditError } = await supabaseServer
        .from('commercial_rule_interpretations')
        .select('contract_unit_type, approved_interpretation')
        .eq('job_id', jobId)
        .eq('rule_type', 'tier_calculation')
        .eq('is_current', true)
      if (tierCalculationAuditError) {
        throw new Error(`Failed to load tier_calculation review evidence: ${tierCalculationAuditError.message}`)
      }
      terms.overage_tiers = preserveTierCalculationReviewState(
        (priorTerms.overage_tiers ?? []) as OverageTier[], terms.overage_tiers ?? [],
        (currentTierCalculationAudit ?? []) as TierCalculationAuditRow[],
      )

      // Step 17H.4B0D4H1B4E3.4 — recurring_fee_id preservation, BEFORE the
      // variable_invoice_timing merge below (which is fee_label-keyed and
      // independent of this, but conceptually identity should stabilize
      // first). See lib/rule-id-stability.ts's preserveRecurringFeeIdentity
      // for the full doctrine — a typed structural fingerprint (semantic
      // metric/cadence/derived-metric shape), never fee_label text, which
      // is exactly what a live re-extraction of the identical NordicFit
      // PDF proved unstable ("Success fee per completed payment" vs
      // "Per-completed payment success fee").
      terms.additional_recurring_fees = preserveRecurringFeeIdentity(
        (priorTerms.additional_recurring_fees ?? []) as AdditionalRecurringFee[], terms.additional_recurring_fees ?? [],
      )
    }

    // Step 17H.4B0D4H1B4E3.3 §7-§9, extended 17H.4B0D4H1B4E3.4.2 — the
    // reviewer-decision fields that had NO preservation at all before these
    // passes (base_fee_proration, fixed_fee_billing_timing,
    // variable_invoice_timing, recurring_fee_proration): same doctrine as
    // tier_calculation immediately above (a corroborating CURRENT
    // commercial_rule_interpretations row is the sole authority a decision
    // was actually reviewer-confirmed — never the prior JSONB's
    // requires_confirmation value alone), applied via lib/contract-terms-
    // merge.ts. One query covers all four rule types for this job.
    const { data: currentDecisionAudit, error: decisionAuditError } = await supabaseServer
      .from('commercial_rule_interpretations')
      .select('rule_type, contract_unit_type, approved_interpretation')
      .eq('job_id', jobId)
      .in('rule_type', ['base_fee_proration', 'fixed_fee_billing_timing', 'variable_invoice_timing', 'recurring_fee_proration'])
      .eq('is_current', true)
    if (decisionAuditError) {
      throw new Error(`Failed to load reviewer-decision evidence: ${decisionAuditError.message}`)
    }
    const auditRows = (currentDecisionAudit ?? []) as Array<CurrentRuleAuditRow & { rule_type: string }>
    const byRuleType = (ruleType: string): CurrentRuleAuditRow[] => auditRows.filter(r => r.rule_type === ruleType)

    terms.base_fee_proration = mergeBaseFeeProrationDecision(terms.base_fee_proration, byRuleType('base_fee_proration'))
    terms.fixed_fee_billing_timing = mergeFixedFeeBillingTimingDecision(terms.fixed_fee_billing_timing, byRuleType('fixed_fee_billing_timing'))
    terms.additional_recurring_fees = mergeVariableInvoiceTimingForFees(
      terms.additional_recurring_fees ?? [], byRuleType('variable_invoice_timing'),
    )
    terms.additional_recurring_fees = mergeRecurringFeeProrationForFees(
      terms.additional_recurring_fees ?? [], byRuleType('recurring_fee_proration'),
    )
  }

  // Build proposed line items from contract terms
  const lineItems = buildLineItems(terms, currency)

  // Save contract terms — pick only known schema columns explicitly so any
  // novel LLM-extracted field (e.g. ramp_schedule) doesn't break the write.
  // The full raw extraction is stored in raw_extraction for auditability.
  // Upsert on job_id (contract_terms_job_id_unique) rather than insert —
  // contract_terms is one canonical row per job; a plain insert on
  // re-extraction used to silently create a second row, breaking confirm-rule
  // and letting other routes read stale data.
  // buildContractTermsUpsertPayload (lib/contract-terms-persistence.ts) is
  // the single source of truth for which fields actually reach the
  // database — see its own comment for why this was pulled out into a
  // directly-testable function (Step 17B0.2: several fields were correct
  // in `terms` here but silently excluded from this literal object for a
  // long time, because the missing DB column was never migrated).
  const { data: savedTerms, error: termsError } = await supabaseServer
    .from('contract_terms')
    .upsert(buildContractTermsUpsertPayload(jobId, terms), { onConflict: 'job_id' })
    .select('id')
    .single()
  if (termsError) throw new Error(`Failed to save contract terms: ${termsError.message}`)

  // Step 17H.4B0D4H1B3 — Generation N+1's commercial truth is now live.
  // From this point on, a failure anywhere below must NEVER restore the
  // billing_hold this execution attempt started under (see the catch
  // block's own comment) — billing stays held until reconciliation is
  // resolved, one way or another.
  termsCommitted = true

  // Step 17H.4B0D4H1B3 — the unconditional line_items INSERT this route
  // used to perform is REMOVED. The only generation-mutation path for
  // current_line_items is now the pure planner (lib/current-line-item-
  // reconciliation-plan.ts) + atomic applier (lib/current-line-item-
  // reconciliation-applier.ts), invoked through the shared orchestration
  // helper — never a second, competing raw insert. Any exception the
  // orchestration itself throws (its own read of current_line_items
  // failing, e.g.) is caught HERE, not allowed to propagate to this
  // function's outer catch below — an orchestration failure happens
  // strictly AFTER termsCommitted=true, so it must be treated exactly
  // like any other non-clean reconciliation outcome (leave billing held,
  // set execute_status to PENDING_HUMAN_REVIEW), never as a reason to
  // restore the pre-execution hold.
  //
  // Step 17H.4B0D4H1B4E3.1 — before running the normal Model B+
  // reconciliation orchestration (which treats an empty current-row set as
  // a real reconciliation problem for any weak-identity family — see
  // lib/initial-commercial-snapshot.ts's own header for the full root-cause
  // trace), always attempt initialization first. This is safe to attempt
  // unconditionally on every execute: establishInitialCommercialSnapshot
  // itself re-derives eligibility from durable evidence
  // (commercial_snapshot_initialized_at, existing line_items/planned_
  // invoices/billing_customer_id/billing_platform) every time it's called,
  // so on every execute AFTER the job's real first one it correctly,
  // immediately falls through to normal reconciliation below — this is not
  // a "first execute vs. later execute" branch the caller has to track
  // itself, it is the SAME eligibility decision, freshly re-evaluated.
  const initResult = await establishInitialCommercialSnapshot({
    supabase: supabaseServer, jobId, freshItems: lineItems,
  })

  let reconciliationResult: ReconciliationOrchestrationResult
  if (initResult.status === 'initialized') {
    // A clean initial snapshot IS the job's current commercial
    // configuration now — there is nothing left to reconcile against it in
    // this same execute pass. Represented as an ordinary clean 'applied'
    // outcome so every line below (execute_status, billing_hold
    // transition) runs through the exact same shared logic a normal clean
    // reconciliation would — no separate "initialization" branch needed
    // past this point (§14: billing_hold must resolve to NULL/schedule_
    // rebuild_required here exactly as any other clean reexecution
    // outcome would, never reconciliation_blocked).
    reconciliationResult = {
      status: 'applied', updatedCount: 0, insertedCount: initResult.insertedCount, supersededCount: 0,
      blockers: [], retried: false,
    }
  } else if (initResult.status === 'not_initialization_eligible') {
    // Either this job already has an established snapshot (the common,
    // ongoing-lifecycle case — normal Model B+ applies, unchanged, §16),
    // or a concurrent initializer won the race (§13), or durable evidence
    // shows an ambiguous legacy configuration this pass must not silently
    // re-baseline (§5/§17/§18) — every one of these must fall through to
    // the SAME frozen reconciliation path a pre-E3.1 execute would have
    // run.
    reconciliationResult = await reconcileCurrentLineItemsForJob({
      supabase: supabaseServer, jobId,
      freshItems: lineItems,
      terms: {
        overage_tiers: terms.overage_tiers ?? [],
        additional_recurring_fees: terms.additional_recurring_fees ?? [],
        base_fee_proration: terms.base_fee_proration ?? null,
      },
    }).catch((err): ReconciliationOrchestrationResult => ({
      status: 'error', errorMessage: err instanceof Error ? err.message : String(err), blockers: [], retried: false,
    }))
  } else if (initResult.status === 'invalid_plan') {
    // A genuine intrinsic defect in this extraction's own fresh batch
    // (duplicate fee_id/tier_id, malformed row) — §7 requires this to
    // still fail, never be silently treated as a normal empty-current-set
    // reconciliation (which would itself just re-derive the same
    // unknown_identity blockers for weak families, obscuring the real,
    // more specific cause).
    reconciliationResult = { status: 'invalid_plan', invalidReason: initResult.reason, blockers: [], retried: false }
  } else {
    reconciliationResult = { status: 'error', errorMessage: initResult.message, blockers: [], retried: false }
  }

  if (reconciliationResult.status === 'error') {
    console.error(`[execute] reconciliation orchestration failed for job ${jobId}:`, reconciliationResult.errorMessage)
  }

  const reconciliationClean = isReconciliationOutcomeClean(reconciliationResult)
  const needsReviewFromConfidence = lineItems.some(i => i.confidence_score < 0.95)
  // §21 — reconciliation problems (blockers, stale after retry, invalid,
  // infra error) always force PENDING_HUMAN_REVIEW, regardless of
  // confidence; a genuinely clean reconciliation falls back to the
  // existing, unchanged confidence rule.
  const finalExecuteStatus = !reconciliationClean
    ? 'PENDING_HUMAN_REVIEW'
    : (needsReviewFromConfidence ? 'PENDING_HUMAN_REVIEW' : 'READY_TO_APPROVE')

  // Step 17H.4B0D4H1B3.4 — every AUTO_CONFIGURE execution attempt now
  // establishes a real reexecution hold (begin_job_reexecution no longer
  // conditions it on billing_customer_id), so this transition always runs
  // — never gated on has_existing_billing_schedule. That flag now only
  // decides the CLEAN target: schedule_rebuild_required when an existing
  // schedule may have just gone stale, NULL when there was never one to
  // protect (a never-approved job). A non-clean outcome always lands on
  // reconciliation_blocked regardless — an unresolved reconciliation
  // problem must block first Approval exactly as it blocks a rebuild.
  const diagnostic = buildReconciliationBlockerDiagnostic(reconciliationResult)
  const transition = computeReconciliationHoldTransition({
    startingKind: 'reexecution',
    currentHold: begin.new_billing_hold,
    outcomeClean: reconciliationClean,
    hasExistingBillingSchedule: begin.has_existing_billing_schedule,
    blockerDiagnostic: diagnostic,
    now: new Date().toISOString(),
  })
  if (transition.changeNeeded) {
    const { applied } = await applyReconciliationHoldTransition(supabaseServer, jobId, begin.new_billing_hold, transition.nextHold)
    if (!applied) {
      // §19 — a CAS miss means a newer hold event already superseded
      // this execution's own reexecution hold (e.g. a second concurrent
      // re-execution attempt). Never overwrite it — just log; the newer
      // state is authoritative and this attempt's own outcome is still
      // correctly reflected via execute_status above.
      console.error(`[execute] hold transition CAS missed for job ${jobId} — a newer billing_hold already exists; leaving it untouched.`)
    }
  }

  // currency is included here too, not just on contract_terms —
  // jobs.currency is what the agreement-list pages actually display, and
  // it was otherwise left at its creation-time placeholder ('USD') forever,
  // silently diverging from the real extracted currency on contract_terms.
  // Only overwritten when extraction actually found a currency — never
  // clobber a good prior value with null.
  await supabaseServer.from('jobs').update({
    execute_status: finalExecuteStatus,
    contract_terms_id: savedTerms?.id,
    ...(terms.currency ? { currency: terms.currency } : {}),
  }).eq('id', jobId)
  } catch (err) {
    // Step 17H.4B0D4H1B3 §7-10 — the ONE place billing_hold is ever
    // restored. Only attempted when contract_terms never committed (the
    // prior generation's commercial truth is still fully intact, so
    // whatever hold predated this re-execution attempt is still exactly
    // correct) — restoring it here, via CAS against the EXACT reexecution
    // hold this attempt itself established, so a newer hold event (e.g. a
    // second concurrent re-execution that somehow got further) is never
    // silently clobbered. After termsCommitted=true, this block does
    // NOTHING to billing_hold — it stays exactly whatever it already was
    // (the reexecution hold, or whatever the try block's own transition
    // logic already set) — Generation N+1 is live and billing must remain
    // held until reconciliation is genuinely resolved, never un-held
    // merely because something later in the pipeline also failed.
    if (!termsCommitted) {
      const { applied } = await applyReconciliationHoldTransition(
        supabaseServer, jobId, begin.new_billing_hold, begin.previous_billing_hold,
      ).catch(() => ({ applied: false, nextHold: begin.previous_billing_hold }))
      if (!applied) {
        console.error(`[execute] pre-terms-commit hold restore CAS missed for job ${jobId} — a newer billing_hold already exists; leaving it untouched.`)
      }
    }
    throw err
  }
}

// Build tokenMap/reverseMap from approved PII entities in DB.
// Loads org-level approved library + any entity linked to this job (including manual additions).
// Falls back to auto-detecting if no entities exist yet.
//
// Hardening item 1 (second pass) — a canonical organisation and its
// alias(es) are DISTINCT entities with DISTINCT tokens, linked via
// pii_entities.alias_of_entity_id (see migration
// 20260901000001_pii_entity_alias.sql), never a shared token. Each
// entity's OWN token is what goes into tokenMap, and reverseMap is a
// plain, unambiguous token -> original_value mapping per entity, so
// restoration always recovers the EXACT original source string (e.g. a
// clause that actually said "Remembill" restores to "Remembill", never to
// "CoAccept AB").
//
// Hardening item 2 (review pass 3) — approval is GROUP-CONSISTENT in both
// directions: approving the canonical masks its alias(es) (as before), and
// approving an alias directly ALSO masks its canonical, because both rows
// represent the same real-world organisation identity — never leave one
// exposed because the reviewer happened to approve the other one. Uses
// lib/pii-detector.ts's aliasGroupRoot (one-hop grouping) so this is a
// single, symmetric containment check rather than two separate directional
// branches.
//
// NOTE — deployment ordering: alias_of_entity_id does not exist until
// migration 20260901000001_pii_entity_alias.sql is applied (deliberately
// left unapplied this session); this function will fail against the
// current live schema until it is.
async function buildMaskFromDB(jobId: string, orgId: string, contractText: string) {
  // Entities linked to this specific job (approved or manually added)
  const { data: jobEntities } = await supabaseServer
    .from('job_pii_occurrences')
    .select(`pii_entity:pii_entities(id, original_value, token, approved, alias_of_entity_id)`)
    .eq('job_id', jobId)

  // Org-level approved entities not already in this job
  const { data: orgEntities } = await supabaseServer
    .from('pii_entities')
    .select('id, original_value, token, approved, alias_of_entity_id')
    .eq('org_id', orgId)
    .eq('approved', true)

  type EntityRow = { id: string; original_value: string; token: string; approved: boolean; alias_of_entity_id: string | null }
  const approvedIds = new Set<string>()
  for (const row of jobEntities ?? []) {
    // Supabase returns foreign-key joins as an object (not array) when the FK is many-to-one
    const e = (row.pii_entity as unknown) as EntityRow | null
    if (e?.approved) approvedIds.add(e.id)
  }
  for (const e of (orgEntities as EntityRow[] | null) ?? []) approvedIds.add(e.id)

  const tokenMap   = new Map<string, string>()
  const reverseMap = new Map<string, string>()

  if (approvedIds.size > 0) {
    const { aliasGroupRoot } = await import('@/lib/pii-detector')
    // Full org entity set (not filtered by approved) so the whole alias
    // group gets included in the mask even when only one member — canonical
    // OR alias — was independently approved.
    const { data: allOrgEntities } = await supabaseServer
      .from('pii_entities')
      .select('id, original_value, token, alias_of_entity_id')
      .eq('org_id', orgId)

    const entities = (allOrgEntities as Pick<EntityRow, 'id' | 'original_value' | 'token' | 'alias_of_entity_id'>[] | null) ?? []
    const rootById = new Map(entities.map(e => [e.id, aliasGroupRoot(e)]))
    const approvedRoots = new Set<string>()
    for (const id of approvedIds) {
      const root = rootById.get(id) ?? id // approved entity outside this select (shouldn't happen, same org) still counts as its own root
      approvedRoots.add(root)
    }

    for (const e of entities) {
      if (!approvedRoots.has(aliasGroupRoot(e))) continue
      // Each entity keeps its own token/original_value pair — no grouping
      // at the token level, so restoration is always exact.
      tokenMap.set(e.original_value, e.token)
      reverseMap.set(e.token, e.original_value)
    }
  }

  // If no reviewed entities exist, fall back to auto-detection (new job, PII not yet reviewed)
  if (tokenMap.size === 0) {
    const { detectPII } = await import('@/lib/pii-detector')
    const { tokenMap: detected, reverseMap: detectedReverse } = detectPII(contractText)
    return { tokenMap: detected, reverseMap: detectedReverse }
  }

  return { tokenMap, reverseMap }
}

async function extractPDFText(buffer: Buffer, url: string): Promise<string> {
  const pathname = new URL(url).pathname
  return extractDocumentText(
    buffer,
    pathname.endsWith('.pdf'),
    'Extract all text from this contract. Output plain text, preserving section structure and all commercial terms, dates, and amounts.',
  )
}
