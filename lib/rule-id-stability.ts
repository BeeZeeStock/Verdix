// Re-extraction previously assigned every discount/service-credit a brand
// new random id every time (lib/contract-extractor.ts's assign*RuleIds only
// ever backfills a MISSING id — nothing upstream of it ever looked at what a
// prior extraction already had). That silently orphaned any already-reviewed
// .interpretation and the commercial_rule_interpretations audit rows that
// address their subject via discount:{id}/credit:{id}. This is the fix: match
// a newly-extracted item back to an existing one by exact description text
// (the same deterministic key mergeExtractions' own dedupe already uses — no
// fuzzy matching, no new heuristic) and carry its id + interpretation
// forward. An item whose description changed materially is treated as a new
// item — it gets a fresh id and no interpretation, which is what correctly
// blocks it from billing until a reviewer re-confirms it (never silently
// continuing to bill under the old, now-stale interpretation).
export function preserveStableRuleIds<
  T extends { description: string; interpretation?: unknown },
  K extends 'discount_rule_id' | 'credit_rule_id',
>(existingItems: T[], newItems: (T & Partial<Record<K, string>>)[], idField: K): (T & Record<K, string | undefined>)[] {
  const existingByDescription = new Map(existingItems.map(item => [item.description, item]))
  return newItems.map(item => {
    const existing = existingByDescription.get(item.description) as (T & Partial<Record<K, string>>) | undefined
    if (!existing || !existing[idField]) return item
    return { ...item, [idField]: existing[idField], interpretation: existing.interpretation }
  })
}

