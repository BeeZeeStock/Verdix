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
  // A company/organisation registration number (e.g. Swedish
  // organisationsnummer) — an organisation identifier, never a personal
  // identity number. Kept as its own type (never PERSON/SSN — this codebase
  // has no personal-identity-number type at all) so an org's registration
  // number is masked and reviewable on its own terms instead of either
  // leaking unmasked or being misclassified as personal data.
  | 'ORGANIZATION_IDENTIFIER'

export interface PIIEntity {
  type:       PIIEntityType
  value:      string       // original text as it appeared
  token:      string       // replacement token e.g. [PERSON_1]
  confidence: number       // 0–100
  source:     'regex' | 'nlp' | 'context_pattern'
  // Item 3 — an alias is a DIFFERENT literal string referring to the SAME
  // organisation (e.g. "CoAccept AB" and its short name "Remembill" used
  // interchangeably through the same contract). Set to the canonical org
  // entity's own `value` when this entity was detected as an alias of it —
  // never set on the canonical entity itself. Two distinct spans stay two
  // distinct, independently traceable PIIEntity records (this module never
  // silently merges text spans); the association is what lets a caller
  // ensure approving/masking the canonical entity also accounts for its
  // aliases, so anonymizing one can never leave the other visible.
  aliasOf?: string
  // Item 4 — for ORGANIZATION_IDENTIFIER entities, the canonical org value
  // (if one was found nearby in the text) this identifier belongs to.
  // Proximity-based and generic — never inferred from the identifier's own
  // digits, which carry no organisation name.
  associatedOrg?: string
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

// Words found in document title headers that must never be classified as ORG names.
// All-caps title words like "MASTER SOFTWARE AS A SERVICE AGREEMENT" can superficially
// match the company-suffix regex (e.g. "MASTER SOFTWARE ... AB") and must be excluded.
const TITLE_WORD_BLOCKLIST = /\b(MASTER|SOFTWARE|SERVICE|AGREEMENT)\b/

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

// Item 2 — generic PERSON-candidate validity check, applied to NLP output.
// compromise.js is an English-tuned tagger; fed non-English prose (Swedish/
// Danish/Norwegian contracts) it can mis-tag an ordinary sentence fragment
// as a person name — e.g. "mätt värdeviktat." ("measured, value-weighted")
// from "...är utfallet, mätt värdeviktat." Never a hardcoded phrase check:
// purely structural, on the SAME shape every genuine name candidate in
// this file is already required to have (see NAME_SEG above) — every word
// must itself look like a name token (capitalized, letters only), and the
// candidate must not end in ordinary sentence-terminating punctuation (a
// real name is never captured ending in two-or-more lowercase letters
// then a period — that's prose, not a name/abbreviation).
function isPlausiblePersonName(candidate: string): boolean {
  const trimmed = candidate.trim()
  if (!trimmed) return false
  if (/[a-zà-ÿ]{2,}\.$/.test(trimmed)) return false
  const core = trimmed.replace(/[.,;:!?]+$/, '')
  const words = core.split(/\s+/).filter(Boolean)
  if (words.length === 0) return false
  return words.every(w => /^[A-ZÀ-Ö][a-zà-ÿ'-]*$/.test(w))
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

  function addEntity(
    type: PIIEntityType, value: string, confidence: number, source: PIIEntity['source'],
    aliasOf?: string, associatedOrg?: string,
  ) {
    const trimmed = value.trim()
    if (!trimmed) return
    const key = dedupKey(trimmed)
    if (seen.has(key)) return
    seen.add(key)

    // Hardening item 1 (second pass) — an alias gets its OWN token, never
    // a shared/reused one. Overloading a single token across two literal
    // source strings makes restoration ambiguous (which original text
    // occupied a given occurrence?) and corrupts source_clause fidelity —
    // a clause that actually said "Remembill" would restore back to
    // "CoAccept AB" instead. Identity GROUPING (does this alias belong to
    // that canonical org, for masking-completeness purposes) is tracked
    // separately via aliasOf below and, once persisted, via
    // pii_entities.alias_of_entity_id — never via token identity.
    const token = nextToken(type)
    const entity: PIIEntity = { type, value: trimmed, token, confidence, source }
    if (aliasOf) entity.aliasOf = aliasOf
    if (associatedOrg) entity.associatedOrg = associatedOrg
    entities.push(entity)
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
  interface OrgMatch { value: string; index: number; end: number }
  const orgMatches: OrgMatch[] = []
  while ((m = COMPANY_SUFFIX_RE.exec(workingText)) !== null) {
    const candidate = m[0].trim()
    // Skip matches that contain document-title words (e.g. "MASTER SOFTWARE ... AB")
    if (TITLE_WORD_BLOCKLIST.test(candidate)) continue
    orgMatches.push({ value: candidate, index: m.index, end: m.index + m[0].length })
  }

  // Item 2 — canonical-span dedup for overlapping organisation matches.
  // The same real occurrence of an org name can be captured under two
  // different literal spans when a preceding capitalized word gets swept
  // into the name segment (e.g. a Swedish signature block "För CoAccept AB"
  // vs. the plain "CoAccept AB" used earlier in the body) — these are
  // DIFFERENT literal substrings, so naive dedup-by-exact-text treats them
  // as two organisations. Purely structural: a longer match that ENDS WITH
  // a shorter match at a whole-word boundary is a duplicate of it; keep
  // only the shortest (canonical) span. No language-specific branch — this
  // is a trailing-substring rule, not a "För" check.
  function isCanonicalDuplicate(candidate: OrgMatch): boolean {
    return orgMatches.some(other => {
      if (other === candidate) return false
      if (other.value.length >= candidate.value.length) return false
      if (!candidate.value.endsWith(other.value)) return false
      const prefix = candidate.value.slice(0, candidate.value.length - other.value.length)
      return /\s$/.test(prefix)
    })
  }

  for (const org of orgMatches) {
    if (isCanonicalDuplicate(org)) continue
    addEntity('ORG', org.value, 95, 'regex')

    // Item 3 — an obvious alias immediately following the canonical name in
    // parentheses, e.g. "CoAccept AB (Remembill)" — a single short,
    // capitalized name, not a sentence. A purely structural, position-
    // relative pattern (right after a just-detected org match), not tied to
    // any specific company — kept as its OWN distinct, traceable entity
    // (never silently merged into the canonical org's own span), linked via
    // aliasOf so a caller can ensure masking one accounts for the other.
    const afterMatch = workingText.slice(org.end, org.end + 60)
    const aliasMatch = /^\s*\(\s*(?:hereinafter\s+)?"?([A-ZÀ-Ö][a-zA-ZÀ-ÿ]{1,40})"?\s*\)/.exec(afterMatch)
    if (aliasMatch) addEntity('ORG', aliasMatch[1], 90, 'regex', org.value)
  }

  // ── Pass 5.5: Organisation registration numbers ───────────────────────────
  // Nordic organisationsnummer shape: 6 digits, hyphen, 4 digits — the SAME
  // shape a Swedish personnummer (personal identity number) uses
  // (YYMMDD-XXXX), so this is genuinely ambiguous by digits alone.
  // Disambiguated the same way Swedish practice does: a personnummer's 3rd
  // and 4th digits are always a valid month (01-12, since they encode a
  // real birth date); an organisationsnummer's never are (its group-number
  // digit starts outside that range). When the digits COULD be a real date,
  // this pass stays silent rather than guessing — never classified as
  // ORGANIZATION_IDENTIFIER on ambiguous input, and never as PERSON/SSN
  // either way (this codebase has no personal-identity-number type to
  // misclassify into).
  workingText = applyTokenMap(text, tokenMap)
  const orgNumberRe = /\b(\d{2})(\d{2})(\d{2})-(\d{4})\b/g
  while ((m = orgNumberRe.exec(workingText)) !== null) {
    const monthDigits = Number(m[2])
    if (monthDigits >= 1 && monthDigits <= 12) continue // plausibly a real date — stay silent
    // Best-effort proximity association with the nearest preceding ORG
    // entity in the original text — never inferred from the digits
    // themselves.
    const occurrenceIndex = text.indexOf(m[0])
    const precedingText = occurrenceIndex >= 0 ? text.slice(0, occurrenceIndex) : ''
    let associatedOrg: string | undefined
    let bestIdx = -1
    for (const orgEntity of entities.filter(e => e.type === 'ORG')) {
      const idx = precedingText.lastIndexOf(orgEntity.value)
      if (idx > bestIdx) { bestIdx = idx; associatedOrg = orgEntity.value }
    }
    addEntity('ORGANIZATION_IDENTIFIER', m[0], 90, 'regex', undefined, associatedOrg)
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

  // Swedish/Danish/Norwegian common words that NLP misclassifies as person names.
  // Tested against both the full phrase AND the first word — this catches multi-word
  // false positives like "från fakturadatum." and "andra Partens".
  const NLP_PERSON_BLOCKLIST = /^(från|till|med|för|och|eller|men|att|som|vid|hos|mot|per|via|utan|samt|dels|denna|detta|dessa|varje|ingen|inget|alla|vilken|vilket|vilka|sådan|sådant|af|fra|til|ska|skall|senast|trettio|fyrtio|femtio|sextio|sjuttio|åttio|nittio|betalning|faktura|avtal|dokument|villkor|period|det|är|de|den|andra|parten|partens|parterna|part|kundens|leverantörens|leverantören|inom|under|efter|innan|enligt|av|vid|om|när|där|hur|vad|vem|sin|sitt|sina|dess|deras|varför|ifall|dock|samt|men|ej|inga|inte|endast|only|the|and|or|for|of|in|to|at|by|with|from|any|all|this|that|these|those|each|every|such|both|also|here|there|which|where|when|who|what|how|why|not|but|however|payment|invoice|contract|document|term|period|date|shall|must|may|will|should)$/i

  for (const name of (doc.people().out('array') as string[])) {
    const trimmed = name.trim()
    const firstWord = trimmed.split(/\s+/)[0].replace(/[.,;:!?]$/, '')
    if (
      trimmed.length > 3 &&
      !trimmed.startsWith('[') &&
      isPlausiblePersonName(trimmed) &&
      !NLP_PERSON_BLOCKLIST.test(trimmed) &&
      !NLP_PERSON_BLOCKLIST.test(firstWord)
    ) addEntity('PERSON', name, 80, 'nlp')
  }
  // Generic service/admin terms that compromise.js misclassifies as organisations.
  // Includes common Swedish/Danish/Norwegian contract words that cause false positives.
  const NLP_ORG_BLOCKLIST = /\b(administration|configuration|implementation|training|support|services|onboarding|setup|migration|master|software|service|agreement|betalning|faktura|avtal|avtalet|villkor|leverantör|kund|tjänst|månadsavgift|årsavgift|abonnemang|licens|produkt|datum|period|betaling|aftale|kontrakt|leverandør|tjeneste|lisens|betaling|avgift|kostnad|pris|rabatt|kundens|kunden|leverantörens|parten|partens|parterna|part|data|information|dokument|regler|bestämmelse|skyldighet|rättighet|sekretess|behandling|personuppgift)\b/i

  for (const org of (doc.organizations().out('array') as string[])) {
    const wordCount = org.trim().split(/\s+/).length
    const hasProperNoun = /[A-ZÀ-Ö]/.test(org)
    // Reject tokens, short/single-word matches, leading punctuation, and generic phrases
    if (
      org.startsWith('[') ||
      org.startsWith('(') ||
      org.length < 6 ||
      wordCount < 2 ||
      !hasProperNoun ||
      NLP_ORG_BLOCKLIST.test(org)
    ) continue
    addEntity('ORG', org, 75, 'nlp')
  }

  return { entities, tokenMap, reverseMap }
}

// ── Alias-group resolution (for DB-persisted entities) ──────────────────────
//
// Hardening item 2 (review pass 3) — approving EITHER member of an
// canonical/alias pair must mask BOTH, since they represent the same real-
// world identity: "approve CoAccept AB -> masks CoAccept AB + Remembill"
// AND, symmetrically, "approve Remembill -> masks Remembill + CoAccept AB".
// One-hop only (alias.alias_of_entity_id always points directly at a
// canonical, never at another alias — enforced by migration
// 20260901000001_pii_entity_alias.sql's chain-prevention check and the
// service layer, see detect-pii/route.ts), so the "group root" for any
// entity is simply its own id (if canonical) or its alias_of_entity_id (if
// an alias) — approving any member whose id maps to the same root, or
// whose root itself is approved, masks the whole two-(or-more)-row group.
// Each entity keeps its own token/original_value throughout — this
// resolves GROUP MEMBERSHIP only, never token identity.

export interface AliasGroupable {
  id: string
  alias_of_entity_id: string | null
}

export function aliasGroupRoot(entity: AliasGroupable): string {
  return entity.alias_of_entity_id ?? entity.id
}

// Hardening item 3 (review pass 5) — the same group-root logic, applied to
// find every id belonging to a given canonical's group (including the
// canonical itself). Used both for masking (buildMaskFromDB) and for
// REVIEW DECISIONS (app/api/jobs/[id]/pii/route.ts's PATCH handler) so
// approve/reject/ignore can never persist a contradictory state across an
// alias and its canonical — they represent the same organisation identity.
export function resolveGroupMemberIds<T extends AliasGroupable>(canonicalId: string, entities: T[]): string[] {
  return entities.filter(e => aliasGroupRoot(e) === canonicalId).map(e => e.id)
}

// Hardening item (review pass 8) — closes the remaining gap: approve/
// reject/ignore already persist group-consistently at ACTION time (the
// PATCH route's resolveAliasGroupIds), but pii_entities.approved is an
// intentionally org-scoped, REUSED flag (see CLAUDE.md — the same
// "CoAccept AB" row is shared across every contract that mentions it). A
// fresh job can therefore start with a canonical already approved: true
// from an earlier job while an alias newly discovered in THIS job's
// document is still approved: false by default — a split the review UI
// must never present, even before any reviewer has clicked anything.
//
// Deliberately takes an already-scoped entity list (e.g. one job's own
// occurrences) rather than reaching org-wide itself — "derive the group
// decision from job-level occurrence state" per the caller's own scope,
// not a blind global inheritance. If ANY member of a group within the
// given set is approved, every member of that group (within the set) is
// presented as approved; if any member is ignored, the whole group is
// ignored (and never simultaneously approved, matching the PATCH route's
// own ignore semantics: approved: false, ignored: true together).
export interface GroupReviewState extends AliasGroupable {
  approved: boolean
  ignored: boolean
}

export function deriveGroupReviewState<T extends GroupReviewState>(entities: T[]): Map<string, { approved: boolean; ignored: boolean }> {
  const ignoredRoots = new Set(entities.filter(e => e.ignored).map(aliasGroupRoot))
  const approvedRoots = new Set(entities.filter(e => e.approved).map(aliasGroupRoot))
  const result = new Map<string, { approved: boolean; ignored: boolean }>()
  for (const e of entities) {
    const root = aliasGroupRoot(e)
    const ignored = ignoredRoots.has(root)
    result.set(e.id, { ignored, approved: !ignored && approvedRoots.has(root) })
  }
  return result
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
