// Organization Rulebook — pre-review auto-resolution (Step 5C, pre-commit
// review finding). Proves the concern raised in review: confirm-rule's own
// organization-resolution branch (lib/credit-application-rule.ts) is
// correct but was, before this fix, reachable ONLY after a reviewer had
// manually picked a survival treatment via the review panel's inline
// picker — because that picker was unconditionally FORCED open whenever
// survival_state === 'decision_required' (configure/[id]/page.tsx's
// survivalNeedsInlinePicker), and picking a treatment always submits a
// CONCRETE carry_forward + 'reviewer_policy' provenance, which pre-empts
// organization resolution entirely. The fix is two-part:
//   1. propose-rule/route.ts now runs a READ-ONLY availability check
//      (withOrganizationPolicyAvailability, reusing
//      resolveProductionOrganizationField — no duplicated logic) and
//      returns survival_organization_policy (rule id/version/value, not
//      just a boolean — so the review panel can show the reviewer the
//      actual policy) on the proposal.
//   2. The review panel's picker-forcing condition is relaxed when that
//      flag is set, so "Confirm & apply" submits carry_forward exactly as
//      the AI proposed it (still 'unclear') — letting confirm-rule's
//      EXISTING, already-hardened resolution branch actually fire.
//
// Second review round (TOCTOU/staleness, item 3): the availability check in
// propose-rule is advisory only — confirm-rule is the sole authoritative
// resolution point, and always independently re-derives org, loads
// matchable rules, matches, and resolves precedence itself (item 4). This
// file's second describe block proves that a policy that disappears,
// becomes conflicting, or is edited (different rule/version/value) between
// propose-rule and confirm-rule is caught by isOrganizationPolicyStale and
// never silently applied — confirm-rule/route.ts's own logic is a direct,
// unmodified composition of the same functions exercised here.
//
// This file cannot exercise the live HTTP routes (propose-rule needs a
// real AI call; confirm-rule/route.ts can't be unit-tested at all — see
// this project's established next-auth/vitest constraint, restated in
// lib/credit-application-rule.test.ts). Instead it composes the exact same
// PURE functions those routes call, with inputs shaped exactly like what
// each route produces/consumes, proving the full chain end to end without
// any AI or HTTP dependency:
//   resolveProductionOrganizationField (availability check)
//   -> buildCreditApplicationRule (what confirm-rule persists when the
//      reviewer submits 'unclear' because the picker never blocked them)
//   -> isServiceCreditUnresolved / computeCommercialRuleWorkload
//      (readiness — proves no manual survival decision was needed)
import { describe, it, expect } from 'vitest'
import { resolveProductionOrganizationField, isOrganizationPolicyStale, type SeenOrganizationPolicy } from '@/lib/rulebook/organization-rulebook-production'
import { buildCreditApplicationRule } from '@/lib/credit-application-rule'
import { isServiceCreditUnresolved, computeCommercialRuleWorkload } from '@/lib/commercial-rule-status'
import type { OrganizationRuleRecord } from '@/lib/rulebook/organization-rules'
import type { ServiceCreditInterpretation } from '@/lib/types'

function orgRule(overrides: Partial<OrganizationRuleRecord> = {}): OrganizationRuleRecord {
  return {
    id: 'rule-carry-forward-default',
    organizationId: 'org-a',
    name: 'Service credits carry forward',
    description: null,
    targetField: 'survival.carry_forward',
    value: true,
    matchConditions: [{ field: 'rule_type', operator: 'eq', value: 'service_credit' }],
    status: 'active',
    version: 4,
    supersedesRuleId: null,
    lineageId: 'lineage-carry-forward',
    sourceKind: 'manual',
    createdBy: 'owner@org-a.test',
    approvedBy: 'owner@org-a.test',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
    effectiveFrom: null,
    effectiveTo: null,
    ...overrides,
  }
}

const AS_OF = new Date('2026-08-22T12:00:00.000Z')