// Step 13 final amendment — the identical problem, for OneTimeFee.fee_id.
// Step 13 introduced fee_id specifically so operational_event_evidence has
// a stable subject to key against; without this function, EVERY
// re-extraction assigned a fresh fee_id (lib/contract-extractor.ts's
// normalizeBillabilityCondition only ever backfills a MISSING id, exactly
// like assignDiscountRuleIds/assignServiceCreditRuleIds), silently
// orphaning any already-recorded evidence and already-confirmed billability
// interpretation the moment a job was re-extracted.
//
// Reuses the EXACT same technique as preserveStableRuleIds above — match by
// exact description text, the same deterministic key mergeExtractions' own
// dedupe uses — never fee_label (Step 11 already documented fee_label as
// collision-prone; Step 13's final amendment explicitly forbids solving
// this with label matching), and never fuzzy/heuristic matching of any
// kind. A OneTimeFee has no nested `.interpretation` the way a discount/
// credit does — its reviewed state is several discrete fields — so this
// carries all of them forward together, atomically, rather than just one id
// field.
//
// The chosen invariant, REVISED (Step 13 final amendment, Part B / item 12
// — "whether reviewed-state preservation was too broad"). The first version
// of this function preserved ALL reviewed state unconditionally on an exact
// description match — but a match on description text is NOT a guarantee
// that the new extraction's concrete amount/condition are still what a
// reviewer actually reviewed. lib/commercial-rule-status.ts's
// isOneTimeFeeAmountUnresolved and isOneTimeFeeBillabilityUnresolved treat
// amount_provenance and billability_provenance/billability_condition as two
// fully INDEPENDENT axes (a fee can be amount-resolved while billability
// stays unresolved, and vice versa) — so this function now grants
// preservation per axis, not as one all-or-nothing bundle:
//
//   - A unique description match establishes IDENTITY CONTINUITY
//     ("same clause slot"). Updated (17H.4B0D4B0A.1.1): the existing
//     record's fee_id is reused only when it actually has one (and it
//     isn't already duplicated elsewhere upstream — a data-integrity issue
//     this function does not repair); a legacy record that predates
//     fee_id's introduction has nothing to hand forward, so the fresh
//     item's OWN already-generated fee_id survives instead — it is never
//     erased to null merely because the old side lacks an id. Either way,
//     evidence stays addressable under a stable subject id regardless of
//     what changed about the fee's other fields. If the condition's
//     event_type changes (below), old evidence naturally, correctly stops
//     matching via resolveOperationalEventEvidence's own subjectId+
//     eventType check — no special-casing needed here.
//   - The amount/billability axes below are gated ONLY on identity
//     continuity being established and on the axis's own equality check —
//     NEVER on whether fee_id itself was reusable. A legacy record with no
//     fee_id can still carry legitimate, previously-reviewed provenance;
//     losing it solely because the id was absent would discard real
//     reviewer work for a reason unrelated to whether that review is still
//     valid.
//   - amount_provenance/requires_confirmation/unresolved_kind/
//     confirmation_reason (the amount axis) carry forward ONLY when the
//     newly extracted `amount` is IDENTICAL to what was reviewed. A
//     reviewer confirmed a SPECIFIC number; if re-extraction (LLM
//     non-determinism, or a genuine contract amendment) produces a
//     different number under the same description text, that new number
//     was never reviewed and must re-enter review with a reset state —
//     exactly like a changed description does, just scoped to this axis.
//   - billability_provenance/billability_condition (the billability axis)
//     carry forward ONLY when the newly extracted condition is
//     STRUCTURALLY IDENTICAL to what was reviewed. Same reasoning: a
//     reviewer confirmed a specific trigger (e.g. customer_acceptance), not
//     "whatever event this clause implies next time."
//
// A fee whose description changed materially is still treated as fully new
// (existing.fee_id is never found, so neither axis nor fee_id carries
// forward) — unchanged from the original invariant. This is NOT a silent
// loss in any case: the OLD fee_id's operational_event_evidence rows remain
// permanently, immutably preserved in the database (append-only, never
// deleted) — simply no longer reachable/matching once the concrete fact
// they attest to has changed — and any reset axis cannot accept new
// evidence or reach billing until a reviewer re-confirms it from scratch
// (lib/commercial-rule-status.ts's readiness gate, and the attest route's
// own commercial_interpretation_unresolved check, both already require this
// regardless). The reviewer is always presented with a fresh, visibly
// unconfirmed item for whichever axis changed — nothing pretends stale
// review still applies to new facts.
// Step 17H.4B0D4B0A.1 — hardened to the same cardinality-aware doctrine
// already established for tier/one-time LINE-ITEM association
// (resolveTierIndexForLineItem, resolveOneTimeLineItemAssociation): 0
// matches -> no reuse (unchanged), exactly 1 old <-> exactly 1 new match on
// a description -> reuse, anything else -> AMBIGUOUS, never resolved by
// array/Map ordering.
//
// The PREVIOUS implementation built existingByDescription as a plain
// `Map(existingItems.map(item => [item.description, item]))` — a single
// key/value Map, so two existing items sharing a description silently
// collapsed to whichever one iterated LAST (an arbitrary "last write wins",
// never surfaced). Worse: because the lookup returns one winner regardless
// of how many NEW items share that same description, every one of them
// would independently receive the SAME existing.fee_id — a real identity
// COLLISION (two genuinely different fresh fees ending up with one
// fee_id), not merely a missed-preservation case. Both directions are now
// checked before any reuse is permitted.
//
// A null/blank description is never treated as an equivalence class: an
// item with no description can never participate in identity preservation
// via this bridge (matches preserveStableRuleIds' own typed requirement
// that description be a real string — OneTimeFee.description is the one
// exception in this codebase that allows null, so this function guards it
// explicitly rather than inheriting a shared type constraint).
//
// Also guards against propagating an already-duplicated fee_id: if the
// EXISTING data already has two items sharing one fee_id (a data-integrity
// issue this function does not attempt to repair — see 17H.4B0D4B0A's live
// audit, which found zero such cases today), that fee_id is never reused
// here even when the specific description group it's matched through
// happens to be unique — an inconsistency upstream is not license to
// propagate it further.
export function preserveOneTimeFeeIdentity<
  T extends {
    description: string | null
    amount: number
    fee_id?: string
    amount_provenance?: unknown
    billability_provenance?: unknown
    billability_condition?: unknown
    requires_confirmation?: boolean
    unresolved_kind?: unknown
    confirmation_reason?: string | null
  },
