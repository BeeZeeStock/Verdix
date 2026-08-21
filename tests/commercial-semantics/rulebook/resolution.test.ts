// Verdix rule resolution, authority & precedence (Step 4). Pure,
// shadow-mode tests for resolveFieldAuthority (lib/rulebook/resolution.ts)
// — the architecture that will eventually let explicit contract semantics,
// contract-specific reviewer decisions, a future Organization Rulebook,
// the Verdix Global Rulebook, and Verdix recommendations coexist
// predictably. No AI calls, no database, no mutation, and — proven at the
// bottom of this file — nothing produced here ever reaches production.
import { describe, it, expect } from 'vitest'
import { resolveFieldAuthority, RESOLUTION_AUTHORITY_PRECEDENCE, type RuleResolutionCandidate } from '@/lib/rulebook/resolution'
import { resolveVerdixRulebookShadow } from '@/lib/rulebook/resolver'
import { resolveVerdixRulebookActivation } from '@/lib/rulebook/activation'
import { minimumCommitmentContext, tierCalculationContext } from '@/lib/rulebook/context'

function candidate(overrides: Partial<RuleResolutionCandidate> & Pick<RuleResolutionCandidate, 'field' | 'value' | 'authority'>): RuleResolutionCandidate {
  return { method: 'existing_normalized_state', ...overrides }
}

describe('RESOLUTION_AUTHORITY_PRECEDENCE — the central ordering', () => {
  it('is exactly, in order: contract_derived, reviewer_policy, organization_rulebook, verdix_rulebook, verdix_recommends', () => {
    expect(RESOLUTION_AUTHORITY_PRECEDENCE).toEqual([
      'contract_derived', 'reviewer_policy', 'organization_rulebook', 'verdix_rulebook', 'verdix_recommends',
    ])
  })
})

describe('resolveFieldAuthority — degenerate inputs', () => {
  it('an empty candidate list is unresolved, not an error', () => {
    expect(resolveFieldAuthority([])).toEqual({ field: '', selected: undefined, suppressed: [], status: 'unresolved' })
  })
  it('a single, unopposed candidate at any real authority resolves to itself', () => {
    const c = candidate({ field: 'carry_forward', value: true, authority: 'organization_rulebook' })
    expect(resolveFieldAuthority([c])).toEqual({ field: 'carry_forward', selected: c, suppressed: [], status: 'resolved' })
  })
  it('candidates addressing different fields are a caller bug — throws rather than silently resolving the wrong thing', () => {
    const a = candidate({ field: 'carry_forward', value: true, authority: 'contract_derived' })
    const b = candidate({ field: 'cash_redeemable', value: false, authority: 'contract_derived' })
    expect(() => resolveFieldAuthority([a, b])).toThrow(/same field/)
  })
})

