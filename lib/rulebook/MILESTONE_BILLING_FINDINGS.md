# Step 10 — milestone/project-billing architecture validation

This is an exploration + regression exercise, not a feature build. It
tests whether the commercial-rule architecture built in Steps 1–9
(provenance, Global Rulebook classes, AI guidance, decision tracing,
candidate governance) generalizes to a contract family Verdix has never
specifically optimized for: **project / milestone-based B2B billing**.

No new Global Rulebook rule was activated. No Organization Rulebook
production field was added. No prompt was changed. No billing behavior
was changed. Everything below is evidence gathered by running the
**current, unmodified production model and routing** against a
Verdix-controlled synthetic fixture family, plus the current, unmodified
Global Rulebook/decision-trace/candidate-governance machinery.

## Synthetic fixture family

Seven synthetic, customer-independent, Verdix-controlled fixtures —
`tests/commercial-semantics/milestone-billing/fixtures.ts` — Cases A–F as
specified, plus Case G (a deliberate counterexample to C, per item 10).
None contain real contract text or customer data.

## 1. Existing-model capability matrix

| Concept | Existing representation | Fully expressible? | Partially expressible? | Not expressible? | Execution support? | Review/provenance support? |
|---|---|:-:|:-:|:-:|:-:|:-:|
| Milestone fixed amount | `OneTimeFee.amount` | ✅ | | | ✅ (parked → manual invoice) | ❌ none |
| Acceptance trigger (generic "needs confirmation") | `OneTimeFee.manual_trigger: boolean` | | ✅ (coarse) | | ✅ (parked-invoices route) | ❌ none |
| Acceptance trigger (*specifically* customer acceptance, vs. plain delivery, vs. internal sign-off) | — | | | ✅ | ❌ | ❌ |
| Deemed acceptance (N-day review window) | — | | | ✅ | ❌ | ❌ |
| Delivery vs. acceptance as distinct events | — | | | ✅ | ❌ | ❌ |
| Milestone sequencing / ordering | — | | | ✅ | ❌ | ❌ |
| Percentage-of-total-project-fee basis | — (extraction computes an absolute amount and discards the % relationship) | | | ✅ | n/a | ❌ |
| Advance/signature payment | `OneTimeFee` + `due_date`, `manual_trigger: false` | ✅ | | | ✅ (auto-invoices when due) | ❌ none |
| Change order / bilateral written approval gate | `OneTimeFee.manual_trigger` + `amount: 0` (reused "amount unknown" convention) | | ✅ (coarse — indistinguishable from unilateral confirmation) | | ✅ (parked) | ❌ none |
| Retention / holdback (partial payment, partial deferred) | — (whole amount folds into one `OneTimeFee`, split only in free-text `description`) | | | ✅ | ❌ | ❌ |
| Retention release trigger (final acceptance) | — | | | ✅ | ❌ | ❌ |
| Delay-penalty trigger (elapsed time past a deadline) | `CreditEarnRule.trigger_metric_key` (generic) | | ✅ | | ✅ (via credit ledger, once wired) | ✅ (full — reuses `ServiceCredit`/`CreditApplicationRule`/`FieldProvenance`) |
| Delay-penalty "complete week" quantity treatment | `CreditEarnRule.quantity_treatment: 'complete_units'` | ✅ | | | ✅ | ✅ |
| Delay-penalty percentage basis + cap | `ServiceCreditInterpretation.credit_basis`/`credit_value`/`cap_pct` | ✅ | | | ✅ | ✅ |
| Delay-penalty recurring "per elapsed week" window | `CreditEarnRule.trigger_window` (enum has no weekly-elapsed-time member; model fell back to `'per_incident'`) | | ✅ | | ⚠️ approximate | ✅ |
| Entitlement (earned) vs. invoiceability (billable now) | `OneTimeFee.manual_trigger` (all-or-nothing boolean) | | ✅ (coarse, binary only) | | ⚠️ binary only, no partial | ❌ none |

**Headline finding:** `OneTimeFee` is the only existing structure this
contract family maps onto, and it has **zero** participation in the
provenance/readiness/Rulebook/decision-trace architecture Steps 1–9
built — no `FieldProvenance`, no `requires_confirmation`, no
propose-rule/confirm-rule HITL flow, nothing in `computeCommercialRuleWorkload`.
Every one of the credit-family gaps (application scope, survival,
cash redeemability, over-inference) already have Rulebook coverage; every
one of the milestone-family gaps has **no normalized field to even
attempt coverage against**.

