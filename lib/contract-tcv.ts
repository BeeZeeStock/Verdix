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
import { computeBaseTcv, type BaseTcvItem } from '@/lib/contract-tcv-calc'
import { computeContractValueModel, type ContractValueTier } from '@/lib/contract-value'
import { isChangeOrderConditional } from '@/lib/billability-condition'
import type { BillabilityCondition } from '@/lib/types'
export { computeBaseTcv, computeCommittedContractValue, contractLifecycleStatus, isEscalatorItem } from '@/lib/contract-tcv-calc'
export type { BaseTcvItem, ContractLifecycleStatus } from '@/lib/contract-tcv-calc'

export type ContractSummary = {
  customer_name: string | null
  /** "Potential fixed fees" — sum of confirmed non-escalator line items,
   *  INCLUDING any fee still conditional on an unsigned future Change
   *  Order. Kept as-is (unchanged meaning/name) for existing compact-table
   *  consumers ("New contracts" list, Agreements dashboard) — see
   *  committedFixedFees/conditionalFixedFees below for the split. */
  tcv: number
  /** @deprecated kept for existing callers during the terminology migration — identical to billedToDate + confirmed one-time additions folded in the old way. Prefer billedToDate/committedContractValue. */
  actualTcv: number
  billedToDate: number
  /** Committed fixed fees + confirmed minimum commitments — NEVER includes
   *  a fee still conditional on an unsigned future Change Order (Agreement
   *  A final amendment, item 2). This is the figure safe to label
   *  "committed" without qualification. */
  committedContractValue: number
  /** Committed fixed fees alone (no minimum commitments) — see
   *  lib/contract-tcv-calc.ts's computeCommittedFixedFees. */
  committedFixedFees: number
  /** Sum of fees still conditional on an unsigned future Change Order —
   *  shown separately, never folded into committedFixedFees/
   *  committedContractValue. */
  conditionalFixedFees: number
  /** committedFixedFees + conditionalFixedFees — equals tcv. Provided
   *  alongside the split so a caller never has to re-derive it. */
  potentialFixedFees: number
  currency: string
}