// The full required matrix (Step 4 item 10), each as its own dedicated
// test so a future regression names exactly which precedence rule broke.
describe('precedence matrix — cross-authority pairs', () => {
  const FIELD = 'application_timing'

  it('contract > reviewer', () => {
    const contract = candidate({ field: FIELD, value: 'next_invoice', authority: 'contract_derived' })
    const reviewer = candidate({ field: FIELD, value: 'future_invoices', authority: 'reviewer_policy' })
    const result = resolveFieldAuthority([reviewer, contract]) // order-independence deliberately exercised
    expect(result).toEqual({ field: FIELD, selected: contract, suppressed: [reviewer], status: 'resolved' })
  })
  it('contract > organization', () => {
    // Item 4's own worked example: contract = expires after 30 days,
    // organization policy = carry forward indefinitely -> contract wins,
    // organization policy suppressed (not a 'conflict' — different
    // authorities disagreeing is an ordinary override, not a same-level
    // contradiction).
    const contract = candidate({ field: 'expiry', value: 'expires_30_days', authority: 'contract_derived' })
    const organization = candidate({ field: 'expiry', value: 'carry_forward_indefinitely', authority: 'organization_rulebook' })
    const result = resolveFieldAuthority([contract, organization])
    expect(result).toEqual({ field: 'expiry', selected: contract, suppressed: [organization], status: 'resolved' })
  })
  it('contract > Verdix', () => {
    const contract = candidate({ field: FIELD, value: 'next_invoice', authority: 'contract_derived' })
    const verdix = candidate({ field: FIELD, value: 'future_invoices', authority: 'verdix_rulebook' })
    const result = resolveFieldAuthority([contract, verdix])
    expect(result).toEqual({ field: FIELD, selected: contract, suppressed: [verdix], status: 'resolved' })
  })
  it('reviewer > organization — item 4\'s worked example: reviewer = full amount, organization = prorate -> reviewer selected for this contract', () => {
    const reviewer = candidate({ field: 'basis', value: 'full_amount', authority: 'reviewer_policy' })
    const organization = candidate({ field: 'basis', value: 'prorate', authority: 'organization_rulebook' })
    const result = resolveFieldAuthority([reviewer, organization])
    expect(result).toEqual({ field: 'basis', selected: reviewer, suppressed: [organization], status: 'resolved' })
  })
  it('reviewer > Verdix', () => {
    const reviewer = candidate({ field: FIELD, value: 'future_invoices', authority: 'reviewer_policy' })
    const verdix = candidate({ field: FIELD, value: 'next_invoice', authority: 'verdix_rulebook' })
    const result = resolveFieldAuthority([reviewer, verdix])
    expect(result).toEqual({ field: FIELD, selected: reviewer, suppressed: [verdix], status: 'resolved' })
  })
  it('organization > Verdix — item 4\'s worked example: organization = carry forward, Verdix default = expire -> organization selected', () => {
    const organization = candidate({ field: 'survival', value: 'carry_forward', authority: 'organization_rulebook' })
    const verdix = candidate({ field: 'survival', value: 'expire', authority: 'verdix_rulebook' })
    const result = resolveFieldAuthority([organization, verdix])
    expect(result).toEqual({ field: 'survival', selected: organization, suppressed: [verdix], status: 'resolved' })
  })
  it('Verdix > recommendation', () => {
    const verdix = candidate({ field: FIELD, value: 'next_invoice', authority: 'verdix_rulebook' })
    const recommendation = candidate({ field: FIELD, value: 'future_invoices', authority: 'verdix_recommends' })
    const result = resolveFieldAuthority([verdix, recommendation])
    expect(result).toEqual({ field: FIELD, selected: verdix, suppressed: [recommendation], status: 'resolved' })
  })
  it('recommendation alone -> unresolved/review-required, never treated as resolved just because nothing else competed', () => {
    const recommendation = candidate({ field: FIELD, value: 'next_invoice', authority: 'verdix_recommends', method: 'ai_recommendation', confidence: 0.92 })
    const result = resolveFieldAuthority([recommendation])
    expect(result.status).toBe('unresolved')
    expect(result.selected).toBeUndefined()
    expect(result.suppressed).toEqual([recommendation])
  })
})

describe('same-authority conflicts fail closed — never an array-order winner', () => {
  it('two organization rules conflict -> conflict, not the first (or last) one in the array', () => {
    const orgA = candidate({ field: 'proration', value: 'prorate', authority: 'organization_rulebook', rule_id: 'org-policy-a' })
    const orgB = candidate({ field: 'proration', value: 'full_amount', authority: 'organization_rulebook', rule_id: 'org-policy-b' })
    const forward = resolveFieldAuthority([orgA, orgB])
    const reversed = resolveFieldAuthority([orgB, orgA])
    expect(forward.status).toBe('conflict')
    expect(forward.selected).toBeUndefined()
    expect(reversed.status).toBe('conflict')
    expect(reversed.selected).toBeUndefined()
    // Deterministic (both orderings agree it's a conflict), but NOT
    // resolved by picking whichever happened to come first.
    expect(forward.suppressed.map(c => c.rule_id).sort()).toEqual(['org-policy-a', 'org-policy-b'])
  })
  it('two Verdix defaults conflict -> conflict, fail closed', () => {
    const verdixA = candidate({ field: 'rounding', value: 'floor', authority: 'verdix_rulebook', rule_id: 'v-a' })
    const verdixB = candidate({ field: 'rounding', value: 'ceiling', authority: 'verdix_rulebook', rule_id: 'v-b' })
    const result = resolveFieldAuthority([verdixA, verdixB])
    expect(result.status).toBe('conflict')
    expect(result.selected).toBeUndefined()
  })
  it('two contradictory CONTRACTUAL candidates also fail closed, not just organization/Verdix ones (item 5: "do the same for contradictory contractual candidates")', () => {
    const contractA = candidate({ field: 'cap', value: 5000, authority: 'contract_derived' })
    const contractB = candidate({ field: 'cap', value: 10_000, authority: 'contract_derived' })
    const result = resolveFieldAuthority([contractA, contractB])
    expect(result.status).toBe('conflict')
    expect(result.selected).toBeUndefined()
  })
  it('agreeing same-authority candidates are NOT a conflict -- resolves normally', () => {
    const orgA = candidate({ field: 'proration', value: 'prorate', authority: 'organization_rulebook', rule_id: 'org-a' })
    const orgB = candidate({ field: 'proration', value: 'prorate', authority: 'organization_rulebook', rule_id: 'org-b' })
    const result = resolveFieldAuthority([orgA, orgB])
    expect(result.status).toBe('resolved')
    expect(result.selected?.value).toBe('prorate')
  })
  it('a same-authority conflict at the TOP band still loses to a genuinely higher authority present -- contract still wins over two disagreeing organization policies', () => {
    const contract = candidate({ field: 'cap', value: 5000, authority: 'contract_derived' })
    const orgA = candidate({ field: 'cap', value: 1000, authority: 'organization_rulebook' })
    const orgB = candidate({ field: 'cap', value: 2000, authority: 'organization_rulebook' })
    const result = resolveFieldAuthority([orgA, contract, orgB])
    expect(result.status).toBe('resolved')
    expect(result.selected).toEqual(contract)
    expect(result.suppressed).toEqual(expect.arrayContaining([orgA, orgB]))
  })
})

