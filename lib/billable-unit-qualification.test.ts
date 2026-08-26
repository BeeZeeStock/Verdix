import { describe, it, expect } from 'vitest'
import {
  isFieldDecisionResolved, isQualificationRuleReady,
  confirmFieldDecision, confirmQualificationRuleField, extractReferencedSourceRoleKeys,
  computeQualificationExpressionDepth, validateQualificationExpression, validateQualificationCondition,
  validateQualificationRuleFieldReferences,
  MAX_QUALIFICATION_EXPRESSION_DEPTH,
  type FieldDecision, type BillableUnitQualificationRule, type QualificationExpression,
  type QualificationFactDefinition,
} from './billable-unit-qualification'
import { buildOs202609Rule } from './os-2026-09-fixture'

// ── FieldDecision resolution ─────────────────────────────────────────────
describe('isFieldDecisionResolved', () => {
  it('clear_from_source with provenance null is NOT resolved — no field is self-authoritative before an explicit reviewer action', () => {
    const d: FieldDecision<string> = { value: 'x', state: 'clear_from_source', provenance: null }
    expect(isFieldDecisionResolved(d)).toBe(false)
  })
  it('clear_from_source with provenance contract_derived IS resolved', () => {
    const d: FieldDecision<string> = { value: 'x', state: 'clear_from_source', provenance: 'contract_derived' }
    expect(isFieldDecisionResolved(d)).toBe(true)
  })
  it('verdix_recommends with a proposed value but provenance null is NOT resolved — a recommendation never clears readiness merely by having a value', () => {
    const d: FieldDecision<string> = { value: 'occurred_at', state: 'verdix_recommends', provenance: null }
    expect(isFieldDecisionResolved(d)).toBe(false)
  })
  it('verdix_recommends with provenance reviewer_policy (accepted) IS resolved', () => {
    const d: FieldDecision<string> = { value: 'occurred_at', state: 'verdix_recommends', provenance: 'reviewer_policy' }
    expect(isFieldDecisionResolved(d)).toBe(true)
  })
  it('decision_required with null value/provenance is NOT resolved', () => {
    const d: FieldDecision<string> = { value: null, state: 'decision_required', provenance: null }
    expect(isFieldDecisionResolved(d)).toBe(false)
  })
  it('decision_required resolved via an explicit reviewer choice (reviewer_policy) IS resolved', () => {
    const d: FieldDecision<string> = { value: 'end_of_business_day', state: 'decision_required', provenance: 'reviewer_policy' }
    expect(isFieldDecisionResolved(d)).toBe(true)
  })
})

// ── confirmFieldDecision ──────────────────────────────────────────────────
describe('confirmFieldDecision', () => {
  it('clear_from_source, reviewer accepts as-is -> contract_derived', () => {
    const result = confirmFieldDecision({ value: 'x', state: 'clear_from_source', provenance: null })
    expect(result).toEqual({ value: 'x', state: 'clear_from_source', provenance: 'contract_derived' })
  })
  it('verdix_recommends, reviewer accepts the recommendation as-is -> reviewer_policy, never contract_derived', () => {
    const result = confirmFieldDecision({ value: 'occurred_at', state: 'verdix_recommends', provenance: null })
    expect(result).toEqual({ value: 'occurred_at', state: 'verdix_recommends', provenance: 'reviewer_policy' })
  })
  it('decision_required requires an explicit overrideValue — throws without one', () => {
    expect(() => confirmFieldDecision({ value: null, state: 'decision_required', provenance: null })).toThrow()
  })
  it('decision_required with an explicit overrideValue -> reviewer_policy', () => {
    const result = confirmFieldDecision({ value: null, state: 'decision_required', provenance: null }, { overrideValue: 'end_of_business_day' })
    expect(result).toEqual({ value: 'end_of_business_day', state: 'decision_required', provenance: 'reviewer_policy' })
  })
  it('an explicit override on an already clear_from_source field still yields reviewer_policy — Override always outranks a passive accept', () => {
    const result = confirmFieldDecision({ value: 'x', state: 'clear_from_source', provenance: null }, { overrideValue: 'y' })
    expect(result).toEqual({ value: 'y', state: 'clear_from_source', provenance: 'reviewer_policy' })
  })
})

