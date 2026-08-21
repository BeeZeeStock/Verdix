import { describe, it, expect } from 'vitest'
import { buildCreditApplicationRule, sanitizeAssertedProvenance } from './credit-application-rule'
import { isProvenanceResolved } from './commercial-rule-status'
import type { FieldProvenance } from './types'
import type { ProductionOrganizationResolution } from './rulebook/organization-rulebook-production'
import { resolveVerdixRulebookActivation, toRulebookExecutionBlockers } from './rulebook/activation'
import { creditApplicationContext } from './rulebook/context'

// Regression coverage for the core safety fix: a live A/B test (Opus vs
// Sonnet, TEST-PAY-002, 2026-08-20/21) showed a reasoning-tier model return
// concrete, confident values (carry_forward: false/true) for survival
// questions the contract never actually answers — tagged only as its own
// recommendation (survival_state: 'verdix_recommends'). Because
// requires_confirmation was previously derived from whether a value was
// present/concrete rather than from provenance, those recommendations
// silently cleared the credit's blocker. AI confidence is not provenance.

describe('isProvenanceResolved — the single canonical gate', () => {
  it('contract_derived resolves', () => expect(isProvenanceResolved('contract_derived')).toBe(true))
  it('reviewer_policy resolves', () => expect(isProvenanceResolved('reviewer_policy')).toBe(true))
  it('verdix_recommends does NOT resolve', () => expect(isProvenanceResolved('verdix_recommends')).toBe(false))
  it('null/undefined does NOT resolve', () => {
    expect(isProvenanceResolved(null)).toBe(false)
    expect(isProvenanceResolved(undefined)).toBe(false)
  })
})

