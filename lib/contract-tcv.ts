// Single source of truth for a contract's commercial-value figures — used by
// the "New contracts" list, the Agreements dashboard, and (via the baseTcv
// prop) the per-job Contract·Commercials page, so all three always agree.
// Terminology (see the terminology-standardisation plan):
//
// Fixed fees (formerly "Base TCV"): the approved billing configuration
// (line_items) — sum of every row's total_amount (each row already holds
// its full, pre-multiplied contribution to the term — see computeBaseTcv),
// excluding escalators (they modify a base rate, they aren't their own
// billable line).
// Committed contract value: Fixed fees + every minimum commitment that has
// actually been confirmed by a reviewer (see computeCommittedContractValue)
// — unconfirmed/ambiguous minimums are excluded, never guessed.
// Billed to date: the canonical, connector-agnostic figure — every
// planned_invoices row actually sent or paid (works identically for Stripe
// and Remembill, unlike the older Stripe-invoice-status-gated version this
// replaces). "Additions" (sent one-time invoices with no matching/zero-value
// line item) are the variable-fee subset of this same figure.
// Realised TCV: once a contract's own end date has passed, its final total
// — this is billed_to_date under a different label once nothing further
// will ever be invoiced against it; see contractLifecycleStatus.
import { supabaseServer } from '@/lib/supabase'
import { computeBaseTcv, computeCommittedContractValue, type ConfirmedMinimumCommitment } from '@/lib/contract-tcv-calc'
export { computeBaseTcv, computeCommittedContractValue, contractLifecycleStatus, isEscalatorItem } from '@/lib/contract-tcv-calc'
export type { BaseTcvItem, ContractLifecycleStatus } from '@/lib/contract-tcv-calc'

export type ContractSummary = {
  customer_name: string | null
  /** Fixed fees — sum of confirmed non-escalator line items. */
  tcv: number
  /** @deprecated kept for existing callers during the terminology migration — identical to billedToDate + confirmed one-time additions folded in the old way. Prefer billedToDate/committedContractValue. */
  actualTcv: number
  billedToDate: number
  committedContractValue: number
  currency: string
}

export async function getContractSummaries(jobIds: string[]): Promise<Record<string, ContractSummary>> {
  if (jobIds.length === 0) return {}
  const [{ data: termsData }, { data: lineItemsData }, { data: sentInvoicesData }, { data: billedRowsData }, { data: meterMappingsData }] = await Promise.all([
    supabaseServer
      .from('contract_terms')
      .select('job_id, customer_name, currency, contract_term_months, contract_start_date, contract_end_date')
      .in('job_id', jobIds),
    supabaseServer
      .from('line_items')
      .select('job_id, product_name, applied_rule, total_amount, billing_period')
      .in('job_id', jobIds),
    supabaseServer
      .from('planned_invoices')
      .select('job_id, fee_label, base_amount')
      .in('job_id', jobIds)
      .eq('status', 'sent')
      .eq('invoice_type', 'one_time'),
    // Canonical billed-to-date source — every sent/paid invoice regardless
    // of invoice_type or which connector (Stripe/Remembill) issued it.
    supabaseServer
      .from('planned_invoices')
      .select('job_id, base_amount')
      .in('job_id', jobIds)
      .in('status', ['sent', 'paid']),
    supabaseServer
      .from('contract_meter_mappings')
      .select('job_id, minimum_commitment_mode, minimum_commitment_requires_confirmation, overage_tiers')
      .in('job_id', jobIds)
      .eq('confirmed', true),
  ])

  type LI = { product_name: string; applied_rule: string | null; total_amount: number | null; billing_period: string | null }
  const lineItemsByJob: Record<string, LI[]> = {}
  for (const li of lineItemsData ?? []) {
    ;(lineItemsByJob[li.job_id] ??= []).push({
      product_name:  li.product_name  as string,
      applied_rule:  li.applied_rule  as string | null,
      total_amount:  li.total_amount  as number | null,
      billing_period: li.billing_period as string | null,
    })
  }

  const sentByJob: Record<string, Array<{ fee_label: string | null; base_amount: number }>> = {}
  for (const inv of sentInvoicesData ?? []) {
    ;(sentByJob[inv.job_id] ??= []).push({
      fee_label:   inv.fee_label   as string | null,
      base_amount: (inv.base_amount as number | null) ?? 0,
    })
  }

  const billedByJob: Record<string, number> = {}
  for (const row of billedRowsData ?? []) {
    billedByJob[row.job_id] = (billedByJob[row.job_id] ?? 0) + Number(row.base_amount ?? 0)
  }

  type MeterMappingRow = {
    job_id: string
    minimum_commitment_mode: string | null
    minimum_commitment_requires_confirmation: boolean | null
    overage_tiers: Array<{ minimum_commitment?: { amount: number } | null; minimum_period_amount?: number | null }> | null
  }
  const minimumsByJob: Record<string, ConfirmedMinimumCommitment[]> = {}
  for (const row of (meterMappingsData ?? []) as MeterMappingRow[]) {
    if (!row.minimum_commitment_mode) continue
    const amount = (row.overage_tiers ?? []).reduce(
      (max, t) => Math.max(max, t.minimum_commitment?.amount ?? t.minimum_period_amount ?? 0),
      0,
    )
    if (amount <= 0) continue
    ;(minimumsByJob[row.job_id] ??= []).push({
      amount,
      requires_confirmation: row.minimum_commitment_requires_confirmation ?? false,
    })
  }

  const map: Record<string, ContractSummary> = {}
  for (const row of termsData ?? []) {
    const jobItems = lineItemsByJob[row.job_id] ?? []
    const tcv = computeBaseTcv(jobItems)

    const jobSent        = sentByJob[row.job_id] ?? []
    const additionsTotal = jobSent.reduce((s, inv) => {
      const matchingItem = jobItems.find(i => i.product_name === inv.fee_label)
      return s + ((!matchingItem || (matchingItem.total_amount ?? 0) === 0) ? inv.base_amount : 0)
    }, 0)

    map[row.job_id] = {
      customer_name: (row.customer_name as string | null) ?? null,
      tcv,
      actualTcv: tcv + additionsTotal,
      billedToDate: billedByJob[row.job_id] ?? 0,
      committedContractValue: computeCommittedContractValue(jobItems, minimumsByJob[row.job_id] ?? []),
      currency: (row.currency as string | null) ?? 'EUR',
    }
  }
  return map
}
