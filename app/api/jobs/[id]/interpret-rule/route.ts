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
  buildDiscountPrompt,
  buildTierCalculationPrompt,
  buildServiceCreditPrompt,
  buildRuleInteractionPrompt,
  parseRuleInterpretationResponse,
  describeMissingFieldQuestions,
  describeWhatWillChange,
  type RuleType,
  type MinimumCommitmentContext,
  type PartialPeriodContext,
  type EscalatorContext,
  type DiscountContext,
  type TierCalculationContext,
  type ServiceCreditContext,
  type RuleInteractionContext,
} from '@/lib/rule-interpretation'

type TierRow = {
  tier_label: string
  from_unit: number | null
  to_unit: number | null
  rate_per_unit: number
  unit_type: string
  minimum_period_amount?: number | null
  measurement_period?: string | null
  // The tier's own extracted source_clause — authoritative evidence for the
  // AI prompt. Never let a client-supplied sourceClause (e.g. the review
  // card's own generated "what to check" instruction text) outrank it.
  minimum_commitment?: { source_clause?: string | null } | null
  tier_calculation?: { source_clause?: string | null } | null
}

function sourceClauseFor(extracted: string | null | undefined, clientSupplied: string | null | undefined): string | null {
  return extracted || clientSupplied || null
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
    // Which discount this interpretation targets, when ruleType is
    // 'discount' — a contract can have several independently-interpretable
    // discounts, so array position alone is never enough to address one.
    discountId?: string
    // Same addressing pattern as discountId, for ruleType 'service_credit'.
    creditId?: string
    // Composite key from lib/rule-interactions.ts's detectRuleInteractionCandidates
    // (e.g. "service_credit:ab12cd34|discount:ef56gh78"), for ruleType
    // 'rule_interaction' — re-parsed server-side against this job's own
    // contract_terms rather than trusted as data.
    interactionKey?: string
  }

  const { ruleType, contractUnitType, selectedOption, freeText, sourceClause, discountId, creditId, interactionKey } = body
  const reviewerInput = (freeText ?? '').trim()
  if (!ruleType) return NextResponse.json({ error: 'ruleType is required' }, { status: 400 })
  if (!reviewerInput && (!selectedOption || selectedOption === 'other')) {
    return NextResponse.json({ error: 'Describe how this rule should work, or pick a structured option.' }, { status: 400 })
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

  // Context is built entirely from this job's own stored data — never from
  // client-supplied contract fields — so a reviewer can't smuggle arbitrary
  // "facts" about the contract into the AI prompt.
  const { data: job } = await supabaseServer
    .from('jobs')
    .select('id, org_id, contract_terms ( currency, overage_tiers, escalators, discounts, service_credits, contract_start_date, contract_end_date )')
    .eq('id', jobId)
    .eq('org_id', org.orgId)
    .single()

  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  const terms = (job.contract_terms as unknown as Array<{
    currency: string | null
    overage_tiers: TierRow[] | null
    escalators: Array<{ escalator_pct: number | null; cap_pct: number | null; effective_date: string | null; applies_from_year: number | null; description: string }> | null
    discounts: Array<{ discount_rule_id?: string; discount_pct: number | null; discount_amount: number | null; discount_type: string | null; applies_to: string | null; description: string | null }> | null
    service_credits: Array<{ credit_rule_id?: string; credit_type: string | null; description: string | null; source_clause: string | null; stated_pct: number | null; stated_amount: number | null }> | null
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
    const extractedClause = tiers.find(t => t.minimum_commitment?.source_clause)?.minimum_commitment?.source_clause
    const context: MinimumCommitmentContext = {
      contractUnitType,
      sourceClause: sourceClauseFor(extractedClause, sourceClause),
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
    const extractedClause = tiers.find(t => t.minimum_commitment?.source_clause)?.minimum_commitment?.source_clause
    const context: PartialPeriodContext = {
      contractUnitType,
      sourceClause: sourceClauseFor(extractedClause, sourceClause),
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
      sourceClause: sourceClauseFor(escalator?.description, sourceClause),
      description: escalator?.description ?? '',
      capPct: escalator?.cap_pct ?? null,
      effectiveDate: escalator?.effective_date ?? null,
      appliesFromYear: escalator?.applies_from_year ?? null,
    }
    prompt = buildEscalatorPrompt(context, reviewerInput, selectedOption)
  } else if (ruleType === 'discount') {
    // Each discount is addressed by its stable discount_rule_id, not array
    // position — a contract can have several independently-interpretable
    // discounts (onboarding, volume, reseller, ...) and only the targeted
    // one should be touched. Falls back to index-matching for a legacy
    // discount row that predates discount_rule_id.
    const discounts = terms.discounts ?? []
    const discount = discounts.find(d => d.discount_rule_id === discountId)
      ?? (Number.isInteger(Number(discountId)) ? discounts[Number(discountId)] : undefined)
    if (!discount) return NextResponse.json({ error: `Discount '${discountId}' not found on this job` }, { status: 404 })
    const context: DiscountContext = {
      sourceClause: sourceClauseFor(discount.description, sourceClause),
      description: discount.description ?? '',
      currency,
      existingPct: discount.discount_pct ?? null,
      existingAmount: discount.discount_amount ?? null,
      extractedType: discount.discount_type ?? null,
      appliesTo: discount.applies_to ?? null,
    }
    prompt = buildDiscountPrompt(context, reviewerInput, selectedOption)
  } else if (ruleType === 'tier_calculation') {
    if (!contractUnitType) return NextResponse.json({ error: 'contractUnitType is required for tier_calculation' }, { status: 400 })
    const tiers = (terms.overage_tiers ?? []).filter(t => t.unit_type === contractUnitType && (t.rate_per_unit ?? 0) > 0)
    const extractedClause = tiers.find(t => t.tier_calculation?.source_clause)?.tier_calculation?.source_clause
    const context: TierCalculationContext = {
      contractUnitType,
      sourceClause: sourceClauseFor(extractedClause, sourceClause),
      currency,
      tiers: tiers.map(t => ({ tier_label: t.tier_label, from_unit: t.from_unit, to_unit: t.to_unit, rate_per_unit: t.rate_per_unit })),
    }
    prompt = buildTierCalculationPrompt(context, reviewerInput, selectedOption)
  } else if (ruleType === 'service_credit') {
    // Same addressing pattern as discount: stable credit_rule_id, not array
    // position, with an index-matching fallback for a legacy row.
    const credits = terms.service_credits ?? []
    const credit = credits.find(c => c.credit_rule_id === creditId)
      ?? (Number.isInteger(Number(creditId)) ? credits[Number(creditId)] : undefined)
    if (!credit) return NextResponse.json({ error: `Service credit '${creditId}' not found on this job` }, { status: 404 })
    const context: ServiceCreditContext = {
      sourceClause: sourceClauseFor(credit.source_clause, sourceClause),
      description: credit.description ?? '',
      creditType: credit.credit_type ?? 'other',
      statedPct: credit.stated_pct ?? null,
      statedAmount: credit.stated_amount ?? null,
      currency,
    }
    prompt = buildServiceCreditPrompt(context, reviewerInput, selectedOption)
  } else if (ruleType === 'rule_interaction') {
    // interactionKey addresses a *pair* of rules — re-derive both sides from
    // this job's own stored terms rather than trusting anything about the
    // pair's content from the client (the key itself is just an address).
    const parts = (interactionKey ?? '').split('|')
    const creditPart = parts.find(p => p.startsWith('service_credit:'))
    const otherPart = parts.find(p => !p.startsWith('service_credit:'))
    const parsedCreditId = creditPart?.split(':')[1]
    const otherType = otherPart?.split(':')[0] as 'discount' | 'escalator' | undefined
    const otherId = otherPart?.split(':').slice(1).join(':')
    const credits = terms.service_credits ?? []
    const credit = credits.find(c => c.credit_rule_id === parsedCreditId)
    if (!credit) return NextResponse.json({ error: `Service credit for interaction '${interactionKey}' not found on this job` }, { status: 404 })
    let otherDescription = ''
    if (otherType === 'discount') {
      const discount = (terms.discounts ?? []).find(d => d.discount_rule_id === otherId)
      if (!discount) return NextResponse.json({ error: `Discount for interaction '${interactionKey}' not found on this job` }, { status: 404 })
      otherDescription = discount.description ?? ''
    } else if (otherType === 'escalator') {
      const escalator = (terms.escalators ?? []).find(e => (e.effective_date ?? e.description.slice(0, 24)) === otherId)
      if (!escalator) return NextResponse.json({ error: `Escalator for interaction '${interactionKey}' not found on this job` }, { status: 404 })
      otherDescription = escalator.description ?? ''
    } else {
      return NextResponse.json({ error: `Malformed interactionKey: ${interactionKey}` }, { status: 400 })
    }
    const context: RuleInteractionContext = {
      creditDescription: credit.description ?? '',
      creditBasisComponent: null,
      otherRuleType: otherType,
      otherRuleDescription: otherDescription,
      overlapReason: sourceClause ?? 'Both rules reference the same fee component.',
    }
    prompt = buildRuleInteractionPrompt(context, reviewerInput, selectedOption)
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

  // Historical impact: has this metric already appeared on an invoice that
  // was actually sent or paid? Changing the rule going forward is always
  // safe; changing it for a period that already billed is not something to
  // silently recalculate — surfaced here so the reviewer sees it before
  // approving, never applied automatically to issued invoices. Scoped to
  // metric-level rules (minimum_commitment/partial_period) where the
  // confirmed meter_key lets this be checked precisely; escalator changes
  // are job-level and much harder to attribute to a specific invoice, so
  // this check is skipped for that rule type rather than guessed at.
  let historicalImpact: { affectedCount: number; periods: string[] } | null = null
  if (contractUnitType && dependency?.meterKey) {
    const { data: sentRows } = await supabaseServer
      .from('planned_invoices')
      .select('period_start, period_end, overage_line_items')
      .eq('job_id', jobId)
      .eq('invoice_type', 'period')
      .in('status', ['sent', 'paid'])
    type SentRow = { period_start: string; period_end: string; overage_line_items: Array<{ meter_key?: string }> | null }
    const affected = ((sentRows ?? []) as SentRow[]).filter(r =>
      (r.overage_line_items ?? []).some(it => it.meter_key === dependency!.meterKey)
    )
    if (affected.length > 0) {
      historicalImpact = { affectedCount: affected.length, periods: affected.map(r => `${r.period_start} – ${r.period_end}`) }
    }
  }

  return NextResponse.json({
    ok: true,
    proposal: parsed.proposal,
    whatWillChange: describeWhatWillChange(ruleType, contractUnitType ?? null, dependency),
    dependency,
    historicalImpact,
  })
}