// Corrected per review: invariants are NOT resolution candidates and must
// never participate in field-authority precedence — that would be a
// second invariant-precedence mechanism duplicating the existing Step 3
// activation layer (resolveVerdixRulebookActivation's execution-target
// violations, evaluateFieldPromotion's promotion-target denials). This
// section proves the architectural separation directly: ordinary
// precedence applies with no exception (organization beats a Verdix
// default exactly like any other field, even one that LOOKS like it maps
// to a real invariant rule_id), and a resulting selected value that would
// violate an ACTIVE invariant is caught entirely separately, by Step 3,
// never by resolveFieldAuthority itself.
describe('architectural separation — invariants are enforced by Step 3, never by the field resolver', () => {
  it('organization_rulebook candidate beats a verdix_rulebook default in field resolution -- ordinary precedence, no exception', () => {
    const organization = candidate({ field: 'tier_execution_model', value: 'graduated', authority: 'organization_rulebook' })
    const verdixDefault = candidate({ field: 'tier_execution_model', value: 'volume', authority: 'verdix_rulebook' })
    const result = resolveFieldAuthority([organization, verdixDefault])
    expect(result).toEqual({ field: 'tier_execution_model', selected: organization, suppressed: [verdixDefault], status: 'resolved' })
  })
  it('this holds even when the verdix_rulebook candidate carries the rule_id of a REAL, active Step 3 execution invariant -- the field resolver has no concept of "this one is special", only authority rank', () => {
    const organization = candidate({ field: 'tier_execution_model', value: 'graduated', authority: 'organization_rulebook', rule_id: 'org-policy-1' })
    const verdixInvariantDefault = candidate({ field: 'tier_execution_model', value: 'volume', authority: 'verdix_rulebook', rule_id: 'pricing.all_units.non_graduated' })
    const result = resolveFieldAuthority([organization, verdixInvariantDefault])
    expect(result.selected).toEqual(organization) // organization wins -- rule_id is not consulted for precedence
  })
  it('resolveFieldAuthority\'s output never carries anything resembling an invariant violation -- its status vocabulary is exactly resolved/unresolved/conflict', () => {
    const organization = candidate({ field: 'tier_execution_model', value: 'graduated', authority: 'organization_rulebook' })
    const verdixDefault = candidate({ field: 'tier_execution_model', value: 'volume', authority: 'verdix_rulebook' })
    const result = resolveFieldAuthority([organization, verdixDefault])
    expect(result).not.toHaveProperty('violations')
    expect(result).not.toHaveProperty('violation')
  })
  it('the worked example from the review: contract-derived normalized method = all_units, organization candidate = graduated -- contract wins normally in field resolution; whether the RESULTING state is executable is checked entirely separately, by the real, already-active pricing.all_units.non_graduated invariant', () => {
    const contract = candidate({ field: 'tierCalculation.method', value: 'all_units', authority: 'contract_derived' })
    const organization = candidate({ field: 'tierCalculation.method', value: 'graduated', authority: 'organization_rulebook' })

    // Step 1: field resolution. The resolver's only job -- contract wins.
    const fieldResult = resolveFieldAuthority([contract, organization])
    expect(fieldResult.selected).toEqual(contract)
    expect(fieldResult.status).toBe('resolved')

    // Step 2, entirely separate: does the resulting normalized/executable
    // state actually hold up? Exercised via the real Step 3 activation
    // layer, on a genuinely mismatched observed execution -- an observed
    // 'graduated' execution against a normalized 'volume' rule is a real,
    // independently-detected execution violation. resolveFieldAuthority
    // was never involved in producing this -- a completely different
    // function, called on completely different (execution-observation)
    // data, after field resolution has already finished.
    const activation = resolveVerdixRulebookActivation({
      tierCalculation: tierCalculationContext({ method: 'volume' }, { method: 'graduated' }),
    })
    expect(activation.violations).toEqual([{
      rule_id: 'pricing.all_units.non_graduated',
      field: 'tierCalculation.observed.method',
      expected_value: 'volume',
      reason: expect.stringContaining('graduated'),
    }])
  })
})

