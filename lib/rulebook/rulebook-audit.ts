// Verdix Global Rulebook — registry integrity audit (Step 9).
//
// A pure, read-only cross-check between the REAL, active Rulebook
// (lib/rulebook/rules.ts's verdixCommercialRulebook, lib/rulebook/
// activation.ts's VERDIX_RULEBOOK_ACTIVATION) and the governance registry
// that's supposed to explain it (lib/rulebook/rule-candidates.ts's
// VERDIX_RULE_CANDIDATES). Run in tests, never in a production billing
// path (item 10) — it changes nothing, it only reports.
import { verdixCommercialRulebook } from './rules'
import { VERDIX_RULEBOOK_ACTIVATION } from './activation'
import { VERDIX_RULE_CANDIDATES, GRANDFATHERED_VERDIX_RULE_IDS } from './rule-candidates'
import { isAllowedCandidateOrigin, type VerdixRuleCandidate } from './candidate'
import type { VerdixRulebookRule } from './types'

export type RulebookAuditIssueCode =
  | 'duplicate_rule_id'
  | 'approved_candidate_missing_active_rule'
  | 'candidate_class_drifted_from_active_rule'
  | 'missing_activation_entry'
  | 'ai_guidance_wrong_class'
  | 'default_policy_active_without_approval'
  | 'customer_derived_candidate_origin'
  | 'rule_missing_governance_coverage'

export interface RulebookAuditIssue {
  code: RulebookAuditIssueCode
  message: string
  ruleId?: string
  candidateId?: string
}

export interface RulebookAuditResult {
  ok: boolean
  issues: RulebookAuditIssue[]
}

// candidates/rules both default to the real, live registries so a no-arg
// call audits production reality; both are overridable in tests — rules
// specifically so "a synthetic new active rule with no candidate and not
// grandfathered" (Step 9 final amendment, item 4) is expressible without
// touching the real verdixCommercialRulebook, which nothing outside
// rules.ts may ever mutate.
export function auditVerdixRulebook(
  candidates: VerdixRuleCandidate[] = VERDIX_RULE_CANDIDATES,
  rules: VerdixRulebookRule[] = verdixCommercialRulebook,
): RulebookAuditResult {
  const issues: RulebookAuditIssue[] = []

  // Rule ids unique.
  const seen = new Set<string>()
  for (const rule of rules) {
    if (seen.has(rule.id)) {
      issues.push({ code: 'duplicate_rule_id', message: `Rule id "${rule.id}" is registered more than once in verdixCommercialRulebook.`, ruleId: rule.id })
    }
    seen.add(rule.id)
  }

  // Every 'approved' candidate that claims to be active must correspond
  // to a real rule, at the class it was actually approved for — a silent
  // class change after approval would bypass this whole governance step.
  for (const candidate of candidates) {
    if (candidate.status !== 'approved' || !candidate.activeRuleId) continue
    const activeRule = rules.find(r => r.id === candidate.activeRuleId)
    if (!activeRule) {
      issues.push({
        code: 'approved_candidate_missing_active_rule',
        message: `Candidate "${candidate.id}" claims activeRuleId "${candidate.activeRuleId}" but no such rule exists in verdixCommercialRulebook.`,
        candidateId: candidate.id,
      })
    } else if (activeRule.ruleClass !== candidate.proposedClass) {
      issues.push({
        code: 'candidate_class_drifted_from_active_rule',
        message: `Candidate "${candidate.id}" was approved for class "${candidate.proposedClass}" but rule "${activeRule.id}" is now classified "${activeRule.ruleClass}".`,
        ruleId: activeRule.id, candidateId: candidate.id,
      })
    }
  }

  // Activation compatibility — every real rule should have an explicit
  // VERDIX_RULEBOOK_ACTIVATION entry. A missing entry is not itself unsafe
  // (activation.ts fails safe to 'diagnostic' for it — see that module's
  // own comment), but it's a completeness gap worth surfacing here.
  for (const rule of rules) {
    if (!VERDIX_RULEBOOK_ACTIVATION[rule.id]) {
      issues.push({ code: 'missing_activation_entry', message: `Rule "${rule.id}" has no explicit VERDIX_RULEBOOK_ACTIVATION entry (defaults to diagnostic).`, ruleId: rule.id })
    }
  }

  // AI-guidance eligibility compatibility — mirrors lib/rulebook/
  // ai-guidance.ts's own structural filter. A rule violating this at the
  // SOURCE (rules.ts itself, not just the selector) would mean the
  // registry drifted from its own eligibility rule.
  for (const rule of rules) {
    if (rule.aiGuidance && rule.ruleClass !== 'anti_inference' && rule.ruleClass !== 'semantic_interpretation') {
      issues.push({ code: 'ai_guidance_wrong_class', message: `Rule "${rule.id}" carries aiGuidance but is classified "${rule.ruleClass}" — only anti_inference/semantic_interpretation rules may.`, ruleId: rule.id })
    }
  }

  // No default_policy rule may be active without a candidate record
  // proving explicit product approval (organization overrideability +
  // acknowledged separate activation decision) — item 3's higher bar,
  // checked here against the REAL registry, not just at candidate-review
  // time (defense in depth).
  for (const rule of rules) {
    if (rule.ruleClass !== 'default_policy') continue
    const governingCandidate = candidates.find(c => c.activeRuleId === rule.id)
    if (!governingCandidate?.defaultPolicyApproval) {
      issues.push({ code: 'default_policy_active_without_approval', message: `Rule "${rule.id}" is classified default_policy but has no candidate record with defaultPolicyApproval.`, ruleId: rule.id })
    }
  }

  // No customer-derived provenance anywhere in the candidate registry —
  // defense in depth alongside candidate.ts's own type-level and
  // assertion-level guards.
  for (const candidate of candidates) {
    if (!isAllowedCandidateOrigin(candidate.origin)) {
      issues.push({ code: 'customer_derived_candidate_origin', message: `Candidate "${candidate.id}" has a non-Verdix-controlled origin "${candidate.origin}".`, candidateId: candidate.id })
    }
  }

  // Governance coverage (Step 9 final amendment) — the check that closes
  // the direct-to-Rulebook bypass. Every ACTIVE rule must either be
  // explicitly grandfathered (GRANDFATHERED_VERDIX_RULE_IDS, frozen — see
  // that array's own comment) or have an 'approved' candidate whose
  // activeRuleId points at it. A brand-new rule added straight to rules.ts
  // with neither has skipped the candidate/validation/approval workflow
  // entirely, which is exactly what this check exists to catch.
  const grandfathered = new Set<string>(GRANDFATHERED_VERDIX_RULE_IDS as readonly string[])
  const approvedActiveRuleIds = new Set(candidates.filter(c => c.status === 'approved' && c.activeRuleId).map(c => c.activeRuleId!))
  for (const rule of rules) {
    if (grandfathered.has(rule.id) || approvedActiveRuleIds.has(rule.id)) continue
    issues.push({
      code: 'rule_missing_governance_coverage',
      message: `Rule "${rule.id}" is active in verdixCommercialRulebook but has no approved governance candidate and is not in GRANDFATHERED_VERDIX_RULE_IDS — it appears to have bypassed the candidate/validation/approval workflow.`,
      ruleId: rule.id,
    })
  }

  return { ok: issues.length === 0, issues }
}
