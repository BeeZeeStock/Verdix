// A minimum commitment is commercially ambiguous the moment it coexists with
// an included allowance on the same metric (does the minimum apply before or
// after the free units? is it a floor under usage charges, or an additional
// fixed charge on top?) — never inferred silently. requires_confirmation
// defaults to true whenever that ambiguity is detected at extraction time;
// the billing owner picks the interpretation in the review workflow, and
// only a confirmed commitment counts toward committed_contract_value.
export interface MinimumCommitment {
  /** floor: max(usage_charge, amount). additive: amount charged on top of usage regardless.
   *  minimum_spend: amount is a spend commitment usage consumes, shortfall billed at true-up.
   *  prepaid_commitment: amount is prepaid, usage draws down from it.
   *  minimum_quantity: a unit-quantity commitment (take-or-pay), not a currency floor. */
  mode: 'floor' | 'additive' | 'minimum_spend' | 'prepaid_commitment' | 'minimum_quantity'
  amount: number
  currency?: string | null
  /** Cadence this commitment is evaluated over. Defaults to the tier's own measurement_period when unset. */
  period?: 'monthly' | 'quarterly' | 'semi-annual' | 'annual' | null
  included_allowance_interaction?: 'before_allowance' | 'after_allowance' | 'unclear'
  rollover?: boolean
  prorate_partial_periods?: boolean | 'unclear'
  /** Whether a 'floor'/'minimum_spend' commitment is still owed for a period
   *  with zero calculated usage (no usage at all, or usage fully inside the
   *  included allowance) — a materially different question from whether the
   *  floor exists at all, and one contracts are frequently silent on.
   *  Missing/undefined (not yet extracted) reads the same as 'unclear'. */
  applies_at_zero_usage?: boolean | 'unclear'
  source_clause?: string | null
  requires_confirmation: boolean
  confirmation_reason?: string | null
}

// How a metric's tier table is actually evaluated once usage crosses a
// second band — this is the one piece of tiered-pricing semantics that
// changes the invoice total even when the rate table itself is identical.
// graduated/staircase: each band's rate applies only to the units within it.
// volume/all-units: the band containing total quantity sets the rate for
// ALL qualifying units. block: reaching a band charges a flat fee for that
// band (not a per-unit rate). custom: contract language doesn't map cleanly
// onto any of the above — requires_confirmation must be true.
// Same shape as DiscountInterpretation.tier_method — reused, not duplicated,
// because the ambiguity is identical whether the tier table sets prices,
// discounts, or overage rates.
export interface TierCalculationMethod {
  method: 'graduated' | 'volume' | 'block' | 'custom'
  source_clause?: string | null
  requires_confirmation: boolean
  confirmation_reason?: string | null
}

export interface OverageTier {
  tier_label: string
  from_unit: number | null
  to_unit: number | null
  rate_per_unit: number
  unit_type: string
  /** How often usage is accumulated and billed. May differ from the contract's main billing_frequency. */
  measurement_period?: 'monthly' | 'quarterly' | 'semi-annual' | 'annual' | null
  /** Minimum payment per measurement period regardless of actual usage (a consumption floor).
   *  @deprecated kept for backward compatibility with existing extracted/stored data — prefer
   *  minimum_commitment, which can represent modes other than a pure floor and carries its own
   *  confirmation state. New extractions populate both when a minimum is present. */
  minimum_period_amount?: number | null
  /** Structured minimum-commitment rule, when the contract states one for this metric. */
  minimum_commitment?: MinimumCommitment | null
  /** Whether measurement_period resets on the contract's own start-date anniversary (default,
   *  preserves existing behavior) or on true calendar boundaries (Jan/Apr/Jul/Oct for quarterly,
   *  Jan/Jul for semi-annual, Jan for annual) — only set to 'calendar' when the contract text
   *  explicitly says so (e.g. "calendar quarter"); never inferred. */
  reset_anchor?: 'contract_start' | 'calendar' | null
  /** How this metric's tier table is evaluated once usage spans more than one
   *  band. Null on pre-existing rows (extracted before this field existed) —
   *  the calculation engine treats null as 'graduated' for backward
   *  compatibility only; every new extraction populates this explicitly. */
  tier_calculation?: TierCalculationMethod | null
  /** Step 17A hardening item 5 — the distinct operational quantities this
   *  tier's surcharge genuinely depends on, mirroring
   *  AdditionalRecurringFee.required_operational_inputs' own convention
   *  (short, generic, extracted-not-invented labels). An excess/overage
   *  surcharge typically depends on the raw usage count AND the contracted
   *  volume that defines where the tier starts — both preserved rather
   *  than only the metric already implied by unit_type. */
  required_operational_inputs?: string[] | null
}

// A reviewer's resolved reading of an escalator whose actual rate can't be
// known at contract signing (CPI-linked, etc.) — mirrors MinimumCommitment's
// confirmation pattern: never fabricated, always explicit, always attributable.
//
// treatment is the field that actually decides what shows and what runs:
// 'applies' means the fields below describe a real, executable escalation;
// 'not_applied' means the reviewer explicitly decided to exclude the clause
// entirely (never inferred from empty fields — a reviewer who says "ignore
// this" produces a `treatment: 'not_applied'` interpretation, not a
// half-filled 'applies' one with placeholder-ish index/frequency values).
// Only 'applies' requires index/frequency/calculation_method to be real.
export interface EscalatorInterpretation {
  treatment: 'applies' | 'not_applied'
  /** Closed internal taxonomy used by the calculation engine — never shown
   *  to a user by itself. A named index other than a literal CPI clause
   *  (e.g. "HICP", "RPI") still classifies as 'other' here; see index_name
   *  for the actual source term, which must always be preserved verbatim. */
  index: 'CPI' | 'fixed_pct' | 'other' | null
  /** The index exactly as named in the contract (e.g. "HICP") — never
   *  normalized to "CPI" or any other generic label. Required (non-null)
   *  whenever index is 'CPI' or 'other'; null when index is 'fixed_pct'
   *  (nothing to name) or treatment is 'not_applied'. */
  index_name: string | null
  frequency: 'annual' | 'monthly' | 'quarterly' | null
  effective_date: string | null
  cap_pct: number | null
  /** Plain-English calculation formula, e.g. "CPI change + 2pp, capped at 6% per 12-month period" — never fabricated. Null when treatment is 'not_applied'. */
  calculation_method: string | null
  /** Whether this escalation is contractually automatic or requires an
   *  affirmative decision each time it could apply. 'requires_renewal_approval'
   *  is the correct reading of discretionary language like "may be increased"
   *  — the calculation engine must not compound the rate until this is
   *  'automatic'. 'not_exercised' means a discretionary clause exists but
   *  the reviewer has decided not to apply it for now — distinct from
   *  treatment:'not_applied' (the clause itself doesn't apply at all).
   *  Missing/undefined on rows written before this field existed reads as
   *  'automatic', preserving prior behavior for already-confirmed escalators. */
  discretion: 'automatic' | 'requires_renewal_approval' | 'not_exercised'
  /** True when the increase is a step applied once at each renewal event
   *  rather than an ordinary escalator recurring every 12 months during the
   *  original term — e.g. "on renewal, the fee may be increased by HICP".
   *  The calculation engine must not apply this as if it recurred mid-term. */
  renewal_triggered: boolean
  requires_confirmation: boolean
  confirmation_reason?: string | null
}

export interface PriceEscalator {
  escalator_pct: number | null
  escalator_type: 'fixed_pct' | 'CPI' | 'CPI_cap' | 'flat_amount'
  effective_date: string | null
  applies_from_year: number | null
  cap_pct: number | null
  description: string
  /** Reviewer-approved structured reading of this escalator's actual calculation, once resolved. */
  interpretation?: EscalatorInterpretation | null
}

// A tiered/volume discount schedule's own row — same shape whether the
// value is a percentage or a flat amount (see DiscountInterpretation.discount_basis).
export interface DiscountTierRow {
  from_unit: number | null
  to_unit: number | null
  value: number
}