// Mirrors exactly what propose-rule/route.ts's withOrganizationPolicyAvailability
// computes (same function, same shape) — kept local so this test doesn't
// need to import route.ts (which it can't, per the next-auth constraint).
function checkAvailability(orgRules: OrganizationRuleRecord[]) {
  return resolveProductionOrganizationField('survival.carry_forward', {
    organizationId: 'org-a',
    commercialContext: {
      current: { 'survival.carry_forward': { value: 'unclear', provenance: null } },
      match: { rule_type: 'service_credit', application: { timing: 'next_invoice' } },
    },
    organizationRules: orgRules,
    asOf: AS_OF,
  })
}

describe('pre-review auto-resolution end to end (Step 5C fix)', () => {
  it('unresolved extracted service credit + active applicable organization policy -> availability check resolves BEFORE any reviewer submission', () => {
    const availability = checkAvailability([orgRule()])
    // This is precisely what would set RuleProposal.survival_organization_
    // policy_available = true, unblocking the review panel's picker — the
    // reviewer is never forced to make a manual survival choice.
    expect(availability.status).toBe('resolved')
    expect(availability.value).toBe(true)
    expect(availability.ruleId).toBe('rule-carry-forward-default')
    expect(availability.ruleVersion).toBe(4)
  })

  it('reviewer submits Confirm & apply WITHOUT touching the survival picker (carry_forward stays "unclear", survival provenance omitted, exactly what the client sends when the picker never blocked them) -> confirm-rule mints organization_rulebook, with the SAME rule id/version the availability check found', () => {
    const availability = checkAvailability([orgRule()])
    // What confirm-rule/route.ts's service_credit branch actually does:
    // approvedInterpretation.application_rule.carry_forward is whatever the
    // AI proposed (still 'unclear' — the client never overrides it), and
    // applicationRuleProvenance.survival is undefined (stateToProvenance
    // returns undefined for 'decision_required').
    const applicationRule = buildCreditApplicationRule(
      { application_rule: { eligible_component_keys: 'all', one_time: false, carry_forward: 'unclear' } },
      null,
      { eligibility: 'contract_derived', survival: undefined },
      availability,
    )
    expect(applicationRule?.carry_forward).toBe(true)
    expect(applicationRule?.survival_provenance).toBe('organization_rulebook')
    expect(applicationRule?.survival_organization_rule_id).toBe('rule-carry-forward-default')
    expect(applicationRule?.survival_organization_rule_version).toBe(4)
    // Zero manual decision for survival specifically, AND (since eligibility
    // was already contract_derived, matching the item 11 acceptance
    // fixture's realistic shape) the credit's application scope as a whole
    // is fully resolved too — no lingering blocker anywhere.
    expect(applicationRule?.requires_confirmation).toBe(false)
  })

  it('readiness/workload (computeCommercialRuleWorkload) sees the resolved credit as fully confirmed once the reviewer\'s single Confirm & apply persists it -- proving no SEPARATE survival decision was ever required', () => {
    const availability = checkAvailability([orgRule()])
    const applicationRule = buildCreditApplicationRule(
      { application_rule: { eligible_component_keys: 'all', one_time: false, carry_forward: 'unclear' } },
      null,
      { eligibility: 'contract_derived', survival: undefined },
      availability,
    )!
    // The rest of the interpretation (trigger/basis/etc.) as confirm-rule
    // would have built it from the SAME single "Confirm & apply" submission
    // — this is the one, unavoidable point of reviewer interaction (Verdix
    // cannot determine a credit's trigger/basis without a human/AI reading
    // the clause), but it required no ADDITIONAL click for survival.
    const interpretation: ServiceCreditInterpretation = {
      trigger_type: 'usage_threshold', trigger_description: 'processes more than 300,000 transactions in a calendar month',
      credit_basis: 'pct_of_period_fee', basis_component: 'platform_fee', credit_value: 10, currency: 'SEK',
      cap_amount: null, cap_pct: null, settlement_period: 'monthly',
      cash_redeemable: false, cash_redeemable_provenance: 'contract_derived',
      interaction_note: null, source_clause: 'Applied against future amounts payable.',
      requires_confirmation: false, confirmation_reason: null,
      earn_rule: {
        trigger_metric_key: 'transactions', trigger_quantity: 300000, trigger_comparator: 'gt',
        trigger_window: 'calendar_month', consecutive_windows_required: 1, window_anchor: 'calendar',
        finalization_deadline_days: null, requires_confirmation: false,
      },
      application_rule: applicationRule,
    }
    const credit = { credit_rule_id: 'credit-1', interpretation }
    expect(isServiceCreditUnresolved(credit)).toBe(false)

    const workload = computeCommercialRuleWorkload({ service_credits: [credit] }, { total: 0, confirmed: 0 })
    expect(workload.blockers).not.toContain('service_credit:credit-1')
    expect(workload.status).toBe('all_commercial_rules_confirmed')
  })

  it('no applicable organization policy exists -> availability check does not resolve, picker correctly stays forced, confirm-rule correctly leaves the field unresolved if the reviewer still submits "unclear"', () => {
    const availability = checkAvailability([]) // no org rules at all
    expect(availability.status).toBe('not_applicable')

    const applicationRule = buildCreditApplicationRule(
      { application_rule: { eligible_component_keys: 'all', one_time: false, carry_forward: 'unclear' } },
      null,
      { eligibility: 'contract_derived', survival: undefined },
      availability,
    )
    expect(applicationRule?.carry_forward).toBe('unclear')
    expect(applicationRule?.survival_provenance).toBeNull()
    expect(applicationRule?.requires_confirmation).toBe(true)
  })
})

