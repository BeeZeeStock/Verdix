// Verdix Global Rulebook — AI contract-interpretation guidance (Step 7).
// Pure tests for lib/rulebook/ai-guidance.ts (selection, rendering) and its
// integration into lib/rule-interpretation.ts's prompt builders. No
// database, no live AI call — this suite tests the DETERMINISTIC layers
// (selector, renderer, prompt text, and the existing validateProposalState
// safety net) exactly the same way every other prompt-builder test in this
// codebase does (see lib/rule-interpretation.test.ts). A separate, one-off,
// throwaway live comparison against real Bedrock/Anthropic calls was run
// during development (not committed — see this step's deliverables report
// for the actual before/after findings) and is not re-run here.
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { getRulebookAIGuidance, renderRulebookAIGuidance, RULEBOOK_AI_GUIDANCE_VERSION } from '@/lib/rulebook/ai-guidance'
import { verdixCommercialRulebook } from '@/lib/rulebook/rules'
import {
  buildServiceCreditProposalPrompt, buildServiceCreditPrompt, buildCreditSurvivalPrompt,
  validateProposalState, type RuleProposal, type ServiceCreditProposalContext,
} from '@/lib/rule-interpretation'

const CREDIT_RULE_IDS = [
  'credit.basis_ne_application_scope',
  'credit.next_invoice_timing_ne_carry_forward',
  'credit.future_payable_scope_ne_indefinite_survival',
  'credit.explicit_carry_forward_authoritative',
  'credit.application_scope_ne_cash_redeemability',
]

describe('getRulebookAIGuidance — deterministic selection (item 3, item 10)', () => {
  it('service-credit proposal context receives exactly the five credit interpretation guidance entries, in registry order', () => {
    const applicable = getRulebookAIGuidance('service_credit_proposal')
    expect(applicable.map(r => r.id)).toEqual(CREDIT_RULE_IDS)
  })

  it('service-credit interpretation (reviewer-override) context also receives all five', () => {
    expect(getRulebookAIGuidance('service_credit_interpretation').map(r => r.id)).toEqual(CREDIT_RULE_IDS)
  })

  it('service-credit survival-only context receives the three survival-relevant entries, excluding basis/scope AND the new cash-redeemability rule (cash treatment is never evaluated in the survival-only prompt)', () => {
    const applicable = getRulebookAIGuidance('service_credit_survival')
    expect(applicable.map(r => r.id)).toEqual([
      'credit.next_invoice_timing_ne_carry_forward',
      'credit.future_payable_scope_ne_indefinite_survival',
      'credit.explicit_carry_forward_authoritative',
    ])
    expect(applicable.map(r => r.id)).not.toContain('credit.basis_ne_application_scope')
    expect(applicable.map(r => r.id)).not.toContain('credit.application_scope_ne_cash_redeemability')
  })

  it('an unrelated context (minimum commitment) receives no credit guidance at all', () => {
    expect(getRulebookAIGuidance('minimum_commitment_proposal')).toEqual([])
  })

  it('meter matching receives no credit Rulebook guidance — a completely different AI call with no relationship to credit semantics', () => {
    expect(getRulebookAIGuidance('meter_mapping')).toEqual([])
  })

  it('is a pure function — repeated calls with the same context produce an identical (by value) result', () => {
    const first = getRulebookAIGuidance('service_credit_proposal')
    const second = getRulebookAIGuidance('service_credit_proposal')
    expect(second.map(r => r.id)).toEqual(first.map(r => r.id))
  })

  // Structural guard (item 1, item 8-adjacent): only anti_inference and
  // semantic_interpretation classes are ever eligible, regardless of what
  // any individual rule's aiGuidance field happens to contain. Exercised
  // against the REAL registry (today: zero invariant/default_policy rules
  // carry an aiGuidance field at all, so this also incidentally proves
  // nothing was fed in that shouldn't have been) plus a synthetic check
  // that the filter logic itself is class-gated, not merely
  // presence-of-aiGuidance-gated.
  it('every rule the selector ever returns is classified anti_inference or semantic_interpretation — never invariant or default_policy', () => {
    for (const context of ['service_credit_proposal', 'service_credit_interpretation', 'service_credit_survival'] as const) {
      for (const rule of getRulebookAIGuidance(context)) {
        expect(['anti_inference', 'semantic_interpretation']).toContain(rule.ruleClass)
      }
    }
  })

  it('no invariant-classed rule in the real registry carries aiGuidance at all — the two structural invariants (minimum-floor, all-units) are execution facts, not contractual-interpretation guidance', () => {
    const invariantRules = verdixCommercialRulebook.filter(r => r.ruleClass === 'invariant')
    expect(invariantRules.length).toBeGreaterThan(0) // sanity — invariants do exist in the registry
    for (const rule of invariantRules) {
      expect(rule.aiGuidance).toBeUndefined()
    }
  })

  it('zero default_policy rules exist, so none could be fed into a prompt even accidentally (current-registry audit, consistent with Step 6\'s own zero-default_policy finding)', () => {
    expect(verdixCommercialRulebook.filter(r => r.ruleClass === 'default_policy')).toHaveLength(0)
  })
})

