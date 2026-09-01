// Step E9C/E9C.1/E9C.2 — cross-org data fetching for the Dashboard's
// Billing Actions section. Thin orchestration only: every actual DECISION
// (is this row an action, what does it say, how is it prioritized, is a
// manual input actually due) lives in the pure, directly-tested lib/
// billing-actions.ts + lib/operational-action-due-state.ts — this file's
// only job is assembling the raw rows those modules need. Not unit-tested
// itself (supabaseServer-coupled — this codebase has no mocking
// convention for it); the pure modules carry the real test coverage, and
// lib/dashboard-billing-actions-org-isolation.test.ts (RLS-integration,
// opt-in) proves this file's own query scoping directly against a real
// database.
//
// Step E9C.1 §11 — EVERY query below is scoped to `jobIds`, itself
// derived from a SINGLE `.eq('org_id', orgId)` query at the very top —
// nothing here ever queries `planned_invoices`/`operational_input_period_
// values`/`usage_period_values`/`contract_meter_mappings`/`jobs` without
// going through that org-scoped allowlist first. The one per-job lookup
// inside the event-action loop below ALSO carries an explicit
// `.eq('org_id', orgId)` redundantly, even though `parkedJobId` is
// structurally guaranteed (by construction, never user input) to already
// be an org-scoped id — defense in depth.
//
// Step E9C.2 §1/§7 — two audited extensions over E9C.1:
//   (a) manual-input mechanisms now cover BOTH performance (percentage_of_
//       basis, via operational_input_period_values) AND usage-manual-
//       fallback (a flat rate_per_unit fee with a semantic_input_key that
//       has no CONFIRMED meter mapping, via usage_period_values) — the two
//       real, execution-gated mechanisms confirmed by reading lib/
//       performance-share-pull.ts and lib/usage-pull.ts respectively.
//       Rolling-band migrations and one_time_fees' own required_
//       operational_inputs are deliberately excluded — see this file's own
//       closing-report note: the former has a genuinely different
//       multi-window/three-way-fallback due-state shape, the latter has NO
//       runtime execution consumer at all (confirmed by grep — extraction-
//       time-only, documentary).
//   (b) the applicable source period for a component is no longer "the
//       most recently closed period" (which the E9C.2 audit found could
//       silently lose an OLDER unresolved requirement once a newer period
//       also closed) — it is now the OLDEST closed period with an
//       unresolved requirement, enumerated from the job's own real
//       planned_invoices schedule (never reconstructed cadence math).
import { supabaseServer } from '@/lib/supabase'
import { resolveOperationalEventEvidence } from '@/lib/operational-event-evidence'
import { loadActiveOperationalEventEvidence } from '@/lib/operational-event-evidence-loader'
import { unwrapEmbedded } from '@/lib/postgrest-helpers'
import { isMonetaryOperationalInput } from '@/lib/operational-data-inputs'
import {
  deriveInvoiceActions, deriveManualInputActions, deriveEventActions, combineBillingActions,
  resolveCustomerDisplayName,
  type BillingAction, type PlannedInvoiceActionRow, type ManualInputComponentRow, type EventActionRow,
} from '@/lib/billing-actions'
import { oldestUnresolvedPeriod, type ClosedPeriod } from '@/lib/operational-action-due-state'

type AdditionalRecurringFeeLike = {
  fee_label: string
  recurring_fee_id?: string | null
  rate_per_unit?: number | null
  semantic_input_key?: string | null
  percentage_of_basis?: {
    derived_metric: { numerator_input_key: string; denominator_input_key: string }
    basis_input_key: string
  } | null
}