// ── Expression depth / validation ────────────────────────────────────────
describe('computeQualificationExpressionDepth / validateQualificationExpression', () => {
  const factSchema: Record<string, QualificationFactDefinition> = {
    a: { type: 'number', reference_time: 'occurred_at' },
    b: { type: 'boolean', reference_time: 'occurred_at' },
    c: { type: 'enum', enumValues: ['x', 'y'], reference_time: 'occurred_at' },
  }

  it('a bare condition has depth 0', () => {
    const expr: QualificationExpression = { kind: 'condition', condition: { field: 'a', operator: 'gte', value: 1 } }
    expect(computeQualificationExpressionDepth(expr)).toBe(0)
  })

  it('an all_of of conditions has depth 1', () => {
    const expr: QualificationExpression = { kind: 'all_of', expressions: [
      { kind: 'condition', condition: { field: 'a', operator: 'gte', value: 1 } },
      { kind: 'condition', condition: { field: 'b', operator: 'eq', value: true } },
    ]}
    expect(computeQualificationExpressionDepth(expr)).toBe(1)
  })

  it('an all_of containing one nested any_of has depth 2 — the approved bound — and is accepted', () => {
    const expr: QualificationExpression = { kind: 'all_of', expressions: [
      { kind: 'condition', condition: { field: 'a', operator: 'gte', value: 1 } },
      { kind: 'any_of', expressions: [
        { kind: 'condition', condition: { field: 'b', operator: 'eq', value: true } },
        { kind: 'condition', condition: { field: 'c', operator: 'in', value: ['x'] } },
      ]},
    ]}
    expect(computeQualificationExpressionDepth(expr)).toBe(MAX_QUALIFICATION_EXPRESSION_DEPTH)
    expect(validateQualificationExpression(expr, factSchema)).toEqual([])
  })

  it('depth 3 (an all_of wrapping an all_of wrapping an any_of) is rejected', () => {
    const expr: QualificationExpression = { kind: 'all_of', expressions: [
      { kind: 'all_of', expressions: [
        { kind: 'any_of', expressions: [
          { kind: 'condition', condition: { field: 'a', operator: 'gte', value: 1 } },
        ]},
      ]},
    ]}
    expect(computeQualificationExpressionDepth(expr)).toBe(3)
    const errors = validateQualificationExpression(expr, factSchema)
    expect(errors.some(e => e.reason.includes('exceeds the maximum'))).toBe(true)
  })

  it('a condition referencing an undeclared fact_schema key is rejected', () => {
    const errors = validateQualificationCondition({ field: 'undeclared', operator: 'eq', value: 1 }, factSchema)
    expect(errors.some(e => e.reason.includes('undeclared fact_schema key'))).toBe(true)
  })

  it('gte/lte against a non-numeric, non-timestamp fact is rejected', () => {
    const errors = validateQualificationCondition({ field: 'c', operator: 'gte', value: 1 }, factSchema)
    expect(errors.some(e => e.reason.includes("requires a number or timestamp"))).toBe(true)
  })

  it('an enum value not in the declared enumValues is rejected', () => {
    const errors = validateQualificationCondition({ field: 'c', operator: 'in', value: ['z'] }, factSchema)
    expect(errors.some(e => e.reason.includes('not a declared enum value'))).toBe(true)
  })

  it('a valid enum value passes', () => {
    const errors = validateQualificationCondition({ field: 'c', operator: 'in', value: ['x', 'y'] }, factSchema)
    expect(errors).toEqual([])
  })
})

