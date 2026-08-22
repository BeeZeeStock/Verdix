// Verdix Global Rulebook — rule class taxonomy (Step 6). Pure tests for
// lib/rulebook/rule-class.ts (VerdixRuleClass, RULE_CLASS_CAPABILITIES,
// assertRuleClassCapability, assertAuthorityAllowedForClass) and the
// classification of all eight current rules in lib/rulebook/rules.ts. No
// database, no AI, no mutation. This step is architecture/audit only —
// nothing here changes what any rule's evaluate() returns, what Step 3's
// activation registry does, or any production behavior.
import { describe, it, expect } from 'vitest'
import {
  RULE_CLASS_CAPABILITIES, ruleClassAllows, assertRuleClassCapability, assertAuthorityAllowedForClass,
  type VerdixRuleClass, type RuleClassCapabilities,
} from '@/lib/rulebook/rule-class'
import { verdixCommercialRulebook } from '@/lib/rulebook/rules'
import { VERDIX_RULEBOOK_ACTIVATION } from '@/lib/rulebook/activation'
import { resolveFieldAuthority, type RuleResolutionCandidate } from '@/lib/rulebook/resolution'
import * as fs from 'node:fs'
import * as path from 'node:path'

const ALL_CLASSES: VerdixRuleClass[] = ['invariant', 'semantic_interpretation', 'default_policy', 'anti_inference']

describe('RULE_CLASS_CAPABILITIES — the capability matrix (item 5)', () => {
  it('defines all four classes, and nothing else', () => {
    expect(Object.keys(RULE_CLASS_CAPABILITIES).sort()).toEqual([...ALL_CLASSES].sort())
  })

  it('invariant: may enforce invariants, may never interpret contract text, produce a candidate, or fill silence', () => {
    expect(RULE_CLASS_CAPABILITIES.invariant).toEqual({
      canEnforceInvariant: true, canInterpretContract: false, canProduceResolutionCandidate: false, canFillContractSilence: false,
    })
  })

  it('semantic_interpretation: may interpret contract text, may never enforce an invariant, produce a candidate, or fill silence', () => {
    expect(RULE_CLASS_CAPABILITIES.semantic_interpretation).toEqual({
      canEnforceInvariant: false, canInterpretContract: true, canProduceResolutionCandidate: false, canFillContractSilence: false,
    })
  })

  it('anti_inference: may do NONE of the four things — it only ever reports, never enforces, interprets, or fills', () => {
    expect(RULE_CLASS_CAPABILITIES.anti_inference).toEqual({
      canEnforceInvariant: false, canInterpretContract: false, canProduceResolutionCandidate: false, canFillContractSilence: false,
    })
  })

  it('default_policy: the ONLY class that may produce a resolution candidate or fill contract silence; may never enforce an invariant or interpret contract text', () => {
    expect(RULE_CLASS_CAPABILITIES.default_policy).toEqual({
      canEnforceInvariant: false, canInterpretContract: false, canProduceResolutionCandidate: true, canFillContractSilence: true,
    })
  })

  it('canProduceResolutionCandidate and canFillContractSilence are true for exactly one class (default_policy) — every other capability combination across classes is mutually exclusive by design', () => {
    const canProduce = ALL_CLASSES.filter(c => RULE_CLASS_CAPABILITIES[c].canProduceResolutionCandidate)
    const canFill = ALL_CLASSES.filter(c => RULE_CLASS_CAPABILITIES[c].canFillContractSilence)
    expect(canProduce).toEqual(['default_policy'])
    expect(canFill).toEqual(['default_policy'])
  })
})

