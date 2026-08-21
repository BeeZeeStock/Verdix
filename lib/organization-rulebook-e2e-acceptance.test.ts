import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { supabaseServer } from './supabase'
import {
  createOrganizationRule, supersedeOrganizationRule, activateOrganizationRule,
  listActiveOrganizationRules, getOrganizationRule, listMatchableOrganizationRules,
} from './rulebook/organization-rules-service'
import { evaluateReviewerDecisionForPromotion, type PromotableFieldState } from './rulebook/organization-rulebook-promotion'
import { resolveProductionOrganizationField, isOrganizationPolicyStale, type SeenOrganizationPolicy, type ProductionOrganizationResolution } from './rulebook/organization-rulebook-production'
import { PRODUCTION_ORGANIZATION_RULEBOOK_ALLOWLIST } from './rulebook/organization-rulebook-production'
import { buildCreditApplicationRule } from './credit-application-rule'
import { isServiceCreditUnresolved, computeCommercialRuleWorkload } from './commercial-rule-status'
import type { ServiceCredit, ServiceCreditInterpretation, CreditApplicationRule, FieldProvenance } from './types'

// ═══════════════════════════════════════════════════════════════════════════
// Step 5E — end-to-end Organization Rulebook acceptance test.
//
// Composes ONLY already-built, already-tested Step 5A-5D primitives against
// a REAL database (real organization, real jobs/contract_terms rows, real
// organization_rulebook_rules writes, real activate_organization_rule_
// supersession RPC calls) — no new Rulebook architecture, no new production
// target fields, no Verdix Global defaults. Every write here follows the
// exact sequence the real routes perform (app/api/jobs/[id]/confirm-rule,
// app/api/org/rulebook/*) — this file cannot invoke those routes directly
// (Next.js route handlers pull in next-auth, which fails under plain
// vitest — the same constraint every prior step's tests have worked
// within), so it calls the identical underlying functions in the identical
// order and re-reads real persisted state afterward, rather than asserting
// against an in-memory approximation.
//
// Scope boundary, stated explicitly: the AI proposal step itself (does
// Claude correctly classify a clause as "genuinely silent" vs "explicit")
// is NOT re-verified here — that's Step 1's regression corpus and the
// service-credit prompt's own existing coverage, neither of which this step
// touches. What's fed in as "the proposal" is what a real propose-rule call
// would produce for the described contract language — used as a realistic
// INPUT to the deterministic machinery under test, not asserted as a live
// AI-behavior claim.
//
// SKIPPED BY DEFAULT — real network calls, creates/cleans up a real
// organization, real jobs, real contract_terms, and real
// organization_rulebook_rules:
//   RUN_RLS_INTEGRATION_TESTS=true npx vitest run lib/organization-rulebook-e2e-acceptance.test.ts
// ═══════════════════════════════════════════════════════════════════════════

const RUN = process.env.RUN_RLS_INTEGRATION_TESTS === 'true'
const describeIf = RUN ? describe : describe.skip

type AcceptanceRow = {
  contract: string
  sourceMeaning: string
  normalizedSurvivalState: string
  selectedAuthority: string
  selectedValue: string
  orgRule: string
  readiness: string
  uiProvenance: string
}
const report: AcceptanceRow[] = []

// Same three-color UI provenance mapping configure/[id]/page.tsx's
// provenanceLabel() uses (Step 5C/5D) — reproduced here (not imported,
// since that function lives in a 'use client' page component) purely to
// state, in this report, exactly what badge text the real UI would render
// for a given persisted provenance value.
function uiProvenanceLabel(p: string | null | undefined): string {
  return p === 'contract_derived' ? 'Clear from contract'
    : p === 'reviewer_policy' ? 'Reviewer policy'
    : p === 'organization_rulebook' ? 'Organization policy'
    : 'Decision required'
}

