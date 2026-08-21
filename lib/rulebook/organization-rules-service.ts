// Private Organization Rulebook — DB-touching orchestration (Step 5A,
// shadow mode only). Pure matching/validation logic lives in
// organization-rules.ts; this file is the read/write glue around it,
// mirroring the split already established between lib/credit-ledger.ts
// (pure) and lib/credit-ledger-service.ts (DB-touching).
//
// Every function here takes organizationId as an explicit parameter and
// filters every query by it — this module never trusts a caller-supplied
// organization id against an unfiltered collection, and it does not itself
// derive organizationId from a request (that's the caller's job, via
// requireOrg() — see lib/org.ts — exactly like every other org-scoped
// module in this codebase; this module has no dependency on requireOrg()
// itself so it stays usable from tests/scripts without a request context).
// The database's own RLS policy denies anon/authenticated entirely (see
// supabase/migrations/20260822000001_organization_rulebook_rules.sql) —
// consistent with every other tenant-scoped table in this schema, the real
// per-organization isolation boundary is THIS module's queries, not RLS
// row-matching against a Supabase Auth session (this app doesn't issue
// per-user Supabase sessions at all).
//
// IMPORTANT for whoever wires a route handler to this module later (no
// production route exists yet): organizationId must always come from
// requireOrg()'s trusted OrgContext.orgId (derived from the authenticated
// session's org_memberships row), NEVER from a client-supplied request
// body/query-param org id. This module has no way to enforce that itself —
// it trusts whatever organizationId it's called with — so that discipline
// belongs entirely to the future route handler, exactly like every other
// org-scoped module in this codebase (e.g. app/api/jobs/[id]/*/route.ts
// always calls requireOrg() first and uses its orgId, never a body field).
//
// Nothing in app/api or app/(dashboard) imports this module yet.
import { supabaseServer } from '@/lib/supabase'
import { validateOrganizationRuleShape } from './organization-rules'
import type { OrganizationRuleRecord, OrganizationRuleStatus, OrganizationRuleSourceKind, MatchCondition } from './organization-rules'

interface OrganizationRuleRow {
  id: string
  organization_id: string
  name: string
  description: string | null
  target_field: string
  value_json: unknown
  match_conditions_json: MatchCondition[]
  status: OrganizationRuleStatus
  version: number
  supersedes_rule_id: string | null
  source_kind: OrganizationRuleSourceKind
  created_by: string
  approved_by: string | null
  created_at: string
  updated_at: string
  effective_from: string | null
}

function rowToRecord(row: OrganizationRuleRow): OrganizationRuleRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    description: row.description,
    targetField: row.target_field,
    value: row.value_json,
    matchConditions: row.match_conditions_json ?? [],
    status: row.status,
    version: row.version,
    supersedesRuleId: row.supersedes_rule_id,
    sourceKind: row.source_kind,
    createdBy: row.created_by,
    approvedBy: row.approved_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    effectiveFrom: row.effective_from,
  }
}

// Every 'active' row requires approvedBy — enforced primarily by the
// database CHECK constraint (org_rulebook_active_requires_approval), and
// mirrored here so a caller gets a clear application-level error before
// ever reaching the database, rather than a raw constraint-violation
// message. There is no other path to 'active' — this validation runs for
// every create/version call, regardless of source_kind, so a
// verdix_pattern_suggestion is exactly as gated as a manual rule.
function assertActivationIsExplicit(status: OrganizationRuleStatus | undefined, approvedBy: string | null | undefined) {
  if (status === 'active' && !approvedBy) {
    throw new Error('organization-rules-service: status "active" requires an explicit approvedBy — a rule can never activate itself')
  }
}

export interface CreateOrganizationRuleInput {
  organizationId: string
  name: string
  description?: string | null
  targetField: string
  value: unknown
  matchConditions: MatchCondition[]
  sourceKind: OrganizationRuleSourceKind
  createdBy: string
  // Defaults to 'draft' — creation never implies approval. Pass 'active'
  // together with approvedBy only when the caller is itself the explicit
  // approval action.
  status?: OrganizationRuleStatus
  approvedBy?: string | null
  effectiveFrom?: string | null
}