## 2. Gap classification (item 3)

**A. Extraction gap** (source meaning exists, AI fails to capture it) —
**one genuine finding**: Case F's milestone `due_date` was set to the
delay-penalty reference date ("agreed completion date") with
`manual_trigger: false`, which would auto-invoice on that date regardless
of whether the milestone was actually complete/accepted. The model
conflated "the date delay is measured from" with "the date this fee is
due." This is a real, reportable extraction-quality issue — **not fixed**
in this step (item 16: report first; this is a single baseline
observation from a synthetic fixture, not a governance-approved semantic
principle, and fixing it opportunistically here would be exactly the
"disguise feature development as a bug fix" item 16 warns against).

**B. Semantic-model gap** (Verdix has no normalized representation) — the
dominant category, and where nearly everything above actually lives:
acceptance-event type, deemed-acceptance windows, delivery≠acceptance,
milestone sequencing, percentage-of-total basis, retention/holdback split,
retention release trigger, and the categorical difference between a
bilateral-signature gate (change order) and a unilateral-confirmation gate
(plain delivery). None of these can be represented today without a new
field — and Step 10 deliberately does not add one (item 11).

**C. Execution-engine gap** — narrower than expected: the delay-penalty
mechanics (percentage basis, cap, complete-unit quantity treatment)
**already have a working engine** (`lib/credit-ledger.ts`'s `evaluateCreditEarn`).
The one real execution gap is `CreditEarnRule.trigger_window`'s enum
(`'calendar_month' | 'billing_period' | 'contract_year' | 'per_incident'`)
having no member for "recurring elapsed time since a fixed deadline" —
the interpretation layer approximated it as `'per_incident'`, which would
need verification against the actual credit-ledger window-enumeration
logic before this could safely execute a real weekly-accruing delay
credit. Everything else in this family that reaches the credit primitive
already has full execution support once entitlement/timing is resolved.

**D. Review/provenance gap** — `OneTimeFee` has no `FieldProvenance`, no
`requires_confirmation`, no interpretation/confirmation flow at all — it
was extracted once and goes straight to `manual_trigger`-gated invoicing.
Every milestone concept above that could theoretically be represented
still has nowhere to record *whose decision* resolved it (contract text?
a reviewer? an organization default?) — the entire Step 4–9 provenance
apparatus simply doesn't reach `OneTimeFee` today.

## 3. Entitlement vs. invoiceability (item 4)

Confirmed as a real, missing distinction, most clearly in Case E: the
contract states a milestone is **earned** (SEK 250,000, approved
milestone invoice) but only **90% is currently payable** — the remaining
10% is earned-but-not-yet-invoiceable pending a later release trigger
(final acceptance). Today's model can express "invoiceable: yes/no" via
`manual_trigger`, but has no representation of **partial** invoiceability,
nor any distinction between "not yet earned" and "earned but held back."
Recorded as a semantic-model gap — see `MILESTONE_ENTITLEMENT_NE_INVOICEABILITY_OBSERVATION`
in `rule-candidates.ts`.

## 4. Trigger semantics (item 5)

The baseline extraction did **not** collapse distinct triggers into a
generic "milestone completed." Contract signature (Case B, auto-invoices
on `due_date`), design acceptance, final acceptance, and delay-elapsed-time
(Case F) all extracted as genuinely distinct shapes at the AI-output
level. The loss happens **structurally**, not semantically: every
acceptance-flavored trigger collapses into the same `manual_trigger: true`
+ free-text description once it lands in `OneTimeFee`, because that's the
only field available — the AI correctly preserved the distinction in
prose; the *schema* is what discards it.

## 5. Baseline AI results (item 6)

Live run, current production model/routing (Sonnet via Bedrock,
`extractContractTerms`, zero prompt changes), all 7 fixtures — full
results captured in `tests/commercial-semantics/milestone-billing/baseline-extraction.test.ts`.
Summary:

- **No over-inference observed anywhere.** No case invented a structured
  acceptance/retention/change-order field that doesn't exist; every
  unsupported concept was preserved as accurate free text instead
  (`extraction_notes`, `OneTimeFee.description`) — exactly the "correctly
  preserving an unsupported concept is preferable to inventing an
  executable interpretation" behavior item 6 asks to verify.
- **Case C vs. Case G (the deliberate counterexample) extract to the
  identical structural shape** — both `manual_trigger: true`, single
  `OneTimeFee`, distinction only in prose. This is the concrete evidence
  behind `MILESTONE_DELIVERY_NE_ACCEPTANCE_CANDIDATE`.
- **Case D reused the existing `amount: 0` + `manual_trigger: true`
  "variable, unknown at contract time" convention** for the change-order
  fee — a genuinely good adaptation, not a failure, though it still can't
  distinguish a bilateral-signature gate from a unilateral one.
- **Case F extraction confidence was `medium`** (vs. `high` for A/B) —
  the model itself signaled lower confidence when a fixture combined a
  milestone fee with a conditional credit in the same clause family.
- One extraction-quality finding (Case F's due_date conflation) — see
  Gap A above.

Second live call: Case F's clause run through the **unmodified**
`buildServiceCreditProposalPrompt` (the real interpretation layer, same
Rulebook AI guidance already active from Step 7) — captured in
`rulebook-generalization.test.ts`'s fixture data. Result: `credit_basis`,
`credit_value`, `cap_pct`, and `quantity_treatment: 'complete_units'` all
captured correctly; `application_state`, `survival_state`, and
`cash_redeemable_state` all correctly left `decision_required` — the
model did **not** invent an application scope, survival treatment, or
cash-redeemability answer the clause never stated.

## 6. Global Rulebook results (item 7)

Fed Case F's real captured interpretation through `resolveVerdixRulebookShadow`/
`resolveVerdixRulebookActivation`, unmodified — see
`rulebook-generalization.test.ts`. **Two of the current nine rules
already fire correctly, with zero changes**:

- `credit.basis_ne_application_scope` — calculation basis
  (`milestone_3_fee`) is known; application scope correctly stays
  `remains_unresolved`.
- `credit.next_invoice_timing_ne_carry_forward` — `availability:
  'next_period'` does not establish `carry_forward`, which correctly
  stays `remains_unresolved`.

The other seven correctly do **not** fire (different shape: two are
structural invariants for minimum-commitment/tier pricing, unrelated to
credits; `credit.future_payable_scope_ne_indefinite_survival` and
`credit.application_scope_ne_cash_redeemability` both require a concrete
`eligible_component_keys` that this clause never states, so correctly
have nothing to evaluate; the two provenance invariants and the
explicit-carry-forward rule need data this proposal-stage context doesn't
carry). **Project billing does not need a separate Rulebook** — the
credit-shaped part of it (Case F) is already inside the existing one.

Step 8 decision tracing also generalizes unmodified:
`buildServiceCreditSurvivalCarryForwardTrace` produces a real,
well-formed, correctly-unresolved trace for Case F's `survival.carry_forward`
with zero code changes. For every other milestone concept (amount,
retention, change-order gating, acceptance type) — **trace unavailable,
because no normalized commercial field exists yet.** No generic
placeholder trace was fabricated to paper over this.

## 7. Candidate records (items 8, 9)

`lib/rulebook/rule-candidates.ts` gained five new records, all under
Step 9's real governance machinery (`validateVerdixRuleCandidate`,
`auditVerdixRulebook` — both pass with zero issues, see
`tests/commercial-semantics/milestone-billing/candidates.test.ts`):

| Candidate | Status | Why |
|---|---|---|
| `milestone.delivery_ne_acceptance` | **validated** | Real positive (Case C) + counterexample (Case G) evidence, both live baseline runs. The only principle with genuine adversarial evidence. |
| `milestone.retention_ne_discount` | observed | One clean (non-adversarial) observation; no normalized `retention` field to constrain a rule against yet. |
| `milestone.entitlement_ne_invoiceability` | observed | The clearest general finding in this whole exercise (§3 above), but no field exists. |
| `milestone.change_order_approval_ne_delivery_confirmation` | observed | One clean observation (Case D); no field distinguishes gate *types* yet. |
| `milestone.percentage_basis_ne_payment_timing` | observed | Real risk identified (Case B loses the % relationship entirely), but no field to validate a rule against. |

**None reaches `approved`. None is active. None was added to
`verdixCommercialRulebook`.** `milestone.delivery_ne_acceptance` is
deliberately stopped at `validated` — the evidence supports the
*principle*, but there is nothing for a Global Rulebook rule to
constrain yet (Rulebook rules read `CommercialSemanticContext` slices
built from real, persisted normalized fields — none exists for milestone
acceptance). Promoting it would mean shipping a rule with nothing real to
evaluate, which is exactly what Step 9 exists to prevent.

## 8. Counterexamples (item 10)

Only one candidate reached the evidence bar requiring one, and it has a
real, deliberately-constructed counterexample: Case G ("delivery shall
constitute acceptance... no separate acceptance review or sign-off is
required") against Case C's positive case, per item 10's own worked
example. Both are real live-model extraction runs, not fabricated
expectations.

## 9. Architecture fit (item 13)

- **`billing-writer.ts`** — the `manual_trigger`/`parked` mechanism
  already does real work for this family (Cases A, C, D, E all correctly
  route to parked, human-confirmed invoicing today). No change needed for
  what's *already* representable; a genuine new primitive (partial
  entitlement, acceptance-type) would need new branches here eventually,
  not now.
- **`tariff.ts` / credit-ledger (`lib/credit-ledger.ts`)** — Case F
  (delay penalty) is a strong composition win: `evaluateCreditEarn` +
  `quantity_treatment: 'complete_units'` + percentage basis + cap already
  do the calculation. **No `ProjectPenaltyEngine` needed** — confirms
  item 13's own hypothesis directly. The one open question is whether
  `enumerateCadenceWindows`/`findCadenceWindowContaining` (the real
  window-iteration functions `trigger_window` feeds) can actually express
  "recurring weekly since a fixed deadline" — not verified in this step
  (would require reading/exercising that code specifically, out of scope
  for an exploration step; flagged as the one concrete follow-up if delay
  penalties are prioritized next).
- **`commercial-rule-status.ts` (readiness)** — does not look at
  `one_time_fees` at all today. This is the single most consequential
  finding for a future step: any real milestone-billing capability needs
  `OneTimeFee` (or its eventual replacement/extension) brought into this
  file's readiness computation, or milestone fees will keep silently
  bypassing the review-before-billing discipline every other commercial
  field already has.
- **Final billing instruction model (`planned_invoices`)** — already
  supports a `'parked'` status distinct from `'scheduled'`; this is
  actually a reasonable foundation for "earned but not yet invoiceable"
  IF a partial-amount concept (retention) were added — it would need a
  new split (parked-partial vs. parked-full) rather than a wholly new
  status vocabulary.

**Prefer composition over parallel architecture — confirmed.** The one
concept that already touches a mature primitive (delay penalty → service
credit) needs no new engine at all. Every concept that doesn't yet have a
primitive (acceptance, retention, change order, milestone sequencing)
needs a genuinely new one — but that's a semantic-model gap, not an
execution-engine gap, and satisfying it is proposed as a **future step**,
not built here.

## 10. Operational evidence requirements (item 12)

| Concept | Evidence Verdix would eventually need | Where it would come from |
|---|---|---|
| Milestone acceptance | Acceptance timestamp + status (accepted/rejected) | Customer sign-off — not ingested anywhere today |
| Deemed acceptance | Delivery timestamp + rejection state + the contractual review-window length | Delivery event + absence-of-rejection signal — not ingested |
| Change order | Signed change-order identifier + effective date | External contract-management/e-signature system — not ingested |
| Retention release | Final-project-acceptance event | Same as milestone acceptance, project-level — not ingested |
| Delay penalty | Contractual deadline (already extractable) + actual completion/acceptance date | Actual date is external — not ingested |

**Today, Verdix ingests none of these.** The only existing "confirmation"
mechanism is `parked-invoices/route.ts` — an org-internal human manually
typing a quantity and clicking a button. That's sufficient for what
`OneTimeFee` already represents (an operator confirms delivery happened),
but it is not, and was never meant to be, a system of record for
customer acceptance, signed change orders, or project-level milestone
sign-off. Confirms item 12's own framing: Verdix should own the
*commercial intelligence* (what triggers billability, and under what
authority), while remaining dependent on an external event feed for the
operational facts themselves — building that ingestion is explicitly out
of scope here.

## 11. Required output matrix (item 15)

| Case | Commercial concepts | Existing model support | AI interpretation quality | Rulebook support | Missing primitive | Execution readiness | Candidate semantic rule? | Operational evidence needed |
|---|---|---|---|---|---|---|---|---|
| **A** Simple fixed milestone | amount, acceptance trigger, billable timing | Partial (`OneTimeFee` + `manual_trigger`) | High confidence, no over-inference, correctly gated | None applicable (not credit-shaped) | Acceptance-event type; milestone sequencing | Parked, human-confirmed only | No (folded into observation below) | Acceptance timestamp/status |
| **B** Advance + milestone % | upfront payment, % basis, sequencing | Partial — timing per-line preserved, % basis lost | High confidence; correct per-line trigger differentiation | None applicable | % of total basis field | Signature milestone auto-invoices; others parked | `milestone.percentage_basis_ne_payment_timing` (observed) | Acceptance timestamps for 2 of 3 milestones |
| **C** Deemed acceptance | acceptance event, deemed-acceptance mechanism, invoiceability | Not expressible structurally (prose only) | Medium confidence; correctly preserved as prose, no fabrication | None applicable | Deemed-acceptance window field | Parked; window not machine-actionable | `milestone.delivery_ne_acceptance` (**validated**) | Delivery timestamp + rejection state + window length |
| **D** Change order | base scope, additional obligation, written approval, separate trigger | Partial (`amount:0` + `manual_trigger` reuse) | Medium confidence; good reuse, gate-type conflated | None applicable | Bilateral-approval gate type | Parked; amount genuinely unknown until CO signed | `milestone.change_order_approval_ne_delivery_confirmation` (observed) | Signed CO id + effective date |
| **E** Retention | gross entitlement, billable portion, retained portion, release trigger | Not expressible (whole amount, prose split) | Medium confidence; correctly avoided miscategorizing as discount | None applicable | Partial-entitlement/retention field | Parked, all-or-nothing (no partial support) | `milestone.retention_ne_discount`, `milestone.entitlement_ne_invoiceability` (both observed) | Final project acceptance event |
| **F** Delay penalty | delay trigger, complete-week treatment, % basis, cap, affected scope | **Full, via existing `ServiceCredit`/`CreditEarnRule`** | Medium confidence; correct basis/cap/quantity_treatment; application/survival/cash correctly left unresolved | **2 of 9 rules fire correctly, unmodified** (`credit.basis_ne_application_scope`, `credit.next_invoice_timing_ne_carry_forward`) | `trigger_window` enum has no weekly-elapsed-time member (approximated as `per_incident`) | Credit-ledger-capable once entitlement/window verified | None new — reuses Step 7's cash-redeemability rule's *shape*, no new rule needed | Contractual deadline + actual completion date |

## 12. Recommendation for the smallest next production capability

**Bring `OneTimeFee` into the readiness/provenance architecture first,
before adding any new field.** Concretely, as a proposed *next* step (not
built here): add `FieldProvenance`-style gating to `OneTimeFee` (or a
narrow, purpose-built successor covering just the acceptance-trigger
shape) so a milestone fee can carry `contract_derived`/`reviewer_policy`
provenance for *why* it's billable, the same way every credit/discount
field already does — this alone would close the review/provenance gap
(Category D) for the majority of this fixture family without yet solving
retention, change orders, or percentage-basis. Delay-penalty-style
credits need no new production capability at all — they already work
through the existing credit primitive; the only follow-up there is
verifying `trigger_window`'s cadence-enumeration logic actually supports
a weekly-elapsed-time shape before relying on it for real billing.

## 13. Confirmations (item 17)

- **No new Global Rulebook rule was activated.** `verdixCommercialRulebook`
  is unchanged (still 9 rules); `VERDIX_RULEBOOK_VERSION` unchanged.
- **Organization Rulebook production allowlist is unchanged** —
  `PRODUCTION_ORGANIZATION_RULEBOOK_ALLOWLIST` still `['survival.carry_forward']`,
  untouched.
- **No production behavior changed.** `lib/contract-extractor.ts`,
  `lib/rule-interpretation.ts`, `lib/billing-writer.ts`, `lib/tariff.ts`,
  `lib/credit-ledger.ts`, `lib/commercial-rule-status.ts` — all
  byte-identical to before this step. The one genuine extraction-quality
  finding (Case F's due_date conflation, §2 Gap A) is reported, not fixed
  — it's a single baseline observation, not an already-approved semantic
  principle being violated (item 16's fix criterion).
- **Zero new production wiring** — `auditVerdixRulebook()` (no arguments)
  passes cleanly with the five new candidate records present; none has an
  `activeRuleId`.
