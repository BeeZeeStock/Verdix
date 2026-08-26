import { describe, it, expect } from 'vitest'
import {
  validateEvidenceFacts, isEvidenceActiveAsOf, pinQualificationRuleVersion,
  resolveCandidateFact, evaluateQualificationExpression, evaluateCandidateCriteria, evaluateDedupeObservation,
  evaluateCandidateEvidenceSnapshot,
  type BillableUnitCandidate, type CandidateUnitEvidence,
} from './billable-unit-candidate'
import { confirmQualificationRuleField, isQualificationRuleReady, type BillableUnitQualificationRule, type QualificationExpression, type QualificationFactDefinition } from './billable-unit-qualification'
import { buildOs202609Rule } from './os-2026-09-fixture'

// ═══════════════════════════════════════════════════════════════════════════
// Generic fixtures — a minimal rule/candidate/evidence trio, independent of
// OS-2026-09, for testing the resolution/evaluation mechanics in isolation.
// ═══════════════════════════════════════════════════════════════════════════
function makeMinimalRule(overrides?: Partial<BillableUnitQualificationRule>): BillableUnitQualificationRule {
  const factSchema: Record<string, QualificationFactDefinition> = {
    amount: { type: 'number', reference_time: 'occurred_at' },
    flag: { type: 'boolean', reference_time: 'occurred_at' },
    role: { type: 'enum', enumValues: ['A', 'B', 'C'], reference_time: 'occurred_at' },
  }
  return {
    id: 'rule-generic', job_id: 'job-generic', org_id: 'org-generic', unit_type: 'GENERIC',
    fact_schema: factSchema,
    criteria: { value: { kind: 'condition', condition: { field: 'amount', operator: 'gte', value: 10 } }, state: 'clear_from_source', provenance: 'contract_derived' },
    qualified_contact_role: {
      base: { value: { field: 'role', operator: 'in', value: ['A', 'B'] }, state: 'clear_from_source', provenance: 'contract_derived' },
      extensions: { value: [], state: 'decision_required', provenance: null },
      attestation_fact_key: { value: null, state: 'decision_required', provenance: 'reviewer_policy' },
    },
    dedupe_rule: { value: { key_fields: ['amount'], lookback: { days: 30, unit: 'calendar' }, scope: [], discovery_coverage_role_keys: [] }, state: 'clear_from_source', provenance: 'contract_derived' },
    rejection_rule: { value: { valid_reasons: [], valid_channels: [], requires_timestamp: true, requires_identification: true, email_alone_valid: false, channel_exception: null, late_rejection_behavior: 'ignored_for_initial_qualification', reason_predicates: {} }, state: 'clear_from_source', provenance: 'contract_derived' },
    rejection_window: { value: { business_days: 3, holiday_calendar: 'SE-stockholm', timezone: 'Europe/Stockholm', reference_time: 'occurred_at' }, state: 'clear_from_source', provenance: 'contract_derived' },
    deadline_convention: { value: 'end_of_business_day', state: 'decision_required', provenance: 'reviewer_policy' },
    business_day_end_local_time: { value: '17:00:00', state: 'decision_required', provenance: 'reviewer_policy' },
    attribution_basis: { value: 'occurred_at', state: 'verdix_recommends', provenance: 'reviewer_policy' },
    evidence_precedence: {},
    fact_evidence_source_roles: {},
    field_sources: {},
    version: 1, revision: 1, supersedes_rule_id: null,
    effective_from: '2026-01-01T00:00:00Z', effective_to: null, status: 'active',
    ...overrides,
  }
}

function makeGenericCandidate(overrides?: Partial<BillableUnitCandidate>): BillableUnitCandidate {
  return {
    id: 'cand-generic', job_id: 'job-generic', org_id: 'org-generic', unit_type: 'GENERIC',
    external_identity: { source_binding_id: 'binding-x', external_id: 'ext-1' },
    booked_at: '2026-01-01T00:00:00Z', occurred_at: '2026-01-10T00:00:00Z', attribution_at: '2026-01-10T00:00:00Z',
    qualification_rule_id: 'rule-generic', qualification_rule_version: 1,
    rejection_deadline: null, status: 'pending', decided_at: null,
    ...overrides,
  }
}

function makeGenericEvidence(overrides: Partial<CandidateUnitEvidence> & { id: string; source_binding_id: string; facts: Record<string, unknown>; occurred_at: string }): CandidateUnitEvidence {
  return {
    candidate_id: 'cand-generic', job_id: 'job-generic', org_id: 'org-generic',
    recorded_at: overrides.occurred_at, recorded_by: 'test-harness', status: 'active', revoked_at: null, revoked_by: null,
    ...overrides,
  }
}

// ── validateEvidenceFacts ─────────────────────────────────────────────────
describe('validateEvidenceFacts', () => {
  const factSchema: Record<string, QualificationFactDefinition> = {
    name: { type: 'string', reference_time: 'occurred_at' },
    amount: { type: 'number', reference_time: 'occurred_at' },
    active: { type: 'boolean', reference_time: 'occurred_at' },
    when: { type: 'timestamp', reference_time: 'occurred_at' },
    tier: { type: 'enum', enumValues: ['gold', 'silver'], reference_time: 'occurred_at' },
  }

  it('accepts a partial, well-typed fact set — evidence routinely reports a subset of declared facts', () => {
    expect(validateEvidenceFacts({ name: 'x', amount: 5 }, factSchema)).toEqual([])
  })
  it('rejects an undeclared fact key', () => {
    const errors = validateEvidenceFacts({ bogus: 1 }, factSchema)
    expect(errors.some(e => e.reason.includes('undeclared'))).toBe(true)
  })
  it('rejects wrong primitive types', () => {
    expect(validateEvidenceFacts({ amount: 'not-a-number' }, factSchema).length).toBeGreaterThan(0)
    expect(validateEvidenceFacts({ active: 'yes' }, factSchema).length).toBeGreaterThan(0)
    expect(validateEvidenceFacts({ name: 123 }, factSchema).length).toBeGreaterThan(0)
  })
  it('rejects an invalid enum value and accepts a valid one', () => {
    expect(validateEvidenceFacts({ tier: 'bronze' }, factSchema).length).toBeGreaterThan(0)
    expect(validateEvidenceFacts({ tier: 'gold' }, factSchema)).toEqual([])
  })
  it('rejects a malformed timestamp and accepts a valid one', () => {
    expect(validateEvidenceFacts({ when: 'not-a-date' }, factSchema).length).toBeGreaterThan(0)
    expect(validateEvidenceFacts({ when: '2026-01-01T00:00:00Z' }, factSchema)).toEqual([])
  })
})

// ── isEvidenceActiveAsOf ─────────────────────────────────────────────────
describe('isEvidenceActiveAsOf', () => {
  it('not yet recorded at asOf -> inactive', () => {
    const e = makeGenericEvidence({ id: 'e1', source_binding_id: 'binding-x', facts: {}, occurred_at: '2026-01-01T00:00:00Z', recorded_at: '2026-01-05T00:00:00Z' })
    expect(isEvidenceActiveAsOf(e, '2026-01-01T00:00:00Z')).toBe(false)
  })
  it('recorded, never revoked -> active at any later asOf', () => {
    const e = makeGenericEvidence({ id: 'e1', source_binding_id: 'binding-x', facts: {}, occurred_at: '2026-01-01T00:00:00Z', recorded_at: '2026-01-01T00:00:00Z' })
    expect(isEvidenceActiveAsOf(e, '2030-01-01T00:00:00Z')).toBe(true)
  })
})

