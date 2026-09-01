// Step 17G.5A — small pure helpers behind the "Commercial Logic & Billing
// Rules" section. The section itself organizes rules by BUSINESS
// component (Platform subscription / Issued payment requests / ...), the
// same structure Commercial BoM uses (lib/commercial-components.ts) —
// never by the internal typed mechanism (additional_recurring_fees /
// overage_tiers / derived_metric). These
// helpers are the two genuinely reusable, independently-testable pieces of
// that grouping; the grouping loop itself stays inline in page.tsx (it
// closes over chargingGroups/ruleInterpretations/terms, same as every
// other rule-derivation block already in that file).
import { bomDisplayLabel } from './commercial-bom'
import { isLongFormValue } from './value-alignment'

export interface CommercialLogicFee {
  fee_label: string
  metric_name?: string | null
}

// Step 17G.6D — the business-level category a component accordion sits
// under (FIXED FEE / VARIABLE FEES / ...). Classified from the SAME typed
// pricingModel lib/commercial-components.ts already computes (fixed /
// usage / performance) plus this section's own two synthetic group kinds
// (a pure-tier usage metric with no matching component, and the
// cross-cutting credits group) — never by matching a component's business
// TITLE/label text (a "Platform subscription" vs "Performance share"
// string match would be exactly the kind of brittle, contract-specific
// guess item 4 forbids).
// Step 17H.3D1 — 'Discounts & pricing rules' added for the one genuinely
// new group shape this step introduces: a discount that cannot be
// truthfully attached to a single existing component (no/multiple/
// unrecognized affected_components — see lib/discount-commercial-logic.ts's
// resolveDiscountComponentAttachment) renders here instead of being
// guessed onto the first/fixed component. A component-attributable
// discount does NOT use this category — it lands inside that component's
// OWN existing group/category (Fixed fee/Variable fees), reusing getGroup
// verbatim rather than creating a second group for the same component.
// Step 17H.4B0D4H1B4E2.6 §2-4 — 'Shared / other required inputs' is the
// SAME kind of carve-out as 'Discounts & pricing rules' above, for the
// same reason: a monetary operational input with no single, typed owning
// commercial component (e.g. sourced only from one_time_fees/a non-
// rolling-band unsupported_commercial_mechanism) must not be silently
// placed inside a priced fee family it doesn't actually belong to (it
// previously rendered under 'One-time / project fees' purely because that
// getGroup call happened to run in that code path — never because the
// input IS a one-time fee). Ordered LAST in CATEGORY_ORDER (page.tsx) —
// after every real commercial component family — since it is
// configuration metadata, not an economic component.
export type CommercialCategory = 'Fixed fee' | 'Variable fees' | 'Discounts & pricing rules' | 'One-time / project fees' | 'Credits & adjustments' | 'Shared / other required inputs'

// Step 17H.4B0D4H1B4E7.1 §9 — a reviewer_name/reviewer_email value can be
// left over from an internal development/acceptance pass (e.g. a
// confirm-rule call made under a step-numbered test label instead of a
// real person, during this codebase's own development) rather than a
// genuine confirmer's name — it is real, persisted audit data (never
// deleted, never fabricated over), just not fit to show a reviewer as if
// it were someone's name. Matched structurally — a step-code-like prefix
// ("E3.6 ...", "17H.4...") or the phrase "acceptance pass/run" — never
// against one specific literal string, so it generalizes to any future
// internal label with the same shape, not just the one that was reported.
export function looksLikeInternalTestLabel(text: string): boolean {
  const trimmed = text.trim()
  if (/^[A-Z]\d+(\.\d+)*(\s|$)/.test(trimmed)) return true
  if (/^\d+[A-Z](\.\d+)*(\s|$)/i.test(trimmed)) return true
  return /acceptance\s+(pass|run)/i.test(trimmed)
}

export function classifyCommercialCategory(kind: 'fixed' | 'usage' | 'performance' | 'one_time' | 'credit'): CommercialCategory {
  switch (kind) {
    case 'fixed': return 'Fixed fee'
    case 'usage':
    case 'performance': return 'Variable fees'
    case 'one_time': return 'One-time / project fees'
    case 'credit': return 'Credits & adjustments'
  }
}