describeIf('Step 5E — end-to-end Organization Rulebook acceptance', () => {
  let orgId: string
  const jobIds: string[] = []
  const termsIds: string[] = []

  beforeAll(async () => {
    const slug = `step5e-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const { data: org, error } = await supabaseServer.from('organizations').insert({ name: 'Step 5E E2E Acceptance Org', slug }).select('id').single()
    if (error || !org) throw new Error(`organizations insert failed: ${error?.message}`)
    orgId = org.id
  })

  afterAll(async () => {
    if (termsIds.length) await supabaseServer.from('contract_terms').delete().in('id', termsIds)
    if (jobIds.length) await supabaseServer.from('jobs').delete().in('id', jobIds)
    await supabaseServer.from('organization_rulebook_rules').delete().eq('organization_id', orgId)
    await supabaseServer.from('organizations').delete().eq('id', orgId)

    // Concise acceptance report — synthetic data only, no customer names,
    // no clause text beyond the fixed synthetic phrasing this file itself
    // wrote. Printed once, after all scenarios and cleanup complete.
    console.log('\n=== Step 5E acceptance report (synthetic contracts only) ===\n' + report.map(r =>
      `\n${r.contract}\n  Source meaning:            ${r.sourceMeaning}\n  Normalized survival state: ${r.normalizedSurvivalState}\n  Selected authority:        ${r.selectedAuthority}\n  Selected value:            ${r.selectedValue}\n  Org rule:                  ${r.orgRule}\n  Readiness:                 ${r.readiness}\n  UI provenance shown:       ${r.uiProvenance}`
    ).join('\n'))
  })

  // ── Fixture helpers ────────────────────────────────────────────────────

  const RAW_CREDIT_SILENT: Omit<ServiceCredit, 'credit_rule_id' | 'interpretation'> = {
    credit_type: 'service_credit',
    description: 'Synthetic service credit — applied against future amounts payable on the next invoice.',
    source_clause: 'Any Service Credit earned in a given month shall be applied against amounts payable on Customer\'s next invoice.',
    stated_pct: 10,
    stated_amount: null,
  }
  const RAW_CREDIT_EXPLICIT_NO_CARRY: Omit<ServiceCredit, 'credit_rule_id' | 'interpretation'> = {
    ...RAW_CREDIT_SILENT,
    source_clause: 'Any Service Credit earned in a given month shall be applied against amounts payable on Customer\'s next invoice. Any unused portion of a Service Credit expires immediately after application to that next invoice and is not carried forward.',
  }

  async function createSyntheticContract(name: string, credits: ServiceCredit[]): Promise<{ jobId: string; termsId: string }> {
    const { data: job, error: jobError } = await supabaseServer.from('jobs').insert({
      org_id: orgId, name, module: 'AUTO_CONFIGURE', status: 'PENDING', currency: 'SEK',
    }).select('id').single()
    if (jobError || !job) throw new Error(`jobs insert failed: ${jobError?.message}`)
    jobIds.push(job.id)

    const { data: terms, error: termsError } = await supabaseServer.from('contract_terms').insert({
      job_id: job.id, currency: 'SEK', service_credits: credits,
    }).select('id').single()
    if (termsError || !terms) throw new Error(`contract_terms insert failed: ${termsError?.message}`)
    termsIds.push(terms.id)

    await supabaseServer.from('jobs').update({ contract_terms_id: terms.id }).eq('id', job.id)
    return { jobId: job.id, termsId: terms.id }
  }

  async function readCredit(termsId: string): Promise<ServiceCredit> {
    const { data } = await supabaseServer.from('contract_terms').select('service_credits').eq('id', termsId).single()
    return (data!.service_credits as ServiceCredit[])[0]
  }

  // Builds a full, persistable ServiceCreditInterpretation — the trigger/
  // basis/cap facts are fixed, plausible, synthetic constants (never the
  // subject of this test); only application_rule (built via the REAL
  // buildCreditApplicationRule) is what each scenario actually varies.
  function fullInterpretation(applicationRule: CreditApplicationRule, sourceClause: string): ServiceCreditInterpretation {
    return {
      trigger_type: 'usage_threshold',
      trigger_description: 'earned monthly based on qualifying usage',
      credit_basis: 'pct_of_period_fee',
      basis_component: 'platform_fee',
      credit_value: 10,
      currency: 'SEK',
      cap_amount: null,
      cap_pct: null,
      settlement_period: 'monthly',
      cash_redeemable: false,
      cash_redeemable_provenance: 'contract_derived',
      interaction_note: null,
      source_clause: sourceClause,
      requires_confirmation: applicationRule.requires_confirmation,
      confirmation_reason: null,
      earn_rule: {
        trigger_metric_key: 'usage', trigger_quantity: 1, trigger_comparator: 'gte',
        trigger_window: 'calendar_month', consecutive_windows_required: 1, window_anchor: 'calendar',
        finalization_deadline_days: null, requires_confirmation: false,
      },
      application_rule: applicationRule,
    }
  }

  async function writeInterpretation(termsId: string, creditRuleId: string, base: ServiceCredit, interpretation: ServiceCreditInterpretation) {
    const updated: ServiceCredit = { ...base, credit_rule_id: creditRuleId, interpretation }
    await supabaseServer.from('contract_terms').update({ service_credits: [updated] }).eq('id', termsId)
  }

  // Mirrors confirm-rule/route.ts's service_credit branch EXACTLY: a fresh,
  // authoritative re-resolution against whatever org rules exist RIGHT NOW
  // (never a cached/earlier snapshot), with optional TOCTOU staleness
  // comparison against what a client claims to have seen (Step 5C
  // hardening, item 3).
  async function confirmRuleResolve(existingProvenance: FieldProvenance | null, existingCarryForward: boolean | 'unclear', seen?: SeenOrganizationPolicy) {
    const orgRules = await listMatchableOrganizationRules(orgId)
    const fresh = resolveProductionOrganizationField('survival.carry_forward', {
      organizationId: orgId,
      commercialContext: { current: { 'survival.carry_forward': { value: existingCarryForward, provenance: existingProvenance } }, match: { rule_type: 'service_credit', application: { timing: 'next_invoice' } } },
      organizationRules: orgRules,
      asOf: new Date(),
    })
    let stale = false
    let organizationResolution: ProductionOrganizationResolution | undefined = fresh
    if (seen && isOrganizationPolicyStale(fresh, seen)) { stale = true; organizationResolution = undefined }
    return { fresh, stale, organizationResolution }
  }

  it('proof: production allowlist remains exactly survival.carry_forward (item "No architecture expansion")', () => {
    expect(PRODUCTION_ORGANIZATION_RULEBOOK_ALLOWLIST).toEqual(['survival.carry_forward'])
  })

  // ── Scenario A — first contract creates the policy ─────────────────────

  let orgRuleV1Id: string

  it('Scenario A: reviewer explicitly resolves genuine silence -> reviewer_policy, then promotes it to a draft, approved+activated org policy, without changing Contract A itself', async () => {
    const { termsId } = await createSyntheticContract('Contract A (creates the policy)', [{ ...RAW_CREDIT_SILENT, credit_rule_id: 'credit-a' }])
    const raw = await readCredit(termsId)
    expect(raw.interpretation).toBeUndefined() // fresh extraction: survival genuinely unresolved

    // Reviewer explicitly chooses "carry forward until fully used".
    const appRule = buildCreditApplicationRule(
      { application_rule: { eligible_component_keys: 'all', one_time: false, carry_forward: true } },
      null,
      { eligibility: 'contract_derived', survival: 'reviewer_policy' },
      undefined,
    )!
    expect(appRule.requires_confirmation).toBe(false)
    await writeInterpretation(termsId, 'credit-a', raw, fullInterpretation(appRule, RAW_CREDIT_SILENT.source_clause!))

    let persisted = await readCredit(termsId)
    expect(persisted.interpretation!.application_rule!.survival_provenance).toBe('reviewer_policy')
    expect(persisted.interpretation!.application_rule!.carry_forward).toBe(true)

    // "Use as organization default" — preview.
    const state: PromotableFieldState = {
      targetField: 'survival.carry_forward', provenance: 'reviewer_policy', value: true,
      matchFacts: { ruleType: 'service_credit', applicationTiming: 'next_invoice' },
    }
    const evaluation = evaluateReviewerDecisionForPromotion(state)
    expect(evaluation.eligible).toBe(true)
    if (!evaluation.eligible) return
    expect(evaluation.matchConditions).toEqual([
      { field: 'rule_type', operator: 'eq', value: 'service_credit' },
      { field: 'application.timing', operator: 'eq', value: 'next_invoice' },
    ])
    expect(evaluation.scopeSummary.treatmentLabel).toBe('Carry forward until fully used')

    // Create as draft.
    const draft = await createOrganizationRule({
      organizationId: orgId, name: 'Service Credit carry-forward default', targetField: evaluation.targetField,
      value: evaluation.value, matchConditions: evaluation.matchConditions, sourceKind: 'reviewer_promotion',
      createdBy: 'reviewer@step5e.test',
    })
    expect(draft.status).toBe('draft')
    expect(draft.sourceKind).toBe('reviewer_promotion')

    // Contract A's own reviewer decision is untouched by draft creation.
    persisted = await readCredit(termsId)
    expect(persisted.interpretation!.application_rule!.survival_provenance).toBe('reviewer_policy')

    // Approve & activate.
    const activated = await activateOrganizationRule(orgId, draft.id, 'admin@step5e.test', new Date())
    expect(activated.status).toBe('active')
    orgRuleV1Id = activated.id

    const active = await listActiveOrganizationRules(orgId)
    expect(active).toHaveLength(1)

    // Required check: Contract A does NOT change after activation.
    const afterActivation = await readCredit(termsId)
    expect(afterActivation.interpretation!.application_rule!.survival_provenance).toBe('reviewer_policy')
    expect(afterActivation.interpretation!.application_rule!.carry_forward).toBe(true)
    expect(afterActivation.interpretation!.application_rule!.survival_organization_rule_id).toBeNull()

    report.push({
      contract: 'Contract A', sourceMeaning: 'Application timing = next invoice; carry-forward unstated',
      normalizedSurvivalState: 'unclear -> reviewer resolved',
      selectedAuthority: 'reviewer_policy', selectedValue: 'true (carry forward until fully used)',
      orgRule: 'none (this contract CREATED the policy; not resolved BY it)',
      readiness: 'resolved, no blocker', uiProvenance: uiProvenanceLabel('reviewer_policy'),
    })
  })

  // ── Scenario B — second contract automatically uses the policy ─────────

  let termsB: string

  it('Scenario B: a second, independent contract with the same silence resolves via the active org policy, with no manual decision, and stops blocking readiness', async () => {
    const { termsId } = await createSyntheticContract('Contract B (uses the policy)', [{ ...RAW_CREDIT_SILENT, credit_rule_id: 'credit-b' }])
    termsB = termsId
    const raw = await readCredit(termsId)

    // "propose-rule recognizes a matching active organization policy" —
    // the exact read-only check propose-rule/route.ts's
    // withOrganizationPolicyAvailability performs.
    const availability = await confirmRuleResolve(null, 'unclear')
    expect(availability.fresh.status).toBe('resolved')
    expect(availability.fresh.value).toBe(true)
    expect(availability.fresh.ruleId).toBe(orgRuleV1Id)
    expect(availability.fresh.ruleVersion).toBe(1)
    // -> this is exactly what the UI would render as
    //    "Organization policy · Carry forward until fully used", and what
    //    unblocks the review panel's inline picker (survivalNeedsInlinePicker).

    // "Confirm & apply" — the reviewer never picked a treatment; carry_forward
    // arrives 'unclear' exactly as the AI proposed it.
    const { organizationResolution } = await confirmRuleResolve(null, 'unclear')
    const appRule = buildCreditApplicationRule(
      { application_rule: { eligible_component_keys: 'all', one_time: false, carry_forward: 'unclear' } },
      null,
      { eligibility: 'contract_derived', survival: undefined },
      organizationResolution,
    )!
    expect(appRule.carry_forward).toBe(true)
    expect(appRule.survival_provenance).toBe('organization_rulebook')
    expect(appRule.survival_organization_rule_id).toBe(orgRuleV1Id)
    expect(appRule.survival_organization_rule_version).toBe(1)
    expect(appRule.requires_confirmation).toBe(false)

    await writeInterpretation(termsId, 'credit-b', raw, fullInterpretation(appRule, RAW_CREDIT_SILENT.source_clause!))
    const persisted = await readCredit(termsId)

    // Survival no longer contributes to review workload.
    expect(isServiceCreditUnresolved(persisted)).toBe(false)
    const workload = computeCommercialRuleWorkload({ service_credits: [persisted] }, { total: 0, confirmed: 0 })
    expect(workload.blockers).not.toContain(`service_credit:credit-b`)
    expect(workload.status).toBe('all_commercial_rules_confirmed')

    // Unrelated unresolved fields still block normally — a second,
    // genuinely-unconfirmed credit on the SAME contract.
    const unrelatedUnresolvedCredit: ServiceCredit = { credit_rule_id: 'credit-b-unrelated', credit_type: 'rebate', description: 'Unrelated, unconfirmed rebate', source_clause: null, stated_pct: 5, stated_amount: null }
    const workloadWithUnrelated = computeCommercialRuleWorkload({ service_credits: [persisted, unrelatedUnresolvedCredit] }, { total: 0, confirmed: 0 })
    expect(workloadWithUnrelated.blockers).toContain('service_credit:credit-b-unrelated')
    expect(workloadWithUnrelated.status).not.toBe('all_commercial_rules_confirmed')

    report.push({
      contract: 'Contract B', sourceMeaning: 'Application timing = next invoice; carry-forward unstated (identical silence to Contract A)',
      normalizedSurvivalState: 'unclear -> organization-resolved automatically',
      selectedAuthority: 'organization_rulebook', selectedValue: 'true (carry forward until fully used)',
      orgRule: `${orgRuleV1Id} · v1`, readiness: 'resolved, no blocker — Verdix did not ask the same question again',
      uiProvenance: uiProvenanceLabel('organization_rulebook'),
    })
  })

  // ── Scenario C — explicit contract wording overrides the policy ────────

  it('Scenario C: explicit no-carry-forward wording -> contract_derived; organization policy suppressed structurally, never even attempted', async () => {
    const { termsId } = await createSyntheticContract('Contract C (explicit override)', [{ ...RAW_CREDIT_EXPLICIT_NO_CARRY, credit_rule_id: 'credit-c' }])
    const raw = await readCredit(termsId)

    // The AI proposal for this contract: clear_from_source, carry_forward
    // = false — the clause explicitly states the credit does NOT survive.
    // Two independent layers of protection here, both exercised:
    //
    // Layer 1 — resolveProductionOrganizationField (via the Step 4
    // precedence resolver) already refuses to select the org candidate,
    // because contract_derived outranks organization_rulebook: the
    // status comes back 'not_applicable' (precedence_blocked under the
    // hood), not 'resolved' — the org policy never even reaches a
    // "would apply" state once the field is already contract-derived.
    const { organizationResolution } = await confirmRuleResolve('contract_derived', false)
    expect(organizationResolution?.status).toBe('not_applicable')

    // Layer 2 — belt-and-braces: buildCreditApplicationRule's own
    // genuine-silence gate (carry_forward === 'unclear') independently
    // refuses to apply ANY organization resolution once a concrete value
    // is already present, even in the hypothetical case where layer 1
    // didn't exist and a 'resolved' status were (incorrectly) handed in.
    const hypotheticalResolvedAnyway: ProductionOrganizationResolution = { status: 'resolved', value: true, ruleId: orgRuleV1Id, ruleVersion: 1, reason: 'hypothetical — proves layer 2 independently' }
    const appRule = buildCreditApplicationRule(
      { application_rule: { eligible_component_keys: 'all', one_time: false, carry_forward: false } },
      null,
      { eligibility: 'contract_derived', survival: 'contract_derived' },
      hypotheticalResolvedAnyway,
    )!
    expect(appRule.carry_forward).toBe(false)
    expect(appRule.survival_provenance).toBe('contract_derived')
    expect(appRule.survival_organization_rule_id).toBeNull()
    expect(appRule.survival_organization_rule_version).toBeNull()
    expect(appRule.requires_confirmation).toBe(false)

    await writeInterpretation(termsId, 'credit-c', raw, fullInterpretation(appRule, RAW_CREDIT_EXPLICIT_NO_CARRY.source_clause!))
    const persisted = await readCredit(termsId)
    expect(persisted.interpretation!.application_rule!.survival_provenance).toBe('contract_derived')
    expect(uiProvenanceLabel(persisted.interpretation!.application_rule!.survival_provenance)).toBe('Clear from contract')

    report.push({
      contract: 'Contract C', sourceMeaning: 'Explicit: "unused portion expires immediately... not carried forward"',
      normalizedSurvivalState: 'false (explicit) -> resolved',
      selectedAuthority: 'contract_derived', selectedValue: 'false (does not carry forward)',
      orgRule: 'none — suppressed, contract wins', readiness: 'resolved, no blocker, no manual decision required',
      uiProvenance: uiProvenanceLabel('contract_derived'),
    })
  })

  // ── Scenario D — contract-local override ────────────────────────────────

  let termsB2: string

  it('Scenario D: overriding Contract B locally produces reviewer_policy, clears org rule id/version, and never mutates the organization rule itself', async () => {
    const before = await readCredit(termsB)
    expect(before.interpretation!.application_rule!.survival_provenance).toBe('organization_rulebook')

    // Explicit reviewer choice: false ("Expires after next invoice") —
    // exactly what OrganizationPolicyControls.submitOverride sends.
    const overridden = buildCreditApplicationRule(
      { application_rule: { eligible_component_keys: 'all', one_time: false, carry_forward: false } },
      before.interpretation!.application_rule!,
      { eligibility: undefined, survival: 'reviewer_policy' },
      undefined,
    )!
    expect(overridden.carry_forward).toBe(false)
    expect(overridden.survival_provenance).toBe('reviewer_policy')
    expect(overridden.survival_organization_rule_id).toBeNull()
    expect(overridden.survival_organization_rule_version).toBeNull()

    await writeInterpretation(termsB, 'credit-b', before, fullInterpretation(overridden, RAW_CREDIT_SILENT.source_clause!))
    const after = await readCredit(termsB)
    expect(after.interpretation!.application_rule!.survival_provenance).toBe('reviewer_policy')
    expect(after.interpretation!.application_rule!.carry_forward).toBe(false)

    // The organization rule itself is unchanged.
    const orgRule = await getOrganizationRule(orgId, orgRuleV1Id)
    expect(orgRule?.value).toBe(true)
    expect(orgRule?.version).toBe(1)
    expect(orgRule?.status).toBe('active')

    report.push({
      contract: 'Contract B (after local override)', sourceMeaning: 'Same as Contract B, reviewer then overrode locally',
      normalizedSurvivalState: 'organization_rulebook -> explicitly overridden',
      selectedAuthority: 'reviewer_policy', selectedValue: 'false (expires after next invoice)',
      orgRule: 'cleared (no longer governs this agreement)', readiness: 'resolved, no blocker',
      uiProvenance: uiProvenanceLabel('reviewer_policy'),
    })

    // Contract B2 — a fresh contract with the same silence, created AFTER
    // B's override — proves the override stayed local to B.
    const { termsId } = await createSyntheticContract('Contract B2 (proves override stayed local)', [{ ...RAW_CREDIT_SILENT, credit_rule_id: 'credit-b2' }])
    termsB2 = termsId
    const rawB2 = await readCredit(termsId)
    const { organizationResolution } = await confirmRuleResolve(null, 'unclear')
    const appRuleB2 = buildCreditApplicationRule(
      { application_rule: { eligible_component_keys: 'all', one_time: false, carry_forward: 'unclear' } },
      null,
      { eligibility: 'contract_derived', survival: undefined },
      organizationResolution,
    )!
    expect(appRuleB2.carry_forward).toBe(true) // still the org default — B's local override never touched v1
    expect(appRuleB2.survival_provenance).toBe('organization_rulebook')
    expect(appRuleB2.survival_organization_rule_id).toBe(orgRuleV1Id)
    expect(appRuleB2.survival_organization_rule_version).toBe(1)
    await writeInterpretation(termsId, 'credit-b2', rawB2, fullInterpretation(appRuleB2, RAW_CREDIT_SILENT.source_clause!))

    report.push({
      contract: 'Contract B2', sourceMeaning: 'Same silence as Contract B, created after B\'s local override',
      normalizedSurvivalState: 'unclear -> organization-resolved (v1 still active)',
      selectedAuthority: 'organization_rulebook', selectedValue: 'true (carry forward until fully used)',
      orgRule: `${orgRuleV1Id} · v1`, readiness: 'resolved, no blocker — proves B\'s override stayed local',
      uiProvenance: uiProvenanceLabel('organization_rulebook'),
    })
  })

  // ── Scenario E — policy version change ──────────────────────────────────

  let orgRuleV2Id: string

  it('Scenario E: superseding v1 with v2 leaves Contract B and B2 exactly as they were; a contract resolved after v2 activates uses v2', async () => {
    const v2Draft = await supersedeOrganizationRule({
      organizationId: orgId, previousRuleId: orgRuleV1Id, name: 'Service Credit carry-forward default',
      targetField: 'survival.carry_forward', value: false,
      matchConditions: [{ field: 'rule_type', operator: 'eq', value: 'service_credit' }, { field: 'application.timing', operator: 'eq', value: 'next_invoice' }],
      createdBy: 'admin@step5e.test',
    })
    const v2 = await activateOrganizationRule(orgId, v2Draft.id, 'admin@step5e.test', new Date())
    expect(v2.status).toBe('active')
    expect(v2.version).toBe(2)
    orgRuleV2Id = v2.id

    const v1AfterSupersession = await getOrganizationRule(orgId, orgRuleV1Id)
    expect(v1AfterSupersession?.status).toBe('superseded')
    expect(v1AfterSupersession?.value).toBe(true) // unchanged historical value

    // Contract B (locally overridden in Scenario D) is untouched by the supersession.
    const bAfter = await readCredit(termsB)
    expect(bAfter.interpretation!.application_rule!.survival_provenance).toBe('reviewer_policy')
    expect(bAfter.interpretation!.application_rule!.carry_forward).toBe(false)

    // Contract B2 (resolved via v1 while it was active) keeps v1's audit
    // trail — historical reproducibility, no retroactive recomputation.
    const b2After = await readCredit(termsB2)
    expect(b2After.interpretation!.application_rule!.survival_provenance).toBe('organization_rulebook')
    expect(b2After.interpretation!.application_rule!.carry_forward).toBe(true)
    expect(b2After.interpretation!.application_rule!.survival_organization_rule_id).toBe(orgRuleV1Id)
    expect(b2After.interpretation!.application_rule!.survival_organization_rule_version).toBe(1)

    // A brand-new contract, resolved AFTER v2 becomes active, uses v2.
    const { termsId } = await createSyntheticContract('Contract E (resolved after v2)', [{ ...RAW_CREDIT_SILENT, credit_rule_id: 'credit-e' }])
    const rawE = await readCredit(termsId)
    const { organizationResolution } = await confirmRuleResolve(null, 'unclear')
    expect(organizationResolution?.ruleId).toBe(orgRuleV2Id)
    expect(organizationResolution?.ruleVersion).toBe(2)
    expect(organizationResolution?.value).toBe(false)
    const appRuleE = buildCreditApplicationRule(
      { application_rule: { eligible_component_keys: 'all', one_time: false, carry_forward: 'unclear' } },
      null,
      { eligibility: 'contract_derived', survival: undefined },
      organizationResolution,
    )!
    expect(appRuleE.carry_forward).toBe(false)
    expect(appRuleE.survival_provenance).toBe('organization_rulebook')
    expect(appRuleE.survival_organization_rule_id).toBe(orgRuleV2Id)
    expect(appRuleE.survival_organization_rule_version).toBe(2)
    await writeInterpretation(termsId, 'credit-e', rawE, fullInterpretation(appRuleE, RAW_CREDIT_SILENT.source_clause!))

    report.push({
      contract: 'Contract B2 (post-supersession re-check)', sourceMeaning: 'unchanged',
      normalizedSurvivalState: 'organization_rulebook (unchanged)', selectedAuthority: 'organization_rulebook',
      selectedValue: 'true (still v1\'s value)', orgRule: `${orgRuleV1Id} · v1 (retained, not recomputed to v2)`,
      readiness: 'resolved, no blocker', uiProvenance: uiProvenanceLabel('organization_rulebook'),
    })
    report.push({
      contract: 'Contract E', sourceMeaning: 'Same silence, created after v2 activated',
      normalizedSurvivalState: 'unclear -> organization-resolved via CURRENT policy',
      selectedAuthority: 'organization_rulebook', selectedValue: 'false (does not carry forward — v2\'s value)',
      orgRule: `${orgRuleV2Id} · v2`, readiness: 'resolved, no blocker',
      uiProvenance: uiProvenanceLabel('organization_rulebook'),
    })
  })

  // ── Scenario F — stale-policy race ──────────────────────────────────────

  it('Scenario F: a policy version change between proposal and confirmation fails closed — no silent substitution from either version', async () => {
    const { termsId } = await createSyntheticContract('Contract F (stale-policy race)', [{ ...RAW_CREDIT_SILENT, credit_rule_id: 'credit-f' }])
    const raw = await readCredit(termsId)

    // "proposal sees v2" — the review panel opens while v2 is the active policy.
    const seenAtProposeTime = await confirmRuleResolve(null, 'unclear')
    expect(seenAtProposeTime.fresh.ruleId).toBe(orgRuleV2Id)
    const seen: SeenOrganizationPolicy = { ruleId: seenAtProposeTime.fresh.ruleId!, ruleVersion: seenAtProposeTime.fresh.ruleVersion!, value: seenAtProposeTime.fresh.value }

    // Before the reviewer confirms, the org policy changes again: v2 -> v3.
    const v3Draft = await supersedeOrganizationRule({
      organizationId: orgId, previousRuleId: orgRuleV2Id, name: 'Service Credit carry-forward default',
      targetField: 'survival.carry_forward', value: true,
      matchConditions: [{ field: 'rule_type', operator: 'eq', value: 'service_credit' }, { field: 'application.timing', operator: 'eq', value: 'next_invoice' }],
      createdBy: 'admin@step5e.test',
    })
    const v3 = await activateOrganizationRule(orgId, v3Draft.id, 'admin@step5e.test', new Date())
    expect(v3.version).toBe(3)

    // "Confirm & apply" — confirm-rule independently re-resolves (now v3)
    // and compares against what the reviewer was shown (v2) -> stale.
    const { fresh, stale, organizationResolution } = await confirmRuleResolve(null, 'unclear', seen)
    expect(fresh.ruleId).toBe(v3.id) // the fresh, authoritative result really is v3
    expect(stale).toBe(true)
    expect(organizationResolution).toBeUndefined()

    const appRule = buildCreditApplicationRule(
      { application_rule: { eligible_component_keys: 'all', one_time: false, carry_forward: 'unclear' } },
      null,
      { eligibility: 'contract_derived', survival: undefined },
      organizationResolution,
    )!
    // No silent substitution from EITHER the seen (v2) or fresh (v3) value.
    expect(appRule.carry_forward).toBe('unclear')
    expect(appRule.survival_provenance).toBeNull()
    expect(appRule.survival_organization_rule_id).toBeNull()
    expect(appRule.requires_confirmation).toBe(true)

    await writeInterpretation(termsId, 'credit-f', raw, fullInterpretation(appRule, RAW_CREDIT_SILENT.source_clause!))
    const persisted = await readCredit(termsId)
    expect(persisted.interpretation!.application_rule!.carry_forward).toBe('unclear')
    expect(isServiceCreditUnresolved(persisted)).toBe(true)

    report.push({
      contract: 'Contract F', sourceMeaning: 'Same silence; org policy changed (v2 -> v3) between proposal and confirm',
      normalizedSurvivalState: 'unclear -> stays unclear (stale-policy guard fired)',
      selectedAuthority: 'none — fails closed', selectedValue: 'unclear (no value applied)',
      orgRule: 'none — client saw v2, server authoritatively found v3, mismatch rejected',
      readiness: 'blocked — reviewer must reopen/refresh', uiProvenance: uiProvenanceLabel(null),
    })
  })
})