// ── Pre-commit hardening audit (16B.2): fact-reference completeness ──────
// validateQualificationRuleFieldReferences must catch every field slot an
// EXECUTABLE rule references but fact_schema never declared — the exact
// class of defect the OS-2026-09 fixture exposed (dedupe_rule.key_fields
// naming 'account.id', which fact_schema never declared).
describe('validateQualificationRuleFieldReferences', () => {
  const validFactSchema: Record<string, QualificationFactDefinition> = {
    amount: { type: 'number', reference_time: 'occurred_at' },
    'account.id': { type: 'string', reference_time: 'booked_at' },
    role: { type: 'enum', enumValues: ['A', 'B'], reference_time: 'booked_at' },
  }

  function baseRule(overrides?: Partial<BillableUnitQualificationRule>): BillableUnitQualificationRule {
    return {
      id: 'r1', job_id: 'j1', org_id: 'o1', unit_type: 'U',
      fact_schema: validFactSchema,
      criteria: { value: { kind: 'condition', condition: { field: 'amount', operator: 'gte', value: 1 } }, state: 'clear_from_source', provenance: null },
      qualified_contact_role: {
        base: { value: { field: 'role', operator: 'in', value: ['A'] }, state: 'clear_from_source', provenance: null },
        extensions: { value: [], state: 'decision_required', provenance: null },
        attestation_fact_key: { value: null, state: 'decision_required', provenance: null },
      },
      dedupe_rule: { value: { key_fields: ['account.id'], lookback: { days: 30, unit: 'calendar' }, scope: [], discovery_coverage_role_keys: [] }, state: 'clear_from_source', provenance: null },
      rejection_rule: { value: null, state: 'decision_required', provenance: null },
      rejection_window: { value: null, state: 'decision_required', provenance: null },
      deadline_convention: { value: null, state: 'decision_required', provenance: null },
      business_day_end_local_time: { value: null, state: 'decision_required', provenance: null },
      attribution_basis: { value: null, state: 'decision_required', provenance: null },
      evidence_precedence: {},
      fact_evidence_source_roles: {
        amount: { value: ['crm'], state: 'clear_from_source', provenance: null },
        role: { value: ['crm'], state: 'clear_from_source', provenance: null },
        'account.id': { value: ['crm'], state: 'clear_from_source', provenance: null },
      },
      field_sources: {},
      version: 1, revision: 1, supersedes_rule_id: null,
      effective_from: '2026-01-01T00:00:00Z', effective_to: null, status: 'draft',
      ...overrides,
    }
  }

  it('a fully well-formed rule (every referenced field declared) validates clean', () => {
    expect(validateQualificationRuleFieldReferences(baseRule())).toEqual([])
  })

  it('rejects a criteria condition referencing an undeclared fact', () => {
    const rule = baseRule({ criteria: { value: { kind: 'condition', condition: { field: 'undeclared_field', operator: 'gte', value: 1 } }, state: 'clear_from_source', provenance: null } })
    const errors = validateQualificationRuleFieldReferences(rule)
    expect(errors.some(e => e.path.startsWith('criteria.') && e.reason.includes('undeclared'))).toBe(true)
  })

  it('rejects qualified_contact_role.base referencing an undeclared fact', () => {
    const rule = baseRule({ qualified_contact_role: { base: { value: { field: 'undeclared_role_field', operator: 'in', value: ['A'] }, state: 'clear_from_source', provenance: null }, extensions: { value: [], state: 'decision_required', provenance: null }, attestation_fact_key: { value: null, state: 'decision_required', provenance: null } } })
    const errors = validateQualificationRuleFieldReferences(rule)
    expect(errors.some(e => e.path.startsWith('qualified_contact_role.base.'))).toBe(true)
  })

  it('rejects qualified_contact_role.attestation_fact_key referencing an undeclared fact', () => {
    const rule = baseRule({ qualified_contact_role: { base: { value: { field: 'role', operator: 'in', value: ['A'] }, state: 'clear_from_source', provenance: null }, extensions: { value: [], state: 'decision_required', provenance: null }, attestation_fact_key: { value: 'undeclared_attestation_key', state: 'decision_required', provenance: null } } })
    const errors = validateQualificationRuleFieldReferences(rule)
    expect(errors).toContainEqual({ path: 'qualified_contact_role.attestation_fact_key', reason: "references undeclared fact_schema key 'undeclared_attestation_key'" })
  })

  it('accepts a declared BOOLEAN qualified_contact_role.attestation_fact_key', () => {
    const withKey = baseRule({
      fact_schema: { ...validFactSchema, approved: { type: 'boolean', reference_time: 'occurred_at' } },
      qualified_contact_role: { base: { value: { field: 'role', operator: 'in', value: ['A'] }, state: 'clear_from_source', provenance: null }, extensions: { value: [], state: 'decision_required', provenance: null }, attestation_fact_key: { value: 'approved', state: 'decision_required', provenance: null } },
      fact_evidence_source_roles: {
        amount: { value: ['crm'], state: 'clear_from_source', provenance: null },
        role: { value: ['crm'], state: 'clear_from_source', provenance: null },
        'account.id': { value: ['crm'], state: 'clear_from_source', provenance: null },
        approved: { value: ['reviewer_attestation'], state: 'clear_from_source', provenance: null },
      },
    })
    expect(validateQualificationRuleFieldReferences(withKey)).toEqual([])
  })

  it('rejects a declared attestation_fact_key whose fact_schema type is NOT boolean — the alternate condition is evaluated as field == true', () => {
    const withStringKey = baseRule({ fact_schema: { ...validFactSchema, approved: { type: 'string', reference_time: 'occurred_at' } }, qualified_contact_role: { base: { value: { field: 'role', operator: 'in', value: ['A'] }, state: 'clear_from_source', provenance: null }, extensions: { value: [], state: 'decision_required', provenance: null }, attestation_fact_key: { value: 'approved', state: 'decision_required', provenance: null } } })
    const errors = validateQualificationRuleFieldReferences(withStringKey)
    expect(errors).toContainEqual({ path: 'qualified_contact_role.attestation_fact_key', reason: "references fact_schema key 'approved' of type 'string', but the attestation condition is evaluated as 'field == true' and requires a 'boolean' fact" })
  })

  it('accepts null attestation_fact_key (no attestation mechanism configured)', () => {
    expect(validateQualificationRuleFieldReferences(baseRule())).toEqual([]) // null by default in baseRule()
  })

  it('the canonical OS-2026-09 rule\'s attestation_fact_key validates clean', () => {
    const rule = buildOs202609Rule()
    const key = rule.qualified_contact_role.attestation_fact_key.value!
    expect(rule.fact_schema[key]?.type).toBe('boolean')
    expect(validateQualificationRuleFieldReferences(rule)).toEqual([])
  })

  it('rejects dedupe_rule.key_fields referencing an undeclared fact — the exact OS-2026-09 gap', () => {
    const rule = baseRule({ dedupe_rule: { value: { key_fields: ['undeclared_key'], lookback: { days: 30, unit: 'calendar' }, scope: [], discovery_coverage_role_keys: [] }, state: 'clear_from_source', provenance: null } })
    const errors = validateQualificationRuleFieldReferences(rule)
    expect(errors.some(e => e.path === 'dedupe_rule.key_fields.undeclared_key')).toBe(true)
  })

  it('accepts a declared dedupe_rule.key_fields entry', () => {
    const rule = baseRule({ dedupe_rule: { value: { key_fields: ['account.id'], lookback: { days: 30, unit: 'calendar' }, scope: [], discovery_coverage_role_keys: [] }, state: 'clear_from_source', provenance: null } })
    expect(validateQualificationRuleFieldReferences(rule)).toEqual([])
  })

  it('rejects a dedupe_rule.scope condition referencing an undeclared fact', () => {
    const rule = baseRule({ dedupe_rule: { value: { key_fields: ['account.id'], lookback: { days: 30, unit: 'calendar' }, scope: [{ field: 'undeclared_scope_field', operator: 'eq', value: true }], discovery_coverage_role_keys: [] }, state: 'clear_from_source', provenance: null } })
    const errors = validateQualificationRuleFieldReferences(rule)
    expect(errors.some(e => e.path.startsWith('dedupe_rule.scope.'))).toBe(true)
  })

  it('rejects an evidence_precedence key that is not a declared fact_schema key', () => {
    const rule = baseRule({ evidence_precedence: { undeclared_precedence_key: { value: { kind: 'authoritative_source', source: 'crm' }, state: 'clear_from_source', provenance: null } } })
    const errors = validateQualificationRuleFieldReferences(rule)
    expect(errors).toContainEqual({ path: 'evidence_precedence.undeclared_precedence_key', reason: "references undeclared fact_schema key 'undeclared_precedence_key'" })
  })

  it('accepts an evidence_precedence key that IS a declared fact_schema key', () => {
    const rule = baseRule({ evidence_precedence: { amount: { value: { kind: 'authoritative_source', source: 'crm' }, state: 'clear_from_source', provenance: null } } })
    expect(validateQualificationRuleFieldReferences(rule)).toEqual([])
  })

  it('every OS-2026-09 canonical evidence_precedence key exists in fact_schema — the regression this whole audit was about', () => {
    const rule = buildOs202609Rule()
    expect(validateQualificationRuleFieldReferences(rule)).toEqual([])
    // Directly re-asserted: no non-field-scoped placeholder key remains.
    expect(Object.keys(rule.evidence_precedence).every(key => key in rule.fact_schema)).toBe(true)
  })
})

