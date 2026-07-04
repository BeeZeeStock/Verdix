import Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'

export type PartnerFindingType = 'WRONG_RATE' | 'WAIVED_FEE' | 'DUPLICATE_CHARGE' | 'EXPIRED_RATE' | 'INCORRECT_CALC'

export interface PartnerFinding {
  id: string
  finding_type: PartnerFindingType
  description: string
  agreed_amount: number
  billed_amount: number
  discrepancy: number
  evidence: string
  status: 'open' | 'accepted' | 'disputed'
}

export interface PartnerAgreementTerms {
  partner_name: string | null
  agreement_type: string | null
  effective_date: string | null
  expiry_date: string | null
  currency: string
  fee_schedules: PartnerFeeSchedule[]
  waived_fees: string[]
  notes: string | null
}

export interface PartnerFeeSchedule {
  fee_name: string
  rate_pct: number | null
  flat_amount: number | null
  unit: string | null
  applies_from: string | null
  applies_to: string | null
  description: string
}

export interface PartnerInvoiceLine {
  description: string
  quantity: number | null
  unit_rate: number | null
  volume: number | null
  amount_billed: number
  currency: string
  reference: string | null
}

const client = new Anthropic()

export async function extractPartnerAgreement(agreementText: string): Promise<PartnerAgreementTerms> {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: `Extract structured terms from a partner/supplier agreement. Return JSON matching this exact schema:
{
  "partner_name": string | null,
  "agreement_type": string | null,
  "effective_date": "YYYY-MM-DD" | null,
  "expiry_date": "YYYY-MM-DD" | null,
  "currency": string,
  "fee_schedules": [{ "fee_name": string, "rate_pct": number | null, "flat_amount": number | null, "unit": string | null, "applies_from": string | null, "applies_to": string | null, "description": string }],
  "waived_fees": [string],
  "notes": string | null
}
IMPORTANT: fee_schedules and waived_fees MUST be arrays (use [] if none found). Return ONLY valid JSON, no markdown.`,
    messages: [{ role: 'user', content: `<agreement>\n${agreementText}\n</agreement>\n\nReturn only JSON.` }],
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : ''
  const cleaned = text.trim().replace(/^```json?\n?/, '').replace(/\n?```$/, '')
  const parsed = JSON.parse(cleaned) as PartnerAgreementTerms
  parsed.fee_schedules = parsed.fee_schedules ?? []
  parsed.waived_fees = parsed.waived_fees ?? []
  return parsed
}

export async function extractPartnerInvoice(invoiceText: string): Promise<PartnerInvoiceLine[]> {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: `Extract line items from a partner invoice. Return a JSON array of PartnerInvoiceLine objects.
Each object must include:
- description: line item description
- quantity: unit count or null
- unit_rate: the percentage rate or unit price used (as a number, e.g. 0.85 for 0.85%) or null
- volume: total monetary or unit volume this line is based on (e.g. total EUR processed) or null
- amount_billed: the billed amount as a number
- currency: 3-letter currency code
- reference: invoice number or line reference or null
Return ONLY a valid JSON array, no markdown.`,
    messages: [{ role: 'user', content: `<invoice>\n${invoiceText}\n</invoice>\n\nReturn only JSON array.` }],
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : '[]'
  const cleaned = text.trim().replace(/^```json?\n?/, '').replace(/\n?```$/, '')
  const parsed = JSON.parse(cleaned)
  return Array.isArray(parsed) ? (parsed as PartnerInvoiceLine[]) : []
}

/**
 * AI-powered reconciliation. Compares the full agreement text against invoice
 * lines to catch complex scenarios like tiered pricing, volume-based waivers,
 * and blended rates. Returns structured findings.
 */
