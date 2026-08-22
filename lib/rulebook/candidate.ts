// Verdix Global Rulebook — candidate governance domain model (Step 9).
//
// Formalizes how a NEW Global Rulebook rule is proposed, evidenced, and
// eventually promoted — replacing "we found a weird clause, add another
// hard-coded rule" with an explicit lifecycle: a Verdix-controlled test
// exposes a pattern -> Verdix records it as a candidate -> humans decide
// whether it's reusable -> regression evidence is required -> a human
// deliberately promotes it into rules.ts through normal code review. See
// lib/rulebook/README.md's "Candidate lifecycle" section for the full
// governance narrative and lib/rulebook/rule-candidates.ts for the actual
// candidate registry (including the retrospective record for the Step 7
// cash-redeemability rule, this workflow's first worked example).
//
// This module is PURE domain modeling + structural guards. It writes
// nothing, calls no LLM, touches no database, and — critically — cannot
// promote anything: there is no function anywhere in this codebase that
// takes a VerdixRuleCandidate and pushes an entry into rules.ts's
// verdixCommercialRulebook. Promotion is always a human editing rules.ts
// directly, in a normal, reviewed commit (item 8).
import type { VerdixRuleClass } from './rule-class'

// Where a candidate's evidence is allowed to come from. Deliberately does
// NOT include anything customer-derived — see FORBIDDEN_CANDIDATE_ORIGINS
// below for the explicit negative list and isAllowedCandidateOrigin/
// assertNotCustomerDerivedOrigin for the structural guard. The Global
// Rulebook may evolve only from material Verdix itself controls
// (synthetic test fixtures, internal test suites) or from separately
// vetted public/domain commercial research — never from a customer's
// contract, a customer's Organization Rulebook, an individual reviewer's
// pattern, or an aggregated cross-customer pattern.
export type VerdixCandidateOrigin =
  | 'verdix_synthetic_test'
  | 'verdix_internal_test'
  | 'public_commercial_research'

const ALLOWED_CANDIDATE_ORIGINS: readonly VerdixCandidateOrigin[] = [
  'verdix_synthetic_test', 'verdix_internal_test', 'public_commercial_research',
]

// The explicit negative list (item 2) — these strings must never be
// accepted as a candidate origin, regardless of how the check is phrased
// elsewhere. Exported so tests can enumerate exactly what's forbidden,
// not just assert an arbitrary string is rejected.
export const FORBIDDEN_CANDIDATE_ORIGINS = [
  'customer_contract', 'organization_rulebook', 'customer_reviewer_pattern', 'cross_customer_pattern',
] as const

export function isAllowedCandidateOrigin(origin: string): origin is VerdixCandidateOrigin {
  return (ALLOWED_CANDIDATE_ORIGINS as readonly string[]).includes(origin)
}

// Structural guard (item 2) — throws immediately rather than silently
// accepting a customer-derived origin string. Defense in depth alongside
// the VerdixCandidateOrigin type itself (which structurally cannot
// express a forbidden value without an explicit cast) and
// validateVerdixRuleCandidate's own origin check.
export function assertNotCustomerDerivedOrigin(origin: string, context?: string): asserts origin is VerdixCandidateOrigin {
  if (!isAllowedCandidateOrigin(origin)) {
    throw new Error(
      `Verdix rule candidate origin "${origin}" is not allowed${context ? ` (${context})` : ''} — ` +
      `the Global Rulebook may only evolve from Verdix-controlled material (verdix_synthetic_test, ` +
      `verdix_internal_test) or separately approved public/domain research (public_commercial_research), ` +
      `never from customer contracts, Organization Rulebooks, or reviewer/cross-customer patterns.`
    )
  }
}

// The candidate lifecycle (item 13's README narrative, encoded as a type):
//   observed  — a Verdix-controlled test exposed a possible reusable
//               pattern; nothing generalized yet, no evidence required.
//   candidate — the principle has been generalized beyond the one fixture
//               that exposed it; a proposedRuleId/proposedClass/principle
//               now exist, but evidence may still be incomplete.
//   validated — positive AND counterexample fixtures (class-appropriate —
//               see candidate-validation.ts) demonstrate the principle
//               holds and know its own boundaries.
//   approved  — a human product/engineering review has accepted the
//               candidate as Verdix commercial doctrine. Still NOT the
//               same as being an active Rulebook rule — see activeRuleId.
//   rejected  — reviewed and declined; kept in the registry (not deleted)
//               as a record of what was considered and why.
export type VerdixCandidateStatus = 'observed' | 'candidate' | 'validated' | 'approved' | 'rejected'