export async function createOrganizationRule(input: CreateOrganizationRuleInput): Promise<OrganizationRuleRecord> {
  const shape = validateOrganizationRuleShape({ targetField: input.targetField, matchConditions: input.matchConditions })
  if (!shape.valid) throw new Error(`organization-rules-service: ${shape.reason}`)
  assertActivationIsExplicit(input.status, input.approvedBy)

  const { data, error } = await supabaseServer
    .from('organization_rulebook_rules')
    .insert({
      organization_id: input.organizationId,
      name: input.name,
      description: input.description ?? null,
      target_field: input.targetField,
      value_json: input.value,
      match_conditions_json: input.matchConditions,
      status: input.status ?? 'draft',
      version: 1,
      supersedes_rule_id: null,
      source_kind: input.sourceKind,
      created_by: input.createdBy,
      approved_by: input.approvedBy ?? null,
      effective_from: input.effectiveFrom ?? null,
    })
    .select('*')
    .single()

  if (error || !data) throw new Error(`organization-rules-service: failed to create rule: ${error?.message}`)
  return rowToRecord(data as OrganizationRuleRow)
}

export interface SupersedeOrganizationRuleInput {
  organizationId: string
  previousRuleId: string
  name: string
  description?: string | null
  targetField: string
  value: unknown
  matchConditions: MatchCondition[]
  createdBy: string
  effectiveFrom?: string | null
  // Deliberately NO status/approvedBy here — see this function's own
  // comment for why. Call activateOrganizationRule(...) as a separate,
  // later step once supersession is confirmed to have succeeded.
}

// Editing an active rule produces a NEW version rather than silently
// changing historical meaning (Step 5A item 8) — the previous row is
// marked 'superseded', never deleted or mutated in place, so any future
// audit of "what did this rule say on date X" stays answerable.
//
// SAFETY: the new version is created as 'draft' UNCONDITIONALLY — there is
// no parameter that lets a caller insert it pre-activated. This is what
// makes the "two simultaneously active versions" failure mode structurally
// impossible rather than merely unlikely: if this function inserted an
// ACTIVE replacement and the following update-to-superseded step then
// failed, the old row would still say 'active' AND the new row would also
// say 'active' — exactly the unsafe state Step 5A's review flagged. By
// forcing the new row to always start 'draft', the worst outcome of a
// failed second write is "an extra harmless draft that isn't linked to
// anything active" (see the throw below) — never two active versions.
// Activating the new version is therefore a deliberate, separate
// operation (activateOrganizationRule) that a caller only reaches AFTER
// this function has already returned successfully, i.e. after supersession
// is confirmed.
//
// Not wrapped in a single database transaction (no RPC exists for it, and
// none is warranted yet — nothing consumes this table's contents in
// production) — the ordering (insert draft, then mark previous superseded,
// requiring the previous row to still genuinely be 'active') is what
// carries the safety guarantee instead.
export async function supersedeOrganizationRule(input: SupersedeOrganizationRuleInput): Promise<OrganizationRuleRecord> {
  const shape = validateOrganizationRuleShape({ targetField: input.targetField, matchConditions: input.matchConditions })
  if (!shape.valid) throw new Error(`organization-rules-service: ${shape.reason}`)

  // Organization-scoped lookup — the previous rule must belong to THIS
  // organization, or the whole operation fails. This is what makes "Org A
  // cannot mutate Org B rules" true even though both share this one
  // service module: there is no code path that supersedes a rule without
  // first confirming it belongs to the caller's own organizationId.
  const previous = await getOrganizationRule(input.organizationId, input.previousRuleId)
  if (!previous) {
    throw new Error(`organization-rules-service: rule ${input.previousRuleId} not found in organization ${input.organizationId}`)
  }

  const { data: inserted, error: insertError } = await supabaseServer
    .from('organization_rulebook_rules')
    .insert({
      organization_id: input.organizationId,
      name: input.name,
      description: input.description ?? null,
      target_field: input.targetField,
      value_json: input.value,
      match_conditions_json: input.matchConditions,
      status: 'draft',
      approved_by: null,
      version: previous.version + 1,
      supersedes_rule_id: previous.id,
      source_kind: previous.sourceKind,
      created_by: input.createdBy,
      effective_from: input.effectiveFrom ?? null,
    })
    .select('*')
    .single()

  if (insertError || !inserted) throw new Error(`organization-rules-service: failed to create new version: ${insertError?.message}`)

  // Only ever supersedes a row that is genuinely still 'active' at this
  // exact moment (the .eq('status', 'active') guard) — if it's already
  // been superseded, disabled, or otherwise changed by a concurrent
  // operation, this matches zero rows, which is treated as a failure
  // below, not silently ignored.
  const { data: supersededRows, error: supersedeError } = await supabaseServer
    .from('organization_rulebook_rules')
    .update({ status: 'superseded' })
    .eq('id', previous.id)
    .eq('organization_id', input.organizationId)
    .eq('status', 'active')
    .select('id')

  if (supersedeError || !supersededRows || supersededRows.length === 0) {
    throw new Error(
      `organization-rules-service: created version ${(inserted as OrganizationRuleRow).id} as a harmless, never-activated draft, but failed to mark ${previous.id} superseded ` +
      `(0 rows matched — it may no longer be active — or an update error occurred: ${supersedeError?.message ?? 'no matching active row'}). ` +
      'The new draft version is inert and safe to leave as-is or delete; it was never activated.',
    )
  }

  return rowToRecord(inserted as OrganizationRuleRow)
}