// ── pinQualificationRuleVersion ──────────────────────────────────────────
describe('pinQualificationRuleVersion', () => {
  it('no_match when no rule version covers the derivable attribution time', () => {
    const rule = makeMinimalRule({ effective_from: '2026-06-01T00:00:00Z', effective_to: null })
    const result = pinQualificationRuleVersion({ booked_at: null, occurred_at: '2026-01-01T00:00:00Z' }, [rule])
    expect(result.status).toBe('no_match')
  })
  it('ignores draft rule versions entirely — a draft was never validated ready and can never govern a candidate', () => {
    const rule = makeMinimalRule({ status: 'draft', effective_from: '2026-01-01T00:00:00Z' })
    const result = pinQualificationRuleVersion({ booked_at: null, occurred_at: '2026-01-05T00:00:00Z' }, [rule])
    expect(result.status).toBe('no_match')
  })
  it('ambiguous when more than one rule version self-consistently matches — refuses to pick arbitrarily', () => {
    const v1 = makeMinimalRule({ id: 'r1', version: 1, effective_from: '2026-01-01T00:00:00Z', effective_to: null })
    const v2 = makeMinimalRule({ id: 'r2', version: 2, effective_from: '2026-01-01T00:00:00Z', effective_to: null })
    const result = pinQualificationRuleVersion({ booked_at: null, occurred_at: '2026-01-05T00:00:00Z' }, [v1, v2])
    expect(result.status).toBe('ambiguous')
  })
  it('defensively skips a rule version whose attribution_basis is not resolved (should never happen for an active/superseded row by construction)', () => {
    const rule = makeMinimalRule({ attribution_basis: { value: 'occurred_at', state: 'verdix_recommends', provenance: null } })
    const result = pinQualificationRuleVersion({ booked_at: null, occurred_at: '2026-01-05T00:00:00Z' }, [rule])
    expect(result.status).toBe('no_match')
  })
  it('a single, correctly self-consistent match pins cleanly', () => {
    const rule = makeMinimalRule({ effective_from: '2026-01-01T00:00:00Z', effective_to: null })
    const result = pinQualificationRuleVersion({ booked_at: null, occurred_at: '2026-01-05T00:00:00Z' }, [rule])
    expect(result).toMatchObject({ status: 'pinned', ruleId: 'rule-generic', ruleVersion: 1, attribution_at: '2026-01-05T00:00:00Z' })
  })
  it("gives an explicit unsupported/unavailable reason — not a generic 'no match' — when every candidate rule version's basis is 'qualified_at'", () => {
    const rule = makeMinimalRule({ attribution_basis: { value: 'qualified_at', state: 'verdix_recommends', provenance: 'reviewer_policy' } })
    const result = pinQualificationRuleVersion({ booked_at: '2026-01-01T00:00:00Z', occurred_at: '2026-01-05T00:00:00Z' }, [rule])
    expect(result.status).toBe('no_match')
    expect(result.status === 'no_match' && result.reason).toMatch(/unsupported.*qualified_at.*16B\.3/)
  })
  it('still gives the generic reason when the no_match is for an unrelated cause (mixed bases, none of which cover the time range)', () => {
    const occurredBasis = makeMinimalRule({ id: 'r-occurred', effective_from: '2026-06-01T00:00:00Z' })
    const result = pinQualificationRuleVersion({ booked_at: null, occurred_at: '2026-01-01T00:00:00Z' }, [occurredBasis])
    expect(result.status).toBe('no_match')
    expect(result.status === 'no_match' && result.reason).not.toMatch(/unsupported/)
  })
})

