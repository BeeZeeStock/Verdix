/**
 * POST /api/org/rulebook/promote
 *
 * Step 5D item 2 — "Use as organization default." Turns an already-made,
 * contract-specific reviewer decision into a private organization policy
 * CANDIDATE. Two-phase, matching item 5 ("preview before creation") and
 * item 6 ("create as draft" — never active from a single click):
 *   - confirm omitted/false: dry-run. Evaluates eligibility AND the
 *     current policy-slot state (see below), returning enough for the
 *     client to render the right UI before the reviewer commits to
 *     anything. Writes nothing.
 *   - confirm: true: re-evaluates (never trusts the client's earlier
 *     preview response as authority — see below) and delegates to
 *     lib/rulebook/organization-rules-service.ts's
 *     resolveOrganizationPolicySlotForWrite — the single shared,
 *     concurrency-safe write boundary (see that function's own header
 *     comment for why it lives in the service layer, not here).
 *
 * Final amendment (concurrency-safety pass) — a PREVIOUS version of this
 * route did its own dedup check (findOrganizationRulesForSlot + classify)
 * and then wrote directly, which closed the "identical value" duplicate-
 * draft bug but left a real TOCTOU race open: two concurrent confirmed
 * promotions could both read "no existing draft" before either had
 * written anything, and both would proceed to insert — the database's own
 * exclusion constraints do not help here, since both are scoped to
 * `status in ('active', 'superseded')` (see
 * 20260823000001_organization_rulebook_temporal_validity.sql) and a
 * 'draft' row sits entirely outside either constraint's WHERE clause. This
 * is now closed by a new database-level partial unique index
 * (20260826000001_organization_policy_slot_uniqueness.sql, at most one
 * 'draft' per canonical slot) — resolveOrganizationPolicySlotForWrite
 * handles the race atomically: whichever request loses gets the SAME
 * semantic outcome (existing_draft / draft_conflict) a request that simply
 * ran second would have gotten, never an opaque database error.
 *
 * Security (item 13) — the entire point of this route's design: the
 * client sends only { jobId, creditId } (plus optional name/description
 * for the new rule's cosmetic labeling) — NEVER the field, value, or
 * scope to promote. This route independently loads the job (org-scoped —
 * .eq('org_id', org.orgId), the exact same defense-in-depth check
 * confirm-rule/route.ts uses), the credit, and its CURRENTLY PERSISTED
 * application_rule.survival_provenance/carry_forward from contract_terms,
 * and hands that server-derived state to evaluateReviewerDecisionForPromotion.
 * A client cannot cause a value it merely claims to be promoted — only
 * whatever this route itself reads from the database. The slot-state
 * lookup below is the same discipline one level further: the CLIENT may
 * have shown the reviewer a state from an earlier dry run, but this route
 * always re-derives it from the database at confirm time, never trusting
 * what the client's request claims the state to be (the request carries
 * no such field at all).
 *
 * Item 3 — this route never touches contract_terms, commercial_rule_
 * interpretations, or any other agreement-scoped write. The agreement's own
 * survival_provenance stays exactly 'reviewer_policy' regardless of what
 * happens to the resulting organization rule (draft, later activated, or
 * never touched again) — a completely separate row, in a completely
 * separate table, is created.
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireOrg } from '@/lib/org'
import { supabaseServer } from '@/lib/supabase'
import { findOrganizationRulesForSlot, resolveOrganizationPolicySlotForWrite } from '@/lib/rulebook/organization-rules-service'
import { evaluateReviewerDecisionForPromotion, type PromotableFieldState } from '@/lib/rulebook/organization-rulebook-promotion'
import { classifyOrganizationPolicySlotOutcome } from '@/lib/rulebook/organization-policy-slot'
import type { OrganizationRuleRecord } from '@/lib/rulebook/organization-rules'
import type { ServiceCreditInterpretation } from '@/lib/types'

type Credit = { credit_rule_id?: string; credit_type?: string | null; description?: string | null; interpretation?: ServiceCreditInterpretation | null }

export async function POST(req: NextRequest) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const body = await req.json() as { jobId?: string; creditId?: string; confirm?: boolean; name?: string; description?: string | null }
  if (!body.jobId || !body.creditId) {
    return NextResponse.json({ error: 'jobId and creditId are required' }, { status: 400 })
  }

  // Org-scoped job lookup — same defense-in-depth as confirm-rule/route.ts:
  // a job id alone is never sufficient, it must also belong to this org.
  const { data: job } = await supabaseServer
    .from('jobs')
    .select('id, contract_terms_id')
    .eq('id', body.jobId)
    .eq('org_id', org.orgId)
    .maybeSingle()
  if (!job || !job.contract_terms_id) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  const { data: termsRow } = await supabaseServer
    .from('contract_terms')
    .select('service_credits')
    .eq('id', job.contract_terms_id)
    .maybeSingle()
  const credits = (termsRow?.service_credits ?? []) as Credit[]
  const credit = credits.find(c => c.credit_rule_id === body.creditId)
  if (!credit) return NextResponse.json({ error: 'Service credit not found on this job' }, { status: 404 })

  const appRule = credit.interpretation?.application_rule
  const state: PromotableFieldState = {
    targetField: 'survival.carry_forward',
    provenance: appRule?.survival_provenance,
    value: appRule?.carry_forward,
    matchFacts: { ruleType: credit.credit_type ?? 'other', applicationTiming: 'next_invoice' },
  }
  const evaluation = evaluateReviewerDecisionForPromotion(state)

  if (!evaluation.eligible) {
    return NextResponse.json({ eligible: false, reason: evaluation.reason, message: evaluation.message }, { status: 200 })
  }

  const preview = {
    targetField: evaluation.targetField,
    value: evaluation.value,
    matchConditions: evaluation.matchConditions,
    scopeSummary: evaluation.scopeSummary,
  }
  const name = body.name?.trim() || `${evaluation.scopeSummary.ruleTypeLabel} carry-forward default`
  const description = body.description ?? `Promoted from a reviewer decision on job ${job.id}.`

  if (!body.confirm) {
    // Dry run — the preview screen (item 5), AND the slot-state check
    // OrganizationPolicyControls uses to decide which UI to show before
    // the reviewer clicks anything. Read-only: uses the same
    // findOrganizationRulesForSlot lookup the write path uses, but never
    // calls resolveOrganizationPolicySlotForWrite (which can write).
    const { activeRule, draftRule } = await findOrganizationRulesForSlot(org.orgId, evaluation.targetField, evaluation.matchConditions)
    const outcome = classifyOrganizationPolicySlotOutcome(evaluation.value, activeRule, draftRule)
    return NextResponse.json({
      eligible: true,
      state: outcome.state,
      preview,
      existingRule: outcome.state === 'no_existing' ? undefined : toClientRule(outcome.rule),
    })
  }

  // Confirm — the single shared, concurrency-safe write boundary. Never
  // does its own dedup read-then-write here; see that function's own
  // header comment for why it lives in the service layer.
  const result = await resolveOrganizationPolicySlotForWrite({
    organizationId: org.orgId,
    targetField: evaluation.targetField,
    matchConditions: evaluation.matchConditions,
    value: evaluation.value,
    name, description,
    sourceKind: 'reviewer_promotion',
    createdBy: org.userEmail,
  })

  if (result.state === 'no_existing') {
    return NextResponse.json({ eligible: true, state: 'no_existing', rule: result.rule })
  }
  if (result.state === 'proposed_policy_change') {
    return NextResponse.json({ eligible: true, state: result.state, rule: result.rule, existingRule: toClientRule(result.existingRule) })
  }
  // already_covered / existing_draft / draft_conflict — no write happened.
  return NextResponse.json({ eligible: true, state: result.state, existingRule: toClientRule(result.existingRule) })
}

// A trimmed, client-safe projection of an existing rule referenced by a
// dedup outcome — enough for OrganizationPolicyControls to render "View
// policy"/"View draft" and fetch the full record via the existing
// GET /api/org/rulebook/[id] route if the reviewer actually clicks
// through, without shipping every internal field in every promote response.
function toClientRule(rule: OrganizationRuleRecord) {
  return { id: rule.id, name: rule.name, status: rule.status, value: rule.value, version: rule.version }
}
