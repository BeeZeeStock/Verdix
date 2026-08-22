# Verdix Global Rulebook — governance

This directory implements the **Verdix Global Rulebook**: a small,
code-defined, version-controlled registry of commercial semantics
(`rules.ts`), a shadow evaluator (`resolver.ts`), a production activation
layer (`activation.ts`), a field-authority precedence resolver
(`resolution.ts`), and — separately — the **private Organization
Rulebook** (`organization-rules*.ts`, `organization-rulebook-*.ts`). This
note is about the *Global* Rulebook specifically: what it is, what it is
not, and what governs adding to it.

## What the Global Rulebook is

A rule is one of four classes (`rule-class.ts`'s `VerdixRuleClass`):

- **`invariant`** — a structural fact the calculation/readiness engine
  must always hold (e.g. "floor mode is never additive"). Violating it is
  always a bug, never a customer-specific ambiguity. Never supplies
  missing customer policy.
- **`semantic_interpretation`** — helps Verdix deterministically interpret
  contract language that is already **explicit**. The resulting field's
  authority stays `contract_derived` (or `reviewer_policy`) — the
  Rulebook may appear as interpretation *method*, never as *authority*.
  See `resolution.ts`'s authority-vs-method split and
  `rule-class.ts`'s `assertAuthorityAllowedForClass`.
- **`anti_inference`** — explicitly states what Verdix must **not**
  infer (e.g. "calculation basis does not establish application scope").
  Preserves silence; never supplies a value.
- **`default_policy`** — may supply a value when the contract, a
  contract-specific reviewer decision, *and* an Organization Rulebook
  policy are all silent. The only class that may ever produce a
  `RuleResolutionCandidate` or mint `authority: 'verdix_rulebook'`. An
  Organization Rulebook policy always outranks it.

As of Step 7, **zero** of the nine current rules are classified
`default_policy` — see `tests/commercial-semantics/rulebook/rule-class
.test.ts`. This is the expected, audited state, not an oversight: no
current rule was ever meant to fill customer silence, and none was
forced into that class just because the architecture supports one.

## What qualifies as a Verdix default

A proposed `default_policy` rule must satisfy **all** of the following
before it is added to `rules.ts`, let alone activated in production:

1. The contract is **genuinely silent** on the field — not merely
   ambiguous, not a case where a reviewer typically clarifies it.
2. The policy is **broadly commercially defensible** as a general
   operating convention — not merely a plausible or convenient guess.
3. It does **not rewrite** explicit contractual language — precedence
   (`contract_derived` > `reviewer_policy` > `organization_rulebook` >
   `verdix_rulebook`) already guarantees this structurally, but the rule
   itself must be designed with that boundary in mind, not merely rely on
   the resolver to save it.
4. It is **safe to override** by an Organization Rulebook policy — the
   default must be a sensible starting point a customer can reasonably
   replace, not something whose absence would be a correctness bug.
5. It ships with **positive, negative, and counterexample fixtures** —
   the same "supports / contradicts / remains_unresolved" discipline
   every current rule already follows (see `rules.ts`'s own worked
   examples and `tests/commercial-semantics/rulebook/rulebook.test.ts`).
6. It has been **validated using Verdix-controlled or synthetic testing**
   — never against a live customer's actual contract data.
7. It is **not derived from customer contracts or cross-customer
   behavior** — see "No customer data, no global learning" below.
8. **Production activation is a separate, explicit decision** — adding a
   rule to `rules.ts` with `ruleClass: 'default_policy'` does not, by
   itself, activate it. That requires a deliberate change to
   `activation.ts`'s `VERDIX_RULEBOOK_ACTIVATION` registry (authority:
   `'resolve_semantic'`), reviewed and approved on its own, exactly like
   any other activation change.

Customer-specific policy — "this particular organization always wants
unused credit balances to carry forward" — belongs in the **Organization
Rulebook**, not here. The Global Rulebook is Verdix product semantics;
the Organization Rulebook is tenant-private configuration. Conflating the
two would mean one customer's operating convention silently becoming
every customer's default, which is exactly what this separation exists
to prevent.

## Candidate lifecycle (Step 9)

