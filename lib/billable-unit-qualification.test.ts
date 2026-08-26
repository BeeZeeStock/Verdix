import { describe, it, expect } from 'vitest'
import {
  isFieldDecisionResolved, isQualificationRuleReady,
  confirmFieldDecision, confirmQualificationRuleField, extractReferencedSourceRoleKeys,
  computeQualificationExpressionDepth, validateQualificationExpression, validateQualificationCondition,
  MAX_QUALIFICATION_EXPRESSION_DEPTH,
  type FieldDecision, type BillableUnitQualificationRule, type QualificationExpression,
  type QualificationFactDefinition,
} from './billable-unit-qualification'

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

// ── OS-2026-09 fixture ────────────────────────────────────────────────────
// Every clause reference below is transcribed from the actual signed
// OS-2026-09 contract text (§§2.1-3.4, Schedule 1), read directly from the
// stored PDF during design — not an illustrative/invented fixture.
function unresolved<T>(): FieldDecision<T> {
  return { value: null, state: 'decision_required', provenance: null }
}

function buildOs202609Rule(): BillableUnitQualificationRule {
  const factSchema: Record<string, QualificationFactDefinition> = {
    'account.hq_or_commercial_ops_country': { type: 'enum', enumValues: ['SE', 'NO', 'DK', 'FI', 'DE', 'NL', 'BE', 'FR', 'GB'], reference_time: 'booked_at' },
    'account.employee_count': { type: 'number', reference_time: 'booked_at' },
    'account.business_category': { type: 'enum', enumValues: ['b2b_software', 'ai', 'developer_tools', 'enterprise_saas', 'fintech_infrastructure', 'deep_tech_b2b'], reference_time: 'booked_at' },
    'account.quota_carrying_sellers': { type: 'number', reference_time: 'booked_at' },
    'account.publicly_documented_enterprise_sales': { type: 'boolean', reference_time: 'booked_at' },
    'account.is_current_paying_customer': { type: 'boolean', reference_time: 'booked_at' },
    'contact.role': { type: 'enum', reference_time: 'booked_at' },
    'attendance_minutes': { type: 'number', reference_time: 'occurred_at' },
    'rejection_reason': {
      type: 'enum', reference_time: 'occurred_at',
      enumValues: ['account_outside_icp_at_booking', 'attendee_not_qualified_contact', 'attendance_under_15_minutes', 'duplicate_meeting', 'preexisting_active_opportunity'],
    },
  }

  // §2.1, §2.3 bullet 1, Schedule 1 — flattened into ONE all_of with a
  // single nested any_of (Schedule 1 bullet 4's genuine OR) to stay within
  // the approved depth-2 bound: AND is associative, so grouping the
  // Target-Account bullets into their own labeled sub-all_of (as an
  // earlier illustrative round did) would have added an unnecessary third
  // nesting level for no semantic gain.
  const criteriaExpr: QualificationExpression = {
    kind: 'all_of', expressions: [
      { kind: 'condition', condition: { field: 'account.hq_or_commercial_ops_country', operator: 'in', value: ['SE', 'NO', 'DK', 'FI', 'DE', 'NL', 'BE', 'FR', 'GB'] } },
      { kind: 'condition', condition: { field: 'account.employee_count', operator: 'gte', value: 500 } },
      { kind: 'condition', condition: { field: 'account.employee_count', operator: 'lte', value: 5000 } },
      { kind: 'condition', condition: { field: 'account.business_category', operator: 'in', value: ['b2b_software', 'ai', 'developer_tools', 'enterprise_saas', 'fintech_infrastructure', 'deep_tech_b2b'] } },
      { kind: 'any_of', expressions: [
        { kind: 'condition', condition: { field: 'account.quota_carrying_sellers', operator: 'gte', value: 10 } },
        { kind: 'condition', condition: { field: 'account.publicly_documented_enterprise_sales', operator: 'eq', value: true } },
      ]},
      { kind: 'condition', condition: { field: 'account.is_current_paying_customer', operator: 'eq', value: false } },
      // §2.3 bullet 3 — attendance, flattened in alongside the Target
      // Account bullets (both are single-candidate field predicates).
      { kind: 'condition', condition: { field: 'attendance_minutes', operator: 'gte', value: 15 } },
    ],
  }

  return {
    id: 'rule-os-2026-09-sqm',
    job_id: 'job-os-2026-09',
    org_id: 'org-lynora',
    unit_type: 'SQM',
    fact_schema: factSchema,
    criteria: { value: criteriaExpr, state: 'clear_from_source', provenance: null },
    qualified_contact_role: {
      // §2.2 — the six named roles, explicit in source.
      base: {
        value: { field: 'contact.role', operator: 'in', value: ['CRO', 'CSO', 'VP_Sales', 'Head_of_Sales', 'VP_Revenue', 'Head_of_Revenue'] },
        state: 'clear_from_source', provenance: null,
      },
      // §2.2's "...or an equivalent role" — starts empty, reviewer-only,
      // never blocks initial readiness.
      extensions: { value: [], state: 'decision_required', provenance: null },
    },
    dedupe_rule: {
      // §2.3 bullet 4 — "preceding 90 days" (no "Business Days" wording
      // here, unlike the rejection window — calendar days).
      value: { key_fields: ['account.id'], lookback: { days: 90, unit: 'calendar' }, scope: [] },
      state: 'clear_from_source', provenance: null,
    },
    rejection_rule: {
      // §2.5's five enumerated reasons, §3.3's channel/timestamp/
      // identification requirements and email-alone exclusion.
      value: {
        valid_reasons: ['account_outside_icp_at_booking', 'attendee_not_qualified_contact', 'attendance_under_15_minutes', 'duplicate_meeting', 'preexisting_active_opportunity'],
        valid_channels: ['crm', 'portal'],
        requires_timestamp: true,
        requires_identification: true,
        email_alone_valid: false,
        email_exception: 'candidate_level_reviewer_override',
        late_rejection_behavior: 'ignored_for_initial_qualification',
      },
      state: 'clear_from_source', provenance: null,
    },
    rejection_window: {
      // §2.7 — explicit calendar.
      value: { business_days: 3, holiday_calendar: 'SE-stockholm', timezone: 'Europe/Stockholm' },
      state: 'clear_from_source', provenance: null,
    },
    // §2.7/§2.5 never state clock-time-vs-end-of-day — genuinely unresolved.
    deadline_convention: unresolved(),
    // §5.1's "Monthly SQMs"/"each calendar month" framing reads naturally
    // as occurrence-month, but the contract never uses the word
    // "attribution" — a confident inference, not an explicit statement.
    attribution_basis: { value: 'occurred_at', state: 'verdix_recommends', provenance: null },
    evidence_precedence: {
      // Schedule 1's qualification notes — explicit conflict-resolution rule.
      'account.employee_count': {
        value: { kind: 'authoritative_if_fresh_else_latest', source: 'crm', freshness_window_days: 90 },
        state: 'clear_from_source', provenance: null,
      },
      // §3.2 — explicit.
      'attendance_minutes': {
        value: { kind: 'source_precedence', order: ['conferencing', 'calendar'] },
        state: 'clear_from_source', provenance: null,
      },
      // §3.1 names CRM + enrichment for the OTHER ICP/contact facts but
      // states no precedence between them — genuinely unresolved, not
      // invented.
      'icp_contact_default': unresolved(),
    },
    // Verbatim quotes from the actual signed OS-2026-09 PDF (read directly
    // from the stored contract during design; see
    // REAL_OS_2026_09_EXCERPT below and the source-grounding-resolution
    // describe block for a test proving each quote is a real substring of
    // the actual agreement text, not a paraphrase or a heading reference).
    field_sources: {
      'criteria': [
        '"Target Account" means an organization that satisfies all ICP requirements in Schedule 1 on the date the meeting is booked.',
        '"Sales Qualified Meeting" or "SQM" means a live meeting sourced and booked by Supplier that satisfies all of the following conditions: the account is a Target Account; the attendee is a Qualified Contact; the prospect attends the scheduled meeting and remains in the meeting for at least 15 minutes;',
        'A prospect is a Target Account only if all of the following are true when the meeting is booked: Headquarters or primary commercial operations in Sweden, Norway, Denmark, Finland, Germany, Netherlands, Belgium, France, or the United Kingdom.',
      ],
      'qualified_contact_role.base': [
        '"Qualified Contact" means a person employed by a Target Account whose role is Chief Revenue Officer, Chief Sales Officer, VP Sales, Head of Sales, VP Revenue, Head of Revenue, or an equivalent role with material responsibility for the account\'s sales or revenue organization.',
      ],
      'dedupe_rule': [
        'the meeting is not a duplicate of another Supplier-sourced meeting with the same account during the preceding 90 days',
      ],
      'rejection_rule': [
        'Customer may reject a meeting within three (3) Business Days after the meeting occurs only by recording one of the following reasons in the agreed CRM workflow or Supplier portal:',
        'Customer rejection under Section 2.5 must identify the meeting and rejection reason and must be timestamped in the agreed CRM workflow or Supplier portal. Email alone is not a valid rejection unless the parties expressly agree otherwise in writing for the specific meeting.',
      ],
      'rejection_window': [
        '"Business Day" means Monday through Friday excluding public holidays in Stockholm, Sweden.',
      ],
      'evidence_precedence.account.employee_count': [
        'Company employee count may be established from Customer CRM data, the prospect\'s public materials, or Supplier\'s enrichment provider. If sources conflict materially, Customer CRM data controls if it was updated within the preceding 90 days; otherwise the parties will use the most recent reliable source.',
      ],
      'evidence_precedence.attendance_minutes': [
        'Attendance duration will be evidenced by the calendar or conferencing record for the meeting. If those records conflict, the conferencing record controls.',
      ],
      // deadline_convention, attribution_basis, evidence_precedence.icp_contact_default
      // deliberately absent — no clause grounds them; the absence itself is meaningful.
    },
    version: 1,
    revision: 1,
    supersedes_rule_id: null,
    effective_from: '2026-08-25T00:00:00Z',
    effective_to: null,
    status: 'draft',
  }
}

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
  it('extractReferencedSourceRoleKeys finds every role_key the rule actually references — crm, portal (rejection channels), conferencing, calendar (evidence precedence) — deduplicated', () => {
    expect(extractReferencedSourceRoleKeys(rule).sort()).toEqual(['calendar', 'conferencing', 'crm', 'portal'])
  })
})

