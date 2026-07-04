import { BillingRecord } from './types'

// Canonical column name → internal field mapping
const COLUMN_MAP: Record<string, keyof BillingRecord | null> = {
  // Invoice ID
  'invoice_id': 'invoiceId',
  'invoice id': 'invoiceId',
  'id': 'invoiceId',
  'number': 'invoiceId',
  // Customer
  'customer_name': 'customerName',
  'customer name': 'customerName',
  'customer': 'customerName',
  'name': 'customerName',
  'company': 'customerName',
  // Customer ID
  'customer_id': 'customerId',
  'customer id': 'customerId',
  // Date
  'invoice_date': 'invoiceDate',
  'invoice date': 'invoiceDate',
  'date': 'invoiceDate',
  'created': 'invoiceDate',
  'created_at': 'invoiceDate',
  // Amount
  'amount_billed': 'amountBilled',
  'amount': 'amountBilled',
  'total': 'amountBilled',
  'total_amount': 'amountBilled',
  'amount_due': 'amountBilled',
  'subtotal': 'amountBilled',
  // Currency
  'currency': 'currency',
  'currency_code': 'currency',
  // Status
  'status': 'status',
  'invoice_status': 'status',
  // Contract ref
  'contract_ref': 'contractRef',
  'subscription_id': 'contractRef',
  'subscription id': 'contractRef',
  'contract': 'contractRef',
  // Invoice / line-item type — lets reconciler distinguish subscription from usage
  'type': 'invoiceType',
  'invoice_type': 'invoiceType',
  'line_item_type': 'invoiceType',
  'line item type': 'invoiceType',
  'charge_type': 'invoiceType',
  'charge type': 'invoiceType',
  'product_type': 'invoiceType',
  'product type': 'invoiceType',
  'description_type': 'invoiceType',
}

export function parseBillingCSV(csvText: string): BillingRecord[] {
  const lines = csvText.trim().split('\n')
  if (lines.length < 2) return []

  const rawHeaders = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''))
  const columnIndexes = buildColumnIndexes(rawHeaders)

  return lines.slice(1).map(line => {
    const cols = splitCSVLine(line)
    return {
      invoiceId: cols[columnIndexes.invoiceId ?? -1] ?? crypto.randomUUID(),
      customerName: cols[columnIndexes.customerName ?? -1] ?? '',
      customerId: cols[columnIndexes.customerId ?? -1] ?? undefined,
      invoiceDate: parseDate(cols[columnIndexes.invoiceDate ?? -1] ?? ''),
      amountBilled: parseAmount(cols[columnIndexes.amountBilled ?? -1] ?? '0'),
      currency: (cols[columnIndexes.currency ?? -1] ?? 'USD').toUpperCase(),
      status: cols[columnIndexes.status ?? -1] ?? 'paid',
      contractRef: cols[columnIndexes.contractRef ?? -1] ?? undefined,
      invoiceType: cols[(columnIndexes as Record<string, number>).invoiceType ?? -1] ?? undefined,
    }
  }).filter(r => r.customerName || r.invoiceId)
}

function buildColumnIndexes(headers: string[]): Partial<Record<keyof BillingRecord, number>> {
  const result: Partial<Record<keyof BillingRecord, number>> = {}
  headers.forEach((header, idx) => {
    const normalized = header.toLowerCase().trim()
    const field = COLUMN_MAP[normalized]
    if (field && !(field in result)) {
      (result as Record<string, number>)[field] = idx
    }
  })
  return result
}

function parseAmount(raw: string): number {
  if (!raw) return 0
  // Strip currency symbols, thousands separators, extra whitespace
  const cleaned = raw.trim().replace(/^"|"$/g, '').replace(/[£€$¥₹]/g, '').replace(/,/g, '').trim()
  const n = parseFloat(cleaned)
  return isNaN(n) ? 0 : n
}

function parseDate(raw: string): Date {
  if (!raw) return new Date()
  const cleaned = raw.trim().replace(/^"|"$/g, '')
  // Try ISO first, then various locale formats
  const iso = new Date(cleaned)
  if (!isNaN(iso.getTime())) return iso
  // DD/MM/YYYY
  const ddmmyyyy = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (ddmmyyyy) return new Date(`${ddmmyyyy[3]}-${ddmmyyyy[2].padStart(2,'0')}-${ddmmyyyy[1].padStart(2,'0')}`)
  return new Date()
}

function splitCSVLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++ }
      else inQuotes = !inQuotes
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  result.push(current.trim())
  return result
}
