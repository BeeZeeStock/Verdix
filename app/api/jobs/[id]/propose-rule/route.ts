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

// Without this, the route falls back to whatever the deployment's platform
// default is — on some plans/configurations short enough that a live Claude
// call (routinely 5-15s, occasionally longer under load) gets killed before
// it returns. The client's fetch then never resolves/rejects cleanly, and
// the calling RuleInterpretationCard is left showing its "reading the
// source clause…" spinner indefinitely — which reads as "this card is
// missing/stuck" rather than a timeout, exactly the symptom reported for
// AI-dependent review cards in production but never reproducible locally
// (a direct script call to the same AI client has no such limit).
// Bumped from 60 to 290 for the reasoning-tier (Opus + adaptive thinking)
// routing — confirmed live that a 60s budget isn't enough for a full
// commercial-clause interpretation call under high-effort thinking; see
// lib/ai-client.ts's AI_REASONING_CLIENT_TIMEOUT_MS (280s per attempt, no
// retries), which this must stay above.
export const maxDuration = 290
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
import { listMatchableOrganizationRules } from '@/lib/rulebook/organization-rules-service'
import { resolveProductionOrganizationField, organizationPolicyAvailableForUnresolvedReason, resolveAuthoritativeUnresolvedReason } from '@/lib/rulebook/organization-rulebook-production'

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