describe('OS-2026-09 fixture — before any reviewer confirmation', () => {
  const rule = buildOs202609Rule()

  it('is not ready — deadline_convention, attribution_basis, and the unstated evidence precedence all block it', () => {
    expect(isQualificationRuleReady(rule)).toBe(false)
  })
  it('criteria/qualified_contact_role.base/dedupe_rule/rejection_rule/rejection_window are clear_from_source but NOT yet resolved (provenance null)', () => {
    const decisions: Array<FieldDecision<unknown>> = [rule.criteria, rule.qualified_contact_role.base, rule.dedupe_rule, rule.rejection_rule, rule.rejection_window]
    for (const d of decisions) {
      expect(d.state).toBe('clear_from_source')
      expect(isFieldDecisionResolved(d)).toBe(false)
    }
  })
  it('deadline_convention is decision_required', () => {
    expect(rule.deadline_convention.state).toBe('decision_required')
    expect(isFieldDecisionResolved(rule.deadline_convention)).toBe(false)
  })
  it('attribution_basis is verdix_recommends with value occurred_at, not yet resolved', () => {
    expect(rule.attribution_basis.state).toBe('verdix_recommends')
    expect(rule.attribution_basis.value).toBe('occurred_at')
    expect(isFieldDecisionResolved(rule.attribution_basis)).toBe(false)
  })
  it('the criteria expression validates structurally against fact_schema (depth <= 2, no undeclared fields)', () => {
    expect(validateQualificationExpression(rule.criteria.value!, rule.fact_schema)).toEqual([])
  })
  it('qualified_contact_role.extensions starts empty and does not by itself block readiness', () => {
    expect(rule.qualified_contact_role.extensions.value).toEqual([])
  })
  it('extractReferencedSourceRoleKeys finds every role_key the rule actually references — crm, portal (rejection channels), conferencing, calendar (evidence precedence), plus every fact_evidence_source_roles capable source (enrichment, public_materials, reviewer_attestation) — deduplicated', () => {
    expect(extractReferencedSourceRoleKeys(rule).sort()).toEqual(['calendar', 'conferencing', 'crm', 'enrichment', 'portal', 'public_materials', 'reviewer_attestation'])
  })
})