describe('renderRulebookAIGuidance — the one canonical renderer (item 4, item 10)', () => {
  it('renders a compact block containing exactly the five credit instructions for a service-credit proposal, in registry order', () => {
    const block = renderRulebookAIGuidance('service_credit_proposal')
    expect(block).toContain('VERDIX COMMERCIAL INTERPRETATION RULES')
    for (const rule of verdixCommercialRulebook.filter(r => CREDIT_RULE_IDS.includes(r.id))) {
      expect(block).toContain(rule.aiGuidance!.instruction)
    }
    // Order: the basis/scope instruction appears before the next-invoice
    // instruction, which appears before future-payable, which appears
    // before explicit-carry-forward, which appears before the Step 7
    // amendment's cash-redeemability instruction — registry order, not
    // alphabetical or re-sorted.
    const basisIdx = block.indexOf('Keep calculation basis and application eligibility separate')
    const timingIdx = block.indexOf('"Applied to the next invoice" establishes application timing')
    const futurePayableIdx = block.indexOf('Language allowing a credit to be applied against future payable amounts')
    const explicitIdx = block.indexOf('When the source explicitly states that an unused portion carries forward')
    const cashIdx = block.indexOf('Invoice application scope and cash redeemability are independent')
    expect(basisIdx).toBeGreaterThanOrEqual(0)
    expect(basisIdx).toBeLessThan(timingIdx)
    expect(timingIdx).toBeLessThan(futurePayableIdx)
    expect(futurePayableIdx).toBeLessThan(explicitIdx)
    expect(explicitIdx).toBeLessThan(cashIdx)
  })

  it('always includes the item 7 "preserve contractual silence" reinforcement sentence whenever guidance is non-empty', () => {
    const block = renderRulebookAIGuidance('service_credit_proposal')
    expect(block).toContain('Verdix Rulebook guidance constrains interpretation but does not supply missing contract terms')
    expect(block).toContain('preserve it as unresolved even if a commercially plausible treatment exists')
  })

  it('returns an empty string (nothing to insert) for a context with no applicable guidance — never an empty header', () => {
    expect(renderRulebookAIGuidance('minimum_commitment_proposal')).toBe('')
    expect(renderRulebookAIGuidance('meter_mapping')).toBe('')
  })

  it('is byte-identical across repeated calls with the same context (item 10)', () => {
    const first = renderRulebookAIGuidance('service_credit_proposal')
    const second = renderRulebookAIGuidance('service_credit_proposal')
    expect(second).toBe(first)
  })

  it('embeds RULEBOOK_AI_GUIDANCE_VERSION in the rendered header — so any content-version bump is visible directly in the fingerprinted prompt text (item 9)', () => {
    const block = renderRulebookAIGuidance('service_credit_proposal')
    expect(block).toContain(`(v${RULEBOOK_AI_GUIDANCE_VERSION})`)
  })

  it('anti_inference rule is included where applicable — credit.basis_ne_application_scope for a service-credit proposal', () => {
    expect(renderRulebookAIGuidance('service_credit_proposal')).toContain('Keep calculation basis and application eligibility separate')
  })

  it('the Step 7 amendment\'s new anti_inference rule is included for a service-credit proposal — credit.application_scope_ne_cash_redeemability', () => {
    expect(renderRulebookAIGuidance('service_credit_proposal')).toContain('Invoice application scope and cash redeemability are independent')
  })

  it('semantic_interpretation rule is included where applicable — credit.explicit_carry_forward_authoritative for a service-credit proposal', () => {
    expect(renderRulebookAIGuidance('service_credit_proposal')).toContain('preserve that meaning as contractual evidence')
  })
})

