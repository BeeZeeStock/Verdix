// Step 17C.3a, item A — a raw extracted operational-input LABEL is free
// text the model chooses per-clause, never a durable identifier: two
// extraction passes over the same contract (or two different clauses
// describing the same underlying quantity) can produce paraphrases that
// read identically to a human — "total invoice value in payment requests"
// vs. "...of payment requests" vs. "...of issued requests" — but would
// otherwise resolve to three different storage keys, breaking a
// 17C.1/17C.2 typed config's own numerator_input_key/denominator_input_key/
// basis_input_key/aggregate.input_key resolution the moment extraction
// re-runs with slightly different wording.
//
// Hardened per 17C.3a's review: the ORIGINAL 17C.3 version applied generic
// heuristic transforms (any "in"/"for" token -> "of"; any "payment_requests"
// bigram -> "issued_requests") — a HEURISTIC is not adequate authority for a
// billing-execution key: it can silently collapse two genuinely different
// concepts that happen to share a connector word, and it can silently fail
// to collapse a real paraphrase the heuristic didn't anticipate. Neither
// failure mode is acceptable for a key that gates whether money moves.
//
// Replaced with a NARROW, EXPLICIT, CLOSED alias registry: only the exact,
// specific paraphrases this codebase has actually observed extraction
// produce are rewritten, each one individually enumerated below. Any label
// NOT in the registry is normalized SYNTACTICALLY ONLY (case/punctuation/
// whitespace) — never semantically rewritten. This means an unrelated key
// that happens to contain "in" or "for" (e.g. "payment_terms",
// "invoice_for_period") is passed through unchanged apart from slugifying,
// exactly preserving its own distinct identity rather than being silently
// merged into some other concept.
//
// Hardened AGAIN per 17C.3c's review: a live extraction produced a FIFTH
// real paraphrase — "total_invoice_value_of_issued_payment_requests" —
// that wasn't in the alias registry at the time. Because the compiler used
// to fall back to plain slugification for an unrecognized label, this
// still "worked" — it silently minted a BRAND NEW runtime input identity
// distinct from every earlier extraction's key. That is unsafe: a
// reviewer's operational_input_period_values entered under the earlier
// key becomes invisible to this one. Two functions now exist for two
// different jobs:
//   - canonicalizeOperationalInputKey: syntactic normalization + known-
//     alias rewrite, ALWAYS returns a string (never fails) — for display/
//     non-executable purposes and for cross-checking an already-resolved
//     key against a formula's own stated dependency list (see
//     lib/commercial-mechanism-compiler.ts).
//   - resolveRecognizedOperationalInputKey: the ONLY function permitted to
//     hand the compiler an execution-authoritative key. Returns a key ONLY
//     when the label resolves — via the canonical spelling itself or the
//     explicit alias registry — to one of a CLOSED set of recognized
//     operational-input concepts. An unrecognized label (any new paraphrase
//     not yet observed and registered) returns null — never a freshly
//     slugified "new identity" — so the compiler must leave the mechanism
//     Unsupported rather than mint one.
//
// The ORIGINAL extracted wording is preserved separately for display/
// provenance by construction: neither function is ever applied to
// required_operational_inputs/derived_metric.raw_inputs (the "Depends on:"
// display list, lib/operational-data-inputs.ts) to REWRITE them — only
// lib/commercial-mechanism-compiler.ts calls resolveRecognizedOperational
// InputKey, and only when resolving the EXPLICIT numerator_input_key/
// denominator_input_key/charge_basis_input_key/rolling_input_key fields
// into the typed config's own runtime keys. source_clause/formula/
// description (never touched by either function) remain the full-fidelity
// record of what the contract actually said.