New Global Rulebook rules do not appear because "we found a weird clause,
so we added a rule." They go through an explicit, code-defined,
version-controlled lifecycle (`candidate.ts`'s `VerdixCandidateStatus`):

1. **OBSERVED** — a Verdix-controlled test (synthetic corpus, internal
   test, or a controlled live-model comparison) exposes a pattern that
   *might* be reusable beyond the one fixture that surfaced it. Nothing
   is generalized yet; no evidence is required at this stage.
2. **CANDIDATE** — the underlying principle is generalized beyond the
   individual fixture into a `proposedRuleId`/`proposedClass`/`principle`
   — a real, reviewable proposal, even if its evidence is still thin.
3. **VALIDATED** — positive **and** counterexample/negative fixtures
   demonstrate the principle holds *and* knows its own boundaries. The
   exact evidence shape is **class-aware** (`candidate-validation.ts`):
   - `invariant` — a positive fixture, an adversarial fixture, and **no**
     legitimate counterexample (a real counterexample would disprove it).
   - `anti_inference` / `semantic_interpretation` — at least one positive
     fixture and at least one counterexample (prefer 2+2 where
     practical — never a rigid quantity rule for every class).
   - `default_policy` — a materially higher bar: multiple (≥ 2)
     Verdix-controlled fixtures, a counterexample, **and** explicit
     `defaultPolicyApproval` metadata (organization overrideability +
     acknowledgement that production activation is a separate decision).
4. **APPROVED** — a human product/engineering review accepts the
   candidate as Verdix commercial doctrine. This is a decision *about*
   the candidate record — it is still not the same as being an active
   Rulebook rule.
5. **ACTIVE** — a human has actually added the corresponding entry to
   `rules.ts` (and, separately, wired activation/AI-guidance if
   applicable) through a normal, reviewed commit. The candidate's
   `activeRuleId` is then set to record that the promotion happened.

`lib/rulebook/rule-candidates.ts` holds the real registry —
`CASH_REDEEMABILITY_CANDIDATE` is the first worked example, a
*retrospective* record for `credit.application_scope_ne_cash_
redeemability` (the Step 7 amendment), walking through all five stages in
its own comment. It does not change that already-active rule; it exists
to document why the rule exists.

**Promotion is always a human/code-review action** (`candidate-
validation.ts`'s own header comment). There is no function anywhere in
this codebase that reads `candidate.status === 'approved'` and writes an
entry into `verdixCommercialRulebook` — `validateVerdixRuleCandidate` can
only reject a candidate; it can never promote one. A real promotion
means a developer: reviews the candidate's evidence, hand-writes the
`rules.ts` entry (and its tests), bumps whichever version(s) below are
affected, and ships it through the normal PR/code-review path — exactly
how Steps 6 and 7 themselves shipped.

### Version-bump discipline

Three independent version constants exist; a change to Rulebook behavior
should bump exactly the ones it actually affects, never all three
reflexively and never none:

| Constant | Location | Bump when… |
|---|---|---|
| `VERDIX_RULEBOOK_VERSION` | `rules.ts` | A rule is added, removed, or its `matches()`/`evaluate()` semantics change — i.e. what the Rulebook *concludes* changes. |
| `RULEBOOK_AI_GUIDANCE_VERSION` | `ai-guidance.ts` | An `aiGuidance.instruction` wording changes, a new guidance entry is added, or an `appliesTo` context list changes — i.e. what the AI *sees* changes. Embedded directly in the rendered prompt header, so this also drives `propose-rule`'s existing prompt-fingerprint cache invalidation automatically. |
| `VERDIX_RULEBOOK_ACTIVATION_VERSION` | `activation.ts` | A rule's production authority/enforcement target changes (e.g. `diagnostic` → `enforce_invariant`) — i.e. what production *does* with a finding changes. |

A single change can affect more than one axis (e.g. promoting a new
`anti_inference` rule with guidance bumps both `VERDIX_RULEBOOK_VERSION`
and `RULEBOOK_AI_GUIDANCE_VERSION`, but not `VERDIX_RULEBOOK_ACTIVATION_
VERSION` unless its production authority also changes) — bump each
applicable constant independently, never as a bundle.

### Registry integrity audit

`rulebook-audit.ts`'s `auditVerdixRulebook()` is a pure, read-only
cross-check between the real, active Rulebook and the candidate registry
that's supposed to explain it: rule ids unique, every `approved` +
`activeRuleId` candidate corresponds to a real rule at the class it was
approved for, every rule has an activation entry, AI-guidance eligibility
matches each rule's class, no `default_policy` rule is active without
`defaultPolicyApproval`, and no candidate has a customer-derived origin.
Run in tests (`tests/commercial-semantics/rulebook/rulebook-audit
.test.ts`) — never in a production billing path.

## No customer data, no global learning

There is no code path, anywhere in this codebase, that goes:

- customer contract → Verdix Global Rulebook
- Organization Rulebook → Verdix Global Rulebook
- repeated customer reviewer behavior → Verdix Global Rulebook

`rules.ts` is a plain, statically-defined, code-reviewed array. It has no
database import, no network import, no dependency on
`organization-rules-service.ts` or any other org-scoped module, and no
rule references an `organization_id`, `customer_id`, `job_id`, or
`contract_id` — see `tests/commercial-semantics/rulebook/rule-class
.test.ts`'s structural guard, which fails loudly if a future import ever
makes such a path possible. `organization-rules.ts` states explicitly, in
its own header comment, that an organization rule is never promoted into
the Global Rulebook, and no code anywhere does that promotion.

Global Rulebook evolution is, and remains, a **curated product-
development process**: a Verdix engineer proposes a rule, backs it with
Verdix-owned/internal/synthetic fixtures, and it ships through the normal
code-review path above — never an automated pipeline fed by customer or
aggregate behavior.

## Class vs. activation — two different questions

`VerdixRuleClass` (this file's subject) answers *what kind of thing is
this rule* — is it capable, in principle, of enforcing an invariant,
interpreting explicit text, filling silence, or only ever reporting.
`activation.ts`'s `RulebookAuthority` (`'diagnostic' | 'enforce_invariant'
| 'resolve_semantic'`) answers a completely different question: *is this
rule switched on in production today, and if so, where does its effect
land*. A rule's class does not by itself grant it production authority —
see `rule-class.ts`'s own header comment, and
`tests/commercial-semantics/rulebook/rule-class.test.ts`'s activation-
registry audit, which confirms the two currently agree for all eight
rules without ever letting one silently drive the other.