describe('OS-2026-09 fixture — after confirming only the unresolved/recommended fields', () => {
  const UNRESOLVED_ICP_PRECEDENCE_KEYS = [
    'account.hq_or_commercial_ops_country', 'account.business_category', 'account.quota_carrying_sellers',
    'account.publicly_documented_enterprise_sales', 'account.is_current_paying_customer', 'contact.role',
  ] as const

  it('becomes ready once deadline_convention, attribution_basis, and every unstated evidence-precedence field are confirmed, WITHOUT changing the provenance of any already source-derived field', () => {
    let rule = buildOs202609Rule()
    expect(isQualificationRuleReady(rule)).toBe(false)

    // Confirm the genuinely open fields. The six unresolved
    // evidence_precedence.<field> entries (§3.1's unresolved CRM/
    // enrichment note) are confirmed one at a time with the SAME
    // override value — modeling a reviewer picking one policy for the
    // whole group in the UI, while the executable rule representation
    // stays fact-key-specific (see the grouped-decision test below).
    rule = confirmQualificationRuleField(rule, 'deadline_convention', 'end_of_business_day')
    rule = confirmQualificationRuleField(rule, 'business_day_end_local_time', '17:00:00')
    rule = confirmQualificationRuleField(rule, 'attribution_basis')  // accept the recommendation as-is
    rule = confirmQualificationRuleField(rule, 'qualified_contact_role.attestation_fact_key')  // accept the recommended mechanism/key as-is
    for (const key of UNRESOLVED_ICP_PRECEDENCE_KEYS) {
      rule = confirmQualificationRuleField(rule, `evidence_precedence.${key}`, { kind: 'source_precedence', order: ['crm', 'enrichment'] })
    }
    for (const key of Object.keys(rule.fact_evidence_source_roles)) {
      rule = confirmQualificationRuleField(rule, `fact_evidence_source_roles.${key}`)
    }

    expect(rule.deadline_convention).toEqual({ value: 'end_of_business_day', state: 'decision_required', provenance: 'reviewer_policy' })
    expect(rule.attribution_basis).toEqual({ value: 'occurred_at', state: 'verdix_recommends', provenance: 'reviewer_policy' })
    expect(rule.qualified_contact_role.attestation_fact_key).toEqual({ value: 'qualified_contact_role.reviewer_attested_equivalent', state: 'verdix_recommends', provenance: 'reviewer_policy' })
    for (const key of UNRESOLVED_ICP_PRECEDENCE_KEYS) {
      expect(rule.evidence_precedence[key].provenance).toBe('reviewer_policy')
    }

    // Still not ready — the clear_from_source fields haven't been
    // confirmed yet (per this codebase's standing HITL discipline, even a
    // clear reading requires an explicit accept).
    expect(isQualificationRuleReady(rule)).toBe(false)

    rule = confirmQualificationRuleField(rule, 'criteria')
    rule = confirmQualificationRuleField(rule, 'qualified_contact_role.base')
    rule = confirmQualificationRuleField(rule, 'dedupe_rule')
    rule = confirmQualificationRuleField(rule, 'rejection_rule')
    rule = confirmQualificationRuleField(rule, 'rejection_window')
    rule = confirmQualificationRuleField(rule, 'evidence_precedence.account.employee_count')
    rule = confirmQualificationRuleField(rule, 'evidence_precedence.attendance_minutes')

    expect(isQualificationRuleReady(rule)).toBe(true)
    // Every source-derived field resolved to contract_derived, never
    // reviewer_policy — confirming the unrelated open fields never
    // relabeled these.
    expect(rule.criteria.provenance).toBe('contract_derived')
    expect(rule.qualified_contact_role.base.provenance).toBe('contract_derived')
    expect(rule.dedupe_rule.provenance).toBe('contract_derived')
    expect(rule.rejection_rule.provenance).toBe('contract_derived')
    expect(rule.rejection_window.provenance).toBe('contract_derived')
    expect(rule.evidence_precedence['account.employee_count'].provenance).toBe('contract_derived')
    expect(rule.evidence_precedence['attendance_minutes'].provenance).toBe('contract_derived')
    // The fields that genuinely required a reviewer choice/acceptance
    // stay reviewer_policy — never silently promoted to contract_derived.
    expect(rule.deadline_convention.provenance).toBe('reviewer_policy')
    expect(rule.attribution_basis.provenance).toBe('reviewer_policy')
    for (const key of UNRESOLVED_ICP_PRECEDENCE_KEYS) {
      expect(rule.evidence_precedence[key].provenance).toBe('reviewer_policy')
    }
  })

  it('a grouped reviewer decision (the same strategy applied to several unresolved precedence fields) updates ONLY the intended real fact keys, never the already-explicit ones', () => {
    let rule = buildOs202609Rule()
    // "Grouping" is purely a caller/UI convenience — confirm two of the
    // six unresolved fields with one shared decision.
    rule = confirmQualificationRuleField(rule, 'evidence_precedence.account.business_category', { kind: 'source_precedence', order: ['crm', 'enrichment'] })
    rule = confirmQualificationRuleField(rule, 'evidence_precedence.contact.role', { kind: 'source_precedence', order: ['crm', 'enrichment'] })

    expect(rule.evidence_precedence['account.business_category'].provenance).toBe('reviewer_policy')
    expect(rule.evidence_precedence['contact.role'].provenance).toBe('reviewer_policy')
    // Every OTHER key — including the other four still-unresolved ICP
    // fields and the two already-explicit contract-stated entries — is
    // untouched.
    for (const key of ['account.hq_or_commercial_ops_country', 'account.quota_carrying_sellers', 'account.publicly_documented_enterprise_sales', 'account.is_current_paying_customer']) {
      expect(rule.evidence_precedence[key].provenance).toBeNull()
    }
    expect(rule.evidence_precedence['account.employee_count'].value).toEqual({ kind: 'authoritative_if_fresh_else_latest', source: 'crm', freshness_window_days: 90 })
    expect(rule.evidence_precedence['attendance_minutes'].value).toEqual({ kind: 'source_precedence', order: ['conferencing', 'calendar'] })
  })

  it('confirming deadline_convention alone does not touch criteria\'s provenance', () => {
    const rule = buildOs202609Rule()
    const afterOneConfirm = confirmQualificationRuleField(rule, 'deadline_convention', 'end_of_business_day')
    expect(afterOneConfirm.criteria).toBe(rule.criteria)  // referentially untouched
    expect(afterOneConfirm.criteria.provenance).toBeNull()
  })

  it('confirming attribution_basis does not touch evidence_precedence provenance', () => {
    const rule = buildOs202609Rule()
    const afterConfirm = confirmQualificationRuleField(rule, 'attribution_basis')
    expect(afterConfirm.evidence_precedence).toBe(rule.evidence_precedence)  // referentially untouched
  })

  it('reviewer-added Qualified Contact role extension never changes the base list\'s provenance, and the base list is never mistaken for reviewer-authored', () => {
    let rule = buildOs202609Rule()
    rule = confirmQualificationRuleField(rule, 'qualified_contact_role.base')
    expect(rule.qualified_contact_role.base.provenance).toBe('contract_derived')

    rule = confirmQualificationRuleField(rule, 'qualified_contact_role.extensions', ['Chief_Growth_Officer'])
    expect(rule.qualified_contact_role.extensions.provenance).toBe('reviewer_policy')
    // Adding an extension never relabels the six-role base list.
    expect(rule.qualified_contact_role.base.provenance).toBe('contract_derived')
    expect((rule.qualified_contact_role.base.value as { value: string[] }).value).toEqual(['CRO', 'CSO', 'VP_Sales', 'Head_of_Sales', 'VP_Revenue', 'Head_of_Revenue'])
  })

  it('field_sources is never mutated by confirmation — the original grounding is immutable', () => {
    const rule = buildOs202609Rule()
    const originalFieldSources = rule.field_sources
    const afterConfirm = confirmQualificationRuleField(rule, 'criteria')
    expect(afterConfirm.field_sources).toBe(originalFieldSources)
  })
})

