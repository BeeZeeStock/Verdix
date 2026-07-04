/**
 * Generates demo PDFs for Partner Reconciliation module.
 * Run: node scripts/generate-demo-pdfs.mjs
 * Output: public/demo/nets-helios-agreement.pdf
 *         public/demo/invoice-nets-2024-0847.pdf
 */
import { writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(__dirname, '../public/demo')
mkdirSync(OUT_DIR, { recursive: true })

function esc(s) {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/€/g, 'EUR ')
    .replace(/§/g, 'S.')
    .replace(/[^\x00-\x7E]/g, '?')
}

function buildPDF(textLines) {
  const LH = 15     // line height in pts
  const SY = 740    // start Y
  const MX = 55     // left margin

  const streamLines = ['BT', `/F1 10 Tf`, `${MX} ${SY} Td`]
  let first = true
  for (const raw of textLines) {
    const line = typeof raw === 'string' ? raw : raw.text
    const size = typeof raw === 'object' ? (raw.size ?? 10) : 10
    const down = typeof raw === 'object' ? (raw.before ?? 0) : 0

    if (!first && down) streamLines.push(`0 -${down} Td`)
    if (!first && !down) streamLines.push(`0 -${LH} Td`)
    streamLines.push(`/F1 ${size} Tf`)
    streamLines.push(`(${esc(line)}) Tj`)
    first = false
  }
  streamLines.push('ET')

  const stream = streamLines.join('\n')
  const streamLen = Buffer.byteLength(stream, 'latin1')

  const bufs = []
  const offsets = {}
  let pos = 0

  const w = (s) => {
    const b = Buffer.from(s, 'latin1')
    bufs.push(b)
    pos += b.length
  }

  w('%PDF-1.4\n')

  offsets[1] = pos
  w('1 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n')

  offsets[2] = pos
  w('2 0 obj\n<< /Type /Catalog /Pages 3 0 R >>\nendobj\n')

  offsets[3] = pos
  w('3 0 obj\n<< /Type /Pages /Kids [4 0 R] /Count 1 >>\nendobj\n')

  offsets[4] = pos
  w(`4 0 obj\n<< /Type /Page /Parent 3 0 R /MediaBox [0 0 612 792]\n   /Resources << /Font << /F1 1 0 R >> >>\n   /Contents 5 0 R\n>>\nendobj\n`)

  offsets[5] = pos
  w(`5 0 obj\n<< /Length ${streamLen} >>\nstream\n`)
  bufs.push(Buffer.from(stream, 'latin1'))
  pos += streamLen
  w('\nendstream\nendobj\n')

  const xrefPos = pos
  w('xref\n0 6\n')
  w('0000000000 65535 f \n')
  for (let i = 1; i <= 5; i++) {
    w(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`)
  }
  w('trailer\n<< /Size 6 /Root 2 0 R >>\n')
  w(`startxref\n${xrefPos}\n%%EOF\n`)

  return Buffer.concat(bufs)
}

// ─── Agreement ───────────────────────────────────────────────────────────────

const agreementLines = [
  { text: 'PAYMENT PROCESSING AGREEMENT', size: 14, before: 0 },
  { text: '', size: 10 },
  { text: 'Parties:', size: 10 },
  { text: 'Service Provider: Nets A/S, Lautrupbjerg 10, DK-2750 Ballerup, Denmark', size: 10 },
  { text: 'Client: Helios Technologies AB, Kungsgatan 54, SE-111 35 Stockholm, Sweden', size: 10 },
  { text: 'Agreement date: 1 January 2024', size: 10 },
  { text: 'Term: 36 months (through 31 December 2026)', size: 10 },
  { text: 'Governing law: Kingdom of Sweden', size: 10 },
  { text: '', size: 10 },
  { text: 'S.4 FEE SCHEDULE', size: 12, before: 8 },
  { text: '', size: 10 },
  { text: 'S.4.1 Processing Fee (volume-based, blended rate)', size: 11 },
  { text: 'The processing fee is calculated as a blended percentage applied to', size: 10 },
  { text: 'the entire monthly processed volume once the applicable threshold is exceeded.', size: 10 },
  { text: 'Tier 1: EUR 0 to EUR 50,000 per month -- 0.95% (blended on full volume)', size: 10 },
  { text: 'Tier 2: EUR 50,001 to EUR 200,000 per month -- 0.85% (blended on full volume)', size: 10 },
  { text: 'Tier 3: above EUR 200,000 per month -- 0.72% (blended on full volume)', size: 10 },
  { text: 'The blended rate applies retroactively to the entire monthly volume,', size: 10 },
  { text: 'not marginally to the portion above each threshold.', size: 10 },
  { text: '', size: 10 },
  { text: 'S.4.2 Monthly Minimum Fee', size: 11 },
  { text: 'A monthly minimum fee of EUR 800 applies.', size: 10 },
  { text: 'WAIVER: The monthly minimum fee is automatically waived in any calendar', size: 10 },
  { text: 'month in which the Client\'s total processed volume exceeds EUR 100,000.', size: 10 },
  { text: 'No action is required by the Client to invoke this waiver.', size: 10 },
  { text: '', size: 10 },
  { text: 'S.4.3 Chargeback Fee', size: 11 },
  { text: 'EUR 15.00 flat fee per chargeback dispute initiated against a transaction.', size: 10 },
  { text: '', size: 10 },
  { text: 'S.4.4 Cross-Border Surcharge', size: 11 },
  { text: '0.30% surcharge on transactions processed on non-EEA-issued cards.', size: 10 },
  { text: '', size: 10 },
  { text: 'S.4.5 Settlement Terms', size: 11 },
  { text: 'Settlement currency: EUR. Payment terms: Net 30 days from invoice date.', size: 10 },
  { text: 'Late payment interest: 1.5% per month on outstanding balances.', size: 10 },
  { text: 'Dispute window: 30 days from invoice receipt, referencing the specific clause.', size: 10 },
  { text: '', size: 10 },
  { text: 'S.5 BILLING AND INVOICING', size: 12, before: 8 },
  { text: '', size: 10 },
  { text: 'S.5.1 Nets A/S will issue monthly invoices by the 10th of the following month.', size: 10 },
  { text: 'S.5.2 Volume data is taken from Nets A/S transaction logs.', size: 10 },
  { text: 'S.5.3 The applicable blended rate tier is determined by end-of-month volume.', size: 10 },
  { text: '', size: 10 },
  { text: '--- END OF AGREEMENT ---', size: 10 },
]

// ─── Invoice ─────────────────────────────────────────────────────────────────

const invoiceLines = [
  { text: 'INVOICE', size: 16, before: 0 },
  { text: '', size: 10 },
  { text: 'Invoice number: INV-2024-0847', size: 10 },
  { text: 'Invoice date: 10 June 2024', size: 10 },
  { text: 'Billing period: 1 May 2024 -- 31 May 2024', size: 10 },
  { text: '', size: 10 },
  { text: 'From:', size: 10 },
  { text: 'Nets A/S', size: 10 },
  { text: 'Lautrupbjerg 10', size: 10 },
  { text: 'DK-2750 Ballerup', size: 10 },
  { text: 'Denmark', size: 10 },
  { text: 'VAT: DK20016010', size: 10 },
  { text: '', size: 10 },
  { text: 'To:', size: 10 },
  { text: 'Helios Technologies AB', size: 10 },
  { text: 'Kungsgatan 54', size: 10 },
  { text: 'SE-111 35 Stockholm', size: 10 },
  { text: 'Sweden', size: 10 },
  { text: '', size: 10 },
  { text: 'Reference: Agreement dated 1 January 2024', size: 10 },
  { text: '', size: 10 },
  { text: 'LINE ITEMS', size: 12, before: 8 },
  { text: '----------------------------------------------------------------', size: 10 },
  { text: 'Description                        Volume       Rate    Amount', size: 10 },
  { text: '----------------------------------------------------------------', size: 10 },
  { text: 'Processing fee (May 2024)    EUR 287,400.00   0.85%  EUR 2,442.90', size: 10 },
  { text: '  (S.4.1 - payment processing, blended rate applied to full volume)', size: 10 },
  { text: '', size: 10 },
  { text: 'Monthly minimum fee                   --        --    EUR   800.00', size: 10 },
  { text: '  (S.4.2 - minimum monthly charge)', size: 10 },
  { text: '', size: 10 },
  { text: 'Chargeback fees (3 disputes)          3     EUR 15.00 EUR    45.00', size: 10 },
  { text: '  (S.4.3 - chargeback fee per dispute)', size: 10 },
  { text: '', size: 10 },
  { text: 'Cross-border surcharge          EUR 18,200.00  0.30%  EUR    54.60', size: 10 },
  { text: '  (S.4.4 - non-EEA card transactions)', size: 10 },
  { text: '----------------------------------------------------------------', size: 10 },
  { text: 'SUBTOTAL                                               EUR 3,342.50', size: 11 },
  { text: 'VAT (0% - B2B EU reverse charge)                       EUR     0.00', size: 10 },
  { text: 'TOTAL DUE                                              EUR 3,342.50', size: 12, before: 5 },
  { text: '----------------------------------------------------------------', size: 10 },
  { text: '', size: 10 },
  { text: 'Payment due: 10 July 2024 (Net 30)', size: 10 },
  { text: 'Bank: Nordea Bank Danmark A/S', size: 10 },
  { text: 'IBAN: DK89 3000 0009 1234 5678', size: 10 },
  { text: 'BIC: NDEADKKK', size: 10 },
  { text: '', size: 10 },
  { text: 'For queries contact: billing@nets.eu', size: 10 },
]

const agPDF = buildPDF(agreementLines)
const invPDF = buildPDF(invoiceLines)

writeFileSync(resolve(OUT_DIR, 'nets-helios-agreement.pdf'), agPDF)
writeFileSync(resolve(OUT_DIR, 'invoice-nets-2024-0847.pdf'), invPDF)

console.log('Created:')
console.log('  public/demo/nets-helios-agreement.pdf')
console.log('  public/demo/invoice-nets-2024-0847.pdf')