// Activates a draft rule (typically one just created by createOrganizationRule
// or supersedeOrganizationRule) — the ONLY function in this module that can
// ever set status = 'active'. Requires an explicit approvedBy; there is no
// path from 'draft' to 'active' that does not go through this function or
// createOrganizationRule's own explicit status/approvedBy parameters.
export async function activateOrganizationRule(organizationId: string, ruleId: string, approvedBy: string): Promise<OrganizationRuleRecord> {
  if (!approvedBy) throw new Error('organization-rules-service: activateOrganizationRule requires an explicit approvedBy — a rule can never activate itself')

  const { data, error } = await supabaseServer
    .from('organization_rulebook_rules')
    .update({ status: 'active', approved_by: approvedBy })
    .eq('organization_id', organizationId)
    .eq('id', ruleId)
    .select('*')
    .single()

  if (error || !data) throw new Error(`organization-rules-service: failed to activate rule ${ruleId} in organization ${organizationId}: ${error?.message}`)
  return rowToRecord(data as OrganizationRuleRow)
}

// Organization-scoped single-row lookup — returns null (not another
// organization's row) when the id doesn't belong to organizationId.
export async function getOrganizationRule(organizationId: string, ruleId: string): Promise<OrganizationRuleRecord | null> {
  const { data, error } = await supabaseServer
    .from('organization_rulebook_rules')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('id', ruleId)
    .maybeSingle()

  if (error || !data) return null
  return rowToRecord(data as OrganizationRuleRow)
}

// The only query the Step 5A matcher ever needs — active rules for
// exactly one organization. Ordered by target_field then created_at for a
// stable, deterministic result across repeated calls (matchOrganizationRules
// itself does no sorting).
export async function listActiveOrganizationRules(organizationId: string): Promise<OrganizationRuleRecord[]> {
  const { data, error } = await supabaseServer
    .from('organization_rulebook_rules')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('status', 'active')
    .order('target_field', { ascending: true })
    .order('created_at', { ascending: true })

  if (error || !data) return []
  return (data as OrganizationRuleRow[]).map(rowToRecord)
}
