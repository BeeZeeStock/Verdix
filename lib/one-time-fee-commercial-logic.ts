// Step 17H.3C3 — pure classification/billability-row logic for one-time
// fees, extracted out of app/(dashboard)/configure/[id]/page.tsx so it has
// direct unit-test coverage (that page has no render-test harness — see
// this session's established pattern of extracting page-local pure logic
// for exactly this reason: lib/commercial-components.ts, lib/billing-
// period-workspace.ts, etc.). Consumed by BOTH Commercial BoM's one-time
// line-item rows and Commercial Logic & Billing Setup's "One-time /
// project fees" / "Credits & adjustments" grouping — one classifier, one
// billability-resolution derivation, never two.
import { describeBillabilityCondition } from './billability-condition'
import { isOneTimeFeeBillabilityUnresolved } from './commercial-rule-status'
import type { BillabilityCondition, FieldProvenance } from './types'

export interface OneTimeFeeClassificationInput {
  amount: number
  // Deliberately accepted (real call sites pass a whole OneTimeFee) but
  // never read — see classifyOneTimeFeeKind's own comment for why label
  // text must never drive classification.
  fee_label?: string
}

// Step 17H.3C4 — WHAT-level commercial classification, sign only. The
// 17H.3C3 version classified positive fees into service/hardware/other via
// regex against fee_label — display-text inference, which the platform
// doctrine forbids ("business/domain classification must not be inferred
// from display-label text"). Audited end-to-end (lib/types.ts's
// OneTimeFee, the extraction prompt in lib/contract-extractor.ts, every
// persisted/derived one-time-fee field) and confirmed: no authoritative
// typed subtype (service/hardware/project/other) exists anywhere in this
// codebase for a one-time fee — extraction is never even asked to
// classify one this way (lib/contract-extractor.ts's one_time_fees schema
// has no subtype field at all). A negative amount remains a genuine,
// authoritative numeric fact (not label inference) and keeps its distinct
// treatment; every positive fee gets the same honest, generic label —
// the fee's own business-readable title (already shown alongside this)
// is the real identifying information, not a guessed subtype. If a real
// typed subtype is ever added end-to-end (extraction schema through
// persistence), this is the one place to start reading it — see item 3's
// hierarchy in the 17H.3C4 report for the exact preference order.
export function classifyOneTimeFeeKind(f: OneTimeFeeClassificationInput): string {
  return f.amount < 0 ? 'Credit / adjustment' : 'One-time / project fee'
}

export interface OneTimeFeeBillabilityInput {
  billability_condition?: BillabilityCondition | null
  billability_provenance?: FieldProvenance | null
  manual_trigger?: boolean
  unresolved_kind?: 'needs_review' | 'unsupported_semantics'
}

export type OneTimeFeeBillabilityRow =
  | { state: 'blocked'; value: 'Not supported by Verdix'; helperText: string }
  | { state: 'decision_required'; value: 'Decision required'; helperText: string }
  | { state: 'resolved'; value: string; provenanceValue: FieldProvenance | null | undefined }

// The three-way outcome Commercial Logic's "Billability" row renders,
// matching ReviewPanel's own established one-time-fee treatment exactly
// (same three states, same 'Manual billing' wording for a genuine legacy
// manual_trigger record — never the retired Products/Services & Pricing
// card's disagreeing "On delivery" fallback for that identical state).
// Deliberately returns only the CONTRACTUAL TRIGGER, never live evidence/
// execution status — that stays Billing Timeline's parked-invoice
// machinery's responsibility alone.
export function deriveOneTimeFeeBillabilityRow(f: OneTimeFeeBillabilityInput): OneTimeFeeBillabilityRow {
  if (f.unresolved_kind === 'unsupported_semantics') {
    return {
      state: 'blocked', value: 'Not supported by Verdix',
      helperText: 'This billability condition does not fit a supported contractual trigger — it stays blocked from billing. There is no confirmation that resolves it.',
    }
  }
  if (isOneTimeFeeBillabilityUnresolved(f)) {
    return { state: 'decision_required', value: 'Decision required', helperText: 'When does this fee become billable?' }
  }
  const genuineManualHold = f.billability_condition === undefined && !!f.manual_trigger
  const conditionLabel = describeBillabilityCondition(f.billability_condition ?? null)
  return {
    state: 'resolved',
    value: genuineManualHold ? 'Manual billing' : (conditionLabel ?? 'Needs review'),
    provenanceValue: f.billability_provenance ?? undefined,
  }
}
