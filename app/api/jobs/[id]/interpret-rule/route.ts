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
  buildCreditSurvivalPrompt,
  buildRuleInteractionPrompt,
  buildFixedFeeBillingTimingPrompt,
  buildVariableInvoiceTimingPrompt,
  parseRuleInterpretationResponse,
  describeMissingFieldQuestions,
  describeWhatWillChange,
  withAppendixContext,
  baseFeeHasExpiringWaiver,
  type LabeledClauseText,
  type RuleType,
  type MinimumCommitmentContext,
  type PartialPeriodContext,
  type EscalatorContext,
  type DiscountContext,
  type TierCalculationContext,
  type ServiceCreditContext,
  type RuleInteractionContext,
  type FixedFeeBillingTimingContext,
  type VariableInvoiceTimingContext,
} from '@/lib/rule-interpretation'

// See propose-rule/route.ts's identical export for why this matters — this
// route makes the same kind of live Claude call. Bumped to 290 for the same
// reasoning-tier (Opus + adaptive thinking) reason.
export const maxDuration = 290

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

function sourceClauseFor(extracted: string | null | undefined, clientSupplied: string | null | undefined, otherClauses?: LabeledClauseText[]): string | null {
  const resolved = extracted || clientSupplied || null
  return otherClauses ? withAppendixContext(resolved, otherClauses) : resolved
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
    // Narrows a service_credit interpretation to ONLY the unused-balance
    // survival question (carry_forward/expiry_periods) — used by the
    // "Other / describe treatment" choice on that one sub-field, when none
    // of CREDIT_SURVIVAL_OPTIONS' four structured choices fit. Every other
    // ruleType/field this route handles ignores this param.
    subField?: 'survival'
  }

  const { ruleType, contractUnitType, selectedOption, freeText, sourceClause, discountId, creditId, interactionKey, subField } = body
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
  // "facts" about the contract into the AI prompt. Addressed via
  // jobs.contract_terms_id (a single-row primary-key lookup) rather than an
  // unordered jobs -> contract_terms(...) join + [0] — see propose-rule for
  // why that matters once re-extraction is in play.
  const { data: job } = await supabaseServer
    .from('jobs')
    .select('id, org_id, contract_terms_id')
    .eq('id', jobId)
    .eq('org_id', org.orgId)
    .single()

  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  if (!job.contract_terms_id) return NextResponse.json({ error: 'Contract terms not found' }, { status: 404 })

  type TermsRow = {
    currency: string | null
    overage_tiers: TierRow[] | null
    escalators: Array<{ escalator_pct: number | null; cap_pct: number | null; effective_date: string | null; applies_from_year: number | null; description: string }> | null
    discounts: Array<{ discount_rule_id?: string; discount_pct: number | null; discount_amount: number | null; discount_type: string | null; applies_to: string | null; description: string | null; affected_components?: string[] | null; possibly_affected_components?: string[] | null }> | null
    service_credits: Array<{ credit_rule_id?: string; credit_type: string | null; description: string | null; source_clause: string | null; stated_pct: number | null; stated_amount: number | null }> | null
    contract_start_date: string | null
    contract_end_date: string | null
    base_monthly_fee: number | null
    base_annual_fee: number | null
    billing_frequency: string | null
    base_fee_proration: { source_clause?: string | null; confirmation_reason?: string | null } | null
    fixed_fee_billing_timing: { source_clause?: string | null } | null
    additional_recurring_fees: Array<{ fee_label: string; amount: number; description: string | null; source_clause?: string | null; proration?: { source_clause?: string | null } | null; variable_invoice_timing?: { source_clause?: string | null } | null }> | null
    one_time_fees: Array<{ fee_label?: string | null; description?: string | null; source_clause?: string | null }> | null
    unsupported_commercial_mechanisms: Array<{ description?: string | null; source_clause?: string | null }> | null
  }
  const { data: termsRaw } = await supabaseServer
    .from('contract_terms')
    .select('currency, overage_tiers, escalators, discounts, service_credits, contract_start_date, contract_end_date, base_monthly_fee, base_annual_fee, billing_frequency, base_fee_proration, fixed_fee_billing_timing, additional_recurring_fees, one_time_fees, unsupported_commercial_mechanisms')
    .eq('id', job.contract_terms_id)
    .single()
  const terms = termsRaw as unknown as TermsRow | null
  if (!terms) return NextResponse.json({ error: 'Contract terms not found' }, { status: 404 })

  // Step 17B0, item A — same bounded appendix-context set as propose-rule.
  const otherClauses: LabeledClauseText[] = [
    { label: 'base_fee_proration.source_clause', text: terms.base_fee_proration?.source_clause },
    ...(terms.discounts ?? []).map((d, i) => ({ label: `discounts[${i}].description`, text: d.description })),
    ...(terms.service_credits ?? []).flatMap((c, i) => [
      { label: `service_credits[${i}].description`, text: c.description },
      { label: `service_credits[${i}].source_clause`, text: c.source_clause },
    ]),
    ...(terms.additional_recurring_fees ?? []).flatMap((f, i) => [
      { label: `additional_recurring_fees[${i}].description`, text: f.description },
      { label: `additional_recurring_fees[${i}].source_clause`, text: f.source_clause },
      { label: `additional_recurring_fees[${i}].proration.source_clause`, text: f.proration?.source_clause },
    ]),
    ...(terms.one_time_fees ?? []).flatMap((f, i) => [
      { label: `one_time_fees[${i}].description`, text: f.description },
      { label: `one_time_fees[${i}].source_clause`, text: f.source_clause },
    ]),
    ...(terms.unsupported_commercial_mechanisms ?? []).flatMap((m, i) => [
      { label: `unsupported_commercial_mechanisms[${i}].description`, text: m.description },
      { label: `unsupported_commercial_mechanisms[${i}].source_clause`, text: m.source_clause },
    ]),
  ]

  const currency = terms.currency ?? 'EUR'
  // Sonnet, not the reasoning tier — see lib/contract-extractor.ts's
  // identical A/B-result comment.
  const client = getAIClient()

  // Narrow survival-only path — bypasses the generic multi-field
  // parseRuleInterpretationResponse/dependency/historical-impact machinery
  // below entirely, since that machinery is scoped to a full trigger/rate/
  // cap/basis (or metric-level) interpretation this one sub-question never
  // touches. Own minimal validation instead of the shared required-fields
  // list, which doesn't have a service_credit-survival-only entry.
  if (subField === 'survival') {
    if (ruleType !== 'service_credit') return NextResponse.json({ error: 'subField "survival" is only valid for service_credit' }, { status: 400 })
    const credits = terms.service_credits ?? []
    const credit = credits.find(c => c.credit_rule_id === creditId)
    if (!credit) return NextResponse.json({ error: `Service credit '${creditId}' not found on this job` }, { status: 404 })
    const survivalPrompt = buildCreditSurvivalPrompt(
      { sourceClause: sourceClauseFor(credit.source_clause, sourceClause, otherClauses), description: credit.description ?? '' },
      reviewerInput,
    )
    let survivalRawText: string
    try {
      const response = await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 4000, messages: [{ role: 'user', content: survivalPrompt }] })
      const content = response.content[0]
      if (content.type !== 'text') throw new Error('Unexpected response type from Claude')
      survivalRawText = content.text
    } catch (err) {
      console.error(`[interpret-rule] survival AI call failed for job ${jobId}:`, err)
      return NextResponse.json({ error: 'Verdix could not reach the AI interpretation service. Try again.' }, { status: 502 })
    }
    const survivalJsonMatch = survivalRawText.match(/\{[\s\S]*\}/)
    if (!survivalJsonMatch) {
      // Structural-only diagnostic — never the raw response, which echoes
      // customer contract text. See propose-rule/route.ts's identical
      // discipline.
      console.error('[interpret-rule] survival parse failure', { jobId, creditId, failureType: 'no_json_object_found', responseLength: survivalRawText.length })
      return NextResponse.json({ ok: false, questions: ['Verdix could not translate that into a specific treatment — try describing it differently.'] })
    }
    let parsedSurvival: { carry_forward?: unknown; expiry_periods?: unknown; expiry_date?: unknown; calculation_summary?: unknown }
    try {
      parsedSurvival = JSON.parse(survivalJsonMatch[0])
    } catch (err) {
      console.error('[interpret-rule] survival parse failure', { jobId, creditId, failureType: 'json_parse_error', parserError: err instanceof Error ? err.message : String(err) })
      return NextResponse.json({ ok: false, questions: ['Verdix could not translate that into a specific treatment — try describing it differently.'] })
    }
    if (typeof parsedSurvival.carry_forward !== 'boolean') {
      return NextResponse.json({ ok: false, questions: ['Be more specific about whether an unused balance carries forward or expires.'] })
    }
    return NextResponse.json({
      ok: true,
      survival: {
        carry_forward: parsedSurvival.carry_forward,
        expiry_periods: typeof parsedSurvival.expiry_periods === 'number' ? parsedSurvival.expiry_periods : null,
        expiry_date: typeof parsedSurvival.expiry_date === 'string' ? parsedSurvival.expiry_date : null,
      },
      calculationSummary: typeof parsedSurvival.calculation_summary === 'string' ? parsedSurvival.calculation_summary : null,
    })
  }

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
      sourceClause: sourceClauseFor(extractedClause, sourceClause, otherClauses),
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
      sourceClause: sourceClauseFor(extractedClause, sourceClause, otherClauses),
      currency,
      contractStartDate: terms.contract_start_date,
      contractEndDate: terms.contract_end_date,
      measurementPeriod: tiers[0]?.measurement_period ?? null,
      minimumAmount: existingMinimum > 0 ? existingMinimum : null,
    }
    prompt = buildPartialPeriodPrompt(context, reviewerInput, selectedOption)
  } else if (ruleType === 'base_fee_proration' || ruleType === 'recurring_fee_proration') {
    const isBase = ruleType === 'base_fee_proration'
    let amount: number | null
    let extractedClause: string | null | undefined
    let subjectLabel: string
    if (isBase) {
      amount = terms.base_monthly_fee ?? terms.base_annual_fee ?? null
      subjectLabel = 'platform subscription fee'
      extractedClause = terms.base_fee_proration?.source_clause
    } else {
      if (!contractUnitType) return NextResponse.json({ error: 'contractUnitType (fee label) is required for recurring_fee_proration' }, { status: 400 })
      const fee = (terms.additional_recurring_fees ?? []).find(f => f.fee_label === contractUnitType)
      if (!fee) return NextResponse.json({ error: `Recurring fee '${contractUnitType}' not found on this job` }, { status: 404 })
      amount = fee.amount ?? null
      subjectLabel = fee.fee_label
      extractedClause = fee.proration?.source_clause ?? fee.description
    }
    const context: PartialPeriodContext = {
      contractUnitType: subjectLabel,
      sourceClause: sourceClauseFor(extractedClause, sourceClause, otherClauses),
      currency,
      contractStartDate: terms.contract_start_date,
      contractEndDate: terms.contract_end_date,
      measurementPeriod: terms.billing_frequency,
      minimumAmount: amount,
      subjectNoun: 'recurring fee',
      waiverExpiry: isBase ? baseFeeHasExpiringWaiver(terms.discounts) : false,
    }
    prompt = buildPartialPeriodPrompt(context, reviewerInput, selectedOption)
  } else if (ruleType === 'escalator') {
    const escalator = (terms.escalators ?? [])[0]
    const context: EscalatorContext = {
      sourceClause: sourceClauseFor(escalator?.description, sourceClause, otherClauses),
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
      sourceClause: sourceClauseFor(discount.description, sourceClause, otherClauses),
      description: discount.description ?? '',
      currency,
      existingPct: discount.discount_pct ?? null,
      existingAmount: discount.discount_amount ?? null,
      extractedType: discount.discount_type ?? null,
      appliesTo: discount.applies_to ?? null,
      affectedComponents: discount.affected_components ?? null,
      possiblyAffectedComponents: discount.possibly_affected_components ?? null,
    }
    prompt = buildDiscountPrompt(context, reviewerInput, selectedOption)
  } else if (ruleType === 'tier_calculation') {
    if (!contractUnitType) return NextResponse.json({ error: 'contractUnitType is required for tier_calculation' }, { status: 400 })
    const tiers = (terms.overage_tiers ?? []).filter(t => t.unit_type === contractUnitType && (t.rate_per_unit ?? 0) > 0)
    const extractedClause = tiers.find(t => t.tier_calculation?.source_clause)?.tier_calculation?.source_clause
    const context: TierCalculationContext = {
      contractUnitType,
      sourceClause: sourceClauseFor(extractedClause, sourceClause, otherClauses),
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
      sourceClause: sourceClauseFor(credit.source_clause, sourceClause, otherClauses),
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
  } else if (ruleType === 'fixed_fee_billing_timing') {
    // Step 17H.4B0D4H1B4E5 — free-text path only (live-reproduced defect:
    // this ruleType previously had NO case here at all, so ANY interpret-
    // rule call for it — including the review drawer's "Generate billing
    // rule" button fired for a known structured option — hit "Unknown
    // ruleType". A known structured option ("At the beginning/end of each
    // billing period") is fully self-explanatory and is now mapped
    // deterministically client-side, never reaching this route at all (see
    // the review drawer's applyDeterministicFixedFeeTiming) — this branch
    // exists only for "Other / unclear" + a genuine custom instruction.
    const context: FixedFeeBillingTimingContext = {
      sourceClause: sourceClauseFor(terms.fixed_fee_billing_timing?.source_clause, sourceClause, otherClauses),
    }
    prompt = buildFixedFeeBillingTimingPrompt(context, reviewerInput)
  } else if (ruleType === 'variable_invoice_timing') {
    // Step 17H.4B0D4H1B4E5.1 — free-text path only, mirroring
    // fixed_fee_billing_timing's E5 fix exactly (same live-reproduced
    // defect: this ruleType had NO case here at all). Per-fee, not
    // job-level — contractUnitType carries the fee_label, exactly as
    // recurring_fee_proration already addresses this same fee shape above.
    // A known structured option is mapped deterministically client-side
    // (see the review drawer's applyDeterministicVariableInvoiceTiming),
    // never reaching this route — this branch exists only for
    // "Other / unclear" + a genuine custom instruction.
    if (!contractUnitType) return NextResponse.json({ error: 'contractUnitType (fee label) is required for variable_invoice_timing' }, { status: 400 })
    const fee = (terms.additional_recurring_fees ?? []).find(f => f.fee_label === contractUnitType)
    if (!fee) return NextResponse.json({ error: `Recurring fee '${contractUnitType}' not found on this job` }, { status: 404 })
    const context: VariableInvoiceTimingContext = {
      contractUnitType: fee.fee_label,
      sourceClause: sourceClauseFor(fee.variable_invoice_timing?.source_clause ?? fee.description, sourceClause, otherClauses),
    }
    prompt = buildVariableInvoiceTimingPrompt(context, reviewerInput)
  } else {
    return NextResponse.json({ error: `Unknown ruleType: ${ruleType}` }, { status: 400 })
  }

  let rawText: string
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      // Reasoning-tier call — see propose-rule/route.ts's identical comment
      // (confirmed live: high-effort thinking alone can consume ~6,000
      // tokens on a single-credit reasoning task).
      max_tokens: 20000,
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