// ── resolveCandidateFact — evidence-precedence strategies ────────────────
describe('resolveCandidateFact — evidence-precedence strategies', () => {
  const candidate = makeGenericCandidate()
  const roleKeys = new Map([['binding-x', 'crm'], ['binding-y', 'enrichment']])

  it('authoritative_source: resolves to the named source when it has an eligible observation', () => {
    const rule = makeMinimalRule({ evidence_precedence: { amount: { value: { kind: 'authoritative_source', source: 'crm' }, state: 'clear_from_source', provenance: 'contract_derived' } } })
    const crm = makeGenericEvidence({ id: 'e1', source_binding_id: 'binding-x', facts: { amount: 42 }, occurred_at: '2026-01-05T00:00:00Z' })
    const enrich = makeGenericEvidence({ id: 'e2', source_binding_id: 'binding-y', facts: { amount: 99 }, occurred_at: '2026-01-05T00:00:00Z' })
    const result = resolveCandidateFact({ candidate, rule, factKey: 'amount', evidence: [crm, enrich], sourceBindingRoleKeys: roleKeys, asOf: '2026-01-11T00:00:00Z' })
    expect(result).toMatchObject({ status: 'resolved', value: 42, sourceRoleKey: 'crm' })
  })

  it('authoritative_source: unresolved when the named source has no eligible observation, even if another source does', () => {
    const rule = makeMinimalRule({ evidence_precedence: { amount: { value: { kind: 'authoritative_source', source: 'crm' }, state: 'clear_from_source', provenance: 'contract_derived' } } })
    const enrich = makeGenericEvidence({ id: 'e2', source_binding_id: 'binding-y', facts: { amount: 99 }, occurred_at: '2026-01-05T00:00:00Z' })
    const result = resolveCandidateFact({ candidate, rule, factKey: 'amount', evidence: [enrich], sourceBindingRoleKeys: roleKeys, asOf: '2026-01-11T00:00:00Z' })
    expect(result.status).toBe('unresolved')
  })

  it('source_precedence: the first source in order with an eligible observation wins, regardless of conflict', () => {
    const rule = makeMinimalRule({ evidence_precedence: { amount: { value: { kind: 'source_precedence', order: ['enrichment', 'crm'] }, state: 'clear_from_source', provenance: 'contract_derived' } } })
    const crm = makeGenericEvidence({ id: 'e1', source_binding_id: 'binding-x', facts: { amount: 42 }, occurred_at: '2026-01-05T00:00:00Z' })
    const enrich = makeGenericEvidence({ id: 'e2', source_binding_id: 'binding-y', facts: { amount: 99 }, occurred_at: '2026-01-05T00:00:00Z' })
    const result = resolveCandidateFact({ candidate, rule, factKey: 'amount', evidence: [crm, enrich], sourceBindingRoleKeys: roleKeys, asOf: '2026-01-11T00:00:00Z' })
    expect(result).toMatchObject({ status: 'resolved', value: 99, sourceRoleKey: 'enrichment' })
  })

  it('point-in-time selection is per-source, applied BEFORE precedence — a higher-priority source\'s older observation is never displaced by a lower-priority source\'s newer one', () => {
    // Exact scenario from the pre-commit hardening audit: CRM observed 2
    // days before the reference time, enrichment observed only 1 hour
    // before it (i.e. enrichment's observation is objectively NEWER/
    // closer to the reference moment) — but precedence = [crm,
    // enrichment] must still pick CRM. If Verdix ever globally selected
    // "the newest evidence across all sources" before applying
    // precedence, enrichment's fresher row would wrongly erase CRM's
    // observation from consideration entirely.
    const rule = makeMinimalRule({ evidence_precedence: { amount: { value: { kind: 'source_precedence', order: ['crm', 'enrichment'] }, state: 'clear_from_source', provenance: 'contract_derived' } } })
    const crm = makeGenericEvidence({ id: 'e1', source_binding_id: 'binding-x', facts: { amount: 42 }, occurred_at: '2026-01-08T00:00:00Z' })       // 2 days before the 2026-01-10 reference
    const enrich = makeGenericEvidence({ id: 'e2', source_binding_id: 'binding-y', facts: { amount: 99 }, occurred_at: '2026-01-09T23:00:00Z' })    // 1 hour before — objectively newer
    const result = resolveCandidateFact({ candidate, rule, factKey: 'amount', evidence: [crm, enrich], sourceBindingRoleKeys: roleKeys, asOf: '2026-01-11T00:00:00Z' })
    expect(result).toMatchObject({ status: 'resolved', value: 42, sourceRoleKey: 'crm' })
  })

  it('source_precedence: falls back to a lower-priority source when the higher-priority one is absent', () => {
    const rule = makeMinimalRule({ evidence_precedence: { amount: { value: { kind: 'source_precedence', order: ['enrichment', 'crm'] }, state: 'clear_from_source', provenance: 'contract_derived' } } })
    const crm = makeGenericEvidence({ id: 'e1', source_binding_id: 'binding-x', facts: { amount: 42 }, occurred_at: '2026-01-05T00:00:00Z' })
    const result = resolveCandidateFact({ candidate, rule, factKey: 'amount', evidence: [crm], sourceBindingRoleKeys: roleKeys, asOf: '2026-01-11T00:00:00Z' })
    expect(result).toMatchObject({ status: 'resolved', value: 42, sourceRoleKey: 'crm' })
  })

  it('authoritative_if_fresh_else_latest: uses the authoritative source when fresh', () => {
    const rule = makeMinimalRule({ evidence_precedence: { amount: { value: { kind: 'authoritative_if_fresh_else_latest', source: 'crm', freshness_window_days: 90 }, state: 'clear_from_source', provenance: 'contract_derived' } } })
    const crm = makeGenericEvidence({ id: 'e1', source_binding_id: 'binding-x', facts: { amount: 42 }, occurred_at: '2026-01-01T00:00:00Z' })
    const result = resolveCandidateFact({ candidate, rule, factKey: 'amount', evidence: [crm], sourceBindingRoleKeys: roleKeys, asOf: '2026-01-11T00:00:00Z' })
    expect(result).toMatchObject({ status: 'resolved', value: 42, sourceRoleKey: 'crm' })
  })

  it('authoritative_if_fresh_else_latest: falls back to the freshest OTHER source when the authoritative one is stale', () => {
    const rule = makeMinimalRule({ evidence_precedence: { amount: { value: { kind: 'authoritative_if_fresh_else_latest', source: 'crm', freshness_window_days: 5 }, state: 'clear_from_source', provenance: 'contract_derived' } } })
    const staleCrm = makeGenericEvidence({ id: 'e1', source_binding_id: 'binding-x', facts: { amount: 42 }, occurred_at: '2025-01-01T00:00:00Z' })
    const freshEnrich = makeGenericEvidence({ id: 'e2', source_binding_id: 'binding-y', facts: { amount: 99 }, occurred_at: '2026-01-09T00:00:00Z' })
    const result = resolveCandidateFact({ candidate, rule, factKey: 'amount', evidence: [staleCrm, freshEnrich], sourceBindingRoleKeys: roleKeys, asOf: '2026-01-11T00:00:00Z' })
    expect(result).toMatchObject({ status: 'resolved', value: 99, sourceRoleKey: 'enrichment' })
  })

  it('authoritative_if_fresh_else_latest: explicit tie semantics — two equally-fresh, conflicting fallback sources resolve unresolved, never arbitrarily', () => {
    const rule = makeMinimalRule({ evidence_precedence: { amount: { value: { kind: 'authoritative_if_fresh_else_latest', source: 'crm', freshness_window_days: 1 }, state: 'clear_from_source', provenance: 'contract_derived' } } })
    const staleCrm = makeGenericEvidence({ id: 'e1', source_binding_id: 'binding-x', facts: { amount: 42 }, occurred_at: '2025-01-01T00:00:00Z' })
    const tie1 = makeGenericEvidence({ id: 'e2', source_binding_id: 'binding-y', facts: { amount: 99 }, occurred_at: '2026-01-09T00:00:00Z' })
    const tie2 = makeGenericEvidence({ id: 'e3', source_binding_id: 'binding-z', facts: { amount: 77 }, occurred_at: '2026-01-09T00:00:00Z' })
    const roleKeysWithThird = new Map([...roleKeys, ['binding-z', 'thirdparty']])
    const result = resolveCandidateFact({ candidate, rule, factKey: 'amount', evidence: [staleCrm, tie1, tie2], sourceBindingRoleKeys: roleKeysWithThird, asOf: '2026-01-11T00:00:00Z' })
    expect(result.status).toBe('unresolved')
  })

  it('no evidence_precedence configured: resolves when all eligible sources agree', () => {
    const rule = makeMinimalRule()
    const a = makeGenericEvidence({ id: 'e1', source_binding_id: 'binding-x', facts: { amount: 42 }, occurred_at: '2026-01-05T00:00:00Z' })
    const b = makeGenericEvidence({ id: 'e2', source_binding_id: 'binding-y', facts: { amount: 42 }, occurred_at: '2026-01-05T00:00:00Z' })
    const result = resolveCandidateFact({ candidate, rule, factKey: 'amount', evidence: [a, b], sourceBindingRoleKeys: roleKeys, asOf: '2026-01-11T00:00:00Z' })
    expect(result).toMatchObject({ status: 'resolved', value: 42 })
  })

  it('no evidence_precedence configured: unresolved (conflict) when sources disagree — never picks arbitrarily', () => {
    const rule = makeMinimalRule()
    const a = makeGenericEvidence({ id: 'e1', source_binding_id: 'binding-x', facts: { amount: 42 }, occurred_at: '2026-01-05T00:00:00Z' })
    const b = makeGenericEvidence({ id: 'e2', source_binding_id: 'binding-y', facts: { amount: 43 }, occurred_at: '2026-01-05T00:00:00Z' })
    const result = resolveCandidateFact({ candidate, rule, factKey: 'amount', evidence: [a, b], sourceBindingRoleKeys: roleKeys, asOf: '2026-01-11T00:00:00Z' })
    expect(result.status).toBe('unresolved')
  })

  it('point-in-time discipline: an observation strictly after the reference time is never used, even if it is the only evidence available', () => {
    const rule = makeMinimalRule()
    const future = makeGenericEvidence({ id: 'e1', source_binding_id: 'binding-x', facts: { amount: 42 }, occurred_at: '2026-02-01T00:00:00Z' })
    const result = resolveCandidateFact({ candidate, rule, factKey: 'amount', evidence: [future], sourceBindingRoleKeys: roleKeys, asOf: '2026-03-01T00:00:00Z' })
    expect(result.status).toBe('unresolved')
  })

  // ── Same-source, same-time conflict — must fail closed, never pick by
  // insertion/array order ─────────────────────────────────────────────
  describe('pathological case: one source, two active rows, identical eligible occurred_at, conflicting values', () => {
    it('authoritative_source: unresolved (conflict), never whichever row happened to be returned first', () => {
      const rule = makeMinimalRule({ evidence_precedence: { amount: { value: { kind: 'authoritative_source', source: 'crm' }, state: 'clear_from_source', provenance: 'contract_derived' } } })
      const rowA = makeGenericEvidence({ id: 'e1', source_binding_id: 'binding-x', facts: { amount: 42 }, occurred_at: '2026-01-05T00:00:00Z' })
      const rowB = makeGenericEvidence({ id: 'e2', source_binding_id: 'binding-x', facts: { amount: 99 }, occurred_at: '2026-01-05T00:00:00Z' })
      // Try both array orders — the outcome must not depend on which
      // came first in the input.
      const resultAB = resolveCandidateFact({ candidate, rule, factKey: 'amount', evidence: [rowA, rowB], sourceBindingRoleKeys: roleKeys, asOf: '2026-01-11T00:00:00Z' })
      const resultBA = resolveCandidateFact({ candidate, rule, factKey: 'amount', evidence: [rowB, rowA], sourceBindingRoleKeys: roleKeys, asOf: '2026-01-11T00:00:00Z' })
      expect(resultAB.status).toBe('unresolved')
      expect(resultBA.status).toBe('unresolved')
    })

    it('source_precedence: unresolved when the tie is on the highest-priority source — never silently falls through to a lower-priority source', () => {
      const rule = makeMinimalRule({ evidence_precedence: { amount: { value: { kind: 'source_precedence', order: ['crm', 'enrichment'] }, state: 'clear_from_source', provenance: 'contract_derived' } } })
      const rowA = makeGenericEvidence({ id: 'e1', source_binding_id: 'binding-x', facts: { amount: 42 }, occurred_at: '2026-01-05T00:00:00Z' })
      const rowB = makeGenericEvidence({ id: 'e2', source_binding_id: 'binding-x', facts: { amount: 99 }, occurred_at: '2026-01-05T00:00:00Z' })
      const enrich = makeGenericEvidence({ id: 'e3', source_binding_id: 'binding-y', facts: { amount: 7 }, occurred_at: '2026-01-05T00:00:00Z' })
      const result = resolveCandidateFact({ candidate, rule, factKey: 'amount', evidence: [rowA, rowB, enrich], sourceBindingRoleKeys: roleKeys, asOf: '2026-01-11T00:00:00Z' })
      // Must NOT resolve to enrichment's clean value 7 — that would
      // silently mask the higher-priority source's own conflict.
      expect(result.status).toBe('unresolved')
    })

    it('no evidence_precedence configured: unresolved (conflict), same rule as any other disagreement', () => {
      const rule = makeMinimalRule()
      const rowA = makeGenericEvidence({ id: 'e1', source_binding_id: 'binding-x', facts: { amount: 42 }, occurred_at: '2026-01-05T00:00:00Z' })
      const rowB = makeGenericEvidence({ id: 'e2', source_binding_id: 'binding-x', facts: { amount: 99 }, occurred_at: '2026-01-05T00:00:00Z' })
      const result = resolveCandidateFact({ candidate, rule, factKey: 'amount', evidence: [rowA, rowB], sourceBindingRoleKeys: roleKeys, asOf: '2026-01-11T00:00:00Z' })
      expect(result.status).toBe('unresolved')
    })

    it('two tied rows that AGREE on value is not a conflict at all — resolves normally', () => {
      const rule = makeMinimalRule({ evidence_precedence: { amount: { value: { kind: 'authoritative_source', source: 'crm' }, state: 'clear_from_source', provenance: 'contract_derived' } } })
      const rowA = makeGenericEvidence({ id: 'e1', source_binding_id: 'binding-x', facts: { amount: 42 }, occurred_at: '2026-01-05T00:00:00Z' })
      const rowB = makeGenericEvidence({ id: 'e2', source_binding_id: 'binding-x', facts: { amount: 42 }, occurred_at: '2026-01-05T00:00:00Z' })
      const result = resolveCandidateFact({ candidate, rule, factKey: 'amount', evidence: [rowA, rowB], sourceBindingRoleKeys: roleKeys, asOf: '2026-01-11T00:00:00Z' })
      expect(result).toMatchObject({ status: 'resolved', value: 42 })
    })

    it('if one of the two tied rows is revoked as of the evaluation time, the remaining row resolves normally — no conflict', () => {
      const rule = makeMinimalRule({ evidence_precedence: { amount: { value: { kind: 'authoritative_source', source: 'crm' }, state: 'clear_from_source', provenance: 'contract_derived' } } })
      const rowA = makeGenericEvidence({ id: 'e1', source_binding_id: 'binding-x', facts: { amount: 42 }, occurred_at: '2026-01-05T00:00:00Z' })
      const rowB = makeGenericEvidence({
        id: 'e2', source_binding_id: 'binding-x', facts: { amount: 99 }, occurred_at: '2026-01-05T00:00:00Z',
        status: 'revoked', revoked_at: '2026-01-06T00:00:00Z', revoked_by: 'reviewer-1',
      })
      // asOf AFTER rowB's revocation — only rowA is active, no conflict.
      const result = resolveCandidateFact({ candidate, rule, factKey: 'amount', evidence: [rowA, rowB], sourceBindingRoleKeys: roleKeys, asOf: '2026-01-11T00:00:00Z' })
      expect(result).toMatchObject({ status: 'resolved', value: 42, evidenceId: 'e1' })

      // asOf BEFORE rowB's revocation — both still active -> conflict.
      const resultEarlier = resolveCandidateFact({ candidate, rule, factKey: 'amount', evidence: [rowA, rowB], sourceBindingRoleKeys: roleKeys, asOf: '2026-01-05T12:00:00Z' })
      expect(resultEarlier.status).toBe('unresolved')
    })

    it('a tied conflict on a NON-nearest observation does not block resolution — only a tie at the actual nearest-eligible timestamp matters', () => {
      const rule = makeMinimalRule({ evidence_precedence: { amount: { value: { kind: 'authoritative_source', source: 'crm' }, state: 'clear_from_source', provenance: 'contract_derived' } } })
      // Two OLDER rows tie with each other but disagree — irrelevant,
      // since neither is nearest to the reference time.
      const older1 = makeGenericEvidence({ id: 'e1', source_binding_id: 'binding-x', facts: { amount: 1 }, occurred_at: '2026-01-01T00:00:00Z' })
      const older2 = makeGenericEvidence({ id: 'e2', source_binding_id: 'binding-x', facts: { amount: 2 }, occurred_at: '2026-01-01T00:00:00Z' })
      const nearest = makeGenericEvidence({ id: 'e3', source_binding_id: 'binding-x', facts: { amount: 42 }, occurred_at: '2026-01-08T00:00:00Z' })
      const result = resolveCandidateFact({ candidate, rule, factKey: 'amount', evidence: [older1, older2, nearest], sourceBindingRoleKeys: roleKeys, asOf: '2026-01-11T00:00:00Z' })
      expect(result).toMatchObject({ status: 'resolved', value: 42, evidenceId: 'e3' })
    })
  })
})