// The two dimensions "before/after tiers" conflates: WHAT kind of discount
// this is, and HOW its tier structure is actually evaluated. A staircase
// (graduated) tier table and a volume (all-units) tier table can share the
// exact same rate schedule and still produce materially different invoice
// totals — tier_method is what tells them apart, and must never be assumed.
// The same ambiguity applies to tiered *pricing* — see OverageTier.tier_calculation,
// which uses this identical method vocabulary (TierCalculationMethod) so the
// two aren't interpreted by parallel, potentially-diverging models.
export interface DiscountInterpretation {
  discount_type: 'flat_percentage' | 'flat_amount' | 'tiered_discount' | 'volume_discount' | 'component_specific' | 'time_ramp' | 'custom'
  discount_basis: 'percentage' | 'amount'
  /** How a tiered/volume discount's bands are evaluated — meaningless (null) for a flat discount. */
  tier_method: 'graduated' | 'volume' | 'block' | 'custom' | null
  tiers: DiscountTierRow[] | null
  /** What the discount reduces, e.g. "usage charge", "base fee", or a specific named component. */
  applies_to: string | null
  /** Plain-English ordering relative to other pricing rules, e.g. "after usage pricing". */
  application_order: string | null
  reset_period: 'monthly' | 'quarterly' | 'semi-annual' | 'annual' | 'contract_term' | 'cumulative' | 'custom' | null
  /** A concrete numeric walkthrough at a sample quantity — lets a Finance reviewer validate the rule without decoding internal field names. */
  worked_example: string | null
  requires_confirmation: boolean
  confirmation_reason?: string | null
}

export interface Discount {
  /** Stable identifier so a contract with multiple discounts can address each
   *  one independently (review, interpretation, audit trail) instead of only
   *  ever operating on array position. Populated at extraction time; a
   *  pre-existing row that predates this field gets one backfilled on first
   *  write by confirm-rule rather than staying positionally-addressed forever. */
  discount_rule_id?: string
  discount_pct: number | null
  discount_amount: number | null
  discount_type: 'introductory' | 'volume' | 'negotiated' | 'other'
  start_date: string | null
  end_date: string | null
  duration_months: number | null
  /** Step 17A, item 10 — a stated duration in DAYS (e.g. "90-day pilot")
   *  that does NOT cleanly convert to a whole month count. Sibling field to
   *  duration_months, not a replacement for it — never both populated for
   *  the same clause; whichever unit the contract actually states is the
   *  one that gets set, the other stays null. Extraction must never invent
   *  a month-aligned start_date/end_date window for a day-stated duration
   *  it cannot cleanly translate (see lib/contract-extractor.ts's prompt
   *  guidance) — a genuinely day-bounded pilot/waiver belongs here, not
   *  forced into duration_months or a guessed end_date. */
  duration_days?: number | null
  applies_to: string
  description: string
  /** How start_date/end_date were derived. 'explicit_dates' (default when
   *  omitted, matches all pre-existing rows) means they're literal calendar
   *  boundaries the billing engine compares real dates against.
   *  'first_n_billing_periods' means the discount runs for
   *  billing_periods_count invoicing cycles from contract start regardless
   *  of calendar alignment — set only when the contract text ties the
   *  discount to invoice/period COUNT rather than a calendar window (e.g.
   *  "the first two quarterly invoices" on a contract starting mid-quarter);
   *  start_date/end_date are then a best-effort calendar approximation only,
   *  not authoritative — the billing engine must count periods instead of
   *  comparing dates for this anchor. */
  anchor?: 'explicit_dates' | 'first_n_billing_periods'
  billing_periods_count?: number | null
  /** Step 17A hardening (review pass 6), item 1 — TYPED commercial-
   *  component targeting, mirroring CreditApplicationRule.eligible_
   *  component_keys' own convention (free-form string keys, not a closed
   *  enum, so a new component never needs a schema change — e.g.
   *  'base_recurring_fee', 'performance_fee', 'usage_fee', 'overage_fee').
   *  This is the ONLY thing calculation code (see
   *  lib/committed-fixed-fee-resolver.ts) may consult to decide whether an
   *  unresolved discount is capable of changing a specific component's
   *  value — never the free-text applies_to above, which is extracted
   *  clause language for human display/audit only and must never drive a
   *  runtime materiality decision (a label merely containing a word like
   *  "platform" proves nothing structurally).
   *  affected_components — components this discount's stated rate/amount
   *  DEFINITELY affects, regardless of how any remaining scope ambiguity
   *  resolves (e.g. a 90-day 100%-waiver explicitly naming the fixed
   *  platform fee: affected_components: ['base_recurring_fee']). */
  affected_components?: string[] | null
  /** Components this discount MIGHT ALSO affect, pending a genuinely
   *  unresolved scope decision (e.g. a hybrid-fee waiver that's silent on
   *  whether it extends to a performance component too:
   *  possibly_affected_components: ['performance_fee']). Never conflated
   *  with affected_components — a component only ever belongs to one of
   *  the two lists for a given discount. Resolving the scope decision
   *  (via confirm-rule) moves an entry from here into affected_components
   *  or drops it; it never changes what's already in affected_components. */
  possibly_affected_components?: string[] | null
  /** Reviewer-approved structured reading of this discount's actual tier/application mechanics, once resolved. */
  interpretation?: DiscountInterpretation | null
}

// Generalizes beyond "availability credit" to any credit/rebate clause —
// SLA credits, promotional credits, earned/usage credits, general rebates —
// one vocabulary rather than a type per credit shape. trigger_type is the
// discriminator; credit_basis/basis_component describe what the credit is
// computed FROM, which is exactly what the rule-interaction detector reads
// to find overlaps with discounts/escalators touching the same component.
// Growth Credit's "3 consecutive calendar months" streak, the Rebate's
// Contract-Year threshold, and a flat SLA-style trigger are all the same
// shape: measure a metric against a threshold over some window, optionally
// requiring N consecutive windows before it's satisfied. window_anchor
// reuses lib/tariff.ts's CadenceAnchorMode vocabulary exactly (not a
// separate concept) so Contract-Year windowing is the same code path as
// metric minimum-commitment cadence, not a reimplementation.
export interface CreditEarnRule {
  trigger_metric_key: string | null
  trigger_quantity: number | null
  /** Full comparison vocabulary — added 'lt'/'lte'/'eq' (Step 1.5) so a
   *  "below threshold" clause (e.g. "availability < 99.5%") can be
   *  represented natively, exactly as the source states it, rather than
   *  requiring the caller to transform the metric into its logical
   *  complement (e.g. "unavailability >= 0.5%") to fit a gt/gte-only
   *  vocabulary. Comparators are never inferred from the metric name —
   *  they come from the normalized rule (evaluateCreditEarn, lib/credit-
   *  ledger.ts, just evaluates whichever one is on the record). */
  trigger_comparator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq'
  trigger_window: 'calendar_month' | 'billing_period' | 'contract_year' | 'per_incident'
  /** >1 for "each of N consecutive windows" triggers (Growth Credit: 3); 1 for a single-window trigger. */
  consecutive_windows_required: number
  window_anchor: 'contract_start' | 'calendar'
  /** "Finalize no later than N days after the window closes" — a deadline,
   *  not a mandatory wait. Only the Annual Rebate states one (45); null for
   *  credits that finalize the moment their window closes. Modeled this way
   *  (not "wait exactly N days") so a future contract's different phrasing
   *  ("within 30 days", "on the next invoice") fits the same field without
   *  renaming it — only day-count deadlines are implemented now, since
   *  that's all any current contract needs. */
  finalization_deadline_days: number | null
  /** How a fractional measured quantity is treated before it's compared
   *  against trigger_quantity and used to compute a per-unit credit value
   *  (Step 1.5) — generic across whatever the contract's qualifying unit
   *  actually is (hours, days, incidents, ...), never hardcoded to "hours".
   *  'exact' (the default when omitted, preserving every pre-existing
   *  rule's behavior byte-for-byte) uses the measured quantity as
   *  provided. 'complete_units' floors a positive measured quantity down
   *  to the nearest whole unit — "SEK 5,500 per COMPLETE hour" means 2.99
   *  measured hours counts as 2, never 2.99 or 3. Optional so legacy
   *  records with no opinion on this default safely rather than being
   *  silently floored. */
  quantity_treatment?: 'exact' | 'complete_units'
  /** Answers a genuinely different question than finalization_deadline_days:
   *  that field is the source's CALCULATION-TIMING obligation ("calculate
   *  within N days") — this field is WHICH paid amounts belong in the
   *  basis once that deadline arrives. Only meaningful for a credit whose
   *  basis is actually computed from an "actually paid" monetary component
   *  (see lib/paid-basis-finalization.ts's isPaidBasisFinalizationApplicable
   *  — the exact condition under which lib/credit-ledger-service.ts calls
   *  sumPaidComponentAmountForWindow); null/absent for every other credit.
   *  'deadline_cutoff' — only fees paid by the calculation deadline count;
   *  freezes once, there. 'full_attribution' — all Contract-Year-
   *  attributable fees count even if paid later; Verdix cannot yet
   *  determine when that basis is complete (no invoice-terminality model —
   *  see lib/commercial-rule-status.ts's capability-blocker handling), so
   *  this is a PRESERVED reviewer decision that never silently executes as
   *  "wait forever." null — genuinely unresolved; the source contract is
   *  silent on this and no reviewer has decided. Never inferred from the
   *  mere presence of a calculation-deadline clause — see
   *  paid_basis_finalization_provenance. Optional (not required, unlike
   *  finalization_deadline_days itself) so every pre-existing fixture/
   *  record that predates this field keeps compiling and behaves exactly
   *  as "genuinely unresolved" — the correct, safe default — without
   *  needing to be touched. */
  paid_basis_finalization_policy?: 'deadline_cutoff' | 'full_attribution' | null
  /** Provenance for paid_basis_finalization_policy specifically — same
   *  FieldProvenance discipline as CreditApplicationRule's eligibility_
   *  provenance/survival_provenance (lib/credit-application-rule.ts). The
   *  source clause stating a calculation deadline ("within 30 days") is
   *  NEVER, by itself, enough to mark this 'contract_derived' — it answers
   *  a different question (see this field's own sibling comment above).
   *  Only a human's explicit choice through the review UI (Paid-basis
   *  finalization decision) may mint 'reviewer_policy' here; a future
   *  contract that actually states a late-payment treatment could
   *  legitimately be 'contract_derived', but no current extraction path
   *  ever produces that. */
  paid_basis_finalization_provenance?: FieldProvenance | null
  requires_confirmation: boolean
  confirmation_reason?: string | null
}