>(existingItems: T[], newItems: T[]): T[] {
  const groupByDescription = (items: T[]): Map<string, T[]> => {
    const groups = new Map<string, T[]>()
    for (const item of items) {
      if (!item.description) continue
      const group = groups.get(item.description)
      if (group) group.push(item)
      else groups.set(item.description, [item])
    }
    return groups
  }
  const existingGroups = groupByDescription(existingItems)
  const newGroups = groupByDescription(newItems)

  const existingFeeIdCounts = new Map<string, number>()
  for (const item of existingItems) {
    if (item.fee_id) existingFeeIdCounts.set(item.fee_id, (existingFeeIdCounts.get(item.fee_id) ?? 0) + 1)
  }

  return newItems.map(item => {
    if (!item.description) return item
    const existingGroup = existingGroups.get(item.description) ?? []
    const newGroup = newGroups.get(item.description) ?? [item]
    // Ambiguous in either direction — never reuse; the item keeps whatever
    // fee_id it already carries in (its own freshly-generated one).
    if (existingGroup.length !== 1 || newGroup.length !== 1) return item

    const existing = existingGroup[0]

    // Step 17H.4B0D4B0A.1.1 — identity CONTINUITY (same clause slot) is
    // proven by the unique description match alone, independent of
    // whether the OLD record happens to carry a fee_id. A legacy record
    // that predates fee_id's introduction (or a fee that never entered the
    // Step-12 lifecycle) still legitimately proves "this is the same fee"
    // via description — it simply has no identity of its own to hand
    // forward, so the fresh item's OWN already-generated fee_id (assigned
    // before this function runs) is what survives; it must never be
    // erased to null just because the old side has nothing to offer.
    //
    // This is deliberately a SEPARATE decision from whether the amount/
    // billability axes below get preserved: an old record lacking fee_id
    // can still carry legitimate, previously-reviewed amount_provenance/
    // billability_provenance — losing that solely because fee_id is absent
    // would throw away real reviewer work for no reason connected to
    // whether the review itself is still valid. The axis checks below run
    // unconditionally once identity continuity is established, keyed only
    // on whether the id itself is safely reusable (present and not
    // already duplicated upstream — the same guard as before).
    const canReuseExistingId = !!existing.fee_id && (existingFeeIdCounts.get(existing.fee_id) ?? 0) === 1
    const result: T = canReuseExistingId ? { ...item, fee_id: existing.fee_id } : { ...item }

    if (existing.amount === item.amount) {
      result.amount_provenance = existing.amount_provenance
      result.requires_confirmation = existing.requires_confirmation
      result.unresolved_kind = existing.unresolved_kind
      result.confirmation_reason = existing.confirmation_reason
    }

    if (JSON.stringify(existing.billability_condition ?? null) === JSON.stringify(item.billability_condition ?? null)) {
      result.billability_provenance = existing.billability_provenance
      result.billability_condition = existing.billability_condition
    }

    return result
  })
}