// ── Pre-commit hardening audit, part A: active-rule immutability ────────
describe('confirmQualificationRuleField — active-rule immutability', () => {
  it('throws when called on an active rule — even for a field that would otherwise still be decision_required', () => {
    const rule: BillableUnitQualificationRule = { ...buildOs202609Rule(), status: 'active' }
    expect(() => confirmQualificationRuleField(rule, 'deadline_convention', 'end_of_business_day')).toThrow(/is 'active', not 'draft'/)
  })

  it('throws when called on a superseded rule', () => {
    const rule: BillableUnitQualificationRule = { ...buildOs202609Rule(), status: 'superseded' }
    expect(() => confirmQualificationRuleField(rule, 'criteria')).toThrow(/is 'superseded', not 'draft'/)
  })

  it('a draft rule may still be confirmed freely — the guard is scoped to non-draft statuses only', () => {
    const rule = buildOs202609Rule()
    expect(() => confirmQualificationRuleField(rule, 'criteria')).not.toThrow()
  })

  it('growing qualified_contact_role.extensions on an active rule is blocked by the same guard — "reusable equivalent-role interpretation" cannot be added in place once active', () => {
    const rule: BillableUnitQualificationRule = { ...buildOs202609Rule(), status: 'active' }
    expect(() => confirmQualificationRuleField(rule, 'qualified_contact_role.extensions', ['Chief_Growth_Officer'])).toThrow(/is 'active', not 'draft'/)
  })
})

