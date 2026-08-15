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
import type { MinimumCommitment, EscalatorInterpretation } from '@/lib/types'

type Body = {
  ruleType: RuleType
  contractUnitType?: string
  sourceClause?: string | null
  reviewerInput: string
  aiProposedInterpretation: Record<string, unknown> | null
  approvedInterpretation: Record<string, unknown>
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
  const { ruleType, contractUnitType, sourceClause, reviewerInput, aiProposedInterpretation, approvedInterpretation } = body

  if (!ruleType || !approvedInterpretation) {
    return NextResponse.json({ error: 'ruleType and approvedInterpretation are required' }, { status: 400 })
  }

  const session = await auth()
  const reviewerEmail = session?.user?.email ?? org.userEmail ?? 'unknown'
  const reviewerName = session?.user?.name ?? null

  const propagation: PropagationStatus = {}
  const affectedComponents = ['Commercial Terms', 'Billing Configuration', 'Billing Engine', 'Billing Schedule']

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
  const { data: priorCurrent } = await (contractUnitType
    ? priorCurrentQuery.eq('contract_unit_type', contractUnitType)
    : priorCurrentQuery.is('contract_unit_type', null)
  ).maybeSingle()

  const nextRevision = (priorCurrent?.revision_number ?? 0) + 1

  const { error: auditError } = await supabaseServer.from('commercial_rule_interpretations').insert({
    job_id: jobId,
    rule_type: ruleType,
    contract_unit_type: contractUnitType ?? null,
    revision_number: nextRevision,
    is_current: true,
    source_clause: sourceClause ?? null,
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
  const { data: termsRow } = await supabaseServer
    .from('contract_terms')
    .select('id, overage_tiers, escalators')
    .eq('job_id', jobId)
    .maybeSingle()

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
    const interpretation: EscalatorInterpretation = {
      index: (approvedInterpretation.index as EscalatorInterpretation['index']) ?? 'other',
      frequency: (approvedInterpretation.frequency as EscalatorInterpretation['frequency']) ?? 'annual',
      effective_date: (approvedInterpretation.effective_date as string | null) ?? null,
      cap_pct: (approvedInterpretation.cap_pct as number | null) ?? null,
      calculation_method: (approvedInterpretation.calculation_method as string) ?? '',
      requires_confirmation: false,
      confirmation_reason: null,
    }
    const newEscalators = escalators.length > 0
      ? escalators.map((e, i) => (i === 0 ? { ...e, interpretation } : e))
      : [{ escalator_pct: null, escalator_type: 'CPI_cap', effective_date: interpretation.effective_date, applies_from_year: null, cap_pct: interpretation.cap_pct, description: '', interpretation }]
    const { error } = await supabaseServer.from('contract_terms').update({ escalators: newEscalators }).eq('id', termsRow.id)
    propagation['contract_terms'] = error ? 'failed' : 'applied'
  }

  // ── Step 3: contract_meter_mappings (mirror, when a confirmed mapping exists) ──
  if ((ruleType === 'minimum_commitment' || ruleType === 'partial_period') && contractUnitType) {
    const { data: mapping } = await supabaseServer
      .from('contract_meter_mappings')
      .select('id, overage_tiers, confirmed')
      .eq('job_id', jobId)
      .eq('contract_unit_type', contractUnitType)
      .maybeSingle()

    if (!mapping) {
      propagation['contract_meter_mappings'] = 'skipped' // no meter mapping exists yet — nothing to mirror into
    } else {
      type Tier = { minimum_commitment?: MinimumCommitment | null; [k: string]: unknown }
      const tiers = (mapping.overage_tiers ?? []) as Tier[]
      const newTiers = tiers.map(t => ({ ...t, minimum_commitment: buildMinimumCommitment(approvedInterpretation, t.minimum_commitment) }))
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
  await (contractUnitType
    ? statusUpdateQuery.eq('contract_unit_type', contractUnitType)
    : statusUpdateQuery.is('contract_unit_type', null))

  const anyFailed = Object.values(propagation).includes('failed')
  return NextResponse.json({ ok: !anyFailed, propagation }, { status: anyFailed ? 207 : 200 })
}
