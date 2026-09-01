// Step 17H.3D1 — where a discount belongs in Commercial Logic & Billing
// Setup, resolved ONLY from typed state. The 17H.3C4 doctrine applies
// identically here: business/domain classification must come from
// authoritative typed fields, never from display-label text
// (discount.applies_to/description are extracted, human-readable clause
// language for audit/display only — lib/types.ts's Discount.affected_components
// doc comment is explicit that "a label merely containing a word like
// 'platform' proves nothing structurally"). affected_components is the
// SAME field lib/committed-fixed-fee-resolver.ts's own materiality check
// reads — never re-derived independently here.
export type DiscountComponentKey = 'base_recurring_fee' | 'performance_fee' | 'usage_fee' | 'overage_fee'

const KNOWN_DISCOUNT_COMPONENT_KEYS: readonly DiscountComponentKey[] = ['base_recurring_fee', 'performance_fee', 'usage_fee', 'overage_fee']

export type DiscountAttachment =
  | { kind: 'component'; componentKey: DiscountComponentKey }
  // Genuinely cannot be truthfully attached to one component — rendered
  // in Commercial Logic's cross-cutting "Discounts" location instead of
  // guessed onto the first/fixed component. `reason` is reported, not
  // silently swallowed, so a caller (or a future audit) can see WHY.
  | { kind: 'cross_cutting'; reason: 'no_affected_components' | 'multiple_affected_components' | 'unrecognized_component_key' }

export function resolveDiscountComponentAttachment(discount: { affected_components?: string[] | null }): DiscountAttachment {
  const affected = discount.affected_components ?? []
  if (affected.length === 0) return { kind: 'cross_cutting', reason: 'no_affected_components' }
  if (affected.length > 1) return { kind: 'cross_cutting', reason: 'multiple_affected_components' }
  const key = affected[0]
  return (KNOWN_DISCOUNT_COMPONENT_KEYS as readonly string[]).includes(key)
    ? { kind: 'component', componentKey: key as DiscountComponentKey }
    : { kind: 'cross_cutting', reason: 'unrecognized_component_key' }
}

// A discount's own typed discount_type — a closed, four-value enum, not
// free text — is authoritative classification, unlike applies_to/
// description. Reused verbatim from Commercial Terms' existing ternary
// (one canonical mapping, not two independently-maintained copies).
export function discountTypeLabel(discount_type: string | null | undefined): string {
  if (discount_type === 'introductory') return 'One-time · introductory'
  if (discount_type === 'volume') return 'Recurring · volume'
  if (discount_type === 'negotiated') return 'Recurring · negotiated'
  return discount_type?.replace(/_/g, ' ') ?? 'Discount'
}

// Step 17H.4B0D4H1B4E7.1 §3/§16 — a SEPARATE function from
// discountTypeLabel above, deliberately: that one is the existing,
// already-tested "typed enum, not label inference" classification label
// ("One-time · introductory") and is left completely unchanged (its own
// test suite enshrines that exact string). This one answers a different
// question — not "which discount_type bucket is this," but "what is the
// economic meaning a reviewer should read at a glance" — for Commercial
// Logic's business-facing row label specifically. A 100%-off introductory
// discount IS a waiver (the fee is fully suspended, not merely reduced);
// anything less than 100% is a genuine discount, not a waiver — that
// distinction is real and worth keeping, not just cosmetic. discount_pct
// is the only signal used (never discount_type's raw string, never a
// label-text guess) — still cash-amount introductory discounts (no pct)
// fall to the discount wording, since "waiver" specifically implies the
// fee itself is suspended, which an amount-based reduction doesn't assert.
export function discountBusinessLabel(discount: { discount_type?: string | null; discount_pct?: number | null }): string {
  if (discount.discount_type === 'introductory') {
    return discount.discount_pct === 100 ? 'Introductory waiver' : 'Introductory discount'
  }
  if (discount.discount_type === 'volume') return 'Volume discount'
  if (discount.discount_type === 'negotiated') return 'Negotiated discount'
  return discount.discount_type ? discount.discount_type.replace(/_/g, ' ') : 'Discount'
}

// Whichever authoritative timing fact is actually populated, in the same
// precedence Commercial Terms already used — never both an explicit date
// range and a bare duration for the same discount. Raw values only (no
// date formatting); the caller applies its own existing fmtDate.
export type DiscountPeriodFact =
  | { kind: 'date_range'; startDate: string; endDate: string }
  | { kind: 'duration_days'; days: number }
  | { kind: 'duration_months'; months: number }
  | { kind: 'none' }

export function resolveDiscountPeriod(discount: {
  start_date?: string | null; end_date?: string | null
  duration_days?: number | null; duration_months?: number | null
}): DiscountPeriodFact {
  if (discount.start_date && discount.end_date) return { kind: 'date_range', startDate: discount.start_date, endDate: discount.end_date }
  if (discount.duration_days) return { kind: 'duration_days', days: discount.duration_days }
  if (discount.duration_months) return { kind: 'duration_months', months: discount.duration_months }
  return { kind: 'none' }
}

// Step 17H.3D1.1 — the 17H.3D1 audit found Commercial Terms could still
// fall back to raw `applies_to` display text when no structured
// applicability existed; Commercial Logic omitted it entirely, a real
// (if minor) context loss. This restores that context WITHOUT giving
// `applies_to` any semantic authority: it is never read by
// resolveDiscountComponentAttachment (that function has no such
// parameter at all — routing stays affected_components-only), and this
// function itself takes the ALREADY-COMPUTED structured scope sentence
// as an input rather than re-deriving applicability, so it can never
// disagree with or override the real routing decision — it can only ever
// be consulted once that decision is already made, purely to decide
// whether raw text is worth showing alongside it.
//
// Returns null (nothing to show) whenever:
//   - structured applicability already produced a sentence (never repeat
//     the same fact as both a structured row and raw prose — 17H.3D1
//     item 3's "explain the contractual rule once"), or
//   - applies_to is absent/blank.
// A non-null return is informational SOURCE WORDING only — the caller
// must render it under a distinct label (never "Applies to", which is
// reserved for the structured fact) so it can never be mistaken for a
// confirmed structured mapping, resolved or not.
export function resolveDiscountContractWordingContext(
  discount: { applies_to?: string | null },
  structuredScopeSentence: string | null,
): string | null {
  if (structuredScopeSentence) return null
  const wording = discount.applies_to?.trim()
  return wording ? wording : null
}
