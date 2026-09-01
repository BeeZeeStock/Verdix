/**
 * POST /api/jobs/[id]/confirm-rule
 *
 * The approval + propagation step. This is the ONLY endpoint that may turn
 * a reviewer's free-text instruction (or structured choice) into executable
 * billing logic — it always requires `approvedInterpretation`, which only
 * ever reaches the client via /interpret-rule's response or the reviewer's
 * own structured-option selection. No endpoint lets client-supplied text
 * write directly to billing data.
 *
 * Propagation sequence (each step's outcome tracked so a partial failure is
 * visible and retryable rather than silently reported as fully "Applied"):
 *   1. Insert a new commercial_rule_interpretations row (append-only —
 *      supersedes the prior current row via is_current, never overwrites it).
 *   2. Write the approved structured data into contract_terms (what the
 *      Review panel and Commercial Logic & Billing Setup read).
 *   3. Mirror the same write into contract_meter_mappings when a confirmed
 *      mapping already exists for the metric (closes the exact dual-write
 *      gap the Fenix bug exposed — usage-pull.ts's real billing computation
 *      reads contract_meter_mappings, not contract_terms).
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { auth } from '@/lib/auth'
import type { RuleType, UnresolvedReason } from '@/lib/rule-interpretation'
import type { MinimumCommitment, EscalatorInterpretation, DiscountInterpretation, TierCalculationMethod, ServiceCreditInterpretation, PeriodProrationRule, AdditionalRecurringFee, FieldProvenance, OneTimeFee, VariableInvoiceTimingRule, FixedFeeBillingTimingRule } from '@/lib/types'
import { buildCreditApplicationRule } from '@/lib/credit-application-rule'
import { buildServiceCreditInterpretation } from '@/lib/service-credit-interpretation'
import { buildOneTimeFeeConfirmation, OneTimeFeeCapabilityBlockedError, OneTimeFeeValueMutationRejectedError } from '@/lib/one-time-fee'
import { listMatchableOrganizationRules } from '@/lib/rulebook/organization-rules-service'
import { resolveProductionOrganizationField, isOrganizationPolicyStale, organizationPolicyAvailableForUnresolvedReason, resolveAuthoritativeUnresolvedReason, type ProductionOrganizationResolution, type SeenOrganizationPolicy } from '@/lib/rulebook/organization-rulebook-production'
import { resolveOrganizationPolicyRevert } from '@/lib/organization-policy-revert'
import { resolveConfirmedDiscountComponents } from '@/lib/discount-component-targeting'
import { buildFreshLineItemsFromPersistedTerms } from '@/lib/reconciliation-terms-loader'
import { reconcileCurrentLineItemsForJob, type ReconciliationOrchestrationResult } from '@/lib/current-line-item-reconciliation-orchestration'
import { computePostMutationHoldTransition, computeReviewerPatchHoldTransition, applyReconciliationHoldTransition, type ReviewerPatchHoldStartingKind } from '@/lib/reconciliation-hold-transition'
import { beginConfigurationMutationClaim, describeConfigurationMutationClaimRejection } from '@/lib/configuration-mutation-claim'
import { AUTO_CONFIGURE_ONLY_MESSAGE } from '@/lib/auto-configure-guard'
import { recurringFeeDecisionKey } from '@/lib/contract-terms-merge'

// Several sequential writes (audit row, contract_terms, sometimes
// contract_meter_mappings) — same defensive reasoning as propose-rule/
// interpret-rule's identical export, so a slow write chain can't silently
// fall back to a too-short platform default either.
export const maxDuration = 60

type Body = {
  ruleType: RuleType
  contractUnitType?: string
  sourceClause?: string | null
  reviewerInput: string
  aiProposedInterpretation: Record<string, unknown> | null
  approvedInterpretation: Record<string, unknown>
  // Which discount this confirmation targets, when ruleType is 'discount'.
  discountId?: string
  // Same addressing pattern as discountId, for ruleType 'service_credit'.
  creditId?: string
  // Composite key from lib/rule-interactions.ts, for ruleType 'rule_interaction'.
  interactionKey?: string
  // service_credit only — provenance for application_rule's two graded
  // sub-questions (eligibility, survival), sourced from the client's own
  // aiProposal.application_state/survival_state (accepting the AI's
  // proposal as given) or explicitly set to 'reviewer_policy' when the
  // reviewer used free-text Override or clicked "Confirm recommendation"
  // on a specific verdix_recommends sub-field. See buildCreditApplicationRule.
  // Deliberately NEVER legitimately carries survival: null on the wire —
  // null is a distinct, trusted signal buildCreditApplicationRule uses to
  // mean "revert this sub-field to genuinely unresolved," and the only
  // place that signal may originate is this route's own server-side
  // revertSurvivalToOrganizationPolicy branch below, never a client-
  // supplied value. A crafted request setting survival: null directly is
  // sanitized back to undefined before use (see sanitizeClientApplicationRuleProvenance).
  applicationRuleProvenance?: { eligibility?: FieldProvenance; survival?: FieldProvenance }
  // Final safety-check amendment — the ONLY legitimate way survival may
  // move from reviewer_policy back to organization_rulebook. A dedicated,
  // narrow, explicit action rather than overloading approvedInterpretation/
  // applicationRuleProvenance with a "carry_forward: unclear + survival:
  // null" combination a crafted request could otherwise trigger regardless
  // of the field's CURRENT authority. Triggers the eligibility + TOCTOU
  // checks right after termsRow is loaded, below — every value persisted
  // afterward (value/rule id/version/provenance) is computed server-side,
  // never accepted from the request body.
  revertSurvivalToOrganizationPolicy?: boolean
  // service_credit only (Step 1.5) — same discipline as applicationRuleProvenance,
  // sourced from aiProposal.cash_redeemable_state or explicitly
  // 'reviewer_policy' on Override/"Confirm recommendation". See
  // buildServiceCreditInterpretation below.
  cashRedeemableProvenance?: FieldProvenance
  // service_credit only (2026-08-24 audit) — provenance for earn_rule's
  // paid_basis_finalization_policy sub-question. Only ever legitimately
  // 'reviewer_policy' — there is no AI proposal pipeline for this
  // question (see lib/credit-earn-rule.ts's own header), so unlike
  // applicationRuleProvenance/cashRedeemableProvenance this never accepts
  // an AI-proposal-derived state. sanitizeAssertedProvenance still strips
  // 'organization_rulebook' server-side regardless (no resolution path
  // exists for this field either).
  earnRuleProvenance?: { paidBasisFinalization?: FieldProvenance }
  // service_credit only (Step 5C, pre-commit review) — evidence of the
  // organization policy (rule id/version/value) the client's review panel
  // showed the reviewer, sourced from RuleProposal.survival_organization_
  // policy (propose-rule/route.ts). PURELY comparison evidence — NEVER
  // trusted as a selection. This route always independently re-derives
  // org, loads matchable rules, matches, and resolves precedence itself
  // (see the service_credit branch below); this field is only used to
  // detect whether that fresh, authoritative result still matches what
  // the reviewer was actually shown, closing the TOCTOU window between
  // propose-rule's advisory check and this route's real resolution.
  survivalOrganizationPolicySeen?: { rule_id: string; version: number; value: boolean }
}

function buildTierCalculation(approved: Record<string, unknown>): TierCalculationMethod {
  return {
    method: (approved.method as TierCalculationMethod['method']) ?? 'graduated',
    source_clause: (approved.source_clause as string | undefined) ?? null,
    requires_confirmation: false,
    confirmation_reason: null,
  }
}

function buildPeriodProrationRule(approved: Record<string, unknown>, existing: PeriodProrationRule | null | undefined): PeriodProrationRule {
  return {
    reset_anchor: (approved.reset_anchor as PeriodProrationRule['reset_anchor']) ?? existing?.reset_anchor ?? 'calendar',
    prorate_partial_periods: (approved.prorate_partial_periods as PeriodProrationRule['prorate_partial_periods']) ?? existing?.prorate_partial_periods ?? 'unclear',
    source_clause: (approved.source_clause as string | undefined) ?? existing?.source_clause ?? null,
    requires_confirmation: false,
    confirmation_reason: null,
  }
}

// Step 17F.3, item 6 (renamed from buildVariableSettlementTimingRule —
// Step 17F.1, item 6) — same shape as buildPeriodProrationRule above: a
// reviewer's explicit choice, never a default sneaking through
// unconfirmed. A reviewer may only ever set requires_confirmation to
// false by actually confirming here (approvedInterpretation.timing must
// be an actual choice, not merely "whatever was already there") — the
// compiler's own default never sets requires_confirmation false itself.
function buildVariableInvoiceTimingRule(approved: Record<string, unknown>, existing: VariableInvoiceTimingRule | null | undefined): VariableInvoiceTimingRule {
  return {
    timing: (approved.timing as VariableInvoiceTimingRule['timing']) ?? existing?.timing ?? 'unclear',
    source_clause: (approved.source_clause as string | undefined) ?? existing?.source_clause ?? null,
    requires_confirmation: false,
    confirmation_reason: null,
  }
}

// Step 17F.3, item 2 — same shape as buildPeriodProrationRule; a
// reviewer's explicit choice for WHEN the fixed recurring fee's invoice is
// issued relative to its own billing period.
function buildFixedFeeBillingTimingRule(approved: Record<string, unknown>, existing: FixedFeeBillingTimingRule | null | undefined): FixedFeeBillingTimingRule {
  return {
    timing: (approved.timing as FixedFeeBillingTimingRule['timing']) ?? existing?.timing ?? 'unclear',
    source_clause: (approved.source_clause as string | undefined) ?? existing?.source_clause ?? null,
    requires_confirmation: false,
    confirmation_reason: null,
  }
}

type PropagationStatus = Record<string, 'applied' | 'failed' | 'skipped'>

// Step 17H.4B0D4H1B4D1.3 §1-§20 — per-ruleType classification, evidence-based
// (buildLineItems and every real downstream billing consumer traced
// directly, never inferred from a rule's name):
//
//   'line_item_relevant' — buildLineItems (lib/line-items.ts) reads the
//     mutated field(s) directly, so fresh line items can genuinely differ.
//     Only a REAL reconcileCurrentLineItemsForJob pass with a clean result
//     is evidence a pre-existing reconciliation_blocked hold is resolved.
//       base_fee_proration — buildLineItems reads base_fee_proration.
//         requires_confirmation directly (the recurring-base-fee placeholder
//         gate).
//       one_time_fee — buildLineItems reads one_time_fees[].amount/
//         manual_trigger directly (unit_price/total_amount/quantity/isParked).
//       escalator — buildLineItems generates one line item per
//         terms.escalators[] entry; confirming an escalator with a
//         previously-empty array creates a new entry (a new row appears).
//         The common case (an entry already exists from extraction) is a
//         structural no-op for buildLineItems, but real reconciliation is
//         cheap and correct either way — never assumed clean.
//
//   'schedule_relevant' — NOT read by buildLineItems (confirmed: none of
//     these fields appear anywhere in lib/line-items.ts), so fresh
//     current_line_items structure cannot differ — but each has a REAL,
//     traced downstream billing-execution consumer, so a confirmation is a
//     genuine material commercial change that can make an EXISTING future
//     schedule stale, independent of Model B+:
//       minimum_commitment, partial_period — lib/usage-pull.ts, lib/tariff.ts
//         (floor/minimum-spend calculation; partial_period resolves the
//         SAME minimum_commitment object's own prorate_partial_periods/
//         applies_at_zero_usage sub-fields, not a separate concept).
//       recurring_fee_proration — lib/billing-writer.ts's
//         applyProrationRule(...) (Stage A's real planned_invoices.
//         base_amount computation).
//       variable_invoice_timing — lib/performance-share-pull.ts.
//       fixed_fee_billing_timing — lib/fixed-fee-invoice-scheduling.ts
//         (the same real consumer reconcile-fixed-fee-timing's own
//         dedicated route defends).
//       discount — lib/tariff.ts's computeDiscountMultiplier, applied in
//         computeFixedFeePeriodAmount (real Stage A calculation).
//       tier_calculation — lib/usage-pull.ts, lib/tariff.ts,
//         lib/billing-engine.ts (real overage calculation method).
//       service_credit — lib/credit-ledger-service.ts, wired into the real,
//         live app/api/admin/invoice-scheduler/route.ts — genuinely
//         execution-consequential, not merely stored for a not-yet-built
//         system.
//
//   'advisory' — no proven current billing consumer at all:
//       rule_interaction — writes only service_credits[].interpretation.
//         interaction_note, a free-text string. Confirmed by direct read of
//         lib/credit-ledger-service.ts: it reads interp.earn_rule/
//         application_rule, never interaction_note. Purely a human-readable
//         annotation today — never promotes a hold on its own.
type ConfirmRuleReconciliationRelevance = 'line_item_relevant' | 'schedule_relevant' | 'advisory'
const RULE_TYPE_RECONCILIATION_RELEVANCE: Record<RuleType, ConfirmRuleReconciliationRelevance> = {
  base_fee_proration: 'line_item_relevant',
  one_time_fee: 'line_item_relevant',
  escalator: 'line_item_relevant',
  minimum_commitment: 'schedule_relevant',
  partial_period: 'schedule_relevant',
  recurring_fee_proration: 'schedule_relevant',
  variable_invoice_timing: 'schedule_relevant',
  fixed_fee_billing_timing: 'schedule_relevant',
  discount: 'schedule_relevant',
  tier_calculation: 'schedule_relevant',
  service_credit: 'schedule_relevant',
  rule_interaction: 'advisory',
}

function buildMinimumCommitment(approved: Record<string, unknown>, existing: MinimumCommitment | null | undefined): MinimumCommitment {
  return {
    mode: (approved.mode as MinimumCommitment['mode']) ?? existing?.mode ?? 'floor',
    amount: typeof approved.amount === 'number' ? approved.amount : existing?.amount ?? 0,
    currency: existing?.currency ?? null,
    period: (approved.period as MinimumCommitment['period']) ?? existing?.period ?? null,
    included_allowance_interaction: (approved.included_allowance_interaction as MinimumCommitment['included_allowance_interaction']) ?? existing?.included_allowance_interaction,
    rollover: existing?.rollover,
    prorate_partial_periods: (approved.prorate_partial_periods as MinimumCommitment['prorate_partial_periods']) ?? existing?.prorate_partial_periods ?? 'unclear',
    // Never silently defaults to true/false — an unresolved zero-usage
    // question must stay 'unclear' through confirmation, same discipline as
    // prorate_partial_periods, so Confirm & apply can never quietly decide
    // it on the reviewer's behalf.
    applies_at_zero_usage: (approved.applies_at_zero_usage as MinimumCommitment['applies_at_zero_usage']) ?? existing?.applies_at_zero_usage ?? 'unclear',
    source_clause: (approved.source_clause as string | undefined) ?? existing?.source_clause ?? null,
    requires_confirmation: false,
    confirmation_reason: null,
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id: jobId } = await params

  // Verify the job actually belongs to the caller's org before touching
  // anything — every write below is scoped by job_id alone, which would
  // otherwise let an admin of one org mutate another org's commercial terms
  // and billing configuration just by knowing/guessing a job id.
  const { data: ownedJob } = await supabaseServer
    .from('jobs')
    .select('id, module, contract_terms_id')
    .eq('id', jobId)
    .eq('org_id', org.orgId)
    .maybeSingle()
  if (!ownedJob) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  // Step 17H.4B0D4H1B4C — confirm-rule is a Model B+ commercial-write
  // surface (AUTO_CONFIGURE-only by design, per H1B4B's audit); reject
  // before the mutation claim and before the audit-row insert.
  if (ownedJob.module !== 'AUTO_CONFIGURE') {
    return NextResponse.json({ error: AUTO_CONFIGURE_ONLY_MESSAGE }, { status: 400 })
  }

  // Step 17H.4B0D4H1B3.1 §6 — ownership claimed BEFORE the first write
  // that changes commercial truth (the commercial_rule_interpretations
  // audit insert, Step 1 below — confirmed by direct audit that nothing
  // between here and that insert performs any write). Everything below
  // this point that returns before contract_terms is confirmed 'applied'
  // must restore this claim (see the three explicit restore sites and the
  // final transition at the end of this function); nothing after it may.
  const claim = await beginConfigurationMutationClaim(supabaseServer, jobId)
  if (!claim.claimed) {
    return NextResponse.json({ error: describeConfigurationMutationClaimRejection(claim) }, { status: 409 })
  }
  const restoreClaim = () => applyReconciliationHoldTransition(supabaseServer, jobId, claim.newBillingHold, claim.previousBillingHold)

  const body = await req.json() as Body
  const { ruleType, contractUnitType, sourceClause, reviewerInput, aiProposedInterpretation, approvedInterpretation, discountId, creditId, interactionKey, applicationRuleProvenance: rawApplicationRuleProvenance, cashRedeemableProvenance, earnRuleProvenance, survivalOrganizationPolicySeen, revertSurvivalToOrganizationPolicy } = body
  // Defense in depth beyond the Body type itself (which a crafted raw JSON
  // payload can bypass) — survival: null is never a legitimate CLIENT
  // input; coerce it to undefined ("not asserted, preserve existing") so
  // the generic merge path can never be tricked into clearing a field's
  // provenance this way. The one place null is genuinely used is
  // constructed entirely in server code, below, after the dedicated
  // revert branch's own eligibility check has already passed.
  const applicationRuleProvenance = rawApplicationRuleProvenance
    ? { eligibility: rawApplicationRuleProvenance.eligibility, survival: rawApplicationRuleProvenance.survival === null ? undefined : rawApplicationRuleProvenance.survival }
    : undefined

  if (!ruleType || !approvedInterpretation) {
    return NextResponse.json({ error: 'ruleType and approvedInterpretation are required' }, { status: 400 })
  }
  if (ruleType === 'discount' && !discountId) {
    return NextResponse.json({ error: 'discountId is required for discount interpretation' }, { status: 400 })
  }
  if (ruleType === 'service_credit' && !creditId) {
    return NextResponse.json({ error: 'creditId is required for service_credit interpretation' }, { status: 400 })
  }
  if (ruleType === 'rule_interaction' && !interactionKey) {
    return NextResponse.json({ error: 'interactionKey is required for rule_interaction interpretation' }, { status: 400 })
  }
  if (ruleType === 'one_time_fee' && !contractUnitType) {
    // contractUnitType is repurposed to carry fee_label — same addressing
    // reuse recurring_fee_proration already does, no new column/migration.
    return NextResponse.json({ error: 'contractUnitType (the fee_label) is required for one_time_fee confirmation' }, { status: 400 })
  }

  // Moved up from its original position (just before the "Step 1: audit
  // row" section) so auditUnitKey, immediately below, can consult it for
  // variable_invoice_timing's id-first addressing — a pure read with no
  // ordering dependency on anything between here and its old position
  // (session/propagation/affectedComponents/priorCurrent are all
  // independent of it). Addressed via jobs.contract_terms_id (a single-row
  // primary-key lookup) rather than querying contract_terms by job_id —
  // the latter used .maybeSingle(), which silently returns no row (and no
  // error surfaced to the caller) the moment more than one contract_terms
  // row exists for a job, which re-extraction used to cause.
  const { data: termsRow } = ownedJob.contract_terms_id
    ? await supabaseServer
        .from('contract_terms')
        .select('id, overage_tiers, escalators, discounts, service_credits, ai_proposal_cache, base_fee_proration, additional_recurring_fees, one_time_fees')
        .eq('id', ownedJob.contract_terms_id)
        .maybeSingle()
    : { data: null }

  // Step 17H.4B0D4H1B4E3.4.1, generalized 17H.4B0D4H1B4E3.4.2 — both
  // per-recurring-fee decision types (variable_invoice_timing,
  // recurring_fee_proration) get recurring_fee_id-first audit addressing
  // once the target fee has one, exactly mirroring the existing
  // discount:{id}/credit:{id}/interaction:{key} synthetic-key convention
  // below. The client still only ever sends the fee_label (contractUnitType)
  // — no GUI change — this is a purely server-side addressing refinement:
  // look up the SAME fee each branch's own mutation logic will target by
  // fee_label, and if it carries a recurring_fee_id, address the audit row
  // by that instead. A legacy fee with no recurring_fee_id yet keeps the
  // exact prior behavior (fee_label-keyed) — the "legacy bridge"
  // 17H.4B0D4H1B4E3.4.1/§5 requires. This is what lets lib/contract-terms-
  // merge.ts's mergeVariableInvoiceTimingForFees/mergeRecurringFeeProration
  // ForFees find a confirmed decision by stable identity instead of by
  // wording that can drift on re-extraction. One shared lookup — both rule
  // types address the SAME fee shape the SAME way, so a single computation
  // covers both rather than duplicating it per ruleType.
  const perRecurringFeeDecisionRuleTypes: RuleType[] = ['variable_invoice_timing', 'recurring_fee_proration']
  const recurringFeeTargetId = perRecurringFeeDecisionRuleTypes.includes(ruleType) && contractUnitType
    ? ((termsRow?.additional_recurring_fees ?? []) as Array<{ fee_label: string; recurring_fee_id?: string }>)
        .find(f => f.fee_label === contractUnitType)?.recurring_fee_id ?? null
    : null

  // The audit table's contract_unit_type column doubles as the addressing
  // key for job-level rules (null for a singular escalator). Discounts,
  // service credits, and rule interactions aren't singular, so their audit
  // history is addressed via a synthetic 'discount:{id}'/'credit:{id}'/
  // 'interaction:{key}' key in that same column — reuses the existing schema
  // rather than requiring another migration. variable_invoice_timing/
  // recurring_fee_proration join this pattern (17H.4B0D4H1B4E3.4.1/.4.2)
  // with recurringFeeDecisionKey(...) ONLY when the target fee's identity is
  // known; otherwise it stays fee_label-keyed, unchanged from before those
  // passes.
  const auditUnitKey = ruleType === 'discount' ? `discount:${discountId}`
    : ruleType === 'service_credit' ? `credit:${creditId}`
    : ruleType === 'rule_interaction' ? `interaction:${interactionKey}`
    : perRecurringFeeDecisionRuleTypes.includes(ruleType) && recurringFeeTargetId ? recurringFeeDecisionKey(recurringFeeTargetId)
    : (contractUnitType ?? null)

  const session = await auth()
  const reviewerEmail = session?.user?.email ?? org.userEmail ?? 'unknown'
  const reviewerName = session?.user?.name ?? null

  const propagation: PropagationStatus = {}
  // Step 5C, pre-commit review (item 3) — set true only when the
  // service_credit branch below finds that the organization policy it
  // just independently re-resolved no longer matches the policy
  // survivalOrganizationPolicySeen says the reviewer was shown. Surfaced
  // on the final response so the client can prompt a refresh rather than
  // silently proceeding as if nothing changed — this never affects
  // whether the write below is safe (it already fails closed on its own;
  // see isOrganizationPolicyStale's own comment), only whether the
  // reviewer is told their view was stale.
  let staleOrganizationPolicy = false
  // A rule interaction never touches Commercial BoM/Schedule directly
  // — it only resolves which basis the referencing service credit's own
  // (separately-confirmed) interpretation should use.
  //
  // Step 17H.3D3 — these are audit-metadata SURFACE NAMES (persisted into
  // commercial_rule_interpretations.affected_components below), not the
  // unrelated Discount.affected_components typed-targeting field this
  // same identifier also names elsewhere in this codebase (a pre-existing
  // naming collision, not introduced here — see lib/types.ts's Discount
  // for that different, structurally-typed field). 'Commercial Terms' and
  // 'Billing Configuration' were the names of two now-retired legacy UI
  // surfaces (the latter absorbed into Commercial BoM in Step 17G.4B, the
  // former retired in 17H.3D3 itself) — updated to name the current
  // authoritative surfaces so future audit rows don't record a
  // destination that no longer exists.
  const affectedComponents = ruleType === 'rule_interaction'
    ? ['Commercial Logic', 'Billing Engine']
    : ['Commercial Logic', 'Commercial BoM', 'Billing Engine', 'Billing Schedule']

  // ── Step 1: audit row (append-only) ─────────────────────────────────────
  // contract_unit_type is null for job-level rules (escalators) — PostgREST's
  // .eq() never matches NULL, so lookups/updates below use .is() for that
  // case or a job-level rule's revision history would never be found.
  const priorCurrentQuery = supabaseServer
    .from('commercial_rule_interpretations')
    .select('id, revision_number')
    .eq('job_id', jobId)
    .eq('rule_type', ruleType)
    .eq('is_current', true)
  const { data: priorCurrent } = await (auditUnitKey
    ? priorCurrentQuery.eq('contract_unit_type', auditUnitKey)
    : priorCurrentQuery.is('contract_unit_type', null)
  ).maybeSingle()

  const nextRevision = (priorCurrent?.revision_number ?? 0) + 1

  // termsRow itself was fetched earlier (before auditUnitKey, so its
  // variable_invoice_timing addressing could consult it) — this remains a
  // true "before" snapshot for original_extraction/Step 2 below, since
  // nothing between its load and here writes to contract_terms.

  // ── Revert-to-organization-policy: eligibility + TOCTOU checks ──────────
  // Runs BEFORE the audit-row insert below, so a rejected revert attempt
  // never creates a phantom "is_current" audit revision for a write that
  // didn't actually happen to the real interpretation.
  //
  // Server-authoritative by construction: creditId is the only client
  // input consulted here (to find the row); the field's CURRENT authority
  // (existingAppRule?.survival_provenance) and the active organization
  // policy (freshResolution) are both read/computed from trusted server-
  // side state, never from the request body. If this succeeds,
  // organizationRevertResolution is the ONLY source the service_credit
  // branch below uses to build the reverted application_rule — the
  // client's approvedInterpretation/applicationRuleProvenance are never
  // consulted for this specific action.
  let organizationRevertResolution: ProductionOrganizationResolution | undefined
  if (revertSurvivalToOrganizationPolicy) {
    if (ruleType !== 'service_credit' || !creditId) {
      return NextResponse.json({ error: 'invalid_request', message: 'revertSurvivalToOrganizationPolicy requires ruleType "service_credit" and a creditId.' }, { status: 400 })
    }
    const revertCredits = (termsRow?.service_credits ?? []) as Array<{ credit_rule_id?: string; credit_type?: string; interpretation?: ServiceCreditInterpretation | null }>
    const revertCurrentCredit = revertCredits.find(c => c.credit_rule_id === creditId)
    const revertExistingAppRule = revertCurrentCredit?.interpretation?.application_rule

    const revertOrganizationRules = await listMatchableOrganizationRules(org.orgId)
    const revertResult = resolveOrganizationPolicyRevert({
      organizationId: org.orgId,
      ruleType: revertCurrentCredit?.credit_type ?? 'other',
      existingSurvivalProvenance: revertExistingAppRule?.survival_provenance,
      organizationRules: revertOrganizationRules,
      asOf: new Date(),
    })
    if (!revertResult.eligible) {
      // Fails closed in both cases — no write of any kind happens on this
      // path; the existing reviewer_policy override (or contract_derived
      // value) is left completely untouched.
      return NextResponse.json({
        error: revertResult.reason,
        message: revertResult.reason === 'not_eligible_for_revert'
          ? 'Only a contract-specific reviewer override can be reverted to the organization policy.'
          : 'No active organization policy currently applies to this agreement — your existing choice for this agreement is unchanged.',
      }, { status: revertResult.reason === 'not_eligible_for_revert' ? 400 : 409 })
    }
    organizationRevertResolution = revertResult.resolution
  }

  // Server-side lookup of what the AI actually showed the reviewer at
  // proposal time — never trusted from a client-supplied value, so the audit
  // row can't diverge from the real proposal cache. Same cacheKey
  // convention propose-rule/route.ts uses when writing to this cache
  // (deliberately NOT auditUnitKey, which is a different addressing scheme
  // for a different column).
  const proposalCacheKey = ruleType === 'discount' ? `discount:${discountId}`
    : ruleType === 'service_credit' ? `service_credit:${creditId}`
    : ruleType === 'rule_interaction' ? `rule_interaction:${interactionKey}`
    : ruleType === 'escalator' ? 'escalator'
    : `${ruleType}:${contractUnitType}`
  const proposalCache = (termsRow?.ai_proposal_cache as Record<string, { proposal?: {
    state?: string; proposed_interpretation?: unknown; reasoning?: string; calculation_preview?: unknown
    // Step 16A — read here (the server's own cached proposal, never a
    // client-submitted value) so the organization-policy resolution below
    // can tell explicit contractual non-agreement apart from ordinary
    // silence using the SAME authoritative source propose-rule computed
    // it from, rather than trusting anything the client claims.
    survival_unresolved_reason?: UnresolvedReason
  } } > | null) ?? {}
  const cachedProposal = proposalCache[proposalCacheKey]?.proposal ?? null

  // partial_period is always a reviewer's own policy decision by definition
  // — the whole point of surfacing it is that the contract doesn't specify a
  // treatment, so there is no "the contract said so" reading available.
  // Everything else derives from what the AI actually proposed: an
  // interpretation the AI itself marked as explicitly grounded in the
  // contract text stays contract_derived once confirmed; anything the AI
  // only recommended or couldn't determine at all required the reviewer's
  // own judgment to resolve, so it's reviewer_policy even though a human
  // clicked confirm on both.
  // one_time_fee joins partial_period/base_fee_proration/recurring_fee_
  // proration here — there is no propose-rule/AI-proposal pipeline for it
  // (lib/rulebook/MILESTONE_BILLING_FINDINGS.md), so every confirmation is,
  // by definition, the reviewer's own decision, never "the contract said
  // so" via an AI proposal this route can independently verify. This is
  // the audit row's own decision_provenance column only — the ACTUAL
  // per-field amount_provenance/billability_provenance written into
  // one_time_fees below are computed independently by
  // buildOneTimeFeeConfirmation from what the client explicitly asserts,
  // not derived from this value.
  const decisionProvenance: 'reviewer_policy' | 'contract_derived' =
    ruleType === 'partial_period' || ruleType === 'base_fee_proration' || ruleType === 'recurring_fee_proration' || ruleType === 'one_time_fee' || ruleType === 'variable_invoice_timing' || ruleType === 'fixed_fee_billing_timing' ? 'reviewer_policy'
      : cachedProposal?.state === 'clear_from_source' ? 'contract_derived'
      : 'reviewer_policy'

  const originalExtraction: unknown = !termsRow ? null
    : ruleType === 'minimum_commitment' || ruleType === 'partial_period'
      ? (termsRow.overage_tiers as Array<{ unit_type?: string }> ?? []).find(t => t.unit_type === contractUnitType) ?? null
    : ruleType === 'tier_calculation'
      ? (termsRow.overage_tiers as Array<{ unit_type?: string }> ?? []).find(t => t.unit_type === contractUnitType) ?? null
    : ruleType === 'discount'
      ? (termsRow.discounts as Array<{ discount_rule_id?: string }> ?? []).find(d => d.discount_rule_id === discountId) ?? null
    : ruleType === 'one_time_fee'
      ? (termsRow as unknown as { one_time_fees?: OneTimeFee[] }).one_time_fees?.find(f => f.fee_label === contractUnitType) ?? null
    : ruleType === 'service_credit'
      ? (termsRow.service_credits as Array<{ credit_rule_id?: string }> ?? []).find(c => c.credit_rule_id === creditId) ?? null
    : ruleType === 'rule_interaction'
      ? (termsRow.service_credits as Array<{ credit_rule_id?: string; interpretation?: unknown }> ?? [])
          .find(c => c.credit_rule_id === (interactionKey ?? '').split('|').find(p => p.startsWith('service_credit:'))?.split(':')[1])?.interpretation ?? null
    : (termsRow.escalators as unknown[] ?? [])[0] ?? null

  let { error: auditError } = await supabaseServer.from('commercial_rule_interpretations').insert({
    job_id: jobId,
    rule_type: ruleType,
    contract_unit_type: auditUnitKey,
    revision_number: nextRevision,
    is_current: true,
    source_clause: sourceClause ?? null,
    source_text: sourceClause ?? null,
    original_extraction: originalExtraction,
    reviewer_input: reviewerInput ?? null,
    ai_proposed_interpretation: aiProposedInterpretation,
    approved_interpretation: approvedInterpretation,
    reviewer_email: reviewerEmail,
    reviewer_name: reviewerName,
    affected_components: affectedComponents,
    propagation_status: {},
    decision_provenance: decisionProvenance,
    ai_proposal_state: cachedProposal,
  })

  // decision_provenance/ai_proposal_state require a migration
  // (20260821000003_commercial_rule_provenance.sql) that may not have run
  // yet in every environment — same degrade-gracefully pattern already used
  // for minimum_commitment_* (meter-mappings) and ai_proposal_cache
  // (propose-rule): confirming a rule must not hard-fail just because this
  // additional provenance metadata can't be stored yet.
  if (auditError?.message?.includes('decision_provenance') || auditError?.message?.includes('ai_proposal_state')) {
    console.warn('[confirm-rule] decision_provenance/ai_proposal_state columns missing — run the pending migration. Falling back without them.')
    ;({ error: auditError } = await supabaseServer.from('commercial_rule_interpretations').insert({
      job_id: jobId, rule_type: ruleType, contract_unit_type: auditUnitKey, revision_number: nextRevision,
      is_current: true, source_clause: sourceClause ?? null, source_text: sourceClause ?? null,
      original_extraction: originalExtraction, reviewer_input: reviewerInput ?? null,
      ai_proposed_interpretation: aiProposedInterpretation, approved_interpretation: approvedInterpretation,
      reviewer_email: reviewerEmail, reviewer_name: reviewerName, affected_components: affectedComponents,
      propagation_status: {},
    }))
  }

  if (auditError) {
    // The audit table itself missing (pending migration) is a hard stop —
    // unlike the meter-mappings confirmation columns, this isn't optional
    // metadata; losing the audit trail defeats the whole point of this flow.
    console.error(`[confirm-rule] audit insert failed for job ${jobId}:`, auditError.message)
    await restoreClaim() // contract_terms never reached — restore the claim (17H.4B0D4H1B3.1 §8)
    return NextResponse.json({
      error: auditError.message.includes('commercial_rule_interpretations')
        ? 'The audit-trail table has not been provisioned yet — run the pending migration (20260816000001_commercial_rule_interpretations.sql) before approving rules.'
        : auditError.message,
    }, { status: 500 })
  }

  if (priorCurrent) {
    await supabaseServer
      .from('commercial_rule_interpretations')
      .update({ is_current: false })
      .eq('id', priorCurrent.id)
  }
  propagation['audit_trail'] = 'applied'

  // Step 17H.4B0D4H1B3.1 — an UNEXPECTED thrown error anywhere in Step 2/3
  // below (not one of the two named, already-handled one_time_fee errors)
  // must never leave the claimed hold dangling. Restores it if
  // contract_terms never actually became 'applied' by the time of the
  // throw (matching the explicit restore sites above); otherwise leaves
  // it exactly as-is (already the temporary reexecution hold — the SAME
  // "post-commit: never restore, leave held" doctrine execute's own
  // pipeline uses) and re-throws so this route's existing behavior for a
  // genuinely unexpected failure (a 500 via Next.js's own error handling)
  // is unchanged.
  let reconciliationOutcome: ReconciliationOrchestrationResult | null = null
  try {
  // ── Step 2: contract_terms ───────────────────────────────────────────────

  if (!termsRow) {
    propagation['contract_terms'] = 'failed'
  } else if (ruleType === 'minimum_commitment' || ruleType === 'partial_period') {
    if (!contractUnitType) {
      propagation['contract_terms'] = 'failed'
    } else {
      type Tier = { unit_type: string; minimum_commitment?: MinimumCommitment | null; [k: string]: unknown }
      const tiers = (termsRow.overage_tiers ?? []) as Tier[]
      const newTiers = tiers.map(t =>
        t.unit_type === contractUnitType
          ? { ...t, minimum_commitment: buildMinimumCommitment(approvedInterpretation, t.minimum_commitment) }
          : t
      )
      const { error } = await supabaseServer.from('contract_terms').update({ overage_tiers: newTiers }).eq('id', termsRow.id)
      propagation['contract_terms'] = error ? 'failed' : 'applied'
    }
  } else if (ruleType === 'base_fee_proration') {
    // Job-level, like escalator — no contractUnitType/fee_label to address by.
    const existing = (termsRow as { base_fee_proration?: PeriodProrationRule | null }).base_fee_proration
    const { error } = await supabaseServer.from('contract_terms')
      .update({ base_fee_proration: buildPeriodProrationRule(approvedInterpretation, existing) })
      .eq('id', termsRow.id)
    propagation['contract_terms'] = error ? 'failed' : 'applied'
    // Step 17E, item 4 (generalized in 17E.1, items C/D) — lib/line-items.ts's
    // recurring-base-fee block emits a STORED placeholder row while
    // base_fee_proration.requires_confirmation is true; once the reviewer
    // confirms it above, that placeholder is stale. Reconciliation for this
    // (and every other LINE_ITEM_RELEVANT ruleType) now runs in ONE shared
    // step after this if/else-if chain (Step 17H.4B0D4H1B4D1.3 §7/§21),
    // gated on RULE_TYPE_RECONCILIATION_RELEVANCE — see that block's own
    // comment for why this moved out of being embedded in one branch.
  } else if (ruleType === 'recurring_fee_proration') {
    // contractUnitType is repurposed to carry the fee_label here — same
    // "reuse the existing addressing column rather than a new migration"
    // approach discount_rule_id/credit_rule_id already use.
    if (!contractUnitType) {
      propagation['contract_terms'] = 'failed'
    } else {
      const fees = ((termsRow as { additional_recurring_fees?: AdditionalRecurringFee[] | null }).additional_recurring_fees ?? []) as AdditionalRecurringFee[]
      const newFees = fees.map(f =>
        f.fee_label === contractUnitType
          ? { ...f, proration: buildPeriodProrationRule(approvedInterpretation, f.proration) }
          : f
      )
      const { error } = await supabaseServer.from('contract_terms').update({ additional_recurring_fees: newFees }).eq('id', termsRow.id)
      propagation['contract_terms'] = error ? 'failed' : 'applied'
    }
  } else if (ruleType === 'variable_invoice_timing') {
    // Step 17F.3, item 6 (renamed from variable_settlement_timing — Step
    // 17F.1, item 6) — same "contractUnitType repurposed to carry
    // fee_label" addressing as recurring_fee_proration above; a reviewer
    // confirming WHEN an already-determined percentage-of-basis charge is
    // invoiced, never WHETHER it's determined in arrears (structural, no
    // longer a decision) or WHAT it computes to (that stays
    // percentage_of_basis, untouched here).
    if (!contractUnitType) {
      propagation['contract_terms'] = 'failed'
    } else {
      const fees = ((termsRow as { additional_recurring_fees?: AdditionalRecurringFee[] | null }).additional_recurring_fees ?? []) as AdditionalRecurringFee[]
      const newFees = fees.map(f =>
        f.fee_label === contractUnitType
          ? { ...f, variable_invoice_timing: buildVariableInvoiceTimingRule(approvedInterpretation, f.variable_invoice_timing) }
          : f
      )
      const { error } = await supabaseServer.from('contract_terms').update({ additional_recurring_fees: newFees }).eq('id', termsRow.id)
      propagation['contract_terms'] = error ? 'failed' : 'applied'
    }
  } else if (ruleType === 'fixed_fee_billing_timing') {
    // Step 17F.3, item 2 — job-level, like base_fee_proration (base_monthly_fee/
    // base_annual_fee are singular fields, not addressed by fee_label).
    // Reviewer confirming WHEN the fixed recurring fee's invoice is issued
    // relative to its own billing period — never WHAT the amount is or how
    // a partial period is treated (base_fee_proration, untouched here).
    const existingTiming = (termsRow as { fixed_fee_billing_timing?: FixedFeeBillingTimingRule | null }).fixed_fee_billing_timing
    const { error } = await supabaseServer.from('contract_terms')
      .update({ fixed_fee_billing_timing: buildFixedFeeBillingTimingRule(approvedInterpretation, existingTiming) })
      .eq('id', termsRow.id)
    propagation['contract_terms'] = error ? 'failed' : 'applied'
  } else if (ruleType === 'one_time_fee') {
    // Step 11B, final security correction — the minimal review path
    // lib/one-time-fee.ts's buildOneTimeFeeConfirmation exists for.
    // contractUnitType carries fee_label (validated required, above), same
    // addressing reuse as recurring_fee_proration.
    //
    // approvedInterpretation carries ONLY which action(s) the reviewer took
    // — confirmAmount / confirmBillability, plain booleans — never a
    // provenance value. The client has no authority to assert 'contract_
    // derived'/'organization_rulebook'/'verdix_rulebook'/'verdix_recommends'
    // (or anything else); buildOneTimeFeeConfirmation itself only ever
    // mints 'reviewer_policy' for a confirmed dimension (or preserves an
    // existing 'contract_derived', never downgrading it) — see that
    // module's header for why. This route no longer accepts or forwards
    // any client-supplied FieldProvenance for this rule type.
    //
    // Step 12 — confirmBillability now confirms the normalized
    // billability_condition (lib/types.ts) exactly as it did the old
    // due_date/manual_trigger pair, unchanged mechanically: no new field is
    // read from the request body for this. Condition EDITING is not
    // introduced (Step 12 item 18 — confirmation of the persisted,
    // extraction-proposed condition only), so there is nothing new to
    // sanitize here.
    const fees = ((termsRow as { one_time_fees?: OneTimeFee[] | null }).one_time_fees ?? []) as OneTimeFee[]
    const targetIndex = fees.findIndex(f => f.fee_label === contractUnitType)
    if (targetIndex === -1) {
      propagation['contract_terms'] = 'failed'
    } else {
      const amount = typeof approvedInterpretation.amount === 'number' ? approvedInterpretation.amount : undefined
      const confirmAmount = approvedInterpretation.confirmAmount === true
      const confirmBillability = approvedInterpretation.confirmBillability === true
      try {
        const newFees = fees.map((f, i) =>
          i === targetIndex ? buildOneTimeFeeConfirmation(f, { amount, confirmAmount, confirmBillability }) : f
        )
        const { error } = await supabaseServer.from('contract_terms').update({ one_time_fees: newFees }).eq('id', termsRow.id)
        propagation['contract_terms'] = error ? 'failed' : 'applied'
      } catch (err) {
        // unresolved_kind: 'unsupported_semantics' is an expected
        // commercial state — Verdix cannot yet represent this fee's
        // billability condition, not an internal failure — so it's caught
        // here and returned as a structured, fail-closed 409, never an
        // uncaught 500. No raw source text is included.
        if (err instanceof OneTimeFeeCapabilityBlockedError) {
          await restoreClaim() // contract_terms never reached (17H.4B0D4H1B3.1 §8)
          return NextResponse.json({
            error: 'This fee cannot be confirmed with the current billing model.',
            code: 'unsupported_commercial_semantics',
          }, { status: 409 })
        }
        // Final adversarial check — a crafted (or genuinely mistaken)
        // request trying to change a contract_derived amount's VALUE. No
        // reviewer-override-of-a-contract-value workflow exists yet, so
        // this is also an expected, structured, fail-closed rejection —
        // never an uncaught 500 — rather than silently letting the new
        // number inherit the old, trusted contract_derived authority.
        if (err instanceof OneTimeFeeValueMutationRejectedError) {
          await restoreClaim() // contract_terms never reached (17H.4B0D4H1B3.1 §8)
          return NextResponse.json({
            error: 'This amount was derived from the contract and cannot be changed via reviewer confirmation.',
            code: 'contract_derived_value_immutable',
          }, { status: 409 })
        }
        throw err
      }
    }
  } else if (ruleType === 'escalator') {
    type Esc = { interpretation?: EscalatorInterpretation | null; [k: string]: unknown }
    const escalators = (termsRow.escalators ?? []) as Esc[]
    const treatment: EscalatorInterpretation['treatment'] = approvedInterpretation.treatment === 'not_applied' ? 'not_applied' : 'applies'
    const interpretation: EscalatorInterpretation = treatment === 'not_applied'
      ? {
          treatment: 'not_applied',
          index: null, index_name: null, frequency: null, effective_date: null, cap_pct: null, calculation_method: null,
          discretion: 'not_exercised', renewal_triggered: false,
          requires_confirmation: false,
          confirmation_reason: (approvedInterpretation.confirmation_reason as string | null) ?? null,
        }
      : {
          treatment: 'applies',
          index: (approvedInterpretation.index as EscalatorInterpretation['index']) ?? 'other',
          index_name: (approvedInterpretation.index_name as string | null) ?? null,
          frequency: (approvedInterpretation.frequency as EscalatorInterpretation['frequency']) ?? 'annual',
          effective_date: (approvedInterpretation.effective_date as string | null) ?? null,
          cap_pct: (approvedInterpretation.cap_pct as number | null) ?? null,
          calculation_method: (approvedInterpretation.calculation_method as string) ?? '',
          // A discretionary clause must never silently default to
          // 'automatic' here — only persist 'automatic' when the reviewer's
          // structured/free-text interpretation actually said so.
          discretion: (approvedInterpretation.discretion as EscalatorInterpretation['discretion']) ?? 'requires_renewal_approval',
          renewal_triggered: (approvedInterpretation.renewal_triggered as boolean) ?? false,
          requires_confirmation: false,
          confirmation_reason: null,
        }
    const newEscalators = escalators.length > 0
      ? escalators.map((e, i) => (i === 0 ? { ...e, interpretation } : e))
      : [{ escalator_pct: null, escalator_type: 'CPI_cap', effective_date: interpretation.effective_date, applies_from_year: null, cap_pct: interpretation.cap_pct, description: '', interpretation }]
    const { error } = await supabaseServer.from('contract_terms').update({ escalators: newEscalators }).eq('id', termsRow.id)
    propagation['contract_terms'] = error ? 'failed' : 'applied'
  } else if (ruleType === 'discount') {
    // Addressed by discount_rule_id, not array position, so a contract with
    // several independent discounts only has the targeted one touched — the
    // others keep whatever interpretation (or lack of one) they already had.
    type Disc = {
      discount_rule_id?: string
      interpretation?: DiscountInterpretation | null
      affected_components?: string[] | null
      possibly_affected_components?: string[] | null
      [k: string]: unknown
    }
    const discounts = (termsRow.discounts ?? []) as Disc[]
    const isTiered = approvedInterpretation.discount_type === 'tiered_discount' || approvedInterpretation.discount_type === 'volume_discount'
    const interpretation: DiscountInterpretation = {
      discount_type: (approvedInterpretation.discount_type as DiscountInterpretation['discount_type']) ?? 'custom',
      discount_basis: (approvedInterpretation.discount_basis as DiscountInterpretation['discount_basis']) ?? 'percentage',
      tier_method: isTiered ? ((approvedInterpretation.tier_method as DiscountInterpretation['tier_method']) ?? null) : null,
      tiers: isTiered ? ((approvedInterpretation.tiers as DiscountInterpretation['tiers']) ?? null) : null,
      applies_to: (approvedInterpretation.applies_to as string | null) ?? null,
      application_order: (approvedInterpretation.application_order as string | null) ?? null,
      reset_period: (approvedInterpretation.reset_period as DiscountInterpretation['reset_period']) ?? null,
      worked_example: (approvedInterpretation.worked_example as string | null) ?? null,
      requires_confirmation: false,
      confirmation_reason: null,
    }
    const targetIndex = discounts.findIndex(d => d.discount_rule_id === discountId)
    const fallbackIndex = targetIndex === -1 && Number.isInteger(Number(discountId)) ? Number(discountId) : -1
    const existingDiscount = targetIndex !== -1 ? discounts[targetIndex] : (fallbackIndex !== -1 ? discounts[fallbackIndex] : undefined)
    // Step 17A hardening (review pass 7), item 2 — close the loop: a
    // reviewer's CONFIRMED scope decision (whether it reached
    // approvedInterpretation via /interpret-rule's natural-language
    // translation or a direct structured-option selection) must update
    // the TYPED targeting fields the committed-fixed-fee resolver actually
    // reads (lib/committed-fixed-fee-resolver.ts), not only the
    // human-readable interpretation/applies_to. When approvedInterpretation
    // carries these fields (array, even empty — an explicit [] IS a
    // resolved answer), they become the new authoritative typed state;
    // when it doesn't (e.g. a legacy client that never sends them), the
    // discount's existing typed fields are preserved as-is rather than
    // being silently cleared to "no typed metadata" (which would reopen
    // the fail-closed gap this confirmation was supposed to close).
    const { affected_components: affectedComponents, possibly_affected_components: possiblyAffectedComponents } =
      resolveConfirmedDiscountComponents(approvedInterpretation, existingDiscount)
    let newDiscounts: Disc[]
    if (targetIndex !== -1) {
      newDiscounts = discounts.map((d, i) => (i === targetIndex ? { ...d, interpretation, affected_components: affectedComponents, possibly_affected_components: possiblyAffectedComponents } : d))
    } else if (fallbackIndex !== -1 && discounts[fallbackIndex]) {
      // Legacy discount row addressed positionally, predates discount_rule_id
      // — backfill the id now so future confirmations address it directly.
      newDiscounts = discounts.map((d, i) => (i === fallbackIndex ? { ...d, discount_rule_id: d.discount_rule_id ?? discountId, interpretation, affected_components: affectedComponents, possibly_affected_components: possiblyAffectedComponents } : d))
    } else if (discounts.length === 0) {
      newDiscounts = [{
        discount_rule_id: discountId, discount_pct: null, discount_amount: null, discount_type: 'other',
        start_date: null, end_date: null, duration_months: null, applies_to: interpretation.applies_to ?? '', description: '',
        interpretation, affected_components: affectedComponents, possibly_affected_components: possiblyAffectedComponents,
      }]
    } else {
      newDiscounts = discounts
      propagation['contract_terms'] = 'failed'
    }
    if (propagation['contract_terms'] !== 'failed') {
      const { error } = await supabaseServer.from('contract_terms').update({ discounts: newDiscounts }).eq('id', termsRow.id)
      propagation['contract_terms'] = error ? 'failed' : 'applied'
    }
  } else if (ruleType === 'tier_calculation') {
    if (!contractUnitType) {
      propagation['contract_terms'] = 'failed'
    } else {
      type Tier = { unit_type: string; tier_calculation?: TierCalculationMethod | null; [k: string]: unknown }
      const tiers = (termsRow.overage_tiers ?? []) as Tier[]
      const newTiers = tiers.map(t =>
        t.unit_type === contractUnitType
          ? { ...t, tier_calculation: buildTierCalculation(approvedInterpretation) }
          : t
      )
      const { error } = await supabaseServer.from('contract_terms').update({ overage_tiers: newTiers }).eq('id', termsRow.id)
      propagation['contract_terms'] = error ? 'failed' : 'applied'
    }
  } else if (ruleType === 'service_credit') {
    // Same addressing pattern as discount: stable credit_rule_id, not array
    // position, with the same legacy-row positional fallback + backfill.
    type Credit = { credit_rule_id?: string; credit_type?: string; interpretation?: ServiceCreditInterpretation | null; [k: string]: unknown }
    const credits = (termsRow.service_credits ?? []) as Credit[]
    const currentCredit = credits.find(c => c.credit_rule_id === creditId)
    const existingAppRule = currentCredit?.interpretation?.application_rule

    // Step 5C — Organization Rulebook production resolution, allowlisted
    // to survival.carry_forward only (lib/rulebook/organization-rulebook-
    // production.ts). Only even attempted when this field is genuinely
    // still silent (no concrete carry_forward yet, or no application_rule
    // at all) — an already contract_derived/reviewer_policy-resolved
    // value never reaches this branch, and buildCreditApplicationRule
    // independently re-checks this before ever applying the result, so
    // this early-out is a cheap optimization (skip the DB lookup
    // entirely when there's nothing to fill), not the enforcement point.
    //
    // Deliberately narrow again (final safety-check amendment) — this no
    // longer widens on a client-submitted carry_forward: 'unclear', which
    // would have let a crafted request re-trigger resolution regardless of
    // the field's CURRENT authority (including contract_derived). The
    // revert case is now handled entirely by organizationRevertResolution
    // (computed above, gated by its own eligibility + TOCTOU checks)
    // before this branch is ever reached.
    //
    // Step 16A — THIS is the authoritative enforcement point (propose-rule's
    // equivalent check is advisory only, per its own comment), so this is
    // where explicit contractual non-agreement must actually be blocked
    // from organization-policy fallback, not just in the review panel's
    // preview. Read from the server's OWN cached proposal for this exact
    // credit (proposalCache/cachedProposal, computed above from
    // termsRow.ai_proposal_cache) — never from a client-submitted value —
    // so a crafted request can't claim 'silent' to bypass this.
    //
    // Step 16A amendment (item 3) — a cache entry with NO stored
    // survival_unresolved_reason at all (any cache written before this
    // field existed) must never be silently treated as 'silent'. Instead
    // resolveAuthoritativeUnresolvedReason re-derives the real answer from
    // currentCredit.source_clause — the server's own persisted contract
    // text for this exact credit — so a pre-existing cache for an
    // agreement that genuinely states explicit non-agreement still blocks
    // organization-policy fallback correctly, without needing its cache
    // entry recomputed first.
    const currentCreditSourceClause = typeof currentCredit?.source_clause === 'string' ? currentCredit.source_clause : null
    const survivalUnresolvedReason = resolveAuthoritativeUnresolvedReason(cachedProposal?.survival_unresolved_reason, currentCreditSourceClause, 'survival')
    let organizationResolution: ProductionOrganizationResolution | undefined
    if ((!existingAppRule || existingAppRule.carry_forward === 'unclear') && organizationPolicyAvailableForUnresolvedReason(survivalUnresolvedReason)) {
      const organizationRules = await listMatchableOrganizationRules(org.orgId)
      const freshResolution = resolveProductionOrganizationField('survival.carry_forward', {
        organizationId: org.orgId,
        commercialContext: {
          current: { 'survival.carry_forward': { value: existingAppRule?.carry_forward ?? null, provenance: existingAppRule?.survival_provenance ?? null } },
          // Every current credit's availability is 'next_period' (the only
          // value CreditApplicationRule.availability implements today —
          // lib/types.ts) — 'next_invoice' is the real, accurate semantic
          // fact this reflects, not a guess.
          match: { rule_type: currentCredit?.credit_type ?? 'other', application: { timing: 'next_invoice' } },
        },
        organizationRules,
        asOf: new Date(),
      })

      // Step 5C, pre-commit review (item 3) — TOCTOU/staleness guard. The
      // organization-policy check propose-rule ran was advisory only; THIS
      // resolution, computed just now against live org.orgId-scoped
      // matchable rules, is the sole authoritative one (item 4 — the
      // client's survivalOrganizationPolicySeen is never used to SELECT a
      // rule, only to compare against). When the reviewer saw a specific
      // policy and the fresh, authoritative result no longer matches it
      // exactly (disabled/superseded — freshResolution.status flips to
      // 'not_applicable'; became conflicting — flips to 'conflict'; or a
      // still-'resolved' but DIFFERENT rule/version/value — e.g. an admin
      // edited the policy between propose and confirm), never silently
      // substitute the new policy for the one the reviewer was told about.
      // Leave organizationResolution unset so buildCreditApplicationRule's
      // own genuine-silence gate leaves carry_forward exactly as unresolved
      // as it already was — the field simply stays open for the reviewer's
      // next attempt (after a refresh), rather than executing on a policy
      // they never actually saw.
      if (survivalOrganizationPolicySeen && isOrganizationPolicyStale(freshResolution, {
        ruleId: survivalOrganizationPolicySeen.rule_id,
        ruleVersion: survivalOrganizationPolicySeen.version,
        value: survivalOrganizationPolicySeen.value,
      } satisfies SeenOrganizationPolicy)) {
        staleOrganizationPolicy = true
      } else {
        organizationResolution = freshResolution
      }
    }

    // Server-authorized revert (final safety-check amendment) — takes
    // priority over the generic client-driven merge entirely. Every value
    // below traces back to organizationRevertResolution, computed above
    // BEFORE the audit-row insert, from trusted server state only — the
    // client's approvedInterpretation/applicationRuleProvenance are never
    // consulted for this specific action, closing the crafted-payload
    // vector this amendment exists to fix.
    const interpretation = organizationRevertResolution
      ? {
          ...currentCredit!.interpretation!,
          application_rule: buildCreditApplicationRule(
            { application_rule: { carry_forward: 'unclear' } },
            existingAppRule,
            { eligibility: undefined, survival: null },
            organizationRevertResolution,
          ),
        }
      : buildServiceCreditInterpretation(approvedInterpretation, currentCredit?.interpretation, applicationRuleProvenance, cashRedeemableProvenance, organizationResolution, earnRuleProvenance, currentCreditSourceClause)
    const targetIndex = credits.findIndex(c => c.credit_rule_id === creditId)
    const fallbackIndex = targetIndex === -1 && Number.isInteger(Number(creditId)) ? Number(creditId) : -1
    let newCredits: Credit[]
    if (targetIndex !== -1) {
      newCredits = credits.map((c, i) => (i === targetIndex ? { ...c, interpretation } : c))
    } else if (fallbackIndex !== -1 && credits[fallbackIndex]) {
      newCredits = credits.map((c, i) => (i === fallbackIndex ? { ...c, credit_rule_id: c.credit_rule_id ?? creditId, interpretation } : c))
    } else if (credits.length === 0) {
      newCredits = [{ credit_rule_id: creditId, credit_type: 'other', description: '', source_clause: null, stated_pct: null, stated_amount: null, interpretation }]
    } else {
      newCredits = credits
      propagation['contract_terms'] = 'failed'
    }
    if (propagation['contract_terms'] !== 'failed') {
      const { error } = await supabaseServer.from('contract_terms').update({ service_credits: newCredits }).eq('id', termsRow.id)
      propagation['contract_terms'] = error ? 'failed' : 'applied'
    }
  } else if (ruleType === 'rule_interaction') {
    // No natural contract_terms field for the interaction itself — the
    // resolution is written back onto the referencing service credit's own
    // interpretation.interaction_note, so the calculation engine and any
    // standalone display of that credit sees the resolved basis without
    // joining the separate interaction audit row.
    const parsedCreditId = (interactionKey ?? '').split('|').find(p => p.startsWith('service_credit:'))?.split(':')[1]
    type Credit = { credit_rule_id?: string; interpretation?: ServiceCreditInterpretation | null; [k: string]: unknown }
    const credits = (termsRow.service_credits ?? []) as Credit[]
    const targetIndex = credits.findIndex(c => c.credit_rule_id === parsedCreditId)
    if (targetIndex === -1 || !credits[targetIndex].interpretation) {
      // The credit's own basis interpretation must exist before an
      // interaction resolution can be attached to it — surfaced as
      // 'skipped', not 'failed', since this isn't an error, just an
      // ordering dependency the reviewer needs to resolve first.
      propagation['contract_terms'] = 'skipped'
    } else {
      const note = (approvedInterpretation.note as string | null) ?? null
      const newCredits = credits.map((c, i) =>
        i === targetIndex ? { ...c, interpretation: { ...c.interpretation!, interaction_note: note } } : c
      )
      const { error } = await supabaseServer.from('contract_terms').update({ service_credits: newCredits }).eq('id', termsRow.id)
      propagation['contract_terms'] = error ? 'failed' : 'applied'
    }
  }

  // Step 17H.4B0D4H1B4E3.3 §23 — audit/authoritative-mutation atomicity.
  // The commercial_rule_interpretations row above was inserted (and any
  // priorCurrent row demoted) BEFORE this contract_terms mutation was
  // attempted — necessary ordering (the audit row must exist first), but
  // it means a contract_terms failure above would otherwise leave an
  // is_current=true audit row whose decision was never actually applied.
  // This directly contradicts lib/contract-terms-merge.ts's own new
  // authority doctrine, which trusts is_current=true as proof a decision
  // was durably confirmed — a stale "applied" audit row could cause a
  // LATER re-extraction to "restore" a decision that never actually took
  // effect. Demote the failed attempt back to not-current and restore
  // whichever row WAS current before this attempt (if any); the last row
  // that genuinely applied stays authoritative, never a failed one. Safe
  // without extra locking — beginConfigurationMutationClaim already
  // serializes concurrent confirm-rule calls for this job.
  if (propagation['contract_terms'] === 'failed') {
    const demoteQuery = supabaseServer
      .from('commercial_rule_interpretations')
      .update({ is_current: false })
      .eq('job_id', jobId)
      .eq('rule_type', ruleType)
      .eq('is_current', true)
    await (auditUnitKey ? demoteQuery.eq('contract_unit_type', auditUnitKey) : demoteQuery.is('contract_unit_type', null))
    if (priorCurrent) {
      await supabaseServer.from('commercial_rule_interpretations').update({ is_current: true }).eq('id', priorCurrent.id)
    }
  }

  // ── Step 3: contract_meter_mappings (mirror, when a confirmed mapping exists) ──
  const mirrorsToMeterMapping = ruleType === 'minimum_commitment' || ruleType === 'partial_period' || ruleType === 'tier_calculation'
  if (mirrorsToMeterMapping && contractUnitType) {
    const { data: mapping } = await supabaseServer
      .from('contract_meter_mappings')
      .select('id, overage_tiers, confirmed')
      .eq('job_id', jobId)
      .eq('contract_unit_type', contractUnitType)
      .maybeSingle()

    if (!mapping) {
      propagation['contract_meter_mappings'] = 'skipped' // no meter mapping exists yet — nothing to mirror into
    } else {
      type Tier = { minimum_commitment?: MinimumCommitment | null; tier_calculation?: TierCalculationMethod | null; [k: string]: unknown }
      const tiers = (mapping.overage_tiers ?? []) as Tier[]
      const newTiers = ruleType === 'tier_calculation'
        ? tiers.map(t => ({ ...t, tier_calculation: buildTierCalculation(approvedInterpretation) }))
        : tiers.map(t => ({ ...t, minimum_commitment: buildMinimumCommitment(approvedInterpretation, t.minimum_commitment) }))
      const { error } = await supabaseServer.from('contract_meter_mappings').update({ overage_tiers: newTiers }).eq('id', mapping.id)
      propagation['contract_meter_mappings'] = error ? 'failed' : 'applied'
    }
  } else {
    propagation['contract_meter_mappings'] = 'skipped'
  }

  // ── Step 4: Model B+ reconciliation, for LINE_ITEM_RELEVANT ruleTypes only ──
  // Step 17H.4B0D4H1B4D1.3 §7/§21 — the ONE shared reconciliation trigger,
  // replacing the base_fee_proration-only version this used to be embedded
  // inside. Runs for every ruleType RULE_TYPE_RECONCILIATION_RELEVANCE
  // marks 'line_item_relevant' (base_fee_proration, one_time_fee,
  // escalator) whenever the terms write actually committed — never for
  // 'schedule_relevant'/'advisory' ruleTypes, which would just manufacture
  // a reconciliation pass over fields buildLineItems never reads (§6/§8:
  // "do not run Model B+ merely to make the hold transition convenient").
  // Best-effort in the sense that matters: a reconciliation failure here
  // never rolls back or invalidates the interpretation already durably
  // saved above — the human decision stands regardless; what it DOES
  // affect is what the final hold transition below decides.
  if (RULE_TYPE_RECONCILIATION_RELEVANCE[ruleType] === 'line_item_relevant' && propagation['contract_terms'] === 'applied') {
    try {
      // Step 17H.4B0D4H1B3.2 — the canonical shared loader (lib/
      // reconciliation-terms-loader.ts), never a hand-picked select — see
      // that loader's own header for the two independent column omissions
      // this fixed historically.
      const built = await buildFreshLineItemsFromPersistedTerms(supabaseServer, jobId)
      if (built) {
        reconciliationOutcome = await reconcileCurrentLineItemsForJob({
          supabase: supabaseServer, jobId,
          freshItems: built.freshItems,
          terms: {
            overage_tiers: built.loaded.terms.overage_tiers ?? [],
            additional_recurring_fees: built.loaded.terms.additional_recurring_fees ?? [],
            base_fee_proration: built.loaded.terms.base_fee_proration ?? null,
          },
        })
      }
    } catch (reconcileErr) {
      // Never lets a reconciliation problem fail this response — the
      // interpretation itself is already durably saved above. Recorded as
      // an 'error' outcome so the final transition still fails safe (->
      // reconciliation_blocked for a previously-approved job) instead of
      // silently leaving reconciliationOutcome null (which would be
      // misread as "no reconciliation was needed").
      console.error(`[confirm-rule] ${ruleType} reconciliation failed for job ${jobId}:`, reconcileErr)
      reconciliationOutcome = { status: 'error', errorMessage: reconcileErr instanceof Error ? reconcileErr.message : String(reconcileErr), blockers: [], retried: false }
    }
  }
  } catch (err) {
    // 17H.4B0D4H1B3.1, revised 17H.4B0D4H1B3.4 — an unexpected thrown
    // error anywhere in Step 2/3. contract_terms never became 'applied' ->
    // restore; otherwise leave the claim exactly as-is (post-commit, never
    // restore — matches execute's own doctrine) and re-throw, unchanged
    // from this route's existing behavior for a genuinely unexpected
    // failure. Unconditional now (no longer gated on claim.
    // hasExistingBillingSchedule): every AUTO_CONFIGURE claim establishes
    // a real hold regardless of approval status, so a never-approved
    // job's claim is just as real and just as much in need of restoring.
    if (propagation['contract_terms'] !== 'applied') {
      await restoreClaim().catch(() => {})
    }
    throw err
  }

  // Step 17H.4B0D4H1B3.1 §9, revised 17H.4B0D4H1B4D1.3 §6/§21-§23 — the ONE
  // shared post-mutation transition, covering every ruleType AND every
  // approval state uniformly. contract_terms never actually 'applied' ->
  // nothing commercial changed, restore the claim. Otherwise, branches on
  // whether real Model B+ reconciliation actually ran for this ruleType:
  //
  //   A. reconciliationOutcome !== null (a 'line_item_relevant' ruleType
  //      that ran real reconciliation) — the SAME computePostMutationHoldTransition
  //      reconcile-line-items uses, on the REAL outcome. allowRestoreToNullWhenUnmutated
  //      is false: contract_terms has already materially changed, so a
  //      clean outcome always promotes (schedule_rebuild_required/NULL per
  //      hasExistingBillingSchedule) — this IS legitimate evidence, since
  //      reconciliation genuinely ran.
  //
  //   B. No reconciliation ran AND the job was under reconciliation_blocked
  //      before this claim — the central acceptance invariant (§23): NO
  //      path here may treat a synthetic/absent outcome as proof a
  //      pre-existing structural blocker is resolved, for ANY ruleType,
  //      'schedule_relevant' or 'advisory' alike. Released back to the
  //      EXACT previous hold, unchanged — same doctrine as the reviewer
  //      line-items PATCH (computeReviewerPatchHoldTransition) and
  //      meter-mappings (H1B4D1.2).
  //
  //   C. No reconciliation ran, not previously blocked, 'schedule_relevant'
  //      — a real, traced downstream billing consumer exists (see
  //      RULE_TYPE_RECONCILIATION_RELEVANCE's own header) even though
  //      buildLineItems doesn't read the field, so this is a genuine
  //      material change: promotes to schedule_rebuild_required (existing
  //      schedule) or stays NULL (never approved), via the SAME
  //      computeReviewerPatchHoldTransition non-reconciling-mutation logic.
  //
  //   D. No reconciliation ran, not previously blocked, 'advisory' —
  //      rule_interaction only, no proven billing consequence at all
  //      (§20/RULE_TYPE_RECONCILIATION_RELEVANCE) — never promotes on its
  //      own; released back to the exact previous hold (NULL stays NULL,
  //      schedule_rebuild_required stays schedule_rebuild_required).
  let holdConflict = false
  if (propagation['contract_terms'] !== 'applied') {
    const { applied } = await restoreClaim()
    holdConflict = !applied
  } else if (reconciliationOutcome !== null) {
    const transition = computePostMutationHoldTransition({ claim, outcome: reconciliationOutcome, allowRestoreToNullWhenUnmutated: false, now: new Date().toISOString() })
    if (transition.changeNeeded) {
      const { applied } = await applyReconciliationHoldTransition(supabaseServer, jobId, claim.newBillingHold, transition.nextHold)
      holdConflict = !applied
    }
  } else if (claim.previousBillingHold?.reason === 'reconciliation_blocked') {
    const { applied } = await applyReconciliationHoldTransition(supabaseServer, jobId, claim.newBillingHold, claim.previousBillingHold)
    holdConflict = !applied
  } else {
    const relevance = RULE_TYPE_RECONCILIATION_RELEVANCE[ruleType]
    const startingKind: ReviewerPatchHoldStartingKind = claim.previousBillingHold === null ? 'clear' : 'schedule_rebuild_required'
    const nextHold = relevance === 'schedule_relevant'
      ? computeReviewerPatchHoldTransition({ startingKind, originalHold: claim.previousBillingHold, hasExistingBillingSchedule: claim.hasExistingBillingSchedule, now: new Date().toISOString() })
      : claim.previousBillingHold // 'advisory' — no proven billing consequence, never promotes; released back exactly as-is.
    const { applied } = await applyReconciliationHoldTransition(supabaseServer, jobId, claim.newBillingHold, nextHold)
    holdConflict = !applied
  }

  // Record the final propagation outcome on the audit row itself so later
  // inspection doesn't need to cross-reference contract_terms state.
  const statusUpdateQuery = supabaseServer
    .from('commercial_rule_interpretations')
    .update({ propagation_status: propagation })
    .eq('job_id', jobId)
    .eq('rule_type', ruleType)
    .eq('revision_number', nextRevision)
  await (auditUnitKey
    ? statusUpdateQuery.eq('contract_unit_type', auditUnitKey)
    : statusUpdateQuery.is('contract_unit_type', null))

  const anyFailed = Object.values(propagation).includes('failed')
  return NextResponse.json({ ok: !anyFailed, propagation, staleOrganizationPolicy, ...(holdConflict ? { holdConflict: true } : {}) }, { status: anyFailed ? 207 : 200 })
}