export async function aiReconcile(
  agreementText: string,
  invoiceLines: PartnerInvoiceLine[],
  currency: string
): Promise<PartnerFinding[]> {
  const invoiceSummary = invoiceLines
    .map((l, i) =>
      `Line ${i + 1}: "${l.description}" | volume=${l.volume ?? 'n/a'} | rate=${l.unit_rate ?? 'n/a'}% | billed=${currency} ${l.amount_billed.toFixed(2)}`
    )
    .join('\n')

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: `You are an expert accounts payable auditor. You will be given a signed partner agreement and a list of invoice line items. Your job is to identify every billing discrepancy — charges that differ from what the agreement stipulates.

For tiered pricing: determine which tier applies to the invoice volume (apply blended/retroactive rules if stated) and calculate the correct amount.
For waiver clauses: check whether waiver thresholds are met and flag any fees that should have been waived.
For duplicate charges: flag any item that appears twice with the same amount.
If a corrected amount from one finding affects the base of another calculation (e.g. an SLA credit is a % of the corrected charge, not the wrong billed amount), use the corrected base.

CRITICAL DEDUPLICATION RULE: Each root-cause billing error must appear EXACTLY ONCE in your output. Do not report the same discrepancy from multiple angles or with different wording. If two candidate findings refer to the same invoice line and the same contract clause, keep only the most precise one.

Return a JSON array of findings. Each finding must be:
{
  "finding_type": "WRONG_RATE" | "WAIVED_FEE" | "DUPLICATE_CHARGE" | "EXPIRED_RATE" | "INCORRECT_CALC",
  "description": "Clear explanation of the discrepancy with exact figures",
  "agreed_amount": <number — what should have been charged>,
  "billed_amount": <number — what was actually charged>,
  "discrepancy": <number — absolute difference, always positive>,
  "evidence": "Exact clause reference from the agreement"
}

If there are NO discrepancies, return an empty array [].
Return ONLY a valid JSON array, no markdown, no explanation outside the array.`,
    messages: [
      {
        role: 'user',
        content: `<agreement>\n${agreementText}\n</agreement>\n\n<invoice_lines>\n${invoiceSummary}\n</invoice_lines>\n\nIdentify all discrepancies. Return only JSON array.`,
      },
    ],
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : '[]'
  const cleaned = text.trim().replace(/^```json?\n?/, '').replace(/\n?```$/, '')
  const raw: Array<{
    finding_type: PartnerFindingType
    description: string
    agreed_amount: number
    billed_amount: number
    discrepancy: number
    evidence: string
  }> = JSON.parse(Array.isArray(JSON.parse(cleaned)) ? cleaned : '[]')

  // Deduplicate: same finding_type + discrepancy within 2% → keep the first (longer description wins)
  const seen = new Map<string, number>()
  const deduped = raw.filter(f => {
    const disc = Math.abs(Number(f.discrepancy))
    for (const [key, seenDisc] of seen) {
      if (key === f.finding_type && Math.abs(disc - seenDisc) / Math.max(disc, seenDisc, 1) < 0.02) {
        return false
      }
    }
    seen.set(f.finding_type + '_' + seen.size, disc)
    return true
  })

  return deduped.map(f => ({
    id: randomUUID(),
    finding_type: f.finding_type,
    description: f.description,
    agreed_amount: Number(f.agreed_amount),
    billed_amount: Number(f.billed_amount),
    discrepancy: Math.abs(Number(f.discrepancy)),
    evidence: f.evidence ?? '',
    status: 'open' as const,
  }))
}

// Keep deterministic reconciler for simple flat-rate agreements (no tiers/waivers)
export function reconcilePartner(
  agreement: PartnerAgreementTerms,
  invoiceLines: PartnerInvoiceLine[]
): PartnerFinding[] {
  const findings: PartnerFinding[] = []

  findings.push(
    ...detectWrongRates(agreement, invoiceLines),
    ...detectWaivedFees(agreement, invoiceLines),
    ...detectDuplicateCharges(invoiceLines),
    ...detectExpiredRates(agreement, invoiceLines),
  )

  return findings
}

