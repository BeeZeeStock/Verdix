// Step 14 — the immutable "what Verdix intends to send downstream right
// now" snapshot, and its deterministic fingerprint. Deliberately reuses the
// EXACT computation that already decides what a real push sends
// (computeBillingSchedule's due-period gate, isOneTimeFeeHeldForExecution's
// held/execute decision, the already-sent dedupe check) rather than
// inventing a second, parallel billing representation that could silently
// disagree with what billing-writer.ts actually executes — this module's
// buildBillingPlanSnapshot is the single source of truth both the
// fingerprint and the real execution loop are built from.
import { createHash } from 'node:crypto'
import type { ContractTerms } from './types'
import { isOneTimeFeeHeldForExecution, type OperationalEventEvidence } from './operational-event-evidence'
import type { LineItemInput } from './billing-writer'
import type { VatMode } from './vat'

export type BillingPlanLineKind = 'period' | 'one_time_fee'

export interface BillingPlanLineInstruction {
  kind: BillingPlanLineKind
  // Stable, content-derived component identity — never a random id. Periods
  // key on (yearNum, periodIndex); one-time fees key on fee_label (the same
  // addressing key billing-writer.ts's own alreadySent dedupe already uses).
  componentKey: string
  amount: number
  currency: string
  quantity: number
  unitPrice: number | null
  dueDate: string | null
  vatMode: VatMode
  vatRatePct: number | null
}

export interface BillingPlanSnapshot {
  provider: 'stripe' | 'remembill' | 'chargebee'
  currency: string
  // Derived from stable, human-entered identity fields (name + org number),
  // never a database id — represents "which customer this plan targets" so
  // a plan retargeted at a genuinely different customer also fingerprints
  // differently. Never the customer's own email/address (not needed to
  // distinguish plans, and keeps the snapshot free of anything beyond what
  // billing already requires).
  customerIdentityKey: string
  lines: BillingPlanLineInstruction[]
}

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Same addressing key billing-writer.ts's own "alreadySent" dedupe already
// uses for each row shape — kept here so both the plan builder and the
// caller computing `alreadySentKeys` from planned_invoices agree on exactly
// one definition.
export function planComponentKey(
  row: { invoice_type: string; year_num: number | null; period_start: string | null; fee_label: string | null },
): string {
  return row.invoice_type === 'period'
    ? `period:${row.year_num}:${row.period_start}`
    : `one_time_fee:${row.fee_label}`
}

interface VatResolution {
  mode: VatMode
  ratePct: number | null
}

/**
 * Builds the deterministic snapshot of every operation Verdix intends to
 * send downstream RIGHT NOW — never a random/timestamped artifact. Two
 * calls with identical terms/lineItems/evidence/alreadySentKeys/vat/`now`
 * (rounded to the day, since `now` only ever gates isDue at day
 * granularity in the existing schedule logic) produce byte-identical
 * snapshots and therefore identical fingerprints.
 */
