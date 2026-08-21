/**
 * POST /api/org/rulebook/promote
 *
 * Step 5D item 2 — "Use as organization default." Turns an already-made,
 * contract-specific reviewer decision into a private organization policy
 * CANDIDATE. Two-phase, matching item 5 ("preview before creation") and
 * item 6 ("create as draft" — never active from a single click):
 *   - confirm omitted/false: dry-run. Evaluates eligibility and returns the
 *     proposed structured scope for the preview screen. Writes nothing.
 *   - confirm: true: re-evaluates (never trusts the client's earlier
 *     preview response as authority — see below) and, if still eligible,
 *     creates the rule via createOrganizationRule with
 *     source_kind: 'reviewer_promotion', status: 'draft'.
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
 * whatever this route itself reads from the database.
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
import { createOrganizationRule } from '@/lib/rulebook/organization-rules-service'
import { evaluateReviewerDecisionForPromotion, type PromotableFieldState } from '@/lib/rulebook/organization-rulebook-promotion'
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

  if (!body.confirm) {
    // Dry run — the preview screen (item 5). No write.
    return NextResponse.json({
      eligible: true,
      preview: {
        targetField: evaluation.targetField,
        value: evaluation.value,
        matchConditions: evaluation.matchConditions,
        scopeSummary: evaluation.scopeSummary,
      },
    })
  }

  const rule = await createOrganizationRule({
    organizationId: org.orgId,
    name: body.name?.trim() || `${evaluation.scopeSummary.ruleTypeLabel} carry-forward default`,
    description: body.description ?? `Promoted from a reviewer decision on job ${job.id}.`,
    targetField: evaluation.targetField,
    value: evaluation.value,
    matchConditions: evaluation.matchConditions,
    sourceKind: 'reviewer_promotion',
    createdBy: org.userEmail,
    // No status/approvedBy — defaults to 'draft'. Create ≠ approve ≠
    // activate (item 6): this route NEVER activates what it creates.
  })

  return NextResponse.json({ eligible: true, rule })
}
