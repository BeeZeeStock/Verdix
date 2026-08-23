/**
 * POST /api/org/rulebook/[id]/activate
 *
 * Step 5D item 7 — "Approve & activate." Uses the EXISTING atomic
 * activation path (activateOrganizationRule ->
 * activate_organization_rule_supersession, Step 5B.5) exclusively — no
 * temporal/supersession logic is reimplemented here. This route's only
 * added behavior is item 8's proactive overlap check, run BEFORE calling
 * that path, so a conflict surfaces as a clear "current vs proposed"
 * comparison instead of a raw database exclusion-constraint error.
 *
 * Overlap handling (item 8):
 *   - No active rule occupies the same (target_field, match_conditions)
 *     slot outside this rule's own lineage -> activate directly.
 *   - One does, and the request did NOT set confirmReplace -> return 409
 *     with both policies' details. Nothing is written. The client's two
 *     safe actions are: "Replace from effective date" (resubmit with
 *     confirmReplace: true) or "Cancel" (do nothing — the draft, being a
 *     draft, still has zero production effect either way).
 *   - confirmReplace: true -> discard the original standalone draft FIRST
 *     (discardDraftOrganizationRule), THEN re-derive a properly-linked new
 *     draft via supersedeOrganizationRule (previousRuleId = the conflicting
 *     active rule) and activate THAT. "Replacement must use the existing
 *     version/cutover path" — both the version creation
 *     (supersedeOrganizationRule) and the cutover (activateOrganizationRule)
 *     are the exact same, unmodified Step 5A/5B.5 functions used everywhere
 *     else in this codebase.
 *
 *     Order matters, and was corrected in the final concurrency-safety
 *     pass: discard MUST happen before supersede, not after. The standalone
 *     draft and the properly-linked successor occupy the IDENTICAL
 *     canonical slot (same organization_id/target_field/match_conditions),
 *     and the database now enforces at most one 'draft' row per slot
 *     (org_rulebook_one_draft_per_slot,
 *     20260826000001_organization_policy_slot_uniqueness.sql). Discarding
 *     the standalone draft first (flips it to 'disabled', which the
 *     uniqueness index doesn't cover) frees the slot so
 *     supersedeOrganizationRule's insert succeeds; attempting it in the
 *     other order — as an earlier version of this route did, before that
 *     invariant existed — deterministically fails every time with an
 *     OrganizationPolicySlotRaceError, since the standalone draft is still
 *     sitting on the exact slot the new linked draft needs.
 *
 * Security (item 13): the [id] path segment and any client-supplied
 * effectiveFrom are never trusted as authority on their own —
 * getOrganizationRule/activateOrganizationRule/findActiveRuleForSameSlot
 * all filter by requireOrg()'s trusted org.orgId. approvedBy is always
 * org.userEmail from the authenticated session, never a client-supplied
 * value — "a rule can never activate itself" (organization-rules-
 * service.ts's own assertion) extends here to "a rule can never be
 * activated by a caller-claimed approver identity" either.
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireOrg } from '@/lib/org'
import {
  getOrganizationRule, activateOrganizationRule, findActiveRuleForSameSlot,
  supersedeOrganizationRule, discardDraftOrganizationRule,
} from '@/lib/rulebook/organization-rules-service'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }
  const { id } = await params

  const draft = await getOrganizationRule(org.orgId, id)
  if (!draft) return NextResponse.json({ error: 'Rule not found' }, { status: 404 })
  if (draft.status !== 'draft') {
    return NextResponse.json({ error: `Only a draft rule can be activated (this rule is ${draft.status})` }, { status: 400 })
  }

  const body = await req.json().catch(() => ({})) as { effectiveFrom?: string; confirmReplace?: boolean }
  const effectiveAt = body.effectiveFrom ? new Date(body.effectiveFrom) : new Date()
  if (Number.isNaN(effectiveAt.getTime())) {
    return NextResponse.json({ error: 'effectiveFrom is not a valid date' }, { status: 400 })
  }

  const conflict = await findActiveRuleForSameSlot(org.orgId, draft.targetField, draft.matchConditions, draft.lineageId)

  if (conflict && conflict.id !== draft.supersedesRuleId && !body.confirmReplace) {
    return NextResponse.json({
      conflict: true,
      currentPolicy: conflict,
      proposedPolicy: draft,
      message: 'An active organization policy already covers this scope. Resubmit with confirmReplace to replace it from an effective date, or leave both unchanged.',
    }, { status: 409 })
  }

  try {
    // Already linked to the same conflicting rule (draft was created via
    // /supersede against it directly) — activate as-is, no re-derivation
    // needed.
    if (!conflict || conflict.id === draft.supersedesRuleId) {
      const activated = await activateOrganizationRule(org.orgId, draft.id, org.userEmail, effectiveAt)
      return NextResponse.json({ rule: activated })
    }

    // confirmReplace: true, and the draft is a STANDALONE rule (not yet
    // linked to the conflicting active rule) — discard the orphaned
    // original FIRST (frees the canonical slot), THEN re-derive a
    // properly-linked successor version and activate it. See this route's
    // own header comment for why the order is load-bearing, not cosmetic.
    await discardDraftOrganizationRule(org.orgId, draft.id)
    const linkedVersion = await supersedeOrganizationRule({
      organizationId: org.orgId,
      previousRuleId: conflict.id,
      name: draft.name,
      description: draft.description,
      targetField: draft.targetField,
      value: draft.value,
      matchConditions: draft.matchConditions,
      createdBy: draft.createdBy,
    })
    const activated = await activateOrganizationRule(org.orgId, linkedVersion.id, org.userEmail, effectiveAt)
    return NextResponse.json({ rule: activated, replacedDraftId: draft.id })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed to activate rule' }, { status: 400 })
  }
}