export function buildBillingPlanSnapshot(params: {
  terms: ContractTerms
  lineItems: LineItemInput[]
  evidence: OperationalEventEvidence[]
  alreadySentKeys: Set<string>
  provider: 'stripe' | 'remembill' | 'chargebee'
  vat: VatResolution
  now: Date
  computeBillingSchedule: (terms: ContractTerms) => Array<{ yearNum: number; periodIndex: number; periodStart: Date; periodEnd: Date; baseAmount: number }>
}): BillingPlanSnapshot {
  const { terms, lineItems, evidence, alreadySentKeys, provider, vat, now, computeBillingSchedule } = params
  const currency = (terms.currency ?? (provider === 'remembill' ? 'SEK' : 'EUR')).toUpperCase()
  const customerIdentityKey = createHash('sha256')
    .update(JSON.stringify({ name: terms.customer_name ?? null, orgNumber: terms.customer_org_number ?? null }))
    .digest('hex').slice(0, 16)

  const lines: BillingPlanLineInstruction[] = []

  for (const period of computeBillingSchedule(terms)) {
    const key = `period:${period.yearNum}:${fmtDate(period.periodStart)}`
    if (alreadySentKeys.has(key)) continue
    if (!(period.periodStart <= now && period.baseAmount > 0)) continue
    lines.push({
      kind: 'period',
      componentKey: `period:${period.yearNum}:${period.periodIndex}`,
      amount: Math.round(period.baseAmount * 100) / 100,
      currency, quantity: 1, unitPrice: null,
      dueDate: fmtDate(period.periodStart),
      vatMode: vat.mode, vatRatePct: vat.ratePct,
    })
  }

  const oneTimeFees = terms.one_time_fees ?? []
  for (const fee of oneTimeFees) {
    if (fee.amount <= 0) continue
    const key = `one_time_fee:${fee.fee_label}`
    if (alreadySentKeys.has(key)) continue
    if (isOneTimeFeeHeldForExecution(fee, evidence, now)) continue
    const feeDueDate = fee.due_date ? new Date(fee.due_date + 'T00:00:00') : null
    const isDue = !feeDueDate || feeDueDate <= now
    if (!isDue) continue
    const li = lineItems.find(l => l.billing_period === 'one_time' && l.product_name === fee.fee_label) ?? null
    const amount = li?.total_amount ?? fee.amount
    const hasBreakdown = !!li && li.quantity > 0 && li.unit_price > 0
    lines.push({
      kind: 'one_time_fee',
      componentKey: `fee:${fee.fee_label}`,
      amount: Math.round(amount * 100) / 100,
      currency,
      quantity: hasBreakdown ? li!.quantity : 1,
      unitPrice: hasBreakdown ? li!.unit_price : null,
      dueDate: fmtDate(feeDueDate ?? now),
      vatMode: vat.mode, vatRatePct: vat.ratePct,
    })
  }

  lines.sort((a, b) => a.componentKey.localeCompare(b.componentKey))
  return { provider, currency, customerIdentityKey, lines }
}

// Step 14 final state-integrity correction — a snapshot's own `lines[]`
// use the index-based componentKey form (`period:{yearNum}:{periodIndex}`,
// `fee:{label}`), but the alreadySentKeys exclusion set this module reads
// (and planned_invoices' own dedupe, via planComponentKey above) uses a
// date-based form for periods (`period:{yearNum}:{periodStartDate}`,
// `one_time_fee:{label}`). This converts a snapshot's lines into THAT
// second form, so a caller can reconstruct "what would still count as
// already-sent if this specific snapshot's own lines were excluded from
// the exclusion set" — see recomputeFingerprintExcludingPriorSnapshot's
// doc comment on getOrCreateAttempt for why that reconstruction matters:
// once a prior attempt succeeds, its own sends immediately shrink any
// freshly-recomputed "what's due right now" fingerprint, even when the
// underlying commercial data never changed.
export function planComponentKeysInSnapshot(snapshot: BillingPlanSnapshot): Set<string> {
  const keys = new Set<string>()
  for (const line of snapshot.lines) {
    if (line.kind === 'period') {
      const yearNum = line.componentKey.split(':')[1]
      keys.add(`period:${yearNum}:${line.dueDate}`)
    } else {
      keys.add(`one_time_fee:${line.componentKey.slice(4)}`)
    }
  }
  return keys
}

/**
 * Deterministic, stable serialization — sorted object keys throughout (the
 * snapshot's own values are already primitives/arrays of primitives, but
 * this guards against any future field addition silently making the
 * fingerprint depend on property insertion order) — then sha256. No
 * generated_at, no random id, no request timestamp: two snapshots that
 * represent the same intended billing instruction always fingerprint
 * identically, and any change to amount/component/tax/currency/instruction
 * always fingerprints differently (proven directly in the test file).
 */
export function fingerprintBillingPlan(snapshot: BillingPlanSnapshot): string {
  const canonical = canonicalStringify(snapshot)
  return createHash('sha256').update(canonical).digest('hex')
}

function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort()
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalStringify((value as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

// Item 5 — "do not persist sensitive request bodies merely for convenience
// if a deterministic safe snapshot/fingerprint is sufficient". Generic
// version of fingerprintBillingPlan's canonical-serialize-then-hash for any
// individual operation's own request parameters (never secrets — callers
// pass only the non-sensitive fields that actually vary the request, e.g.
// amount/currency/description, never an API key).
export function fingerprintValue(value: unknown): string {
  return createHash('sha256').update(canonicalStringify(value)).digest('hex')
}