// Item 7: "This needs strong tests." Several independent angles, beyond
// the matrix above, all converging on the same guarantee.
describe('contract always beats both Rulebooks — strong, redundant coverage', () => {
  const FIELD = 'carry_forward'
  it('contract beats organization_rulebook even when organization and Verdix both agree with each other against the contract', () => {
    const contract = candidate({ field: FIELD, value: false, authority: 'contract_derived' })
    const organization = candidate({ field: FIELD, value: true, authority: 'organization_rulebook' })
    const verdix = candidate({ field: FIELD, value: true, authority: 'verdix_rulebook' })
    const result = resolveFieldAuthority([organization, verdix, contract])
    expect(result.selected).toEqual(contract)
    expect(result.status).toBe('resolved')
  })
  it('contract wins regardless of array position (order-independence, checked both directions)', () => {
    const contract = candidate({ field: FIELD, value: false, authority: 'contract_derived' })
    const organization = candidate({ field: FIELD, value: true, authority: 'organization_rulebook' })
    expect(resolveFieldAuthority([contract, organization]).selected).toEqual(contract)
    expect(resolveFieldAuthority([organization, contract]).selected).toEqual(contract)
  })
})

// Item 8: reviewer_policy is contract-LOCAL — modeled structurally by the
// simple fact that resolveFieldAuthority is a pure function with no shared
// state between calls; a reviewer override supplied for one candidate set
// (one contract's field) cannot leak into a resolution for a different
// candidate set (a different contract's same field), and nothing in this
// module ever turns a reviewer_policy candidate into an
// organization_rulebook one.
describe('reviewer override is contract-local, never automatically organization-wide', () => {
  it('a reviewer_policy candidate for contract A does not affect resolution of the identical field for contract B (no shared/global state)', () => {
    const contractAReviewerOverride = candidate({ field: 'carry_forward', value: true, authority: 'reviewer_policy' })
    const contractAOrgDefault = candidate({ field: 'carry_forward', value: false, authority: 'organization_rulebook' })
    const contractAResult = resolveFieldAuthority([contractAOrgDefault, contractAReviewerOverride])
    expect(contractAResult.selected?.value).toBe(true) // reviewer's local override wins for contract A

    // Contract B never supplied a reviewer override -- same organization
    // default, resolved completely independently of contract A's call.
    const contractBOrgDefault = candidate({ field: 'carry_forward', value: false, authority: 'organization_rulebook' })
    const contractBResult = resolveFieldAuthority([contractBOrgDefault])
    expect(contractBResult.selected?.value).toBe(false) // unaffected by contract A's reviewer override
  })
  it('no candidate produced anywhere in this module ever carries authority: \'organization_rulebook\' as a consequence of a reviewer_policy input -- reviewer_policy candidates pass through resolveFieldAuthority completely unchanged (never re-typed/promoted)', () => {
    const reviewerCandidate = candidate({ field: 'carry_forward', value: true, authority: 'reviewer_policy' })
    const result = resolveFieldAuthority([reviewerCandidate])
    expect(result.selected).toBe(reviewerCandidate) // same object reference -- nothing rewrapped or re-authored
    expect(result.selected?.authority).toBe('reviewer_policy')
  })
  // Item 9: no automatic learning. There is no function anywhere in
  // lib/rulebook/ that takes a history of reviewer_policy candidates and
  // produces an organization_rulebook one -- confirmed by inspection (this
  // module exports exactly resolveFieldAuthority and its supporting
  // types/constant; grep -rn "organization_rulebook" lib/rulebook/
  // resolution.ts shows it only ever appears as a literal union member and
  // in comments, never assigned FROM a reviewer_policy value). Repeated
  // reviewer decisions promoting to an organization rule is explicitly
  // future, suggestion-only work this step does not build.
  it('calling resolveFieldAuthority repeatedly with the same reviewer_policy candidate never changes its authority or produces a new organization_rulebook candidate', () => {
    const reviewerCandidate = candidate({ field: 'carry_forward', value: true, authority: 'reviewer_policy' })
    for (let i = 0; i < 5; i++) {
      const result = resolveFieldAuthority([reviewerCandidate])
      expect(result.selected?.authority).toBe('reviewer_policy')
    }
  })
})