/** Four-way provenance, never conflated: a value can exist (a model can
 *  always produce SOME boolean/array) without being resolved. Only
 *  'contract_derived' (the source text states or unambiguously implies it),
 *  'reviewer_policy' (a human explicitly confirmed or chose it for THIS
 *  agreement), or — Step 5C — 'organization_rulebook' (an active,
 *  applicable private Organization Rulebook policy filled a field the
 *  contract and reviewer left genuinely silent on) make a field executable.
 *  'verdix_recommends' means exactly what it says — a model's confidence,
 *  however strongly reasoned, is not the same thing as the agreement or a
 *  reviewer having decided it. See isProvenanceResolved() in
 *  lib/commercial-rule-status.ts, the single place this distinction is
 *  enforced.
 *
 *  authority vs. interpretation METHOD are deliberately kept separate here
 *  too (see lib/rulebook/resolution.ts's ResolutionAuthority/ResolutionMethod
 *  split) — 'organization_rulebook' records WHY a value counts (an
 *  organization's own confirmed default applied), never HOW a contract
 *  clause was read; it is never assigned to a value the contract or a
 *  reviewer already spoke to. Never assigned to a value that came from
 *  Verdix's OWN global Rulebook defaults — that authority tier
 *  ('verdix_rulebook') has no production provenance value at all yet; only
 *  Organization Rulebook resolution is activated in production as of
 *  Step 5C, and only for the fields in
 *  lib/rulebook/organization-rulebook-production.ts's
 *  PRODUCTION_ORGANIZATION_RULEBOOK_ALLOWLIST. */
export type FieldProvenance = 'contract_derived' | 'verdix_recommends' | 'reviewer_policy' | 'organization_rulebook'

export interface CreditApplicationRule {
  /** For %-based credit_basis: which components the percentage is computed
   *  FROM (e.g. the Rebate's 5% of transaction-processing fees). Null when
   *  credit_basis isn't %-based. */
  computed_from_component_keys: string[] | null
  /** What this credit may reduce. 'all' = the full remaining payable pool
   *  (Service Credit's "future amounts payable"); string[] = these specific
   *  components only (Growth Credit's transaction-processing-only scope);
   *  null = the contract doesn't say what it may offset (the Rebate's case —
   *  it states the rebate's *size* but not its application scope), so this
   *  cannot be applied until a reviewer resolves it. Never assumed/defaulted
   *  by the engine — always exactly what was extracted/confirmed. */
  eligible_component_keys: string[] | 'all' | null
  /** Provenance for eligible_component_keys specifically — see
   *  FieldProvenance. A concrete value here does NOT by itself mean this
   *  field is resolved; only 'contract_derived'/'reviewer_policy' does.
   *  Null/undefined when there's genuinely nothing to grade yet (no
   *  proposal has run) — distinct from a graded-but-unresolved state. */
  eligibility_provenance?: FieldProvenance | null
  excluded_component_keys: string[]
  one_time: boolean | 'unclear'
  /** boolean when the contract states a position (Growth Credit: true,
   *  explicit "carries forward until consumed"); 'unclear' when it doesn't
   *  (Service Credit and the Rebate — "applied against future amounts
   *  payable" establishes *not-same-period*, not *indefinite* survival).
   *  Never defaulted to true just because a credit isn't same-period-
   *  applicable — those are different questions. */
  carry_forward: boolean | 'unclear'
  /** Provenance for one_time + carry_forward together (they're graded as
   *  one "survival" question upstream) — see eligibility_provenance's
   *  identical discipline, and FieldProvenance. */
  survival_provenance?: FieldProvenance | null
  /** Audit metadata (Step 5C) — populated ONLY when survival_provenance is
   *  'organization_rulebook', so a resolved carry_forward value can always
   *  be traced back to exactly which organization policy produced it, and
   *  which VERSION of that policy (a superseded/edited rule keeps its old
   *  id/version on every credit it already resolved — see lib/rulebook/
   *  organization-rules.ts's versioning model). Never set for any other
   *  survival_provenance value. Read-only audit trail — never consulted by
   *  the calculation engine, never mutates the organization rule itself. */
  survival_organization_rule_id?: string | null
  survival_organization_rule_version?: number | null
  /** Only set when the contract states a specific bounded survival window
   *  (e.g. "expires after 2 quarters if unused") — the real middle ground
   *  between carry_forward: true (forever) and 'unclear' (blocked). Mutually
   *  exclusive with expiry_date in practice (a reviewer picks one bound or
   *  the other), never both. */
  expiry_periods?: number | null
  /** Alternative, date-bounded survival window (e.g. "expires 2027-12-31")
   *  — a reviewer-policy choice, never AI-derived (no current contract
   *  states an absolute expiry date; this exists for the reviewer's own
   *  "expire on a specified date" option). ISO date string, or null. */
  expiry_date?: string | null
  /** Only value implemented — every current credit type needs "available
   *  starting the period after it's earned", never the same period. */
  availability: 'next_period'
  /** Derived from provenance, NOT from whether a value is present — see
   *  isProvenanceResolved(). A concrete eligible_component_keys/carry_forward
   *  value with 'verdix_recommends' provenance still leaves this true; only
   *  'contract_derived' or 'reviewer_policy' provenance on BOTH
   *  eligibility_provenance and survival_provenance clears it. A credit can
   *  still be *earned* and tracked while this is true — it just can't be
   *  *applied* until a reviewer resolves the remaining ambiguity via
   *  confirm-rule. */
  requires_confirmation: boolean
  confirmation_reason?: string | null
}

