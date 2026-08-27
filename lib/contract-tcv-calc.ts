// Pure Base TCV calculation — zero I/O, zero server-only imports, so it's
// safe to import from client components. lib/contract-tcv.ts (server-only,
// pulls in supabaseServer) wraps this for the DB-fetching getContractSummaries;
// the Configure page imports this file directly instead, since it already
// has items/terms loaded client-side and importing anything that drags in
// supabaseServer crashes the page (that client throws at module-init time
// when SUPABASE_SERVICE_ROLE_KEY is undefined in the browser bundle).

export function isEscalatorItem(productName: string, appliedRule: string | null | undefined): boolean {
  const name = (productName ?? '').toLowerCase()
  const rule = (appliedRule ?? '').toLowerCase()
  return rule.includes('escalator') || name.includes('escalator') || name.includes('cpi') || name.includes('price escalator')
}

// Agreement A final amendment, item 2 — a fee's BILLABILITY CONDITION
// (when it becomes billable — see lib/billability-condition.ts) is a
// different question from its COMMITMENT STATUS (whether the underlying
// commercial obligation is already part of the signed agreement at all).
// An Implementation fee gated on customer_acceptance is still committed —
// the customer already agreed to pay it, only the timing depends on an
// event within this agreement's own guaranteed lifecycle. A fee that only
// arises if a future, separate, optional Change Order is signed is
// different in kind: the obligation itself doesn't exist yet. This module
// stays a dumb summation over whatever commitmentStatus its caller
// supplies — it deliberately does NOT import billability-condition.ts or
// know what "change_order_signature" means; that classification happens at
// the commercial-item construction boundary (where a BaseTcvItem is built
// from a OneTimeFee/LineItem — see isChangeOrderConditional's own callers)
// and is passed in already resolved, exactly like every other field here.
export type CommitmentStatus = 'committed' | 'conditional_future_agreement'

export type BaseTcvItem = {
  product_name: string
  applied_rule?: string | null
  total_amount: number | null
  billing_period: string | null
  /** Defaults to 'committed' when absent — preserves every existing
   *  caller's exact prior behavior (recurring fees, and one-time fees with
   *  no Change-Order gating, were always committed; nothing here changes
   *  for them). Only a fee whose own existence depends on an unsigned,
   *  optional future Change Order is 'conditional_future_agreement'. */
  commitmentStatus?: CommitmentStatus
}

// buildLineItems (app/api/jobs/[id]/execute/route.ts) always emits
// total_amount as the item's *already fully-resolved* contribution to the
// term — quantity × unit_price, pre-multiplied by however many cycles that
// row spans (one row per distinct rate block, so an escalator or ramp
// contract naturally produces several rows, each already complete). TCV is
// therefore just the sum of every non-escalator row's total_amount — no
// further multiplication, and no need to infer a per-item cycle count from
// how many other rows happen to share its billing_period (that heuristic
// broke as soon as two unrelated fields — e.g. the base fee and an overage
// tier — could legitimately share the same cadence).
// "Potential fixed fees" — every non-escalator row, INCLUDING fees still
// conditional on a future, unsigned Change Order. Never itself labeled
// "committed"/"fixed fees" to a reviewer without qualification — see
// computeCommittedFixedFees/computeConditionalFixedFees below for the
// split a UI showing a committed-value figure must use instead.
export function computeBaseTcv(items: BaseTcvItem[]): number {
  return items.reduce((s, item) => {
    if (isEscalatorItem(item.product_name, item.applied_rule)) return s
    return s + (item.total_amount ?? 0)
  }, 0)
}

// "Committed fixed fees" — every non-escalator row that is already part of
// the signed agreement's commercial obligation, excluding only fees whose
// existence itself depends on a future, unsigned, optional Change Order
// (commitmentStatus === 'conditional_future_agreement'). This is the figure
// safe to label "committed"/"fixed fees" without qualification — see the
// module-level CommitmentStatus doc comment for why this is independent of
// a fee's billability CONDITION (an item gated on customer_acceptance is
// still committed; only a Change-Order-gated item is not).
export function computeCommittedFixedFees(items: BaseTcvItem[]): number {
  return items.reduce((s, item) => {
    if (isEscalatorItem(item.product_name, item.applied_rule)) return s
    if (item.commitmentStatus === 'conditional_future_agreement') return s
    return s + (item.total_amount ?? 0)
  }, 0)
}