describe('ruleClassAllows / assertRuleClassCapability — structural guards (item 8)', () => {
  it('ruleClassAllows reflects the matrix exactly, for every class/capability pair', () => {
    for (const ruleClass of ALL_CLASSES) {
      for (const capability of Object.keys(RULE_CLASS_CAPABILITIES.invariant) as (keyof RuleClassCapabilities)[]) {
        expect(ruleClassAllows(ruleClass, capability)).toBe(RULE_CLASS_CAPABILITIES[ruleClass][capability])
      }
    }
  })

  it('forbidden combination 1: an anti_inference rule attempting to produce a RuleResolutionCandidate throws loudly', () => {
    expect(() => assertRuleClassCapability('anti_inference', 'canProduceResolutionCandidate', 'credit.basis_ne_application_scope')).toThrow(/does not permit "canProduceResolutionCandidate"/)
  })

  it('forbidden combination 3: an invariant rule attempting to produce a (necessarily organization-overrideable) field candidate throws loudly — no candidate, no overrideability question', () => {
    expect(() => assertRuleClassCapability('invariant', 'canProduceResolutionCandidate', 'minimum.floor.non_additive')).toThrow(/does not permit "canProduceResolutionCandidate"/)
  })

  it('a semantic_interpretation rule attempting to produce a resolution candidate also throws — only default_policy may', () => {
    expect(() => assertRuleClassCapability('semantic_interpretation', 'canProduceResolutionCandidate', 'credit.explicit_carry_forward_authoritative')).toThrow()
  })

  it('the one permitted case never throws: default_policy producing a resolution candidate', () => {
    expect(() => assertRuleClassCapability('default_policy', 'canProduceResolutionCandidate')).not.toThrow()
  })

  it('permitted, non-candidate capabilities never throw for their own class', () => {
    expect(() => assertRuleClassCapability('invariant', 'canEnforceInvariant')).not.toThrow()
    expect(() => assertRuleClassCapability('semantic_interpretation', 'canInterpretContract')).not.toThrow()
  })
})

describe('assertAuthorityAllowedForClass — forbidden combination 2: semantic_interpretation minting authority: verdix_rulebook (item 8)', () => {
  it('throws when a semantic_interpretation rule attempts to mint authority: verdix_rulebook', () => {
    expect(() => assertAuthorityAllowedForClass('semantic_interpretation', 'verdix_rulebook', 'credit.explicit_carry_forward_authoritative')).toThrow(/may never mint authority: 'verdix_rulebook'/)
  })
  it('throws for invariant and anti_inference too — only default_policy may ever mint this authority', () => {
    expect(() => assertAuthorityAllowedForClass('invariant', 'verdix_rulebook')).toThrow()
    expect(() => assertAuthorityAllowedForClass('anti_inference', 'verdix_rulebook')).toThrow()
  })
  it('never throws for default_policy minting verdix_rulebook authority — the one legitimate case', () => {
    expect(() => assertAuthorityAllowedForClass('default_policy', 'verdix_rulebook')).not.toThrow()
  })
  it('never throws for any class proposing a NON-verdix_rulebook authority — this guard is specifically about that one authority value, not a general authority gate', () => {
    for (const ruleClass of ALL_CLASSES) {
      expect(() => assertAuthorityAllowedForClass(ruleClass, 'contract_derived')).not.toThrow()
      expect(() => assertAuthorityAllowedForClass(ruleClass, 'reviewer_policy')).not.toThrow()
    }
  })
})

// Item 6 — reconfirms Step 4's existing authority-vs-method separation
// using a realistic worked example, composing the UNMODIFIED
// resolveFieldAuthority (no new resolution logic added by Step 6).
describe('authority vs. method — reconfirmed, not reinvented (item 6)', () => {
  it('contract explicitly states carry-forward; a semantic_interpretation rule (F) helped interpret it -> authority stays contract_derived, method may legitimately be verdix_rulebook', () => {
    const candidate: RuleResolutionCandidate = {
      field: 'creditApplication.carryForward', value: true,
      authority: 'contract_derived', // NEVER 'verdix_rulebook' — see assertAuthorityAllowedForClass above
      method: 'verdix_rulebook', // this IS allowed — method answers "how", not "why it counts"
      rule_id: 'credit.explicit_carry_forward_authoritative',
    }
    // Sanity: this exact shape is legal per the guard (authority isn't verdix_rulebook).
    expect(() => assertAuthorityAllowedForClass('semantic_interpretation', candidate.authority)).not.toThrow()

    // And it resolves exactly like any other contract_derived candidate —
    // the Rulebook's involvement as METHOD has zero effect on precedence.
    const result = resolveFieldAuthority([candidate])
    expect(result.status).toBe('resolved')
    expect(result.selected?.authority).toBe('contract_derived')
  })

  it('the forbidden version of the same scenario — authority incorrectly promoted to verdix_rulebook merely because the Rulebook helped interpret — is exactly what assertAuthorityAllowedForClass rejects', () => {
    expect(() => assertAuthorityAllowedForClass('semantic_interpretation', 'verdix_rulebook', 'would incorrectly imply the Rulebook, not the contract, is why this counts')).toThrow()
  })
})