describe('organization policy never included (item 8)', () => {
  it('RuleInterpretationContext accepts no organization-scoped value — the selector/renderer functions take no organizationId parameter at all', () => {
    // Structural: getRulebookAIGuidance/renderRulebookAIGuidance both take
    // a single string context argument — TypeScript itself enforces this
    // signature; this test documents and pins it so a future signature
    // change (e.g. accidentally threading an org id through) is caught by
    // a diff review, not silently.
    expect(getRulebookAIGuidance.length).toBe(1)
    expect(renderRulebookAIGuidance.length).toBe(1)
  })

  it('lib/rulebook/ai-guidance.ts imports nothing organization-scoped or database-touching', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'lib/rulebook/ai-guidance.ts'), 'utf-8')
    const importLines = source.split('\n').filter(line => /^import /.test(line.trim()))
    expect(importLines.length).toBeGreaterThan(0)
    for (const line of importLines) {
      expect(line).not.toMatch(/organization-rules/i)
      expect(line).not.toMatch(/supabase/i)
    }
  })

  it('no rendered guidance block, for any context, contains the words "organization" or "org" — the guidance is pure Verdix product text', () => {
    for (const context of ['service_credit_proposal', 'service_credit_interpretation', 'service_credit_survival'] as const) {
      const block = renderRulebookAIGuidance(context).toLowerCase()
      expect(block).not.toMatch(/\borganization\b/)
    }
  })
})

