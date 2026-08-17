/**
 * POST /api/jobs/[id]/confirm-rule
 *
 * The approval + propagation step. This is the ONLY endpoint that may turn
 * a reviewer's free-text instruction (or structured choice) into executable
 * billing logic — it always requires `approvedInterpretation`, which only
 * ever reaches the client via /interpret-rule's response or the reviewer's
 * own structured-option selection. No endpoint lets client-supplied text
 * write directly to billing data.
 *
 * Propagation sequence (each step's outcome tracked so a partial failure is
 * visible and retryable rather than silently reported as fully "Applied"):
 *   1. Insert a new commercial_rule_interpretations row (append-only —
 *      supersedes the prior current row via is_current, never overwrites it).
 *   2. Write the approved structured data into contract_terms (what the
 *      Review panel and Commercial Terms section read).
 *   3. Mirror the same write into contract_meter_mappings when a confirmed
 *      mapping already exists for the metric (closes the exact dual-write
 *      gap the Fenix bug exposed — usage-pull.ts's real billing computation
 *      reads contract_meter_mappings, not contract_terms).
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { auth } from '@/lib/auth'
import type { RuleType } from '@/lib/rule-interpretation'
import type { MinimumCommitment, EscalatorInterpretation, DiscountInterpretation, TierCalculationMethod, ServiceCreditInterpretation } from '@/lib/types'

type Body = {
  ruleType: RuleType
  contractUnitType?: string
  sourceClause?: string | null
  reviewerInput: string
  aiProposedInterpretation: Record<string, unknown> | null
  approvedInterpretation: Record<string, unknown>
  // Which discount this confirmation targets, when ruleType is 'discount'.
  discountId?: string
  // Same addressing pattern as discountId, for ruleType 'service_credit'.
  creditId?: string
  // Composite key from lib/rule-interactions.ts, for ruleType 'rule_interaction'.
  interactionKey?: string
}

function buildTierCalculation(approved: Record<string, unknown>): TierCalculationMethod {
  return {
    method: (approved.method as TierCalculationMethod['method']) ?? 'graduated',
    source_clause: (approved.source_clause as string | undefined) ?? null,
    requires_confirmation: false,
    confirmation_reason: null,
  }
}

function buildServiceCreditInterpretation(approved: Record<string, unknown>, existing: ServiceCreditInterpretation | null | undefined): ServiceCreditInterpretation {
  return {
    trigger_type: (approved.trigger_type as ServiceCreditInterpretation['trigger_type']) ?? existing?.trigger_type ?? 'other',
    trigger_description: (approved.trigger_description as string | null) ?? existing?.trigger_description ?? null,
    credit_basis: (approved.credit_basis as ServiceCreditInterpretation['credit_basis']) ?? existing?.credit_basis ?? 'flat_amount',
    basis_component: (approved.basis_component as string | null) ?? existing?.basis_component ?? null,
    credit_value: typeof approved.credit_value === 'number' ? approved.credit_value : existing?.credit_value ?? null,
    currency: existing?.currency ?? null,
    cap_amount: (approved.cap_amount as number | null) ?? existing?.cap_amount ?? null,
    cap_pct: (approved.cap_pct as number | null) ?? existing?.cap_pct ?? null,
    settlement_period: (approved.settlement_period as ServiceCreditInterpretation['settlement_period']) ?? existing?.settlement_period ?? null,
    cash_redeemable: typeof approved.cash_redeemable === 'boolean' ? approved.cash_redeemable : existing?.cash_redeemable ?? false,
    interaction_note: existing?.interaction_note ?? null,
    source_clause: (approved.source_clause as string | undefined) ?? existing?.source_clause ?? null,
    requires_confirmation: false,
    confirmation_reason: null,
  }
}

type PropagationStatus = Record<string, 'applied' | 'failed' | 'skipped'>

function buildMinimumCommitment(approved: Record<string, unknown>, existing: MinimumCommitment | null | undefined): MinimumCommitment {
  return {
    mode: (approved.mode as MinimumCommitment['mode']) ?? existing?.mode ?? 'floor',
    amount: typeof approved.amount === 'number' ? approved.amount : existing?.amount ?? 0,
    currency: existing?.currency ?? null,
    period: (approved.period as MinimumCommitment['period']) ?? existing?.period ?? null,
    included_allowance_interaction: (approved.included_allowance_interaction as MinimumCommitment['included_allowance_interaction']) ?? existing?.included_allowance_interaction,
    rollover: existing?.rollover,
    prorate_partial_periods: (approved.prorate_partial_periods as MinimumCommitment['prorate_partial_periods']) ?? existing?.prorate_partial_periods ?? 'unclear',
    source_clause: (approved.source_clause as string | undefined) ?? existing?.source_clause ?? null,
    requires_confirmation: false,
    confirmation_reason: null,
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id: jobId } = await params
  const body = await req.json() as Body
  const { ruleType, contractUnitType, sourceClause, reviewerInput, aiProposedInterpretation, approvedInterpretation, discountId, creditId, interactionKey } = body

  if (!ruleType || !approvedInterpretation) {
    return NextResponse.json({ error: 'ruleType and approvedInterpretation are required' }, { status: 400 })
  }
  if (ruleType === 'discount' && !discountId) {
    return NextResponse.json({ error: 'discountId is required for discount interpretation' }, { status: 400 })
  }
  if (ruleType === 'service_credit' && !creditId) {
    return NextResponse.json({ error: 'creditId is required for service_credit interpretation' }, { status: 400 })
  }
  if (ruleType === 'rule_interaction' && !interactionKey) {
    return NextResponse.json({ error: 'interactionKey is required for rule_interaction interpretation' }, { status: 400 })
  }

  // The audit table's contract_unit_type column doubles as the addressing
  // key for job-level rules (null for a singular escalator). Discounts,
  // service credits, and rule interactions aren't singular, so their audit
  // history is addressed via a synthetic 'discount:{id}'/'credit:{id}'/
  // 'interaction:{key}' key in that same column — reuses the existing schema
  // rather than requiring another migration.
  const auditUnitKey = ruleType === 'discount' ? `discount:${discountId}`
    : ruleType === 'service_credit' ? `credit:${creditId}`
    : ruleType === 'rule_interaction' ? `interaction:${interactionKey}`
    : (contractUnitType ?? null)

  const session = await auth()
  const reviewerEmail = session?.user?.email ?? org.userEmail ?? 'unknown'
  const reviewerName = session?.user?.name ?? null

  const propagation: PropagationStatus = {}
  // A rule interaction never touches Billing Configuration/Schedule directly
  // — it only resolves which basis the referencing service credit's own
  // (separately-confirmed) interpretation should use.
  const affectedComponents = ruleType === 'rule_interaction'
    ? ['Commercial Terms', 'Billing Engine']
    : ['Commercial Terms', 'Billing Configuration', 'Billing Engine', 'Billing Schedule']

  // ── Step 1: audit row (append-only) ─────────────────────────────────────
  // contract_unit_type is null for job-level rules (escalators) — PostgREST's
  // .eq() never matches NULL, so lookups/updates below use .is() for that
  // case or a job-level rule's revision history would never be found.
  const priorCurrentQuery = supabaseServer
    .from('commercial_rule_interpretations')
    .select('id, revision_number')
    .eq('job_id', jobId)
    .eq('rule_type', ruleType)
    .eq('is_current', true)
  const { data: priorCurrent } = await (auditUnitKey
    ? priorCurrentQuery.eq('contract_unit_type', auditUnitKey)
    : priorCurrentQuery.is('contract_unit_type', null)
  ).maybeSingle()

  const nextRevision = (priorCurrent?.revision_number ?? 0) + 1

  // Fetched before any write this request makes, so original_extraction is a
  // true "before" snapshot — the specific sub-object this confirmation is
  // about to overwrite, not a post-hoc reconstruction. Reused by Step 2
  // below rather than queried twice.
  const { data: termsRow } = await supabaseServer
    .from('contract_terms')
    .select('id, overage_tiers, escalators, discounts, service_credits')
    .eq('job_id', jobId)
    .maybeSingle()

  const originalExtraction: unknown = !termsRow ? null
    : ruleType === 'minimum_commitment' || ruleType === 'partial_period'
      ? (termsRow.overage_tiers as Array<{ unit_type?: string }> ?? []).find(t => t.unit_type === contractUnitType) ?? null
    : ruleType === 'tier_calculation'
      ? (termsRow.overage_tiers as Array<{ unit_type?: string }> ?? []).find(t => t.unit_type === contractUnitType) ?? null
    : ruleType === 'discount'
      ? (termsRow.discounts as Array<{ discount_rule_id?: string }> ?? []).find(d => d.discount_rule_id === discountId) ?? null
    : ruleType === 'service_credit'
      ? (termsRow.service_credits as Array<{ credit_rule_id?: string }> ?? []).find(c => c.credit_rule_id === creditId) ?? null
    : ruleType === 'rule_interaction'
      ? (termsRow.service_credits as Array<{ credit_rule_id?: string; interpretation?: unknown }> ?? [])
          .find(c => c.credit_rule_id === (interactionKey ?? '').split('|').find(p => p.startsWith('service_credit:'))?.split(':')[1])?.interpretation ?? null
    : (termsRow.escalators as unknown[] ?? [])[0] ?? null

  const { error: auditError } = await supabaseServer.from('commercial_rule_interpretations').insert({
    job_id: jobId,
    rule_type: ruleType,
    contract_unit_type: auditUnitKey,
    revision_number: nextRevision,
    is_current: true,
    source_clause: sourceClause ?? null,
    source_text: sourceClause ?? null,
    original_extraction: originalExtraction,
    reviewer_input: reviewerInput ?? null,
    ai_proposed_interpretation: aiProposedInterpretation,
    approved_interpretation: approvedInterpretation,
    reviewer_email: reviewerEmail,
    reviewer_name: reviewerName,
    affected_components: affectedComponents,
    propagation_status: {},
  })

  if (auditError) {
    // The audit table itself missing (pending migration) is a hard stop —
    // unlike the meter-mappings confirmation columns, this isn't optional
    // metadata; losing the audit trail defeats the whole point of this flow.
    console.error(`[confirm-rule] audit insert failed for job ${jobId}:`, auditError.message)
    return NextResponse.json({
      error: auditError.message.includes('commercial_rule_interpretations')
        ? 'The audit-trail table has not been provisioned yet — run the pending migration (20260816000001_commercial_rule_interpretations.sql) before approving rules.'
        : auditError.message,
    }, { status: 500 })
  }

  if (priorCurrent) {
    await supabaseServer
      .from('commercial_rule_interpretations')
      .update({ is_current: false })
      .eq('id', priorCurrent.id)
  }
  propagation['audit_trail'] = 'applied'

  // ── Step 2: contract_terms ───────────────────────────────────────────────

  if (!termsRow) {
    propagation['contract_terms'] = 'failed'
  } else if (ruleType === 'minimum_commitment' || ruleType === 'partial_period') {
    if (!contractUnitType) {
      propagation['contract_terms'] = 'failed'
    } else {
      type Tier = { unit_type: string; minimum_commitment?: MinimumCommitment | null; [k: string]: unknown }
      const tiers = (termsRow.overage_tiers ?? []) as Tier[]
      const newTiers = tiers.map(t =>
        t.unit_type === contractUnitType
          ? { ...t, minimum_commitment: buildMinimumCommitment(approvedInterpretation, t.minimum_commitment) }
          : t
      )
      const { error } = await supabaseServer.from('contract_terms').update({ overage_tiers: newTiers }).eq('id', termsRow.id)
      propagation['contract_terms'] = error ? 'failed' : 'applied'
    }
  } else if (ruleType === 'escalator') {
    type Esc = { interpretation?: EscalatorInterpretation | null; [k: string]: unknown }
    const escalators = (termsRow.escalators ?? []) as Esc[]
    const treatment: EscalatorInterpretation['treatment'] = approvedInterpretation.treatment === 'not_applied' ? 'not_applied' : 'applies'
    const interpretation: EscalatorInterpretation = treatment === 'not_applied'
      ? {
          treatment: 'not_applied',
          index: null, index_name: null, frequency: null, effective_date: null, cap_pct: null, calculation_method: null,
          discretion: 'not_exercised', renewal_triggered: false,
          requires_confirmation: false,
          confirmation_reason: (approvedInterpretation.confirmation_reason as string | null) ?? null,
        }
      : {
          treatment: 'applies',
          index: (approvedInterpretation.index as EscalatorInterpretation['index']) ?? 'other',
          index_name: (approvedInterpretation.index_name as string | null) ?? null,
          frequency: (approvedInterpretation.frequency as EscalatorInterpretation['frequency']) ?? 'annual',
          effective_date: (approvedInterpretation.effective_date as string | null) ?? null,
          cap_pct: (approvedInterpretation.cap_pct as number | null) ?? null,
          calculation_method: (approvedInterpretation.calculation_method as string) ?? '',
          // A discretionary clause must never silently default to
          // 'automatic' here — only persist 'automatic' when the reviewer's
          // structured/free-text interpretation actually said so.
          discretion: (approvedInterpretation.discretion as EscalatorInterpretation['discretion']) ?? 'requires_renewal_approval',
          renewal_triggered: (approvedInterpretation.renewal_triggered as boolean) ?? false,
          requires_confirmation: false,
          confirmation_reason: null,
        }
    const newEscalators = escalators.length > 0
      ? escalators.map((e, i) => (i === 0 ? { ...e, interpretation } : e))
      : [{ escalator_pct: null, escalator_type: 'CPI_cap', effective_date: interpretation.effective_date, applies_from_year: null, cap_pct: interpretation.cap_pct, description: '', interpretation }]
    const { error } = await supabaseServer.from('contract_terms').update({ escalators: newEscalators }).eq('id', termsRow.id)
    propagation['contract_terms'] = error ? 'failed' : 'applied'
  } else if (ruleType === 'discount') {
    // Addressed by discount_rule_id, not array position, so a contract with
    // several independent discounts only has the targeted one touched — the
    // others keep whatever interpretation (or lack of one) they already had.
    type Disc = { discount_rule_id?: string; interpretation?: DiscountInterpretation | null; [k: string]: unknown }
    const discounts = (termsRow.discounts ?? []) as Disc[]
    const isTiered = approvedInterpretation.discount_type === 'tiered_discount' || approvedInterpretation.discount_type === 'volume_discount'
    const interpretation: DiscountInterpretation = {
      discount_type: (approvedInterpretation.discount_type as DiscountInterpretation['discount_type']) ?? 'custom',
      discount_basis: (approvedInterpretation.discount_basis as DiscountInterpretation['discount_basis']) ?? 'percentage',
      tier_method: isTiered ? ((approvedInterpretation.tier_method as DiscountInterpretation['tier_method']) ?? null) : null,
      tiers: isTiered ? ((approvedInterpretation.tiers as DiscountInterpretation['tiers']) ?? null) : null,
      applies_to: (approvedInterpretation.applies_to as string | null) ?? null,
      application_order: (approvedInterpretation.application_order as string | null) ?? null,
      reset_period: (approvedInterpretation.reset_period as DiscountInterpretation['reset_period']) ?? null,
      worked_example: (approvedInterpretation.worked_example as string | null) ?? null,
      requires_confirmation: false,
      confirmation_reason: null,
    }
    const targetIndex = discounts.findIndex(d => d.discount_rule_id === discountId)
    const fallbackIndex = targetIndex === -1 && Number.isInteger(Number(discountId)) ? Number(discountId) : -1
    let newDiscounts: Disc[]
    if (targetIndex !== -1) {
      newDiscounts = discounts.map((d, i) => (i === targetIndex ? { ...d, interpretation } : d))
    } else if (fallbackIndex !== -1 && discounts[fallbackIndex]) {
      // Legacy discount row addressed positionally, predates discount_rule_id
      // — backfill the id now so future confirmations address it directly.
      newDiscounts = discounts.map((d, i) => (i === fallbackIndex ? { ...d, discount_rule_id: d.discount_rule_id ?? discountId, interpretation } : d))
    } else if (discounts.length === 0) {
      newDiscounts = [{ discount_rule_id: discountId, discount_pct: null, discount_amount: null, discount_type: 'other', start_date: null, end_date: null, duration_months: null, applies_to: interpretation.applies_to ?? '', description: '', interpretation }]
    } else {
      newDiscounts = discounts
      propagation['contract_terms'] = 'failed'
    }
    if (propagation['contract_terms'] !== 'failed') {
      const { error } = await supabaseServer.from('contract_terms').update({ discounts: newDiscounts }).eq('id', termsRow.id)
      propagation['contract_terms'] = error ? 'failed' : 'applied'
    }
  } else if (ruleType === 'tier_calculation') {
    if (!contractUnitType) {
      propagation['contract_terms'] = 'failed'
    } else {
      type Tier = { unit_type: string; tier_calculation?: TierCalculationMethod | null; [k: string]: unknown }
      const tiers = (termsRow.overage_tiers ?? []) as Tier[]
      const newTiers = tiers.map(t =>
        t.unit_type === contractUnitType
          ? { ...t, tier_calculation: buildTierCalculation(approvedInterpretation) }
          : t
      )
      const { error } = await supabaseServer.from('contract_terms').update({ overage_tiers: newTiers }).eq('id', termsRow.id)
      propagation['contract_terms'] = error ? 'failed' : 'applied'
    }
  } else if (ruleType === 'service_credit') {
    // Same addressing pattern as discount: stable credit_rule_id, not array
    // position, with the same legacy-row positional fallback + backfill.
    type Credit = { credit_rule_id?: string; interpretation?: ServiceCreditInterpretation | null; [k: string]: unknown }
    const credits = (termsRow.service_credits ?? []) as Credit[]
    const interpretation = buildServiceCreditInterpretation(approvedInterpretation, credits.find(c => c.credit_rule_id === creditId)?.interpretation)
    const targetIndex = credits.findIndex(c => c.credit_rule_id === creditId)
    const fallbackIndex = targetIndex === -1 && Number.isInteger(Number(creditId)) ? Number(creditId) : -1
    let newCredits: Credit[]
    if (targetIndex !== -1) {
      newCredits = credits.map((c, i) => (i === targetIndex ? { ...c, interpretation } : c))
    } else if (fallbackIndex !== -1 && credits[fallbackIndex]) {
      newCredits = credits.map((c, i) => (i === fallbackIndex ? { ...c, credit_rule_id: c.credit_rule_id ?? creditId, interpretation } : c))
    } else if (credits.length === 0) {
      newCredits = [{ credit_rule_id: creditId, credit_type: 'other', description: '', source_clause: null, stated_pct: null, stated_amount: null, interpretation }]
    } else {
      newCredits = credits
      propagation['contract_terms'] = 'failed'
    }
    if (propagation['contract_terms'] !== 'failed') {
      const { error } = await supabaseServer.from('contract_terms').update({ service_credits: newCredits }).eq('id', termsRow.id)
      propagation['contract_terms'] = error ? 'failed' : 'applied'
    }
  } else if (ruleType === 'rule_interaction') {
    // No natural contract_terms field for the interaction itself — the
    // resolution is written back onto the referencing service credit's own
    // interpretation.interaction_note, so the calculation engine and any
    // standalone display of that credit sees the resolved basis without
    // joining the separate interaction audit row.
    const parsedCreditId = (interactionKey ?? '').split('|').find(p => p.startsWith('service_credit:'))?.split(':')[1]
    type Credit = { credit_rule_id?: string; interpretation?: ServiceCreditInterpretation | null; [k: string]: unknown }
    const credits = (termsRow.service_credits ?? []) as Credit[]
    const targetIndex = credits.findIndex(c => c.credit_rule_id === parsedCreditId)
    if (targetIndex === -1 || !credits[targetIndex].interpretation) {
      // The credit's own basis interpretation must exist before an
      // interaction resolution can be attached to it — surfaced as
      // 'skipped', not 'failed', since this isn't an error, just an
      // ordering dependency the reviewer needs to resolve first.
      propagation['contract_terms'] = 'skipped'
    } else {
      const note = (approvedInterpretation.note as string | null) ?? null
      const newCredits = credits.map((c, i) =>
        i === targetIndex ? { ...c, interpretation: { ...c.interpretation!, interaction_note: note } } : c
      )
      const { error } = await supabaseServer.from('contract_terms').update({ service_credits: newCredits }).eq('id', termsRow.id)
      propagation['contract_terms'] = error ? 'failed' : 'applied'
    }
  }

  // ── Step 3: contract_meter_mappings (mirror, when a confirmed mapping exists) ──
  const mirrorsToMeterMapping = ruleType === 'minimum_commitment' || ruleType === 'partial_period' || ruleType === 'tier_calculation'
  if (mirrorsToMeterMapping && contractUnitType) {
    const { data: mapping } = await supabaseServer
      .from('contract_meter_mappings')
      .select('id, overage_tiers, confirmed')
      .eq('job_id', jobId)
      .eq('contract_unit_type', contractUnitType)
      .maybeSingle()

    if (!mapping) {
      propagation['contract_meter_mappings'] = 'skipped' // no meter mapping exists yet — nothing to mirror into
    } else {
      type Tier = { minimum_commitment?: MinimumCommitment | null; tier_calculation?: TierCalculationMethod | null; [k: string]: unknown }
      const tiers = (mapping.overage_tiers ?? []) as Tier[]
      const newTiers = ruleType === 'tier_calculation'
        ? tiers.map(t => ({ ...t, tier_calculation: buildTierCalculation(approvedInterpretation) }))
        : tiers.map(t => ({ ...t, minimum_commitment: buildMinimumCommitment(approvedInterpretation, t.minimum_commitment) }))
      const { error } = await supabaseServer.from('contract_meter_mappings').update({ overage_tiers: newTiers }).eq('id', mapping.id)
      propagation['contract_meter_mappings'] = error ? 'failed' : 'applied'
    }
  } else {
    propagation['contract_meter_mappings'] = 'skipped'
  }

  // Record the final propagation outcome on the audit row itself so later
  // inspection doesn't need to cross-reference contract_terms state.
  const statusUpdateQuery = supabaseServer
    .from('commercial_rule_interpretations')
    .update({ propagation_status: propagation })
    .eq('job_id', jobId)
    .eq('rule_type', ruleType)
    .eq('revision_number', nextRevision)
  await (auditUnitKey
    ? statusUpdateQuery.eq('contract_unit_type', auditUnitKey)
    : statusUpdateQuery.is('contract_unit_type', null))

  const anyFailed = Object.values(propagation).includes('failed')
  return NextResponse.json({ ok: !anyFailed, propagation }, { status: anyFailed ? 207 : 200 })
}
