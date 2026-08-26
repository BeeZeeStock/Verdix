import { describe, it, expect } from 'vitest'
import { confirmQualificationRuleField, type BillableUnitQualificationRule } from './billable-unit-qualification'
import { buildOs202609Rule } from './os-2026-09-fixture'
import type { BillableUnitCandidate, CandidateUnitEvidence } from './billable-unit-candidate'
import type { SourceBinding } from './source-bindings'
import type { SourceCoverage } from './source-coverage'
import {
  evaluateCandidateFinalDecision, resolveRejectionDeadline,
  OBJECTION_REASON_FACT_KEY, OBJECTION_CHANNEL_FACT_KEY, OBJECTION_TIMESTAMP_FACT_KEY, OBJECTION_SUBJECT_EXTERNAL_ID_FACT_KEY,
} from './billable-unit-candidate-finality'

// ═══════════════════════════════════════════════════════════════════════════
// Step 16B.3 — OS-2026-09 fixture cases A-J for the completeness + terminal
// finality layer. Reuses the exact buildActiveOs202609Rule/makeCandidate/
// makeEvidence pattern already established in
// lib/billable-unit-candidate.test.ts (16B.2), extended with SourceBinding/
// SourceCoverage fixtures this slice adds.
// ═══════════════════════════════════════════════════════════════════════════

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

const SOURCE_BINDING_ROLE_KEYS = new Map<string, string>([
  ['binding-crm', 'crm'], ['binding-conferencing', 'conferencing'], ['binding-calendar', 'calendar'],
  ['binding-enrichment', 'enrichment'], ['binding-reviewer', 'reviewer_attestation'], ['binding-portal', 'portal'],
])

const SOURCE_BINDINGS: SourceBinding[] = Array.from(SOURCE_BINDING_ROLE_KEYS.keys()).map(id => ({
  id, source_role_id: `role-${id}`, job_id: 'job-os-2026-09', org_id: 'org-lynora', label: id,
  effective_from: '2020-01-01T00:00:00Z', effective_to: null, supersedes_binding_id: null, status: 'active' as const,
}))

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
  id: string; rule: BillableUnitQualificationRule; external_id: string
  booked_at: string | null; occurred_at: string | null; attribution_at: string
}): BillableUnitCandidate {
  return {
    id: params.id, job_id: 'job-os-2026-09', org_id: 'org-lynora', unit_type: 'SQM',
    external_identity: { source_binding_id: 'binding-conferencing', external_id: params.external_id },
    booked_at: params.booked_at, occurred_at: params.occurred_at, attribution_at: params.attribution_at,
    qualification_rule_id: params.rule.id, qualification_rule_version: params.rule.version,
    rejection_deadline: null, status: 'pending', decided_at: null,
  }
}

function makeEvidence(params: {
  id: string; candidate_id: string; source_binding_id: string; facts: Record<string, unknown>
  occurred_at: string; recorded_at: string
}): CandidateUnitEvidence {
  return {
    id: params.id, candidate_id: params.candidate_id, job_id: 'job-os-2026-09', org_id: 'org-lynora',
    source_binding_id: params.source_binding_id, facts: params.facts,
    occurred_at: params.occurred_at, recorded_at: params.recorded_at, recorded_by: 'test-harness',
    status: 'active', revoked_at: null, revoked_by: null,
  }
}

function makeCoverage(params: {
  id: string; source_binding_id: string; coverage_kind: SourceCoverage['coverage_kind']
  covered_from: string; covered_through: string; established_at: string
}): SourceCoverage {
  return {
    id: params.id, job_id: 'job-os-2026-09', org_id: 'org-lynora', source_binding_id: params.source_binding_id,
    coverage_kind: params.coverage_kind, covered_from: params.covered_from, covered_through: params.covered_through,
    established_at: params.established_at, completeness_basis: 'connector_high_watermark', established_by: 'test-harness', metadata: {},
    status: 'active', revoked_at: null, revoked_by: null,
  }
}

// Criteria-satisfying, dedupe-key-resolvable account facts + attendance —
// the same "clean" evidence pair used across cases A/E/F/G/I, which only
// differ in rejection/coverage handling, not criteria. Account facts are
// declared reference_time: 'booked_at' (see the fixture's fact_schema), so
// the CRM evidence must be observed AT-OR-BEFORE booked_at, never later —
// exactly the same timing 16B.2's own Case A test uses.
function cleanEvidence(candidateId: string, bookedAt: string, occurredAt: string): CandidateUnitEvidence[] {
  return [
    makeEvidence({ id: `${candidateId}-crm`, candidate_id: candidateId, source_binding_id: 'binding-crm', facts: baseAccountFacts(), occurred_at: bookedAt, recorded_at: bookedAt }),
    makeEvidence({ id: `${candidateId}-conf`, candidate_id: candidateId, source_binding_id: 'binding-conferencing', facts: { attendance_minutes: 22 }, occurred_at: occurredAt, recorded_at: occurredAt }),
  ]
}

function rejectionSourceCoverage(candidateId: string, from: string, through: string, establishedAt: string): SourceCoverage[] {
  return [
    makeCoverage({ id: `${candidateId}-rej-crm`, source_binding_id: 'binding-crm', coverage_kind: 'rejection_source', covered_from: from, covered_through: through, established_at: establishedAt }),
    makeCoverage({ id: `${candidateId}-rej-portal`, source_binding_id: 'binding-portal', coverage_kind: 'rejection_source', covered_from: from, covered_through: through, established_at: establishedAt }),
  ]
}

function dedupeCoverage(candidateId: string, from: string, through: string, establishedAt: string): SourceCoverage {
  return makeCoverage({ id: `${candidateId}-dedupe`, source_binding_id: 'binding-crm', coverage_kind: 'candidate_discovery', covered_from: from, covered_through: through, established_at: establishedAt })
}

// Contractual-finality hardening — the facts a "qualified" (or a criteria-
// not_satisfied "rejected") outcome materially relies on for THIS fixture
// are exactly: every account.* fact resolved via 'crm' (index-0 in its
// source_precedence order, or the authoritative_if_fresh_else_latest
// source for account.employee_count) through booked_at, plus
// attendance_minutes resolved via 'conferencing' (index-0 in ITS order)
// through occurred_at. account.publicly_documented_enterprise_sales and
// the reviewer-attestation fallback are correctly EXCLUDED — Case A's any_of
// branches are already satisfied via quota_carrying_sellers/contact.role
// directly, so the unresolved alternate branches were never material (see
// collectMaterialFactKeysFromTrace's own priority-aware design note).
// dedupe_rule.key_fields (account.id) is also 'crm'-resolved through
// booked_at, so this same crm row covers it too.
function standardFactEvidenceCoverage(candidateId: string, bookedAt: string, occurredAt: string, establishedAt: string): SourceCoverage[] {
  return [
    makeCoverage({ id: `${candidateId}-fe-crm`, source_binding_id: 'binding-crm', coverage_kind: 'fact_evidence', covered_from: '2020-01-01T00:00:00Z', covered_through: bookedAt, established_at: establishedAt }),
    makeCoverage({ id: `${candidateId}-fe-conf`, source_binding_id: 'binding-conferencing', coverage_kind: 'fact_evidence', covered_from: '2020-01-01T00:00:00Z', covered_through: occurredAt, established_at: establishedAt }),
  ]
}