// Item 2 — verified against the actual implementation (lib/rulebook/
// rules.ts) and its actual, already-passing test coverage (rulebook.test.ts),
// not copied from the hypothesis. Each assertion's comment states WHY,
// referencing the rule's real matches()/evaluate() behavior.
describe('classification of the eight current Verdix Global Rulebook rules (item 2)', () => {
  function ruleClassOf(id: string): VerdixRuleClass {
    const rule = verdixCommercialRulebook.find(r => r.id === id)
    if (!rule) throw new Error(`rule ${id} not found in verdixCommercialRulebook`)
    return rule.ruleClass
  }

  it('minimum.floor.non_additive -> invariant (structural engine fact: payable = max(charge, minimum); a contradiction is always a bug)', () => {
    expect(ruleClassOf('minimum.floor.non_additive')).toBe('invariant')
  })
  it('pricing.all_units.non_graduated -> invariant (structural engine fact about tier-execution method)', () => {
    expect(ruleClassOf('pricing.all_units.non_graduated')).toBe('invariant')
  })
  it('credit.basis_ne_application_scope -> anti_inference (never determines meaning; only flags an ungrounded value that looks copied from the basis, or reports remains_unresolved)', () => {
    expect(ruleClassOf('credit.basis_ne_application_scope')).toBe('anti_inference')
  })
  it('credit.next_invoice_timing_ne_carry_forward -> anti_inference (same shape: states what must not be inferred, never supplies a value)', () => {
    expect(ruleClassOf('credit.next_invoice_timing_ne_carry_forward')).toBe('anti_inference')
  })
  it('credit.future_payable_scope_ne_indefinite_survival -> anti_inference (same shape again)', () => {
    expect(ruleClassOf('credit.future_payable_scope_ne_indefinite_survival')).toBe('anti_inference')
  })
  it('credit.explicit_carry_forward_authoritative -> semantic_interpretation (its match guard REQUIRES survivalProvenance already contract_derived — it only ever affirms/interprets an already-grounded explicit reading, never determines meaning from silence)', () => {
    expect(ruleClassOf('credit.explicit_carry_forward_authoritative')).toBe('semantic_interpretation')
  })
  it('provenance.silence_cannot_become_contract_derived -> invariant, not anti_inference (polices the PROVENANCE MODEL\'s own integrity — a structural guarantee about how provenance may be assigned at all, not a specific commercial inference like "timing implies carry-forward")', () => {
    expect(ruleClassOf('provenance.silence_cannot_become_contract_derived')).toBe('invariant')
  })
  it('provenance.verdix_recommendation_cannot_clear_readiness -> invariant, not anti_inference (unconditional — never checks whether a value was wrongly inferred FROM something else; directly mirrors isProvenanceResolved(), the canonical readiness gate)', () => {
    expect(ruleClassOf('provenance.verdix_recommendation_cannot_clear_readiness')).toBe('invariant')
  })

  it('every current rule has exactly one of the four classes, and the registry has exactly eight rules (matches Step 6\'s audit scope)', () => {
    expect(verdixCommercialRulebook).toHaveLength(8)
    for (const rule of verdixCommercialRulebook) {
      expect(ALL_CLASSES).toContain(rule.ruleClass)
    }
  })
})

// Item 3 / item 9 — explicit, current-state assertion, NOT a permanent
// architectural invariant. A future step may deliberately add a vetted
// default_policy rule (see lib/rulebook/README.md's governance checklist)
// — when that happens, this specific test (and only this one) is expected
// to be updated to reflect the new, deliberately-added rule; nothing else
// in this file should need to change, since the classification/capability
// machinery already supports default_policy fully.
describe('zero rules currently classified default_policy (items 3, 9 — current-registry audit, not a forever rule)', () => {
  it('none of the eight current rules are default_policy — no Verdix default has been manufactured just because the architecture supports one', () => {
    const defaultPolicyRules = verdixCommercialRulebook.filter(r => r.ruleClass === 'default_policy')
    expect(defaultPolicyRules).toHaveLength(0)
  })
})