// "Conditional fees" — the complement of computeCommittedFixedFees: only
// rows whose existence depends on a future, unsigned Change Order.
// computeCommittedFixedFees(items) + computeConditionalFixedFees(items) ===
// computeBaseTcv(items) always (both are a partition of the same
// non-escalator row set), so a caller can show all three consistently
// without risk of the parts silently failing to add up to the whole.
export function computeConditionalFixedFees(items: BaseTcvItem[]): number {
  return items.reduce((s, item) => {
    if (isEscalatorItem(item.product_name, item.applied_rule)) return s
    if (item.commitmentStatus !== 'conditional_future_agreement') return s
    return s + (item.total_amount ?? 0)
  }, 0)
}

export type ConfirmedMinimumCommitment = {
  amount: number
  requires_confirmation: boolean
}

// Committed contract value = Committed fixed fees + every minimum
// commitment that has actually been confirmed. Uses
// computeCommittedFixedFees, not computeBaseTcv — a "committed contract
// value" figure must never include a fee that only arises from an unsigned
// Change Order, exactly like an unconfirmed minimum commitment is already
// excluded below for the same reason: nothing goes into a committed total
// without an actual, present obligation behind it. An unconfirmed
// commitment (ambiguous interaction with an included allowance, unclear
// proration, etc.) is deliberately left out of this figure rather than
// assumed. Once confirmed (or rejected/edited down to 0 by a reviewer), it
// flows in the same way any other confirmed minimum does.
export function computeCommittedContractValue(
  items: BaseTcvItem[],
  minimumCommitments: ConfirmedMinimumCommitment[],
): number {
  const fixedFees = computeCommittedFixedFees(items)
  const confirmedMinimums = minimumCommitments.reduce(
    (s, mc) => s + (mc.requires_confirmation ? 0 : mc.amount),
    0,
  )
  return fixedFees + confirmedMinimums
}

// Hardening item 3 — a committed-fixed-fee figure must never be presented
// as final while a billing-impacting decision that could still change it
// (fee applicability, effective period, or proration) remains unresolved.
// Deliberately generic and caller-driven: this module stays a dumb
// aggregator exactly like computeCommittedFixedFees above — it does not
// itself decide WHAT counts as "unresolved" (that's already governed
// elsewhere by lib/commercial-rule-status.ts's isDiscountUnresolved and
// sibling predicates, the codebase's one existing readiness gate for
// commercial rules); callers pass in the reasons their own readiness
// checks already produced. Any non-empty reason list withholds the WHOLE
// figure — never partially computed around an unresolved item — the same
// conservative posture already used for unresolved contract dates.
export interface CommittedFixedFeeReadiness {
  status: 'resolved' | 'unresolved'
  amount: number | null
  reasons: string[]
}

export function assessCommittedFixedFeeReadiness(
  items: BaseTcvItem[],
  unresolvedReasons: string[],
): CommittedFixedFeeReadiness {
  if (unresolvedReasons.length > 0) return { status: 'unresolved', amount: null, reasons: unresolvedReasons }
  return { status: 'resolved', amount: computeCommittedFixedFees(items), reasons: [] }
}

export type ContractLifecycleStatus = 'upcoming' | 'active' | 'completed' | 'no_dates'

// Drives the Billed to date / Realised TCV label choice: a contract is
// "completed" only once its own end date has passed — not when it merely
// looks fully billed, since a contract can be fully billed early (all
// invoices sent ahead of schedule) while still contractually active.
export function contractLifecycleStatus(
  startDate: string | Date | null,
  endDate: string | Date | null,
  today: Date = new Date(),
): ContractLifecycleStatus {
  if (!startDate || !endDate) return 'no_dates'
  const start = typeof startDate === 'string' ? new Date(startDate) : startDate
  const end   = typeof endDate   === 'string' ? new Date(endDate)   : endDate
  if (start > today) return 'upcoming'
  if (end < today) return 'completed'
  return 'active'
}
