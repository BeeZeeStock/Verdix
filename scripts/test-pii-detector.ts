#!/usr/bin/env tsx
/**
 * Usage: npx tsx scripts/test-pii-detector.ts
 */
import { detectPII, maskText } from '../lib/pii-detector'

const SAMPLE = `
ORDER FORM — CLR-2024-0001

Vendor:   Verdix Corp, 123 Main Street, Oslo, Norway
Customer: Acme Inc, 14 Innovation Drive, Stockholm, Sweden SE-11243
VAT:      SE556123456701

This Agreement is entered into between Verdix Corp ("Vendor") and Acme Inc ("Customer").

Signatory (Vendor):  CEO John Smith, john.smith@verdix.com, +46 70 123 4567
Signatory (Customer): CFO Maria Lopez, m.lopez@acme.com, +46 8 123 45 67

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

Signed on behalf of Acme Inc by Maria Lopez.
Signed on behalf of Verdix Corp by John Smith.
`

const { entities, tokenMap } = detectPII(SAMPLE)
const masked = maskText(SAMPLE, tokenMap)

console.log('\n═══ DETECTED PII ENTITIES ═══\n')
const grouped: Record<string, typeof entities> = {}
for (const e of entities) {
  if (!grouped[e.type]) grouped[e.type] = []
  grouped[e.type].push(e)
}
for (const [type, items] of Object.entries(grouped)) {
  console.log(type)
  for (const e of items) {
    console.log(`  ${e.token.padEnd(18)} ${String(e.confidence).padStart(3)}%  [${e.source}]  "${e.value}"`)
  }
}

console.log('\n═══ MASKED CONTRACT TEXT ═══\n')
console.log(masked.trim())

console.log(`\n═══ SUMMARY ═══`)
console.log(`Total entities: ${entities.length}`)
console.log(`Types: ${[...new Set(entities.map(e => e.type))].join(', ')}`)
