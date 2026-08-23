// Deterministic, extraction-time grounding for OneTimeFee.billability_
// provenance — the Effective-Date fixed_date class ONLY, per the billability
// audit's explicit scoping. Every other billability class (contract_
// signature, customer_acceptance, final_acceptance, delivery, change_
// order_signature, immediate, and a literal (non-Effective-Date) fixed
// calendar date) is deliberately NOT handled here — each needs its own,
// separately-argued grounding case (some may never be safely groundable at
// all, e.g. 'immediate' — see lib/one-time-fee-billability-provenance's own
// module design discussion in the billability audit). Returning null for
// all of those is not a gap in this module — it's the module's actual,
// intended scope boundary; extending it is a deliberate, separate change.
//
// Mirrors lib/one-time-fee-provenance.ts's discipline exactly: never AI
// confidence, never model reasoning, never semantic similarity, never
// whole-contract inference — a small, pure check over THIS fee's own
// source_clause plus the already-validated canonical BillabilityCondition,
// cross-referenced against the agreement's own independently-extracted
// contract_start_date.
import type { OneTimeFee, BillabilityCondition } from './types'

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// Deliberately narrow, per the audit's explicit instruction not to accept
// a generic word like "start" alone — every phrase here requires enough
// surrounding context to be unambiguously about the AGREEMENT's own
// commencement, mirroring the exact vocabulary the extraction PROMPT
// itself already requires before the model may emit fixed_date(contract_
// start_date) in the first place (lib/contract-extractor.ts's
// billability_condition guidance: "Effective Date", "commencement",
// "contract start").
const EFFECTIVE_DATE_ANCHOR_RE = /\beffective date\b|\bcommencement date\b|\bcommencement\b|\bcontract start date\b|\bstart of the agreement\b/i

// Any of these appearing in the SAME fee's source_clause means a simple
// Effective-Date grounding is not deterministic — the clause states (or
// may state) an alternative/competing trigger, e.g. "billable on the
// Effective Date or upon Customer Acceptance." Deliberately conservative:
// presence alone is enough to refuse grounding, even if on a closer human
// reading the competing phrase turns out to be unrelated — a false
// negative (still reviewer-confirmed) is the safe failure mode, never a
// false positive.
const COMPETING_ANCHOR_RE = /\bcustomer acceptance\b|\bupon acceptance\b|\bupon delivery\b|\bupon completion\b|\bupon signing\b|\bupon execution\b|\bchange order\b|\bfinal acceptance\b/i

// The single deterministic gate for this pass's one supported class.
export function isEffectiveDateFixedDateGrounded(
  fee: Pick<OneTimeFee, 'source_clause'>,
  canonicalCondition: BillabilityCondition | null,
  contractStartDate: string | null | undefined,
): boolean {
  if (!fee.source_clause || !fee.source_clause.trim()) return false
  if (!canonicalCondition || canonicalCondition.kind !== 'fixed_date') return false
  if (!ISO_DATE_RE.test(canonicalCondition.date)) return false
  if (!contractStartDate || !ISO_DATE_RE.test(contractStartDate)) return false
  if (canonicalCondition.date !== contractStartDate) return false

  const text = fee.source_clause
  if (!EFFECTIVE_DATE_ANCHOR_RE.test(text)) return false
  if (COMPETING_ANCHOR_RE.test(text)) return false

  return true
}

// Thin wrapper returning the actual FieldProvenance value this module may
// mint — 'contract_derived' or null, never anything else (never
// 'reviewer_policy', exclusively lib/one-time-fee.ts's confirmedProvenance's
// job; never 'verdix_recommends'/'organization_rulebook', neither of which
// billability_provenance has a path to).
export function deriveOneTimeFeeBillabilityProvenance(
  fee: Pick<OneTimeFee, 'source_clause'>,
  canonicalCondition: BillabilityCondition | null,
  contractStartDate: string | null | undefined,
): 'contract_derived' | null {
  return isEffectiveDateFixedDateGrounded(fee, canonicalCondition, contractStartDate) ? 'contract_derived' : null
}