// Mirrors confirm-rule/route.ts's service_credit branch EXACTLY: fresh,
// authoritative re-resolution against whatever org rules exist right now
// (never the client-supplied "seen" metadata as a selection) -> compare
// against survivalOrganizationPolicySeen via isOrganizationPolicyStale ->
// only pass organizationResolution through to buildCreditApplicationRule
// when it is NOT stale. Kept local (route.ts itself can't be imported —
// next-auth constraint) but is a line-for-line match of the real logic, so
// a change to one without the other would show up as this test file
// diverging from the route's own comments during review.
function confirmAsRoute(
  orgRulesAtConfirmTime: OrganizationRuleRecord[],
  seen: SeenOrganizationPolicy | undefined,
) {
  const freshResolution = resolveProductionOrganizationField('survival.carry_forward', {
    organizationId: 'org-a',
    commercialContext: {
      current: { 'survival.carry_forward': { value: 'unclear', provenance: null } },
      match: { rule_type: 'service_credit', application: { timing: 'next_invoice' } },
    },
    organizationRules: orgRulesAtConfirmTime,
    asOf: AS_OF,
  })
  let stale = false
  let organizationResolution = freshResolution
  if (seen && isOrganizationPolicyStale(freshResolution, seen)) {
    stale = true
    organizationResolution = { status: 'not_applicable', reason: 'stale — not applied this submission' }
  }
  const applicationRule = buildCreditApplicationRule(
    { application_rule: { eligible_component_keys: 'all', one_time: false, carry_forward: 'unclear' } },
    null,
    { eligibility: 'contract_derived', survival: undefined },
    organizationResolution,
  )
  return { stale, applicationRule }
}

