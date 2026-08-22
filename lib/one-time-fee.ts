// Verdix commercial rules — OneTimeFee confirmation (Step 11 + amendments,
// Step 12).
//
// The minimal review/provenance path this step introduces (item 9) — NOT
// a new elaborate milestone review workflow. A reviewer explicitly
// confirming a one-time fee's amount and/or its billability/timing
// treatment is the ONE thing this module does.
//
// Step 12 note — this module needs NO functional change for
// BillabilityCondition. confirmBillability already mints reviewer_policy
// for whatever billability_provenance currently gates — under Step 12 that
// is the same field, now describing "is the normalized billability_
// condition confirmed" rather than the old due_date/manual_trigger pair
// (see lib/types.ts's OneTimeFee.billability_condition). Per Step 12 item
// 18, this step deliberately offers confirmation of the ALREADY-persisted,
// extraction-proposed condition only — no free-form condition editing —
// so there is no new client input surface here to secure: a reviewer
// cannot submit a BillabilityCondition value through this function at all.
// If condition editing is ever introduced, it must get the exact same
// trusted-value immutability discipline buildOneTimeFeeConfirmation already
// gives `amount` below (never silently overwrite a contract_derived value).
//
// Final security correction — this function accepts NO client-asserted
// FieldProvenance value at all, for either dimension. The caller (a route
// handler) may only say WHICH action happened — confirmAmount /
// confirmBillability, plain booleans — never WHAT AUTHORITY that action
// carries. The server derives the authority itself: a reviewer explicitly
// confirming an existing, already-extracted value can only ever mean
// 'reviewer_policy' — that IS the actual basis for resolution (a human
// looked at it and said yes), never 'contract_derived' (which would claim
// the CONTRACT TEXT itself is the basis, something this action never
// establishes) and never 'organization_rulebook'/'verdix_rulebook'
// (authorities this field has no activated path to at all — Organization
// Rulebook resolution is not extended to OneTimeFee in this step, and
// nothing in this codebase ever mints 'verdix_rulebook' outside a
// default_policy Global Rulebook rule, which does not exist for this
// field either). If Verdix later gains genuine source-grounding evidence
// for a OneTimeFee field, THAT would be a separate, new server-side path
// minting 'contract_derived' from real evidence — never this button,
// merely because a reviewer agrees the extraction looks right.
import type { OneTimeFee, FieldProvenance } from './types'

// Distinct from a plain Error specifically so route handlers can catch
// this ONE expected commercial state precisely (item 6) — never treated
// as an internal server failure. unresolved_kind: 'unsupported_semantics'
// is a real, structurally-expected outcome (Verdix cannot yet represent
// the source's billability condition), not a bug.
export class OneTimeFeeCapabilityBlockedError extends Error {
  readonly feeLabel: string
  constructor(feeLabel: string) {
    super(`Fee "${feeLabel}" is capability-blocked (unresolved_kind: 'unsupported_semantics') and cannot be confirmed via an ordinary reviewer decision.`)
    this.name = 'OneTimeFeeCapabilityBlockedError'
    this.feeLabel = feeLabel
  }
}

// Final adversarial correction — trusted provenance belongs to a specific
// resolved VALUE, not to the field in the abstract. A contract_derived
// amount is a (value, authority) pair grounded in the contract text;
// silently accepting a different number while leaving amount_provenance
// untouched would let that number inherit trust it never earned. There is
// no reviewer-override-of-a-contract-value workflow yet — a deliberate,
// narrow Step 11 scope boundary — so this fails closed: the mutation is
// rejected outright rather than accepted with a downgraded-but-unmarked
// authority. Distinct, catchable type (mirrors OneTimeFeeCapabilityBlocked
// Error) so a route handler can return a structured, non-500 response.
export class OneTimeFeeValueMutationRejectedError extends Error {
  readonly feeLabel: string
  readonly field: 'amount'
  constructor(feeLabel: string) {
    super(
      `Fee "${feeLabel}"'s amount is contract_derived — changing its value requires a dedicated ` +
      `source-reconfirmation workflow, which does not exist yet. Confirming the same value is safe; ` +
      `submitting a different one is rejected rather than silently accepted.`
    )
    this.name = 'OneTimeFeeValueMutationRejectedError'
    this.feeLabel = feeLabel
    this.field = 'amount'
  }
}