describe('buildCreditApplicationRule — readiness gated on provenance, not value presence', () => {
  const baseApproved = (appRule: Record<string, unknown>) => ({ application_rule: appRule })

  it('A. Recommendation does not resolve — concrete value + verdix_recommends provenance still blocks', () => {
    const result = buildCreditApplicationRule(
      baseApproved({ eligible_component_keys: ['transaction_processing'], one_time: false, carry_forward: false }),
      null,
      { eligibility: 'contract_derived', survival: 'verdix_recommends' },
    )
    expect(result?.carry_forward).toBe(false) // the concrete value IS stored...
    expect(result?.survival_provenance).toBe('verdix_recommends')
    expect(result?.requires_confirmation).toBe(true) // ...but never clears the blocker on its own
  })

  it('A2. Same for eligibility specifically — Opus\'s exact TEST-PAY-002 Rebate shape (eligible_component_keys concrete, eligibility contract_derived; carry_forward concrete, survival verdix_recommends)', () => {
    const result = buildCreditApplicationRule(
      baseApproved({ eligible_component_keys: ['transaction_processing'], one_time: false, carry_forward: false }),
      null,
      { eligibility: 'verdix_recommends', survival: 'verdix_recommends' },
    )
    expect(result?.requires_confirmation).toBe(true)
  })

  it('B. Contract-derived resolves — no blocker when BOTH sub-fields are contract_derived', () => {
    const result = buildCreditApplicationRule(
      baseApproved({ eligible_component_keys: ['transaction_processing'], one_time: true, carry_forward: true }),
      null,
      { eligibility: 'contract_derived', survival: 'contract_derived' },
    )
    expect(result?.requires_confirmation).toBe(false)
    expect(result?.confirmation_reason).toBeNull()
  })

  it('C. Reviewer confirmation resolves — no blocker when BOTH sub-fields are reviewer_policy', () => {
    const result = buildCreditApplicationRule(
      baseApproved({ eligible_component_keys: 'all', one_time: false, carry_forward: true }),
      null,
      { eligibility: 'reviewer_policy', survival: 'reviewer_policy' },
    )
    expect(result?.requires_confirmation).toBe(false)
  })

  it('C2. Mixed provenance resolves too — contract_derived eligibility + reviewer_policy survival is fully resolved (order/source doesn\'t matter, only that both are good)', () => {
    const result = buildCreditApplicationRule(
      baseApproved({ eligible_component_keys: ['transaction_processing'], one_time: true, carry_forward: true }),
      null,
      { eligibility: 'contract_derived', survival: 'reviewer_policy' },
    )
    expect(result?.requires_confirmation).toBe(false)
  })

  it('D. Model confidence cannot override provenance — no provenance supplied at all still blocks regardless of how concrete/confident the value looks', () => {
    const result = buildCreditApplicationRule(
      baseApproved({ eligible_component_keys: ['transaction_processing'], one_time: false, carry_forward: false, confirmation_reason: 'model is very confident' }),
      null,
      undefined, // no applicationRuleProvenance in the request at all
    )
    expect(result?.requires_confirmation).toBe(true)
  })

  it('Only ONE sub-field resolved still blocks — eligibility contract_derived but survival verdix_recommends (TEST-PAY-002 Rebate\'s real, correct end state)', () => {
    const result = buildCreditApplicationRule(
      baseApproved({ eligible_component_keys: ['transaction_processing'], one_time: 'unclear', carry_forward: 'unclear' }),
      null,
      { eligibility: 'contract_derived', survival: undefined },
    )
    expect(result?.eligibility_provenance).toBe('contract_derived')
    expect(result?.survival_provenance).toBeNull()
    expect(result?.requires_confirmation).toBe(true)
  })

  it('a later confirm on the same credit does not silently downgrade an earlier reviewer_policy back to unresolved when this submission omits provenance', () => {
    const existing = buildCreditApplicationRule(
      baseApproved({ eligible_component_keys: ['transaction_processing'], one_time: true, carry_forward: true }),
      null,
      { eligibility: 'reviewer_policy', survival: 'reviewer_policy' },
    )
    expect(existing?.requires_confirmation).toBe(false)
    // A subsequent confirm on the same credit (e.g. re-confirming trigger/
    // rate facts) that doesn't touch application_rule provenance at all —
    // existing resolved state must survive, not silently reset to blocked.
    const second = buildCreditApplicationRule(
      { application_rule: undefined },
      existing,
      undefined,
    )
    expect(second?.requires_confirmation).toBe(false)
    expect(second?.eligibility_provenance).toBe('reviewer_policy')
  })

  it('still returns null when there is no application_rule at all and nothing existing — genuinely nothing to grade yet', () => {
    const result = buildCreditApplicationRule({}, null, undefined)
    expect(result).toBeNull()
  })

  it('a value of null for eligible_component_keys blocks even with contract_derived provenance claimed (belt-and-braces: provenance alone is not sufficient without an actual value)', () => {
    const result = buildCreditApplicationRule(
      baseApproved({ eligible_component_keys: null, one_time: true, carry_forward: true }),
      null,
      { eligibility: 'contract_derived', survival: 'contract_derived' },
    )
    expect(result?.requires_confirmation).toBe(true)
  })

  it('provenance values are typed to the closed FieldProvenance set — compile-time guard against a stray string reaching this gate', () => {
    const valid: FieldProvenance[] = ['contract_derived', 'verdix_recommends', 'reviewer_policy', 'organization_rulebook']
    for (const p of valid) expect(['contract_derived', 'verdix_recommends', 'reviewer_policy', 'organization_rulebook']).toContain(p)
  })
})

// Step 5C — organization resolution as a genuine-silence-only fallback
// inside buildCreditApplicationRule. resolveProductionOrganizationField
// itself is tested independently (tests/commercial-semantics/rulebook/
// organization-rulebook-production.test.ts) — these tests only cover HOW
// buildCreditApplicationRule consumes that already-computed result, exactly
// like a real confirm-rule/route.ts caller would hand it in.
const RESOLVED: ProductionOrganizationResolution = { status: 'resolved', value: true, ruleId: 'rule-1', ruleVersion: 3, reason: 'matched' }
const CONFLICT: ProductionOrganizationResolution = { status: 'conflict', reason: 'two equally-specific rules disagree' }
const NOT_APPLICABLE: ProductionOrganizationResolution = { status: 'not_applicable', reason: 'no active rule matched' }

