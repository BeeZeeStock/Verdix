/**
 * POST /api/jobs/[id]/interpret-rule
 *
 * The AI step of the in-panel rule-interpretation flow. Takes a reviewer's
 * structured choice and/or free-text instruction for an ambiguous
 * commercial rule (minimum commitment, escalator, or partial-period
 * proration) and asks Claude to translate it into a structured proposal.
 *
 * Strictly read-only server-side — this route never writes to contract_terms,
 * contract_meter_mappings, or the audit table. The reviewer must separately
 * call /confirm-rule to approve the proposal before anything becomes
 * executable billing logic (see lib/rule-interpretation.ts's module comment).
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { getAIClient } from '@/lib/ai-client'
import {
  buildMinimumCommitmentPrompt,
  buildPartialPeriodPrompt,
  buildEscalatorPrompt,
  parseRuleInterpretationResponse,
  describeMissingFieldQuestions,
  describeWhatWillChange,
  type RuleType,
  type MinimumCommitmentContext,
  type PartialPeriodContext,
  type EscalatorContext,
} from '@/lib/rule-interpretation'

type TierRow = {
  tier_label: string
  from_unit: number | null
  to_unit: number | null
  rate_per_unit: number
  unit_type: string
  minimum_period_amount?: number | null
  measurement_period?: string | null
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id: jobId } = await params
  const body = await req.json() as {
    ruleType: RuleType
    contractUnitType?: string
    selectedOption?: string
    freeText?: string
    // The clause text already shown on the reviewer's card — passed through
    // for AI-prompt context only (purely descriptive; never used to decide
    // what gets written, so it isn't a trust boundary the way contract
    // financial fields are).
    sourceClause?: string
  }

  const { ruleType, contractUnitType, selectedOption, freeText, sourceClause } = body
  const reviewerInput = (freeText ?? '').trim()
  if (!ruleType) return NextResponse.json({ error: 'ruleType is required' }, { status: 400 })
  if (!reviewerInput && (!selectedOption || selectedOption === 'other')) {
    return NextResponse.json({ error: 'Describe how this rule should work, or pick a structured option.' }, { status: 400 })
  }

  // Context is built entirely from this job's own stored data — never from
  // client-supplied contract fields — so a reviewer can't smuggle arbitrary
  // "facts" about the contract into the AI prompt.
  const { data: job } = await supabaseServer
    .from('jobs')
    .select('id, org_id, contract_terms ( currency, overage_tiers, escalators, contract_start_date, contract_end_date )')
    .eq('id', jobId)
    .eq('org_id', org.orgId)
    .single()

  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  const terms = (job.contract_terms as unknown as Array<{
    currency: string | null
    overage_tiers: TierRow[] | null
    escalators: Array<{ escalator_pct: number | null; cap_pct: number | null; effective_date: string | null; applies_from_year: number | null; description: string }> | null
    contract_start_date: string | null
    contract_end_date: string | null
  }>)?.[0]
  if (!terms) return NextResponse.json({ error: 'Contract terms not found' }, { status: 404 })

  const currency = terms.currency ?? 'EUR'
  const client = getAIClient()

  let prompt: string
  if (ruleType === 'minimum_commitment') {
    if (!contractUnitType) return NextResponse.json({ error: 'contractUnitType is required for minimum_commitment' }, { status: 400 })
    const tiers = (terms.overage_tiers ?? []).filter(t => t.unit_type === contractUnitType)
    const includedTier = tiers.find(t => (t.rate_per_unit ?? 0) === 0)
    const paidTiers = tiers.filter(t => (t.rate_per_unit ?? 0) > 0)
    const existingMinimum = tiers.reduce((max, t) => Math.max(max, t.minimum_period_amount ?? 0), 0)
    const context: MinimumCommitmentContext = {
      contractUnitType,
      sourceClause: sourceClause ?? null,
      currency,
      includedUnits: includedTier?.to_unit ?? 0,
      tiers: paidTiers.map(t => ({ tier_label: t.tier_label, from_unit: t.from_unit, to_unit: t.to_unit, rate_per_unit: t.rate_per_unit })),
      existingMinimumAmount: existingMinimum > 0 ? existingMinimum : null,
      measurementPeriod: paidTiers[0]?.measurement_period ?? null,
    }
    prompt = buildMinimumCommitmentPrompt(context, reviewerInput, selectedOption)
  } else if (ruleType === 'partial_period') {
    if (!contractUnitType) return NextResponse.json({ error: 'contractUnitType is required for partial_period' }, { status: 400 })
    const tiers = (terms.overage_tiers ?? []).filter(t => t.unit_type === contractUnitType)
    const existingMinimum = tiers.reduce((max, t) => Math.max(max, t.minimum_period_amount ?? 0), 0)
    const context: PartialPeriodContext = {
      contractUnitType,
      sourceClause: sourceClause ?? null,
      currency,
      contractStartDate: terms.contract_start_date,
      contractEndDate: terms.contract_end_date,
      measurementPeriod: tiers[0]?.measurement_period ?? null,
      minimumAmount: existingMinimum > 0 ? existingMinimum : null,
    }
    prompt = buildPartialPeriodPrompt(context, reviewerInput, selectedOption)
  } else if (ruleType === 'escalator') {
    const escalator = (terms.escalators ?? [])[0]
    const context: EscalatorContext = {
      sourceClause: sourceClause ?? null,
      description: escalator?.description ?? '',
      capPct: escalator?.cap_pct ?? null,
      effectiveDate: escalator?.effective_date ?? null,
      appliesFromYear: escalator?.applies_from_year ?? null,
    }
    prompt = buildEscalatorPrompt(context, reviewerInput, selectedOption)
  } else {
    return NextResponse.json({ error: `Unknown ruleType: ${ruleType}` }, { status: 400 })
  }

  let rawText: string
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    })
    const content = response.content[0]
    if (content.type !== 'text') throw new Error('Unexpected response type from Claude')
    rawText = content.text
  } catch (err) {
    console.error(`[interpret-rule] AI call failed for job ${jobId}:`, err)
    return NextResponse.json({ error: 'Verdix could not reach the AI interpretation service. Try again.' }, { status: 502 })
  }

  const parsed = parseRuleInterpretationResponse(ruleType, rawText)
  if (!parsed.ok) {
    return NextResponse.json({
      ok: false,
      missingFields: parsed.missingFields,
      questions: describeMissingFieldQuestions(parsed.missingFields),
    })
  }

  // Dependency check: a minimum/partial-period rule can't calculate a real
  // invoice amount until the metric's usage source is confirmed.
  let dependency: { meterMappingConfirmed: boolean; meterKey?: string | null } | undefined
  if (contractUnitType) {
    const { data: mapping } = await supabaseServer
      .from('contract_meter_mappings')
      .select('confirmed, meter_key')
      .eq('job_id', jobId)
      .eq('contract_unit_type', contractUnitType)
      .maybeSingle()
    dependency = { meterMappingConfirmed: !!mapping?.confirmed, meterKey: mapping?.meter_key ?? null }
  }

  return NextResponse.json({
    ok: true,
    proposal: parsed.proposal,
    whatWillChange: describeWhatWillChange(ruleType, contractUnitType ?? null, dependency),
    dependency,
  })
}
