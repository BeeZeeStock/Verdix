import { describe, it, expect } from 'vitest'
import { splitCompoundHeading, norm } from './PDFViewer'

// Regression, found while writing the compound-heading test below — a
// SEPARATE, independent bug in norm() itself: STRIP_RE previously had no
// `g` flag, so `s.replace(STRIP_RE, '')` only ever removed the FIRST
// matching whitespace/currency/hyphen character in the whole string,
// leaving every subsequent space intact. Any heading of more than two or
// three words normalized to a needle that still contained embedded spaces
// (e.g. "4.1 Account Setup Fee" -> "4.1account setup fee"), which could
// never match the window text (correctly fully space-stripped via the
// separate, always-correct normWithMap/.test() character loop) — silently
// forcing every multi-word heading through the "loose" fallback pass
// instead of ever succeeding on the strict pass it was meant for.
describe('norm — strips EVERY matching character, not just the first (regression)', () => {
  it('strips every space in a multi-word heading, not just the first', () => {
    expect(norm('4.1 Account Setup Fee')).toBe('4.1accountsetupfee')
  })

  it('strips every space across a long, real-world-length heading', () => {
    expect(norm('3.2 Transaction-processing fee - All-units monthly pricing')).toBe('3.2transactionprocessingfeeallunitsmonthlypricing')
  })

  it('strips every currency symbol and comma, not just the first', () => {
    expect(norm('SEK 15,000 and SEK 25,000')).toBe('sek15000andsek25000')
  })
})

// Regression: a section/field_sources value covering more than one clause
// (discounts/service_credits/one_time_fees with items from different
// headings) can arrive as a single, semicolon-joined compound string —
// e.g. "4.1 Account Setup Fee; 4.2 Security Onboarding Fee; 4.3
// Implementation Fee; 4.4 Optional Custom Connector" — because extraction
// records one field_sources value per FIELD, not per array item. Passing
// that whole string as one search needle to the PDF text matcher can never
// match real PDF text (the document has four separate headings, not one
// heading containing semicolons), so no Verdix marker was ever drawn and
// "View source clause" silently did nothing. This is the pure split the
// matcher now tries candidates from, one at a time, in order.
describe('splitCompoundHeading — PDF marker matching regression', () => {
  it('a plain single heading with no semicolon splits into exactly one segment, unchanged', () => {
    expect(splitCompoundHeading('1.1 Base Platform Fee')).toEqual(['1.1 Base Platform Fee'])
  })

  it('the exact Agreement A one-time-fees compound string splits into four independently-matchable headings', () => {
    const heading = '4.1 Account Setup Fee; 4.2 Security Onboarding Fee; 4.3 Implementation Fee; 4.4 Optional Custom Connector'
    expect(splitCompoundHeading(heading)).toEqual([
      '4.1 Account Setup Fee',
      '4.2 Security Onboarding Fee',
      '4.3 Implementation Fee',
      '4.4 Optional Custom Connector',
    ])
  })

  it('a heading whose own text contains a hyphen (not a semicolon) stays intact within its segment', () => {
    const heading = '3.2 Transaction-processing fee - All-units monthly pricing; 3.3 Monthly transaction-processing minimum; 3.4 Chargeback fee'
    expect(splitCompoundHeading(heading)).toEqual([
      '3.2 Transaction-processing fee - All-units monthly pricing',
      '3.3 Monthly transaction-processing minimum',
      '3.4 Chargeback fee',
    ])
  })

  it('trims whitespace around each segment (semicolon-space-separated, as extraction actually writes it)', () => {
    expect(splitCompoundHeading('1.3 Introductory Discount;   1.4 Service Credit  ')).toEqual([
      '1.3 Introductory Discount',
      '1.4 Service Credit',
    ])
  })

  it('drops empty segments from stray/trailing/double semicolons rather than producing a blank candidate', () => {
    expect(splitCompoundHeading('1.1 Base Platform Fee;;')).toEqual(['1.1 Base Platform Fee'])
    expect(splitCompoundHeading(';1.1 Base Platform Fee')).toEqual(['1.1 Base Platform Fee'])
  })

  it('an empty string produces no candidates at all', () => {
    expect(splitCompoundHeading('')).toEqual([])
  })

  // Real Agreement A data (contract_terms.field_sources.service_credits):
  // extraction joined all three service-credit headings with " / " instead
  // of ";" — the semicolon-only split left this as one, still-compound,
  // unmatchable string, so no marker was ever drawn for the Annual rebate,
  // Growth Credit, or SLA Service Credit cards specifically (reported after
  // the semicolon-only fix already shipped).
  it('the exact real Agreement A service-credits compound string (slash-separated) splits into three independently-matchable headings', () => {
    const heading = '6.1 Annual volume rebate / 6.2 Growth Credit / 6.3 SLA Service Credit'
    expect(splitCompoundHeading(heading)).toEqual([
      '6.1 Annual volume rebate',
      '6.2 Growth Credit',
      '6.3 SLA Service Credit',
    ])
  })

  it('trims whitespace around each segment for slash-separated headings too', () => {
    expect(splitCompoundHeading('1.3 Introductory Discount /   1.4 Service Credit  ')).toEqual([
      '1.3 Introductory Discount',
      '1.4 Service Credit',
    ])
  })

  it('a heading number itself (e.g. "6.1") is never split — only ";" and "/" are treated as item separators', () => {
    expect(splitCompoundHeading('6.1 Annual volume rebate')).toEqual(['6.1 Annual volume rebate'])
  })

  it('a mix of semicolon- and slash-separated segments in the same string splits on both', () => {
    expect(splitCompoundHeading('4.1 Account Setup Fee; 4.2 Security Onboarding Fee / 4.3 Implementation Fee')).toEqual([
      '4.1 Account Setup Fee',
      '4.2 Security Onboarding Fee',
      '4.3 Implementation Fee',
    ])
  })
})