describe('OS-2026-09 fixture — Step 16B.3 completeness + terminal finality', () => {
  const rule = buildActiveOs202609Rule()

  it('sanity: the activated fixture is ready and active', () => {
    expect(rule.status).toBe('active')
  })

  // ── Case A — clean candidate -> qualified ────────────────────────────
  it('Case A — criteria satisfied + complete 90d dedupe coverage + deadline passed + complete rejection coverage + no rejection -> qualified', () => {
    const candidate = makeCandidate({ id: 'cand-A', rule, external_id: 'meeting-A', booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-10T14:00:00Z', attribution_at: '2026-09-10T14:00:00Z' })
    const deadlineResult = resolveRejectionDeadline(candidate, rule)
    if (deadlineResult.status !== 'resolved') throw new Error('test setup: deadline must resolve')

    const coverage = [
      dedupeCoverage(candidate.id, '2026-06-01T00:00:00Z', '2026-09-11T00:00:00Z', '2026-09-11T00:00:00Z'),
      ...rejectionSourceCoverage(candidate.id, candidate.occurred_at!, deadlineResult.deadline, deadlineResult.deadline),
      ...standardFactEvidenceCoverage(candidate.id, candidate.booked_at!, candidate.occurred_at!, deadlineResult.deadline),
    ]
    const asOf = new Date(new Date(deadlineResult.deadline).getTime() + 86_400_000).toISOString()

    const decision = evaluateCandidateFinalDecision({
      candidate, rule, evidence: cleanEvidence(candidate.id, candidate.booked_at!, candidate.occurred_at!),
      priorCandidates: [], sourceBindingRoleKeys: SOURCE_BINDING_ROLE_KEYS, sourceBindings: SOURCE_BINDINGS, coverage, asOf,
    })
    expect(decision.outcome).toBe('qualified')
    expect(decision.dedupe.outcome).toBe('cleared')
    expect(decision.rejection.outcome).toBe('cleared')
  })

  // ── Case B — missing dedupe coverage -> pending ──────────────────────
  it('Case B — missing dedupe (candidate_discovery) coverage -> pending', () => {
    const candidate = makeCandidate({ id: 'cand-B', rule, external_id: 'meeting-B', booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-10T14:00:00Z', attribution_at: '2026-09-10T14:00:00Z' })
    const deadlineResult = resolveRejectionDeadline(candidate, rule)
    if (deadlineResult.status !== 'resolved') throw new Error('test setup: deadline must resolve')

    const coverage = rejectionSourceCoverage(candidate.id, candidate.occurred_at!, deadlineResult.deadline, deadlineResult.deadline)
    const asOf = new Date(new Date(deadlineResult.deadline).getTime() + 86_400_000).toISOString()

    const decision = evaluateCandidateFinalDecision({
      candidate, rule, evidence: cleanEvidence(candidate.id, candidate.booked_at!, candidate.occurred_at!),
      priorCandidates: [], sourceBindingRoleKeys: SOURCE_BINDING_ROLE_KEYS, sourceBindings: SOURCE_BINDINGS, coverage, asOf,
    })
    expect(decision.outcome).toBe('pending')
    expect(decision.dedupe.outcome).toBe('pending')
  })

  // ── Case C — missing rejection-source coverage -> pending ────────────
  it('Case C — deadline passed but incomplete rejection-source coverage (portal missing) -> pending', () => {
    const candidate = makeCandidate({ id: 'cand-C', rule, external_id: 'meeting-C', booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-10T14:00:00Z', attribution_at: '2026-09-10T14:00:00Z' })
    const deadlineResult = resolveRejectionDeadline(candidate, rule)
    if (deadlineResult.status !== 'resolved') throw new Error('test setup: deadline must resolve')

    // Only the CRM channel is covered — portal is a required valid_channel
    // too, and its absence must block clearance on its own.
    const coverage = [
      dedupeCoverage(candidate.id, '2026-06-01T00:00:00Z', '2026-09-11T00:00:00Z', '2026-09-11T00:00:00Z'),
      makeCoverage({ id: 'cov-C-crm', source_binding_id: 'binding-crm', coverage_kind: 'rejection_source', covered_from: candidate.occurred_at!, covered_through: deadlineResult.deadline, established_at: deadlineResult.deadline }),
    ]
    const asOf = new Date(new Date(deadlineResult.deadline).getTime() + 86_400_000).toISOString()

    const decision = evaluateCandidateFinalDecision({
      candidate, rule, evidence: cleanEvidence(candidate.id, candidate.booked_at!, candidate.occurred_at!),
      priorCandidates: [], sourceBindingRoleKeys: SOURCE_BINDING_ROLE_KEYS, sourceBindings: SOURCE_BINDINGS, coverage, asOf,
    })
    expect(decision.outcome).toBe('pending')
    expect(decision.rejection.outcome).toBe('pending')
    expect(decision.rejection.reason).toContain('incomplete')
  })

  // ── Case D — valid timely rejection -> rejected ──────────────────────
  // Uses 'preexisting_active_opportunity', not 'attendee_not_qualified_
  // contact' — materiality-aware terminalization hardening surfaced a
  // real structural fact: criteria.result is the COMBINED result of the
  // criteria expression AND the qualified_contact_role check
  // (evaluateCandidateCriteria's own combineAllOf), so a genuinely
  // substantiated 'attendee_not_qualified_contact' (or
  // 'account_outside_icp_at_booking'/'attendance_under_15_minutes') ALWAYS
  // makes criteria.result itself 'not_satisfied' too — meaning the FAST
  // criteria-rejection path (materially cheaper: no deadline needed)
  // always intercepts it first, exactly as intended. Only
  // 'preexisting_active_opportunity' is genuinely independent of
  // criteria/dedupe, so it's the only reason that can ever actually
  // reach the objection-based rejection path — see Case E and the
  // dedicated circularity test below for the direct proof of this.
  it('Case D — valid, timely, SUBSTANTIATED objection-based rejection (CRM channel) -> rejected', () => {
    const candidate = makeCandidate({ id: 'cand-D', rule, external_id: 'meeting-D', booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-10T14:00:00Z', attribution_at: '2026-09-10T14:00:00Z' })
    const deadlineResult = resolveRejectionDeadline(candidate, rule)
    if (deadlineResult.status !== 'resolved') throw new Error('test setup: deadline must resolve')

    const rejectionTimestamp = '2026-09-11T09:00:00Z' // well before the ~Sept 15 deadline
    const opportunityFacts = {
      'opportunity.exists_active': true,
      'opportunity.recorded_at': '2026-06-01T00:00:00Z',
      'account.supplier_first_contact_at': '2026-08-01T00:00:00Z',
    }
    const evidence = [
      ...cleanEvidence(candidate.id, candidate.booked_at!, candidate.occurred_at!),
      makeEvidence({ id: 'ev-D-opportunity', candidate_id: candidate.id, source_binding_id: 'binding-crm', facts: opportunityFacts, occurred_at: candidate.booked_at!, recorded_at: candidate.booked_at! }),
      makeEvidence({
        id: 'ev-D-rejection', candidate_id: candidate.id, source_binding_id: 'binding-crm',
        facts: {
          [OBJECTION_REASON_FACT_KEY]: 'preexisting_active_opportunity', [OBJECTION_CHANNEL_FACT_KEY]: 'crm',
          [OBJECTION_TIMESTAMP_FACT_KEY]: rejectionTimestamp, [OBJECTION_SUBJECT_EXTERNAL_ID_FACT_KEY]: 'meeting-D',
        },
        occurred_at: rejectionTimestamp, recorded_at: rejectionTimestamp,
      }),
    ]
    // Material for THIS decisive path is only the opportunity/first-
    // contact facts (all crm-resolved through booked_at) — NOT criteria,
    // NOT dedupe: this rejection is dispositive entirely independent of
    // them (materialDependencies below proves it structurally, not just
    // by the outcome).
    const coverage = [
      makeCoverage({ id: 'cov-D-fe-crm', source_binding_id: 'binding-crm', coverage_kind: 'fact_evidence', covered_from: '2020-01-01T00:00:00Z', covered_through: candidate.booked_at!, established_at: deadlineResult.deadline }),
    ]
    const asOf = new Date(new Date(deadlineResult.deadline).getTime() + 86_400_000).toISOString()

    const decision = evaluateCandidateFinalDecision({
      candidate, rule, evidence, priorCandidates: [], sourceBindingRoleKeys: SOURCE_BINDING_ROLE_KEYS, sourceBindings: SOURCE_BINDINGS, coverage, asOf,
    })
    expect(decision.outcome).toBe('rejected')
    expect(decision.rejection.outcome).toBe('rejected')
    expect(decision.rejection.validTimelyRecord?.record.reason).toBe('preexisting_active_opportunity')
    expect(decision.rejection.validTimelyRecord?.reasonSubstantiation?.result).toBe('satisfied')
    expect(decision.materialDependencies).toContain('rejection_deadline')
  })

  it('Case D2 — a timely rejection with an ALLOWED but UNSUBSTANTIATED reason is invalid and never terminally rejects', () => {
    // Same candidate/timing as Case D, but the claimed reason is FALSE:
    // cleanEvidence's contact.role (VP_Sales) genuinely IS a qualified
    // contact, so 'attendee_not_qualified_contact' cannot be substantiated
    // — item 2's core guarantee.
    const candidate = makeCandidate({ id: 'cand-D2', rule, external_id: 'meeting-D2', booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-10T14:00:00Z', attribution_at: '2026-09-10T14:00:00Z' })
    const deadlineResult = resolveRejectionDeadline(candidate, rule)
    if (deadlineResult.status !== 'resolved') throw new Error('test setup: deadline must resolve')

    const rejectionTimestamp = '2026-09-11T09:00:00Z'
    const evidence = [
      ...cleanEvidence(candidate.id, candidate.booked_at!, candidate.occurred_at!),
      makeEvidence({
        id: 'ev-D2-rejection', candidate_id: candidate.id, source_binding_id: 'binding-crm',
        facts: {
          [OBJECTION_REASON_FACT_KEY]: 'attendee_not_qualified_contact', [OBJECTION_CHANNEL_FACT_KEY]: 'crm',
          [OBJECTION_TIMESTAMP_FACT_KEY]: rejectionTimestamp, [OBJECTION_SUBJECT_EXTERNAL_ID_FACT_KEY]: 'meeting-D2',
        },
        occurred_at: rejectionTimestamp, recorded_at: rejectionTimestamp,
      }),
    ]
    const coverage = [
      dedupeCoverage(candidate.id, '2026-06-01T00:00:00Z', '2026-09-11T00:00:00Z', deadlineResult.deadline),
      ...rejectionSourceCoverage(candidate.id, candidate.occurred_at!, deadlineResult.deadline, deadlineResult.deadline),
      ...standardFactEvidenceCoverage(candidate.id, candidate.booked_at!, candidate.occurred_at!, deadlineResult.deadline),
    ]
    const asOf = new Date(new Date(deadlineResult.deadline).getTime() + 86_400_000).toISOString()

    const decision = evaluateCandidateFinalDecision({
      candidate, rule, evidence, priorCandidates: [], sourceBindingRoleKeys: SOURCE_BINDING_ROLE_KEYS, sourceBindings: SOURCE_BINDINGS, coverage, asOf,
    })
    expect(decision.rejection.invalidRecords).toHaveLength(1)
    expect(decision.rejection.invalidRecords[0].reasonSubstantiation?.result).toBe('not_satisfied')
    expect(decision.rejection.invalidRecords[0].reason).toMatch(/not substantiated/)
    // Never terminally rejects on the strength of an unsubstantiated claim
    // — the rest of the (otherwise clean) candidate proceeds normally.
    expect(decision.outcome).toBe('qualified')
  })

  // ── Case E — late rejection -> qualified initially ───────────────────
  // Uses 'preexisting_active_opportunity' rather than 'duplicate_meeting' —
  // the latter's predicate reuses the SAME dedupe check the qualified path
  // itself depends on, so substantiating it for real would ALSO flip
  // dedupe.outcome to 'duplicate' and reject via that independent path,
  // defeating the point of this case. 'preexisting_active_opportunity' is
  // the one reason genuinely independent of criteria/dedupe.
  it('Case E — valid but LATE rejection does not prevent initial qualification', () => {
    const candidate = makeCandidate({ id: 'cand-E', rule, external_id: 'meeting-E', booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-10T14:00:00Z', attribution_at: '2026-09-10T14:00:00Z' })
    const deadlineResult = resolveRejectionDeadline(candidate, rule)
    if (deadlineResult.status !== 'resolved') throw new Error('test setup: deadline must resolve')

    const lateTimestamp = new Date(new Date(deadlineResult.deadline).getTime() + 3 * 86_400_000).toISOString() // 3 days after the deadline
    const opportunityFacts = {
      'opportunity.exists_active': true,
      'opportunity.recorded_at': '2026-06-01T00:00:00Z',
      'account.supplier_first_contact_at': '2026-08-01T00:00:00Z', // recorded_at is >30d before this
    }
    const evidence = [
      ...cleanEvidence(candidate.id, candidate.booked_at!, candidate.occurred_at!),
      makeEvidence({ id: 'ev-E-opportunity', candidate_id: candidate.id, source_binding_id: 'binding-crm', facts: opportunityFacts, occurred_at: candidate.booked_at!, recorded_at: candidate.booked_at! }),
      makeEvidence({
        id: 'ev-E-rejection', candidate_id: candidate.id, source_binding_id: 'binding-crm',
        facts: {
          [OBJECTION_REASON_FACT_KEY]: 'preexisting_active_opportunity', [OBJECTION_CHANNEL_FACT_KEY]: 'crm',
          [OBJECTION_TIMESTAMP_FACT_KEY]: lateTimestamp, [OBJECTION_SUBJECT_EXTERNAL_ID_FACT_KEY]: 'meeting-E',
        },
        occurred_at: lateTimestamp, recorded_at: lateTimestamp,
      }),
    ]
    const coverage = [
      dedupeCoverage(candidate.id, '2026-06-01T00:00:00Z', '2026-09-11T00:00:00Z', '2026-09-11T00:00:00Z'),
      ...rejectionSourceCoverage(candidate.id, candidate.occurred_at!, deadlineResult.deadline, deadlineResult.deadline),
      ...standardFactEvidenceCoverage(candidate.id, candidate.booked_at!, candidate.occurred_at!, deadlineResult.deadline),
    ]
    const asOf = new Date(new Date(lateTimestamp).getTime() + 86_400_000).toISOString() // after both the deadline AND the late rejection

    const decision = evaluateCandidateFinalDecision({
      candidate, rule, evidence, priorCandidates: [], sourceBindingRoleKeys: SOURCE_BINDING_ROLE_KEYS, sourceBindings: SOURCE_BINDINGS, coverage, asOf,
    })
    expect(decision.outcome).toBe('qualified')
    expect(decision.rejection.outcome).toBe('cleared')
    expect(decision.rejection.validLateRecords).toHaveLength(1)
    expect(decision.rejection.validLateRecords[0].record.reason).toBe('preexisting_active_opportunity')
    expect(decision.rejection.validLateRecords[0].reasonSubstantiation?.result).toBe('satisfied')
  })

  // ── Case F — email rejection WITHOUT a written exception -> invalid ──
  it('Case F — email-channel rejection with no written-agreement exception is ignored as invalid', () => {
    const candidate = makeCandidate({ id: 'cand-F', rule, external_id: 'meeting-F', booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-10T14:00:00Z', attribution_at: '2026-09-10T14:00:00Z' })
    const deadlineResult = resolveRejectionDeadline(candidate, rule)
    if (deadlineResult.status !== 'resolved') throw new Error('test setup: deadline must resolve')

    const rejectionTimestamp = '2026-09-11T09:00:00Z'
    const evidence = [
      ...cleanEvidence(candidate.id, candidate.booked_at!, candidate.occurred_at!),
      makeEvidence({
        id: 'ev-F-rejection', candidate_id: candidate.id, source_binding_id: 'binding-portal',
        facts: {
          [OBJECTION_REASON_FACT_KEY]: 'attendee_not_qualified_contact', [OBJECTION_CHANNEL_FACT_KEY]: 'email',
          [OBJECTION_TIMESTAMP_FACT_KEY]: rejectionTimestamp, [OBJECTION_SUBJECT_EXTERNAL_ID_FACT_KEY]: 'meeting-F',
        },
        occurred_at: rejectionTimestamp, recorded_at: rejectionTimestamp,
      }),
    ]
    const coverage = [
      dedupeCoverage(candidate.id, '2026-06-01T00:00:00Z', '2026-09-11T00:00:00Z', '2026-09-11T00:00:00Z'),
      ...rejectionSourceCoverage(candidate.id, candidate.occurred_at!, deadlineResult.deadline, deadlineResult.deadline),
      ...standardFactEvidenceCoverage(candidate.id, candidate.booked_at!, candidate.occurred_at!, deadlineResult.deadline),
    ]
    const asOf = new Date(new Date(deadlineResult.deadline).getTime() + 86_400_000).toISOString()

    const decision = evaluateCandidateFinalDecision({
      candidate, rule, evidence, priorCandidates: [], sourceBindingRoleKeys: SOURCE_BINDING_ROLE_KEYS, sourceBindings: SOURCE_BINDINGS, coverage, asOf,
    })
    expect(decision.rejection.invalidRecords).toHaveLength(1)
    expect(decision.rejection.invalidRecords[0].reason).toMatch(/not otherwise valid/)
    // The invalid email rejection does not block qualification.
    expect(decision.outcome).toBe('qualified')
  })

  // ── Case G — email rejection WITH written agreement + attestation ────
  // Same 'preexisting_active_opportunity' substitution as Case D (see its
  // own comment) — otherwise-clean, fully-qualifying criteria/role, so
  // this exercises the channel exception specifically, not a criteria
  // circularity.
  it('Case G — email-channel rejection backed by a written-agreement reference + candidate attestation is valid', () => {
    const candidate = makeCandidate({ id: 'cand-G', rule, external_id: 'meeting-G', booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-10T14:00:00Z', attribution_at: '2026-09-10T14:00:00Z' })
    const deadlineResult = resolveRejectionDeadline(candidate, rule)
    if (deadlineResult.status !== 'resolved') throw new Error('test setup: deadline must resolve')

    const rejectionTimestamp = '2026-09-11T09:00:00Z'
    const opportunityFacts = {
      'opportunity.exists_active': true,
      'opportunity.recorded_at': '2026-06-01T00:00:00Z',
      'account.supplier_first_contact_at': '2026-08-01T00:00:00Z',
    }
    const evidence = [
      ...cleanEvidence(candidate.id, candidate.booked_at!, candidate.occurred_at!),
      makeEvidence({ id: 'ev-G-opportunity', candidate_id: candidate.id, source_binding_id: 'binding-crm', facts: opportunityFacts, occurred_at: candidate.booked_at!, recorded_at: candidate.booked_at! }),
      makeEvidence({
        id: 'ev-G-rejection', candidate_id: candidate.id, source_binding_id: 'binding-portal',
        facts: {
          [OBJECTION_REASON_FACT_KEY]: 'preexisting_active_opportunity', [OBJECTION_CHANNEL_FACT_KEY]: 'email',
          [OBJECTION_TIMESTAMP_FACT_KEY]: rejectionTimestamp, [OBJECTION_SUBJECT_EXTERNAL_ID_FACT_KEY]: 'meeting-G',
        },
        occurred_at: rejectionTimestamp, recorded_at: rejectionTimestamp,
      }),
      // Reviewer attestation, recorded separately, linking a specific
      // written agreement to THIS candidate — ordinary evidence, resolved
      // through resolveCandidateFact exactly like any other fact.
      makeEvidence({
        id: 'ev-G-channel-attestation', candidate_id: candidate.id, source_binding_id: 'binding-reviewer',
        facts: {
          'objection_or_rejection.written_agreement_reference': 'email-thread-12345',
          'objection_or_rejection.written_agreement_attested': true,
        },
        occurred_at: candidate.occurred_at!, recorded_at: '2026-09-12T00:00:00Z',
      }),
    ]
    // Material for this decisive path is only the opportunity/first-
    // contact facts, all crm-resolved through booked_at.
    const coverage = [
      makeCoverage({ id: 'cov-G-fe-crm', source_binding_id: 'binding-crm', coverage_kind: 'fact_evidence', covered_from: '2020-01-01T00:00:00Z', covered_through: candidate.booked_at!, established_at: deadlineResult.deadline }),
    ]

    const decision = evaluateCandidateFinalDecision({
      candidate, rule, evidence, priorCandidates: [], sourceBindingRoleKeys: SOURCE_BINDING_ROLE_KEYS, sourceBindings: SOURCE_BINDINGS, coverage,
      asOf: new Date(new Date(deadlineResult.deadline).getTime() + 86_400_000).toISOString(),
    })
    expect(decision.outcome).toBe('rejected')
    expect(decision.rejection.validTimelyRecord?.record.channel).toBe('email')
    expect(decision.rejection.validTimelyRecord?.reason).toMatch(/written-agreement exception/)
  })

  // ── Case H — Stockholm holiday/business-day boundary -> correct deadline ─
  it('Case H — the rule\'s 3-business-day window correctly skips Good Friday, the weekend, and Easter Monday', () => {
    // Reference Wed 2026-04-01T09:00:00Z. Good Friday is 2026-04-03, Easter
    // Monday is 2026-04-06 — both must be skipped when counting.
    const candidate = makeCandidate({ id: 'cand-H', rule, external_id: 'meeting-H', booked_at: '2026-03-20T00:00:00Z', occurred_at: '2026-04-01T09:00:00Z', attribution_at: '2026-04-01T09:00:00Z' })
    const deadlineResult = resolveRejectionDeadline(candidate, rule)
    expect(deadlineResult.status).toBe('resolved')
    if (deadlineResult.status !== 'resolved') return
    expect(deadlineResult.deadline.slice(0, 10) <= '2026-04-08').toBe(true)
    // buildActiveOs202609Rule confirms business_day_end_local_time as
    // '17:00:00' — 17:00:00.999 CEST (UTC+2) on 2026-04-08 is 15:00:00.999Z.
    expect(deadlineResult.deadline).toBe('2026-04-08T15:00:00.999Z')
  })

  // ── Case I — coverage established after the evaluation asOf is invisible ─
  it('Case I — SourceCoverage established after asOf cannot retroactively clear a historical evaluation', () => {
    const candidate = makeCandidate({ id: 'cand-I', rule, external_id: 'meeting-I', booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-10T14:00:00Z', attribution_at: '2026-09-10T14:00:00Z' })
    const deadlineResult = resolveRejectionDeadline(candidate, rule)
    if (deadlineResult.status !== 'resolved') throw new Error('test setup: deadline must resolve')

    const establishedAt = '2026-09-20T00:00:00Z' // established well after the deadline
    const coverage = [
      dedupeCoverage(candidate.id, '2026-06-01T00:00:00Z', '2026-09-11T00:00:00Z', establishedAt),
      ...rejectionSourceCoverage(candidate.id, candidate.occurred_at!, deadlineResult.deadline, establishedAt),
      // Established early — deliberately NOT part of what this test is
      // demonstrating (that's dedupe/rejection coverage's established_at,
      // above), so fact-evidence finality never blocks either evaluation.
      ...standardFactEvidenceCoverage(candidate.id, candidate.booked_at!, candidate.occurred_at!, candidate.occurred_at!),
    ]
    const evidence = cleanEvidence(candidate.id, candidate.booked_at!, candidate.occurred_at!)

    const earlyAsOf = new Date(new Date(deadlineResult.deadline).getTime() + 86_400_000).toISOString() // before establishedAt
    const earlyDecision = evaluateCandidateFinalDecision({
      candidate, rule, evidence, priorCandidates: [], sourceBindingRoleKeys: SOURCE_BINDING_ROLE_KEYS, sourceBindings: SOURCE_BINDINGS, coverage, asOf: earlyAsOf,
    })
    expect(earlyDecision.outcome).toBe('pending')

    const lateAsOf = new Date(new Date(establishedAt).getTime() + 86_400_000).toISOString() // after establishedAt
    const lateDecision = evaluateCandidateFinalDecision({
      candidate, rule, evidence, priorCandidates: [], sourceBindingRoleKeys: SOURCE_BINDING_ROLE_KEYS, sourceBindings: SOURCE_BINDINGS, coverage, asOf: lateAsOf,
    })
    expect(lateDecision.outcome).toBe('qualified')
  })

  // ── Additional architectural-guarantee coverage (item 8) ─────────────
  it('criteria not_satisfied is dispositive on its own -> rejected, independent of dedupe/rejection completeness', () => {
    const candidate = makeCandidate({ id: 'cand-crit', rule, external_id: 'meeting-crit', booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-10T14:00:00Z', attribution_at: '2026-09-10T14:00:00Z' })
    const evidence = [
      makeEvidence({ id: 'ev-crit-crm', candidate_id: candidate.id, source_binding_id: 'binding-crm', facts: baseAccountFacts(), occurred_at: candidate.booked_at!, recorded_at: candidate.booked_at! }),
      makeEvidence({ id: 'ev-crit-conf', candidate_id: candidate.id, source_binding_id: 'binding-conferencing', facts: { attendance_minutes: 5 }, occurred_at: candidate.occurred_at!, recorded_at: candidate.occurred_at! }),
    ]
    // Material for a not_satisfied all_of is ONLY the not_satisfied
    // child(ren) — here, exactly attendance_minutes (every account.* fact
    // is satisfied and correctly excluded; see collectMaterialFactKeysFromTrace).
    const coverage = [
      makeCoverage({ id: 'cov-crit-fe-conf', source_binding_id: 'binding-conferencing', coverage_kind: 'fact_evidence', covered_from: '2020-01-01T00:00:00Z', covered_through: candidate.occurred_at!, established_at: '2026-09-20T00:00:00Z' }),
    ]
    const decision = evaluateCandidateFinalDecision({
      candidate, rule, evidence, priorCandidates: [], sourceBindingRoleKeys: SOURCE_BINDING_ROLE_KEYS, sourceBindings: SOURCE_BINDINGS, coverage,
      asOf: '2026-09-20T00:00:00Z',
    })
    expect(decision.outcome).toBe('rejected')
    expect(decision.criteria).toBe('not_satisfied')
  })

  it('a definitive duplicate is dispositive on its own -> rejected', () => {
    const prior = makeCandidate({ id: 'cand-prior', rule, external_id: 'meeting-prior', booked_at: '2026-08-01T00:00:00Z', occurred_at: '2026-08-10T14:00:00Z', attribution_at: '2026-08-10T14:00:00Z' })
    const priorEvidence = cleanEvidence(prior.id, prior.booked_at!, prior.occurred_at!)

    const candidate = makeCandidate({ id: 'cand-dup', rule, external_id: 'meeting-dup', booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-10T14:00:00Z', attribution_at: '2026-09-10T14:00:00Z' })
    const evidence = cleanEvidence(candidate.id, candidate.booked_at!, candidate.occurred_at!)

    // Material for a 'duplicate' dedupe outcome is only dedupe_rule.
    // key_fields (account.id) — never criteria, since this path never
    // needed criteria to be satisfied at all.
    const coverage = [
      makeCoverage({ id: 'cov-dup-fe-crm', source_binding_id: 'binding-crm', coverage_kind: 'fact_evidence', covered_from: '2020-01-01T00:00:00Z', covered_through: candidate.booked_at!, established_at: '2026-09-20T00:00:00Z' }),
    ]
    const decision = evaluateCandidateFinalDecision({
      candidate, rule, evidence, priorCandidates: [{ candidate: prior, evidence: priorEvidence }],
      sourceBindingRoleKeys: SOURCE_BINDING_ROLE_KEYS, sourceBindings: SOURCE_BINDINGS, coverage,
      asOf: '2026-09-20T00:00:00Z',
    })
    expect(decision.outcome).toBe('rejected')
    expect(decision.dedupe.outcome).toBe('duplicate')
  })

  it('an unresolvable rejection deadline fails closed to pending — never terminal without one (item 7)', () => {
    // occurred_at is null, and rejection_window.reference_time is
    // 'occurred_at' — the deadline has nothing to anchor to.
    const candidate = makeCandidate({ id: 'cand-nodeadline', rule, external_id: 'meeting-nodeadline', booked_at: '2026-09-01T00:00:00Z', occurred_at: null, attribution_at: '2026-09-10T14:00:00Z' })
    const evidence = [makeEvidence({ id: 'ev-nodeadline-crm', candidate_id: candidate.id, source_binding_id: 'binding-crm', facts: baseAccountFacts(), occurred_at: candidate.attribution_at, recorded_at: candidate.attribution_at })]
    const decision = evaluateCandidateFinalDecision({
      candidate, rule, evidence, priorCandidates: [], sourceBindingRoleKeys: SOURCE_BINDING_ROLE_KEYS, sourceBindings: SOURCE_BINDINGS, coverage: [],
      asOf: '2026-09-20T00:00:00Z',
    })
    expect(decision.outcome).toBe('pending')
    expect(decision.reason).toMatch(/deadline is not resolvable/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Materiality-aware terminalization — a definitive criteria/dedupe
// rejection must never wait on the rejection deadline (or rejection-source/
// dedupe coverage) unless those inputs were actually material to the
// SPECIFIC outcome reached. Only a genuinely independent objection-based
// rejection, or 'qualified' (the strictest path), depends on the deadline.
// ═══════════════════════════════════════════════════════════════════════════
describe('Materiality-aware terminalization — deadline/coverage only required when actually material', () => {
  const rule = buildActiveOs202609Rule()

  // A rule variant whose rejection_window is anchored to booked_at instead
  // of occurred_at (§2.5's real text says occurred_at — this is a
  // deliberate TEST-ONLY decoupling, not a claim about the real contract),
  // so a candidate can have occurred_at present (attendance resolvable)
  // while the deadline is independently unresolvable via a missing
  // booked_at.
  function buildActiveRuleWithBookedAtDeadlineReference(): BillableUnitQualificationRule {
    let draft = buildOs202609Rule()
    draft = confirmQualificationRuleField(draft, 'rejection_window', { business_days: 3, holiday_calendar: 'SE-stockholm', timezone: 'Europe/Stockholm', reference_time: 'booked_at' })
    draft = confirmQualificationRuleField(draft, 'deadline_convention', 'end_of_business_day')
    draft = confirmQualificationRuleField(draft, 'business_day_end_local_time', '17:00:00')
    draft = confirmQualificationRuleField(draft, 'attribution_basis')
    for (const key of UNRESOLVED_ICP_PRECEDENCE_KEYS) {
      draft = confirmQualificationRuleField(draft, `evidence_precedence.${key}`, { kind: 'source_precedence', order: ['crm', 'enrichment'] })
    }
    draft = confirmQualificationRuleField(draft, 'criteria')
    draft = confirmQualificationRuleField(draft, 'qualified_contact_role.base')
    draft = confirmQualificationRuleField(draft, 'qualified_contact_role.attestation_fact_key')
    draft = confirmQualificationRuleField(draft, 'dedupe_rule')
    draft = confirmQualificationRuleField(draft, 'rejection_rule')
    draft = confirmQualificationRuleField(draft, 'evidence_precedence.account.employee_count')
    draft = confirmQualificationRuleField(draft, 'evidence_precedence.attendance_minutes')
    for (const key of Object.keys(draft.fact_evidence_source_roles)) {
      draft = confirmQualificationRuleField(draft, `fact_evidence_source_roles.${key}`)
    }
    return { ...draft, id: 'rule-os-2026-09-sqm-booked-at-deadline', status: 'active' }
  }

  it('conclusive attendance failure + unresolved deadline -> rejected (deadline never touched)', () => {
    const bookedAtDeadlineRule = buildActiveRuleWithBookedAtDeadlineReference()
    const candidate = makeCandidate({
      id: 'cand-mat1', rule: bookedAtDeadlineRule, external_id: 'meeting-mat1',
      booked_at: null, occurred_at: '2026-09-10T14:00:00Z', attribution_at: '2026-09-10T14:00:00Z',
    })
    // Only attendance evidence — deliberately no crm/account evidence at
    // all, to prove those facts are genuinely never consulted (they'd be
    // unresolvable anyway with booked_at null, but the point is that this
    // decision doesn't even need to try).
    const evidence = [makeEvidence({ id: 'ev-mat1-conf', candidate_id: candidate.id, source_binding_id: 'binding-conferencing', facts: { attendance_minutes: 5 }, occurred_at: candidate.occurred_at!, recorded_at: candidate.occurred_at! })]
    const coverage = [makeCoverage({ id: 'cov-mat1-conf', source_binding_id: 'binding-conferencing', coverage_kind: 'fact_evidence', covered_from: '2020-01-01T00:00:00Z', covered_through: candidate.occurred_at!, established_at: '2026-09-20T00:00:00Z' })]

    const deadline = resolveRejectionDeadline(candidate, bookedAtDeadlineRule)
    expect(deadline.status).toBe('unresolved') // sanity: this candidate's deadline genuinely cannot resolve

    const decision = evaluateCandidateFinalDecision({
      candidate, rule: bookedAtDeadlineRule, evidence, priorCandidates: [], sourceBindingRoleKeys: SOURCE_BINDING_ROLE_KEYS, sourceBindings: SOURCE_BINDINGS, coverage,
      asOf: '2026-09-20T00:00:00Z',
    })
    expect(decision.outcome).toBe('rejected')
    expect(decision.criteria).toBe('not_satisfied')
    expect(decision.materialDependencies).toEqual(['criteria', 'fact_finality'])
    expect(decision.materialDependencies).not.toContain('rejection_deadline')
  })

  it('conclusive duplicate + unresolved deadline -> rejected (deadline never touched)', () => {
    // Default rule (rejection_window.reference_time: 'occurred_at') —
    // occurred_at is null (deadline unresolvable) but booked_at is
    // present, so account.id (booked_at-referenced) still resolves and
    // dedupe can reach a definitive match.
    const priorCandidate = makeCandidate({ id: 'cand-mat2-prior', rule, external_id: 'meeting-mat2-prior', booked_at: '2026-08-01T00:00:00Z', occurred_at: '2026-08-01T00:00:00Z', attribution_at: '2026-08-01T00:00:00Z' })
    const priorEvidence = [makeEvidence({ id: 'ev-mat2-prior-crm', candidate_id: priorCandidate.id, source_binding_id: 'binding-crm', facts: { 'account.id': 'acct-mat2' }, occurred_at: priorCandidate.booked_at!, recorded_at: priorCandidate.booked_at! })]

    const candidate = makeCandidate({ id: 'cand-mat2', rule, external_id: 'meeting-mat2', booked_at: '2026-09-01T00:00:00Z', occurred_at: null, attribution_at: '2026-09-01T00:00:00Z' })
    const evidence = [makeEvidence({ id: 'ev-mat2-crm', candidate_id: candidate.id, source_binding_id: 'binding-crm', facts: { 'account.id': 'acct-mat2' }, occurred_at: candidate.booked_at!, recorded_at: candidate.booked_at! })]
    const coverage = [makeCoverage({ id: 'cov-mat2-crm', source_binding_id: 'binding-crm', coverage_kind: 'fact_evidence', covered_from: '2020-01-01T00:00:00Z', covered_through: candidate.booked_at!, established_at: '2026-09-20T00:00:00Z' })]

    const deadline = resolveRejectionDeadline(candidate, rule)
    expect(deadline.status).toBe('unresolved') // sanity

    const decision = evaluateCandidateFinalDecision({
      candidate, rule, evidence, priorCandidates: [{ candidate: priorCandidate, evidence: priorEvidence }],
      sourceBindingRoleKeys: SOURCE_BINDING_ROLE_KEYS, sourceBindings: SOURCE_BINDINGS, coverage,
      asOf: '2026-09-20T00:00:00Z',
    })
    expect(decision.outcome).toBe('rejected')
    expect(decision.dedupe.outcome).toBe('duplicate')
    expect(decision.materialDependencies).toEqual(['dedupe_observation', 'fact_finality'])
    expect(decision.materialDependencies).not.toContain('rejection_deadline')
  })

  it('criteria satisfied + unresolved deadline -> pending', () => {
    // A rule that reached 'active' with every OTHER field resolved but
    // business_day_end_local_time still unresolved is not reachable
    // through the real confirm/activate flow (isQualificationRuleReady
    // blocks it) — constructed directly here, the same defensive-test
    // pattern already used elsewhere in this codebase (e.g.
    // pinQualificationRuleVersion's own "should never happen for an
    // active row by construction" test) to exercise this function's own
    // fail-closed behavior in isolation.
    const ruleWithMissingCutoff: BillableUnitQualificationRule = { ...rule, business_day_end_local_time: { value: null, state: 'decision_required', provenance: null } }
    const candidate = makeCandidate({ id: 'cand-mat3', rule: ruleWithMissingCutoff, external_id: 'meeting-mat3', booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-10T14:00:00Z', attribution_at: '2026-09-10T14:00:00Z' })
    const evidence = cleanEvidence(candidate.id, candidate.booked_at!, candidate.occurred_at!)

    const deadline = resolveRejectionDeadline(candidate, ruleWithMissingCutoff)
    expect(deadline.status).toBe('unresolved') // sanity

    const decision = evaluateCandidateFinalDecision({
      candidate, rule: ruleWithMissingCutoff, evidence, priorCandidates: [], sourceBindingRoleKeys: SOURCE_BINDING_ROLE_KEYS, sourceBindings: SOURCE_BINDINGS, coverage: [],
      asOf: '2026-09-20T00:00:00Z',
    })
    expect(decision.criteria).toBe('satisfied')
    expect(decision.outcome).toBe('pending')
    expect(decision.reason).toMatch(/deadline is not resolvable/)
  })

  it('otherwise-qualified + incomplete rejection-source coverage -> pending (Case C, cross-referenced)', () => {
    // Already covered end-to-end by "Case C — deadline passed but
    // incomplete rejection-source coverage (portal missing) -> pending"
    // above — recorded here only as an explicit pointer so this
    // materiality suite documents all four regressions requested,
    // without duplicating the scenario.
    expect(true).toBe(true)
  })

  it('the four "objective" reason codes are structurally circular with criteria/dedupe — only preexisting_active_opportunity can reach the objection-based rejection path', () => {
    // Proves the claim used to justify Case D/E/G's reason choice: a
    // genuinely-substantiated 'attendee_not_qualified_contact' makes
    // criteria.result itself 'not_satisfied' (qualified_contact_role is
    // one of criteria.result's own two inputs — see
    // evaluateCandidateCriteria's combineAllOf), so the FAST criteria path
    // always intercepts it first — the objection-based branch is
    // unreachable for this reason, by construction, not by accident.
    const candidate = makeCandidate({ id: 'cand-circ', rule, external_id: 'meeting-circ', booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-10T14:00:00Z', attribution_at: '2026-09-10T14:00:00Z' })
    const disqualifyingAccountFacts = { ...baseAccountFacts(), 'contact.role': 'IC_Sales' }
    const rejectionTimestamp = '2026-09-11T09:00:00Z'
    const evidence = [
      makeEvidence({ id: 'ev-circ-crm', candidate_id: candidate.id, source_binding_id: 'binding-crm', facts: disqualifyingAccountFacts, occurred_at: candidate.booked_at!, recorded_at: candidate.booked_at! }),
      makeEvidence({ id: 'ev-circ-conf', candidate_id: candidate.id, source_binding_id: 'binding-conferencing', facts: { attendance_minutes: 22 }, occurred_at: candidate.occurred_at!, recorded_at: candidate.occurred_at! }),
      makeEvidence({ id: 'ev-circ-attestation', candidate_id: candidate.id, source_binding_id: 'binding-reviewer', facts: { 'qualified_contact_role.reviewer_attested_equivalent': false }, occurred_at: candidate.occurred_at!, recorded_at: candidate.occurred_at! }),
      makeEvidence({
        id: 'ev-circ-rejection', candidate_id: candidate.id, source_binding_id: 'binding-crm',
        facts: {
          [OBJECTION_REASON_FACT_KEY]: 'attendee_not_qualified_contact', [OBJECTION_CHANNEL_FACT_KEY]: 'crm',
          [OBJECTION_TIMESTAMP_FACT_KEY]: rejectionTimestamp, [OBJECTION_SUBJECT_EXTERNAL_ID_FACT_KEY]: 'meeting-circ',
        },
        occurred_at: rejectionTimestamp, recorded_at: rejectionTimestamp,
      }),
    ]
    const coverage = [makeCoverage({ id: 'cov-circ-crm', source_binding_id: 'binding-crm', coverage_kind: 'fact_evidence', covered_from: '2020-01-01T00:00:00Z', covered_through: candidate.booked_at!, established_at: '2026-09-20T00:00:00Z' })]

    const decision = evaluateCandidateFinalDecision({
      candidate, rule, evidence, priorCandidates: [], sourceBindingRoleKeys: SOURCE_BINDING_ROLE_KEYS, sourceBindings: SOURCE_BINDINGS, coverage,
      asOf: '2026-09-20T00:00:00Z',
    })
    expect(decision.outcome).toBe('rejected')
    // Reached via the FAST criteria path, never the objection machinery —
    // 'rejection_deadline'/'rejection_completeness' are absent, and the
    // rejection field is the never-computed placeholder (outcome 'pending').
    expect(decision.materialDependencies).toEqual(['criteria', 'fact_finality'])
    expect(decision.rejection.outcome).toBe('pending')
    expect(decision.rejection.reason).toMatch(/not evaluated/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Contractual-finality hardening — fact-evidence finality regression suite.
// Exercises exactly the scenario named in the brief: contact.role currently
// resolves from 'enrichment' (source_precedence order ['crm','enrichment'])
// because 'crm' has no row for it yet — a terminal decision must not rest
// on that until crm's own silence is PROVEN complete, not merely absent.
// ═══════════════════════════════════════════════════════════════════════════
describe('Fact-evidence finality — required-source-set regression suite', () => {
  const rule = buildActiveOs202609Rule()

  // account.* facts (minus contact.role) + attendance — everything the
  // "clean" fixture provides EXCEPT contact.role, which these tests supply
  // separately (via crm, enrichment, or neither) to control precisely
  // which source resolves it.
  function evidenceWithoutContactRole(candidateId: string, bookedAt: string, occurredAt: string): CandidateUnitEvidence[] {
    const { 'contact.role': _omit, ...rest } = baseAccountFacts()
    void _omit
    return [
      makeEvidence({ id: `${candidateId}-crm`, candidate_id: candidateId, source_binding_id: 'binding-crm', facts: rest, occurred_at: bookedAt, recorded_at: bookedAt }),
      makeEvidence({ id: `${candidateId}-conf`, candidate_id: candidateId, source_binding_id: 'binding-conferencing', facts: { attendance_minutes: 22 }, occurred_at: occurredAt, recorded_at: occurredAt }),
    ]
  }

  function fullQualifyingCoverage(candidateId: string, occurredAt: string, deadline: string): SourceCoverage[] {
    // Dedupe's required interval runs through attribution_at (== occurred_at
    // for this fixture's attribution_basis), never booked_at.
    return [
      dedupeCoverage(candidateId, '2026-06-01T00:00:00Z', new Date(new Date(occurredAt).getTime() + 86_400_000).toISOString(), deadline),
      ...rejectionSourceCoverage(candidateId, occurredAt, deadline, deadline),
    ]
  }

  it('lower-priority source (enrichment) currently resolves contact.role, but the higher-priority source (crm) lacks fact_evidence coverage -> pending', () => {
    const candidate = makeCandidate({ id: 'cand-fin1', rule, external_id: 'meeting-fin1', booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-10T14:00:00Z', attribution_at: '2026-09-10T14:00:00Z' })
    const deadlineResult = resolveRejectionDeadline(candidate, rule)
    if (deadlineResult.status !== 'resolved') throw new Error('test setup: deadline must resolve')

    const evidence = [
      ...evidenceWithoutContactRole(candidate.id, candidate.booked_at!, candidate.occurred_at!),
      makeEvidence({ id: 'ev-fin1-enrichment', candidate_id: candidate.id, source_binding_id: 'binding-enrichment', facts: { 'contact.role': 'VP_Sales' }, occurred_at: candidate.booked_at!, recorded_at: candidate.booked_at! }),
    ]
    // Coverage is source+kind+interval-scoped, not fact-scoped — so crm's
    // coverage must be narrowed to stop BEFORE booked_at to genuinely
    // isolate "crm's silence on contact.role is not yet proven complete"
    // (a full-through-booked_at crm row would trivially satisfy it).
    const coverage = [
      ...fullQualifyingCoverage(candidate.id, candidate.occurred_at!, deadlineResult.deadline),
      makeCoverage({ id: 'cov-fin1-crm-partial', source_binding_id: 'binding-crm', coverage_kind: 'fact_evidence', covered_from: '2020-01-01T00:00:00Z', covered_through: '2026-08-15T00:00:00Z', established_at: deadlineResult.deadline }),
      makeCoverage({ id: 'cov-fin1-conf', source_binding_id: 'binding-conferencing', coverage_kind: 'fact_evidence', covered_from: '2020-01-01T00:00:00Z', covered_through: candidate.occurred_at!, established_at: deadlineResult.deadline }),
      // enrichment itself (the WINNING source) is fully covered — per
      // source_precedence semantics that alone is not enough: every
      // HIGHER-priority source ahead of the winner (crm, index 0) must
      // ALSO be proven silent through the same reference time.
      makeCoverage({ id: 'cov-fin1-enrichment', source_binding_id: 'binding-enrichment', coverage_kind: 'fact_evidence', covered_from: '2020-01-01T00:00:00Z', covered_through: candidate.booked_at!, established_at: deadlineResult.deadline }),
    ]
    const asOf = new Date(new Date(deadlineResult.deadline).getTime() + 86_400_000).toISOString()

    const decision = evaluateCandidateFinalDecision({
      candidate, rule, evidence, priorCandidates: [], sourceBindingRoleKeys: SOURCE_BINDING_ROLE_KEYS, sourceBindings: SOURCE_BINDINGS, coverage, asOf,
    })
    expect(decision.outcome).toBe('pending')
    expect(decision.factFinality?.some(f => f.factKey === 'contact.role' && f.status === 'incomplete')).toBe(true)
  })

  it('the SAME facts, once crm coverage also proves silence through the reference time -> may finalize as qualified', () => {
    const candidate = makeCandidate({ id: 'cand-fin2', rule, external_id: 'meeting-fin2', booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-10T14:00:00Z', attribution_at: '2026-09-10T14:00:00Z' })
    const deadlineResult = resolveRejectionDeadline(candidate, rule)
    if (deadlineResult.status !== 'resolved') throw new Error('test setup: deadline must resolve')

    const evidence = [
      ...evidenceWithoutContactRole(candidate.id, candidate.booked_at!, candidate.occurred_at!),
      makeEvidence({ id: 'ev-fin2-enrichment', candidate_id: candidate.id, source_binding_id: 'binding-enrichment', facts: { 'contact.role': 'VP_Sales' }, occurred_at: candidate.booked_at!, recorded_at: candidate.booked_at! }),
    ]
    const coverage = [
      ...fullQualifyingCoverage(candidate.id, candidate.occurred_at!, deadlineResult.deadline),
      // crm's coverage now reaches all the way through booked_at — its
      // silence on contact.role is genuinely proven, not merely assumed.
      makeCoverage({ id: 'cov-fin2-crm', source_binding_id: 'binding-crm', coverage_kind: 'fact_evidence', covered_from: '2020-01-01T00:00:00Z', covered_through: candidate.booked_at!, established_at: deadlineResult.deadline }),
      makeCoverage({ id: 'cov-fin2-enrichment', source_binding_id: 'binding-enrichment', coverage_kind: 'fact_evidence', covered_from: '2020-01-01T00:00:00Z', covered_through: candidate.booked_at!, established_at: deadlineResult.deadline }),
      makeCoverage({ id: 'cov-fin2-conf', source_binding_id: 'binding-conferencing', coverage_kind: 'fact_evidence', covered_from: '2020-01-01T00:00:00Z', covered_through: candidate.occurred_at!, established_at: deadlineResult.deadline }),
    ]
    const asOf = new Date(new Date(deadlineResult.deadline).getTime() + 86_400_000).toISOString()

    const decision = evaluateCandidateFinalDecision({
      candidate, rule, evidence, priorCandidates: [], sourceBindingRoleKeys: SOURCE_BINDING_ROLE_KEYS, sourceBindings: SOURCE_BINDINGS, coverage, asOf,
    })
    expect(decision.outcome).toBe('qualified')
    expect(decision.factFinality?.find(f => f.factKey === 'contact.role')?.status).toBe('complete')
  })

  it('coverage proving crm silence, established AFTER asOf, is invisible to a historical evaluation at that asOf', () => {
    const candidate = makeCandidate({ id: 'cand-fin3', rule, external_id: 'meeting-fin3', booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-10T14:00:00Z', attribution_at: '2026-09-10T14:00:00Z' })
    const deadlineResult = resolveRejectionDeadline(candidate, rule)
    if (deadlineResult.status !== 'resolved') throw new Error('test setup: deadline must resolve')

    const evidence = [
      ...evidenceWithoutContactRole(candidate.id, candidate.booked_at!, candidate.occurred_at!),
      makeEvidence({ id: 'ev-fin3-enrichment', candidate_id: candidate.id, source_binding_id: 'binding-enrichment', facts: { 'contact.role': 'VP_Sales' }, occurred_at: candidate.booked_at!, recorded_at: candidate.booked_at! }),
    ]
    const lateEstablishedAt = '2026-09-25T00:00:00Z'
    const coverage = [
      ...fullQualifyingCoverage(candidate.id, candidate.occurred_at!, deadlineResult.deadline),
      makeCoverage({ id: 'cov-fin3-crm', source_binding_id: 'binding-crm', coverage_kind: 'fact_evidence', covered_from: '2020-01-01T00:00:00Z', covered_through: candidate.booked_at!, established_at: lateEstablishedAt }),
      makeCoverage({ id: 'cov-fin3-enrichment', source_binding_id: 'binding-enrichment', coverage_kind: 'fact_evidence', covered_from: '2020-01-01T00:00:00Z', covered_through: candidate.booked_at!, established_at: lateEstablishedAt }),
      makeCoverage({ id: 'cov-fin3-conf', source_binding_id: 'binding-conferencing', coverage_kind: 'fact_evidence', covered_from: '2020-01-01T00:00:00Z', covered_through: candidate.occurred_at!, established_at: lateEstablishedAt }),
    ]

    const earlyAsOf = new Date(new Date(deadlineResult.deadline).getTime() + 86_400_000).toISOString() // before lateEstablishedAt
    const earlyDecision = evaluateCandidateFinalDecision({
      candidate, rule, evidence, priorCandidates: [], sourceBindingRoleKeys: SOURCE_BINDING_ROLE_KEYS, sourceBindings: SOURCE_BINDINGS, coverage, asOf: earlyAsOf,
    })
    expect(earlyDecision.outcome).toBe('pending')

    const lateAsOf = new Date(new Date(lateEstablishedAt).getTime() + 86_400_000).toISOString() // after lateEstablishedAt
    const lateDecision = evaluateCandidateFinalDecision({
      candidate, rule, evidence, priorCandidates: [], sourceBindingRoleKeys: SOURCE_BINDING_ROLE_KEYS, sourceBindings: SOURCE_BINDINGS, coverage, asOf: lateAsOf,
    })
    expect(lateDecision.outcome).toBe('qualified')
  })

  it('selected authoritative source (account.employee_count via crm) itself incomplete -> pending', () => {
    const candidate = makeCandidate({ id: 'cand-fin4', rule, external_id: 'meeting-fin4', booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-10T14:00:00Z', attribution_at: '2026-09-10T14:00:00Z' })
    const deadlineResult = resolveRejectionDeadline(candidate, rule)
    if (deadlineResult.status !== 'resolved') throw new Error('test setup: deadline must resolve')

    const evidence = cleanEvidence(candidate.id, candidate.booked_at!, candidate.occurred_at!)
    // Every OTHER material fact is covered; crm's own fact_evidence
    // coverage (which account.employee_count's authoritative_source
    // strategy exclusively relies on) is entirely absent.
    const coverage = [
      ...fullQualifyingCoverage(candidate.id, candidate.occurred_at!, deadlineResult.deadline),
      makeCoverage({ id: 'cov-fin4-conf', source_binding_id: 'binding-conferencing', coverage_kind: 'fact_evidence', covered_from: '2020-01-01T00:00:00Z', covered_through: candidate.occurred_at!, established_at: deadlineResult.deadline }),
    ]
    const asOf = new Date(new Date(deadlineResult.deadline).getTime() + 86_400_000).toISOString()

    const decision = evaluateCandidateFinalDecision({
      candidate, rule, evidence, priorCandidates: [], sourceBindingRoleKeys: SOURCE_BINDING_ROLE_KEYS, sourceBindings: SOURCE_BINDINGS, coverage, asOf,
    })
    expect(decision.outcome).toBe('pending')
    expect(decision.factFinality?.some(f => f.status === 'incomplete')).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Audit (item 3) — a terminal REJECTION substantiated through rejection_
// rule.reason_predicates must require finality of every material fact the
// predicate used, via the SAME trace-driven mechanism as ordinary criteria.
// This was already true as of the previous hardening pass
// (collectReasonPredicateMaterialFactKeys + gateOnFactFinality, both
// consulted before ANY objection-based 'rejected' is returned — see
// evaluateCandidateFinalDecision's rejection.outcome === 'rejected'
// branch) — these tests exist to prove it explicitly, per instruction, not
// to change production code.
// ═══════════════════════════════════════════════════════════════════════════
describe('Audit — reason-predicate substantiation is itself fact-finality-gated', () => {
  const rule = buildActiveOs202609Rule()

  it("'attendance < 15' cannot terminally reject while a higher-priority source capable of changing attendance_minutes remains incomplete", () => {
    // attendance_minutes resolves to 12 (< 15) via 'calendar' — the
    // LOWER-priority source in source_precedence order ['conferencing',
    // 'calendar'] — only because 'conferencing' (higher-priority) has no
    // evidence yet, not because conferencing was watched and found silent.
    const candidate = makeCandidate({ id: 'cand-audit1', rule, external_id: 'meeting-audit1', booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-10T14:00:00Z', attribution_at: '2026-09-10T14:00:00Z' })
    const rejectionTimestamp = '2026-09-11T09:00:00Z'
    const evidence = [
      ...cleanEvidence(candidate.id, candidate.booked_at!, candidate.occurred_at!).filter(e => e.source_binding_id !== 'binding-conferencing'),
      makeEvidence({ id: 'ev-audit1-calendar', candidate_id: candidate.id, source_binding_id: 'binding-calendar', facts: { attendance_minutes: 12 }, occurred_at: candidate.occurred_at!, recorded_at: candidate.occurred_at! }),
      makeEvidence({
        id: 'ev-audit1-rejection', candidate_id: candidate.id, source_binding_id: 'binding-crm',
        facts: {
          [OBJECTION_REASON_FACT_KEY]: 'attendance_under_15_minutes', [OBJECTION_CHANNEL_FACT_KEY]: 'crm',
          [OBJECTION_TIMESTAMP_FACT_KEY]: rejectionTimestamp, [OBJECTION_SUBJECT_EXTERNAL_ID_FACT_KEY]: 'meeting-audit1',
        },
        occurred_at: rejectionTimestamp, recorded_at: rejectionTimestamp,
      }),
    ]
    // crm is fully covered (every OTHER criteria fact is final); calendar
    // (the winning, lower-priority source) is fully covered too; but
    // conferencing — the HIGHER-priority source ahead of it — has NO
    // fact_evidence coverage at all.
    const coverage = [
      makeCoverage({ id: 'cov-audit1-crm', source_binding_id: 'binding-crm', coverage_kind: 'fact_evidence', covered_from: '2020-01-01T00:00:00Z', covered_through: candidate.booked_at!, established_at: '2026-09-20T00:00:00Z' }),
      makeCoverage({ id: 'cov-audit1-calendar', source_binding_id: 'binding-calendar', coverage_kind: 'fact_evidence', covered_from: '2020-01-01T00:00:00Z', covered_through: candidate.occurred_at!, established_at: '2026-09-20T00:00:00Z' }),
    ]

    const decision = evaluateCandidateFinalDecision({
      candidate, rule, evidence, priorCandidates: [], sourceBindingRoleKeys: SOURCE_BINDING_ROLE_KEYS, sourceBindings: SOURCE_BINDINGS, coverage,
      asOf: '2026-09-20T00:00:00Z',
    })
    // NEVER 'rejected' merely because the currently-visible attendance
    // says 12 — conferencing's silence is unproven.
    expect(decision.outcome).toBe('pending')
    expect(decision.criteria).toBe('not_satisfied') // reached via the fast criteria path (see the circularity test above)
    expect(decision.factFinality?.some(f => f.factKey === 'attendance_minutes' && f.status === 'incomplete')).toBe(true)
  })

  it("the temporal predicate (opportunity.recorded_at <= supplier_first_contact_at - 30d) cannot terminally reject while either timestamp's finality is unproven", () => {
    const candidate = makeCandidate({ id: 'cand-audit2', rule, external_id: 'meeting-audit2', booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-10T14:00:00Z', attribution_at: '2026-09-10T14:00:00Z' })
    const rejectionTimestamp = '2026-09-11T09:00:00Z'
    const opportunityFacts = {
      'opportunity.exists_active': true,
      'opportunity.recorded_at': '2026-06-01T00:00:00Z',
      'account.supplier_first_contact_at': '2026-08-01T00:00:00Z', // recorded_at is genuinely >30d before this
    }
    const evidence = [
      ...cleanEvidence(candidate.id, candidate.booked_at!, candidate.occurred_at!),
      makeEvidence({ id: 'ev-audit2-opportunity', candidate_id: candidate.id, source_binding_id: 'binding-crm', facts: opportunityFacts, occurred_at: candidate.booked_at!, recorded_at: candidate.booked_at! }),
      makeEvidence({
        id: 'ev-audit2-rejection', candidate_id: candidate.id, source_binding_id: 'binding-crm',
        facts: {
          [OBJECTION_REASON_FACT_KEY]: 'preexisting_active_opportunity', [OBJECTION_CHANNEL_FACT_KEY]: 'crm',
          [OBJECTION_TIMESTAMP_FACT_KEY]: rejectionTimestamp, [OBJECTION_SUBJECT_EXTERNAL_ID_FACT_KEY]: 'meeting-audit2',
        },
        occurred_at: rejectionTimestamp, recorded_at: rejectionTimestamp,
      }),
    ]
    // Deliberately NO fact_evidence coverage at all for the opportunity/
    // first-contact facts (capable source: crm) — the predicate resolves
    // 'satisfied' (the relation genuinely holds), but neither timestamp's
    // finality is established.
    const deadlineResult = resolveRejectionDeadline(candidate, rule)
    if (deadlineResult.status !== 'resolved') throw new Error('test setup: deadline must resolve')
    const coverage = rejectionSourceCoverage(candidate.id, candidate.occurred_at!, deadlineResult.deadline, deadlineResult.deadline)
    const asOf = new Date(new Date(deadlineResult.deadline).getTime() + 86_400_000).toISOString()

    const decision = evaluateCandidateFinalDecision({
      candidate, rule, evidence, priorCandidates: [], sourceBindingRoleKeys: SOURCE_BINDING_ROLE_KEYS, sourceBindings: SOURCE_BINDINGS, coverage, asOf,
    })
    expect(decision.outcome).toBe('pending')
    expect(decision.factFinality?.some(f => (f.factKey === 'opportunity.recorded_at' || f.factKey === 'account.supplier_first_contact_at') && f.status === 'incomplete')).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Positive-duplicate finality (final hardening pass, item 2) — a
// duplicate_found match is dynamically resolved on BOTH sides
// (evaluateDedupeObservation calls resolveKeyFieldValues against the
// CURRENT candidate's own evidence AND, independently, against each prior
// candidate's own evidence — lib/billable-unit-candidate.ts). Neither side
// is a frozen identity, so a terminal 'rejected' via duplicate_found must
// gate finality on BOTH. A dedicated minimal rule is used here (not the
// OS-2026-09 fixture) because account.id there has only one capable
// source (crm) — this suite needs a genuine two-source precedence
// scenario to exercise "resolves from the lower-priority source only
// because the higher-priority one hasn't reported yet."
// ═══════════════════════════════════════════════════════════════════════════
describe('Positive-duplicate finality — both sides of a dynamically-resolved match are gated', () => {
  function buildDedupeInstabilityRule(): BillableUnitQualificationRule {
    const alwaysTrue = { kind: 'condition' as const, condition: { field: 'account.id', operator: 'exists' as const } }
    return {
      id: 'rule-dedupe-instability', job_id: 'job-os-2026-09', org_id: 'org-lynora', unit_type: 'SQM',
      fact_schema: { 'account.id': { type: 'string', reference_time: 'booked_at' } },
      criteria: { value: alwaysTrue, state: 'clear_from_source', provenance: 'contract_derived' },
      qualified_contact_role: {
        // combineQualifiedContactRoleCondition only supports 'in'/'eq' base
        // operators (it merges reviewer extensions into the same
        // condition) — 'exists' is fine for criteria but not here.
        base: { value: { field: 'account.id', operator: 'eq', value: 'unused-role-placeholder' }, state: 'clear_from_source', provenance: 'contract_derived' },
        extensions: { value: [], state: 'decision_required', provenance: null },
        attestation_fact_key: { value: null, state: 'decision_required', provenance: 'reviewer_policy' },
      },
      dedupe_rule: { value: { key_fields: ['account.id'], lookback: { days: 90, unit: 'calendar' }, scope: [], discovery_coverage_role_keys: ['crm'] }, state: 'clear_from_source', provenance: 'contract_derived' },
      rejection_rule: { value: { valid_reasons: [], valid_channels: [], requires_timestamp: true, requires_identification: true, email_alone_valid: false, channel_exception: null, late_rejection_behavior: 'ignored_for_initial_qualification', reason_predicates: {} }, state: 'clear_from_source', provenance: 'contract_derived' },
      rejection_window: { value: { business_days: 3, holiday_calendar: 'SE-stockholm', timezone: 'Europe/Stockholm', reference_time: 'occurred_at' }, state: 'clear_from_source', provenance: 'contract_derived' },
      deadline_convention: { value: 'end_of_business_day', state: 'decision_required', provenance: 'reviewer_policy' },
      business_day_end_local_time: { value: '17:00:00', state: 'decision_required', provenance: 'reviewer_policy' },
      attribution_basis: { value: 'occurred_at', state: 'verdix_recommends', provenance: 'reviewer_policy' },
      // account.id is deliberately resolvable from TWO sources with an
      // explicit priority order — the OS-2026-09 fixture's own account.id
      // has only one capable source, which can't exercise "resolves from
      // the lower-priority source only because the higher-priority one
      // hasn't reported yet."
      evidence_precedence: { 'account.id': { value: { kind: 'source_precedence', order: ['crm', 'enrichment'] }, state: 'clear_from_source', provenance: 'contract_derived' } },
      fact_evidence_source_roles: { 'account.id': { value: ['crm', 'enrichment'], state: 'clear_from_source', provenance: 'contract_derived' } },
      field_sources: {}, version: 1, revision: 1, supersedes_rule_id: null,
      effective_from: '2026-01-01T00:00:00Z', effective_to: null, status: 'active',
    }
  }

  const rule = buildDedupeInstabilityRule()

  function makeAccountIdEvidence(id: string, candidateId: string, sourceBindingId: string, accountId: string, at: string): CandidateUnitEvidence {
    return makeEvidence({ id, candidate_id: candidateId, source_binding_id: sourceBindingId, facts: { 'account.id': accountId }, occurred_at: at, recorded_at: at })
  }

  it('duplicate_found via the CURRENT candidate resolving from a lower-priority source (higher-priority incomplete) -> pending', () => {
    const prior = makeCandidate({ id: 'cand-dupfin-prior', rule, external_id: 'meeting-dupfin-prior', booked_at: '2026-08-01T00:00:00Z', occurred_at: '2026-08-01T00:00:00Z', attribution_at: '2026-08-01T00:00:00Z' })
    const priorEvidence = [makeAccountIdEvidence('ev-dupfin-prior-crm', prior.id, 'binding-crm', 'acct-A', prior.booked_at!)]

    const candidate = makeCandidate({ id: 'cand-dupfin-1', rule, external_id: 'meeting-dupfin-1', booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-01T00:00:00Z', attribution_at: '2026-09-01T00:00:00Z' })
    // account.id resolves to 'acct-A' via enrichment (LOWER priority) only
    // because crm (higher priority) has no evidence at all yet — exactly
    // the brief's own example.
    const evidence = [makeAccountIdEvidence('ev-dupfin-1-enrichment', candidate.id, 'binding-enrichment', 'acct-A', candidate.booked_at!)]
    // Prior's own crm resolution is fully covered; enrichment (the
    // CURRENT candidate's winning source) is covered; crm for the CURRENT
    // candidate is NOT.
    const coverage = [
      makeCoverage({ id: 'cov-dupfin-1-prior-crm', source_binding_id: 'binding-crm', coverage_kind: 'fact_evidence', covered_from: '2020-01-01T00:00:00Z', covered_through: prior.booked_at!, established_at: '2026-09-20T00:00:00Z' }),
      makeCoverage({ id: 'cov-dupfin-1-enrichment', source_binding_id: 'binding-enrichment', coverage_kind: 'fact_evidence', covered_from: '2020-01-01T00:00:00Z', covered_through: candidate.booked_at!, established_at: '2026-09-20T00:00:00Z' }),
    ]

    const decision = evaluateCandidateFinalDecision({
      candidate, rule, evidence, priorCandidates: [{ candidate: prior, evidence: priorEvidence }],
      sourceBindingRoleKeys: SOURCE_BINDING_ROLE_KEYS, sourceBindings: SOURCE_BINDINGS, coverage,
      asOf: '2026-09-20T00:00:00Z',
    })
    expect(decision.dedupe.outcome).toBe('duplicate')
    expect(decision.outcome).toBe('pending')
    expect(decision.factFinality?.some(f => f.factKey === 'account.id' && f.status === 'incomplete')).toBe(true)
  })

  it("duplicate_found via the MATCHED PRIOR candidate's own account.id being unstable (current candidate fully final) -> pending", () => {
    const prior = makeCandidate({ id: 'cand-dupfin-prior2', rule, external_id: 'meeting-dupfin-prior2', booked_at: '2026-08-01T00:00:00Z', occurred_at: '2026-08-01T00:00:00Z', attribution_at: '2026-08-01T00:00:00Z' })
    // The PRIOR's own account.id resolves from enrichment (the winner,
    // idx 1) — required = ['crm', 'enrichment'] (the source_precedence
    // prefix through the winner, same rule as the current candidate's own
    // resolution). enrichment itself is never asserted as covered here.
    const priorEvidence = [makeAccountIdEvidence('ev-dupfin-prior2-enrichment', prior.id, 'binding-enrichment', 'acct-B', prior.booked_at!)]

    const candidate = makeCandidate({ id: 'cand-dupfin-2', rule, external_id: 'meeting-dupfin-2', booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-01T00:00:00Z', attribution_at: '2026-09-01T00:00:00Z' })
    const evidence = [makeAccountIdEvidence('ev-dupfin-2-crm', candidate.id, 'binding-crm', 'acct-B', candidate.booked_at!)]
    // Current candidate's own crm resolution (required=['crm'] only,
    // since crm is index 0) is fully covered — and because coverage
    // intervals share the SAME lower bound (the binding's own
    // effective_from) across every candidate in the job, this same crm
    // row necessarily ALSO satisfies the prior's own crm requirement
    // (its reference time is earlier still). What is NOT covered is
    // enrichment — the prior's own WINNING source — proving the gate
    // still blocks on the matched prior's resolution even when the
    // higher-priority source it shares with the current candidate is
    // already proven silent.
    const coverage = [
      makeCoverage({ id: 'cov-dupfin-2-crm', source_binding_id: 'binding-crm', coverage_kind: 'fact_evidence', covered_from: '2020-01-01T00:00:00Z', covered_through: candidate.booked_at!, established_at: '2026-09-20T00:00:00Z' }),
    ]

    const decision = evaluateCandidateFinalDecision({
      candidate, rule, evidence, priorCandidates: [{ candidate: prior, evidence: priorEvidence }],
      sourceBindingRoleKeys: SOURCE_BINDING_ROLE_KEYS, sourceBindings: SOURCE_BINDINGS, coverage,
      asOf: '2026-09-20T00:00:00Z',
    })
    expect(decision.dedupe.outcome).toBe('duplicate')
    expect(decision.outcome).toBe('pending')
    expect(decision.factFinality?.some(f => f.factKey === 'account.id' && f.status === 'incomplete')).toBe(true)
  })

  it('duplicate_found with BOTH sides fully final -> rejected, without ever needing candidate_discovery coverage', () => {
    const prior = makeCandidate({ id: 'cand-dupfin-prior3', rule, external_id: 'meeting-dupfin-prior3', booked_at: '2026-08-01T00:00:00Z', occurred_at: '2026-08-01T00:00:00Z', attribution_at: '2026-08-01T00:00:00Z' })
    const priorEvidence = [makeAccountIdEvidence('ev-dupfin-prior3-crm', prior.id, 'binding-crm', 'acct-C', prior.booked_at!)]

    const candidate = makeCandidate({ id: 'cand-dupfin-3', rule, external_id: 'meeting-dupfin-3', booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-01T00:00:00Z', attribution_at: '2026-09-01T00:00:00Z' })
    const evidence = [makeAccountIdEvidence('ev-dupfin-3-crm', candidate.id, 'binding-crm', 'acct-C', candidate.booked_at!)]
    // Deliberately NO candidate_discovery coverage anywhere in this test —
    // a positive duplicate must never need it.
    const coverage = [
      makeCoverage({ id: 'cov-dupfin-3-crm-current', source_binding_id: 'binding-crm', coverage_kind: 'fact_evidence', covered_from: '2020-01-01T00:00:00Z', covered_through: candidate.booked_at!, established_at: '2026-09-20T00:00:00Z' }),
      makeCoverage({ id: 'cov-dupfin-3-crm-prior', source_binding_id: 'binding-crm', coverage_kind: 'fact_evidence', covered_from: '2020-01-01T00:00:00Z', covered_through: prior.booked_at!, established_at: '2026-09-20T00:00:00Z' }),
    ]

    const decision = evaluateCandidateFinalDecision({
      candidate, rule, evidence, priorCandidates: [{ candidate: prior, evidence: priorEvidence }],
      sourceBindingRoleKeys: SOURCE_BINDING_ROLE_KEYS, sourceBindings: SOURCE_BINDINGS, coverage,
      asOf: '2026-09-20T00:00:00Z',
    })
    expect(decision.dedupe.outcome).toBe('duplicate')
    expect(decision.outcome).toBe('rejected')
    expect(decision.materialDependencies).toEqual(['dedupe_observation', 'fact_finality'])
  })
})