describe('buildCreditApplicationRule — Step 5C organization resolution (fills genuine silence only)', () => {
  const baseApproved = (appRule: Record<string, unknown>) => ({ application_rule: appRule })

  it('genuine silence: carry_forward unclear, no provenance yet -> organization resolution fills it, audit fields recorded, blocker on THIS sub-field clears', () => {
    const result = buildCreditApplicationRule(
      baseApproved({ eligible_component_keys: 'all', one_time: false, carry_forward: 'unclear' }),
      null,
      { eligibility: 'contract_derived', survival: undefined },
      RESOLVED,
    )
    expect(result?.carry_forward).toBe(true)
    expect(result?.survival_provenance).toBe('organization_rulebook')
    expect(result?.survival_organization_rule_id).toBe('rule-1')
    expect(result?.survival_organization_rule_version).toBe(3)
    expect(result?.requires_confirmation).toBe(false)
  })

  it('never overwrites an existing contract_derived value, even when a resolved organization candidate is handed in', () => {
    const result = buildCreditApplicationRule(
      baseApproved({ eligible_component_keys: 'all', one_time: false, carry_forward: false }),
      null,
      { eligibility: 'contract_derived', survival: 'contract_derived' },
      RESOLVED,
    )
    expect(result?.carry_forward).toBe(false) // contract's value, not the org rule's
    expect(result?.survival_provenance).toBe('contract_derived')
    expect(result?.survival_organization_rule_id).toBeNull()
  })

  it('never overwrites an existing reviewer_policy value, even when a resolved organization candidate is handed in', () => {
    const result = buildCreditApplicationRule(
      baseApproved({ eligible_component_keys: 'all', one_time: false, carry_forward: false }),
      null,
      { eligibility: 'reviewer_policy', survival: 'reviewer_policy' },
      RESOLVED,
    )
    expect(result?.carry_forward).toBe(false)
    expect(result?.survival_provenance).toBe('reviewer_policy')
    expect(result?.survival_organization_rule_id).toBeNull()
  })

  it('conflict status never selects a value — field stays unresolved, no newest/oldest/first fallback', () => {
    const result = buildCreditApplicationRule(
      baseApproved({ eligible_component_keys: 'all', one_time: false, carry_forward: 'unclear' }),
      null,
      { eligibility: 'contract_derived', survival: undefined },
      CONFLICT,
    )
    expect(result?.carry_forward).toBe('unclear')
    expect(result?.survival_provenance).toBeNull()
    expect(result?.requires_confirmation).toBe(true)
  })

  it('not_applicable status leaves the field genuinely unresolved, same as no organizationResolution at all', () => {
    const withNotApplicable = buildCreditApplicationRule(
      baseApproved({ eligible_component_keys: 'all', one_time: false, carry_forward: 'unclear' }),
      null,
      { eligibility: 'contract_derived', survival: undefined },
      NOT_APPLICABLE,
    )
    const withoutResolution = buildCreditApplicationRule(
      baseApproved({ eligible_component_keys: 'all', one_time: false, carry_forward: 'unclear' }),
      null,
      { eligibility: 'contract_derived', survival: undefined },
      undefined,
    )
    expect(withNotApplicable?.carry_forward).toBe('unclear')
    expect(withNotApplicable).toEqual(withoutResolution)
  })

  it('resolving carry_forward via organization policy does not, by itself, clear an UNRELATED unresolved gate (eligibility) — no cross-field bypass', () => {
    const result = buildCreditApplicationRule(
      baseApproved({ eligible_component_keys: null, one_time: false, carry_forward: 'unclear' }),
      null,
      { eligibility: undefined, survival: undefined },
      RESOLVED,
    )
    expect(result?.survival_provenance).toBe('organization_rulebook') // this sub-field DID resolve...
    expect(result?.requires_confirmation).toBe(true) // ...but eligibility is still genuinely unresolved, so the credit overall still blocks
  })

  it('audit fields persist across a later confirm that does not touch application_rule at all (no silent downgrade)', () => {
    const existing = buildCreditApplicationRule(
      baseApproved({ eligible_component_keys: 'all', one_time: false, carry_forward: 'unclear' }),
      null,
      { eligibility: 'contract_derived', survival: undefined },
      RESOLVED,
    )
    expect(existing?.survival_provenance).toBe('organization_rulebook')
    const second = buildCreditApplicationRule({ application_rule: undefined }, existing, undefined, undefined)
    expect(second?.survival_provenance).toBe('organization_rulebook')
    expect(second?.survival_organization_rule_id).toBe('rule-1')
    expect(second?.survival_organization_rule_version).toBe(3)
  })

  // Step 5D item 12 — "Override for this agreement". The reviewer submits
  // a concrete value + survival: 'reviewer_policy' directly (bypassing
  // propose-rule entirely, since the current value/provenance is already
  // known — see OrganizationPolicyControls.submitOverride in configure/
  // [id]/page.tsx). This is the scenario that surfaced the audit-field bug
  // fixed in this same pass: overriding an ALREADY organization_rulebook-
  // resolved field must leave NO stale reference to the rule it replaced.
  it('item 12, DIFFERENT value: organization policy true, reviewer explicitly chooses false -> reviewer_policy, cleared org rule id/version, org rule itself untouched (bug fix)', () => {
    const orgResolved = buildCreditApplicationRule(
      baseApproved({ eligible_component_keys: 'all', one_time: false, carry_forward: 'unclear' }),
      null,
      { eligibility: 'contract_derived', survival: undefined },
      RESOLVED,
    )
    expect(orgResolved?.survival_provenance).toBe('organization_rulebook')
    expect(orgResolved?.carry_forward).toBe(true) // RESOLVED's value, per this file's fixture
    expect(orgResolved?.survival_organization_rule_id).toBe('rule-1')

    // The override submission: a concrete value, explicit reviewer_policy
    // provenance, no organizationResolution passed (matches exactly what
    // OrganizationPolicyControls.submitOverride sends to confirm-rule —
    // and, client-side, only reachable once the reviewer has explicitly
    // clicked a radio option; see that component's overrideValue comment).
    const overridden = buildCreditApplicationRule(
      baseApproved({ eligible_component_keys: 'all', one_time: false, carry_forward: false }),
      orgResolved,
      { eligibility: undefined, survival: 'reviewer_policy' },
      undefined,
    )
    expect(overridden?.carry_forward).toBe(false)
    expect(overridden?.survival_provenance).toBe('reviewer_policy')
    // The bug: these used to stay 'rule-1'/3 (carried over from `existing`
    // and never cleared) even though provenance no longer says
    // organization_rulebook — a misleading audit trail pointing at a
    // policy that no longer governs this field.
    expect(overridden?.survival_organization_rule_id).toBeNull()
    expect(overridden?.survival_organization_rule_version).toBeNull()
    expect(overridden?.requires_confirmation).toBe(false)
    // The organization rule's own record is never touched by this
    // function at all — it has no organization_rulebook_rules write path;
    // this is a structural guarantee (see lib/rulebook/organization-
    // rulebook-production.ts's own module comment), not something this
    // pure function could violate even if it tried.
  })

  it('item 12, SAME value: organization policy true, reviewer explicitly re-confirms true for this agreement -> still becomes reviewer_policy (an explicit contract-local choice, not a silent provenance swap)', () => {
    const orgResolved = buildCreditApplicationRule(
      baseApproved({ eligible_component_keys: 'all', one_time: false, carry_forward: 'unclear' }),
      null,
      { eligibility: 'contract_derived', survival: undefined },
      RESOLVED,
    )
    expect(orgResolved?.survival_provenance).toBe('organization_rulebook')
    expect(orgResolved?.carry_forward).toBe(true)

    // The reviewer explicitly picked "Carry forward until fully used" in
    // the override panel — the SAME value the org policy already applies —
    // but this is still a deliberate, explicit action (see configure/[id]/
    // page.tsx's OrganizationPolicyControls: overrideValue starts at null,
    // never pre-filled from the current value, so reaching this submission
    // at all required a real click), so it is honored as reviewer_policy,
    // not silently rejected as a no-op.
    const overridden = buildCreditApplicationRule(
      baseApproved({ eligible_component_keys: 'all', one_time: false, carry_forward: true }),
      orgResolved,
      { eligibility: undefined, survival: 'reviewer_policy' },
      undefined,
    )
    expect(overridden?.carry_forward).toBe(true)
    expect(overridden?.survival_provenance).toBe('reviewer_policy')
    // Audit fields still clear — this agreement's field is no longer
    // governed by the organization rule at all, even though the VALUE
    // happens to currently agree with it (the org default could change
    // later without this agreement silently following it anymore).
    expect(overridden?.survival_organization_rule_id).toBeNull()
    expect(overridden?.survival_organization_rule_version).toBeNull()
    expect(overridden?.requires_confirmation).toBe(false)
  })

  it('audit fields are never populated for any other survival_provenance value', () => {
    const contractResult = buildCreditApplicationRule(
      baseApproved({ eligible_component_keys: 'all', one_time: false, carry_forward: true }),
      null,
      { eligibility: 'contract_derived', survival: 'contract_derived' },
      undefined,
    )
    expect(contractResult?.survival_organization_rule_id).toBeNull()
    expect(contractResult?.survival_organization_rule_version).toBeNull()
  })
})

