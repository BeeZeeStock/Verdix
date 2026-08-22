// Verdix Global Rulebook — candidate validation (Step 9).
//
// A pure function: given a VerdixRuleCandidate and the fixture registry it
// cites evidence against, decides whether the candidate is well-formed for
// its current lifecycle stage. Class-aware (item 4/3) because different
// VerdixRuleClass values need structurally different evidence — an
// invariant must have NO legitimate counterexample, while anti_inference/
// semantic_interpretation/default_policy candidates require one. Never
// mutates its input, never touches lib/rulebook/rules.ts's
// verdixCommercialRulebook, never calls a database or an LLM — this
// function can reject a candidate; it can never promote one (item 7/8).
import type { VerdixRuleCandidate, VerdixCandidateStatus } from './candidate'
import { isAllowedCandidateOrigin } from './candidate'
import type { VerdixRuleClass } from './rule-class'
import { VERDIX_FIXTURE_REGISTRY, type VerdixFixtureDescriptor } from './fixture-registry'

export type CandidateValidationIssueCode =
  | 'missing_principle'
  | 'invalid_proposed_class'
  | 'customer_derived_origin'
  | 'no_positive_evidence'
  | 'no_counterexample_evidence'
  | 'invariant_has_counterexample'
  | 'invariant_missing_adversarial_fixture'
  | 'unknown_fixture_id'
  | 'duplicate_rule_id'
  | 'ai_guidance_wrong_class'
  | 'default_policy_missing_approval'
  | 'default_policy_insufficient_evidence'
  | 'default_policy_not_overrideable'

export interface CandidateValidationIssue {
  code: CandidateValidationIssueCode
  message: string
}

export interface CandidateValidationResult {
  valid: boolean
  issues: CandidateValidationIssue[]
}

const VALID_CLASSES: readonly VerdixRuleClass[] = ['invariant', 'semantic_interpretation', 'anti_inference', 'default_policy']

// A candidate is only held to full evidence requirements once it claims to
// have REACHED that bar — item 4: "a candidate cannot reach validated
// without both [...]". An 'observed'/'candidate'-stage record legitimately
// has incomplete evidence; 'rejected' needs none either (it was declined,
// possibly precisely for lacking evidence — that's what got it rejected,
// not a separate thing to re-flag here).
const EVIDENCE_REQUIRED_STATUSES: readonly VerdixCandidateStatus[] = ['validated', 'approved']

function pushIssue(issues: CandidateValidationIssue[], code: CandidateValidationIssueCode, message: string): void {
  issues.push({ code, message })
}