// Pre-commit review, second round — the organization-policy availability
// check in propose-rule is advisory only; confirm-rule is the sole
// authoritative resolution point (item 4) and must fail closed whenever
// the policy state it independently re-resolves no longer matches what a
// reviewer was shown (items 1, 2, 3).
describe('TOCTOU/staleness safeguard between propose-rule and confirm-rule (items 1-3)', () => {
  const seenPolicy: SeenOrganizationPolicy = { ruleId: 'rule-carry-forward-default', ruleVersion: 4, value: true }

  it('item 1 — policy disappears before confirmation (disabled/no longer effective): no organization provenance is minted, no unresolved value is treated as resolved, confirmation fails closed', () => {
    // propose-rule saw an active matching policy (this is the fixture the
    // OTHER describe block's availability check already proves resolves).
    // By confirm time, the org disabled it — orgRulesAtConfirmTime reflects
    // that live state.
    const { stale, applicationRule } = confirmAsRoute([orgRule({ status: 'disabled' })], seenPolicy)
    expect(stale).toBe(true)
    // Never minted — carry_forward stays exactly as unresolved as it was.
    expect(applicationRule?.carry_forward).toBe('unclear')
    expect(applicationRule?.survival_provenance).toBeNull()
    expect(applicationRule?.survival_organization_rule_id).toBeNull()
    expect(applicationRule?.survival_organization_rule_version).toBeNull()
    // Fails closed — still requires review, exactly the "needs-review
    // outcome" the reviewer must refresh or decide themselves.
    expect(applicationRule?.requires_confirmation).toBe(true)
  })

  it('item 2 — policy becomes conflicting before confirmation: no selected organization value, no organization_rulebook provenance, field remains unresolved', () => {
    const conflictingRules = [orgRule({ id: 'rule-carry-forward-default', version: 4, value: true }), orgRule({ id: 'rule-new-conflicting', value: false })]
    const { stale, applicationRule } = confirmAsRoute(conflictingRules, seenPolicy)
    expect(stale).toBe(true)
    expect(applicationRule?.carry_forward).toBe('unclear')
    expect(applicationRule?.survival_provenance).toBeNull()
    expect(applicationRule?.requires_confirmation).toBe(true)
  })

  it('item 3 — policy VALUE changed (same rule, new version) before confirmation: treated as stale, the newer policy is not silently substituted for the one the reviewer saw', () => {
    const editedRule = orgRule({ id: 'rule-carry-forward-default', version: 5, value: false }) // was v4/true when seen
    const { stale, applicationRule } = confirmAsRoute([editedRule], seenPolicy)
    expect(stale).toBe(true)
    expect(applicationRule?.carry_forward).toBe('unclear')
    expect(applicationRule?.survival_provenance).toBeNull()
  })

  it('control: policy UNCHANGED between propose and confirm -> not stale, resolves normally with the same rule id/version', () => {
    const { stale, applicationRule } = confirmAsRoute([orgRule()], seenPolicy)
    expect(stale).toBe(false)
    expect(applicationRule?.carry_forward).toBe(true)
    expect(applicationRule?.survival_provenance).toBe('organization_rulebook')
    expect(applicationRule?.survival_organization_rule_id).toBe('rule-carry-forward-default')
    expect(applicationRule?.survival_organization_rule_version).toBe(4)
  })

  it('item 4 — server never trusts the client-supplied seen metadata as a selection: a client claiming to have seen a policy that never matches ANY live rule still resolves against the REAL live rule, not the claimed one', () => {
    // The client's "seen" claim names a rule/version that doesn't exist at
    // all in the live org rules — confirm-rule must not fabricate a match
    // for it; it independently matches against orgRulesAtConfirmTime only.
    const fabricatedSeen: SeenOrganizationPolicy = { ruleId: 'rule-does-not-exist', ruleVersion: 99, value: true }
    const { stale, applicationRule } = confirmAsRoute([orgRule()], fabricatedSeen)
    // Real policy exists and would resolve on its own merits, but since it
    // doesn't match the (fabricated) seen claim, this submission treats it
    // as stale rather than trusting the client's story either way.
    expect(stale).toBe(true)
    expect(applicationRule?.survival_provenance).toBeNull()
  })

  it('no seen metadata supplied at all (e.g. reviewer never saw a proposal-time policy) -> no staleness comparison, resolves normally against live state', () => {
    const { stale, applicationRule } = confirmAsRoute([orgRule()], undefined)
    expect(stale).toBe(false)
    expect(applicationRule?.survival_provenance).toBe('organization_rulebook')
  })
})