// A tier/minimum-commitment's unit_type (e.g. "issued_payment_request")
// is a semantic key, not a business name. Matches it against the flat
// usage fee that shares the same metric_name (the same identity
// buildUsageComponents itself groups overage tiers by) and runs the match
// through the same bomDisplayLabel() the Commercial BoM already uses, so
// the two sections' component headers read identically. Falls back to a
// light humanization of the unit_type itself — never a guess — when no
// matching fee exists (a metric that's purely tiered, with no separate
// flat per-unit fee of its own).
export function matchUsageComponentTitle(unitType: string, fees: CommercialLogicFee[] | null | undefined): string {
  const match = (fees ?? []).find(f => f.metric_name === unitType)
  if (match) return bomDisplayLabel(match.fee_label)
  return unitType.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())
}

// Step 17G.6B — pluralizes the trailing noun of a usage-component title
// ("Issued payment request" -> "Issued payment requests"). Deliberately
// NOT added to bomDisplayLabel itself (which stays a blanket, context-free
// transform reused by Commercial BoM and Products/Services/Pricing too,
// where a fee label isn't guaranteed to end in a countable per-unit noun —
// pluralizing an uncountable one, e.g. "Annual support" -> "Annual
// supports", would be wrong). Safe ONLY at this call site: every usage
// COMPONENT (lib/commercial-components.ts's buildUsageComponents) is, by
// construction, a per-rate_per_unit charge on a countable thing — the
// premise that makes pluralizing its trailing noun a genuinely safe,
// general English rule here, not a per-contract guess.
//
// Step 17G.6E, item 1 — first strips a short, EXPLICITLY named list of
// trailing qualifier words ("success") that commonly appear in an
// extracted fee label as pure filler around the true countable noun, not
// as content of their own — "Completed payment success fee" means "a fee
// per successfully completed payment," and the countable thing being
// charged is the payment, not "success." This is deliberately a narrow,
// enumerated exception, never a generic "drop the last adjective"
// heuristic (which would risk silently discarding real meaning from a
// future, differently-worded fee label) — a word not on this list is
// left completely alone.
const TRAILING_QUALIFIER_WORDS = new Set(['success'])

export function pluralizeUsageComponentTitle(title: string): string {
  const qualifierMatch = title.match(/^(.+)\s+(\S+)$/)
  const withoutQualifier = qualifierMatch && TRAILING_QUALIFIER_WORDS.has(qualifierMatch[2].toLowerCase())
    ? qualifierMatch[1]
    : title

  const match = withoutQualifier.match(/^(.*\s)?(\S+)$/)
  if (!match) return withoutQualifier
  const [, lead, lastWord] = match
  if (/s$/i.test(lastWord)) return withoutQualifier
  const plural = /[xz]$|[cs]h$/i.test(lastWord) ? `${lastWord}es`
    : /[^aeiou]y$/i.test(lastWord) ? `${lastWord.slice(0, -1)}ies`
    : `${lastWord}s`
  return `${lead ?? ''}${plural}`
}

