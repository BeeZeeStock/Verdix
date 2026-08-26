// DB-touching persistence for billable_unit_qualification_rules — split
// from lib/billable-unit-qualification.ts (pure domain logic) for the same
// reason lib/rulebook/organization-rules.ts/-service.ts are split: route
// handlers that eventually call this transitively pull in next-auth via
// lib/org.ts, which fails to resolve under plain vitest, so anything
// needing a direct unit test has to stay in the pure module.
//
// No HTTP route or UI in this slice (16B.1) — per its own scope, stopping
// at a tested server-side service + read model rather than forcing UI work
// that isn't needed to validate this slice.
import { supabaseServer } from './supabase'
import {
  confirmQualificationRuleField, isQualificationRuleReady, extractReferencedSourceRoleKeys,
  type BillableUnitQualificationRule, type QualificationRuleFieldPath,
} from './billable-unit-qualification'
import { listSourceRolesForJob } from './source-roles-service'

const TABLE = 'billable_unit_qualification_rules'

function rowToRule(row: Record<string, unknown>): BillableUnitQualificationRule {
  return {
    id: row.id as string,
    job_id: row.job_id as string,
    org_id: row.org_id as string,
    unit_type: row.unit_type as string,
    fact_schema: row.fact_schema as BillableUnitQualificationRule['fact_schema'],
    criteria: row.criteria as BillableUnitQualificationRule['criteria'],
    qualified_contact_role: row.qualified_contact_role as BillableUnitQualificationRule['qualified_contact_role'],
    dedupe_rule: row.dedupe_rule as BillableUnitQualificationRule['dedupe_rule'],
    rejection_rule: row.rejection_rule as BillableUnitQualificationRule['rejection_rule'],
    rejection_window: row.rejection_window as BillableUnitQualificationRule['rejection_window'],
    deadline_convention: row.deadline_convention as BillableUnitQualificationRule['deadline_convention'],
    attribution_basis: row.attribution_basis as BillableUnitQualificationRule['attribution_basis'],
    evidence_precedence: row.evidence_precedence as BillableUnitQualificationRule['evidence_precedence'],
    field_sources: row.field_sources as Record<string, string[]>,
    version: row.version as number,
    revision: row.revision as number,
    supersedes_rule_id: (row.supersedes_rule_id as string | null) ?? null,
    effective_from: row.effective_from as string,
    effective_to: (row.effective_to as string | null) ?? null,
    status: row.status as BillableUnitQualificationRule['status'],
    created_at: row.created_at as string | undefined,
    updated_at: row.updated_at as string | undefined,
  }
}

type NewRuleInput = Omit<BillableUnitQualificationRule, 'id' | 'created_at' | 'updated_at' | 'status' | 'version' | 'revision' | 'supersedes_rule_id' | 'effective_to'> & {
  version?: number
  supersedes_rule_id?: string | null
  effective_to?: string | null
}

// Always inserted as 'draft' — a rule never starts active. See
// activateQualificationRule for the one, deliberate, separate transition.
export async function createDraftQualificationRule(rule: NewRuleInput): Promise<BillableUnitQualificationRule> {
  const { data, error } = await supabaseServer.from(TABLE).insert({
    job_id: rule.job_id,
    org_id: rule.org_id,
    unit_type: rule.unit_type,
    fact_schema: rule.fact_schema,
    criteria: rule.criteria,
    qualified_contact_role: rule.qualified_contact_role,
    dedupe_rule: rule.dedupe_rule,
    rejection_rule: rule.rejection_rule,
    rejection_window: rule.rejection_window,
    deadline_convention: rule.deadline_convention,
    attribution_basis: rule.attribution_basis,
    evidence_precedence: rule.evidence_precedence,
    field_sources: rule.field_sources,
    version: rule.version ?? 1,
    supersedes_rule_id: rule.supersedes_rule_id ?? null,
    effective_from: rule.effective_from,
    effective_to: rule.effective_to ?? null,
    status: 'draft',
  }).select().single()
  if (error || !data) throw new Error(`createDraftQualificationRule failed: ${error?.message}`)
  return rowToRule(data)
}

export async function getQualificationRule(id: string): Promise<BillableUnitQualificationRule | null> {
  const { data, error } = await supabaseServer.from(TABLE).select('*').eq('id', id).maybeSingle()
  if (error) throw new Error(`getQualificationRule failed: ${error.message}`)
  return data ? rowToRule(data) : null
}