// Step 17H.4B0D4B1A — tier_id preservation. Deliberately NOT a copy of
// preserveStableRuleIds/preserveOneTimeFeeIdentity's description-keyed
// model: OverageTier has no description field, and a tier's true identity
// is STRUCTURAL — which metric, which boundary range — never a mutable or
// presentation field. The fingerprint is (metricKey, from_unit, to_unit):
//   - metricKey prefers semantic_input_key (already resolved through the
//     existing closed, deterministic registry elsewhere in this codebase —
//     lib/commercial-mechanism-compiler.ts's
//     resolveRecognizedOperationalInputKey) when present; falls back to
//     unit_type, normalized by trim+lowercase only — no fuzzy matching,
//     the same "normalize, don't fuzz" doctrine every other identity
//     bridge in this codebase follows. Live data audit (17H.4B0D4B1A):
//     semantic_input_key is populated on only 1 of 191 real tiers today —
//     the unit_type fallback carries almost the entire real population,
//     so its normalization quality matters in practice, not just in
//     principle.
//   - from_unit/to_unit compared as their own stored values (number or
//     null) — never coerced, never treated as equivalent to 0/undefined/a
//     display string. A live audit found only `number` and `null` ever
//     actually persisted for these fields; no open-ended sentinel other
//     than `null` exists in the real data to reconcile.
// Deliberately EXCLUDED from the fingerprint: rate_per_unit, tier_label,
// tier_calculation (method/wording/confirmation state), minimum_commitment,
// reset_anchor, measurement_period, required_operational_inputs,
// tier_id itself, and array position — all mutable/presentation/derived,
// never identity. A live audit found ZERO structural fingerprint
// collisions across all 191 real tiers in 52 jobs — this fingerprint does
// not need strengthening against real data as of this pass.
//
// Cardinality doctrine is identical to every other producer-side identity
// bridge hardened this session (preserveOneTimeFeeIdentity, resolveTierIndex
// ForLineItem): exactly one old tier and exactly one new tier sharing a
// fingerprint -> reuse; anything else (0, or >1 on either side) ->
// ambiguous, retain whatever tier_id the new tier already carries (assigned
// upstream by assignTierIds before this function ever runs — never null).
// An already-duplicated old tier_id (two existing tiers sharing one
// non-null tier_id — a data-integrity issue this function does not repair)
// is never propagated even through an otherwise-unique fingerprint match,
// mirroring the identical guard preserveOneTimeFeeIdentity already applies
// to fee_id.
//
// Deliberately does NOT preserve tier_calculation, minimum_commitment, or
// any other field — per explicit instruction, this pass does not invent
// preservation for state nothing preserves today. tier_calculation in
// particular is a METRIC-level field (duplicated across every tier of one
// metric, addressed by the job-level `tier:{unitType}` interpretation key,
// never by individual tier_id) — its own preservation, if ever needed, is
// a genuinely separate design question, out of scope here.
// Step 17H.4B0D4H1B4E3.4 — recurring_fee_id preservation for
// additional_recurring_fees[] (additional_recurring_fixed/variable line-item
// families). Root cause this fixes, confirmed via a REAL live extraction of
// the identical NordicFit PDF (E3.3's acceptance pass): the SAME clause was
// labeled "Success fee per completed payment" on one extraction and
// "Per-completed payment success fee" on another — pure AI wording
// non-determinism with the agreement completely unchanged. fee_label
// (product_name) was the ONLY identity these two families ever had, so a
// weak-family exact-label match blocked the re-extraction as
// unknown_identity even though nothing commercial actually changed.
//
// Deliberately NOT a copy of preserveTierIdentity/preserveOneTimeFeeIdentity
// — different family, different available typed evidence — but SAME
// doctrine and SAME cardinality-aware shape (0 matches -> no reuse, exactly
// 1 old <-> exactly 1 new on a fingerprint -> reuse, anything else ->
// ambiguous, never resolved by array position or label similarity).
//
// Fingerprint, per family (§9-§12 of 17H.4B0D4H1B4E3.4):
//   - A VARIABLE-RATE fee (metric_name + rate_per_unit>0, isVariableRateFee's
//     own predicate, mirrored here rather than imported to avoid pulling
//     lib/line-items.ts's server-only import chain into this module) is
//     identified by its semantic metric (semantic_input_key — the
//     CANONICAL, already-resolved key, preferred over metric_name's own
//     free-text spelling, which is display-only) + billing_frequency +
//     whether it's a derived-metric mechanism (a value-weighted-rate fee is
//     structurally different from a plain per-unit fee even if it happened
//     to share a metric name) + its sorted required_operational_inputs (the
//     ONLY further typed scope evidence this schema currently offers to
//     distinguish two fees that legitimately share one metric — e.g. "€X
//     per completed payment for Product A" vs "€Y per completed payment for
//     Product B" cannot be told apart by ANYTHING typed in the current
//     AdditionalRecurringFee shape beyond this; if two such fees are ever
//     genuinely indistinguishable by every typed field here, this function
//     correctly fails closed via the existing cardinality check — it does
//     NOT invent a label-based scope to force a decision, per explicit
//     instruction. This is a real, reported schema limitation, not a
//     defect in this function.
//   - A FIXED fee (no metric_name/rate_per_unit) has almost no distinguishing
//     typed structure in the current schema beyond billing_frequency — also
//     reported as a real limitation (§26). With exactly one fixed fee
//     (the common case), the fingerprint's cardinality is trivially 1:1
//     regardless, so preservation still works correctly for the common
//     case; a contract with MULTIPLE fixed fees sharing the same cadence
//     will correctly and safely fail to disambiguate them (fingerprint
//     collision -> ambiguous -> no reuse) rather than guessing.
//   - Deliberately EXCLUDED from the fingerprint (mirrors tier's own
//     exclusion of rate_per_unit): fee_label, description, amount,
//     rate_per_unit, confidence, source_clause/source_sections (supporting
//     evidence only, never sole identity — §14). A rate/amount correction
//     or a re-worded label must never orphan identity; a genuinely
//     DIFFERENT metric (semantic_input_key) or cadence correctly does.
export function preserveRecurringFeeIdentity<
  T extends {
    recurring_fee_id?: string
    metric_name?: string | null
    rate_per_unit?: number | null
    semantic_input_key?: string | null
    billing_frequency?: string | null
    derived_metric?: unknown
    required_operational_inputs?: string[] | null
  },