describe('OS-2026-09 fixture — after confirming only the unresolved/recommended fields', () => {
  it('becomes ready once deadline_convention, attribution_basis, and the unstated evidence precedence are confirmed, WITHOUT changing the provenance of any already source-derived field', () => {
    let rule = buildOs202609Rule()
    expect(isQualificationRuleReady(rule)).toBe(false)

    // Confirm the three genuinely open fields only.
    rule = confirmQualificationRuleField(rule, 'deadline_convention', 'end_of_business_day')
    rule = confirmQualificationRuleField(rule, 'attribution_basis')  // accept the recommendation as-is
    rule = confirmQualificationRuleField(rule, 'evidence_precedence.icp_contact_default', { kind: 'source_precedence', order: ['crm', 'enrichment'] })

    expect(rule.deadline_convention).toEqual({ value: 'end_of_business_day', state: 'decision_required', provenance: 'reviewer_policy' })
    expect(rule.attribution_basis).toEqual({ value: 'occurred_at', state: 'verdix_recommends', provenance: 'reviewer_policy' })
    expect(rule.evidence_precedence['icp_contact_default'].provenance).toBe('reviewer_policy')

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
    // The two fields that genuinely required a reviewer choice/acceptance
    // stay reviewer_policy — never silently promoted to contract_derived.
    expect(rule.deadline_convention.provenance).toBe('reviewer_policy')
    expect(rule.attribution_basis.provenance).toBe('reviewer_policy')
    expect(rule.evidence_precedence['icp_contact_default'].provenance).toBe('reviewer_policy')
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