export async function loadDashboardBillingActions(orgId: string): Promise<BillingAction[]> {
  // Step E9D §2/§9 — jobs.name is the UPLOADED FILENAME with its extension
  // stripped (confirmed by reading app/(dashboard)/configure/new/page.tsx's
  // own upload call: `name: file.name.replace(/\.[^/.]+$/, '')`) — never a
  // real customer/business name. contract_terms.customer_name is the real,
  // extracted business identity (lib/types.ts) and is preferred wherever
  // extraction has actually populated it; jobs.name is used ONLY as the
  // truthful fallback for a job with no contract_terms row yet (e.g. still
  // being reviewed) — never guessed from the filename text beyond that.
  const { data: jobRows } = await supabaseServer
    .from('jobs')
    .select('id, name, contract_terms(customer_name)')
    .eq('org_id', orgId)
  const jobs = jobRows ?? []
  const jobIds = jobs.map(j => j.id)
  const nameOf = new Map(jobs.map(j => {
    const terms = unwrapEmbedded(j.contract_terms as unknown as { customer_name?: string | null } | { customer_name?: string | null }[] | null)
    return [j.id, resolveCustomerDisplayName(terms?.customer_name, j.name as string)]
  }))
  if (jobIds.length === 0) return []

  const [
    { data: dueInvoiceRows },
    { data: allPeriodRows },
    { data: inputValueRows },
    { data: usageValueRows },
    { data: meterMappingRows },
    { data: parkedOneTimeRows },
    { data: contractTermsRows },
  ] = await Promise.all([
    // Step §26 — only 'scheduled'/'failed' are ever candidates for a
    // Billing Action (paid/open/sent/void/canceled excluded at the query
    // level, not just by the pure classifier downstream — defense in
    // depth, never relies on one layer alone).
    supabaseServer
      .from('planned_invoices')
      .select('id, job_id, status, error_message, invoice_type, period_start, period_end')
      .in('job_id', jobIds)
      .in('status', ['scheduled', 'failed']),
    // Step E9C.1/E9C.2 §1/§7 — every ordinary period invoice row for
    // these jobs, used to enumerate each job's own real, already-
    // materialized closed-period schedule (arrears: period N's
    // performance/usage is what's due once period N+1 exists; a PARKED
    // invoice's own "prior period" is the same relationship app/api/
    // admin/invoice-scheduler/route.ts's own arrears scan uses) — never
    // reconstructed cadence/anchor math.
    supabaseServer
      .from('planned_invoices')
      .select('job_id, period_start, period_end')
      .in('job_id', jobIds)
      .eq('invoice_type', 'period')
      .lt('period_end', new Date().toISOString().slice(0, 10))
      .order('period_end', { ascending: true }),
    supabaseServer
      .from('operational_input_period_values')
      .select('job_id, input_key, period_start, period_end, status, finalized_at')
      .in('job_id', jobIds)
      .eq('status', 'active'),
    // Step E9C.2 §1 — the usage-manual-fallback mechanism's OWN table
    // (lib/usage-quantity-resolver.ts's resolveUsageQuantityForPeriod
    // reads this, NEVER operational_input_period_values — confirmed by
    // reading; these are two structurally distinct manual-entry systems).
    supabaseServer
      .from('usage_period_values')
      .select('job_id, semantic_input_key, period_start, period_end, status, finalized_at')
      .in('job_id', jobIds)
      .eq('status', 'active'),
    // Step E9C.2 §1 — a semantic_input_key is genuinely manual-fallback-
    // eligible only when NO confirmed meter mapping supplies it — the
    // SAME confirmed+meter_key check lib/usage-pull.ts's real pull path
    // relies on (contract_meter_mappings.confirmed = true).
    supabaseServer
      .from('contract_meter_mappings')
      .select('job_id, semantic_input_key, meter_key, confirmed')
      .in('job_id', jobIds),
    supabaseServer
      .from('planned_invoices')
      .select('id, job_id, fee_id, fee_label, created_at')
      .in('job_id', jobIds)
      .eq('invoice_type', 'one_time')
      .eq('status', 'parked'),
    // Step E9C.1 §1/§9 — additional_recurring_fees (percentage_of_basis
    // configs, flat rate_per_unit/semantic_input_key configs, and
    // recurring_fee_id) is the SAME contract-derived source lib/pricing-
    // dependency.ts's buildPricingDependencyGroups and app/api/jobs/[id]/
    // performance-share/route.ts already read — reused directly, never
    // re-extracted or guessed.
    supabaseServer
      .from('jobs')
      .select('id, contract_terms(additional_recurring_fees)')
      .in('id', jobIds),
  ])

  // Step E9C.2 §7 — ascending per job (query already ordered ascending;
  // grouped here so callers can find "the oldest unresolved" cheaply).
  const closedPeriodsByJob = new Map<string, ClosedPeriod[]>()
  for (const r of allPeriodRows ?? []) {
    const jobId = r.job_id as string
    const list = closedPeriodsByJob.get(jobId)
    const period = { periodStart: r.period_start as string, periodEnd: r.period_end as string }
    if (list) list.push(period)
    else closedPeriodsByJob.set(jobId, [period])
  }

  // Step E9C.2 §10 — for each PARKED invoice candidate, its own prior
  // closed period (largest period_end < this row's own period_start) —
  // the IDENTICAL relationship invoice-scheduler's own arrears scan uses,
  // computed here from the SAME closedPeriodsByJob data (no second query).
  function priorPeriodFor(jobId: string, periodStart: string): ClosedPeriod | null {
    const periods = closedPeriodsByJob.get(jobId) ?? []
    let best: ClosedPeriod | null = null
    for (const p of periods) {
      if (p.periodEnd < periodStart && (!best || p.periodEnd > best.periodEnd)) best = p
    }
    return best
  }

  const invoiceActionRows: PlannedInvoiceActionRow[] = (dueInvoiceRows ?? []).map(r => {
    const jobId = r.job_id as string
    const periodStart = r.period_start as string
    const prior = priorPeriodFor(jobId, periodStart)
    return {
      id: r.id as string, jobId, customerName: nameOf.get(jobId) ?? 'Unknown contract',
      invoiceType: r.invoice_type as string, status: r.status as string, errorMessage: r.error_message as string | null,
      periodStart, periodEnd: r.period_end as string,
      priorPeriodStart: prior?.periodStart, priorPeriodEnd: prior?.periodEnd,
    }
  })

  // Step E9C.1 §3/§4 — finalized/draft key sets, scoped to the EXACT
  // (job, period) pair classifyOperationalActionState will be asked
  // about — an input value row for a DIFFERENT period never counts
  // toward this period's own required-key resolution. Two independent
  // sets: operational_input_period_values (performance) and
  // usage_period_values (usage-manual-fallback) — never merged, since a
  // key in one table has no relationship to a key in the other.
  function buildKeySets<T extends { job_id: unknown; period_start: unknown; period_end: unknown; status: unknown; finalized_at: unknown }>(
    rows: T[], keyField: (r: T) => string,
  ): { finalized: Map<string, Set<string>>; draft: Map<string, Set<string>> } {
    const finalized = new Map<string, Set<string>>()
    const draft = new Map<string, Set<string>>()
    for (const r of rows) {
      const pKey = `${r.job_id}:${r.period_start}:${r.period_end}`
      const target = r.finalized_at ? finalized : draft
      const set = target.get(pKey)
      if (set) set.add(keyField(r))
      else target.set(pKey, new Set([keyField(r)]))
    }
    return { finalized, draft }
  }
  const opInput = buildKeySets(inputValueRows ?? [], r => r.input_key as string)
  const usageInput = buildKeySets(usageValueRows ?? [], r => r.semantic_input_key as string)

  // Step E9C.2 §1 — confirmed, real meter-backed semantic_input_keys per
  // job — anything NOT in this set (but referenced by a fee) is genuinely
  // manual-fallback-eligible, mirroring lib/usage-pull.ts's own
  // `!cfg.meter_key` branch condition.
  const meterConfirmedKeysByJob = new Map<string, Set<string>>()
  for (const r of meterMappingRows ?? []) {
    if (!r.confirmed || !r.meter_key || !r.semantic_input_key) continue
    const jobId = r.job_id as string
    const set = meterConfirmedKeysByJob.get(jobId)
    if (set) set.add(r.semantic_input_key as string)
    else meterConfirmedKeysByJob.set(jobId, new Set([r.semantic_input_key as string]))
  }

  const manualInputRows: ManualInputComponentRow[] = []
  for (const jobRow of contractTermsRows ?? []) {
    const jobId = jobRow.id as string
    const periods = closedPeriodsByJob.get(jobId)
    if (!periods || periods.length === 0) continue // no closed period yet — nothing can be due (§9)
    const contractTerms = unwrapEmbedded(jobRow.contract_terms as unknown as { additional_recurring_fees?: AdditionalRecurringFeeLike[] } | { additional_recurring_fees?: AdditionalRecurringFeeLike[] }[] | null)
    const fees = contractTerms?.additional_recurring_fees ?? []
    const customerName = nameOf.get(jobId) ?? 'Unknown contract'

    for (const fee of fees) {
      if (fee.percentage_of_basis) {
        // ── Performance mechanism ──
        const config = fee.percentage_of_basis
        // Step E9C.1 §9 — only MONETARY required inputs need manual entry
        // via operational_input_period_values (the same distinction lib/
        // performance-share-pull.ts's own findMonetaryCurrencyProblem
        // call makes) — a non-monetary (countable) required key isn't
        // this action type's concern.
        const requiredKeys = [config.derived_metric.numerator_input_key, config.derived_metric.denominator_input_key, config.basis_input_key]
          .filter(isMonetaryOperationalInput)
        if (requiredKeys.length === 0) continue
        const period = oldestUnresolvedPeriod(periods, p => {
          const pKey = `${jobId}:${p.periodStart}:${p.periodEnd}`
          const finalizedKeys = opInput.finalized.get(pKey) ?? new Set<string>()
          return requiredKeys.every(k => finalizedKeys.has(k))
        })
        if (!period) continue
        const pKey = `${jobId}:${period.periodStart}:${period.periodEnd}`
        manualInputRows.push({
          jobId, customerName, componentLabel: fee.fee_label, recurringFeeId: fee.recurring_fee_id ?? null,
          mechanismKind: 'performance',
          periodStart: period.periodStart, periodEnd: period.periodEnd,
          requiredKeys,
          finalizedKeys: [...(opInput.finalized.get(pKey) ?? [])],
          draftKeys: [...(opInput.draft.get(pKey) ?? [])],
        })
      } else if (typeof fee.rate_per_unit === 'number' && fee.rate_per_unit > 0 && fee.semantic_input_key) {
        // ── Usage-manual-fallback mechanism ──
        // Step E9C.2 §1 — a flat usage fee whose semantic_input_key has
        // NO confirmed meter mapping is exactly lib/usage-pull.ts's
        // `!cfg.meter_key && cfg.semantic_input_key` manual-fallback
        // branch (the E9B fix's own throw site) — never checked for a
        // meter-backed key, which is a completely different, non-manual
        // execution path.
        const confirmedKeys = meterConfirmedKeysByJob.get(jobId)
        if (confirmedKeys?.has(fee.semantic_input_key)) continue
        const requiredKeys = [fee.semantic_input_key]
        const period = oldestUnresolvedPeriod(periods, p => {
          const pKey = `${jobId}:${p.periodStart}:${p.periodEnd}`
          const finalizedKeys = usageInput.finalized.get(pKey) ?? new Set<string>()
          return requiredKeys.every(k => finalizedKeys.has(k))
        })
        if (!period) continue
        const pKey = `${jobId}:${period.periodStart}:${period.periodEnd}`
        manualInputRows.push({
          jobId, customerName, componentLabel: fee.fee_label, recurringFeeId: fee.recurring_fee_id ?? null,
          mechanismKind: 'usage_manual_fallback',
          periodStart: period.periodStart, periodEnd: period.periodEnd,
          requiredKeys,
          finalizedKeys: [...(usageInput.finalized.get(pKey) ?? [])],
          draftKeys: [...(usageInput.draft.get(pKey) ?? [])],
        })
      }
    }
  }

  // Step §2.E/§2.F — resolves satisfaction via the SAME
  // resolveOperationalEventEvidence function billing-summary/route.ts and
  // ParkedInvoicesCard already use — never a second, independently-
  // derived answer to "is this event confirmed." Bounded N+1 (one
  // contract_terms + one evidence load per JOB that currently has a
  // parked one-time fee, not per org job).
  const jobIdsWithParkedFees = [...new Set(
    (parkedOneTimeRows ?? []).filter(r => r.fee_id).map(r => r.job_id as string),
  )]
  const eventActionRows: EventActionRow[] = []
  for (const parkedJobId of jobIdsWithParkedFees) {
    const rowsForJob = (parkedOneTimeRows ?? []).filter(r => r.job_id === parkedJobId && r.fee_id)
    // Step §11 — redundant org_id check (see this file's own header).
    const { data: job } = await supabaseServer
      .from('jobs')
      .select('contract_terms(one_time_fees)')
      .eq('id', parkedJobId)
      .eq('org_id', orgId)
      .maybeSingle()
    const contractTerms = unwrapEmbedded(job?.contract_terms as unknown as { one_time_fees?: Array<{ fee_id?: string; billability_condition?: unknown }> } | { one_time_fees?: Array<{ fee_id?: string; billability_condition?: unknown }> }[] | null)
    const feesArray = contractTerms?.one_time_fees ?? []
    const evidence = await loadActiveOperationalEventEvidence(parkedJobId)
    for (const row of rowsForJob) {
      const termFee = feesArray.find(f => f.fee_id === row.fee_id)
      const condition = termFee?.billability_condition as Parameters<typeof resolveOperationalEventEvidence>[0]['condition']
      const result = resolveOperationalEventEvidence({ condition, subjectId: row.fee_id as string, evidence, asOf: new Date() })
      if (!result.required) continue
      eventActionRows.push({
        id: row.id as string, jobId: row.job_id as string, customerName: nameOf.get(row.job_id as string) ?? 'Unknown contract',
        feeLabel: row.fee_label as string | null, satisfied: result.satisfied, createdAt: row.created_at as string,
      })
    }
  }

  return combineBillingActions(
    deriveInvoiceActions(invoiceActionRows),
    deriveManualInputActions(manualInputRows),
    deriveEventActions(eventActionRows),
  )
}