>(existingFees: T[], newFees: T[]): T[] {
  const isVariable = (f: T): boolean => !!f.metric_name && typeof f.rate_per_unit === 'number' && f.rate_per_unit > 0
  const fingerprint = (f: T): string => {
    if (isVariable(f)) {
      const metricKey = f.semantic_input_key ?? f.metric_name ?? ''
      const inputs = (f.required_operational_inputs ?? []).slice().sort().join(',')
      return `variable|${metricKey}|${f.billing_frequency ?? ''}|${!!f.derived_metric}|${inputs}`
    }
    return `fixed|${f.billing_frequency ?? ''}`
  }

  const groupByFingerprint = (fees: T[]): Map<string, T[]> => {
    const groups = new Map<string, T[]>()
    for (const fee of fees) {
      const fp = fingerprint(fee)
      const group = groups.get(fp)
      if (group) group.push(fee)
      else groups.set(fp, [fee])
    }
    return groups
  }
  const existingGroups = groupByFingerprint(existingFees)
  const newGroups = groupByFingerprint(newFees)

  const existingIdCounts = new Map<string, number>()
  for (const fee of existingFees) {
    if (fee.recurring_fee_id) existingIdCounts.set(fee.recurring_fee_id, (existingIdCounts.get(fee.recurring_fee_id) ?? 0) + 1)
  }

  return newFees.map(fee => {
    const fp = fingerprint(fee)
    const existingGroup = existingGroups.get(fp) ?? []
    const newGroup = newGroups.get(fp) ?? [fee]
    // Ambiguous in either direction — never reuse; the fee keeps its own
    // freshly-assigned recurring_fee_id (assignRecurringFeeIds — never
    // null for a modern extraction).
    if (existingGroup.length !== 1 || newGroup.length !== 1) return fee

    const existing = existingGroup[0]
    const canReuse = !!existing.recurring_fee_id && (existingIdCounts.get(existing.recurring_fee_id) ?? 0) === 1
    if (!canReuse) return fee

    return { ...fee, recurring_fee_id: existing.recurring_fee_id }
  })
}

export function preserveTierIdentity<
  T extends {
    tier_id?: string
    semantic_input_key?: string | null
    unit_type: string
    from_unit: number | null
    to_unit: number | null
  },
>(existingTiers: T[], newTiers: T[]): T[] {
  const metricKey = (tier: T): string => tier.semantic_input_key ?? tier.unit_type.trim().toLowerCase()
  const fingerprint = (tier: T): string => `${metricKey(tier)}|${tier.from_unit}|${tier.to_unit}`

  const groupByFingerprint = (tiers: T[]): Map<string, T[]> => {
    const groups = new Map<string, T[]>()
    for (const tier of tiers) {
      const fp = fingerprint(tier)
      const group = groups.get(fp)
      if (group) group.push(tier)
      else groups.set(fp, [tier])
    }
    return groups
  }
  const existingGroups = groupByFingerprint(existingTiers)
  const newGroups = groupByFingerprint(newTiers)

  const existingTierIdCounts = new Map<string, number>()
  for (const tier of existingTiers) {
    if (tier.tier_id) existingTierIdCounts.set(tier.tier_id, (existingTierIdCounts.get(tier.tier_id) ?? 0) + 1)
  }

  return newTiers.map(tier => {
    const fp = fingerprint(tier)
    const existingGroup = existingGroups.get(fp) ?? []
    const newGroup = newGroups.get(fp) ?? [tier]
    // Ambiguous in either direction — never reuse; the tier keeps whatever
    // tier_id it already carries (its own freshly-generated one, per
    // assignTierIds — never null for a modern extraction).
    if (existingGroup.length !== 1 || newGroup.length !== 1) return tier

    const existing = existingGroup[0]
    const canReuse = !!existing.tier_id && (existingTierIdCounts.get(existing.tier_id) ?? 0) === 1
    if (!canReuse) return tier

    return { ...tier, tier_id: existing.tier_id }
  })
}