// default_policy-specific approval metadata (item 3's "materially higher
// bar"). Required before a default_policy candidate may ever reach
// 'approved' — see candidate-validation.ts's class-aware validation.
// Deliberately distinct from the generic 'approved' status itself: status
// says a decision was made; this records WHO made the product-level call
// and WHY the two extra default_policy-only bars (organization
// overrideability, a separate production-activation decision) are met.
export interface VerdixDefaultPolicyApproval {
  approvedBy: string
  approvedAt: string
  // Explicit confirmation that an Organization Rulebook policy can still
  // override this default — item 3: "organization overrideability".
  organizationOverrideable: boolean
  // Explicit acknowledgement that adding this to rules.ts as ruleClass:
  // 'default_policy' does NOT itself activate it — activation.ts's
  // VERDIX_RULEBOOK_ACTIVATION still needs its own separate, reviewed
  // change (authority: 'resolve_semantic') — item 3: "separate production
  // activation decision". This field records that the approver understood
  // and accepted that a second decision remains outstanding, not that
  // activation has already happened.
  productionActivationDecisionRequired: true
  note: string
}

// An internal, code-defined, version-controlled record — never persisted
// to the customer database (item 11: this is product code, reviewed and
// shipped exactly like rules.ts itself, not a table any tenant's data can
// reach). See lib/rulebook/rule-candidates.ts for the actual registry.
export interface VerdixRuleCandidate {
  id: string
  // The rule_id this candidate proposes for lib/rulebook/rules.ts — NOT
  // required to be unique across the whole candidate registry by itself
  // (a rejected-then-resubmitted candidate may legitimately reuse it) —
  // see candidate-validation.ts's duplicate/supersession check.
  proposedRuleId: string
  proposedClass: VerdixRuleClass
  status: VerdixCandidateStatus
  // A short, generalized statement of the commercial/architectural
  // principle — never raw contract text, never a specific customer's
  // wording. E.g. "Restrictions on where a credit may be applied on an
  // invoice do not by themselves establish whether it may be redeemed in
  // cash."
  principle: string
  origin: VerdixCandidateOrigin
  // Stable fixture IDs (lib/rulebook/fixture-registry.ts) — never raw
  // contract text embedded directly. See that module's own header comment
  // for the addressing convention.
  evidenceFixtureIds: string[]
  counterexampleFixtureIds: string[]
  // Why this candidate matters / what it prevents — free text, but
  // strictly about the ABSTRACT principle and its governance history,
  // never about a specific customer or contract.
  rationale: string
  // Compact guidance text this candidate proposes for lib/rulebook/
  // ai-guidance.ts, if promoted — only ever meaningful for anti_inference/
  // semantic_interpretation classes (candidate-validation.ts rejects it
  // otherwise, mirroring ai-guidance.ts's own structural eligibility
  // filter). Never itself inserted into a prompt by this module — a real
  // promotion still requires a human to add it to rules.ts by hand.
  proposedAIGuidance?: string
  // default_policy only — see VerdixDefaultPolicyApproval's own comment.
  // Absent for every other class.
  defaultPolicyApproval?: VerdixDefaultPolicyApproval
  // Once this candidate has actually been promoted (a human added a real
  // entry to rules.ts), the rule_id that now exists there — usually
  // identical to proposedRuleId, kept distinct in case the id changed
  // during review. Absent until promotion actually happens; setting this
  // is itself a manual, reviewed edit to this registry, never automatic.
  activeRuleId?: string
  // Explicit supersession intent when this candidate reuses another
  // candidate's proposedRuleId (e.g. a rejected candidate resubmitted
  // with stronger evidence) — see candidate-validation.ts's duplicate
  // check, which requires this field whenever a proposedRuleId collision
  // is intentional rather than accidental.
  supersedesCandidateId?: string
}