// ── evaluateQualificationExpression — tri-state semantics ────────────────
describe('evaluateQualificationExpression — tri-state semantics', () => {
  const candidate = makeGenericCandidate()
  const roleKeys = new Map([['binding-x', 'crm']])
  const rule = makeMinimalRule()

  it('all_of: any not_satisfied -> not_satisfied, even with an unknown sibling', () => {
    const evidence = [makeGenericEvidence({ id: 'e1', source_binding_id: 'binding-x', facts: { amount: 5 }, occurred_at: '2026-01-05T00:00:00Z' })]
    const expr: QualificationExpression = { kind: 'all_of', expressions: [
      { kind: 'condition', condition: { field: 'amount', operator: 'gte', value: 10 } },
      { kind: 'condition', condition: { field: 'flag', operator: 'eq', value: true } },
    ]}
    const { result } = evaluateQualificationExpression({ expr, candidate, rule, evidence, sourceBindingRoleKeys: roleKeys, asOf: '2026-01-11T00:00:00Z' })
    expect(result).toBe('not_satisfied')
  })

  it('all_of: no false, but an unknown present -> unknown', () => {
    const evidence = [makeGenericEvidence({ id: 'e1', source_binding_id: 'binding-x', facts: { amount: 20 }, occurred_at: '2026-01-05T00:00:00Z' })]
    const expr: QualificationExpression = { kind: 'all_of', expressions: [
      { kind: 'condition', condition: { field: 'amount', operator: 'gte', value: 10 } },
      { kind: 'condition', condition: { field: 'flag', operator: 'eq', value: true } },
    ]}
    const { result } = evaluateQualificationExpression({ expr, candidate, rule, evidence, sourceBindingRoleKeys: roleKeys, asOf: '2026-01-11T00:00:00Z' })
    expect(result).toBe('unknown')
  })

  it('all_of: everything satisfied -> satisfied', () => {
    const evidence = [makeGenericEvidence({ id: 'e1', source_binding_id: 'binding-x', facts: { amount: 20, flag: true }, occurred_at: '2026-01-05T00:00:00Z' })]
    const expr: QualificationExpression = { kind: 'all_of', expressions: [
      { kind: 'condition', condition: { field: 'amount', operator: 'gte', value: 10 } },
      { kind: 'condition', condition: { field: 'flag', operator: 'eq', value: true } },
    ]}
    const { result } = evaluateQualificationExpression({ expr, candidate, rule, evidence, sourceBindingRoleKeys: roleKeys, asOf: '2026-01-11T00:00:00Z' })
    expect(result).toBe('satisfied')
  })

  it('any_of: any satisfied -> satisfied, even with an unknown sibling', () => {
    const evidence = [makeGenericEvidence({ id: 'e1', source_binding_id: 'binding-x', facts: { amount: 20 }, occurred_at: '2026-01-05T00:00:00Z' })]
    const expr: QualificationExpression = { kind: 'any_of', expressions: [
      { kind: 'condition', condition: { field: 'amount', operator: 'gte', value: 10 } },
      { kind: 'condition', condition: { field: 'flag', operator: 'eq', value: true } },
    ]}
    const { result } = evaluateQualificationExpression({ expr, candidate, rule, evidence, sourceBindingRoleKeys: roleKeys, asOf: '2026-01-11T00:00:00Z' })
    expect(result).toBe('satisfied')
  })

  it('any_of: no satisfied, but an unknown present -> unknown', () => {
    const evidence = [makeGenericEvidence({ id: 'e1', source_binding_id: 'binding-x', facts: { amount: 5 }, occurred_at: '2026-01-05T00:00:00Z' })]
    const expr: QualificationExpression = { kind: 'any_of', expressions: [
      { kind: 'condition', condition: { field: 'amount', operator: 'gte', value: 10 } },
      { kind: 'condition', condition: { field: 'flag', operator: 'eq', value: true } },
    ]}
    const { result } = evaluateQualificationExpression({ expr, candidate, rule, evidence, sourceBindingRoleKeys: roleKeys, asOf: '2026-01-11T00:00:00Z' })
    expect(result).toBe('unknown')
  })

  it('any_of: everything false -> not_satisfied', () => {
    const evidence = [makeGenericEvidence({ id: 'e1', source_binding_id: 'binding-x', facts: { amount: 5, flag: false }, occurred_at: '2026-01-05T00:00:00Z' })]
    const expr: QualificationExpression = { kind: 'any_of', expressions: [
      { kind: 'condition', condition: { field: 'amount', operator: 'gte', value: 10 } },
      { kind: 'condition', condition: { field: 'flag', operator: 'eq', value: true } },
    ]}
    const { result } = evaluateQualificationExpression({ expr, candidate, rule, evidence, sourceBindingRoleKeys: roleKeys, asOf: '2026-01-11T00:00:00Z' })
    expect(result).toBe('not_satisfied')
  })

  it("'exists' never returns not_satisfied — missing evidence is honestly 'unknown', not a positive claim of absence", () => {
    const { result } = evaluateQualificationExpression({
      expr: { kind: 'condition', condition: { field: 'amount', operator: 'exists' } },
      candidate, rule, evidence: [], sourceBindingRoleKeys: roleKeys, asOf: '2026-01-11T00:00:00Z',
    })
    expect(result).toBe('unknown')
  })
})