export async function listQualificationRulesForJob(job_id: string, unit_type?: string): Promise<BillableUnitQualificationRule[]> {
  let query = supabaseServer.from(TABLE).select('*').eq('job_id', job_id)
  if (unit_type) query = query.eq('unit_type', unit_type)
  const { data, error } = await query
  if (error) throw new Error(`listQualificationRulesForJob failed: ${error.message}`)
  return (data ?? []).map(rowToRule)
}

// Confirms exactly one field (lib/billable-unit-qualification.ts's
// confirmQualificationRuleField) and persists ONLY that field. Never
// touches field_sources — the original source grounding is immutable; a
// reviewer decision references it, never rewrites it.
//
// Pre-commit hardening audit, part C — this used to read the WHOLE row,
// compute a new in-memory rule with one field changed, then write ALL
// eight tracked columns back. Two concurrent confirms of DIFFERENT fields
// (e.g. request A confirms deadline_convention, request B confirms
// attribution_basis) would each hold a pre-write snapshot of the other
// six columns; whichever write committed second would silently revert
// the first request's change — the exact same lost-update shape fixed for
// contract_terms.ai_proposal_cache in Step 16A.1. Fixed the same way, at
// the right granularity for each column's actual structure:
//   - criteria/dedupe_rule/rejection_rule/rejection_window/
//     deadline_convention/attribution_basis each own their WHOLE column —
//     a plain single-column UPDATE is naturally atomic at the Postgres
//     column level; two concurrent updates to two DIFFERENT columns on
//     the same row cannot conflict at all, no JSONB merge needed.
//   - qualified_contact_role (.base/.extensions) and evidence_precedence
//     (dynamic per-fact keys) are each ONE JSONB column holding MULTIPLE
//     independently-confirmable sub-keys — confirming one sub-key still
//     needs an atomic jsonb_set against the row's CURRENT value, same
//     RPC pattern as set_proposal_cache_entry (supabase/migrations/
//     20260830000006_proposal_cache_atomic_upsert.sql).
// Same-field concurrent confirmations: documented last-committed-write-
// wins, exactly like Step 16A.1's same-key policy — Postgres serializes
// them, whichever commits last simply wins for that one field; no
// unrelated field is ever touched or lost.
//
// Every path also atomically re-checks status = 'draft' at the moment of
// the write (not just via the up-front existing.status check below),
// closing the read-then-write TOCTOU gap: if the rule was concurrently
// activated or superseded between the initial read and this write, the
// write matches zero rows and this function throws rather than silently
// mutating an active rule.
export async function confirmQualificationRuleFieldAndPersist(
  id: string,
  fieldPath: QualificationRuleFieldPath,
  overrideValue?: unknown,
): Promise<BillableUnitQualificationRule> {
  const existing = await getQualificationRule(id)
  if (!existing) throw new Error(`confirmQualificationRuleFieldAndPersist: rule ${id} not found`)
  if (existing.status !== 'draft') {
    throw new Error(`confirmQualificationRuleFieldAndPersist: rule ${id} is '${existing.status}', not 'draft' — an active rule's commercial meaning is immutable; use createSuccessorDraft/activateQualificationRuleSuccessor instead`)
  }
  const updated = confirmQualificationRuleField(existing, fieldPath, overrideValue)

  if (fieldPath === 'qualified_contact_role.base' || fieldPath === 'qualified_contact_role.extensions') {
    const subField = fieldPath === 'qualified_contact_role.base' ? 'base' : 'extensions'
    const { data, error } = await supabaseServer.rpc('set_qualification_rule_contact_role_field', {
      p_rule_id: id, p_field: subField, p_value: updated.qualified_contact_role[subField],
    })
    if (error) throw new Error(`confirmQualificationRuleFieldAndPersist failed: ${error.message}`)
    const row = Array.isArray(data) ? data[0] : data
    if (!row) throw new Error(`confirmQualificationRuleFieldAndPersist: rule ${id} was not updated — it may have been activated or superseded concurrently`)
    return rowToRule(row)
  }

  if (fieldPath.startsWith('evidence_precedence.')) {
    const key = fieldPath.slice('evidence_precedence.'.length)
    const { data, error } = await supabaseServer.rpc('set_qualification_rule_evidence_precedence_key', {
      p_rule_id: id, p_key: key, p_value: updated.evidence_precedence[key],
    })
    if (error) throw new Error(`confirmQualificationRuleFieldAndPersist failed: ${error.message}`)
    const row = Array.isArray(data) ? data[0] : data
    if (!row) throw new Error(`confirmQualificationRuleFieldAndPersist: rule ${id} was not updated — it may have been activated or superseded concurrently`)
    return rowToRule(row)
  }

  const independentColumnValues: Record<string, unknown> = {
    criteria: updated.criteria,
    dedupe_rule: updated.dedupe_rule,
    rejection_rule: updated.rejection_rule,
    rejection_window: updated.rejection_window,
    deadline_convention: updated.deadline_convention,
    attribution_basis: updated.attribution_basis,
  }
  if (!(fieldPath in independentColumnValues)) throw new Error(`confirmQualificationRuleFieldAndPersist: unrecognized field path '${fieldPath}'`)
  // Activation-TOCTOU hardening pass — routed through a function (rather
  // than the plain single-column .update() this used before) so
  // `revision = revision + 1` can be computed atomically against the
  // row's CURRENT value, same as the two JSONB-merge RPCs below. A plain
  // supabase-js .update({...}) call cannot express "increment this
  // column," only "set it to a literal value" — a JS-computed
  // `existing.revision + 1` would reintroduce exactly the kind of
  // read-modify-write race this whole file exists to avoid.
  const { data, error } = await supabaseServer.rpc('confirm_qualification_rule_field', {
    p_rule_id: id, p_column: fieldPath, p_value: independentColumnValues[fieldPath],
  })
  if (error) throw new Error(`confirmQualificationRuleFieldAndPersist failed: ${error.message}`)
  const row = Array.isArray(data) ? data[0] : data
  if (!row) throw new Error(`confirmQualificationRuleFieldAndPersist: rule ${id} was not updated — it may have been activated or superseded concurrently`)
  return rowToRule(row)
}

