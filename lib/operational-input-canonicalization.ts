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
// The ORIGINAL extracted wording is preserved separately for display/
// provenance by construction: this function is never applied to
// required_operational_inputs/derived_metric.raw_inputs (the "Depends on:"
// display list, lib/operational-data-inputs.ts) — only
// lib/commercial-mechanism-compiler.ts calls it, and only when resolving
// the EXPLICIT numerator_input_key/denominator_input_key/
// charge_basis_input_key/rolling_input_key fields into the typed config's
// own runtime keys. source_clause/description (never touched by this
// function at all) remain the full-fidelity record of what the contract
// actually said.

// Closed, explicitly enumerated: syntactically-normalized (slugified) raw
// label -> canonical runtime key. Every entry is a SPECIFIC, individually
// justified paraphrase, not a rule that could fire on unrelated input.
// Extend this table only when a new real paraphrase is actually observed —
// never generalize it into a pattern/regex.
const OPERATIONAL_INPUT_KEY_ALIASES: Record<string, string> = {
  total_invoice_value_in_payment_requests: 'total_invoice_value_of_issued_requests',
  total_invoice_value_of_payment_requests: 'total_invoice_value_of_issued_requests',
  total_invoice_value_in_issued_payment_requests: 'total_invoice_value_of_issued_requests',
  total_invoice_value_of_issued_requests: 'total_invoice_value_of_issued_requests',
}

function slugify(rawLabel: string): string {
  return rawLabel
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

export function canonicalizeOperationalInputKey(rawLabel: string): string {
  const slug = slugify(rawLabel)
  return OPERATIONAL_INPUT_KEY_ALIASES[slug] ?? slug
}

// Step 17C.3a, item B/C — "canonicalizes successfully" means the result is
// a non-empty, well-formed key, not merely that the function returned
// without throwing (it never throws). A raw label that is empty/pure
// punctuation/whitespace slugifies to an empty string, which can never be
// a valid runtime key — the compiler treats that exactly like a missing
// field (fail closed), never an accidental valid-looking key.
export function isValidCanonicalKey(key: string): boolean {
  return /^[a-z0-9]+(_[a-z0-9]+)*$/.test(key)
}