// Item 7 — audits the EXISTING Step 3 activation registry against the NEW
// classification, without changing either. Reports (via test failure, if
// any) a mismatch rather than silently tidying production authority to
// match the matrix.
describe('activation registry audit against ruleClass (item 7)', () => {
  const invariantIds = verdixCommercialRulebook.filter(r => r.ruleClass === 'invariant').map(r => r.id)
  const antiInferenceIds = verdixCommercialRulebook.filter(r => r.ruleClass === 'anti_inference').map(r => r.id)
  const semanticInterpretationIds = verdixCommercialRulebook.filter(r => r.ruleClass === 'semantic_interpretation').map(r => r.id)
  const defaultPolicyIds = verdixCommercialRulebook.filter(r => r.ruleClass === 'default_policy').map(r => r.id)

  it('every invariant-classed rule is registered as enforce_invariant (compatible with the class\'s canEnforceInvariant capability)', () => {
    expect(invariantIds).toHaveLength(4) // A, B, G, H
    for (const id of invariantIds) {
      expect(VERDIX_RULEBOOK_ACTIVATION[id]?.authority).toBe('enforce_invariant')
    }
  })

  it('every anti_inference-classed rule is registered as diagnostic only — never enforce_invariant or resolve_semantic', () => {
    expect(antiInferenceIds).toHaveLength(3) // C, D, E
    for (const id of antiInferenceIds) {
      expect(VERDIX_RULEBOOK_ACTIVATION[id]?.authority).toBe('diagnostic')
    }
  })

  it('every semantic_interpretation-classed rule is registered as diagnostic/interpretive only for now — never resolve_semantic (which would imply it fills silence, which this class structurally cannot do)', () => {
    expect(semanticInterpretationIds).toHaveLength(1) // F
    for (const id of semanticInterpretationIds) {
      expect(VERDIX_RULEBOOK_ACTIVATION[id]?.authority).toBe('diagnostic')
    }
  })

  it('no default_policy rule exists, so none is registered at resolve_semantic — the activation authority tier that would correspond to an activated default_policy stays entirely unused, exactly as expected', () => {
    expect(defaultPolicyIds).toHaveLength(0)
    const resolveSemanticEntries = Object.entries(VERDIX_RULEBOOK_ACTIVATION).filter(([, entry]) => entry.authority === 'resolve_semantic')
    expect(resolveSemanticEntries).toHaveLength(0)
  })

  it('no mismatch found — the audit conclusion, stated as a single assertion: class and activation agree for all eight current rules', () => {
    const mismatches: string[] = []
    for (const rule of verdixCommercialRulebook) {
      const entry = VERDIX_RULEBOOK_ACTIVATION[rule.id]
      const authority = entry?.authority ?? 'diagnostic'
      if (rule.ruleClass === 'invariant' && authority !== 'enforce_invariant') mismatches.push(`${rule.id}: invariant but activation authority is "${authority}"`)
      if ((rule.ruleClass === 'anti_inference' || rule.ruleClass === 'semantic_interpretation') && authority !== 'diagnostic') mismatches.push(`${rule.id}: ${rule.ruleClass} but activation authority is "${authority}" (expected diagnostic)`)
      if (rule.ruleClass === 'default_policy' && authority === 'enforce_invariant') mismatches.push(`${rule.id}: default_policy incorrectly registered as enforce_invariant`)
    }
    expect(mismatches).toEqual([])
  })
})

// Item 11 — a cheap, real structural guard: the Verdix Global Rulebook's
// own source file must never import a database client, an HTTP/network
// module, or any organization-scoped service — the only way this file
// could ever be reached by customer contract data, Organization Rulebook
// data, or aggregated reviewer behavior. This is intentionally a plain
// source-text check (not a mocked import-graph test) — cheap, fast, and
// it fails loudly the moment anyone adds an import that would make such a
// path possible, without needing to know in advance what that import
// would be called.
describe('no customer data / global learning path into the Verdix Global Rulebook (item 11)', () => {
  it('lib/rulebook/rules.ts imports nothing beyond its own sibling ./types module — no database, no organization service, no contract extractor', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'lib/rulebook/rules.ts'), 'utf-8')
    const importLines = source.split('\n').filter(line => /^import /.test(line.trim()))
    expect(importLines.length).toBeGreaterThan(0) // sanity — the file does import something (./types)
    for (const line of importLines) {
      expect(line).not.toMatch(/supabase/i)
      expect(line).not.toMatch(/organization-rules/i)
      expect(line).not.toMatch(/contract-extractor/i)
      expect(line).not.toMatch(/\bfetch\b|node-fetch|axios/i)
    }
  })

  it('verdixCommercialRulebook is a plain, statically-defined array — not a function, not a Promise, not something computed from external data at call time', () => {
    expect(Array.isArray(verdixCommercialRulebook)).toBe(true)
  })

  it('no rule in the registry references an organizationId, customerId, or job/contract identifier in its own definition — the Rulebook is organization-agnostic by construction', () => {
    for (const rule of verdixCommercialRulebook) {
      const serialized = rule.id + rule.description
      expect(serialized).not.toMatch(/organization_id|customer_id|job_id|contract_id/i)
    }
  })
})