// ── evaluateCandidateEvidenceSnapshot — never terminal, never mutates ────
describe('evaluateCandidateEvidenceSnapshot', () => {
  it('throws if the candidate is not pinned to the rule being evaluated against', () => {
    const rule = makeMinimalRule()
    const candidate = makeGenericCandidate({ qualification_rule_id: 'some-other-rule' })
    expect(() => evaluateCandidateEvidenceSnapshot({ candidate, rule, evidence: [], priorCandidates: [], sourceBindingRoleKeys: new Map(), asOf: '2026-01-11T00:00:00Z' }))
      .toThrow(/is pinned to rule/)
  })

  it('never returns qualified/billable/rejected fields, and never mutates the candidate object', () => {
    const rule = makeMinimalRule()
    const candidate = makeGenericCandidate({ qualification_rule_id: rule.id })
    const before = JSON.stringify(candidate)
    const snapshot = evaluateCandidateEvidenceSnapshot({ candidate, rule, evidence: [], priorCandidates: [], sourceBindingRoleKeys: new Map(), asOf: '2026-01-11T00:00:00Z' })
    expect(JSON.stringify(candidate)).toBe(before)
    expect(snapshot).not.toHaveProperty('qualified')
    expect(snapshot).not.toHaveProperty('billable')
    expect(snapshot).not.toHaveProperty('rejected')
    expect(candidate.status).toBe('pending')
  })
})

// ── Generic attestation_fact_key mechanism — no hardcoded SQM/role
// knowledge in the evaluator ───────────────────────────────────────────
describe('evaluateCandidateCriteria — generic attestation_fact_key mechanism', () => {
  const candidate = makeGenericCandidate()
  const roleKeys = new Map([['binding-x', 'crm']])

  it('a completely different reviewer-attested boolean condition (nothing to do with roles or SQM) uses the SAME generic mechanism with no code changes', () => {
    // Deliberately unrelated to "roles" or "equivalent role" in any way
    // — a manager sign-off flag — to prove the evaluator has no special
    // knowledge of what the configured key means.
    const rule = makeMinimalRule({
      fact_schema: {
        amount: { type: 'number', reference_time: 'occurred_at' },
        flag: { type: 'boolean', reference_time: 'occurred_at' },
        role: { type: 'enum', enumValues: ['A', 'B', 'C'], reference_time: 'occurred_at' },
        manager_override_approved: { type: 'boolean', reference_time: 'occurred_at' },
      },
      qualified_contact_role: {
        base: { value: { field: 'role', operator: 'in', value: ['A'] }, state: 'clear_from_source', provenance: 'contract_derived' },
        extensions: { value: [], state: 'decision_required', provenance: null },
        attestation_fact_key: { value: 'manager_override_approved', state: 'decision_required', provenance: 'reviewer_policy' },
      },
    })
    const roleFails = makeGenericEvidence({ id: 'e1', source_binding_id: 'binding-x', facts: { role: 'C' }, occurred_at: '2026-01-05T00:00:00Z' }) // not in ['A']

    const withoutOverride = evaluateCandidateCriteria({ candidate, rule, evidence: [roleFails], sourceBindingRoleKeys: roleKeys, asOf: '2026-01-11T00:00:00Z' })
    // base fails, attestation absent -> any_of(not_satisfied, unknown) = unknown
    expect(withoutOverride.qualifiedContactRoleTrace.result).toBe('unknown')

    const managerOverride = makeGenericEvidence({ id: 'e2', source_binding_id: 'binding-x', facts: { manager_override_approved: true }, occurred_at: '2026-01-05T00:00:00Z' })
    const withOverride = evaluateCandidateCriteria({ candidate, rule, evidence: [roleFails, managerOverride], sourceBindingRoleKeys: roleKeys, asOf: '2026-01-11T00:00:00Z' })
    expect(withOverride.qualifiedContactRoleTrace.result).toBe('satisfied')
  })

  it('with no attestation_fact_key configured, the role check is exactly base ∪ extensions — no implicit any_of wrapping', () => {
    const rule = makeMinimalRule() // default attestation_fact_key.value is null
    const roleFails = makeGenericEvidence({ id: 'e1', source_binding_id: 'binding-x', facts: { role: 'C' }, occurred_at: '2026-01-05T00:00:00Z' })
    const result = evaluateCandidateCriteria({ candidate, rule, evidence: [roleFails], sourceBindingRoleKeys: roleKeys, asOf: '2026-01-11T00:00:00Z' })
    // A clean not_satisfied (not 'unknown') proves this is the bare
    // roleLeaf, not an any_of with a permanently-unknown second branch.
    expect(result.qualifiedContactRoleTrace.result).toBe('not_satisfied')
  })
})

