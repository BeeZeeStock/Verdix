import nlp from 'compromise'

// ── Entity types ──────────────────────────────────────────────────────────────

export type PIIEntityType =
  | 'PERSON'
  | 'ORG'
  | 'EMAIL'
  | 'PHONE'
  | 'IBAN'
  | 'VAT_NUMBER'
  | 'ADDRESS'

export interface PIIEntity {
  type:       PIIEntityType
  value:      string       // original text as it appeared
  token:      string       // replacement token e.g. [PERSON_1]
  confidence: number       // 0–100
  source:     'regex' | 'nlp' | 'context_pattern'
}

export interface PIIDetectionResult {
  entities:   PIIEntity[]
  tokenMap:   Map<string, string>   // original → token (for masking)
  reverseMap: Map<string, string>   // token → original (for restore)
}

// ── Legal-form suffixes that signal a company name ────────────────────────────

const COMPANY_SUFFIXES = [
  // English
  'Ltd', 'Limited', 'Inc', 'LLC', 'LLP', 'PLC', 'Corp', 'Corporation',
  // Nordic
  'AB', 'AS', 'ASA', 'ApS', 'Oy', 'Oyj', 'HB', 'KB', 'DA',
  // German/Dutch/French/Spanish
  'GmbH', 'AG', 'KG', 'OHG', 'BV', 'NV', 'VOF', 'SARL', 'SAS', 'SL',
  // Italian/Portuguese
  'SRL', 'SpA', 'Lda',
  // Eastern European
  'sro',
]

// Match: 1–5 properly title-cased words, then a legal suffix.
// Restricting the name part to capitalized words prevents "This Agreement ... Corp" matches.
// The name segment allows &, -, ' between words but not full sentences.
const SUFFIX_ALT = COMPANY_SUFFIXES.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
const COMPANY_SUFFIX_RE = new RegExp(
  `\\b([A-ZÀ-Ö][a-zA-ZÀ-ÿ'-]+(?:\\s+(?:&|and|of|the|[A-ZÀ-Ö][a-zA-ZÀ-ÿ'-]+)){0,4})\\s+(${SUFFIX_ALT})\\b`,
  'g'
)

// ── Context patterns for person names ────────────────────────────────────────

// Name segment: 1 capital word + 1–3 more capital words, all on the same line (no \n)
const NAME_SEG = `([A-ZÀ-Ö][a-záéíóúàèìòùäëïöüñç'-]+(?:[ ][A-ZÀ-Ö][a-záéíóúàèìòùäëïöüñç'-]+){1,3})`