// Part 3 hardening audit — every role_key a rule's data actually
// references (rejection_rule.valid_channels, evidence_precedence
// strategies — extractReferencedSourceRoleKeys) must correspond to a
// source_roles row registered for the SAME job. Deliberately no JSON
// foreign-key machinery — a deterministic, activation-time set-membership
// check against listSourceRolesForJob is enough: a role_key registered
// only for a DIFFERENT job never appears in this job's list, so it's
// indistinguishable from (and correctly rejected as) missing.
// reviewer_attestation is not special-cased here — it resolves through
// its own registered source_roles row exactly like any other role
// (ensureReviewerAttestationRole is what registers it; this function
// doesn't know or care that the key is reserved).
async function assertReferencedSourceRolesRegistered(rule: BillableUnitQualificationRule): Promise<void> {
  const referenced = extractReferencedSourceRoleKeys(rule)
  if (referenced.length === 0) return
  const registered = await listSourceRolesForJob(rule.job_id)
  const registeredKeys = new Set(registered.map(r => r.role_key))
  const missing = referenced.filter(key => !registeredKeys.has(key))
  if (missing.length > 0) {
    throw new Error(`activation blocked: rule ${rule.id} references source role(s) not registered for job ${rule.job_id}: ${missing.join(', ')}`)
  }
}