// Step 5C item 10 — invariants remain separate. Step 3's execution-invariant
// enforcement (resolveVerdixRulebookActivation / toRulebookExecutionBlockers)
// is a wholly independent mechanism from organization-rulebook field
// resolution; nothing in buildCreditApplicationRule or
// organization-rulebook-production.ts touches it. Proven directly: feeding
// the SAME resolved-via-organization-policy CreditApplicationRule through
// the unmodified Step 3 activation layer produces exactly the same
// diagnostic/invariant behavior as an equivalent contract_derived rule —
// invariant enforcement cannot see, and does not special-case, how a field's
// provenance was produced.
describe('invariants remain separate from organization-rulebook resolution (item 10)', () => {
  it('a carry_forward resolved via organization_rulebook flows into Step 3 invariant evaluation exactly like any other resolved provenance — no special-casing, no bypass', () => {
    const orgResolved = buildCreditApplicationRule(
      baseApprovedFixture({ eligible_component_keys: ['transaction_processing'], one_time: false, carry_forward: 'unclear' }),
      null,
      { eligibility: 'contract_derived', survival: undefined },
      RESOLVED,
    )!
    const contractResolved = buildCreditApplicationRule(
      baseApprovedFixture({ eligible_component_keys: ['transaction_processing'], one_time: false, carry_forward: true }),
      null,
      { eligibility: 'contract_derived', survival: 'contract_derived' },
      undefined,
    )!

    const orgContext = { creditApplication: creditApplicationContext(orgResolved) }
    const contractContext = { creditApplication: creditApplicationContext(contractResolved) }

    const orgActivation = resolveVerdixRulebookActivation(orgContext)
    const contractActivation = resolveVerdixRulebookActivation(contractContext)

    // Neither produces an execution blocker — the credit-application rules
    // in the Global Rulebook are diagnostic-only (see activation.test.ts's
    // DIAGNOSTIC_RULE_IDS), and this is true identically regardless of
    // whether carry_forward's provenance is organization_rulebook or
    // contract_derived — invariant enforcement has no organization-
    // rulebook-specific branch at all.
    expect(toRulebookExecutionBlockers(orgActivation)).toEqual([])
    expect(toRulebookExecutionBlockers(contractActivation)).toEqual([])
  })
})

