// Contract B final fix — canonical commercial component classification.
//
// The problem this module exists to solve, proven empirically against the
// real Contract B job (b583f52c…): a credit's application_rule.
// eligible_component_keys is FREE TEXT produced by contract extraction
// (lib/rule-interpretation.ts never constrains it to a fixed vocabulary —
// the model writes whatever token best names the contract's own wording,
// e.g. 'transaction_processing_fees', 'platform_subscription_fees'). The
// runtime invoice component pool (app/api/admin/invoice-scheduler/route.ts)
// uses a DIFFERENT vocabulary: a hardcoded 'platform_fee' constant, plus
// each metered component's OPERATIONAL meter_key — an org-chosen,
// customer-specific string (Contract B's own transaction-processing meter
// is literally named 'sync'; its chargeback meter is 'sms_sent'). Matching
// these two vocabularies by raw string equality (the old
// filterEligibleComponents) silently never matches anything for any
// eligible_component_keys value beyond the exact literal 'platform_fee' /
// 'transaction_processing' / 'chargeback' a test fixture happened to
// choose — Contract B's real credits could never actually apply.
//
// The fix is a small, closed, canonical vocabulary — CommercialComponentClass
// — that BOTH sides resolve into before comparison, so eligibility is
// decided by commercial MEANING, never by incidental key equality:
//
//   contract's eligible_component_keys tokens  ─┐
//                                                 ├─> CommercialComponentClass ─> match
//   runtime pool component (key + contract_unit_type) ─┘
//
// Deliberately NOT solved by (a) collapsing everything into one generic
// list — earning basis (lib/credit-ledger-service.ts's basis_component/
// sumPaidComponentAmountForWindow) stays completely separate and untouched
// by this module; or (b) matching on the operational meter_key at all —
// see classifyContractUnitType's own comment for why.
export type CommercialComponentClass =
  | 'platform_fee'
  | 'transaction_processing'
  | 'chargeback'
  | 'one_time_fee'

const ALL_CLASSES: ReadonlySet<CommercialComponentClass> = new Set([
  'platform_fee', 'transaction_processing', 'chargeback', 'one_time_fee',
])

function normalize(token: string): string {
  return token.trim().toLowerCase()
}

// Known synonyms a credit's eligible_component_keys / excluded_component_keys
// may use for each canonical class. The short forms ('platform_fee',
// 'transaction_processing', 'chargeback') are this codebase's OWN
// pre-existing test/fixture vocabulary (lib/credit-ledger.test.ts,
// lib/credit-priority.test.ts) — included as identity entries so every
// already-passing test keeps matching exactly as before, with zero
// modification. The longer forms are what real extraction has been
// observed to produce for Contract B ('platform_subscription_fees',
// 'transaction_processing_fees', 'chargeback_fees'). Deliberately a small,
// explicit, EXACT-match table (after trim+lowercase normalization only) —
// no substring matching, no fuzzy matching, never a display label. Extend
// this table, never the matching logic, when a new synonym is observed in
// a real contract.
const SCOPE_TOKEN_ALIASES: Readonly<Record<string, CommercialComponentClass>> = {
  platform_fee: 'platform_fee',
  platform_fees: 'platform_fee',
  platform_subscription_fee: 'platform_fee',
  platform_subscription_fees: 'platform_fee',
  transaction_processing: 'transaction_processing',
  transaction_processing_fee: 'transaction_processing',
  transaction_processing_fees: 'transaction_processing',
  transaction_processing_charge: 'transaction_processing',
  transaction_processing_charges: 'transaction_processing',
  chargeback: 'chargeback',
  chargebacks: 'chargeback',
  chargeback_fee: 'chargeback',
  chargeback_fees: 'chargeback',
  one_time_fee: 'one_time_fee',
  one_time_fees: 'one_time_fee',
}

// Resolves ONE eligible_component_keys / excluded_component_keys token to
// its canonical class. Returns null for anything not in the known-synonym
// table — including genuinely unrecognized tokens ('taxes',
// 'previously_applied_credits', or any future novel extraction string) —
// so an unresolvable token can never accidentally grant eligibility (it
// simply contributes nothing to the matched class set) and can never
// accidentally exclude a component either. This is the fail-closed
// behavior for an unknown scope token: matches nothing, not everything.
export function resolveScopeTokenClass(token: string): CommercialComponentClass | null {
  return SCOPE_TOKEN_ALIASES[normalize(token)] ?? null
}

// contract_meter_mappings.contract_unit_type (equivalently
// contract_terms.overage_tiers[].unit_type — the same contract-derived
// value, duplicated across the two tables) -> canonical class. A SEPARATE
// alias table from SCOPE_TOKEN_ALIASES on purpose: this one bridges the
// CONTRACT's own description of what a meter measures into the same
// canonical space, and must NEVER be confused with — or fall back to —
// the org's operational meter_key. A customer is free to name their
// transaction-processing meter 'sync', 'txn_v2', or anything else; the
// commercial meaning ("this component represents transaction-processing
// charges") is carried entirely by contract_unit_type, which extraction
// derives from the CONTRACT text, not from however the org's systems
// happen to be wired. Keeping this resolver keyed off contract_unit_type
// (never meter_key) is what keeps operational meter identity and
// commercial component classification genuinely independent.
const CONTRACT_UNIT_TYPE_ALIASES: Readonly<Record<string, CommercialComponentClass>> = {
  'processed transaction': 'transaction_processing',
  'processed transactions': 'transaction_processing',
  transaction: 'transaction_processing',
  transactions: 'transaction_processing',
  'transaction processing': 'transaction_processing',
  chargeback: 'chargeback',
  chargebacks: 'chargeback',
}

export function classifyContractUnitType(contractUnitType: string | null | undefined): CommercialComponentClass | null {
  if (!contractUnitType) return null
  return CONTRACT_UNIT_TYPE_ALIASES[normalize(contractUnitType)] ?? null
}

// Every canonical class this module currently knows how to resolve, for
// callers that want to defensively validate a class value (e.g. tests).
export function isCommercialComponentClass(value: string): value is CommercialComponentClass {
  return ALL_CLASSES.has(value as CommercialComponentClass)
}