export interface ServiceCreditInterpretation {
  trigger_type: 'sla_breach' | 'usage_threshold' | 'promotional' | 'earned_milestone' | 'other'
  /** Plain-English condition, e.g. "uptime < 99.9% in a calendar month" — never fabricated. */
  trigger_description: string | null
  credit_basis: 'pct_of_period_fee' | 'pct_of_affected_component' | 'fixed_amount_per_unit' | 'flat_amount' | 'usage_units'
  /** What the percentage/amount is computed from, e.g. "subscription_fee",
   *  "invoice_total", "usage_charge", or a specific named component — free
   *  text, mirrors DiscountInterpretation.applies_to's convention rather
   *  than inventing a second closed enum for the same concept. */
  basis_component: string | null
  /** 2026-08-30 correction — answers a genuinely different question than
   *  basis_component/computed_from_component_keys: WHICH component the %
   *  is computed from is a separate concern from WHAT MONETARY STATE that
   *  component must be in. 'paid' = the source states or implies the basis
   *  is amounts actually paid (Contract B's "actually paid" — see
   *  lib/paid-basis-finalization.ts, which this field is the sole trusted
   *  input to). 'component_amount' = the basis is the stated/invoiced
   *  amount for the component, independent of payment status — currently
   *  has no verified execution path (see computeCommercialRuleWorkload's
   *  capability-blocker handling), so it is never silently treated as
   *  'paid'. 'unclear'/null = genuinely not established. Never inferred
   *  from credit_basis being percentage-typed, or from the earning
   *  engine's own implementation detail (lib/credit-ledger-service.ts's
   *  sumPaidComponentAmountForWindow querying status='paid') — an
   *  execution detail is not evidence of contract semantics. */
  monetary_basis_recognition?: 'paid' | 'component_amount' | 'unclear' | null
  /** Provenance for monetary_basis_recognition specifically — same
   *  FieldProvenance discipline as every other *_provenance field in this
   *  codebase. Confirm-rule never accepts a caller-asserted value for this
   *  field (no reviewer decision resolves it today) — it can only ever be
   *  'contract_derived' (set by extraction reading the source, or by a
   *  one-time backfill for a pre-existing record whose source is already
   *  known — e.g. Contract B) or preserved from what was already there. */
  monetary_basis_recognition_provenance?: FieldProvenance | null
  credit_value: number | null
  currency: string | null
  /** Maximum credit per settlement_period, null = uncapped. */
  cap_amount: number | null
  /** Alternative cap expressed as a % of the basis, null = uncapped. */
  cap_pct: number | null
  settlement_period: 'monthly' | 'quarterly' | 'semi-annual' | 'annual' | 'per_incident' | null
  /** false = explicitly not cash-redeemable (credit against future invoices
   *  only); true = explicitly may be paid/refunded in cash; 'unclear' = the
   *  source is genuinely silent (Step 1.5 fix — previously this was a plain
   *  boolean that silently defaulted to false on ANY silence, collapsing
   *  "explicitly not redeemable" and "never addressed" into the identical
   *  value with no way to tell them apart downstream; see
   *  cash_redeemable_provenance and lib/commercial-rule-status.ts's
   *  isServiceCreditUnresolved, which now gates readiness on it). A
   *  concrete true/false here does NOT by itself mean this field is
   *  resolved — only cash_redeemable_provenance does.
   *  Step 16A amendment, known scope gap (documented, not fixed here per
   *  explicit instruction not to redesign this type in this amendment):
   *  this is a single flat field with no before/after-termination (or any
   *  other temporal/circumstantial) dimension. A contract can state
   *  redeemability is clear during the active term while leaving
   *  redeemability specifically after termination unresolved (OS-2026-09's
   *  Annual Rebate: "...whether it is redeemable for cash after
   *  termination") — this field cannot distinguish that narrower
   *  uncertainty from "redeemability is unresolved in general." Grading
   *  this 'unclear'/decision_required for such a clause is conservative
   *  and safe (it never wrongly resolves a genuinely open question), but
   *  is broader than the actual contractual uncertainty. A future change
   *  that needs to express post-termination cash treatment as a distinct
   *  question from ordinary-term cash treatment should add a new field
   *  (e.g. alongside CreditApplicationRule's survival concept), not
   *  overload this one. */
  cash_redeemable: boolean | 'unclear'
  /** Provenance for cash_redeemable specifically — same FieldProvenance
   *  discipline as CreditApplicationRule's eligibility_provenance/
   *  survival_provenance (lib/credit-application-rule.ts), reused rather
   *  than a bespoke cash-only mechanism. Absent/null means never graded —
   *  including every record persisted before this field existed, which is
   *  deliberately treated as unresolved (consistent with how a missing
   *  application_rule is already treated) rather than assumed safe. */
  cash_redeemable_provenance?: FieldProvenance | null
  /** Resolution note written by the rule-interaction reviewer when this
   *  credit's basis was found to overlap another rule (e.g. an active
   *  discount) — lets the calculation engine and any standalone display of
   *  this credit reflect the resolved basis without joining the separate
   *  interaction audit row. Null until an interaction is detected and resolved. */
  interaction_note?: string | null
  source_clause: string | null
  requires_confirmation: boolean
  confirmation_reason?: string | null
  /** When/how this credit is earned and how it may be applied, once
   *  resolved — same "absent means not yet interpreted" discipline as every
   *  other field on this interpretation. */
  earn_rule?: CreditEarnRule | null
  application_rule?: CreditApplicationRule | null
}

export interface ServiceCredit {
  /** Stable identifier, same pattern as Discount.discount_rule_id — a
   *  contract can have several independent credit clauses addressed
   *  independently in review/audit. Populated at extraction time, and
   *  preserved across re-extraction (see lib/rule-id-stability.ts) rather
   *  than reassigned. */
  credit_rule_id?: string
  /** 'sla' was renamed to 'service_credit' (a 2026-08-20 migration rewrites
   *  existing rows) — 'conditional_credit' added for milestone/multi-period
   *  threshold credits (e.g. Growth Credit) that don't fit either a flat
   *  service credit or a period-based rebate. Distinct types get distinct
   *  review-UI labels rather than one flat "Service credit basis" for all. */
  credit_type: 'service_credit' | 'rebate' | 'conditional_credit' | 'promotional' | 'earned' | 'usage' | 'waiver' | 'other'
  description: string
  source_clause: string | null
  /** Raw extracted numbers before interpretation resolves basis/cap/timing
   *  ambiguity — same "extracted fact vs resolved interpretation" split as
   *  Discount.discount_pct/interpretation. */
  stated_pct: number | null
  stated_amount: number | null
  /** Reviewer-approved structured reading, once resolved — absent means
   *  "extracted but not yet interpreted", never inferred. */
  interpretation?: ServiceCreditInterpretation | null
}

// Job-level: which credit gets first claim on a shared, overlapping pool of
// eligible charges when more than one credit could draw from the same
// component. Array order in ContractTerms.service_credits is NOT this policy
// — it's incidental extraction order, not a business rule, and defaulting to
// it would silently make a real financial decision.
export interface CreditApplicationPriority {
  order: string[]   // credit_rule_id[], meaningful entry order
  /** 'contract_stated' only when the contract text itself specifies an
   *  order; 'verdix_recommends_constrained_first' when Verdix suggests
   *  ordering the more narrowly-scoped credit first (nowhere else it could
   *  draw from) but a reviewer still had to confirm it; 'reviewer_policy'
   *  for a fully open reviewer decision. The middle case is still
   *  reviewer_policy once confirmed — "Verdix recommended it" isn't the same
   *  as "the contract said so". */
  policy_source: 'contract_stated' | 'verdix_recommends_constrained_first' | 'reviewer_policy'
  requires_confirmation: boolean
  confirmation_reason?: string | null
  source_clause?: string | null
}

// Step 12 — the closed, initial set of contractual events Verdix can
// normalize a OneTimeFee's billability trigger to. Deliberately small and
// closed (item 2: "do not add a generic free-text executable event") —
// justified only by the concrete Step 10/11 fixtures, not by anticipated
// future contract shapes:
//   'contract_signature'     — "upon signing" / "upon execution of this
//                               Agreement". NEVER collapsed into the
//                               contract's effective/start date, even when
//                               they are likely the same calendar day (see
//                               BillabilityCondition's own comment — this is
//                               the exact Step 11C nondeterminism this type
//                               exists to close).
//   'delivery'                — "upon delivery" / "upon completion of the
//                               Services", distinct from acceptance.
//   'customer_acceptance'    — "upon Customer's acceptance" / "upon written
//                               acceptance of the deliverables".
//   'final_acceptance'       — ONLY when the contract itself distinguishes
//                               an earlier/interim acceptance from a
//                               separate, later FINAL acceptance milestone.
//   'change_order_signature' — "upon execution of a signed Change Order".
// An event that doesn't fit one of these five is never forced into the
// closest-sounding category — see BillabilityCondition's own comment.
export type BillabilityEventType =
  | 'contract_signature'
  | 'delivery'
  | 'customer_acceptance'
  | 'final_acceptance'
  | 'change_order_signature'