const PERSON_CONTEXT_PATTERNS = [
  // "signed by John Smith" / "represented by ..."
  new RegExp(`\\b(?:signed by|represented by|executed by|authorized by)\\s+${NAME_SEG}`, 'gi'),
  // "on behalf of <ORG> by <Person>" — name after "by" only
  new RegExp(`on behalf of[^,\\n]{0,60}\\bby\\s+${NAME_SEG}`, 'gi'),
  // "signatory: Name" / "billing contact: Name" / "attn: Name"
  new RegExp(`\\b(?:signatory|billing contact|contact|attention|attn)\\s*[:\\-]\\s*${NAME_SEG}`, 'gi'),
  // Field label "Name: John Smith"
  new RegExp(`^(?:Name|Full Name)\\s*[:\\-]\\s*${NAME_SEG}`, 'gim'),
  // Role label "CEO John Smith"
  new RegExp(`\\b(?:Director|CEO|CFO|CTO|COO|VP|Manager|Officer)\\s*[:\\-,]?\\s+${NAME_SEG}`, 'g'),
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCounter(): (type: PIIEntityType) => string {
  const counts: Partial<Record<PIIEntityType, number>> = {}
  return (type) => {
    counts[type] = (counts[type] ?? 0) + 1
    return `[${type}_${counts[type]}]`
  }
}

function dedupKey(value: string): string {
  return value
    .trim()
    .replace(/[.,;:()"'\s]+$/g, '')  // strip trailing punctuation
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

// Replace all known entities in `text` to prevent subsequent passes from
// re-matching substrings of already-found values.
function applyTokenMap(text: string, tokenMap: Map<string, string>): string {
  let result = text
  const sorted = [...tokenMap.entries()].sort((a, b) => b[0].length - a[0].length)
  for (const [original, token] of sorted) {
    result = result.split(original).join(token)
  }
  return result
}

// ── Main detection function ───────────────────────────────────────────────────

export function detectPII(text: string): PIIDetectionResult {
  const entities:   PIIEntity[]         = []
  const tokenMap:   Map<string, string> = new Map()
  const reverseMap: Map<string, string> = new Map()
  const seen:       Set<string>         = new Set()
  const nextToken = makeCounter()

  function addEntity(type: PIIEntityType, value: string, confidence: number, source: PIIEntity['source']) {
    const trimmed = value.trim()
    if (!trimmed) return
    const key = dedupKey(trimmed)
    if (seen.has(key)) return
    seen.add(key)

    const token = nextToken(type)
    entities.push({ type, value: trimmed, token, confidence, source })
    tokenMap.set(trimmed, token)
    reverseMap.set(token, trimmed)
  }

  // ── Pass 1: Email (most specific, run first) ──────────────────────────────
  const emailRe = /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g
  let m: RegExpExecArray | null
  while ((m = emailRe.exec(text)) !== null) addEntity('EMAIL', m[0], 100, 'regex')

  // ── Pass 2: IBAN (long specific pattern — before VAT/phone to prevent substring matches) ──
  // Matches both compact (SE4550000000...) and grouped (SE45 5000 0000 ...) formats.
  let workingText = applyTokenMap(text, tokenMap)
  const ibanRe = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){4,7}\b/g
  while ((m = ibanRe.exec(workingText)) !== null) addEntity('IBAN', m[0], 100, 'regex')

  // ── Pass 3: VAT numbers (run on text already masked of IBANs) ────────────
  workingText = applyTokenMap(text, tokenMap)
  const vatRe = /\b(?:VAT\s*(?:No\.?\s*)?)?(?:SE|GB|DE|FR|NL|DK|NO|FI|PL|IT|ES|AT|BE|CZ|HU|IE|PT)\s*\d[\d\s]{6,12}\d\b/g
  while ((m = vatRe.exec(workingText)) !== null) addEntity('VAT_NUMBER', m[0], 95, 'regex')

  // ── Pass 4: Phone — only high-confidence patterns to avoid false positives ─
  // Strategy: only match if there's a leading + (international) OR a context label.
  // Ambiguous digit strings (contract IDs, amounts, dates) are left unmasked.
  workingText = applyTokenMap(text, tokenMap)
  // International format: +XX or +XXX followed by digit groups
  const intlPhoneRe = /\+\d{1,3}[\s\-.]?\(?\d{1,4}\)?(?:[\s\-.]?\d{2,6}){1,4}/g
  while ((m = intlPhoneRe.exec(workingText)) !== null) addEntity('PHONE', m[0], 95, 'regex')
  // Context-labelled: "Tel: ..." / "Phone: ..." / "Mobile: ..."
  workingText = applyTokenMap(text, tokenMap)
  const labelledPhoneRe = /\b(?:tel|phone|mobile|mob|fax|cell)\s*[:\-]?\s*([\d\s\-\+\(\)\.]{7,20})/gi
  while ((m = labelledPhoneRe.exec(workingText)) !== null) {
    const digits = m[1].replace(/\D/g, '')
    if (digits.length >= 7) addEntity('PHONE', m[1].trim(), 88, 'regex')
  }

  // ── Pass 5: Company names (title-cased words + legal suffix) ──────────────
  workingText = applyTokenMap(text, tokenMap)
  COMPANY_SUFFIX_RE.lastIndex = 0
  while ((m = COMPANY_SUFFIX_RE.exec(workingText)) !== null) {
    // Full match is "Name Suffix" — use it; group 1 = name only, group 2 = suffix
    addEntity('ORG', m[0].trim(), 95, 'regex')
  }

  // ── Pass 6: Context-pattern person names ──────────────────────────────────
  workingText = applyTokenMap(text, tokenMap)
  for (const pattern of PERSON_CONTEXT_PATTERNS) {
    pattern.lastIndex = 0
    while ((m = pattern.exec(workingText)) !== null) {
      if (m[1] && m[1].length > 3) addEntity('PERSON', m[1].trim(), 90, 'context_pattern')
    }
  }

  // ── Pass 7: NLP — compromise.js for anything the above missed ─────────────
  // Feed fully-masked text so NLP doesn't re-detect already-found values.
  const maskedForNLP = applyTokenMap(text, tokenMap)
  const doc = nlp(maskedForNLP)

  for (const name of (doc.people().out('array') as string[])) {
    if (name.length > 3 && !name.startsWith('[')) addEntity('PERSON', name, 80, 'nlp')
  }
  for (const org of (doc.organizations().out('array') as string[])) {
    // Require: not a token, at least 2 words, at least 6 chars, no leading punctuation,
    // and not a generic phrase (all-lowercase words like "implementation & configuration")
    const wordCount = org.trim().split(/\s+/).length
    const hasProperNoun = /[A-ZÀ-Ö]/.test(org)
    if (!org.startsWith('[') && org.length >= 6 && wordCount >= 2 && hasProperNoun) {
      addEntity('ORG', org, 75, 'nlp')
    }
  }

  return { entities, tokenMap, reverseMap }
}

// ── Mask contract text ────────────────────────────────────────────────────────

export function maskText(text: string, tokenMap: Map<string, string>): string {
  return applyTokenMap(text, tokenMap)
}

// ── Restore tokens in extracted terms object ──────────────────────────────────
// Walks all string fields and replaces tokens with original values.
// Numeric and date fields are never affected.

export function restoreTokensInObject<T extends object>(
  obj: T,
  reverseMap: Map<string, string>
): T {
  if (!reverseMap.size) return obj

  function restore(value: unknown): unknown {
    if (typeof value === 'string') {
      let result = value
      for (const [token, original] of reverseMap) {
        result = result.split(token).join(original)
      }
      return result
    }
    if (Array.isArray(value)) return value.map(restore)
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, restore(v)])
      ) as unknown
    }
    return value
  }

  return restore(obj) as T
}