// Pre-commit review finding: organization_rulebook provenance must ONLY be
// mintable server-side, via the real resolver (resolveProductionOrganizationField
// against a matching, active organization rule) — never as a bare client
// assertion. confirm-rule/route.ts destructures applicationRuleProvenance/
// cashRedeemableProvenance directly from the request body and threads them
// into buildCreditApplicationRule as the `provenance` parameter — so a
// crafted request body claiming `{ survival: 'organization_rulebook' }`
// would, without this guard, mint that provenance for ANY value with no
// matching rule and no audit trail (ruleId/ruleVersion). route.ts itself
// can't be unit-tested (next-auth import chain fails under plain vitest —
// see this file's own established convention), so these tests exercise the
// exact two functions route.ts calls, with inputs shaped exactly like what
// a malicious or buggy request body would produce.
describe('sanitizeAssertedProvenance — server-only minting of organization_rulebook (hard requirement)', () => {
  it('strips a bare organization_rulebook claim, passes every other value through unchanged', () => {
    expect(sanitizeAssertedProvenance('organization_rulebook')).toBeUndefined()
    expect(sanitizeAssertedProvenance('contract_derived')).toBe('contract_derived')
    expect(sanitizeAssertedProvenance('reviewer_policy')).toBe('reviewer_policy')
    expect(sanitizeAssertedProvenance('verdix_recommends')).toBe('verdix_recommends')
    expect(sanitizeAssertedProvenance(null)).toBeNull()
    expect(sanitizeAssertedProvenance(undefined)).toBeUndefined()
  })
})