function detectWrongRates(
  agreement: PartnerAgreementTerms,
  lines: PartnerInvoiceLine[]
): PartnerFinding[] {
  const findings: PartnerFinding[] = []

  for (const line of lines) {
    for (const fee of (agreement.fee_schedules ?? [])) {
      const nameMatch = line.description.toLowerCase().includes(fee.fee_name.toLowerCase())
      if (!nameMatch) continue

      if (fee.rate_pct !== null && line.unit_rate !== null && line.volume !== null) {
        const expectedRate = fee.rate_pct / 100
        const billedRate = line.amount_billed / line.volume
        const expectedAmount = line.volume * expectedRate

        if (Math.abs(billedRate - expectedRate) > expectedRate * 0.001) {
          const discrepancy = line.amount_billed - expectedAmount
          if (Math.abs(discrepancy) > 0.01) {
            findings.push({
              id: randomUUID(),
              finding_type: 'WRONG_RATE',
              description: `"${line.description}": billed at ${(billedRate * 100).toFixed(4)}% but agreement specifies ${fee.rate_pct}%`,
              agreed_amount: expectedAmount,
              billed_amount: line.amount_billed,
              discrepancy: Math.abs(discrepancy),
              evidence: fee.description,
              status: 'open',
            })
          }
        }
      }

      if (fee.flat_amount !== null && line.unit_rate === null) {
        const discrepancy = line.amount_billed - fee.flat_amount
        if (Math.abs(discrepancy) > 0.01) {
          findings.push({
            id: randomUUID(),
            finding_type: 'WRONG_RATE',
            description: `"${line.description}": flat fee is ${agreement.currency} ${line.amount_billed.toFixed(2)} but agreement specifies ${agreement.currency} ${fee.flat_amount.toFixed(2)}`,
            agreed_amount: fee.flat_amount,
            billed_amount: line.amount_billed,
            discrepancy: Math.abs(discrepancy),
            evidence: fee.description,
            status: 'open',
          })
        }
      }
    }
  }

  return findings
}

function detectWaivedFees(
  agreement: PartnerAgreementTerms,
  lines: PartnerInvoiceLine[]
): PartnerFinding[] {
  const findings: PartnerFinding[] = []
  if (!agreement.waived_fees?.length) return findings

  for (const line of lines) {
    for (const waivedFee of agreement.waived_fees) {
      if (line.description.toLowerCase().includes(waivedFee.toLowerCase()) && line.amount_billed > 0) {
        findings.push({
          id: randomUUID(),
          finding_type: 'WAIVED_FEE',
          description: `"${line.description}" is explicitly waived in the agreement but billed at ${agreement.currency} ${line.amount_billed.toFixed(2)}`,
          agreed_amount: 0,
          billed_amount: line.amount_billed,
          discrepancy: line.amount_billed,
          evidence: `Waived fee clause: "${waivedFee}"`,
          status: 'open',
        })
      }
    }
  }

  return findings
}

function detectDuplicateCharges(lines: PartnerInvoiceLine[]): PartnerFinding[] {
  const findings: PartnerFinding[] = []
  const seen = new Map<string, PartnerInvoiceLine>()

  for (const line of lines) {
    const key = `${line.description.toLowerCase().trim()}:${line.amount_billed.toFixed(2)}`
    if (seen.has(key)) {
      const original = seen.get(key)!
      findings.push({
        id: randomUUID(),
        finding_type: 'DUPLICATE_CHARGE',
        description: `"${line.description}" appears twice at ${line.currency} ${line.amount_billed.toFixed(2)} — possible duplicate charge`,
        agreed_amount: line.amount_billed,
        billed_amount: line.amount_billed * 2,
        discrepancy: line.amount_billed,
        evidence: `Duplicate of line: "${original.description}" ${original.reference ? `(${original.reference})` : ''}`,
        status: 'open',
      })
    } else {
      seen.set(key, line)
    }
  }

  return findings
}

function detectExpiredRates(
  agreement: PartnerAgreementTerms,
  lines: PartnerInvoiceLine[]
): PartnerFinding[] {
  const findings: PartnerFinding[] = []
  if (!agreement.expiry_date) return findings

  const expiryDate = new Date(agreement.expiry_date)
  const today = new Date()

  if (today <= expiryDate) return findings

  for (const fee of (agreement.fee_schedules ?? [])) {
    if (fee.applies_to && new Date(fee.applies_to) < today) {
      const matchingLines = lines.filter(l =>
        l.description.toLowerCase().includes(fee.fee_name.toLowerCase())
      )
      for (const line of matchingLines) {
        findings.push({
          id: randomUUID(),
          finding_type: 'EXPIRED_RATE',
          description: `"${line.description}" uses rate from expired fee schedule (valid until ${fee.applies_to}). Renegotiation required.`,
          agreed_amount: 0,
          billed_amount: line.amount_billed,
          discrepancy: line.amount_billed,
          evidence: `Fee schedule "${fee.fee_name}" expired ${fee.applies_to}. ${fee.description}`,
          status: 'open',
        })
      }
    }
  }

  return findings
}
