// Verdix commercial decision trace — service credit survival.carry_forward
// entry point (Step 8, item 9). The FIRST and, for this step, ONLY field
// wired to lib/rulebook/decision-trace.ts's generic composer — chosen
// because it's the sole field in PRODUCTION_ORGANIZATION_RULEBOOK_ALLOWLIST
// today (lib/rulebook/organization-rulebook-production.ts). A thin adapter,
// not a special case: everything it does is build the same generic
// DecisionTraceInput any other field would, from the real persisted
// CreditApplicationRule shape (lib/types.ts) and the same inputs confirm-
// rule/route.ts's own organization-resolution branch already uses.
import type { CreditApplicationRule, FieldProvenance } from '@/lib/types'
import { creditApplicationContext } from './context'
import { buildCommercialDecisionTrace, type CommercialDecisionTrace, type DecisionTraceProposalState } from './decision-trace'
import type { OrganizationRuleRecord } from './organization-rules'
import type { RuleInterpretationContext } from './types'

export const SERVICE_CREDIT_SURVIVAL_CARRY_FORWARD_FIELD = 'survival.carry_forward'

export interface ServiceCreditSurvivalTraceInput {
  // The credit's current, persisted application_rule — or undefined/null
  // for a credit that has none yet. Only the fields actually needed to
  // build a Global Rulebook context are read (mirrors lib/rulebook/
  // context.ts's creditApplicationContext own Pick<>).
  applicationRule: Pick<CreditApplicationRule, 'eligible_component_keys' | 'eligibility_provenance' | 'carry_forward' | 'survival_provenance' | 'availability'> | null | undefined
  // cash_redeemable lives on the sibling ServiceCreditInterpretation, not
  // on CreditApplicationRule — see context.ts's own comment. Optional:
  // omitting it just means rule I (credit.application_scope_ne_cash_
  // redeemability) has nothing to evaluate, exactly like any other
  // genuinely absent domain slice.
  cashRedeemable?: boolean | 'unclear' | null
  cashRedeemableProvenance?: FieldProvenance | null
  // Overrides the default sourceTextPresent proxy (survival_provenance ===
  // 'contract_derived') — pass only when a more authoritative per-field
  // signal exists; see decision-trace.ts's own DecisionTraceInput comment.
  sourceTextPresent?: boolean
  // AI layer — structural facts only, mirrors lib/rule-interpretation.ts's
  // RuleProposal.survival_state / survival_organization_policy, never the
  // full proposal object (no reasoning, no source clause reaches here).
  interpretationContext?: RuleInterpretationContext
  aiProposalState?: DecisionTraceProposalState
  seenOrganizationPolicy?: { ruleId: string; ruleVersion: number; value: unknown }
  // Organization Rulebook — same inputs confirm-rule/route.ts's own
  // organization-resolution branch uses (org rules pre-loaded by the
  // caller; this stays pure).
  organizationId: string
  organizationRules: OrganizationRuleRecord[]
  // Every current service credit's availability is 'next_period' — see
  // confirm-rule/route.ts's own comment on why 'next_invoice' is the real
  // match-context fact this reflects, not a guess. ruleType defaults to
  // 'service_credit', overridable for a rebate/conditional_credit.
  ruleType?: string
  asOf: Date
}

export function buildServiceCreditSurvivalCarryForwardTrace(input: ServiceCreditSurvivalTraceInput): CommercialDecisionTrace {
  const creditApplication = creditApplicationContext(
    input.applicationRule,
    input.cashRedeemable !== undefined
      ? { cash_redeemable: input.cashRedeemable ?? 'unclear', cash_redeemable_provenance: input.cashRedeemableProvenance }
      : undefined,
  )
  return buildCommercialDecisionTrace({
    field: SERVICE_CREDIT_SURVIVAL_CARRY_FORWARD_FIELD,
    currentValue: input.applicationRule?.carry_forward ?? null,
    currentProvenance: input.applicationRule?.survival_provenance ?? null,
    sourceTextPresent: input.sourceTextPresent,
    domainContext: { creditApplication },
    interpretationContext: input.interpretationContext,
    aiProposalState: input.aiProposalState,
    seenOrganizationPolicy: input.seenOrganizationPolicy,
    organizationId: input.organizationId,
    organizationRules: input.organizationRules,
    organizationMatchContext: { rule_type: input.ruleType ?? 'service_credit', application: { timing: 'next_invoice' } },
    asOf: input.asOf,
  })
}

// Item 12 — a small, reusable, fully DETERMINISTIC explanation formatter,
// generated from trace facts only (rule ids, authorities, statuses) —
// never a second AI call, never raw contract text. Deliberately narrow:
// covers only the outcomes buildServiceCreditSurvivalCarryForwardTrace can
// actually produce, not a general-purpose trace-to-English engine. Not
// wired into any existing review card yet — see this step's deliverables
// report (item 12 explicitly says not to build the full audit UI now).
//
// Current-state language only (Step 8 amendment) — every sentence answers
// "why is this CURRENTLY resolved this way," never "why Verdix originally
// decided this." The trace is a reconstructed snapshot (see decision-
// trace.ts's own header comment), not a historical record — there is no
// persisted evidence of what happened at the original confirm-time, so
// this formatter must never claim a past event ("Verdix applied...",
// "...was applied when the contract was confirmed") that isn't actually
// proven by persisted data.
export function explainServiceCreditSurvivalCarryForward(trace: CommercialDecisionTrace): string {
  if (trace.final?.authority === 'contract_derived') {
    return trace.organizationRulebook.considered
      ? 'The agreement explicitly specifies this treatment, so the organization default does not apply.'
      : 'The agreement explicitly specifies this treatment.'
  }
  if (trace.final?.authority === 'reviewer_policy') {
    return trace.organizationRulebook.status === 'not_applicable' && trace.organizationRulebook.considered
      ? 'A reviewer\'s decision currently governs this treatment for this agreement, taking precedence over the organization default.'
      : 'A reviewer\'s decision currently governs this treatment for this agreement.'
  }
  if (trace.final?.authority === 'organization_rulebook') {
    return 'Organization policy currently supplies this treatment because the agreement does not specify unused-balance treatment.'
  }
  if (trace.organizationRulebook.staleAgainstSeenPolicy) {
    return 'The organization policy has changed since this was last reviewed. No treatment is currently applied automatically — please review again.'
  }
  if (trace.organizationRulebook.status === 'conflict') {
    return 'Multiple organization policies currently conflict for this agreement. No treatment is applied automatically.'
  }
  return 'The agreement does not currently specify unused-balance treatment. This requires a reviewer decision.'
}