// Step 12 — the normalized answer to "what does the agreement say must
// happen before this fee becomes billable?" A small, closed discriminated
// union — deliberately NOT a free-text field, NOT a date derived by
// guessing, and NOT the same thing as `manual_trigger`/`due_date` (which
// remain execution-representation fields, projected FROM this condition —
// see lib/billability-condition.ts's projectBillabilityConditionToExecutionFields
// — never the canonical contractual meaning themselves; item 3).
//
//   'immediate'  — the contract states the fee is due/payable immediately,
//                  with NO further condition. Only ever set when the source
//                  text actually says so (item 10) — "no date was
//                  extracted" is NOT evidence of 'immediate'; that silence
//                  stays represented as a null/undefined condition (see
//                  OneTimeFee.billability_condition's own comment). The old
//                  "due_date: null -> bill now" behavior must never leak
//                  back into this layer.
//   'fixed_date' — the contract states (or a reviewer confirms) a specific
//                  calendar date. Distinct from 'immediate' even when the
//                  date happens to be the contract's own start date — see
//                  the counterexample regressions in lib/billability-
//                  condition.test.ts.
//   'event'      — billability depends on a real-world contractual EVENT
//                  from the closed BillabilityEventType set, not a
//                  calendar date. A resolved 'event' condition (billability_
//                  provenance is contract_derived/reviewer_policy) means
//                  Verdix understands WHAT the trigger is — it does NOT
//                  mean the trigger has occurred. Whether it has occurred
//                  is a separate, execution-layer question — see
//                  lib/billability-condition.ts's getBillabilityExecutionCapability
//                  and lib/commercial-rule-status.ts's
//                  RequiredOperationalEventMissingBlocker.
export type BillabilityCondition =
  | { kind: 'immediate' }
  | { kind: 'fixed_date'; date: string }
  | { kind: 'event'; event_type: BillabilityEventType }

export interface OneTimeFee {
  fee_label: string
  amount: number
  due_date: string | null
  description: string | null
  /** Literal (or lightly paraphrased) source text for THIS fee's own
   *  clause, mirroring ServiceCredit/Discount's own source_clause field.
   *  Populated by extraction. The ONLY thing this field is read for today
   *  is deterministic amount-provenance grounding
   *  (lib/one-time-fee-provenance.ts's deriveOneTimeFeeAmountProvenance) —
   *  never used as display copy or for any other purpose in this pass. */
  source_clause?: string | null
  /** True when the fee requires manual delivery confirmation before invoicing (e.g. professional services charged per hour) */
  manual_trigger?: boolean
  /** Unit of the delivery metric, e.g. "hours", "days", "sessions" */
  metric_name?: string | null
  /** Rate per metric unit — used to calculate the invoice amount at trigger time */
  rate_per_unit?: number | null
  /** Step 11 — provenance for `amount`, the one execution-relevant fact this
   *  shape can actually resolve today. Reuses the canonical FieldProvenance
   *  discipline (see lib/commercial-rule-status.ts's isProvenanceResolved)
   *  rather than a bespoke notion of confidence/approval.
   *
   *  THREE distinct states, same discriminator as billability_provenance
   *  below: `undefined` means never graded at all — every record persisted
   *  before this field existed — and is NOT, by itself, treated as
   *  unresolved/blocking (only requires_confirmation being explicitly true
   *  blocks readiness; see that field's own comment). `null` means
   *  genuinely evaluated and unresolved — extraction could not
   *  deterministically ground this amount in the fee's own source_clause
   *  (lib/one-time-fee-provenance.ts's deriveOneTimeFeeAmountProvenance:
   *  no explicit in-currency amount stated, or a stated amount that
   *  disagrees with the extracted value — a range or correction, never
   *  guessed). A real FieldProvenance value means resolved: 'contract_
   *  derived' when that same deterministic grounding succeeded (the
   *  contract explicitly states this exact amount, unambiguously, in this
   *  fee's own clause), 'reviewer_policy' once a human explicitly confirms
   *  or supplies it via lib/one-time-fee.ts's buildOneTimeFeeConfirmation.
   *  Confirming an already contract_derived amount never downgrades it —
   *  see that function's confirmedProvenance. 'organization_rulebook' is
   *  never valid here — PRODUCTION_ORGANIZATION_RULEBOOK_ALLOWLIST has no
   *  one_time_fee entry (Step 11 does not add one). */
  amount_provenance?: FieldProvenance | null
  /** Step 11 — an explicit, narrow safety net (lib/contract-extractor.ts's
   *  flagAmbiguousOneTimeFees), set true only for the one real risk found by
   *  auditing this type's actual production lifecycle: a fee that would
   *  auto-invoice with zero further human review (manual_trigger falsy,
   *  amount > 0, due_date null — genuinely ambiguous whether "now" is the
   *  right billing moment, unlike a fee with either a clear due_date or
   *  manual_trigger: true, both of which already have a real, correct
   *  billing timing today). Absent/false for every historical record and
   *  for every fee outside that one ambiguous shape — never a blanket
   *  "every one-time fee needs review" gate (lib/commercial-rule-status.ts's
   *  isOneTimeFeeUnresolved is field-requiredness-aware, not presence-aware). */
  requires_confirmation?: boolean
  confirmation_reason?: string | null
  /** Step 11 — distinguishes ordinary, reviewer-resolvable ambiguity from a
   *  genuine Verdix modeling-capability gap. 'needs_review' (the default
   *  when requires_confirmation is true) means a reviewer CAN resolve this
   *  by confirming/correcting the amount — see lib/one-time-fee.ts's
   *  buildOneTimeFeeConfirmation. 'unsupported_semantics' means the SOURCE
   *  describes a billability condition this shape cannot represent at all
   *  (e.g. "billable upon customer acceptance") — no reviewer confirmation
   *  can fix that, since there is nothing to confirm; it becomes an
   *  execution-capability blocker instead (lib/commercial-rule-status.ts's
   *  UnsupportedCommercialSemanticsBlocker), never a fabricated
   *  reviewer_policy/contract_derived value. Nothing in production sets this
   *  yet — no extraction/interpretation call site can currently DETECT this
   *  distinction; see lib/rulebook/MILESTONE_BILLING_FINDINGS.md. Present
   *  here, and handled correctly by readiness, so a future step can start
   *  setting it without another type/readiness change. */
  unresolved_kind?: 'needs_review' | 'unsupported_semantics'
  /** Step 11 amendment — provenance for the SINGLE semantic decision the
   *  existing `manual_trigger` + `due_date` pair together express: what
   *  authority establishes the current executable timing/gating treatment.
   *  One field, not two (per manual_trigger/due_date), because nothing in
   *  the current implementation gives them independent authorities — they
   *  are two facets of one decision ("when/how does this become billable"),
   *  not two separate contractual questions.
   *
   *  Deliberately INDEPENDENT of amount_provenance (item 2) — a fee can be
   *  fully resolved on amount (contract_derived) while its billability
   *  stays unresolved, and vice versa; nothing here or in
   *  isOneTimeFeeUnresolved ever lets confirming one resolve the other.
   *
   *  Never auto-derived from a field simply being present — a concrete
   *  due_date, or manual_trigger: true "safely holding" execution, is NOT
   *  evidence of resolved billability semantics on its own (items 3, 6):
   *  the same "concrete value + missing provenance != source-derived"
   *  doctrine used everywhere else in this codebase. Only ever
   *  'contract_derived' when the extraction/interpretation path genuinely
   *  has source evidence for that specific conclusion (item 4), or
   *  'reviewer_policy' once a human explicitly confirms it via
   *  lib/one-time-fee.ts's buildOneTimeFeeConfirmation. Never
   *  'organization_rulebook' — same reasoning as amount_provenance above.
   *
   *  THREE distinct states, not two — this is the backward-compatibility
   *  discriminator lib/commercial-rule-status.ts's isOneTimeFeeUnresolved
   *  relies on (item 8): `undefined` means this record predates the
   *  billability-provenance model entirely (every historical record, and
   *  every record only ever touched by original Step 11's amount-only
   *  safety net) — never retroactively treated as unresolved. `null` means
   *  a fee HAS been evaluated under this model and is genuinely,
   *  explicitly unresolved — a real blocker (unless manual_trigger is
   *  true — see isOneTimeFeeUnresolved's own comment for why that shape is
   *  "safely held" rather than blocking). A real FieldProvenance value
   *  means resolved. */
  billability_provenance?: FieldProvenance | null
  /** Step 12 — the normalized contractual billability trigger (see
   *  BillabilityCondition's own comment for the full domain-model
   *  rationale). `billability_provenance` (above) continues to be the ONE
   *  provenance field for this decision — Step 12 does NOT add a second,
   *  competing provenance inside the union (item 4): `billability_
   *  condition = { kind: 'event', event_type: 'customer_acceptance' }` +
   *  `billability_provenance = 'reviewer_policy'` means "a reviewer
   *  confirmed that customer acceptance is the contractual billability
   *  condition" — it does NOT mean customer acceptance has occurred (item
   *  5). Whether it has occurred is answered separately, at execution time,
   *  by lib/commercial-rule-status.ts's RequiredOperationalEventMissingBlocker
   *  — never by this field or its provenance.
   *
   *  THREE-state discriminator, same shape as every other Step 11/12 field
   *  on this type (item 19): `undefined` means this record predates Step
   *  12 entirely (every historical record, and every record only ever
   *  touched by Step 11's manual_trigger/due_date-only lifecycle) — NEVER
   *  retroactively evaluated; `lib/commercial-rule-status.ts`'s
   *  isOneTimeFeeUnresolved falls back to the exact pre-Step-12
   *  manual_trigger-gated check for these. `null` means Step 12 extraction
   *  ran and could not determine a condition — genuine contractual silence,
   *  which must NEVER be interpreted as `{ kind: 'immediate' }` (item 10) —
   *  it behaves like the old due_date-null "needs review" case. A concrete
   *  BillabilityCondition value means Step 12 extraction (or a reviewer)
   *  identified a specific condition; its resolution status is still
   *  governed entirely by billability_provenance, exactly as before.
   *
   *  `due_date`/`manual_trigger` are execution-representation fields
   *  deterministically PROJECTED from this condition wherever it is known
   *  (lib/billability-condition.ts's projectBillabilityConditionToExecutionFields)
   *  — never independently set once billability_condition is populated, so
   *  the two can never silently disagree (item 15). They remain the sole
   *  source of truth only for legacy records where billability_condition is
   *  still undefined. */
  billability_condition?: BillabilityCondition | null
  /** Step 13 — stable, immutable subject identity for this fee, assigned
   *  once (lib/contract-extractor.ts's normalizeBillabilityCondition) the
   *  moment a fee enters the Step-12 lifecycle (billability_condition is
   *  populated, not left undefined). Exists ONLY so operational_event_
   *  evidence rows (supabase/migrations/20260824000001_operational_event_
   *  evidence.sql) have something safer than fee_label to key off —
   *  fee_label is a display string, extraction-order-dependent and
   *  documented as collision-prone (lib/rulebook/MILESTONE_BILLING_
   *  FINDINGS.md); it remains this codebase's addressing key for
   *  everything else (confirm-rule, billing-writer) — Step 13 does not
   *  change that, it only avoids compounding the risk for the ONE new
   *  registry it introduces. Absent for every fee that never entered the
   *  Step-12 lifecycle (manual_trigger-exempt fees, historical records) —
   *  those have no operational-event concept to key evidence against
   *  anyway. Known, documented limitation carried over unfixed from Step
   *  11/12: this id is NOT preserved across a real re-extraction (one_
   *  time_fees has no id-preservation mechanism at all, unlike discount_
   *  rule_id/credit_rule_id) — re-extracting a job assigns fresh fee_ids,
   *  orphaning any prior evidence rows (they remain in the database,
   *  intact and auditable, just no longer reachable from the new fee
   *  object). Fixing that is a separate, pre-existing gap outside Step
   *  13's scope. */
  fee_id?: string
}

