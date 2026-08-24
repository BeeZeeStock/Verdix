// Deterministic, extraction-time grounding for OneTimeFee.billability_
// provenance. Two classes handled today, per two separate audit passes:
//   A. Effective-Date fixed_date (original pass)
//   B. Customer Acceptance event (this amendment)
// Every other billability class (contract_signature, final_acceptance,
// delivery, change_order_signature, immediate, and a literal non-Effective-
// Date fixed calendar date) is deliberately NOT handled here — each needs
// its own, separately-argued grounding case (some may never be safely
// groundable at all, e.g. 'immediate'). Returning null for all of those is
// not a gap in this module — it's the module's actual, intended scope
// boundary; extending it is a deliberate, separate change each time.
//
// Mirrors lib/one-time-fee-provenance.ts's discipline exactly: never AI
// confidence, never model reasoning, never semantic similarity, never
// whole-contract inference — a small, pure check over THIS fee's own
// source_clause plus the already-validated canonical BillabilityCondition,
// cross-referenced (class A) against the agreement's own independently-
// extracted contract_start_date.
//
// Interpretation vs. evidence — this module answers ONLY "does the
// contract text deterministically establish WHAT event/date makes this fee
// billable." It says nothing about WHETHER that event has occurred — that
// remains lib/operational-event-evidence.ts's exclusive concern, gated
// separately (lib/commercial-rule-status.ts's RequiredOperationalEvent
// MissingBlocker), and is neither read nor written here. Grounding class B
// to contract_derived can never make a manual_trigger:true event fee
// executable on its own — lib/billability-condition.ts's
// getBillabilityExecutionCapability structurally returns
// executable:false for every 'event' kind regardless of provenance.
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

// ── Class B: Customer Acceptance event ──────────────────────────────────
//
// Positive requirement (item 4) — a billing-effect verb, optionally
// softened by a small, CLOSED set of qualifying adverbs (deliberately never
// a generic \w+/"any word" filler — that could silently absorb a negation
// like "NOT" as if it were harmless filler wording), a connector, then the
// literal phrase "Customer Acceptance". This deliberately does NOT match
// bare "Customer Acceptance" appearing anywhere in the clause (item 4's
// "do not ground merely because the phrase appears somewhere") — the text
// must itself state the billing-TRIGGER relationship. The optional
// defining sentence Contract B also has ("Customer Acceptance occurs
// when...") is real supporting evidence when present, but per item 5 is
// never required — this pattern alone is sufficient.
//
// Known, accepted limitation: this does not detect a negation immediately
// before the billing verb (e.g. a contrived "shall NOT be billable upon
// Customer Acceptance") — deliberately not guarded against, since building
// negation detection here would be exactly the "large NLP engine" this
// pass is explicitly told not to build, for a construction that does not
// occur in ordinary contract drafting Verdix has ever seen.
const CUSTOMER_ACCEPTANCE_BILLING_TRIGGER_RE =
  /\b(?:billable|payable|due|invoiced|billed)\b(?:\s+(?:only|solely|strictly|directly)){0,2}\s+(?:upon|after|on|following)\s+customer acceptance\b/i

// A DIFFERENT known billability anchor stated via the SAME billing-verb +
// connector construction, ANYWHERE in the fee's own source_clause — a
// genuine second, independently-stated positive trigger. Item 8's critical
// requirement: this must NOT fire on Contract B's own exclusionary
// sentence ("Supplier delivery... does not by itself constitute Customer
// Acceptance") — and it doesn't, by construction: that sentence has no
// billing verb (billable/payable/due/invoiced/billed) immediately before
// "delivery" at all ("Supplier delivery" — "Supplier" precedes it, not a
// billing verb), so this pattern, which requires the verb+connector+anchor
// SHAPE (not bare word presence), simply never matches it. A naive
// `source.includes('delivery')` check would have wrongly rejected Contract
// B's own strongest grounded example — deliberately not built that way.
const COMPETING_BILLING_TRIGGER_RE =
  /\b(?:billable|payable|due|invoiced|billed)\b(?:\s+(?:only|solely|strictly|directly)){0,2}\s+(?:upon|after|on|following)\s+(?:delivery|signing|execution|the effective date|final acceptance|a signed change order|change order)\b/i

// A strong, deterministic marker of an explicit multi-trigger alternation
// clause — safe to treat as disqualifying wherever it appears in the fee's
// own source_clause, regardless of proximity to the positive match.
const ALTERNATION_MARKER_RE = /\bwhichever (?:occurs|comes) first\b|\bwhichever is earlier\b|\bwhichever is later\b/i

// A bare "or" appearing in the SAME SENTENCE as (and after) the positive
// billing-trigger match — e.g. "billable upon Customer Acceptance or
// production go-live" — is treated as an alternation regardless of what
// follows "or"; deliberately conservative (item 6: "do not try to resolve
// precedence between multiple triggers in this pass"). Scoped to the
// current sentence (up to the next '.'/';'/newline) specifically so a
// LATER, separate sentence's own "or" (e.g. Contract B's own "Supplier
// delivery, test completion, or project-manager email...") is never
// inspected by this check at all.
function hasSameSentenceAlternation(text: string, matchEndIndex: number): boolean {
  const rest = text.slice(matchEndIndex)
  const sentenceEndIdx = rest.search(/[.;\n]/)
  const sameSentence = sentenceEndIdx === -1 ? rest : rest.slice(0, sentenceEndIdx)
  return /\bor\b/i.test(sameSentence)
}

export function isCustomerAcceptanceEventGrounded(
  fee: Pick<OneTimeFee, 'source_clause'>,
  canonicalCondition: BillabilityCondition | null,
): boolean {
  if (!fee.source_clause || !fee.source_clause.trim()) return false
  if (!canonicalCondition || canonicalCondition.kind !== 'event') return false
  if (canonicalCondition.event_type !== 'customer_acceptance') return false

  const text = fee.source_clause
  const match = CUSTOMER_ACCEPTANCE_BILLING_TRIGGER_RE.exec(text)
  if (!match) return false
  if (hasSameSentenceAlternation(text, match.index + match[0].length)) return false
  if (ALTERNATION_MARKER_RE.test(text)) return false
  if (COMPETING_BILLING_TRIGGER_RE.test(text)) return false

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
  if (isEffectiveDateFixedDateGrounded(fee, canonicalCondition, contractStartDate)) return 'contract_derived'
  if (isCustomerAcceptanceEventGrounded(fee, canonicalCondition)) return 'contract_derived'
  return null
}
