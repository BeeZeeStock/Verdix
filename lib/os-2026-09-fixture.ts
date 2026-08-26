// The OS-2026-09 qualification-rule fixture, shared across 16B.1
// (lib/billable-unit-qualification.test.ts) and 16B.2
// (lib/billable-unit-candidate.test.ts) test files. Lives in its own
// non-test module (not re-exported from a .test.ts file) specifically so
// importing it never re-executes another file's top-level describe/it
// blocks as a side effect — a plain `import` from a *.test.ts file would
// otherwise re-run that whole suite a second time.
//
// Every clause reference below is transcribed from the actual signed
// OS-2026-09 contract text (§§2.1-3.4, Schedule 1), read directly from the
// stored PDF during design — not an illustrative/invented fixture.
import type { BillableUnitQualificationRule, FieldDecision, QualificationExpression, QualificationFactDefinition } from './billable-unit-qualification'

function unresolved<T>(): FieldDecision<T> {
  return { value: null, state: 'decision_required', provenance: null }
}

export function buildOs202609Rule(): BillableUnitQualificationRule {
  const factSchema: Record<string, QualificationFactDefinition> = {
    // Pre-commit hardening audit (16B.2) — dedupe_rule.key_fields below
    // has always named 'account.id' (§2.3 bullet 4, "the same account"),
    // but 16B.1 never declared it in fact_schema because 16B.1 only
    // validated the rule's own STRUCTURE, never resolved a dedupe key
    // against real evidence. Canonical fix, not a test-only patch — every
    // field an executable rule references must be declared here (see
    // validateQualificationRuleFieldReferences).
    'account.id': { type: 'string', reference_time: 'booked_at' },
    'account.hq_or_commercial_ops_country': { type: 'enum', enumValues: ['SE', 'NO', 'DK', 'FI', 'DE', 'NL', 'BE', 'FR', 'GB'], reference_time: 'booked_at' },
    'account.employee_count': { type: 'number', reference_time: 'booked_at' },
    'account.business_category': { type: 'enum', enumValues: ['b2b_software', 'ai', 'developer_tools', 'enterprise_saas', 'fintech_infrastructure', 'deep_tech_b2b'], reference_time: 'booked_at' },
    'account.quota_carrying_sellers': { type: 'number', reference_time: 'booked_at' },
    'account.publicly_documented_enterprise_sales': { type: 'boolean', reference_time: 'booked_at' },
    'account.is_current_paying_customer': { type: 'boolean', reference_time: 'booked_at' },
    'contact.role': { type: 'enum', reference_time: 'booked_at' },
    // Reserved 16B.2 evaluator convention — NOT itself contract-extracted
    // data (no clause states this literal fact key), but its declaration
    // here reflects that §2.2's "...or an equivalent role with material
    // responsibility" is exactly the case this mechanism exists for: a
    // reviewer may attest, per candidate, that the attendee's actual
    // title satisfies that clause, WITHOUT rewriting contact.role's own
    // factual value or mutating qualified_contact_role.extensions (a
    // reusable, rule-level list) for a one-off judgment. Literal string
    // must stay in sync with
    // lib/billable-unit-candidate.ts's QUALIFIED_CONTACT_ROLE_ATTESTATION_FACT_KEY
    // — not imported directly, to avoid this shared 16B.1 fixture
    // depending on a 16B.2 module.
    'qualified_contact_role.reviewer_attested_equivalent': { type: 'boolean', reference_time: 'occurred_at' },
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
      // Pre-commit hardening audit (16B.2) — §2.2's "or an equivalent
      // role with material responsibility" is exactly the case 16B.2's
      // generic attestation mechanism exists for: a reviewer may attest,
      // per candidate, that the attendee's actual title satisfies this
      // clause, WITHOUT rewriting contact.role's own factual value or
      // mutating `extensions` above (a reusable, rule-level list) for a
      // one-off judgment. The fact key itself is NOT contract text — no
      // clause names it — it's a Verdix-proposed mechanism/key a reviewer
      // must explicitly accept, hence verdix_recommends rather than
      // clear_from_source (same distinction attribution_basis makes
      // below). The referenced key must be declared in fact_schema (see
      // 'qualified_contact_role.reviewer_attested_equivalent' above) —
      // validateQualificationRuleFieldReferences enforces this exactly
      // like any other field reference.
      attestation_fact_key: { value: 'qualified_contact_role.reviewer_attested_equivalent', state: 'verdix_recommends', provenance: null },
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
      // invented. Pre-commit hardening audit (16B.2): previously modeled
      // as one non-field-scoped placeholder key ('icp_contact_default'),
      // which validateQualificationRuleFieldReferences now correctly
      // rejects (it isn't a fact_schema key, and 16B.2's
      // resolveCandidateFact only ever looks up evidence_precedence by a
      // REAL fact key — a non-field-scoped entry could never actually be
      // consulted). Replaced with one entry per actual affected fact —
      // every field §3.1's unresolved CRM/enrichment note touches, each
      // independently unresolved until a reviewer decides (a reviewer UI
      // MAY still let someone confirm all six with one click, but the
      // executable rule representation stays fact-key-specific).
      // account.employee_count (above) and attendance_minutes (above)
      // already have their OWN explicit, contract-stated precedence —
      // they are deliberately not part of this unresolved group.
      'account.hq_or_commercial_ops_country': unresolved(),
      'account.business_category': unresolved(),
      'account.quota_carrying_sellers': unresolved(),
      'account.publicly_documented_enterprise_sales': unresolved(),
      'account.is_current_paying_customer': unresolved(),
      'contact.role': unresolved(),
    },
    // Verbatim quotes from the actual signed OS-2026-09 PDF (read directly
    // from the stored contract during design; see the source-grounding-
    // resolution describe block in lib/billable-unit-qualification.test.ts
    // for a test proving each quote is a real substring of the actual
    // agreement text, not a paraphrase or a heading reference).
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
      // deadline_convention, attribution_basis, and the six unresolved
      // evidence_precedence.<field> entries above deliberately absent —
      // no clause grounds them; the absence itself is meaningful.
    },
    version: 1,
    revision: 1,
    supersedes_rule_id: null,
    effective_from: '2026-08-25T00:00:00Z',
    effective_to: null,
    status: 'draft',
  }
}