// Same structural gap as MinimumCommitment.prorate_partial_periods, now
// generalized: any fee whose cadence resets on fixed calendar boundaries can
// produce a partial first/last period once the contract starts mid-cycle,
// and whether that partial period bills in full or prorated is very rarely
// stated for a flat recurring fee the way it might be for a metric minimum.
// Never inferred — 'unclear' stays 'unclear' through confirmation.
export interface PeriodProrationRule {
  reset_anchor: 'contract_start' | 'calendar' | null
  prorate_partial_periods: boolean | 'unclear'
  requires_confirmation: boolean
  confirmation_reason?: string | null
  source_clause?: string | null
}

export interface AdditionalRecurringFee {
  fee_label: string
  // Amount per billing period — 0 (falsy) when this fee has NO fixed
  // periodic amount at all: either it is priced per unit of operational
  // usage (metric_name/rate_per_unit populated instead — item 7) or it is
  // a commercial mechanism this shape cannot execute yet (unresolved_kind
  // === 'unsupported_semantics' — item 12). buildLineItems' own existing
  // `if (!fee.amount) continue` guard is what keeps a falsy amount from
  // ever contributing a fixed quantity/committed amount — never a
  // secondary check duplicated here.
  amount: number
  description: string | null
  /** Billing cadence for this fee when it differs from the contract's main billing_frequency. */
  billing_frequency?: 'monthly' | 'quarterly' | 'semi-annual' | 'annual' | null
  proration?: PeriodProrationRule | null
  /** Step 17A, item 7 — mirrors OneTimeFee's own metric_name/rate_per_unit
   *  convention exactly. Set when the source states a per-unit/per-event
   *  rate (e.g. "€0.38 per issued payment request") rather than a fixed
   *  periodic amount — `amount` MUST be 0 whenever these are set; the
   *  operational quantity this rate multiplies is unknown until real
   *  usage data exists, never the contract's own term/cycle count. */
  metric_name?: string | null
  rate_per_unit?: number | null
  /** Step 17A, item 11 (refined by hardening item 5) — the distinct
   *  operational quantities/measurements THIS fee's own rate directly
   *  depends on, when that's more than a single metric_name/rate_per_unit
   *  pair can express. Must be the EXACT dependency set for this specific
   *  fee, never a blanket list shared across every fee on the contract
   *  (e.g. the €0.38 request fee depends only on
   *  issued_payment_request_count — never also on completed_payment_count,
   *  which belongs to the separate €1.70 success fee). When a fee's rate
   *  is itself a DERIVED metric computed from other raw inputs via a
   *  stated formula (see derived_metric below), this field lists only the
   *  fee's OWN direct additional input(s) beyond that derived metric —
   *  the derived metric's own raw inputs live in derived_metric.raw_inputs,
   *  never duplicated here. Short, generic snake_case-ish labels extracted
   *  from the clause itself — never invented, never a pricing-runtime
   *  wiring, just preserving which inputs a future execution primitive
   *  would need. */
  required_operational_inputs?: string[] | null
  /** Step 17A hardening item 5 — when this fee's rate is itself a DERIVED
   *  metric (computed from other raw operational inputs via a formula the
   *  contract states, e.g. "value-weighted payment rate = paid invoice
   *  value ÷ total invoice value") rather than one raw measurement, this
   *  preserves that formula truthfully instead of flattening every
   *  referenced quantity into required_operational_inputs as if they were
   *  independent, equally-weighted raw inputs to THIS fee directly.
   *  Extraction-time preservation only — a human-readable label/formula
   *  STRING, never itself execution authority (no eval, ever — see
   *  PercentageOfBasisConfig below for the actual typed, structural
   *  execution config Step 17C.1 introduces alongside this field, which
   *  this one is never repurposed into). */
  derived_metric?: {
    metric_name: string
    formula: string
    raw_inputs: string[]
  } | null
  /** Step 17C.1 — the TYPED, structural, deterministic execution
   *  configuration for a fee whose rate is itself a percentage selected
   *  from a schedule keyed off a derived ratio metric (e.g. Remembill's
   *  value-weighted-payment-rate performance share). Populated at
   *  extraction time when the contract states an explicit rate schedule
   *  (never invented/interpolated) — see lib/rate-schedule.ts's own
   *  gap/overlap validation, which this shape must satisfy before it's
   *  usable. Absent/null means this fee has no executable percentage-of-
   *  basis mechanism (the common case for every fee that isn't shaped this
   *  way) — never a fallback derived from derived_metric.formula's free
   *  text. See lib/percentage-of-basis-fee.ts's computePercentageOfBasisFee
   *  for the actual execution, and lib/performance-share-fee.ts for how
   *  this composes with pilot/waiver materiality gating and readiness. */
  percentage_of_basis?: PercentageOfBasisConfig | null
  /** Step 17A, item 12 — same convention as OneTimeFee.unresolved_kind
   *  (see that field's own comment). 'unsupported_semantics' marks a
   *  commercial mechanism this shape genuinely cannot represent/execute
   *  yet (e.g. a rolling multi-month average repricing transition) — the
   *  clause itself (fee_label/description/source_clause/
   *  required_operational_inputs) is still fully preserved, never silently
   *  dropped; it simply contributes no amount/quantity anywhere until a
   *  future step adds real execution support. Never set merely because a
   *  fee is per-unit (item 7) — metric_name/rate_per_unit alone is a
   *  SUPPORTED shape (an operational-quantity fee, correctly represented,
   *  just not yet invoiceable without usage data); this is reserved for a
   *  fee whose pricing MECHANISM itself has no representation at all. A
   *  percentage-of-basis fee (percentage_of_basis populated, Step 17C.1) is
   *  likewise no longer this shape — it has real execution support now,
   *  even though it still contributes no amount until real per-period
   *  operational input values exist (a readiness/finality question, not a
   *  representational one — see lib/performance-share-fee.ts). */
  unresolved_kind?: 'unsupported_semantics' | null
  /** Literal (or lightly paraphrased) source text for THIS fee's own
   *  clause — mirrors OneTimeFee/Discount/ServiceCredit's own
   *  source_clause convention. */
  source_clause?: string | null
  /** Step 17B0.2, item 6 (revised Step 17B0.4) — when source_clause
   *  combines evidence from more than one section (e.g. a performance-
   *  share fee whose rate, formula, and rate-schedule are each stated in a
   *  different part of an appendix), each section's own SourceLocator, in
   *  the same order the evidence appears in source_clause — never one
   *  locator standing in for a concatenated multi-clause string. Absent/
   *  empty means this fee's evidence came from a single section (the
   *  common case) — callers fall back to field_sources.
   *  additional_recurring_fees exactly as before. */
  source_sections?: SourceLocator[] | null
}