// Step 17G.6B, item 3/9 — "Performance share" as a component's primary
// title, with a longer contractual elaboration (everything after a
// parenthetical or em/en-dash) demoted to secondary text rather than
// dropped. Purely a display split — the full original title is always
// still returned as `secondary` when a split occurs, never discarded. Only
// splits when a genuine multi-word leading clause exists before the
// delimiter (a label that IS the parenthetical, or starts with one, is
// left completely alone — never guessed at).
export function splitComponentTitle(title: string): { primary: string; secondary: string | null } {
  // Parenthesis and em/en-dash only — deliberately NOT a plain hyphen,
  // which is also legitimately used inside a single compound word (e.g.
  // "Value-added service") and would false-split there.
  const match = title.match(/^(.+?)\s*(?:\(|—|–)\s*(.+)$/)
  if (match && match[1].trim().split(/\s+/).length >= 2) {
    return { primary: match[1].trim(), secondary: title }
  }
  return { primary: title, secondary: null }
}

// "Logic complete" / "Blocked by N decision(s)" — a component-level
// summary of whether the RULE ITSELF is fully resolved. Deliberately
// never "Ready to bill": full billing readiness can still depend on usage
// sources, operational inputs and period finality, none of which this
// function (or this section) knows about — see item 12.
export function describeLogicStatus(blockedCount: number): string {
  if (blockedCount <= 0) return 'Logic complete'
  return `Blocked by ${blockedCount} decision${blockedCount === 1 ? '' : 's'}`
}

// Step 17G.6A, item 2 — broadens "Logic complete"/"Blocked by N
// decision(s)" into a component-level BILLING-SETUP readiness state, now
// that a component group can also carry a usage-source binding or a
// required operational input. Every input here is read from ALREADY
// authoritative state this codebase computes elsewhere — commercial-rule
// blockers (17G.5A's own decisionRequired count), usage-source/meter-
// mapping status (lib/usage-source-cards.ts's UsageSourceCard.status), and
// operational-input presence (GET .../meter-mappings' operational_data_
// inputs) — never a new persisted flag, never re-derived independently.
//
// Deliberately means only "this component has enough configuration to
// enter period billing" — NEVER "invoice ready now": a real invoice still
// depends on the period existing/closing and real quantities/values being
// entered for it, both handled entirely by Billing Timeline, which this
// function has no knowledge of.
export type ComponentReadiness =
  | 'ready_for_billing_timeline' | 'needs_commercial_decision' | 'needs_input_source'
  | 'needs_operational_input_configuration' | 'needs_commercial_decision_and_input_source'

// Step 17G.6G — reverted 17G.6F's "Billing logic ready" rename: per
// explicit instruction, "Ready for billing timeline" stays the platform's
// setup-readiness vocabulary "unless there is a deliberate platform-wide
// terminology decision elsewhere" — this pass makes that decision the
// other way. Everything else about this function is unchanged: still
// purely local to one component's own rule/source/input state, still
// never persisted, still never implies invoice-send readiness (that's
// describeInvoiceStatus below — a genuinely separate, cross-component
// concept, not renamed here).
export function describeComponentReadiness(params: {
  blockedDecisions: number
  hasUnconfiguredSource?: boolean
  hasUnconfiguredOperationalInput?: boolean
}): { state: ComponentReadiness; label: string } {
  const { blockedDecisions, hasUnconfiguredSource, hasUnconfiguredOperationalInput } = params
  if (blockedDecisions > 0 && hasUnconfiguredSource) {
    return { state: 'needs_commercial_decision_and_input_source', label: 'Needs commercial decision + input source' }
  }
  if (blockedDecisions > 0) {
    return { state: 'needs_commercial_decision', label: `Needs ${blockedDecisions} commercial decision${blockedDecisions === 1 ? '' : 's'}` }
  }
  if (hasUnconfiguredOperationalInput) {
    return { state: 'needs_operational_input_configuration', label: 'Needs operational input configuration' }
  }
  if (hasUnconfiguredSource) {
    return { state: 'needs_input_source', label: 'Needs input source' }
  }
  return { state: 'ready_for_billing_timeline', label: 'Ready for billing timeline' }
}

// Step 17G.6F, items 3/4/7 — a component's own commercial logic can be
// fully resolved (billing_logic_ready above) while its INVOICE still
// can't go out, because it shares a planned_invoices row with a fixed
// component whose own decision (Recurring fixed-fee timing) is still
// unresolved — verified in 17G.6E's direct scheduler audit: the
// fixedFeeDecision gate holds the ENTIRE combined row, not just the
// fixed-fee portion. This is a genuinely different axis from local
// billing-logic readiness — a component can be "Billing logic ready" AND
// "Blocked by upstream decision" at the same time, which is exactly the
// real Remembill case for Issued payment requests/Completed payments
// today. Deliberately not folded into describeComponentReadiness's own
// states (that function has no notion of another component's decisions
// at all — this one is explicitly cross-component).
export type InvoiceStatus = 'ready_for_invoice' | 'blocked_by_upstream_decision'

export function describeInvoiceStatus(hasUpstreamBlocker: boolean): { state: InvoiceStatus; label: string } {
  return hasUpstreamBlocker
    ? { state: 'blocked_by_upstream_decision', label: 'Blocked by upstream decision' }
    : { state: 'ready_for_invoice', label: 'Ready for invoice' }
}

// Step 17G.5B — the collapsed-row summary line for a component group
// ("Pilot · Discount · Volume adjustment · Billing timing"). Dynamically
// derived from whatever rows actually exist in that group — never a
// hard-coded component name or rule count. Capped so a component with
// many rules (item 12: "5-8 rules") still collapses to one compact line;
// the "+N more" suffix is itself computed from the real remaining count,
// never a guessed/rounded figure.
export function summarizeGroupRowLabels(labels: string[], max = 4): string {
  if (labels.length === 0) return ''
  if (labels.length <= max) return labels.join(' · ')
  return `${labels.slice(0, max).join(' · ')} +${labels.length - max} more`
}

// Step 17G.5B — purely VISUAL sub-grouping of rows already present inside
// one component's expanded detail (item 4: "lightweight subheadings...
// this is only visual grouping of existing rows"). Matched off each row's
// existing label text — introduces no new commercial semantics, no new
// data, and never changes which group (Platform subscription / a usage
// metric / Performance share / Credits & rebates) a row belongs to; that
// grouping stays exactly as 17G.5A computed it. A label this function
// doesn't recognize (Charging rule, Overage rule, Tier calculation
// method, Minimum commitment, Price escalation, every credit-row label)
// returns null — the general, un-subheaded bucket — rather than forcing
// it under a category it doesn't clearly belong to.
// Step 17G.6A — value is optionally consulted too, for a category that
// can only be recognized structurally rather than by a fixed label
// string: a "required input" row's label is the input's own (contract-
// specific) name — e.g. "Paid invoice value" — which can never be
// enumerated in advance, but its value always literally starts with
// "Source: " (see buildPerformanceComponents/lib/commercial-components.ts,
// item 5) — a stable, generic, structural signal that works for any
// future project/service/outcome-KPI mechanism, not a Remembill-specific
// label list.
export function ruleCategoryFor(label: string, value?: string): string | null {
  if (label === 'Pilot' || label === 'Discount') return 'Pricing / discount'
  // startsWith, not ===: the rolling-band rule now spans several rows
  // ("Volume adjustment", "Volume adjustment trigger"/"effect"/"history"/
  // "source" — lib/commercial-components.ts's buildFixedComponent), all of
  // which must group together under the same heading rather than the
  // trigger/effect/history/source rows falling through to the generic
  // section merely because they aren't byte-identical to the first row's
  // label.
  if (label.startsWith('Volume adjustment')) return 'Pricing adjustment'
  if (label === 'Partial-period treatment' || label === 'Billing-period treatment') return 'Period rules'
  // Step 17G.6F, items 3/4/8 — "Current billing treatment" -> "Billing
  // treatment" (controlled vocabulary); "Invoice status" (the new
  // cross-component Blocked-by-upstream-decision/Ready-for-invoice fact)
  // joins the same Timing bucket, right alongside the other timing/
  // dependency facts it explains the consequence of.
  if (label === 'Recurring fixed-fee timing' || label === 'Measurement' || label === 'Invoice timing'
    || label === 'Invoice composition' || label === 'Billing treatment' || label === 'Invoice status') return 'Timing'
  // Step 17G.6F, item 5 — "Calculation flow" (the new step-by-step
  // performance-share chain) sits with the rest of the calculation facts,
  // matching the item's own expected ordering (Performance measure /
  // Calculation / Charge basis / Rate selection / Calculation flow).
  if (label === 'Derived measure' || label === 'Charge basis' || label === 'Rate selection'
    || label === 'Calculation' || label === 'Calculation flow') return 'Calculation'
  // Step 17G.6C — the full contract measure -> billing metric -> source ->
  // consuming-rules chain, grouped together under one heading rather than
  // a bare "Source" (which used to collide visually with the row of the
  // same name — see CommercialLogicRow's own label).
  if (label === 'Contract measure' || label === 'Billing metric' || label === 'Configured source' || label === 'Used to calculate') return 'Usage billing mapping'
  if (value?.startsWith('Source: ')) return 'Required inputs'
  return null
}

export interface CategorizedRow { label: string; value?: string }
export interface RuleSection<T extends CategorizedRow> { name: string | null; rows: T[] }

// Splits a group's rows into named sections (in first-seen order) plus a
// trailing null-named "general" section for anything ruleCategoryFor
// doesn't recognize — never an empty section (item 4: "do not show an
// empty subheading").
export function sectionizeRows<T extends CategorizedRow>(rows: T[]): RuleSection<T>[] {
  const sections: RuleSection<T>[] = []
  const byName = new Map<string | null, RuleSection<T>>()
  for (const row of rows) {
    const name = ruleCategoryFor(row.label, row.value)
    let section = byName.get(name)
    if (!section) {
      section = { name, rows: [] }
      byName.set(name, section)
      sections.push(section)
    }
    section.rows.push(row)
  }
  // The general (unnamed) bucket always renders first, regardless of
  // where its rows first appeared, so a component's "headline" facts
  // (charging rule, tier method, ...) lead — named sub-groupings read as
  // secondary detail beneath them.
  const general = sections.find(s => s.name === null)
  const named = sections.filter(s => s.name !== null)
  return general ? [general, ...named] : named
}

// Step 17H.4B0D4H1B4E7 §2 — the component header used to summarize a
// group by dumping its own row LABELS (summarizeGroupRowLabels — "Charge
// basis · Rate selection · Partial-period treatment +7 more"), forcing a
// reviewer to read internal field names to understand what the mechanism
// even IS. lib/commercial-components.ts already computes exactly this as
// typed data — pricingModelLabel ("Fixed recurring," "Usage-based," …)
// and billingCadence — for every component, never re-derived here. This
// only joins two already-existing typed strings; it invents no new fact
// and reads nothing contract-specific.
export function buildComponentMechanismSummary(component: { pricingModelLabel: string; billingCadence: string | null }): string {
  return component.billingCadence
    ? `${component.pricingModelLabel} · ${component.billingCadence.toLowerCase()} billing`
    : component.pricingModelLabel
}

// Step 17H.4B0D4H1B4E7 §3 — the "commercial snapshot" grid: 2-4 of a
// component's most important economic facts, shown compactly before the
// detailed rule rows. Deliberately NOT a per-pricingModel allowlist of
// specific label strings (lib/commercial-components.ts's real row labels
// vary too much across fixed/usage/performance/one_time/credit components
// to enumerate safely, and doing so would risk silently producing an
// empty grid the moment a label changes) — instead reuses the SAME
// structural signal isLongFormValue already established: a short, scalar-
// shaped value (a count, a band range, a rate, a short status) reads as a
// "headline fact," while a long-form value (a sentence, a rule
// description) reads as a "rule to explain," never a snapshot fact. Only
// draws from the GENERAL (unnamed) section sectionizeRows already
// produces — a component's Timing/Calculation/... sections stay intact,
// never fragmented by pulling one of their rows out into the snapshot.
// decisionRequired rows are always excluded: an open question is not a
// settled economic fact, regardless of how short its "Decision required"
// value text is.
export function selectSnapshotRows<T extends { label: string; value: string; decisionRequired?: boolean }>(
  generalSectionRows: T[], max = 4,
): { snapshot: T[]; remaining: T[] } {
  const snapshot: T[] = []
  const remaining: T[] = []
  for (const row of generalSectionRows) {
    if (!row.decisionRequired && row.label && snapshot.length < max && !isLongFormValue(row.value)) {
      snapshot.push(row)
    } else {
      remaining.push(row)
    }
  }
  return { snapshot, remaining }
}