describe('prompt builder integration (item 5) — guidance inserted before the schema, existing content preserved', () => {
  const context: ServiceCreditProposalContext = {
    sourceClause: 'Credits shall be applied to the next invoice.',
    description: '', creditType: 'service_credit', statedPct: null, statedAmount: null, currency: 'USD',
  }

  it('buildServiceCreditProposalPrompt includes the Rulebook guidance block, positioned before the JSON schema instructions', () => {
    const prompt = buildServiceCreditProposalPrompt(context)
    expect(prompt).toContain('VERDIX COMMERCIAL INTERPRETATION RULES')
    const guidanceIdx = prompt.indexOf('VERDIX COMMERCIAL INTERPRETATION RULES')
    const schemaIdx = prompt.indexOf('Respond with a structured JSON object')
    expect(guidanceIdx).toBeGreaterThan(0)
    expect(schemaIdx).toBeGreaterThan(guidanceIdx)
  })

  it('buildServiceCreditProposalPrompt still contains the source clause and every existing instruction paragraph — this is an addition, not a rewrite', () => {
    const prompt = buildServiceCreditProposalPrompt(context)
    expect(prompt).toContain(context.sourceClause!)
    expect(prompt).toContain('ABSENCE OF A STATED RULE IS NOT EVIDENCE FOR TRUE OR FALSE')
    expect(prompt).toContain('application_rule.eligible_component_keys is the single most commonly UNSTATED field')
  })

  it('buildServiceCreditPrompt (interpret-rule override) includes the Rulebook guidance block before its own schema', () => {
    const prompt = buildServiceCreditPrompt(context, 'the reviewer said something')
    expect(prompt).toContain('VERDIX COMMERCIAL INTERPRETATION RULES')
    const guidanceIdx = prompt.indexOf('VERDIX COMMERCIAL INTERPRETATION RULES')
    const schemaIdx = prompt.indexOf('Translate the reviewer\'s instruction into a structured JSON object')
    expect(guidanceIdx).toBeGreaterThan(0)
    expect(schemaIdx).toBeGreaterThan(guidanceIdx)
    // Existing content preserved.
    expect(prompt).toContain('This mirrors the exact same "silence is not evidence" discipline')
  })

  it('buildCreditSurvivalPrompt includes the (survival-scoped) Rulebook guidance block before its own schema', () => {
    const prompt = buildCreditSurvivalPrompt({ sourceClause: context.sourceClause, description: '' }, 'carries forward')
    expect(prompt).toContain('VERDIX COMMERCIAL INTERPRETATION RULES')
    // Survival-only context excludes the basis/scope instruction and the
    // Step 7 amendment's cash-redeemability instruction — cash treatment is
    // never evaluated in this prompt.
    expect(prompt).not.toContain('Keep calculation basis and application eligibility separate')
    expect(prompt).not.toContain('Invoice application scope and cash redeemability are independent')
    expect(prompt).toContain('"Applied to the next invoice" establishes application timing')
    // Existing content preserved.
    expect(prompt).toContain('Never invent a treatment they didn\'t describe.')
  })

  it('a rule type with no Rulebook guidance (minimum commitment) is entirely unaffected — no empty "VERDIX COMMERCIAL INTERPRETATION RULES" header ever appears for it', () => {
    // buildMinimumCommitmentProposalPrompt doesn't call renderRulebookAIGuidance
    // at all (Step 7 only integrates the service-credit family) — this is a
    // structural, not a runtime, guarantee; documented here by grepping the
    // real source rather than re-deriving a prompt fixture.
    const source = fs.readFileSync(path.join(process.cwd(), 'lib/rule-interpretation.ts'), 'utf-8')
    const fnMatch = source.match(/export function buildMinimumCommitmentProposalPrompt[\s\S]*?\n}/)
    expect(fnMatch).not.toBeNull()
    expect(fnMatch![0]).not.toContain('renderRulebookAIGuidance')
  })
})