// Step 17B0.4 — a PDF clause locator is not the same thing as what a
// reviewer reads as its caption. exact_source_heading is the ONLY value
// PDFViewer.tsx's text-layer search may ever receive: copied verbatim from
// the original document (own language, own numbering, own punctuation) —
// never translated, paraphrased, or given an invented "Section N" label
// (a real, confirmed live bug: extraction was writing values like "Bilaga
// 1 – Pris och kommersiell modell, Section 2" for a document whose actual
// heading is "2. Pilot och affärsmodell" — that invented compound string
// can never match real PDF text, so no marker was ever drawn).
// display_label is a friendlier caption for the UI ONLY — e.g. "Bilaga 1,
// Source 2" — and must never be passed to the PDF viewer as a locator.
export interface SourceLocator {
  exact_source_heading: string
  display_label?: string | null
}

// Step 17A hardening item 4 — a commercial MECHANISM that is not itself a
// billable fee (see ContractTerms.unsupported_commercial_mechanisms' own
// doc for the distinction from AdditionalRecurringFee.unresolved_kind).
// `kind` is a short, generic, extracted-not-invented slug (e.g.
// 'rolling_volume_pricing_transition') — never a closed enum, since new
// contracts will state mechanisms this shape hasn't seen before and this
// container's whole purpose is to preserve them rather than force-fit or
// silently drop whatever doesn't fit an existing enum value.
export interface UnsupportedCommercialMechanism {
  kind: string
  description: string
  source_clause?: string | null
  /** Step 17B0.2, item 6 (revised Step 17B0.4) — see
   *  AdditionalRecurringFee.source_sections' own doc; identical
   *  convention, for a mechanism whose evidence spans more than one
   *  section. */
  source_sections?: SourceLocator[] | null
  required_operational_inputs?: string[] | null
  execution_status: 'unsupported'
}

// Step 17A, item 13 — one row of a committed-volume fixed-fee band table
// (e.g. "1–500: EUR 500/mo", "501–1,500: EUR 1,200/mo", "1,501–5,000: EUR
// 2,000/mo"). to_unit null means "and above" (the top/open-ended band).
export interface FixedFeeBand {
  from_unit: number
  to_unit: number | null
  /** Step 17B0.3 — null means this band has no stated fixed amount at all:
   *  the contract requires a separate quote/negotiation above this volume
   *  (e.g. "150,001+: Offereras" / "priced on request"). Never 0 — a
   *  quote-required band is not a free one. Display code must render this
   *  distinctly (e.g. "Offereras" / "Price required"), never as a blank
   *  "—/month" that reads as missing data rather than a real, deliberate
   *  contractual state. */
  monthly_fee: number | null
}

// Step 17C.1 — the generic execution chain: raw operational inputs ->
// DerivedMetric -> RateSchedule -> PercentageOfBasis -> economic
// obligation. Each stage is its own small, typed, deterministic primitive
// (lib/derived-metric.ts, lib/rate-schedule.ts, lib/percentage-of-basis-
// fee.ts) — no arbitrary formula/eval, ever; every operand is referenced by
// a stable typed key, resolved against the SAME operational-input map
// lib/operational-data-inputs.ts already surfaces for review-UI visibility.

// A deterministic computation of one value from two named raw operational
// inputs. 'ratio' is the only operation Step 17C.1 implements (numerator /
// denominator) — deliberately not an open-ended formula language (see this
// file's header rule against arbitrary JS/eval). output_unit converts the
// raw ratio (0..1) to a percentage (0..100) when the consuming RateSchedule
// is itself percentage-keyed, without the two needing to agree on units by
// convention alone.
export interface DerivedMetricConfig {
  metric_key: string
  operation: 'ratio'
  numerator_input_key: string
  denominator_input_key: string
  output_unit: 'ratio' | 'percentage'
  /** Both operands are rejected as invalid (never silently coerced to 0 or
   *  their absolute value) when negative and this is false/unset — the
   *  correct default for a monetary/countable operational input, where a
   *  negative value is virtually always a data error. Set true only for a
   *  metric whose configured semantics genuinely permit a negative operand
   *  (none exist in this codebase yet). */
  allow_negative_operands?: boolean
  /** Optional domain bound on the COMPUTED value (in output_unit), not the
   *  raw operands — e.g. a ratio where the numerator is contractually a
   *  subset of the denominator (paid invoice value ⊆ total invoice value)
   *  can never legitimately exceed 100%; a value above this is a data
   *  problem (paid > total), not a "wait for more data" situation, and
   *  fails 'invalid' rather than 'not_ready'. Unset = no bound. */
  min_output_value?: number | null
  max_output_value?: number | null
}

// One row of a rate schedule: [from, to) — from inclusive, to EXCLUSIVE
// (never the FixedFeeBand's inclusive-inclusive convention above — a
// percentage schedule's own stated intervals are half-open, e.g. "5–<10%",
// and must preserve that exact boundary semantics, not FixedFeeBand's
// unrelated committed-volume-band shape). to: null is only ever valid on
// the LAST band of a schedule — see RateSchedule.max_selector_value, which
// is what actually bounds an open-ended last band (e.g. a schedule capped
// at exactly 100% represents that as a single-point last band
// {from:100, to:null} + max_selector_value:100, never a literal {from:100,
// to:100} which validateRateSchedule would reject as empty/inverted).
export interface RateScheduleBand {
  from: number
  to: number | null
  rate_pct: number
}