// Activation is a deliberate, separate action from readiness — a fully
// resolved draft does not auto-activate. Hard-enforces
// isQualificationRuleReady AND assertReferencedSourceRolesRegistered as
// preconditions; never activates a rule with any unresolved field
// (qualified_contact_role.extensions excepted, per isQualificationRuleReady's
// own design) or a source-role reference this job hasn't registered.
//
// Pre-commit hardening audit, part D — the UPDATE is guarded by
// .eq('status', 'draft') (not just the up-front check above) so a
// concurrent activation of a DIFFERENT draft rule for the same
// job_id/unit_type is caught by the database's own partial unique index
// (billable_unit_qualification_rules_one_active_per_unit_type_idx —
// supabase/migrations/20260830000007_billable_unit_qualification.sql),
// never by a race-prone "check then write" in application code alone.
//
// Activation-TOCTOU hardening pass — ALSO guarded by
// .eq('revision', existing.revision): this function reads the rule,
// validates isQualificationRuleReady and every referenced source role
// against THAT read, then writes. Without a revision check, a
// confirmation landing in between (e.g. someone edits evidence_precedence
// to reference an unregistered role after this function already
// validated the old, registered one) would activate a rule DIFFERENT
// from the one actually validated. Same shape of race as
// activateQualificationRuleSuccessor's — read/validate/activate — so it
// gets the same guard, expressed here as a plain additional .eq() rather
// than an RPC parameter, since this path only ever CHECKS revision
// equality, never increments it (a plain supabase-js .update() can
// express an equality check in its WHERE clause; it just can't express
// an atomic increment, which is why the confirm-time writes route
// through functions instead).
//
// This is specifically the FIRST-EVER activation of a rule with no
// predecessor (supersedes_rule_id is null) — see
// activateQualificationRuleSuccessor below for the separate, atomic
// transition that retires a predecessor and promotes a successor
// together.
export async function activateQualificationRule(id: string): Promise<BillableUnitQualificationRule> {
  const existing = await getQualificationRule(id)
  if (!existing) throw new Error(`activateQualificationRule: rule ${id} not found`)
  if (existing.status !== 'draft') throw new Error(`activateQualificationRule: rule ${id} is not in draft status (found '${existing.status}')`)
  if (existing.supersedes_rule_id) throw new Error(`activateQualificationRule: rule ${id} supersedes another rule — use activateQualificationRuleSuccessor instead`)
  if (!isQualificationRuleReady(existing)) throw new Error(`activateQualificationRule: rule ${id} is not ready — unresolved fields remain`)
  await assertReferencedSourceRolesRegistered(existing)
  const { data, error } = await supabaseServer.from(TABLE)
    .update({ status: 'active', updated_at: new Date().toISOString() })
    .eq('id', id).eq('status', 'draft').eq('revision', existing.revision)
    .select().maybeSingle()
  if (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new Error(`activateQualificationRule: another rule is already active for job ${existing.job_id}/unit_type '${existing.unit_type}' — supersede it before activating a different one`)
    }
    throw new Error(`activateQualificationRule failed: ${error.message}`)
  }
  if (!data) throw new Error(`activateQualificationRule: rule ${id} was not activated — it is no longer draft, or its revision changed concurrently (expected revision ${existing.revision}); re-read, re-validate, and retry`)
  return rowToRule(data)
}

// Creates a new draft version linked to (but NOT yet superseding) the
// current active rule. The active rule keeps governing, completely
// unchanged, for as long as this draft remains unresolved — see
// activateQualificationRuleSuccessor for the one atomic transition that
// actually retires it.
//
// Pre-commit hardening audit, part 2 — this function used to ALSO mark
// the active rule 'superseded' immediately, in the same call that merely
// CREATED the draft amendment. That was a real bug: the predecessor
// stopped governing the moment a reviewer started drafting an amendment,
// not when the amendment was actually ready and activated — a contract
// could end up with ZERO active rules for as long as the draft sat
// unresolved. createSuccessorDraft now does ONLY the create; the
// predecessor is untouched.
//
// (job_id, unit_type, version) is uniquely constrained at the database
// level (same migration) — if two requests race to draft a successor off
// the SAME active rule concurrently, both would compute
// `active.version + 1`; the second insert fails the unique constraint
// rather than silently minting a duplicate version.
export async function createSuccessorDraft(
  activeRuleId: string,
  amendment: Omit<NewRuleInput, 'job_id' | 'org_id' | 'unit_type'>,
): Promise<BillableUnitQualificationRule> {
  const active = await getQualificationRule(activeRuleId)
  if (!active) throw new Error(`createSuccessorDraft: rule ${activeRuleId} not found`)
  if (active.status !== 'active') throw new Error(`createSuccessorDraft: rule ${activeRuleId} is not active (found '${active.status}')`)
  // Effective-range sanity, checked as early as possible (activation also
  // re-checks this — see activate_qualification_rule_successor — as the
  // hard guarantee; this is the fail-fast copy so an invalid draft is
  // rejected at creation time rather than only much later at activation).
  // This slice does not support retroactive amendments: a successor must
  // strictly postdate its predecessor's own effective_from.
  if (new Date(amendment.effective_from).getTime() <= new Date(active.effective_from).getTime()) {
    throw new Error(`createSuccessorDraft: successor effective_from (${amendment.effective_from}) must be strictly after predecessor ${activeRuleId}'s effective_from (${active.effective_from}) — retroactive amendments are not supported in this slice`)
  }
  try {
    return await createDraftQualificationRule({
      ...amendment,
      job_id: active.job_id,
      org_id: active.org_id,
      unit_type: active.unit_type,
      version: active.version + 1,
      supersedes_rule_id: active.id,
    })
  } catch (err) {
    if (err instanceof Error && /duplicate key value/.test(err.message)) {
      throw new Error(`createSuccessorDraft: version ${active.version + 1} for job ${active.job_id}/unit_type '${active.unit_type}' already exists — a concurrent successor draft won this race; re-read the active rule and retry`)
    }
    throw err
  }
}