// Step 5C — surfaces organization-policy availability to the review panel
// BEFORE the reviewer has to make a manual survival decision, so an
// approved private policy actually eliminates the repetitive click rather
// than only being reachable after one. READ-ONLY: reuses
// resolveProductionOrganizationField (the exact same production resolver
// confirm-rule/route.ts calls) against organization rules already loaded
// for this org — no duplicated matching/precedence logic, and no write to
// contract_terms here. Only ever runs for a proposal the AI itself already
// graded 'decision_required' for survival (genuine contract silence,
// already validated by validateProposalState) — never overrides an
// explicit or recommended AI value. Returns the SAME proposal object
// (referentially) when nothing applies, so callers can pass it straight
// through without a defensive null-check.
//
// Step 16A — 'decision_required' alone is not enough: it collapses two
// different facts (see UnresolvedReason's own comment) — the contract
// simply never raising this question, versus the contract affirmatively
// stating the parties did NOT reach agreement on it. A real negotiated
// non-agreement is stronger, still-contract-derived evidence than
// ordinary silence, and an organization-wide default must never silently
// stand in for it — the authority hierarchy is contract-derived > reviewer
// policy > organization policy > Verdix rulebook > Verdix recommendation,
// and an explicit (if unresolved) contract fact outranks an organization
// default. Confirmed live: OS-2026-09's Annual Rebate states "The parties
// do not agree in this Agreement whether an unused rebate credit survives
// termination" — that must surface as a contract-level Decision Required
// for THIS agreement, never auto-filled from an unrelated org-wide
// carry-forward default.
// sourceClause: the credit's actual persisted source_clause text (the
// same resolvedSourceClause this proposal's own prompt was built from,
// whichever call site — fresh compute or cache-hit — is invoking this).
// Step 16A amendment (item 3): a cached proposal's survival_unresolved_reason
// may be `undefined` (any cache entry written before this field existed),
// which must never be silently treated as 'silent' — resolveAuthoritative
// UnresolvedReason re-derives it from the real clause text instead.
async function withOrganizationPolicyAvailability(
  proposal: RuleProposal, orgId: string, creditType: string, sourceClause: string | null,
): Promise<RuleProposal> {
  if (proposal.survival_state !== 'decision_required') return proposal
  const unresolvedReason = resolveAuthoritativeUnresolvedReason(proposal.survival_unresolved_reason, sourceClause, 'survival')
  if (!organizationPolicyAvailableForUnresolvedReason(unresolvedReason)) return proposal
  const orgRules = await listMatchableOrganizationRules(orgId)
  const resolution = resolveProductionOrganizationField('survival.carry_forward', {
    organizationId: orgId,
    commercialContext: {
      current: { 'survival.carry_forward': { value: 'unclear', provenance: null } },
      // application.timing mirrors confirm-rule's own call site — every
      // current credit's availability is 'next_period' (the only value
      // CreditApplicationRule.availability implements today).
      match: { rule_type: creditType, application: { timing: 'next_invoice' } },
    },
    organizationRules: orgRules,
    asOf: new Date(),
  })
  if (resolution.status !== 'resolved') return proposal
  // Carries the actual rule id/version/value — see RuleProposal.
  // survival_organization_policy's own comment for why this is real
  // metadata, not a boolean: the review panel shows the reviewer WHAT
  // policy is being applied, and confirm-rule uses it as staleness
  // evidence (never as authority — it re-resolves independently).
  // rule_name is looked up from orgRules (already loaded for matching, no
  // extra query) purely for display — never part of the staleness
  // comparison, which stays scoped to rule_id/version/value.
  const matchedRule = orgRules.find(r => r.id === resolution.ruleId)
  return {
    ...proposal,
    survival_organization_policy: { rule_id: resolution.ruleId!, version: resolution.ruleVersion!, value: resolution.value as boolean, rule_name: matchedRule?.name ?? null },
  }
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
  // /interpret-rule — never from client-supplied contract fields. Addressed
  // via jobs.contract_terms_id (a single-row primary-key lookup) rather than
  // an unordered jobs -> contract_terms(...) join + [0] — the join could
  // silently serve a stale, pre-re-extraction row if more than one
  // contract_terms row ever existed for this job.
  const { data: job } = await supabaseServer
    .from('jobs')
    .select('id, org_id, contract_terms_id')
    .eq('id', jobId)
    .eq('org_id', org.orgId)
    .single()

  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  if (!job.contract_terms_id) return NextResponse.json({ error: 'Contract terms not found' }, { status: 404 })

  type TermsRow = {
    id: string
    currency: string | null
    overage_tiers: TierRow[] | null
    escalators: Array<{ escalator_pct: number | null; cap_pct: number | null; effective_date: string | null; applies_from_year: number | null; description: string }> | null
    discounts: Array<{ discount_rule_id?: string; discount_pct: number | null; discount_amount: number | null; discount_type: string | null; applies_to: string | null; description: string | null }> | null
    service_credits: Array<{ credit_rule_id?: string; credit_type: string | null; description: string | null; source_clause: string | null; stated_pct: number | null; stated_amount: number | null }> | null
    contract_start_date: string | null
    contract_end_date: string | null
    base_monthly_fee: number | null
    base_annual_fee: number | null
    billing_frequency: string | null
    base_fee_proration: { source_clause?: string | null } | null
    additional_recurring_fees: Array<{ fee_label: string; amount: number; description: string | null; proration?: { source_clause?: string | null } | null }> | null
  }
  const { data: termsRaw } = await supabaseServer
    .from('contract_terms')
    .select('id, currency, overage_tiers, escalators, discounts, service_credits, contract_start_date, contract_end_date, base_monthly_fee, base_annual_fee, billing_frequency, base_fee_proration, additional_recurring_fees')
    .eq('id', job.contract_terms_id)
    .single()
  const terms = termsRaw as unknown as TermsRow | null
  if (!terms) return NextResponse.json({ error: 'Contract terms not found' }, { status: 404 })

  // Isolated from the query above deliberately — ai_proposal_cache requires
  // a migration (20260819000001_ai_proposal_cache.sql) that may not have
  // run yet in every environment. Fetching it as its own query means a
  // missing column can only ever disable caching (empty object, silently),
  // never break context-fetching for the actual proposal itself.
  let existingCache: Record<string, { promptFingerprint: string; proposal: RuleProposal }> = {}
  const { data: cacheRow, error: cacheReadError } = await supabaseServer
    .from('contract_terms')
    .select('ai_proposal_cache')
    .eq('id', terms.id)
    .maybeSingle()
  if (cacheReadError) {
    console.warn(`[propose-rule] ai_proposal_cache column missing — run the pending migration. Falling back without caching.`)
  } else {
    existingCache = (cacheRow?.ai_proposal_cache as typeof existingCache | null) ?? {}
  }

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
  // Sonnet, not the reasoning tier — see lib/contract-extractor.ts's
  // identical A/B-result comment.
  const client = getAIClient()
  let prompt: string
  let sourceClauseAvailable = !!sourceClause
  // Captured alongside sourceClauseAvailable in every branch below — the
  // grounded fallback reasoning (used if the AI call fails or returns
  // something unparsable) quotes this instead of a bare apology, so a
  // reviewer facing a failed AI call still sees the real clause and can act
  // on it, exactly the same information the successful-path reasoning
  // would have started from.
  let resolvedSourceClause: string | null = sourceClause ?? null
  // service_credit only — captured here (not re-derived near the return
  // points) so withOrganizationPolicyAvailability sees the exact same
  // credit_type the AI prompt itself was built from.
  let serviceCreditType: string | null = null

  if (ruleType === 'minimum_commitment') {
    if (!contractUnitType) return NextResponse.json({ error: 'contractUnitType is required for minimum_commitment' }, { status: 400 })
    const tiers = (terms.overage_tiers ?? []).filter(t => t.unit_type === contractUnitType)
    const includedTier = tiers.find(t => (t.rate_per_unit ?? 0) === 0)
    const paidTiers = tiers.filter(t => (t.rate_per_unit ?? 0) > 0)
    const existingMinimum = tiers.reduce((max, t) => Math.max(max, t.minimum_period_amount ?? 0), 0)
    const extractedClause = tiers.find(t => t.minimum_commitment?.source_clause)?.minimum_commitment?.source_clause
    sourceClauseAvailable = sourceClauseAvailable || !!extractedClause
    resolvedSourceClause = sourceClauseFor(extractedClause, sourceClause)
    const context: MinimumCommitmentContext = {
      contractUnitType,
      sourceClause: resolvedSourceClause,
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
    resolvedSourceClause = sourceClauseFor(extractedClause, sourceClause)
    const context: PartialPeriodContext = {
      contractUnitType,
      sourceClause: resolvedSourceClause,
      currency,
      contractStartDate: terms.contract_start_date,
      contractEndDate: terms.contract_end_date,
      measurementPeriod: tiers[0]?.measurement_period ?? null,
      minimumAmount: existingMinimum > 0 ? existingMinimum : null,
    }
    prompt = buildPartialPeriodProposalPrompt(context)
  } else if (ruleType === 'base_fee_proration' || ruleType === 'recurring_fee_proration') {
    // Same underlying question as partial_period, applied to the base fee
    // (job-level, singular — contractUnitType is a fixed sentinel) or one
    // AdditionalRecurringFee (contractUnitType repurposed to carry fee_label,
    // matching how confirm-rule already addresses it).
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
    sourceClauseAvailable = sourceClauseAvailable || !!extractedClause
    resolvedSourceClause = sourceClauseFor(extractedClause, sourceClause)
    const context: PartialPeriodContext = {
      contractUnitType: subjectLabel,
      sourceClause: resolvedSourceClause,
      currency,
      contractStartDate: terms.contract_start_date,
      contractEndDate: terms.contract_end_date,
      measurementPeriod: terms.billing_frequency,
      minimumAmount: amount,
      subjectNoun: 'recurring fee',
    }
    prompt = buildPartialPeriodProposalPrompt(context)
  } else if (ruleType === 'escalator') {
    const escalator = (terms.escalators ?? [])[0]
    sourceClauseAvailable = sourceClauseAvailable || !!escalator?.description
    resolvedSourceClause = sourceClauseFor(escalator?.description, sourceClause)
    const context: EscalatorContext = {
      sourceClause: resolvedSourceClause,
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
    resolvedSourceClause = sourceClauseFor(discount.description, sourceClause)
    const context: DiscountContext = {
      sourceClause: resolvedSourceClause,
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
    resolvedSourceClause = sourceClauseFor(extractedClause, sourceClause)
    const context: TierCalculationContext = {
      contractUnitType,
      sourceClause: resolvedSourceClause,
      currency,
      tiers: tiers.map(t => ({ tier_label: t.tier_label, from_unit: t.from_unit, to_unit: t.to_unit, rate_per_unit: t.rate_per_unit })),
    }
    prompt = buildTierCalculationProposalPrompt(context)
  } else if (ruleType === 'service_credit') {
    const credits = terms.service_credits ?? []
    const credit = credits.find(c => c.credit_rule_id === creditId)
      ?? (Number.isInteger(Number(creditId)) ? credits[Number(creditId)] : undefined)
    if (!credit) return NextResponse.json({ error: `Service credit '${creditId}' not found on this job` }, { status: 404 })
    serviceCreditType = credit.credit_type ?? 'other'
    sourceClauseAvailable = sourceClauseAvailable || !!credit.description || !!credit.source_clause
    resolvedSourceClause = sourceClauseFor(credit.source_clause, sourceClause)
    const context: ServiceCreditContext = {
      sourceClause: resolvedSourceClause,
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
    resolvedSourceClause = sourceClause ?? otherDescription ?? null
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
  const cached = existingCache[cacheKey]
  if (cached && cached.promptFingerprint === prompt) {
    // Re-checked on every cache hit, not baked into the cached object
    // itself — organization rules can be added/activated at any time,
    // independent of whether the underlying AI prompt/answer changed, and
    // this check is a cheap deterministic DB read, not an AI call, so
    // there is no cost reason to let it go stale for the life of the cache.
    const cachedProposal = ruleType === 'service_credit' && serviceCreditType
      ? await withOrganizationPolicyAvailability(cached.proposal, org.orgId, serviceCreditType, resolvedSourceClause)
      : cached.proposal
    return NextResponse.json({ ok: true, proposal: cachedProposal, cached: true })
  }

  let rawText: string
  let stopReason: string | undefined
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      // max_tokens caps the JSON response. 20,000 leaves generous headroom
      // over a normal structured-proposal response (typically well under
      // 2,000 tokens) — kept elevated from an earlier reasoning-tier
      // experiment on this route (see CLAUDE.md's "AI model routing"
      // section); this call itself is plain Sonnet, no thinking.
      max_tokens: 20000,
      messages: [{ role: 'user', content: prompt }],
    })
    const content = response.content[0]
    if (content.type !== 'text') throw new Error('Unexpected response type from Claude')
    rawText = content.text
    stopReason = (response as unknown as { stop_reason?: string }).stop_reason
  } catch (err) {
    console.error(`[propose-rule] AI call failed for job ${jobId}:`, err)
    return NextResponse.json({ error: 'Verdix could not reach the AI interpretation service. Try again.' }, { status: 502 })
  }

  // Grounded fallback for when the model's response can't be parsed at all
  // (missing/malformed JSON) — never a bare apology. Reuses the exact
  // clause this call was built from, so a reviewer facing a failed AI call
  // still sees the real contract text and the same "silence is silence,
  // not evidence" framing every prompt above already applies, rather than
  // an opaque dead end. state stays decision_required / proposed_
  // interpretation stays null deliberately — a failed call must never
  // fabricate a confident structured answer.
  const groundedParseFailureProposal = (): RuleProposal => ({
    state: 'decision_required',
    proposed_interpretation: null,
    reasoning: resolvedSourceClause
      ? `Verdix could not generate a structured AI proposal for this clause just now. The source clause is: "${resolvedSourceClause}" — review it directly and record a reviewer decision below.`
      : 'Verdix could not generate a structured AI proposal for this clause just now, and no source clause was captured to review directly — treat this as an open reviewer decision.',
  })

  // Diagnostic logging for a parse failure — deliberately structural only.
  // rawText is derived from the customer's own contract text (it's an echo
  // of/reasoning about the source clause), so it must never be written to
  // application logs, including in development — only shape/metadata that
  // can't leak commercial terms, customer names, or clause text.
  const logParseFailure = (failureType: string, extra: Record<string, unknown> = {}) => {
    console.error('[propose-rule] parse failure', {
      jobId, ruleType, failureType, stopReason,
      responseLength: rawText.length,
      model: 'claude-sonnet-4-6',
      ...extra,
    })
  }

  const jsonMatch = rawText.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    logParseFailure('no_json_object_found')
    return NextResponse.json({ ok: true, proposal: groundedParseFailureProposal() })
  }
  let parsedRaw: Record<string, unknown>
  try {
    parsedRaw = JSON.parse(jsonMatch[0]) as Record<string, unknown>
  } catch (err) {
    logParseFailure('json_parse_error', {
      parserError: err instanceof Error ? err.message : String(err),
      matchedTextLength: jsonMatch[0].length,
      matchStartIndex: jsonMatch.index,
    })
    return NextResponse.json({ ok: true, proposal: groundedParseFailureProposal() })
  }

  const rawProposal: RuleProposal = {
    state: (parsedRaw.state as RuleProposal['state']) ?? 'decision_required',
    proposed_interpretation: (parsedRaw.proposed_interpretation as Record<string, unknown> | null) ?? null,
    reasoning: typeof parsedRaw.reasoning === 'string' ? parsedRaw.reasoning : '',
    calculation_preview: parsedRaw.calculation_preview as RuleProposal['calculation_preview'],
    // service_credit only — buildServiceCreditProposalPrompt asks Claude for
    // this and validateProposalState grades/corrects it, but this was never
    // actually pulled out of the raw parsed response, so it was silently
    // always undefined regardless of what the prompt asked for or what
    // Claude returned. The entire "Application scope" split (item 7 —
    // Annual Rebate/Growth Credit/Service Credit's unresolved
    // application/carry-forward policy) never reached the client.
    application_state: parsedRaw.application_state as RuleProposal['application_state'],
    // Same extraction gap as application_state above, for the newer,
    // independently-graded survival/expiry question (carry_forward/
    // one_time) — must be pulled out explicitly here too, not just added to
    // the type/prompt/validator, or it silently stays undefined forever.
    survival_state: parsedRaw.survival_state as RuleProposal['survival_state'],
    // Same extraction discipline, for cash_redeemable (Step 1.5) — must be
    // pulled out explicitly here too, or it silently stays undefined
    // forever regardless of what the prompt asked for or what Claude returned.
    cash_redeemable_state: parsedRaw.cash_redeemable_state as RuleProposal['cash_redeemable_state'],
  }

  const proposal = validateProposalState(rawProposal, sourceClauseAvailable, resolvedSourceClause)

  // Best-effort, and — since Step 16A.1 — atomic at the database level.
  // A failed cache write just means the next open recomputes rather than
  // reusing, never a correctness issue worth failing the request over: no
  // downstream logic (confirm-rule's org-policy gate, this route's own
  // cash-redeemable path) assumes this write is guaranteed to have landed
  // — both independently re-derive from the credit's persisted
  // source_clause when the cache is missing or stale. See this route's
  // own cache-hit branch above and confirm-rule/route.ts's
  // resolveAuthoritativeUnresolvedReason.
  //
  // Caches the UNAUGMENTED proposal deliberately — organization-policy
  // availability is re-checked fresh on every request (see the cache-hit
  // branch above), so a rule added/activated after this proposal was first
  // cached still takes effect on the very next open, without needing the
  // AI cache itself to be invalidated.
  //
  // Step 16A.1 — was previously a whole-column read-modify-write
  // (`{ ...existingCache, [cacheKey]: ... }`), which lost updates when two
  // rule cards on the same job proposed concurrently: each request read
  // the column before either write landed, so whichever write committed
  // second silently reverted the other's key. set_proposal_cache_entry
  // (supabase/migrations/20260830000006_proposal_cache_atomic_upsert.sql)
  // does the merge in a single atomic UPDATE ... jsonb_set against the
  // CURRENT row value, so concurrent writes to different keys can no
  // longer clobber each other — Postgres's own row-level locking
  // serializes them instead of JS holding a stale snapshot.
  if (!cacheReadError) {
    const { error: cacheWriteError } = await supabaseServer.rpc('set_proposal_cache_entry', {
      p_contract_terms_id: terms.id,
      p_cache_key: cacheKey,
      p_cache_entry: { promptFingerprint: prompt, proposal, computedAt: new Date().toISOString() },
    })
    // Explicit, not silent — never claim a persisted write succeeded when
    // it didn't. The client still gets the freshly-computed proposal
    // either way (returned below); this only affects whether the NEXT
    // request gets to reuse it from cache.
    if (cacheWriteError) console.warn(`[propose-rule] cache write failed for job ${jobId}:`, cacheWriteError.message)
  }

  const returnedProposal = ruleType === 'service_credit' && serviceCreditType
    ? await withOrganizationPolicyAvailability(proposal, org.orgId, serviceCreditType, resolvedSourceClause)
    : proposal

  return NextResponse.json({ ok: true, proposal: returnedProposal })
}
