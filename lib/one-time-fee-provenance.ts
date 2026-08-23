// Deterministic, extraction-time grounding for OneTimeFee.amount_provenance.
//
// Contract B acceptance finding: a one-time fee whose amount is stated
// explicitly and unambiguously in the contract text ("Customer will pay a
// one-time launch fee of SEK 20,000") was always starting at
// amount_provenance: null — the same "no source-grounding signal exists"
// treatment as billability, which genuinely IS often unstated. A reviewer
// merely confirming an explicit contractual fact then minted reviewer_policy
// (lib/one-time-fee.ts's confirmedProvenance falls through to reviewer_
// policy whenever the existing value isn't already contract_derived) — that
// function itself is correct (it never downgrades an existing contract_
// derived value); the gap was that contract_derived was never assigned in
// the first place.
//
// This module is the narrow fix: a small, pure, deterministic check —
// never AI confidence, never model reasoning, never semantic similarity —
// over the fee's OWN source_clause text (never the whole contract), scoped
// to exactly the amount dimension. Billability grounding is a separate,
// not-yet-built audit (deliberately out of scope here — see lib/contract-
// extractor.ts's flagAmbiguousOneTimeFees, which still treats billability_
// provenance exactly as it did before this module existed).
//
// Required, all of them, before amount_provenance may become contract_
// derived:
//   1. There is a source_clause for THIS fee at all (per-fee, per Contract
//      B's "same one-time fee / source clause" requirement — a different
//      fee's source_clause is never consulted).
//   2. The clause contains at least one explicit currency-tagged monetary
//      amount whose currency resolves to the agreement's own currency.
//   3. Every such currency-matching amount has EXACTLY ONE plausible
//      normalized numeric reading (see parseAmountCandidates), AND that
//      one reading equals the already-extracted fee.amount exactly. A
//      token with more than one plausible reading (e.g. "20,50" — could be
//      2,050 thousands-grouped or 20.50 decimal) is never grounding, even
//      when one of its candidates happens to equal fee.amount — matching
//      by coincidence is not the same as the text deterministically
//      stating the number, and this module never picks a winner among
//      ambiguous candidates.
// Any currency-matching amount in the clause that does NOT equal fee.amount
// — a genuinely different figure, or one leg of a stated range — fails
// condition 3 and the whole fee falls back to null, deliberately: a range
// or a conflicting restatement is not grounding, it's the clause itself
// being unresolved about the number.
import type { OneTimeFee } from './types'

// Currencies this product actually issues invoices in today (Stripe/
// Remembill connectors — see lib/connectors/billing/types.ts and lib/
// billing-writer.ts's Remembill SEK-only gate) plus the common EU/UK/US
// set — a small, explicit allowlist, not an attempt to recognize every
// ISO 4217 code. The agreement's own currency is always added at call time
// even if it falls outside this list, so an unusual but real agreement
// currency is still recognized.
const KNOWN_CURRENCY_CODES = ['SEK', 'EUR', 'USD', 'GBP', 'NOK', 'DKK'] as const

// Deliberately small and unambiguous — "kr" alone is excluded because it's
// genuinely ambiguous across SEK/NOK/DKK (never guess which).
const CURRENCY_SYMBOL_TO_CODE: Record<string, string> = { '$': 'USD', '€': 'EUR', '£': 'GBP' }

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function currencyTokenPattern(agreementCurrency: string | null | undefined): string {
  const codes = new Set<string>(KNOWN_CURRENCY_CODES)
  if (agreementCurrency && /^[A-Za-z]{3}$/.test(agreementCurrency)) codes.add(agreementCurrency.toUpperCase())
  const codeAlt = `\\b(?:${[...codes].join('|')})\\b`
  const symbolAlt = Object.keys(CURRENCY_SYMBOL_TO_CODE).map(escapeRegExp).join('|')
  return `(?:${codeAlt}|${symbolAlt})`
}

function resolveCurrencyCode(token: string): string {
  return CURRENCY_SYMBOL_TO_CODE[token] ?? token.toUpperCase()
}

// A run of digits and separators (comma, dot, space, NBSP) — deliberately
// does not try to resolve grouping-vs-decimal itself here; that ambiguity
// is resolved once, centrally, by parseAmountCandidates below.
const NUMBER_TOKEN = '\\d[\\d.,\\s\\u00A0]*\\d|\\d'

export interface ExplicitAmountMatch {
  currencyToken: string
  numberRaw: string
}