// Step 17H.4B0D4B1B0D — tier_calculation reviewer-state (requires_confirmation/
// confirmation_reason) preservation, deliberately separate from
// preserveTierIdentity above: band identity and metric-level review identity
// answer different questions and are never merged into one function (see
// preserveTierIdentity's own comment). Grounded in a two-round live audit
// (17H.4B0D4B1B0C, .1) rather than assumption:
//
//   - tier_calculation is METRIC-scoped, not band-scoped: confirm-rule's own
//     tier_calculation branch (app/api/jobs/[id]/confirm-rule/route.ts)
//     writes the identical approved object onto every band sharing one exact
//     `unit_type` in a single update. Review identity here is therefore
//     `unit_type` (exact string, NEVER trim/lowercase-normalized) — the same
//     raw key confirm-rule, the review UI, and commercial_rule_interpretations
//     .contract_unit_type all already use. This is deliberately MORE
//     conservative than tier_id's own structural (metricKey/from_unit/to_unit)
//     fingerprint: a unit_type casing/spelling change breaks review
//     continuity here even where tier_id's own normalization might still
//     treat it as the same band — re-review is the safe failure mode, never
//     silently carrying an old approval onto a differently-labeled metric the
//     reviewer never saw under that exact name.
//   - The persisted JSONB alone can never distinguish "the extractor itself
//     concluded requires_confirmation=false" from "a reviewer explicitly
//     confirmed this via confirm-rule" — only a corroborating CURRENT
//     commercial_rule_interpretations row (rule_type='tier_calculation',
//     contract_unit_type=unit_type, is_current=true) proves the latter. A
//     unit_type with zero such rows gets NO preservation, no matter how
//     confident its prior JSONB looked — this function must never manufacture
//     reviewer authority extraction alone never earned (17H.4B0D4B1B0C's own
//     explicit finding: 12 of 15 live metric groups are in exactly this
//     no-evidence state today).
//   - The minimum semantic fingerprint that actually changes billed amounts,
//     traced directly into lib/tariff.ts's computeMetricOverage, is `method`
//     ALONE — confirmed via a live semantic-alignment audit
//     (17H.4B0D4B1B0C.1) that `source_clause` is NOT safe to add to this
//     fingerprint: the audit table's own source_clause column holds
//     UI-generated prompt/question text for this rule type, not contract
//     clause text, and the operational JSONB's tier_calculation.source_clause
//     is null on every one of the 3 live reviewed groups — comparing them
//     would never be a meaningful match, only ever a coincidental one.
//     worked_example/calculation_summary (fields the review UI/audit payload
//     carry) are confirmed EXPLANATORY ONLY — computeMetricOverage never
//     reads them — so they play no role in eligibility either.
//   - Preservation restores ONLY requires_confirmation=false and
//     confirmation_reason=null on the FRESH tier_calculation object — method
//     and source_clause always remain whatever the fresh extraction actually
//     produced, never copied from the old object. An old approval blessing a
//     DIFFERENT fresh method (or a fresh re-extraction that dropped/changed
//     source_clause under an otherwise-matching method) must never silently
//     re-apply to facts nobody has reviewed.
//   - Cardinality-aware exactly like every other identity bridge in this
//     file: for a given unit_type, 0 current audit rows -> no evidence, 1 ->
//     the sole candidate, >1 (a data-integrity anomaly this function does not
//     repair) -> ambiguous. Never resolved by first/last/array-position. The
//     prior operational group's own calculation-bearing bands must ALSO be
//     internally consistent (a single method value) before its state can
//     authorize anything — a prior metric that was itself already
//     inconsistent has no coherent "the reviewed method" to project forward.
//     Same requirement applies to the fresh group.
//   - "Calculation-bearing" reuses the exact convention already established
//     everywhere else this is read (page.tsx, lib/commercial-rule-status.ts:
//     `tiers.find(t => t.tier_calculation)`) — a band the extractor/safety
//     net actually populated tier_calculation on. A $0 "included" band that
//     legitimately has no tier_calculation (flagAmbiguousTierCalculation's
//     own documented exclusion) is never required to have one, and this
//     function never manufactures one where fresh extraction omitted it.
export type TierCalculationApprovedMethod = 'graduated' | 'volume' | 'block' | 'custom'
const VALID_TIER_CALCULATION_METHODS = new Set<TierCalculationApprovedMethod>(['graduated', 'volume', 'block', 'custom'])

