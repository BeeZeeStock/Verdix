#!/usr/bin/env node
/**
 * Usage: node scripts/test-pii-detector.mjs
 *
 * Runs the PII detector against a realistic sample contract and prints
 * detected entities + the masked output.
 */

// Dynamically import the compiled TS via ts-node or just the built JS.
// Since we use Next.js / Turbopack we can call the detector via a small
// inline re-implementation for this standalone script.

import nlp from 'compromise'

// ── Inline minimal version of the detector (mirrors lib/pii-detector.ts) ─────

const COMPANY_SUFFIXES = [
  'Ltd','Limited','Inc','LLC','LLP','PLC','Corp','Corporation','Co.',
  'AB','AS','ASA','ApS','Oy','Oyj','HB','KB','GmbH','AG','BV','NV','SARL',
  'SAS','SA','SL','SRL','SpA','Lda','sp. z o.o.','a.s.','s.r.o.',
]
const COMPANY_SUFFIX_RE = new RegExp(
  `\\b[A-Z][\\w\\s,.'&-]{1,60}\\s+(${COMPANY_SUFFIXES.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'g'
)

const PERSON_CONTEXT_PATTERNS = [
  /(?:signed by|represented by|executed by|on behalf of|authorized by|signatory[:\s]+|contact[:\s]+|attention[:\s]+|attn[:\s]+)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/gi,
  /(?:Name|Full Name)[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/gi,
  /(?:Director|CEO|CFO|CTO|VP|Manager|Officer)[:\s,]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/gi,
]

const PATTERNS = [
  { type: 'EMAIL',      re: /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g, confidence: 100 },
  { type: 'PHONE',      re: /(?:\+\d{1,3}[\s\-.]?)?\(?\d{2,4}\)?[\s\-.]?\d{3,4}[\s\-.]?\d{3,6}/g, confidence: 90 },
  { type: 'IBAN',       re: /\b[A-Z]{2}\d{2}[A-Z0-9]{4}\d{7}[A-Z0-9]{0,16}\b/g, confidence: 100 },
  { type: 'VAT_NUMBER', re: /\b(?:SE|GB|DE|FR|NL|DK|NO|FI|PL|IT|ES|AT|BE|CZ|HU|IE|PT)\s*\d[\d\s]{6,14}\b/g, confidence: 95 },
]

function makeCounter() {
  const counts = {}
  return (type) => {
    counts[type] = (counts[type] ?? 0) + 1
    return `[${type}_${counts[type]}]`
  }
}

function detectPII(text) {
  const entities = []
  const tokenMap = new Map()
  const reverseMap = new Map()
  const seen = new Set()
  const nextToken = makeCounter()

  function addEntity(type, value, confidence, source) {
    const norm = value.trim()
    if (!norm || seen.has(norm.toLowerCase())) return
    seen.add(norm.toLowerCase())
    const token = nextToken(type)
    entities.push({ type, value: norm, token, confidence, source })
    tokenMap.set(norm, token)
    reverseMap.set(token, norm)
  }

  for (const { type, re, confidence } of PATTERNS) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text)) !== null) addEntity(type, m[0], confidence, 'regex')
  }

  COMPANY_SUFFIX_RE.lastIndex = 0
  let cm
  while ((cm = COMPANY_SUFFIX_RE.exec(text)) !== null) addEntity('ORG', cm[0], 95, 'regex')

  for (const pattern of PERSON_CONTEXT_PATTERNS) {
    pattern.lastIndex = 0
    let pm
    while ((pm = pattern.exec(text)) !== null) if (pm[1]) addEntity('PERSON', pm[1], 90, 'context_pattern')
  }

  let maskedForNLP = text
  for (const [original, token] of tokenMap) maskedForNLP = maskedForNLP.split(original).join(token)

  const doc = nlp(maskedForNLP)
  for (const name of doc.people().out('array')) if (name.length > 3) addEntity('PERSON', name, 80, 'nlp')
  for (const org  of doc.organizations().out('array')) if (org.length > 2) addEntity('ORG', org, 75, 'nlp')

  return { entities, tokenMap, reverseMap }
}

function maskText(text, tokenMap) {
  let masked = text
  const sorted = [...tokenMap.entries()].sort((a, b) => b[0].length - a[0].length)
  for (const [original, token] of sorted) masked = masked.split(original).join(token)
  return masked
}

// ── Sample contract text ──────────────────────────────────────────────────────

const SAMPLE = `
ORDER FORM — CLR-2024-0001

Vendor:   Verdix Corp, 123 Main Street, Oslo, Norway
Customer: Acme Inc, 14 Innovation Drive, Stockholm, Sweden SE-11243
VAT:      SE556123456701

This Agreement is entered into between Verdix Corp ("Vendor") and Acme Inc ("Customer").

Signatory (Vendor):  CEO John Smith, john.smith@verdix.com, +46 70 123 4567
Signatory (Customer): CFO Maria López, m.lopez@acme.com, +46 8 123 45 67

Billing contact: Sarah Johansson, billing@acme.com

Section 1 — Fees
Base Annual Fee: €456,987 per year.
Year 1: €436,288 (20% introductory discount applied).
Year 2: Year 1 fee + base annual fee + 10 users × €2,500/user/year.
Year 3: Year 1 + Year 2 + base annual fee + 20 users × €2,500/user/year.
Professional Services: €50,000 one-time fee due 2024-02-01.

Payment: Net 30 days from invoice date.
Bank: IBAN SE45 5000 0000 0583 9825 7466

Price escalator: 3% CPI annually from Year 2.

Signed on behalf of Acme Inc by Maria López.
Signed on behalf of Verdix Corp by John Smith.
`

// ── Run ───────────────────────────────────────────────────────────────────────

const { entities, tokenMap } = detectPII(SAMPLE)
const masked = maskText(SAMPLE, tokenMap)

console.log('\n═══ DETECTED PII ENTITIES ═══\n')
const grouped = {}
for (const e of entities) {
  if (!grouped[e.type]) grouped[e.type] = []
  grouped[e.type].push(e)
}
for (const [type, items] of Object.entries(grouped)) {
  console.log(`${type}`)
  for (const e of items) {
    console.log(`  ${e.token.padEnd(16)} ${String(e.confidence).padStart(3)}%  [${e.source}]  "${e.value}"`)
  }
}

console.log('\n═══ MASKED CONTRACT TEXT ═══\n')
console.log(masked.trim())

console.log('\n═══ SUMMARY ═══')
console.log(`Total entities detected: ${entities.length}`)
console.log(`Types: ${[...new Set(entities.map(e => e.type))].join(', ')}`)