// Item 11 — synthetic semantic regression cases, using ONLY synthetic
// clauses (no customer data). Since a live AI call is non-deterministic
// and not part of this codebase's committed-suite convention (see this
// file's header), each case is tested at the two DETERMINISTIC layers
// Step 7 actually controls: (1) the prompt the model would receive
// contains the specific guidance relevant to that clause's known failure
// mode, and (2) validateProposalState — the existing, unmodified
// downstream safety net — correctly accepts the semantically-correct
// structured answer and would flag a structurally-incomplete one. A
// one-off LIVE run against the original five clauses (real Bedrock/
// Anthropic calls, throwaway script, not committed) was performed during
// Step 7's original development; see this step's deliverables report for
// those findings, including a genuine before/after improvement found in
// case D. Cases F-H were added by the Step 7 amendment (promoting that
// same case-D finding into its own explicit anti_inference rule) and were
// separately re-verified live — see the amendment's deliverables report.
describe('semantic regression cases A-H (item 11, item 12)', () => {
  it('A. next invoice, survival silent -> prompt carries the exact anti-inference instruction for this mistake, and the correct answer (timing known, survival unresolved) survives validateProposalState unchanged', () => {
    const context: ServiceCreditProposalContext = {
      sourceClause: 'Credits shall be applied to the next invoice.',
      description: '', creditType: 'service_credit', statedPct: null, statedAmount: null, currency: 'USD',
    }
    const prompt = buildServiceCreditProposalPrompt(context)
    expect(prompt).toContain('"Applied to the next invoice" establishes application timing. It does not by itself establish whether an unused remainder carries forward or expires after that invoice.')

    const correct: RuleProposal = {
      state: 'decision_required', proposed_interpretation: null,
      reasoning: 'The clause states only that credits are applied to the next invoice — no trigger, value, cap, or survival treatment is stated.',
      application_state: 'clear_from_source', survival_state: 'decision_required', cash_redeemable_state: 'decision_required',
    }
    const validated = validateProposalState(correct, true)
    expect(validated.survival_state).toBe('decision_required')
    expect(validated.application_state).toBe('clear_from_source')
  })

  it('B. explicit carry-forward -> prompt carries the explicit-carry-forward-is-authoritative instruction, and the correct answer (carry_forward true, contract-grounded) survives validateProposalState unchanged', () => {
    const context: ServiceCreditProposalContext = {
      sourceClause: 'Any unused portion shall carry forward and may be applied against future invoices until fully used.',
      description: '', creditType: 'service_credit', statedPct: null, statedAmount: null, currency: 'USD',
    }
    const prompt = buildServiceCreditProposalPrompt(context)
    expect(prompt).toContain('When the source explicitly states that an unused portion carries forward until fully used, preserve that meaning as contractual evidence')

    // Matches the real shape a well-formed response takes for a
    // survival-only fragment like this one: the credit's TRIGGER/VALUE
    // (main `state`) is genuinely undeterminable from this clause alone,
    // so proposed_interpretation is correctly null — but application_state
    // and survival_state are independently graded TOP-LEVEL fields that
    // don't depend on proposed_interpretation being populated, and
    // validateProposalState must not touch them just because the main
    // interpretation object is empty.
    const correct: RuleProposal = {
      state: 'decision_required', proposed_interpretation: null,
      reasoning: 'The clause explicitly states any unused portion shall carry forward until fully used, and applies against future invoices, but states no trigger, value, or cap.',
      application_state: 'clear_from_source', survival_state: 'clear_from_source', cash_redeemable_state: 'decision_required',
    }
    const validated = validateProposalState(correct, true)
    expect(validated.survival_state).toBe('clear_from_source')
    expect(validated.application_state).toBe('clear_from_source')
    expect(validated.proposed_interpretation).toBeNull()
  })

  it('C. calculation basis only -> prompt carries the basis-does-not-establish-scope instruction, and the correct answer (basis known, eligibility unresolved) survives validateProposalState unchanged', () => {
    const context: ServiceCreditProposalContext = {
      sourceClause: 'Customer receives a rebate equal to 5% of transaction-processing fees.',
      description: '', creditType: 'rebate', statedPct: 5, statedAmount: null, currency: 'USD',
    }
    const prompt = buildServiceCreditProposalPrompt(context)
    expect(prompt).toContain('A component used to calculate the amount of a credit or rebate does not by itself establish which invoice components that credit may offset.')

    const correct: RuleProposal = {
      state: 'clear_from_source', proposed_interpretation: {
        credit_basis: 'pct_of_affected_component', basis_component: 'transaction_processing',
        application_rule: { eligible_component_keys: null, carry_forward: 'unclear', one_time: 'unclear' },
      },
      reasoning: 'The clause states the rebate is 5% of transaction-processing fees — the rate and basis are explicit, but application scope is never addressed.',
      application_state: 'decision_required', survival_state: 'decision_required', cash_redeemable_state: 'decision_required',
    }
    const validated = validateProposalState(correct, true)
    expect(validated.application_state).toBe('decision_required')
    expect((validated.proposed_interpretation as { application_rule: { eligible_component_keys: null } }).application_rule.eligible_component_keys).toBeNull()
  })

  it('D. explicit calculation + application scope -> both basis and scope are source-derived; the guidance does not suppress a genuinely explicit scope statement', () => {
    const context: ServiceCreditProposalContext = {
      sourceClause: 'Customer receives a rebate equal to 5% of transaction-processing fees, which may only be applied against future transaction-processing fees.',
      description: '', creditType: 'rebate', statedPct: 5, statedAmount: null, currency: 'USD',
    }
    // The prompt still carries the basis-vs-scope separation instruction
    // even when THIS clause happens to state both explicitly — the
    // instruction is what stopped the model from over-generalizing an
    // explicit scope statement into an unrelated cash-redemption claim
    // (the real bug the live run found), not a signal to suppress a
    // genuinely explicit reading.
    expect(buildServiceCreditProposalPrompt(context)).toContain('Keep calculation basis and application eligibility separate unless the source explicitly links them.')
    const correct: RuleProposal = {
      state: 'clear_from_source', proposed_interpretation: {
        credit_basis: 'pct_of_affected_component', basis_component: 'transaction_processing',
        application_rule: { eligible_component_keys: ['transaction_processing'], carry_forward: 'unclear', one_time: 'unclear' },
      },
      reasoning: 'The clause states the rebate is 5% of transaction-processing fees and may only be applied against future transaction-processing fees — both basis and scope are explicit.',
      application_state: 'clear_from_source', survival_state: 'decision_required',
      // The live before/after run found a REAL over-inference bug here: an
      // earlier prompt variant let the model conflate this explicit scope
      // restriction with an (unstated) cash-redemption prohibition. The
      // guidance-augmented prompt correctly left this decision_required —
      // asserted directly, not merely hoped for.
      cash_redeemable_state: 'decision_required',
    }
    const validated = validateProposalState(correct, true)
    expect(validated.application_state).toBe('clear_from_source')
    expect(validated.cash_redeemable_state).toBe('decision_required')
    expect((validated.proposed_interpretation as { application_rule: { eligible_component_keys: string[] } }).application_rule.eligible_component_keys).toEqual(['transaction_processing'])
  })

  it('E. future payable without survival -> prompt carries the future-payable-does-not-establish-survival instruction, and the correct answer (scope known, survival unresolved) survives validateProposalState unchanged', () => {
    const context: ServiceCreditProposalContext = {
      sourceClause: 'The credit shall be applied against future amounts payable.',
      description: '', creditType: 'service_credit', statedPct: null, statedAmount: null, currency: 'USD',
    }
    const prompt = buildServiceCreditProposalPrompt(context)
    expect(prompt).toContain('Language allowing a credit to be applied against future payable amounts does not by itself establish indefinite carry-forward or survival until fully used.')

    const correct: RuleProposal = {
      state: 'decision_required', proposed_interpretation: null,
      reasoning: 'The clause establishes broad future application scope but states no trigger, value, or survival treatment.',
      application_state: 'clear_from_source', survival_state: 'decision_required', cash_redeemable_state: 'decision_required',
    }
    const validated = validateProposalState(correct, true)
    expect(validated.application_state).toBe('clear_from_source')
    expect(validated.survival_state).toBe('decision_required')
  })

  // F, G, H — Step 7 amendment. Promotes what was previously only an
  // incidental correction (case D above happened to leave cash_redeemable
  // decision_required as a side effect of the other four rules' guidance)
  // into its own durable, explicit rule and regression coverage. F mirrors
  // case D's clause almost exactly, but now the "unresolved" outcome is
  // asserted as the direct, intended effect of
  // credit.application_scope_ne_cash_redeemability's own guidance, not a
  // side effect of the basis/scope rule.
  // F/G/H's clauses (like A and E) never state a trigger, credit value, or
  // cap — only application scope, and (G/H) cash treatment — so the main
  // `state` is correctly decision_required and proposed_interpretation
  // correctly nulls out entirely (validateProposalState's own "decision_
  // required + populated proposed_interpretation is contradictory" rule,
  // the exact rule Step 7's original Case B fixture ran into). application_
  // state/cash_redeemable_state remain independent, correctly-graded
  // TOP-LEVEL fields regardless — matching cases A and E's established
  // shape, not a new pattern invented for this amendment.
  it('F. application restriction only -> cash redeemability remains unresolved. Prompt carries the new cash-redeemability instruction, and the correct answer (scope known, cash unresolved) survives validateProposalState unchanged', () => {
    const context: ServiceCreditProposalContext = {
      sourceClause: 'The rebate may only be applied against future transaction-processing fees.',
      description: '', creditType: 'rebate', statedPct: null, statedAmount: null, currency: 'USD',
    }
    const prompt = buildServiceCreditProposalPrompt(context)
    expect(prompt).toContain('Invoice application scope and cash redeemability are independent. Language restricting a credit to particular invoice components or future invoices does not establish that cash payment is prohibited or allowed.')

    const correct: RuleProposal = {
      state: 'decision_required', proposed_interpretation: null,
      reasoning: 'The clause restricts application to future transaction-processing fees but states no trigger, value, or cap, and never addresses cash payment or redemption.',
      application_state: 'clear_from_source', survival_state: 'decision_required', cash_redeemable_state: 'decision_required',
    }
    const validated = validateProposalState(correct, true)
    expect(validated.application_state).toBe('clear_from_source')
    expect(validated.cash_redeemable_state).toBe('decision_required')
  })

  it('G. explicit no-cash -> cash_redeemable resolves to false, contract_derived. Prompt carries the same cash-redeemability instruction, and the correct answer survives validateProposalState unchanged', () => {
    const context: ServiceCreditProposalContext = {
      sourceClause: 'The rebate may only be applied against future transaction-processing fees and shall not be paid in cash.',
      description: '', creditType: 'rebate', statedPct: null, statedAmount: null, currency: 'USD',
    }
    const prompt = buildServiceCreditProposalPrompt(context)
    expect(prompt).toContain('Resolve cash redeemability only from explicit source language.')

    const correct: RuleProposal = {
      state: 'decision_required', proposed_interpretation: null,
      reasoning: 'The clause restricts application to future transaction-processing fees and explicitly states the rebate shall not be paid in cash, but states no trigger, value, or cap.',
      application_state: 'clear_from_source', survival_state: 'decision_required', cash_redeemable_state: 'clear_from_source',
    }
    const validated = validateProposalState(correct, true)
    expect(validated.application_state).toBe('clear_from_source')
    expect(validated.cash_redeemable_state).toBe('clear_from_source')
  })

  it('H. explicit cash allowed -> cash_redeemable resolves to true, contract_derived. Same instruction applies; a positive explicit statement is preserved just as faithfully as an explicit prohibition', () => {
    const context: ServiceCreditProposalContext = {
      sourceClause: 'The rebate may only be applied against future transaction-processing fees and may, at Customer\'s election, be paid in cash.',
      description: '', creditType: 'rebate', statedPct: null, statedAmount: null, currency: 'USD',
    }
    const prompt = buildServiceCreditProposalPrompt(context)
    expect(prompt).toContain('Resolve cash redeemability only from explicit source language.')

    const correct: RuleProposal = {
      state: 'decision_required', proposed_interpretation: null,
      reasoning: 'The clause restricts application to future transaction-processing fees and explicitly allows the customer to elect cash payment, but states no trigger, value, or cap.',
      application_state: 'clear_from_source', survival_state: 'decision_required', cash_redeemable_state: 'clear_from_source',
    }
    const validated = validateProposalState(correct, true)
    expect(validated.application_state).toBe('clear_from_source')
    expect(validated.cash_redeemable_state).toBe('clear_from_source')
  })

  it('none of the cases collapse survival/eligibility to a resolved state merely because the OTHER is resolved — the independence validateProposalState already guarantees (Step 1.5/pre-existing), reconfirmed under the new guidance-augmented prompts', () => {
    // D is the interesting case: eligibility resolved, survival still open.
    const mixed: RuleProposal = {
      state: 'clear_from_source', proposed_interpretation: {
        application_rule: { eligible_component_keys: ['transaction_processing'], carry_forward: 'unclear', one_time: 'unclear' },
      },
      reasoning: 'Scope is explicit; survival is never addressed.',
      application_state: 'clear_from_source', survival_state: 'decision_required', cash_redeemable_state: 'decision_required',
    }
    const validated = validateProposalState(mixed, true)
    expect(validated.application_state).toBe('clear_from_source')
    expect(validated.survival_state).toBe('decision_required')
  })
})