// End-to-end proof, not just the split in isolation: pickMatch's own core
// check is `normalizedPdfText.includes(normalizedNeedle)` (see PDFViewer's
// pickMatch). This reproduces that exact check against a realistic
// approximation of how the four §4.1-4.4 headings actually appear in the
// PDF's text layer — as four separate lines, never concatenated with
// semicolons (semicolons are an artifact of field_sources bundling several
// extracted items' section references into one string, not real document
// text) — proving the reported symptom (no marker ever drawn) and that the
// fix (matching each split candidate independently) resolves it.
describe('compound heading vs. real PDF text — reproduces the reported "no marker drawn" bug and its fix', () => {
  const realizedPdfText = norm(
    '4.1 Account Setup Fee A one-time fee of SEK 15,000 is payable... ' +
    '4.2 Security Onboarding Fee A one-time fee of SEK 25,000 is payable... ' +
    '4.3 Implementation Fee A one-time fee of SEK 150,000 is payable... ' +
    '4.4 Optional Custom Connector Subject to a signed Change Order...',
  )
  const compoundHeading = '4.1 Account Setup Fee; 4.2 Security Onboarding Fee; 4.3 Implementation Fee; 4.4 Optional Custom Connector'

  it('the OLD behavior: the whole compound string as one needle never matches real PDF text (reproduces the bug)', () => {
    expect(realizedPdfText.includes(norm(compoundHeading))).toBe(false)
  })

  it('the FIX: at least one split candidate matches the real PDF text', () => {
    const candidates = splitCompoundHeading(compoundHeading)
    expect(candidates.some(c => realizedPdfText.includes(norm(c)))).toBe(true)
  })

  it('the FIX: specifically, the FIRST candidate ("4.1 Account Setup Fee") matches on its own — the exact heading a reviewer clicking the Account setup fee card expects to land on', () => {
    const candidates = splitCompoundHeading(compoundHeading)
    expect(realizedPdfText.includes(norm(candidates[0]))).toBe(true)
  })

  it('every one of the four individual headings matches independently, proving all four review cards (not just the first) resolve correctly', () => {
    const candidates = splitCompoundHeading(compoundHeading)
    expect(candidates).toHaveLength(4)
    for (const c of candidates) {
      expect(realizedPdfText.includes(norm(c))).toBe(true)
    }
  })
})

// Same end-to-end proof as above, but against the ACTUAL real Agreement A
// data (slash-separated, not semicolon-separated) — the specific case that
// motivated widening splitCompoundHeading to also split on "/".
describe('slash-separated compound heading vs. real PDF text — Agreement A service credits', () => {
  const realizedPdfText = norm(
    '6.1 Annual volume rebate If Customer exceeds 2,400,000 Processed Transactions during a Contract Year... ' +
    '6.2 Growth Credit Customer earns a one-time Growth Credit of SEK 120,000... ' +
    '6.3 SLA Service Credit If monthly Service Availability falls below 99.90%...',
  )
  const compoundHeading = '6.1 Annual volume rebate / 6.2 Growth Credit / 6.3 SLA Service Credit'

  it('the whole compound string as one needle never matches real PDF text (reproduces the reported bug)', () => {
    expect(realizedPdfText.includes(norm(compoundHeading))).toBe(false)
  })

  it('every one of the three individual headings matches independently — Annual rebate, Growth Credit, and SLA Service Credit cards all resolve to a real marker', () => {
    const candidates = splitCompoundHeading(compoundHeading)
    expect(candidates).toHaveLength(3)
    for (const c of candidates) {
      expect(realizedPdfText.includes(norm(c))).toBe(true)
    }
  })
})