// ── Pre-commit hardening audit, part B: field-level source grounding ────
// The exact excerpt read directly from the real, signed OS-2026-09 PDF
// during design (§§2.1-3.3, Schedule 1's ICP paragraph and qualification
// notes) — embedded here so this test proves field_sources entries are
// genuinely verbatim-traceable to the immutable agreement text without
// needing live DB/network access. Whitespace normalized to single spaces
// (PDF text extraction linebreaks), matching how field_sources quotes
// themselves are stored.
const REAL_OS_2026_09_EXCERPT = [
  '2.1 "Target Account" means an organization that satisfies all ICP requirements in Schedule 1 on the date the meeting is booked.',
  '2.2 "Qualified Contact" means a person employed by a Target Account whose role is Chief Revenue Officer, Chief Sales Officer, VP Sales, Head of Sales, VP Revenue, Head of Revenue, or an equivalent role with material responsibility for the account\'s sales or revenue organization.',
  '2.3 "Sales Qualified Meeting" or "SQM" means a live meeting sourced and booked by Supplier that satisfies all of the following conditions: the account is a Target Account; the attendee is a Qualified Contact; the prospect attends the scheduled meeting and remains in the meeting for at least 15 minutes; the meeting is not a duplicate of another Supplier-sourced meeting with the same account during the preceding 90 days; and Customer has not validly rejected the meeting under Section 2.5 within three (3) Business Days after the meeting occurs.',
  '2.5 Customer may reject a meeting within three (3) Business Days after the meeting occurs only by recording one of the following reasons in the agreed CRM workflow or Supplier portal: the account was outside the ICP in Schedule 1 when the meeting was booked; the attendee was not a Qualified Contact; the prospect did not attend for at least 15 minutes; the meeting was a duplicate under Section 2.3; or the account was already an active Customer sales opportunity, recorded in Customer\'s CRM at least 30 days before Supplier first contacted that account.',
  '2.7 "Business Day" means Monday through Friday excluding public holidays in Stockholm, Sweden.',
  '3.2 Attendance duration will be evidenced by the calendar or conferencing record for the meeting. If those records conflict, the conferencing record controls.',
  '3.3 Customer rejection under Section 2.5 must identify the meeting and rejection reason and must be timestamped in the agreed CRM workflow or Supplier portal. Email alone is not a valid rejection unless the parties expressly agree otherwise in writing for the specific meeting.',
  'SCHEDULE 1 - IDEAL CUSTOMER PROFILE (ICP) A prospect is a Target Account only if all of the following are true when the meeting is booked: Headquarters or primary commercial operations in Sweden, Norway, Denmark, Finland, Germany, Netherlands, Belgium, France, or the United Kingdom.',
  'Company employee count may be established from Customer CRM data, the prospect\'s public materials, or Supplier\'s enrichment provider. If sources conflict materially, Customer CRM data controls if it was updated within the preceding 90 days; otherwise the parties will use the most recent reliable source.',
].join(' ')