describe('buildCreditApplicationRule — client cannot mint organization_rulebook by simply asserting it', () => {
  it('client sends carry_forward=true + survival provenance asserted as organization_rulebook, but no applicable rule was resolved server-side -> the assertion is ignored; field is NOT resolved as organization policy', () => {
    const result = buildCreditApplicationRule(
      baseApprovedFixture({ eligible_component_keys: 'all', one_time: false, carry_forward: true }),
      null,
      // Exactly what a crafted/malicious request body would put in
      // applicationRuleProvenance.survival — never a value confirm-rule's
      // own client code actually sends (stateToProvenance never returns
      // this), but nothing stops an arbitrary HTTP client from trying.
      { eligibility: 'contract_derived', survival: 'organization_rulebook' as FieldProvenance },
      undefined, // no organizationResolution — server found no matching rule
    )
    expect(result?.survival_provenance).not.toBe('organization_rulebook')
    // Falls back to null (unresolved) rather than silently accepting the
    // client's claim — readiness still correctly blocks on it.
    expect(result?.survival_provenance).toBeNull()
    expect(result?.survival_organization_rule_id).toBeNull()
    expect(result?.survival_organization_rule_version).toBeNull()
    expect(result?.requires_confirmation).toBe(true)
  })

  it('same client assertion, but this time a real organization rule DOES apply server-side -> resolved via the real resolver, with rule id/version persisted (not because the client asked for it)', () => {
    const result = buildCreditApplicationRule(
      baseApprovedFixture({ eligible_component_keys: 'all', one_time: false, carry_forward: 'unclear' }),
      null,
      // The client's claim is IGNORED either way — what actually matters is
      // organizationResolution, computed server-side.
      { eligibility: 'contract_derived', survival: 'organization_rulebook' as FieldProvenance },
      { status: 'resolved', value: true, ruleId: 'rule-real-1', ruleVersion: 2, reason: 'matched' },
    )
    expect(result?.carry_forward).toBe(true)
    expect(result?.survival_provenance).toBe('organization_rulebook')
    expect(result?.survival_organization_rule_id).toBe('rule-real-1')
    expect(result?.survival_organization_rule_version).toBe(2)
    expect(result?.requires_confirmation).toBe(false)
  })

  it('client asserting organization_rulebook cannot even overwrite an existing contract_derived value -- both protections apply simultaneously', () => {
    const result = buildCreditApplicationRule(
      baseApprovedFixture({ eligible_component_keys: 'all', one_time: false, carry_forward: false }),
      null,
      { eligibility: 'contract_derived', survival: 'organization_rulebook' as FieldProvenance },
      undefined,
    )
    // Neither the client's bare claim NOR any organization resolution ever
    // applies here anyway (buildCreditApplicationRule.carry_forward !==
    // 'unclear'), but confirms the sanitizer doesn't accidentally make this
    // WORSE than before Step 5C.
    expect(result?.carry_forward).toBe(false)
    expect(result?.survival_provenance).toBeNull()
  })
})

function baseApprovedFixture(appRule: Record<string, unknown>) {
  return { application_rule: appRule }
}
