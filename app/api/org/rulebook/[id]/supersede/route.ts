/**
 * POST /api/org/rulebook/[id]/supersede
 *
 * Step 5D item 9 — "editing means versioning." A semantic change (value,
 * scope, effective treatment) to an existing rule never mutates it in
 * place — it creates a new draft version (version + 1, supersedes_rule_id
 * pointing at the edited rule), leaving the edited rule's own historical
 * meaning untouched until (and unless) the new version is later activated
 * via /activate. Uses organization-rules-service.ts's
 * supersedeOrganizationRule directly — no new versioning logic here.
 *
 * Scope (target_field/match_conditions) defaults to the PREVIOUS rule's own
 * — Step 5D's UI only ever edits the value (e.g. flipping carry_forward
 * true -> false) or cosmetic name/description, never the scope a rule
 * targets; an explicit override is still accepted for API completeness but
 * is not exercised by the Step 5D UI.
 *
 * Security (item 13): previousRuleId (the [id] path segment) is verified
 * against requireOrg()'s org.orgId inside supersedeOrganizationRule's own
 * getOrganizationRule lookup — a ruleId from another organization fails
 * with "not found", never silently versions that organization's rule.
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireOrg } from '@/lib/org'
import { getOrganizationRule, supersedeOrganizationRule } from '@/lib/rulebook/organization-rules-service'
import type { MatchCondition } from '@/lib/rulebook/organization-rules'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }
  const { id } = await params

  const previous = await getOrganizationRule(org.orgId, id)
  if (!previous) return NextResponse.json({ error: 'Rule not found' }, { status: 404 })

  const body = await req.json() as {
    value?: unknown
    name?: string
    description?: string | null
    targetField?: string
    matchConditions?: MatchCondition[]
  }
  if (body.value === undefined) return NextResponse.json({ error: 'value is required' }, { status: 400 })

  try {
    const newVersion = await supersedeOrganizationRule({
      organizationId: org.orgId,
      previousRuleId: previous.id,
      name: body.name ?? previous.name,
      description: body.description ?? previous.description,
      targetField: body.targetField ?? previous.targetField,
      value: body.value,
      matchConditions: body.matchConditions ?? previous.matchConditions,
      createdBy: org.userEmail,
    })
    return NextResponse.json({ rule: newVersion })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed to create new version' }, { status: 400 })
  }
}