describe('field_sources — source-grounding resolution path (FieldDecision -> field_sources entry -> immutable agreement text)', () => {
  const rule = buildOs202609Rule()

  it('every field_sources quote, for every field, is a verbatim substring of the actual agreement text — not a heading, not a paraphrase', () => {
    for (const [fieldPath, quotes] of Object.entries(rule.field_sources)) {
      for (const quote of quotes) {
        expect(REAL_OS_2026_09_EXCERPT.includes(quote), `field_sources['${fieldPath}'] quote not found verbatim in the agreement: "${quote}"`).toBe(true)
      }
    }
  })

  it('a field with no field_sources entry (deadline_convention) is not silently backed by a fabricated clause', () => {
    expect(rule.field_sources['deadline_convention']).toBeUndefined()
  })

  it('one field (rejection_rule) legitimately references multiple distinct clauses — a single Record<string,string> could not represent this', () => {
    expect(rule.field_sources['rejection_rule'].length).toBeGreaterThan(1)
  })

  it('resolving criteria\'s grounding from the rule alone (no external lookup, no re-fetched document, no extractSectionClause-style heading match) recovers real, non-empty source text', () => {
    const resolved = rule.field_sources['criteria']
    expect(resolved.length).toBeGreaterThan(0)
    for (const clause of resolved) {
      expect(clause.length).toBeGreaterThan(20)
      expect(REAL_OS_2026_09_EXCERPT).toContain(clause)
    }
  })
})
