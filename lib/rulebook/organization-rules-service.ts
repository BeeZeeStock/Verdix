// Private Organization Rulebook — DB-touching orchestration (Step 5A/5B.5,
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
import { randomUUID } from 'node:crypto'
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
  lineage_id: string
  source_kind: OrganizationRuleSourceKind
  created_by: string
  approved_by: string | null
  created_at: string
  updated_at: string
  effective_from: string | null
  effective_to: string | null
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
    lineageId: row.lineage_id,
    sourceKind: row.source_kind,
    createdBy: row.created_by,
    approvedBy: row.approved_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
  }
}

// Every 'active' row requires approvedBy — enforced primarily by the
// database CHECK constraint (org_rulebook_active_requires_approval), and
// mirrored here so a caller gets a clear application-level error before
// ever reaching the database, rather than a raw constraint-violation
// message. There is no other path to 'active' — this validation runs for
// every create call, regardless of source_kind, so a verdix_pattern_
// suggestion is exactly as gated as a manual rule.
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
  // approval action. Safe to do directly here (unlike supersession) — a
  // brand-new rule has no predecessor to overlap with, so there is no
  // temporal-validity race to guard against.
  status?: OrganizationRuleStatus
  approvedBy?: string | null
  effectiveFrom?: string | null
}

export async function createOrganizationRule(input: CreateOrganizationRuleInput): Promise<OrganizationRuleRecord> {
  const shape = validateOrganizationRuleShape({ targetField: input.targetField, matchConditions: input.matchConditions })
  if (!shape.valid) throw new Error(`organization-rules-service: ${shape.reason}`)
  assertActivationIsExplicit(input.status, input.approvedBy)

  // Generated client-side (not left to the DB's gen_random_uuid() default)
  // so lineage_id can be set to the row's OWN id in the same insert — a
  // fresh rule is the root of its own lineage (Step 5B.5).
  const id = randomUUID()

  const { data, error } = await supabaseServer
    .from('organization_rulebook_rules')
    .insert({
      id,
      organization_id: input.organizationId,
      name: input.name,
      description: input.description ?? null,
      target_field: input.targetField,
      value_json: input.value,
      match_conditions_json: input.matchConditions,
      status: input.status ?? 'draft',
      version: 1,
      supersedes_rule_id: null,
      lineage_id: id,
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
  // Deliberately NO status/approvedBy/effectiveFrom here — see this
  // function's own comment. Both the new version's effective_from AND the
  // previous version's effective_to are set together, atomically, by
  // activateOrganizationRule (Step 5B.5) — never here.
}

// Editing an active rule produces a NEW version rather than silently
// changing historical meaning (Step 5A item 8) — the previous row is
// eventually marked 'superseded' (with a recorded effective_to), never
// deleted or mutated in place, so a historical asOf can still resolve it.
//
// SAFETY (Step 5A, refined by Step 5B.5): the new version is created as
// 'draft' UNCONDITIONALLY, and this function does NOT touch the previous
// row's status or timestamps AT ALL — the previous row stays exactly
// 'active' until a later, separate activateOrganizationRule call succeeds.
// This means supersedeOrganizationRule alone can never produce two active
// versions (it only ever ADDS a draft; nothing here can retire the
// predecessor), and a failed/never-called activation simply leaves the
// predecessor active and the new version an inert draft forever — never a
// gap, never an overlap.
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

  const id = randomUUID()
  const { data: inserted, error: insertError } = await supabaseServer
    .from('organization_rulebook_rules')
    .insert({
      id,
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
      lineage_id: previous.lineageId,
      source_kind: previous.sourceKind,
      created_by: input.createdBy,
      effective_from: null,
    })
    .select('*')
    .single()

  if (insertError || !inserted) throw new Error(`organization-rules-service: failed to create new version: ${insertError?.message}`)
  return rowToRecord(inserted as OrganizationRuleRow)
}

// Activates a draft rule — the ONLY function in this module that can ever
// set status = 'active', and (Step 5B.5) the ONLY place effective_from/
// effective_to are ever written. Calls the atomic
// activate_organization_rule_supersession database function
// (supabase/migrations/20260823000001_organization_rulebook_temporal_
// validity.sql) rather than doing a plain UPDATE, so — when the draft has
// a predecessor (supersedesRuleId) — retiring the predecessor
// (effective_to = effectiveAt, status -> 'superseded') and activating the
// new version (effective_from = effectiveAt, status -> 'active') happen in
// ONE database transaction. Either both succeed, or neither does: there is
// no application-code sequencing gap where the predecessor is already
// retired but the new version isn't active yet (or vice versa), and the
// database's own no-overlap exclusion constraint would reject the
// transaction outright if the two windows ever failed to be adjacent.
//
// effectiveAt defaults to "now" for real usage but is a real parameter
// (never read from inside a pure function) so tests can supply an exact,
// deterministic cutover instant.
//
// Retroactive-activation policy (Step 5B.5 review item 3): the database
// function rejects an effectiveAt more than ~60 seconds in the past
// (a small grace window for normal request latency, not an exact
// less-than-now check, which would be flaky) — an ordinary activation may
// never silently rewrite what policy was authoritative during an ALREADY-
// INVOICED period. A future-dated effectiveAt is always fine (the
// predecessor correctly stays authoritative until that instant arrives).
// This restriction applies ONLY to this function (the supersession/
// activation path) — a brand-new rule's own initial effectiveFrom, set
// directly via createOrganizationRule, is unrestricted, since there is no
// existing authoritative record being retired. A deliberate, audited
// backdating/correction workflow may be added in a later step; none
// exists yet.
export async function activateOrganizationRule(
  organizationId: string, ruleId: string, approvedBy: string, effectiveAt: Date = new Date(),
): Promise<OrganizationRuleRecord> {
  if (!approvedBy) throw new Error('organization-rules-service: activateOrganizationRule requires an explicit approvedBy — a rule can never activate itself')

  const { data, error } = await supabaseServer.rpc('activate_organization_rule_supersession', {
    p_organization_id: organizationId,
    p_new_rule_id: ruleId,
    p_approved_by: approvedBy,
    p_effective_at: effectiveAt.toISOString(),
  })

  if (error) throw new Error(`organization-rules-service: failed to activate rule ${ruleId} in organization ${organizationId}: ${error.message}`)
  const row = Array.isArray(data) ? data[0] : data
  if (!row) throw new Error(`organization-rules-service: activation of rule ${ruleId} returned no row`)
  return rowToRecord(row as OrganizationRuleRow)
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

// The query a CURRENT-only matcher call needs — active rules for exactly
// one organization. Ordered by target_field then created_at for a stable,
// deterministic result across repeated calls (matchOrganizationRules
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

// The query a HISTORICAL matcher call needs (Step 5B.5) — active AND
// superseded rules for exactly one organization, since matchOrganizationRules
// itself now decides temporal eligibility (via each row's validity window)
// rather than relying on status alone. 'draft'/'disabled' rows are still
// excluded here at the query level — they are never authoritative for any
// asOf, so there is no reason to even fetch them for matching.
export async function listMatchableOrganizationRules(organizationId: string): Promise<OrganizationRuleRecord[]> {
  const { data, error } = await supabaseServer
    .from('organization_rulebook_rules')
    .select('*')
    .eq('organization_id', organizationId)
    .in('status', ['active', 'superseded'])
    .order('target_field', { ascending: true })
    .order('created_at', { ascending: true })

  if (error || !data) return []
  return (data as OrganizationRuleRow[]).map(rowToRecord)
}

// Step 5D — the management page's query: every status, for one
// organization. Distinct from listActiveOrganizationRules/
// listMatchableOrganizationRules (both matching-oriented, deliberately
// excluding draft/disabled) — this is the ONLY query in this module that
// returns draft/disabled rows, and it exists solely for display, never for
// resolution. Never used by any matching/resolution code path.
export async function listAllOrganizationRules(organizationId: string): Promise<OrganizationRuleRecord[]> {
  const { data, error } = await supabaseServer
    .from('organization_rulebook_rules')
    .select('*')
    .eq('organization_id', organizationId)
    .order('target_field', { ascending: true })
    .order('created_at', { ascending: false })

  if (error || !data) return []
  return (data as OrganizationRuleRow[]).map(rowToRecord)
}

// Step 5D item 8 — "before activation, surface when an existing policy
// occupies the same policy slot." A policy SLOT is (organization_id,
// target_field, match_conditions) — the exact scope the database's own
// org_rulebook_no_overlapping_scope exclusion constraint protects
// (20260823000001_organization_rulebook_temporal_validity.sql). This is a
// proactive, read-only check the API layer runs BEFORE calling
// activateOrganizationRule, so the reviewer sees a clear "current vs
// proposed" comparison instead of a raw database constraint-violation
// error. match_conditions is compared the same way the database does — as
// canonicalized JSON text — so this function and the constraint agree on
// what "the same slot" means; see that migration's own comment on the
// (documented, pre-existing) array-order limitation this inherits.
//
// Excludes rows in the SAME lineage as candidateRuleId — a draft superseding
// its own predecessor is the NORMAL, expected activation path (handled by
// activate_organization_rule_supersession's atomic retire-then-activate),
// not an "overlap" in the sense this function reports.
export async function findActiveRuleForSameSlot(
  organizationId: string, targetField: string, matchConditions: MatchCondition[], excludeLineageId: string,
): Promise<OrganizationRuleRecord | null> {
  const { data, error } = await supabaseServer
    .from('organization_rulebook_rules')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('target_field', targetField)
    .eq('status', 'active')
    .neq('lineage_id', excludeLineageId)

  if (error || !data) return null
  const candidateJson = JSON.stringify(matchConditions)
  const match = (data as OrganizationRuleRow[]).find(row => JSON.stringify(row.match_conditions_json ?? []) === candidateJson)
  return match ? rowToRecord(match) : null
}

// Step 5D — discards a never-activated draft (e.g. a promoted draft the
// reviewer/admin decides not to pursue, or one superseded by a "replace"
// choice at activation time — see app/api/org/rulebook/[id]/activate/
// route.ts). Deliberately restricted to status = 'draft' only: an ACTIVE
// rule is retired exclusively through activateOrganizationRule's atomic
// supersession path (never through this function), so a real, historically-
// resolving policy can never be silently removed from matching by this
// call. Org-scoped via the same getOrganizationRule lookup every other
// mutation in this module uses.
export async function discardDraftOrganizationRule(organizationId: string, ruleId: string): Promise<void> {
  const rule = await getOrganizationRule(organizationId, ruleId)
  if (!rule) throw new Error(`organization-rules-service: rule ${ruleId} not found in organization ${organizationId}`)
  if (rule.status !== 'draft') throw new Error(`organization-rules-service: only a draft rule can be discarded (rule ${ruleId} is ${rule.status})`)

  const { error } = await supabaseServer
    .from('organization_rulebook_rules')
    .update({ status: 'disabled', updated_at: new Date().toISOString() })
    .eq('id', ruleId)
    .eq('organization_id', organizationId)
  if (error) throw new Error(`organization-rules-service: failed to discard draft ${ruleId}: ${error.message}`)
}

// Step 5D item 9 — cosmetic-only edit, safe to apply in place regardless of
// status (never touches target_field/value_json/match_conditions_json/
// status/version — every SEMANTIC property). A change to any semantic
// property must go through supersedeOrganizationRule + activateOrganizationRule
// instead, so historical resolution stays reproducible.
export async function updateOrganizationRuleDescription(
  organizationId: string, ruleId: string, description: string | null,
): Promise<OrganizationRuleRecord> {
  const { data, error } = await supabaseServer
    .from('organization_rulebook_rules')
    .update({ description, updated_at: new Date().toISOString() })
    .eq('id', ruleId)
    .eq('organization_id', organizationId)
    .select('*')
    .maybeSingle()
  if (error || !data) throw new Error(`organization-rules-service: rule ${ruleId} not found in organization ${organizationId}`)
  return rowToRecord(data as OrganizationRuleRow)
}