// The shape execute/route.ts's own commercial_rule_interpretations query
// result already has — deliberately narrow (no reviewer_email/name, no
// unrelated columns) since this function needs nothing else, and the route
// should never select more PII than a given operation actually requires.
// Caller MUST pre-filter to this job's rows with rule_type='tier_calculation'
// AND is_current=true — this function trusts that contract exactly like
// preserveStableRuleIds/preserveOneTimeFeeIdentity trust their own
// existingItems arrays; it does not re-filter or re-verify currentness.
export interface TierCalculationAuditRow {
  contract_unit_type: string | null
  approved_interpretation: unknown
}

function parseApprovedTierCalculationMethod(row: TierCalculationAuditRow): TierCalculationApprovedMethod | null {
  const raw = (row.approved_interpretation as { method?: unknown } | null)?.method
  return typeof raw === 'string' && VALID_TIER_CALCULATION_METHODS.has(raw as TierCalculationApprovedMethod)
    ? (raw as TierCalculationApprovedMethod)
    : null
}

export function preserveTierCalculationReviewState<
  T extends {
    unit_type: string
    tier_calculation?: { method: TierCalculationApprovedMethod; requires_confirmation: boolean; confirmation_reason?: string | null } | null
  },
>(priorTiers: T[], freshTiers: T[], currentAuditRows: TierCalculationAuditRow[]): T[] {
  const auditGroups = new Map<string, TierCalculationAuditRow[]>()
  for (const row of currentAuditRows) {
    if (!row.contract_unit_type) continue
    const group = auditGroups.get(row.contract_unit_type)
    if (group) group.push(row)
    else auditGroups.set(row.contract_unit_type, [row])
  }

  const groupByUnitType = (tiers: T[]): Map<string, T[]> => {
    const groups = new Map<string, T[]>()
    for (const tier of tiers) {
      const group = groups.get(tier.unit_type)
      if (group) group.push(tier)
      else groups.set(tier.unit_type, [tier])
    }
    return groups
  }
  const priorGroups = groupByUnitType(priorTiers)
  const freshGroups = groupByUnitType(freshTiers)
  const calculationBearing = (tiers: T[]): T[] => tiers.filter(t => !!t.tier_calculation)

  const eligibleUnitTypes = new Set<string>()
  for (const [unitType, auditRows] of auditGroups) {
    // Ambiguous audit evidence (0 handled by simple absence from this map;
    // >1 current rows for the same unit_type is a data-integrity anomaly)
    // authorizes nothing — never pick a winner.
    if (auditRows.length !== 1) continue
    const approvedMethod = parseApprovedTierCalculationMethod(auditRows[0])
    if (!approvedMethod) continue

    const priorGroup = priorGroups.get(unitType)
    const freshGroup = freshGroups.get(unitType)
    if (!priorGroup || !freshGroup) continue

    const priorCalc = calculationBearing(priorGroup)
    const freshCalc = calculationBearing(freshGroup)
    if (priorCalc.length === 0 || freshCalc.length === 0) continue

    const priorMethods = new Set(priorCalc.map(t => t.tier_calculation!.method))
    const freshMethods = new Set(freshCalc.map(t => t.tier_calculation!.method))
    // Internal inconsistency on either side means there is no single
    // coherent "the reviewed method" to project forward — never preserve.
    if (priorMethods.size !== 1 || freshMethods.size !== 1) continue

    const [priorMethod] = priorMethods
    const [freshMethod] = freshMethods
    // The three-way gate: audit-approved, prior-operational, and
    // fresh-extracted method must all agree exactly.
    if (priorMethod !== approvedMethod || freshMethod !== approvedMethod) continue

    eligibleUnitTypes.add(unitType)
  }

  return freshTiers.map(tier => {
    // Never manufacture tier_calculation on a band the fresh extraction
    // legitimately omitted (a $0 included band, or a metric that no longer
    // has 2+ paid tiers).
    if (!tier.tier_calculation) return tier
    if (!eligibleUnitTypes.has(tier.unit_type)) return tier
    return {
      ...tier,
      tier_calculation: { ...tier.tier_calculation, requires_confirmation: false, confirmation_reason: null },
    }
  })
}