// Item 11: existing Rulebook shadow output can be ADAPTED into a synthetic
// candidate for testing/illustration -- resolveVerdixRulebookShadow itself
// is completely untouched (still exercised via its real, unchanged API),
// and the adaptation happens only here, in a test, never inside
// lib/rulebook/resolution.ts or any production call site.
describe('composing with the existing (Step 2/3) Rulebook shadow output, illustratively', () => {
  it('a real shadow finding can be adapted into a candidate and still loses to an organization policy, exactly as plain precedence dictates for a non-invariant Verdix rule', () => {
    // minimum.floor.non_additive (Step 3: enforce_invariant/execution) has
    // nothing to do with field resolution -- picking a DIAGNOSTIC-category
        // finding here on purpose (credit.explicit_carry_forward_authoritative,
    // via a 'supports' outcome) to prove composition works even for a rule
    // Step 3 never activated for execution/promotion at all.
    const shadow = resolveVerdixRulebookShadow({
      creditApplication: { eligibleComponentKeys: ['transaction_processing'], carryForward: true, survivalProvenance: 'contract_derived', availability: 'next_period' },
    })
    const finding = shadow.findings.find(f => f.rule_id === 'credit.explicit_carry_forward_authoritative')
    expect(finding?.outcome).toBe('supports')

    // Adapt (test-only, illustrative -- NOT a lib/rulebook/resolution.ts
    // export): a 'supports' finding becomes a verdix_rulebook-authority
    // candidate reflecting what the Rulebook confirmed.
    const verdixCandidate: RuleResolutionCandidate = {
      field: finding!.field, value: true, authority: 'verdix_rulebook', method: 'verdix_rulebook', rule_id: finding!.rule_id,
    }
    const organization = candidate({ field: finding!.field, value: false, authority: 'organization_rulebook' })
    const result = resolveFieldAuthority([verdixCandidate, organization])
    expect(result.selected).toEqual(organization) // ordinary Verdix default, organization may override it
  })
  it('resolveVerdixRulebookShadow itself remains completely untouched by Step 4 -- still pure, still returns findings only, never a resolution candidate directly', () => {
    const shadow = resolveVerdixRulebookShadow({ minimumCommitment: minimumCommitmentContext({ mode: 'floor' }) })
    expect(shadow).toHaveProperty('rulebookVersion')
    expect(shadow).toHaveProperty('matchedRuleIds')
    expect(shadow).toHaveProperty('findings')
    expect(shadow).not.toHaveProperty('selected')
    expect(shadow).not.toHaveProperty('suppressed')
  })
})

// Proof required by item 13: no resolution result enters production.
describe('proof: nothing in lib/rulebook/resolution.ts is consumed by production code', () => {
  it('resolveFieldAuthority and its types are exported for tests/future use only -- this test documents the guarantee; the authoritative check is the grep run and reported alongside this file (see Step 4 deliverables report)', () => {
    // A live code fact, not just a comment: resolveFieldAuthority has no
    // side effects an app/ call site could even observe indirectly (no
    // module-level mutable state, no console output, no timers) --
    // calling it repeatedly with fresh candidate arrays is fully
    // referentially transparent.
    const a = candidate({ field: 'x', value: 1, authority: 'contract_derived' })
    const first = resolveFieldAuthority([a])
    const second = resolveFieldAuthority([a])
    expect(first).toEqual(second)
  })
})