export function validateVerdixRuleCandidate(
  candidate: VerdixRuleCandidate,
  fixtureRegistry: Record<string, VerdixFixtureDescriptor> = VERDIX_FIXTURE_REGISTRY,
  existingCandidates: VerdixRuleCandidate[] = [],
): CandidateValidationResult {
  const issues: CandidateValidationIssue[] = []

  if (!candidate.principle || !candidate.principle.trim()) {
    pushIssue(issues, 'missing_principle', 'Candidate has no principle statement.')
  }

  const classIsValid = VALID_CLASSES.includes(candidate.proposedClass)
  if (!classIsValid) {
    pushIssue(issues, 'invalid_proposed_class', `"${candidate.proposedClass}" is not a valid VerdixRuleClass.`)
  }

  if (!isAllowedCandidateOrigin(candidate.origin)) {
    pushIssue(issues, 'customer_derived_origin', `Origin "${candidate.origin}" is not Verdix-controlled — the Global Rulebook may never learn from customer data.`)
  }

  // Fixture IDs must exist regardless of lifecycle stage — a candidate
  // should never cite evidence that isn't actually registered, even
  // before it's mature enough to be REQUIRED to have any.
  for (const fixtureId of [...candidate.evidenceFixtureIds, ...candidate.counterexampleFixtureIds]) {
    if (!Object.prototype.hasOwnProperty.call(fixtureRegistry, fixtureId)) {
      pushIssue(issues, 'unknown_fixture_id', `Fixture id "${fixtureId}" is not registered in the fixture registry.`)
    }
  }

  // Duplicate proposedRuleId — only a real problem when another candidate
  // already claims the same proposedRuleId and this one doesn't declare
  // explicit supersession intent.
  const collision = existingCandidates.find(c => c.id !== candidate.id && c.proposedRuleId === candidate.proposedRuleId)
  if (collision && candidate.supersedesCandidateId !== collision.id) {
    pushIssue(issues, 'duplicate_rule_id', `proposedRuleId "${candidate.proposedRuleId}" is already used by candidate "${collision.id}" — set supersedesCandidateId to "${collision.id}" if this is an intentional replacement.`)
  }

  // AI guidance eligibility mirrors lib/rulebook/ai-guidance.ts's own
  // structural filter exactly (only anti_inference/semantic_interpretation
  // rules are ever eligible) — a candidate proposing guidance for an
  // invariant or default_policy class is malformed regardless of status.
  if (candidate.proposedAIGuidance && candidate.proposedClass !== 'anti_inference' && candidate.proposedClass !== 'semantic_interpretation') {
    pushIssue(issues, 'ai_guidance_wrong_class', `proposedClass "${candidate.proposedClass}" may never carry AI guidance — only anti_inference/semantic_interpretation rules can (lib/rulebook/ai-guidance.ts's own eligibility filter).`)
  }

  if (classIsValid && EVIDENCE_REQUIRED_STATUSES.includes(candidate.status)) {
    if (candidate.proposedClass === 'invariant') {
      // Item 3 — positive fixture, adversarial fixture, NO legitimate
      // counterexample (a real counterexample would disprove the invariant).
      if (candidate.evidenceFixtureIds.length === 0) {
        pushIssue(issues, 'no_positive_evidence', 'invariant candidates need at least one positive fixture.')
      }
      const hasAdversarial = candidate.evidenceFixtureIds.some(id => fixtureRegistry[id]?.kind === 'adversarial')
      if (!hasAdversarial) {
        pushIssue(issues, 'invariant_missing_adversarial_fixture', 'invariant candidates need at least one adversarial fixture demonstrating the violation always represents invalid commercial/execution semantics.')
      }
      if (candidate.counterexampleFixtureIds.length > 0) {
        pushIssue(issues, 'invariant_has_counterexample', 'invariant candidates must have NO legitimate counterexample.')
      }
    } else if (candidate.proposedClass === 'default_policy') {
      // Item 3 — materially higher bar: multiple fixtures, a counterexample
      // showing the default correctly yields to an explicit answer, and
      // explicit approval metadata (organization overrideability +
      // acknowledgement that activation is a separate decision).
      if (candidate.evidenceFixtureIds.length < 2) {
        pushIssue(issues, 'default_policy_insufficient_evidence', 'default_policy candidates need multiple (at least 2) Verdix-controlled positive fixtures.')
      }
      if (candidate.counterexampleFixtureIds.length === 0) {
        pushIssue(issues, 'no_counterexample_evidence', 'default_policy candidates need at least one counterexample showing the default correctly yields to an explicit contract/reviewer answer.')
      }
      if (!candidate.defaultPolicyApproval) {
        pushIssue(issues, 'default_policy_missing_approval', 'default_policy candidates require explicit defaultPolicyApproval before reaching validated/approved — default_policy promotion must never happen automatically.')
      } else if (!candidate.defaultPolicyApproval.organizationOverrideable) {
        pushIssue(issues, 'default_policy_not_overrideable', 'default_policy candidates must be safe for an Organization Rulebook policy to override.')
      }
    } else {
      // semantic_interpretation / anti_inference — item 3's shared shape:
      // positive evidence (wording variant / over-inference-avoidance
      // fixture) AND a counterexample (absent wording, or the boundary
      // case where the second concept really is explicitly addressed).
      if (candidate.evidenceFixtureIds.length === 0) {
        pushIssue(issues, 'no_positive_evidence', `${candidate.proposedClass} candidates need at least one positive fixture.`)
      }
      if (candidate.counterexampleFixtureIds.length === 0) {
        pushIssue(issues, 'no_counterexample_evidence', `${candidate.proposedClass} candidates need at least one counterexample fixture.`)
      }
    }
  }

  return { valid: issues.length === 0, issues }
}