export async function getContractSummaries(jobIds: string[]): Promise<Record<string, ContractSummary>> {
  if (jobIds.length === 0) return {}
  const [{ data: termsData }, { data: lineItemsData }, { data: sentInvoicesData }, { data: billedRowsData }, { data: meterMappingsData }] = await Promise.all([
    supabaseServer
      .from('contract_terms')
      .select('job_id, customer_name, currency, contract_term_months, contract_start_date, contract_end_date, one_time_fees')
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

  // Agreement A final amendment (post-review correction) — the commercial-
  // item construction boundary. line_items rows carry no stable identity
  // back to a specific OneTimeFee (the line_items table has no fee_id
  // column), and matching them to contract_terms.one_time_fees by
  // product_name === fee_label was rejected: display labels are not stable
  // commercial identity — that's exactly why OneTimeFee.fee_id exists (Step
  // 13) — two fees can legitimately share a label, and a label match would
  // silently misclassify one of them in a FINANCIAL total. Instead: exclude
  // one-time rows from line_items entirely (a category filter on
  // billing_period, not an identity match) and rebuild the one-time portion
  // DIRECTLY from contract_terms.one_time_fees, which already carries
  // amount and billability_condition natively — no matching needed at all.
  // Recurring rows need no classification either: Change-Order
  // conditionality only ever applies to one_time_fees in this domain model
  // (see isChangeOrderConditional), so every recurring row is committed by
  // construction. computeCommittedFixedFees/computeConditionalFixedFees
  // themselves stay dumb summations — they never import
  // billability-condition.ts; only this construction boundary does.
  type LI = BaseTcvItem
  const recurringLineItemsByJob: Record<string, LI[]> = {}
  for (const li of lineItemsData ?? []) {
    if (li.billing_period === 'one_time') continue
    ;(recurringLineItemsByJob[li.job_id] ??= []).push({
      product_name:  li.product_name  as string,
      applied_rule:  li.applied_rule  as string | null,
      total_amount:  li.total_amount  as number | null,
      billing_period: li.billing_period as string | null,
    })
  }
  const oneTimeItemsByJob: Record<string, LI[]> = {}
  for (const row of termsData ?? []) {
    const fees = (row.one_time_fees ?? []) as Array<{ fee_label?: string; amount?: number | null; billability_condition?: BillabilityCondition | null }>
    oneTimeItemsByJob[row.job_id as string] = fees.map(f => ({
      product_name: f.fee_label ?? '',
      applied_rule: null,
      total_amount: f.amount ?? 0,
      billing_period: 'one_time',
      commitmentStatus: isChangeOrderConditional(f.billability_condition) ? 'conditional_future_agreement' : 'committed',
    }))
  }
  const lineItemsByJob: Record<string, LI[]> = {}
  for (const jobId of new Set([...Object.keys(recurringLineItemsByJob), ...Object.keys(oneTimeItemsByJob)])) {
    lineItemsByJob[jobId] = [...(recurringLineItemsByJob[jobId] ?? []), ...(oneTimeItemsByJob[jobId] ?? [])]
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

  // One entry per METRIC (unit_type), not per raw tier row — a metric's
  // minimum_commitment/measurement_period/reset_anchor are duplicated onto
  // every tier row extraction wrote for it, so grouping by unit_type and
  // taking the first row avoids counting the same commitment's term-wide
  // schedule (see computeContractValueModel) more than once per metric.
  type MeterMappingTier = {
    unit_type?: string | null
    measurement_period?: string | null
    reset_anchor?: 'contract_start' | 'calendar' | null
    minimum_commitment?: { amount: number; prorate_partial_periods?: boolean | 'unclear'; requires_confirmation: boolean } | null
  }
  type MeterMappingRow = {
    job_id: string
    minimum_commitment_mode: string | null
    minimum_commitment_requires_confirmation: boolean | null
    overage_tiers: MeterMappingTier[] | null
  }
  const metricsByJob: Record<string, ContractValueTier[]> = {}
  for (const row of (meterMappingsData ?? []) as MeterMappingRow[]) {
    if (!row.minimum_commitment_mode) continue
    const seenUnitTypes = new Set<string>()
    for (const t of row.overage_tiers ?? []) {
      if (!t.minimum_commitment) continue
      const key = t.unit_type ?? ''
      if (seenUnitTypes.has(key)) continue
      seenUnitTypes.add(key)
      ;(metricsByJob[row.job_id] ??= []).push({
        measurement_period: t.measurement_period,
        reset_anchor: t.reset_anchor,
        minimum_commitment: t.minimum_commitment,
      })
    }
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

    const billedToDate = billedByJob[row.job_id] ?? 0
    const model = computeContractValueModel({
      items: jobItems,
      metrics: metricsByJob[row.job_id] ?? [],
      contractStartDate: (row.contract_start_date as string | null) ?? null,
      contractEndDate: (row.contract_end_date as string | null) ?? null,
      billedToDate,
    })

    map[row.job_id] = {
      customer_name: (row.customer_name as string | null) ?? null,
      tcv,
      actualTcv: tcv + additionsTotal,
      billedToDate,
      // Falls back to model.fixedFees (committed), never tcv (potential,
      // includes any conditional Change-Order fee) — the two only diverge
      // once a conditional fee exists, and a fallback must not silently
      // reintroduce the exact number this fix excludes.
      committedContractValue: model.committedContractValue ?? model.fixedFees,
      committedFixedFees: model.fixedFees,
      conditionalFixedFees: model.conditionalFixedFees,
      potentialFixedFees: model.potentialFixedFees,
      currency: (row.currency as string | null) ?? 'EUR',
    }
  }
  return map
}