// A generic, bounded, explicit lookup table converting a selector value
// (e.g. a DerivedMetric's output) into a contractual rate — never a
// generic mathematical formula reconstructing the table (e.g. "round down
// to the nearest 5%"), even when the real numbers happen to look like they
// might fit one — the agreement's schedule is what it states, verbatim,
// row by row; lib/rate-schedule.ts's validateRateSchedule enforces no
// gaps/no overlaps/deterministic boundaries structurally, not by trusting
// extraction to have gotten the arithmetic right.
export interface RateSchedule {
  schedule_key: string
  bands: RateScheduleBand[]
  /** The first band's `from` must equal this exactly (validated) — the
   *  schedule's own stated floor, e.g. 0 for a payment-rate percentage
   *  that can be as low as 0%. */
  min_selector_value: number
  /** A selector value above this is rejected (out_of_bounds) rather than
   *  silently matched against whichever band happens to have to: null —
   *  null means genuinely unbounded (no configured cap), which must be an
   *  explicit choice, never the default for a schedule whose real-world
   *  values are contractually bounded (e.g. a payment rate can never
   *  exceed 100%). */
  max_selector_value: number | null
}

// Ties a DerivedMetric (the RATE SELECTOR) to a RateSchedule (the RATE
// TABLE) and a separately-configurable MONETARY BASIS the selected rate is
// applied against. The key generic principle Step 17C.1 exists to encode:
// Metric A may select Rate B, and Rate B may be applied to a different
// Basis C — basis_input_key is deliberately independent of
// derived_metric.numerator_input_key/denominator_input_key (for Remembill
// they happen to share the denominator, total_invoice_value_of_issued_
// requests, but nothing here couples them — a future contract could select
// a rate off one ratio and apply it to an entirely unrelated monetary
// basis). See lib/percentage-of-basis-fee.ts's computePercentageOfBasisFee.
export interface PercentageOfBasisConfig {
  derived_metric: DerivedMetricConfig
  rate_schedule: RateSchedule
  basis_input_key: string
}

export interface RampStep {
  start_date: string
  end_date: string
  monthly_fee: number
  label?: string
}

export interface ContractTerms {
  contract_id: string | null
  crm_id: string | null
  customer_name: string | null
  customer_address: string | null
  billing_contact: string | null
  vendor_name: string | null
  vendor_address: string | null
  order_date: string | null
  contract_start_date: string | null
  contract_end_date: string | null
  contract_term_months: number | null
  auto_renews: boolean | null
  renewal_notice_days: number | null
  /** Step 17A, item 10 — set ONLY when the contract states the renewal
   *  notice period in MONTHS (e.g. "three (3) months' notice"). Sibling
   *  field to renewal_notice_days, never a conversion of it and never both
   *  meaningfully populated for the same clause — extraction preserves
   *  whichever unit the contract actually uses; display code prefers this
   *  field when present rather than converting a stated month-count into
   *  an approximate day figure (see lib/contract-notice-period.ts's
   *  formatRenewalNoticePeriod). */
  renewal_notice_months?: number | null
  customer_email?: string | null
  customer_org_number?: string | null
  /** Length of each successive renewal period in months. Often differs from the initial term. */
  renewal_term_months?: number | null
  currency: string
  base_monthly_fee: number | null
  base_annual_fee: number | null
  /** Step 17A, item 13 — the full committed-volume fee band table, when the
   *  contract states one (e.g. "1,501–5,000 requests/month: EUR 2,000").
   *  base_monthly_fee remains the single resolved/selected figure the
   *  billing engine actually uses (unchanged, backward compatible) —
   *  this preserves the CAUSAL CHAIN (which band, and the committed
   *  volume that selected it) rather than flattening it into an
   *  unexplained flat number. See lib/fixed-fee-band.ts's
   *  resolveFixedFeeBand for the (pure, generic) band-selection logic —
   *  the SAME tier-selection shape lib/tariff.ts already uses for usage
   *  overage tiers, applied here to a committed FIXED fee instead. */
  base_fee_bands?: FixedFeeBand[] | null
  /** The contractually stated/signed committed volume that selects a band
   *  in base_fee_bands above (e.g. 5,000). Distinct from included_units
   *  (the free allowance before overage applies) — a contract can state
   *  both a committed volume (which band) and a separate included
   *  allowance; they coincide in the common case but are not the same
   *  fact. Null when the contract has no band table at all. */
  base_fee_committed_volume?: number | null
  /** base_monthly_fee/base_annual_fee are singular fields, not an array, so
   *  they need their own proration slot rather than a per-item one like
   *  AdditionalRecurringFee.proration. */
  base_fee_proration?: PeriodProrationRule | null
  billing_frequency: 'monthly' | 'quarterly' | 'semi-annual' | 'annual' | null
  payment_terms_days: number | null
  payment_terms_text: string | null
  included_units: number | null
  included_unit_type: string | null
  year_pricing: Record<string, number> | null
  ramp_schedule: RampStep[] | null
  escalators: PriceEscalator[]
  discounts: Discount[]
  service_credits: ServiceCredit[]
  /** Reviewer-confirmed ordering for when two service_credits' eligible
   *  components overlap — see CreditApplicationPriority. Absent/null means
   *  either no overlap exists (order genuinely doesn't matter) or an
   *  overlap exists but hasn't been resolved yet (those credits stay
   *  blocked from application until it is). */
  credit_application_priority?: CreditApplicationPriority | null
  overage_tiers: OverageTier[]
  billing_metered_items?: BillingMeteredItem[]
  additional_recurring_fees: AdditionalRecurringFee[] | null
  one_time_fees: OneTimeFee[]
  /** Step 17A hardening item 4 — a commercial MECHANISM the contract states
   *  that is not itself a fee at all (nothing here is ever billed
   *  directly) but instead governs HOW another fee's rate changes over
   *  time (e.g. a rolling three-month-average repricing transition for a
   *  performance-share rate). AdditionalRecurringFee's own
   *  unresolved_kind/'unsupported_semantics' convention stays reserved for
   *  fee mechanisms proper (see that field's doc) — a transition/repricing
   *  RULE belongs here instead, in a container the line-items/TCV pipeline
   *  never reads, so it structurally cannot become a line item or
   *  contribute to any total by accident. Preserved with full source
   *  provenance; no execution runtime exists for any entry here yet. */
  unsupported_commercial_mechanisms?: UnsupportedCommercialMechanism[] | null
  field_sources: Record<string, string>
  extraction_confidence: 'high' | 'medium' | 'low'
  extraction_notes: string | null
  number_format?: 'dot' | 'comma'
}

export interface BillingRecord {
  invoiceId: string
  customerName: string
  customerId?: string
  invoiceDate: Date
  amountBilled: number
  currency: string
  status: string
  contractRef?: string
  /** e.g. "subscription", "usage", "additional_users", "overage" — populated when the CSV has a type/line_item_type column */
  invoiceType?: string
}

export interface LeakageFinding {
  finding_id: string
  leakage_type: 'ESCALATOR_MISS' | 'DISCOUNT_OVERHANG' | 'OVERAGE_UNBILLED'
  customer_name: string
  contract_id: string | null
  invoice_id?: string
  billing_month: string
  description: string
  contracted_amount: number
  billed_amount: number
  leakage_amount: number
  evidence: string
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  priority: 'CRITICAL' | 'HIGH' | 'MEDIUM'
}

export interface ApprovedLineItem {
  product_name: string
  quantity: number
  unit_price: number
  billing_period: string
  total_amount: number
  currency: string
}

export interface BillingMeteredItem {
  unit_type:            string
  meter_id:             string
  price_id:             string
  subscription_item_id: string
  /** @deprecated Lago was removed in favour of the on-demand pull model. Field is preserved for backward compatibility with existing JSONB rows but is no longer read by any runtime path. */
  lago_metric_code?: string
}

export interface PartnerInvoiceLine {
  description: string
  quantity: number | null
  unit_rate: number | null
  volume: number | null
  amount_billed: number
  currency: string
  reference: string | null
}