// Finds every "currency + number" or "number + currency" pair in `text`,
// in either order (contracts use both — "SEK 20,000" and "20,000 SEK").
// A bare number with no adjacent currency marker is never returned — an
// explicit MONETARY amount requires the currency to actually be stated,
// not inferred from context.
export function findExplicitAmounts(text: string, agreementCurrency: string | null | undefined): ExplicitAmountMatch[] {
  const currencyPat = currencyTokenPattern(agreementCurrency)
  const re = new RegExp(`(${currencyPat})\\s*(${NUMBER_TOKEN})|(${NUMBER_TOKEN})\\s*(${currencyPat})`, 'gi')
  const out: ExplicitAmountMatch[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m[1] !== undefined && m[2] !== undefined) out.push({ currencyToken: m[1], numberRaw: m[2] })
    else if (m[3] !== undefined && m[4] !== undefined) out.push({ currencyToken: m[4], numberRaw: m[3] })
  }
  return out
}

// Normalizes a raw digit-and-separator run into every numerically
// plausible reading, since the separator convention (comma vs. dot vs.
// space as thousands grouping vs. decimal point) varies by contract and
// this function has no access to the document-wide number_format signal.
// Returns candidates, not a single answer — the caller only needs to know
// whether the ALREADY-EXTRACTED amount is among the plausible readings of
// this text, not which single reading is "the" correct one.
//   "20,000" / "20.000" / "20 000"  -> [20000]                  (thousands grouping, no decimal)
//   "20,50"  / "20.50"              -> [2050, 20.5]             (ambiguous: grouping OR decimal)
//   "20000"                          -> [20000]
export function parseAmountCandidates(raw: string): number[] {
  const trimmed = raw.trim()
  const candidates = new Set<number>()

  const strippedAllSeparators = trimmed.replace(/[.,\s ]/g, '')
  if (/^\d+$/.test(strippedAllSeparators)) candidates.add(Number(strippedAllSeparators))

  // Trailing 1-2 digit group after a final separator is plausibly a decimal
  // remainder (never 3, which is always a thousands group per every
  // notation this product's contracts use).
  const decimalMatch = trimmed.match(/^([\d.,\s ]*?)[.,](\d{1,2})$/)
  if (decimalMatch) {
    const intPart = decimalMatch[1].replace(/[.,\s ]/g, '')
    if (intPart === '' || /^\d+$/.test(intPart)) {
      const val = Number(`${intPart || '0'}.${decimalMatch[2]}`)
      if (!Number.isNaN(val)) candidates.add(val)
    }
  }

  return [...candidates]
}

// The single deterministic gate. Never true for a fee whose source_clause
// is missing/blank, whose clause states no amount in the agreement's own
// currency, or where any in-currency stated amount disagrees with the
// already-extracted fee.amount (a range, a correction, a different fee's
// figure that leaked into the clause — all fail closed to false/null,
// exactly as the conservative-fallback examples require).
//
// Final amendment — deterministic grounding requires each in-currency
// token to itself have exactly ONE plausible normalized reading, not
// merely a reading that happens to match fee.amount. parseAmountCandidates
// can return more than one candidate when the separator convention is
// genuinely ambiguous without document-wide number_format context (e.g.
// "20,50" -> [2050, 20.5] — could be a thousands-grouped 2,050 or a
// decimal 20.50). Grounding on "the extracted amount is ONE of several
// plausible readings" would not actually be grounding — it would be
// picking whichever interpretation happens to agree, which is exactly the
// kind of guess this module exists to refuse. A token only counts as
// deterministically stated when parsing it yields a single unambiguous
// number, no locale inference performed to disambiguate further.
export function isOneTimeFeeAmountExplicitlyGrounded(
  fee: Pick<OneTimeFee, 'amount' | 'source_clause'>,
  agreementCurrency: string | null | undefined,
): boolean {
  if (!(fee.amount > 0)) return false
  if (!fee.source_clause || !fee.source_clause.trim()) return false
  if (!agreementCurrency) return false

  const matches = findExplicitAmounts(fee.source_clause, agreementCurrency)
  const inCurrency = matches.filter(m => resolveCurrencyCode(m.currencyToken) === agreementCurrency.toUpperCase())
  if (inCurrency.length === 0) return false

  return inCurrency.every(m => {
    const candidates = parseAmountCandidates(m.numberRaw)
    return candidates.length === 1 && candidates[0] === fee.amount
  })
}

// Thin wrapper returning the actual FieldProvenance value this module is
// allowed to mint — 'contract_derived' or null, never anything else (never
// 'reviewer_policy', which is exclusively lib/one-time-fee.ts's
// confirmedProvenance's job, and never 'verdix_recommends'/'organization_
// rulebook', neither of which this field has a path to).
export function deriveOneTimeFeeAmountProvenance(
  fee: Pick<OneTimeFee, 'amount' | 'source_clause'>,
  agreementCurrency: string | null | undefined,
): 'contract_derived' | null {
  return isOneTimeFeeAmountExplicitlyGrounded(fee, agreementCurrency) ? 'contract_derived' : null
}