export interface OneTimeFeeConfirmationInput {
  // Present only when the reviewer is correcting the extracted amount —
  // absent means "leave the existing amount as-is." A number alone,
  // without confirmAmount, does NOT resolve amount_provenance — see below.
  amount?: number
  // True only when THIS submission is the reviewer explicitly confirming
  // the amount. The server mints 'reviewer_policy' for this — see the
  // module header for why no other value is ever accepted here.
  confirmAmount?: boolean
  // True only when THIS submission is the reviewer explicitly confirming
  // the billability/timing treatment (item 1's single field for the
  // manual_trigger + due_date decision) — independent of confirmAmount.
  confirmBillability?: boolean
}

// Item 5 — a reviewer confirmation must never DOWNGRADE an already
// higher-authority resolved value. contract_derived outranks reviewer_
// policy (lib/rulebook/resolution.ts's RESOLUTION_AUTHORITY_PRECEDENCE);
// nothing in THIS lifecycle can produce contract_derived yet (see the
// module header), but this stays correct by construction for the day a
// separate source-confirmation path does, and for defense in depth.
function confirmedProvenance(current: FieldProvenance | null | undefined): FieldProvenance {
  return current === 'contract_derived' ? 'contract_derived' : 'reviewer_policy'
}

// Pure — takes the existing persisted fee plus which action(s) THIS
// confirmation performs, returns the next OneTimeFee. Never reads a
// database, never calls an LLM.
//
// Item 5/6's critical guard: a fee flagged unresolved_kind: 'unsupported_
// semantics' can NEVER be resolved via this function, for EITHER
// dimension — confirming "yes, the amount is right" or "yes, the timing
// is fine" says nothing about the missing billability-trigger
// representation the capability blocker is actually about. Throws
// OneTimeFeeCapabilityBlockedError (a distinct, catchable type — item 6)
// rather than silently clearing the blocker.
export function buildOneTimeFeeConfirmation(
  existing: OneTimeFee,
  approved: OneTimeFeeConfirmationInput,
): OneTimeFee {
  if (existing.unresolved_kind === 'unsupported_semantics') {
    throw new OneTimeFeeCapabilityBlockedError(existing.fee_label)
  }

  // Guard applies regardless of confirmAmount — a bare `{ amount: X }` with
  // no confirm flag would otherwise still overwrite the value while
  // amount_provenance falls through to "existing, unchanged" below, which
  // is exactly the same unearned-trust outcome via a different code path.
  if (
    existing.amount_provenance === 'contract_derived' &&
    typeof approved.amount === 'number' &&
    approved.amount !== existing.amount
  ) {
    throw new OneTimeFeeValueMutationRejectedError(existing.fee_label)
  }

  const amount = approved.amount ?? existing.amount

  // Amount dimension — untouched unless confirmAmount was actually
  // submitted this round (item 2: confirming billability must never, as a
  // side effect, also resolve amount, and vice versa).
  const amount_provenance = approved.confirmAmount
    ? confirmedProvenance(existing.amount_provenance)
    : existing.amount_provenance ?? null
  const requires_confirmation = approved.confirmAmount ? false : existing.requires_confirmation
  const confirmation_reason = approved.confirmAmount ? null : existing.confirmation_reason

  // Billability dimension — same discipline, independently.
  const billability_provenance = approved.confirmBillability
    ? confirmedProvenance(existing.billability_provenance)
    : existing.billability_provenance

  return {
    ...existing,
    amount,
    amount_provenance,
    requires_confirmation,
    confirmation_reason,
    billability_provenance,
  }
}
