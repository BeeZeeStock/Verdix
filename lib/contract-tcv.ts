// Single source of truth for a contract's Base TCV and Actual TCV — used by
// the "New contracts" list, the Agreements dashboard, and (via the baseTcv
// prop) the per-job Contract·Commercials page, so all three always agree.
//
// Base TCV: the approved billing configuration (line_items) — total_amount
// × periods-in-term, excluding escalators (they modify a base rate, they
// aren't their own billable line).
// Actual TCV: Base TCV + additions — sent one-time invoices for variable
// fees (a line_items row with total_amount = 0, or no matching row at all,
// meaning the amount was only known once actually invoiced).
import { supabaseServer } from '@/lib/supabase'

export type ContractSummary = { customer_name: string | null; tcv: number; actualTcv: number; currency: string }

function isEscalatorItem(productName: string, appliedRule: string | null): boolean {
  const name = (productName ?? '').toLowerCase()
  const rule = (appliedRule ?? '').toLowerCase()
  return rule.includes('escalator') || name.includes('escalator') || name.includes('cpi') || name.includes('price escalator')
}

function periodsInTermFor(bp: string | null | undefined, termMonths: number): number {
  if (!termMonths) return 1
  if (bp === 'monthly')     return termMonths
  if (bp === 'quarterly')   return termMonths / 3
  if (bp === 'semi-annual') return termMonths / 6
  if (bp === 'annual')      return termMonths / 12
  return 1
}

export async function getContractSummaries(jobIds: string[]): Promise<Record<string, ContractSummary>> {
  if (jobIds.length === 0) return {}
  const [{ data: termsData }, { data: lineItemsData }, { data: sentInvoicesData }] = await Promise.all([
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

  const map: Record<string, ContractSummary> = {}
  for (const row of termsData ?? []) {
    const termMonths = (row.contract_term_months as number | null)
      ?? (row.contract_start_date && row.contract_end_date
        ? (new Date(row.contract_end_date as string).getFullYear() - new Date(row.contract_start_date as string).getFullYear()) * 12
          + (new Date(row.contract_end_date as string).getMonth() - new Date(row.contract_start_date as string).getMonth()) + 1
        : 0)

    const jobItems = lineItemsByJob[row.job_id] ?? []
    // A single line item per billing_period represents a steady recurring
    // rate — multiply by how many such periods fit in the term (legacy
    // convention). But buildLineItems generates one row *per contract year*
    // for multi-year deals ("Year 1 recurring fee", "Year 2 recurring fee",
    // ...) so escalators land on the right year — each of those rows is
    // already a complete, distinct occurrence, not a steady rate to repeat.
    // Multiplying it again by periodsInTermFor double(-or-more)-counts the
    // whole term. Only apply the multiplier when this billing_period has
    // exactly one line item; when several share it, sum them as-is.
    const countByPeriod = new Map<string, number>()
    for (const item of jobItems) {
      const key = item.billing_period ?? ''
      countByPeriod.set(key, (countByPeriod.get(key) ?? 0) + 1)
    }
    const tcv = jobItems.reduce((s, item) => {
      if (isEscalatorItem(item.product_name, item.applied_rule)) return s
      const sharesPeriodWithOthers = (countByPeriod.get(item.billing_period ?? '') ?? 0) > 1
      const multiplier = sharesPeriodWithOthers ? 1 : periodsInTermFor(item.billing_period, termMonths)
      return s + (item.total_amount ?? 0) * multiplier
    }, 0)

    const jobSent        = sentByJob[row.job_id] ?? []
    const additionsTotal = jobSent.reduce((s, inv) => {
      const matchingItem = jobItems.find(i => i.product_name === inv.fee_label)
      return s + ((!matchingItem || (matchingItem.total_amount ?? 0) === 0) ? inv.base_amount : 0)
    }, 0)

    map[row.job_id] = {
      customer_name: (row.customer_name as string | null) ?? null,
      tcv,
      actualTcv: tcv + additionsTotal,
      currency: (row.currency as string | null) ?? 'EUR',
    }
  }
  return map
}