// Closed, explicitly enumerated: syntactically-normalized (slugified) raw
// label -> canonical runtime key. Every entry is a SPECIFIC, individually
// justified paraphrase, not a rule that could fire on unrelated input.
// Extend this table only when a new real paraphrase is actually observed —
// never generalize it into a pattern/regex.
const OPERATIONAL_INPUT_KEY_ALIASES: Record<string, string> = {
  total_invoice_value_in_payment_requests: 'total_invoice_value_of_issued_requests',
  total_invoice_value_of_payment_requests: 'total_invoice_value_of_issued_requests',
  total_invoice_value_in_issued_payment_requests: 'total_invoice_value_of_issued_requests',
  // Step 17C.3c — observed in a live extraction (2026-08-28), not
  // previously registered; see this file's header for why an unregistered
  // paraphrase must fail closed rather than silently mint a new identity.
  total_invoice_value_of_issued_payment_requests: 'total_invoice_value_of_issued_requests',
  total_invoice_value_of_issued_requests: 'total_invoice_value_of_issued_requests',
  // Step 17F.1 — the real Remembill job (a4459e99) was extracted before
  // additional_recurring_fees/overage_tiers.semantic_input_key existed in
  // the extraction prompt (commit 3c1fe52b7, 2026-08-28 16:24, ~2 hours
  // after this job's own extraction at 14:41 the same day — confirmed via
  // git blame, not guessed). Its real stored metric_name/unit_type values
  // are "issued_payment_request"/"payment request"/"completed_payment" —
  // each an individually observed, real paraphrase of a recognized
  // concept (the missing "_count" suffix, and unit_type's missing
  // "issued_" prefix), registered here the same way every other entry in
  // this table was: a specific paraphrase actually seen, not a generic
  // pattern. Used by lib/semantic-input-key-reconciliation.ts to resolve
  // ALREADY-STORED metric_name/unit_type (a controlled, extraction-typed
  // field describing the counted unit — never fee_label/tier_label free
  // text) into the canonical key a pre-17D.1 contract's fee/tier never
  // received directly.
  issued_payment_request: 'issued_payment_request_count',
  payment_request: 'issued_payment_request_count',
  completed_payment: 'completed_payment_count',
}

// Step 17C.3c, item 2 — the CLOSED set of operational-input concepts this
// codebase's compiled 17C.1/17C.2 configs are actually allowed to
// reference as an execution key. Every OPERATIONAL_INPUT_KEY_ALIASES entry
// above resolves to a member of this set; the set also includes each
// concept's own canonical spelling (an extraction that already states the
// canonical form directly needs no alias entry). Extend this only when a
// NEW mechanism/operand is deliberately added to the compiler — never as a
// side effect of an extraction merely mentioning a new-looking label.
const RECOGNIZED_CANONICAL_OPERATIONAL_INPUT_KEYS = new Set<string>([
  'paid_invoice_value',
  'total_invoice_value_of_issued_requests',
  'issued_payment_request_count',
  // Step 17D — the €0.38 per-unit fee's sibling €1.70 success fee depends
  // on this same countable concept; recognized here so both
  // lib/usage-quantity-resolver.ts (meter/manual source matching) and any
  // future compiled execution config can resolve it consistently.
  'completed_payment_count',
])

function slugify(rawLabel: string): string {
  return rawLabel
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

// Lenient — ALWAYS returns a string, never fails. For display/non-
// executable purposes (and for cross-checking an already-resolved,
// strictly-validated key against a formula's own raw_inputs list) only.
// Never call this to produce a value that will itself become a NEW
// execution-authoritative key — see resolveRecognizedOperationalInputKey.
export function canonicalizeOperationalInputKey(rawLabel: string): string {
  const slug = slugify(rawLabel)
  return OPERATIONAL_INPUT_KEY_ALIASES[slug] ?? slug
}

// Step 17C.3c, item 2 — the ONLY function permitted to hand
// lib/commercial-mechanism-compiler.ts an execution-authoritative
// operational-input key. Unlike canonicalizeOperationalInputKey above,
// this can and does fail (returns null) for a label that resolves to
// neither a recognized canonical spelling nor a registered alias — an
// unrecognized paraphrase must never silently become a brand new runtime
// input identity (see this file's header for the live incident this
// fixes: "total_invoice_value_of_issued_payment_requests" would otherwise
// have minted its own identity, orphaning data already recorded under an
// earlier extraction's key).
export function resolveRecognizedOperationalInputKey(rawLabel: string): string | null {
  const slug = slugify(rawLabel)
  if (RECOGNIZED_CANONICAL_OPERATIONAL_INPUT_KEYS.has(slug)) return slug
  const aliased = OPERATIONAL_INPUT_KEY_ALIASES[slug]
  return aliased && RECOGNIZED_CANONICAL_OPERATIONAL_INPUT_KEYS.has(aliased) ? aliased : null
}

// Step 17C.3a, item B/C — "canonicalizes successfully" means the result is
// a non-empty, well-formed key, not merely that the function returned
// without throwing (it never throws). A raw label that is empty/pure
// punctuation/whitespace slugifies to an empty string, which can never be
// a valid runtime key. Kept as a general-purpose well-formedness check —
// resolveRecognizedOperationalInputKey above no longer needs it (a
// non-null result is, by construction, always a member of the recognized
// set and therefore already well-formed), but it remains available for
// any other syntactic-validity use.
export function isValidCanonicalKey(key: string): boolean {
  return /^[a-z0-9]+(_[a-z0-9]+)*$/.test(key)
}