// The ONE atomic transition that actually retires a predecessor and
// promotes its successor — both effects happen inside a single database
// transaction (activate_qualification_rule_successor, migration
// 20260830000007_billable_unit_qualification.sql), never as two separate
// application-level writes. Either BOTH the predecessor's supersession
// AND the successor's activation happen, or NEITHER does: if the RPC
// raises an exception for any reason (successor not draft, predecessor
// not active, predecessor already retired by a concurrent call), Postgres
// rolls back everything the function did, automatically — no in-process
// transaction/mutex substitute needed or used.
//
// Concurrency: the RPC takes a row lock on the PREDECESSOR (SELECT ...
// FOR UPDATE) before checking its status, so two concurrent calls
// targeting successors of the SAME predecessor serialize on that lock —
// the first to commit wins; the second observes the predecessor already
// 'superseded' and fails cleanly. This is what makes "no candidate-time
// rule range should have two applicable active versions" hold even under
// real concurrency, not just in the common case.
//
// Readiness and source-role registration are checked here, in
// TypeScript, before ever calling the RPC — same split as
// activateQualificationRule: business-rule validation (which needs no
// multi-row coordination) stays in the pure/service layer; the RPC's own
// job is strictly the atomic STATE TRANSITION and its concurrency safety.
//
// Activation-TOCTOU hardening pass — the read at the top of this
// function captures `successor.revision`, which is passed to the RPC as
// `expected_revision`. Everything between that read and the RPC call
// (isQualificationRuleReady, assertReferencedSourceRolesRegistered) is
// validated against that exact snapshot; if the row changed underneath
// this function before the RPC's own row lock is acquired, the RPC's
// revision check fails closed rather than activating unseen changes —
// see activate_qualification_rule_successor's own comment for the
// concrete scenario this closes (a concurrent edit swapping in a
// reference to an unregistered source role after validation already
// passed).
export async function activateQualificationRuleSuccessor(
  successorId: string,
): Promise<{ predecessor: BillableUnitQualificationRule; successor: BillableUnitQualificationRule }> {
  const successor = await getQualificationRule(successorId)
  if (!successor) throw new Error(`activateQualificationRuleSuccessor: rule ${successorId} not found`)
  if (successor.status !== 'draft') throw new Error(`activateQualificationRuleSuccessor: rule ${successorId} is not in draft status (found '${successor.status}')`)
  if (!successor.supersedes_rule_id) throw new Error(`activateQualificationRuleSuccessor: rule ${successorId} has no supersedes_rule_id — use activateQualificationRule for a first-ever activation`)
  if (!isQualificationRuleReady(successor)) throw new Error(`activateQualificationRuleSuccessor: rule ${successorId} is not ready — unresolved fields remain`)
  await assertReferencedSourceRolesRegistered(successor)

  const { data, error } = await supabaseServer.rpc('activate_qualification_rule_successor', {
    p_successor_id: successorId, p_expected_revision: successor.revision,
  })
  if (error) throw new Error(`activateQualificationRuleSuccessor failed: ${error.message}`)
  const rows = Array.isArray(data) ? data : (data ? [data] : [])
  const activatedSuccessor = rows.find((r: { id: string }) => r.id === successorId)
  if (!activatedSuccessor) throw new Error(`activateQualificationRuleSuccessor: rule ${successorId} was not activated`)

  const predecessor = await getQualificationRule(successor.supersedes_rule_id)
  if (!predecessor) throw new Error(`activateQualificationRuleSuccessor: predecessor ${successor.supersedes_rule_id} not found after activation`)
  return { predecessor, successor: rowToRule(activatedSuccessor) }
}