// ── evaluateDedupeObservation — generic guards ───────────────────────────
describe('evaluateDedupeObservation — generic guards', () => {
  it('throws for business-day lookback — explicitly deferred to 16B.3, never silently treated as calendar days', () => {
    const rule = makeMinimalRule({ dedupe_rule: { value: { key_fields: ['amount'], lookback: { days: 30, unit: 'business' }, scope: [], discovery_coverage_role_keys: [] }, state: 'clear_from_source', provenance: 'contract_derived' } })
    const candidate = makeGenericCandidate({ qualification_rule_id: rule.id })
    expect(() => evaluateDedupeObservation({ candidate, rule, evidence: [], priorCandidates: [], sourceBindingRoleKeys: new Map(), asOf: '2026-01-11T00:00:00Z' }))
      .toThrow(/business-day lookback/)
  })
  it("unknown when the current candidate's own key_fields cannot be resolved", () => {
    const rule = makeMinimalRule()
    const candidate = makeGenericCandidate({ qualification_rule_id: rule.id })
    const result = evaluateDedupeObservation({ candidate, rule, evidence: [], priorCandidates: [], sourceBindingRoleKeys: new Map(), asOf: '2026-01-11T00:00:00Z' })
    expect(result.status).toBe('unknown')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// OS-2026-09 fixture — the actual 16B.1 qualification rule fixture, made
// active/ready exactly the way lib/billable-unit-qualification-service.ts's
// real activation flow would (confirm every field, then activate) — never
// redesigned, only consumed.
// ═══════════════════════════════════════════════════════════════════════════
// Pre-commit hardening audit (16B.2) — 'account.id' is now declared
// canonically in lib/os-2026-09-fixture.ts itself (validated by
// validateQualificationRuleFieldReferences), so no ad hoc fact_schema
// patch is needed here anymore. The six evidence_precedence.<field>
// entries (formerly one non-field-scoped 'icp_contact_default'
// placeholder — see lib/os-2026-09-fixture.ts's own comment) are each
// confirmed independently, exactly as a reviewer would via
// confirmQualificationRuleField.
const UNRESOLVED_ICP_PRECEDENCE_KEYS = [
  'account.hq_or_commercial_ops_country', 'account.business_category', 'account.quota_carrying_sellers',
  'account.publicly_documented_enterprise_sales', 'account.is_current_paying_customer', 'contact.role',
] as const

function buildActiveOs202609Rule(): BillableUnitQualificationRule {
  let rule = buildOs202609Rule()
  rule = confirmQualificationRuleField(rule, 'deadline_convention', 'end_of_business_day')
  rule = confirmQualificationRuleField(rule, 'business_day_end_local_time', '17:00:00')
  rule = confirmQualificationRuleField(rule, 'attribution_basis')
  for (const key of UNRESOLVED_ICP_PRECEDENCE_KEYS) {
    rule = confirmQualificationRuleField(rule, `evidence_precedence.${key}`, { kind: 'source_precedence', order: ['crm', 'enrichment'] })
  }
  rule = confirmQualificationRuleField(rule, 'criteria')
  rule = confirmQualificationRuleField(rule, 'qualified_contact_role.base')
  rule = confirmQualificationRuleField(rule, 'qualified_contact_role.attestation_fact_key')
  rule = confirmQualificationRuleField(rule, 'dedupe_rule')
  rule = confirmQualificationRuleField(rule, 'rejection_rule')
  rule = confirmQualificationRuleField(rule, 'rejection_window')
  rule = confirmQualificationRuleField(rule, 'evidence_precedence.account.employee_count')
  rule = confirmQualificationRuleField(rule, 'evidence_precedence.attendance_minutes')
  for (const key of Object.keys(rule.fact_evidence_source_roles)) {
    rule = confirmQualificationRuleField(rule, `fact_evidence_source_roles.${key}`)
  }
  return { ...rule, id: 'rule-os-2026-09-sqm-v1', status: 'active' }
}

const ROLE_KEYS = new Map<string, string>([
  ['binding-crm', 'crm'],
  ['binding-conferencing', 'conferencing'],
  ['binding-calendar', 'calendar'],
  ['binding-enrichment', 'enrichment'],
  ['binding-reviewer', 'reviewer_attestation'],
])

function baseAccountFacts(): Record<string, unknown> {
  return {
    'account.id': 'acct-1',
    'account.hq_or_commercial_ops_country': 'SE',
    'account.employee_count': 1000,
    'account.business_category': 'b2b_software',
    'account.quota_carrying_sellers': 15,
    'account.is_current_paying_customer': false,
    'contact.role': 'VP_Sales',
  }
}

function makeCandidate(params: {
  id: string
  rule: BillableUnitQualificationRule
  external_id: string
  source_binding_id?: string
  booked_at: string | null
  occurred_at: string | null
  attribution_at: string
}): BillableUnitCandidate {
  return {
    id: params.id, job_id: 'job-os-2026-09', org_id: 'org-lynora', unit_type: 'SQM',
    external_identity: { source_binding_id: params.source_binding_id ?? 'binding-conferencing', external_id: params.external_id },
    booked_at: params.booked_at, occurred_at: params.occurred_at, attribution_at: params.attribution_at,
    qualification_rule_id: params.rule.id, qualification_rule_version: params.rule.version,
    rejection_deadline: null, status: 'pending', decided_at: null,
  }
}

function makeEvidence(params: {
  id: string
  candidate_id: string
  source_binding_id: string
  facts: Record<string, unknown>
  occurred_at: string
  recorded_at: string
  status?: 'active' | 'revoked'
  revoked_at?: string | null
  revoked_by?: string | null
}): CandidateUnitEvidence {
  return {
    id: params.id, candidate_id: params.candidate_id, job_id: 'job-os-2026-09', org_id: 'org-lynora',
    source_binding_id: params.source_binding_id, facts: params.facts,
    occurred_at: params.occurred_at, recorded_at: params.recorded_at, recorded_by: 'test-harness',
    status: params.status ?? 'active', revoked_at: params.revoked_at ?? null, revoked_by: params.revoked_by ?? null,
  }
}

describe('OS-2026-09 fixture — provisional candidate evaluation (16B.2)', () => {
  const rule = buildActiveOs202609Rule()

  it('sanity: the activated fixture is ready and active', () => {
    expect(isQualificationRuleReady(rule)).toBe(true)
    expect(rule.status).toBe('active')
  })

  it('Case A — clean prospective SQM: criteria satisfied, dedupe no_known_duplicate, candidate remains pending', () => {
    const candidate = makeCandidate({ id: 'cand-A', rule, external_id: 'meeting-A', booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-10T14:00:00Z', attribution_at: '2026-09-10T14:00:00Z' })
    const crm = makeEvidence({ id: 'ev-A-crm', candidate_id: candidate.id, source_binding_id: 'binding-crm', facts: baseAccountFacts(), occurred_at: '2026-09-01T00:00:00Z', recorded_at: '2026-09-01T00:00:00Z' })
    const conferencing = makeEvidence({ id: 'ev-A-conf', candidate_id: candidate.id, source_binding_id: 'binding-conferencing', facts: { attendance_minutes: 22 }, occurred_at: '2026-09-10T14:00:00Z', recorded_at: '2026-09-10T15:00:00Z' })

    const snapshot = evaluateCandidateEvidenceSnapshot({
      candidate, rule, evidence: [crm, conferencing], priorCandidates: [], sourceBindingRoleKeys: ROLE_KEYS, asOf: '2026-09-11T00:00:00Z',
    })

    expect(snapshot.criteria_status).toBe('satisfied')
    expect(snapshot.dedupe_observation).toBe('no_known_duplicate')
    expect(candidate.status).toBe('pending')
  })

  it('Case B — attendance under 15 minutes: criteria not_satisfied, candidate still persisted pending, no terminal rejection', () => {
    const candidate = makeCandidate({ id: 'cand-B', rule, external_id: 'meeting-B', booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-10T14:00:00Z', attribution_at: '2026-09-10T14:00:00Z' })
    const crm = makeEvidence({ id: 'ev-B-crm', candidate_id: candidate.id, source_binding_id: 'binding-crm', facts: baseAccountFacts(), occurred_at: '2026-09-01T00:00:00Z', recorded_at: '2026-09-01T00:00:00Z' })
    const conferencing = makeEvidence({ id: 'ev-B-conf', candidate_id: candidate.id, source_binding_id: 'binding-conferencing', facts: { attendance_minutes: 10 }, occurred_at: '2026-09-10T14:00:00Z', recorded_at: '2026-09-10T15:00:00Z' })

    const snapshot = evaluateCandidateEvidenceSnapshot({
      candidate, rule, evidence: [crm, conferencing], priorCandidates: [], sourceBindingRoleKeys: ROLE_KEYS, asOf: '2026-09-11T00:00:00Z',
    })

    expect(snapshot.criteria_status).toBe('not_satisfied')
    expect(candidate.status).toBe('pending')
    expect(candidate.decided_at).toBeNull()
  })

  it('Case C — missing attendance evidence entirely: criteria unknown', () => {
    const candidate = makeCandidate({ id: 'cand-C', rule, external_id: 'meeting-C', booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-10T14:00:00Z', attribution_at: '2026-09-10T14:00:00Z' })
    const crm = makeEvidence({ id: 'ev-C-crm', candidate_id: candidate.id, source_binding_id: 'binding-crm', facts: baseAccountFacts(), occurred_at: '2026-09-01T00:00:00Z', recorded_at: '2026-09-01T00:00:00Z' })

    const snapshot = evaluateCandidateEvidenceSnapshot({
      candidate, rule, evidence: [crm], priorCandidates: [], sourceBindingRoleKeys: ROLE_KEYS, asOf: '2026-09-11T00:00:00Z',
    })

    expect(snapshot.criteria_status).toBe('unknown')
    expect(snapshot.unresolved_facts).toContain('attendance_minutes')
  })

  it('Case D — §3.2: conferencing controls on conflict; calendar remains usable when conferencing is absent', () => {
    const candidate = makeCandidate({ id: 'cand-D', rule, external_id: 'meeting-D', booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-10T14:00:00Z', attribution_at: '2026-09-10T14:00:00Z' })
    const conferencing = makeEvidence({ id: 'ev-D-conf', candidate_id: candidate.id, source_binding_id: 'binding-conferencing', facts: { attendance_minutes: 22 }, occurred_at: '2026-09-10T14:00:00Z', recorded_at: '2026-09-10T15:00:00Z' })
    const calendar = makeEvidence({ id: 'ev-D-cal', candidate_id: candidate.id, source_binding_id: 'binding-calendar', facts: { attendance_minutes: 5 }, occurred_at: '2026-09-10T14:00:00Z', recorded_at: '2026-09-10T15:00:00Z' })
    const asOf = '2026-09-11T00:00:00Z'

    const bothPresent = resolveCandidateFact({ candidate, rule, factKey: 'attendance_minutes', evidence: [conferencing, calendar], sourceBindingRoleKeys: ROLE_KEYS, asOf })
    expect(bothPresent).toMatchObject({ status: 'resolved', value: 22, sourceRoleKey: 'conferencing' })

    const onlyCalendar = resolveCandidateFact({ candidate, rule, factKey: 'attendance_minutes', evidence: [calendar], sourceBindingRoleKeys: ROLE_KEYS, asOf })
    expect(onlyCalendar).toMatchObject({ status: 'resolved', value: 5, sourceRoleKey: 'calendar' })
  })

  it('Case E — booking-anchored fact uses the booking-time CRM evidence, never a later re-snapshot', () => {
    const bookedAt = '2026-09-01T00:00:00Z'
    const candidate = makeCandidate({ id: 'cand-E', rule, external_id: 'meeting-E', booked_at: bookedAt, occurred_at: '2026-09-10T14:00:00Z', attribution_at: '2026-09-10T14:00:00Z' })
    const atBooking = makeEvidence({ id: 'ev-E-1', candidate_id: candidate.id, source_binding_id: 'binding-crm', facts: { 'account.employee_count': 600 }, occurred_at: bookedAt, recorded_at: bookedAt })
    const later = makeEvidence({ id: 'ev-E-2', candidate_id: candidate.id, source_binding_id: 'binding-crm', facts: { 'account.employee_count': 200 }, occurred_at: '2026-09-20T00:00:00Z', recorded_at: '2026-09-20T00:00:00Z' })

    const resolution = resolveCandidateFact({ candidate, rule, factKey: 'account.employee_count', evidence: [atBooking, later], sourceBindingRoleKeys: ROLE_KEYS, asOf: '2026-09-25T00:00:00Z' })
    expect(resolution).toMatchObject({ status: 'resolved', value: 600 })
  })

  it('Case F — reviewer attests candidate-specific equivalence WITHOUT falsifying the factual title or mutating qualified_contact_role.extensions', () => {
    const candidate = makeCandidate({ id: 'cand-F', rule, external_id: 'meeting-F', booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-10T14:00:00Z', attribution_at: '2026-09-10T14:00:00Z' })
    // The attendee's REAL, factual title — genuinely not one of the six
    // named roles and not something evidence should ever be made to lie
    // about.
    const crm = makeEvidence({ id: 'ev-F-crm', candidate_id: candidate.id, source_binding_id: 'binding-crm', facts: { ...baseAccountFacts(), 'contact.role': 'Chief_Growth_Officer' }, occurred_at: '2026-09-01T00:00:00Z', recorded_at: '2026-09-01T00:00:00Z' })
    const conferencing = makeEvidence({ id: 'ev-F-conf', candidate_id: candidate.id, source_binding_id: 'binding-conferencing', facts: { attendance_minutes: 22 }, occurred_at: '2026-09-10T14:00:00Z', recorded_at: '2026-09-10T15:00:00Z' })
    const asOf = '2026-09-11T00:00:00Z'

    // Without an attestation, the title is genuinely out of the base list
    // (not_satisfied on its own) but the rule DOES support attestation,
    // so the absence of one is honestly 'unknown' — not a confident
    // denial and not a silent pass — exactly the any_of tri-state rule
    // (no satisfied, but an unknown sibling present -> unknown).
    const withoutAttestation = evaluateCandidateCriteria({ candidate, rule, evidence: [crm, conferencing], sourceBindingRoleKeys: ROLE_KEYS, asOf })
    expect(withoutAttestation.result).toBe('unknown')

    // Reviewer attests candidate-specific equivalence via a real
    // reviewer_attestation SourceBinding — a SEPARATE fact, never a
    // rewrite of contact.role. The fact key comes from the RULE's own
    // configuration, not a constant the evaluator recognizes by name.
    const attestationKey = rule.qualified_contact_role.attestation_fact_key.value!
    const attestation = makeEvidence({ id: 'ev-F-attest', candidate_id: candidate.id, source_binding_id: 'binding-reviewer', facts: { [attestationKey]: true }, occurred_at: '2026-09-10T14:00:00Z', recorded_at: '2026-09-11T00:00:00Z' })
    const withAttestation = evaluateCandidateCriteria({ candidate, rule, evidence: [crm, conferencing, attestation], sourceBindingRoleKeys: ROLE_KEYS, asOf: '2026-09-12T00:00:00Z' })
    expect(withAttestation.result).toBe('satisfied')

    // contact.role's OWN factual resolution is unchanged and unfalsified
    // — still genuinely "Chief_Growth_Officer", never canonicalized to a
    // base-list title merely to make the check pass.
    const roleResolution = resolveCandidateFact({ candidate, rule, factKey: 'contact.role', evidence: [crm, attestation], sourceBindingRoleKeys: ROLE_KEYS, asOf: '2026-09-12T00:00:00Z' })
    expect(roleResolution).toMatchObject({ status: 'resolved', value: 'Chief_Growth_Officer' })

    // The rule's own reusable, contract-derived role list is untouched by
    // this candidate-specific evidence — no mutation, no side channel, no
    // per-candidate rule amendment.
    expect(rule.qualified_contact_role.extensions.value).toEqual([])
    expect(rule.qualified_contact_role.base.provenance).toBe('contract_derived')
  })

  it('a rule with no attestation_fact_key configured gets exactly the original base-∪-extensions-only behavior — attestation support is opt-in, not a global evaluator change', () => {
    const attestationKey = rule.qualified_contact_role.attestation_fact_key.value!
    const ruleWithoutAttestationSupport: BillableUnitQualificationRule = {
      ...rule,
      qualified_contact_role: {
        ...rule.qualified_contact_role,
        attestation_fact_key: { value: null, state: 'decision_required', provenance: 'reviewer_policy' },
      },
    }
    const candidate = makeCandidate({ id: 'cand-F-no-support', rule: ruleWithoutAttestationSupport, external_id: 'meeting-F-no-support', booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-10T14:00:00Z', attribution_at: '2026-09-10T14:00:00Z' })
    const crm = makeEvidence({ id: 'ev-F2-crm', candidate_id: candidate.id, source_binding_id: 'binding-crm', facts: { ...baseAccountFacts(), 'contact.role': 'Chief_Growth_Officer' }, occurred_at: '2026-09-01T00:00:00Z', recorded_at: '2026-09-01T00:00:00Z' })
    const conferencing = makeEvidence({ id: 'ev-F2-conf', candidate_id: candidate.id, source_binding_id: 'binding-conferencing', facts: { attendance_minutes: 22 }, occurred_at: '2026-09-10T14:00:00Z', recorded_at: '2026-09-10T15:00:00Z' })
    // Evidence happens to carry a fact under the SAME key name the
    // attestation-supporting version of this rule uses — irrelevant here,
    // since THIS rule was never configured to consult it.
    const attestation = makeEvidence({ id: 'ev-F2-attest', candidate_id: candidate.id, source_binding_id: 'binding-reviewer', facts: { [attestationKey]: true }, occurred_at: '2026-09-10T14:00:00Z', recorded_at: '2026-09-11T00:00:00Z' })

    const result = evaluateCandidateCriteria({ candidate, rule: ruleWithoutAttestationSupport, evidence: [crm, conferencing, attestation], sourceBindingRoleKeys: ROLE_KEYS, asOf: '2026-09-12T00:00:00Z' })
    // The attestation fact is present in evidence but the rule's own
    // configuration never named it — ignored, not silently honored.
    expect(result.result).toBe('not_satisfied')
  })

  it('Case G — evidence revoked later remains visible at an earlier asOf, and invisible once asOf passes the revocation', () => {
    const candidate = makeCandidate({ id: 'cand-G', rule, external_id: 'meeting-G', booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-04T00:00:00Z', attribution_at: '2026-09-04T00:00:00Z' })
    const evidence = makeEvidence({
      id: 'ev-G', candidate_id: candidate.id, source_binding_id: 'binding-conferencing', facts: { attendance_minutes: 22 },
      occurred_at: '2026-09-04T00:00:00Z', recorded_at: '2026-09-05T00:00:00Z',
      status: 'revoked', revoked_at: '2026-09-10T00:00:00Z', revoked_by: 'reviewer-1',
    })

    const visible = resolveCandidateFact({ candidate, rule, factKey: 'attendance_minutes', evidence: [evidence], sourceBindingRoleKeys: ROLE_KEYS, asOf: '2026-09-06T00:00:00Z' })
    expect(visible.status).toBe('resolved')

    const invisible = resolveCandidateFact({ candidate, rule, factKey: 'attendance_minutes', evidence: [evidence], sourceBindingRoleKeys: ROLE_KEYS, asOf: '2026-09-11T00:00:00Z' })
    expect(invisible.status).toBe('unresolved')
  })

  it('Case H — rule amendment: attribution before/after the boundary pins different rule versions, regardless of when each candidate is processed', () => {
    const v1: BillableUnitQualificationRule = { ...rule, id: 'rule-v1', version: 1, status: 'superseded', effective_from: '2026-08-25T00:00:00Z', effective_to: '2026-10-01T00:00:00Z' }
    const v2: BillableUnitQualificationRule = { ...rule, id: 'rule-v2', version: 2, supersedes_rule_id: v1.id, status: 'active', effective_from: '2026-10-01T00:00:00Z', effective_to: null }

    // Both pins computed "after the amendment" (both calls happen in the
    // same test run, well after v2 exists) — the OUTCOME still depends
    // solely on each candidate's own attribution time, never on when the
    // pinning happens to run.
    const before = pinQualificationRuleVersion({ booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-15T00:00:00Z' }, [v1, v2])
    expect(before).toMatchObject({ status: 'pinned', ruleId: 'rule-v1', ruleVersion: 1 })

    const after = pinQualificationRuleVersion({ booked_at: '2026-10-05T00:00:00Z', occurred_at: '2026-10-15T00:00:00Z' }, [v1, v2])
    expect(after).toMatchObject({ status: 'pinned', ruleId: 'rule-v2', ruleVersion: 2 })

    expect(before.status === 'pinned' && after.status === 'pinned' && before.ruleId !== after.ruleId).toBe(true)
  })

  it('Case I — a prior matching candidate within lookback yields duplicate_found; none yields no_known_duplicate, never promoted to satisfied', () => {
    const priorCandidate = makeCandidate({ id: 'cand-I-prior', rule, external_id: 'meeting-I-prior', booked_at: '2026-08-01T00:00:00Z', occurred_at: '2026-08-15T00:00:00Z', attribution_at: '2026-08-15T00:00:00Z' })
    const priorEvidence = makeEvidence({ id: 'ev-I-prior', candidate_id: priorCandidate.id, source_binding_id: 'binding-crm', facts: baseAccountFacts(), occurred_at: '2026-08-01T00:00:00Z', recorded_at: '2026-08-01T00:00:00Z' })

    const currentCandidate = makeCandidate({ id: 'cand-I-current', rule, external_id: 'meeting-I-current', booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-10T00:00:00Z', attribution_at: '2026-09-10T00:00:00Z' })
    const currentEvidence = makeEvidence({ id: 'ev-I-current', candidate_id: currentCandidate.id, source_binding_id: 'binding-crm', facts: baseAccountFacts(), occurred_at: '2026-09-01T00:00:00Z', recorded_at: '2026-09-01T00:00:00Z' })

    const asOf = '2026-09-15T00:00:00Z'

    const withPrior = evaluateDedupeObservation({
      candidate: currentCandidate, rule, evidence: [currentEvidence],
      priorCandidates: [{ candidate: priorCandidate, evidence: [priorEvidence] }],
      sourceBindingRoleKeys: ROLE_KEYS, asOf,
    })
    expect(withPrior.status).toBe('duplicate_found')
    expect(withPrior.matchedPriorCandidateId).toBe('cand-I-prior')

    const withoutPrior = evaluateDedupeObservation({
      candidate: currentCandidate, rule, evidence: [currentEvidence],
      priorCandidates: [], sourceBindingRoleKeys: ROLE_KEYS, asOf,
    })
    expect(withoutPrior.status).toBe('no_known_duplicate')
    // DedupeObservationStatus has no 'satisfied' member at all — this is
    // enforced by the type itself; reasserted here for explicitness.
    expect(['duplicate_found', 'no_known_duplicate', 'unknown']).toContain(withoutPrior.status)
  })
})
