/**
 * POST /api/jobs/[id]/propose-rule
 *
 * The AI-proposes-FIRST step of the review-panel flow — asks Claude for
 * Verdix's own best interpretation of an ambiguous commercial rule, built
 * entirely from the source clause and this job's own stored contract data,
 * with NO reviewer input at all (contrast with /interpret-rule, which only
 * ever runs after a reviewer has typed something or picked an option — that
 * route remains the "override" path once a reviewer rejects what this route
 * proposes). Read-only, same discipline as /interpret-rule: never writes to
 * contract_terms, contract_meter_mappings, or the audit table.
 *
 * Response includes a three-state classification (clear_from_source /
 * verdix_recommends / decision_required) that the review panel uses to
 * decide whether to pre-select the proposal or leave the choice to the
 * reviewer — see lib/rule-interpretation.ts's validateProposalState, which
 * is the deterministic safety net this route always runs the AI response
 * through before returning it (the model's own stated confidence is never
 * trusted as the final word).
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { getAIClient } from '@/lib/ai-client'
import {
  buildMinimumCommitmentProposalPrompt,
  buildPartialPeriodProposalPrompt,
  buildEscalatorProposalPrompt,
  buildDiscountProposalPrompt,
  buildTierCalculationProposalPrompt,
  buildServiceCreditProposalPrompt,
  buildRuleInteractionProposalPrompt,
  validateProposalState,
  type RuleType,
  type RuleProposal,
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
  // The tier's own extracted source_clause for these two sub-rules — the
  // authoritative evidence the AI must reason from. A client-supplied
  // sourceClause is never trusted over this: the review card used to pass
  // its own generated "what to check" instruction text as if it were the
  // contract clause, which produced false "the contract doesn't specify..."
  // verdicts for clauses that were actually explicit. See sourceClauseFor().
  minimum_commitment?: { source_clause?: string | null } | null
  tier_calculation?: { source_clause?: string | null } | null
}

// The server's own extracted text always wins over whatever the client
// happened to send as `sourceClause` — a client-supplied value is only ever
// used as a last-resort fallback when extraction genuinely captured nothing.
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
    sourceClause?: string
    discountId?: string
    creditId?: string
    interactionKey?: string
  }
  const { ruleType, contractUnitType, sourceClause, discountId, creditId, interactionKey } = body
  if (!ruleType) return NextResponse.json({ error: 'ruleType is required' }, { status: 400 })
  if (ruleType === 'discount' && !discountId) {
    return NextResponse.json({ error: 'discountId is required for discount proposals' }, { status: 400 })
  }
  if (ruleType === 'service_credit' && !creditId) {
    return NextResponse.json({ error: 'creditId is required for service_credit proposals' }, { status: 400 })
  }
  if (ruleType === 'rule_interaction' && !interactionKey) {
    return NextResponse.json({ error: 'interactionKey is required for rule_interaction proposals' }, { status: 400 })
  }

  // Context built entirely from this job's own stored data, exactly like
  // /interpret-rule — never from client-supplied contract fields.
  const { data: job } = await supabaseServer
    .from('jobs')
    .select('id, org_id, contract_terms ( id, currency, overage_tiers, escalators, discounts, service_credits, contract_start_date, contract_end_date, ai_proposal_cache )')
    .eq('id', jobId)
    .eq('org_id', org.orgId)
    .single()

  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  const terms = (job.contract_terms as unknown as Array<{
    id: string
    currency: string | null
    overage_tiers: TierRow[] | null
    escalators: Array<{ escalator_pct: number | null; cap_pct: number | null; effective_date: string | null; applies_from_year: number | null; description: string }> | null
    discounts: Array<{ discount_rule_id?: string; discount_pct: number | null; discount_amount: number | null; discount_type: string | null; applies_to: string | null; description: string | null }> | null
    service_credits: Array<{ credit_rule_id?: string; credit_type: string | null; description: string | null; source_clause: string | null; stated_pct: number | null; stated_amount: number | null }> | null
    contract_start_date: string | null
    contract_end_date: string | null
    ai_proposal_cache: Record<string, { promptFingerprint: string; proposal: RuleProposal }> | null
  }>)?.[0]
  if (!terms) return NextResponse.json({ error: 'Contract terms not found' }, { status: 404 })

  // Same synthetic addressing convention commercial_rule_interpretations
  // already uses for contract_unit_type — a stable key per rule instance,
  // not per request, so the cache entry for "the AI processing minimum
  // commitment" survives across every re-open of the Review panel.
  const cacheKey = ruleType === 'discount' ? `discount:${discountId}`
    : ruleType === 'service_credit' ? `service_credit:${creditId}`
    : ruleType === 'rule_interaction' ? `rule_interaction:${interactionKey}`
    : ruleType === 'escalator' ? 'escalator'
    : `${ruleType}:${contractUnitType}`

  const currency = terms.currency ?? 'EUR'
  const client = getAIClient()
  let prompt: string
  let sourceClauseAvailable = !!sourceClause

  if (ruleType === 'minimum_commitment') {
    if (!contractUnitType) return NextResponse.json({ error: 'contractUnitType is required for minimum_commitment' }, { status: 400 })
    const tiers = (terms.overage_tiers ?? []).filter(t => t.unit_type === contractUnitType)
    const includedTier = tiers.find(t => (t.rate_per_unit ?? 0) === 0)
    const paidTiers = tiers.filter(t => (t.rate_per_unit ?? 0) > 0)
    const existingMinimum = tiers.reduce((max, t) => Math.max(max, t.minimum_period_amount ?? 0), 0)
    const extractedClause = tiers.find(t => t.minimum_commitment?.source_clause)?.minimum_commitment?.source_clause
    sourceClauseAvailable = sourceClauseAvailable || !!extractedClause
    const context: MinimumCommitmentContext = {
      contractUnitType,
      sourceClause: sourceClauseFor(extractedClause, sourceClause),
      currency,
      includedUnits: includedTier?.to_unit ?? 0,
      tiers: paidTiers.map(t => ({ tier_label: t.tier_label, from_unit: t.from_unit, to_unit: t.to_unit, rate_per_unit: t.rate_per_unit })),
      existingMinimumAmount: existingMinimum > 0 ? existingMinimum : null,
      measurementPeriod: paidTiers[0]?.measurement_period ?? null,
    }
    prompt = buildMinimumCommitmentProposalPrompt(context)
  } else if (ruleType === 'partial_period') {
    if (!contractUnitType) return NextResponse.json({ error: 'contractUnitType is required for partial_period' }, { status: 400 })
    const tiers = (terms.overage_tiers ?? []).filter(t => t.unit_type === contractUnitType)
    const existingMinimum = tiers.reduce((max, t) => Math.max(max, t.minimum_period_amount ?? 0), 0)
    // Partial-period ambiguity concerns the SAME minimum-commitment clause,
    // not a separate one — reuse its extracted source_clause.
    const extractedClause = tiers.find(t => t.minimum_commitment?.source_clause)?.minimum_commitment?.source_clause
    sourceClauseAvailable = sourceClauseAvailable || !!extractedClause
    const context: PartialPeriodContext = {
      contractUnitType,
      sourceClause: sourceClauseFor(extractedClause, sourceClause),
      currency,
      contractStartDate: terms.contract_start_date,
      contractEndDate: terms.contract_end_date,
      measurementPeriod: tiers[0]?.measurement_period ?? null,
      minimumAmount: existingMinimum > 0 ? existingMinimum : null,
    }
    prompt = buildPartialPeriodProposalPrompt(context)
  } else if (ruleType === 'escalator') {
    const escalator = (terms.escalators ?? [])[0]
    sourceClauseAvailable = sourceClauseAvailable || !!escalator?.description
    const context: EscalatorContext = {
      sourceClause: sourceClauseFor(escalator?.description, sourceClause),
      description: escalator?.description ?? '',
      capPct: escalator?.cap_pct ?? null,
      effectiveDate: escalator?.effective_date ?? null,
      appliesFromYear: escalator?.applies_from_year ?? null,
    }
    prompt = buildEscalatorProposalPrompt(context)
  } else if (ruleType === 'discount') {
    const discounts = terms.discounts ?? []
    const discount = discounts.find(d => d.discount_rule_id === discountId)
      ?? (Number.isInteger(Number(discountId)) ? discounts[Number(discountId)] : undefined)
    if (!discount) return NextResponse.json({ error: `Discount '${discountId}' not found on this job` }, { status: 404 })
    sourceClauseAvailable = sourceClauseAvailable || !!discount.description
    const context: DiscountContext = {
      sourceClause: sourceClauseFor(discount.description, sourceClause),
      description: discount.description ?? '',
      currency,
      existingPct: discount.discount_pct ?? null,
      existingAmount: discount.discount_amount ?? null,
      extractedType: discount.discount_type ?? null,
      appliesTo: discount.applies_to ?? null,
    }
    prompt = buildDiscountProposalPrompt(context)
  } else if (ruleType === 'tier_calculation') {
    if (!contractUnitType) return NextResponse.json({ error: 'contractUnitType is required for tier_calculation' }, { status: 400 })
    const tiers = (terms.overage_tiers ?? []).filter(t => t.unit_type === contractUnitType && (t.rate_per_unit ?? 0) > 0)
    const extractedClause = tiers.find(t => t.tier_calculation?.source_clause)?.tier_calculation?.source_clause
    sourceClauseAvailable = sourceClauseAvailable || !!extractedClause
    const context: TierCalculationContext = {
      contractUnitType,
      sourceClause: sourceClauseFor(extractedClause, sourceClause),
      currency,
      tiers: tiers.map(t => ({ tier_label: t.tier_label, from_unit: t.from_unit, to_unit: t.to_unit, rate_per_unit: t.rate_per_unit })),
    }
    prompt = buildTierCalculationProposalPrompt(context)
  } else if (ruleType === 'service_credit') {
    const credits = terms.service_credits ?? []
    const credit = credits.find(c => c.credit_rule_id === creditId)
      ?? (Number.isInteger(Number(creditId)) ? credits[Number(creditId)] : undefined)
    if (!credit) return NextResponse.json({ error: `Service credit '${creditId}' not found on this job` }, { status: 404 })
    sourceClauseAvailable = sourceClauseAvailable || !!credit.description || !!credit.source_clause
    const context: ServiceCreditContext = {
      sourceClause: sourceClauseFor(credit.source_clause, sourceClause),
      description: credit.description ?? '',
      creditType: credit.credit_type ?? 'other',
      statedPct: credit.stated_pct ?? null,
      statedAmount: credit.stated_amount ?? null,
      currency,
    }
    prompt = buildServiceCreditProposalPrompt(context)
  } else if (ruleType === 'rule_interaction') {
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
    prompt = buildRuleInteractionProposalPrompt(context)
  } else {
    return NextResponse.json({ error: `Unknown ruleType: ${ruleType}` }, { status: 400 })
  }

  // Cache hit: the exact prompt (i.e. the exact source data) this rule
  // instance was last proposed from hasn't changed, so the AI's answer
  // can't have changed either — skip the Claude call entirely. A cache
  // miss (prompt text differs, e.g. extraction was corrected) always falls
  // through to a fresh call rather than ever serving a stale answer.
  const cached = terms.ai_proposal_cache?.[cacheKey]
  if (cached && cached.promptFingerprint === prompt) {
    return NextResponse.json({ ok: true, proposal: cached.proposal, cached: true })
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
    console.error(`[propose-rule] AI call failed for job ${jobId}:`, err)
    return NextResponse.json({ error: 'Verdix could not reach the AI interpretation service. Try again.' }, { status: 502 })
  }

  const jsonMatch = rawText.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    return NextResponse.json({
      ok: true,
      proposal: { state: 'decision_required', proposed_interpretation: null, reasoning: 'Verdix could not produce a structured proposal for this clause.' } as RuleProposal,
    })
  }
  let parsedRaw: Record<string, unknown>
  try {
    parsedRaw = JSON.parse(jsonMatch[0]) as Record<string, unknown>
  } catch {
    return NextResponse.json({
      ok: true,
      proposal: { state: 'decision_required', proposed_interpretation: null, reasoning: 'Verdix could not produce a structured proposal for this clause.' } as RuleProposal,
    })
  }

  const rawProposal: RuleProposal = {
    state: (parsedRaw.state as RuleProposal['state']) ?? 'decision_required',
    proposed_interpretation: (parsedRaw.proposed_interpretation as Record<string, unknown> | null) ?? null,
    reasoning: typeof parsedRaw.reasoning === 'string' ? parsedRaw.reasoning : '',
    calculation_preview: parsedRaw.calculation_preview as RuleProposal['calculation_preview'],
  }

  const proposal = validateProposalState(rawProposal, sourceClauseAvailable)

  // Best-effort — a failed cache write just means the next open recomputes
  // rather than reusing, never a correctness issue worth failing the request over.
  await supabaseServer
    .from('contract_terms')
    .update({ ai_proposal_cache: { ...(terms.ai_proposal_cache ?? {}), [cacheKey]: { promptFingerprint: prompt, proposal, computedAt: new Date().toISOString() } } })
    .eq('id', terms.id)
    .then(({ error }) => { if (error) console.warn(`[propose-rule] cache write failed for job ${jobId}:`, error.message) })

  return NextResponse.json({ ok: true, proposal })
}
