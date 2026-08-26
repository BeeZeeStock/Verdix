// SourceBinding — Step 16B.2's identity + effective-dating layer on top of
// 16B.1's SourceRole (lib/source-roles.ts).
//
// A SourceRole is the STABLE thing rules/evidence reference (a role_key
// like 'crm'); a SourceBinding is a dated identity of which concrete
// source instance actually backed that role_key during some interval
// (e.g. role_key 'crm' resolved to "Salesforce sandbox A" through
// 2026-09-01, then "Salesforce prod" after a migration). Deliberately NOT
// connector infrastructure — no credentials, URLs, auth, retry policy, or
// pull mechanics live here or ever will in this type; see
// lib/source-bindings-service.ts for the one atomic write path
// (create_source_binding) that keeps this identity-only.
//
// External-ID namespace invariant (pre-commit hardening audit):
// BillableUnitCandidate's uniqueness key is (job_id, source_binding_id,
// external_id) — this is only correct because a SourceBinding IS the
// namespace external_id is unique within, not merely a label. Superseding
// a binding is a namespace change: external_id values under the new
// binding may collide with, but are not the same identity space as,
// values under the old one.
//
// This is why creating a new SourceBinding must be reserved for a
// GENUINE re-platform (a different system, or the same system with a
// materially different/reset external-ID scheme) — never for routine
// credential/token/auth rotation against the SAME underlying system with
// the SAME id scheme. Rotating an API key does not, by itself, justify
// calling createSourceBinding at all: credentials/auth are explicitly
// out of scope for SourceBinding, so nothing about a credential rotation
// should ever reach this table in the first place. If the same real
// external event were re-pulled through a wrongly-created successor
// binding, it would not be recognized as a duplicate (the uniqueness
// key's source_binding_id differs) and a second candidate would be
// created for the same real-world event — the exact failure mode a
// superseding binding must never be created to cause. See
// lib/billable-unit-candidate-integration.test.ts for a test proving
// this consequence is real by design, never a surprise.
export interface SourceBinding {
  id: string
  source_role_id: string
  job_id: string
  org_id: string
  label: string
  effective_from: string
  effective_to: string | null
  supersedes_binding_id: string | null
  status: 'active' | 'superseded'
  created_at?: string
}

// ── Historical binding resolution ───────────────────────────────────────
//
// Pure predicate only — deliberately takes a referenceTime parameter
// rather than reading any ambient clock, and is applied against a list of
// ALL of a role's bindings (active + superseded), never just "the
// currently active one." Evaluating historical evidence against "whatever
// binding happens to be active today" would be wrong the moment a binding
// is ever superseded: evidence recorded under an old binding must keep
// resolving to that OLD binding's identity forever, regardless of what
// binds the role_key now. See resolveSourceBinding
// (lib/source-bindings-service.ts) for the I/O half of this — it fetches
// the candidate list, then narrows it with this exact predicate.
export function isSourceBindingEffectiveAt(binding: SourceBinding, referenceTime: string): boolean {
  const ref = new Date(referenceTime).getTime()
  const from = new Date(binding.effective_from).getTime()
  if (ref < from) return false
  if (binding.effective_to === null) return true
  return ref < new Date(binding.effective_to).getTime()
}

// Interval variant of the point-in-time predicate above — Step 16B.3 needs
// this to resolve every SourceBinding that backed a role_key at ANY point
// during a completeness-check interval (e.g. a 90-day dedupe lookback),
// not just at one instant, since a role's identity can legitimately change
// mid-window on a genuine re-platform (see this module's own external-ID-
// namespace note). Half-open interval semantics throughout, consistent
// with effective_to's own convention.
export function doesSourceBindingOverlapInterval(binding: SourceBinding, from: string, through: string): boolean {
  const bindingFromMs = new Date(binding.effective_from).getTime()
  const bindingThroughMs = binding.effective_to === null ? Infinity : new Date(binding.effective_to).getTime()
  const fromMs = new Date(from).getTime()
  const throughMs = new Date(through).getTime()
  return bindingFromMs < throughMs && bindingThroughMs > fromMs
}

export type ResolveSourceBindingResult =
  | { status: 'resolved'; binding: SourceBinding }
  | { status: 'no_match'; reason: string }
  | { status: 'ambiguous'; reason: string; matches: SourceBinding[] }

// Fails closed rather than ever falling back to "the currently active
// binding," "Date.now()," or "the latest binding" — those are exactly the
// three shortcuts this function exists to forbid (see the 16B.2 brief).
// candidateBindings is expected to already be scoped to one source_role_id
// (the caller's job) — this function additionally re-checks
// job_id/org_id on every candidate as defense in depth against a caller
// accidentally passing bindings from another job/org.
export function resolveSourceBindingFromCandidates(
  sourceRole: { id: string; job_id: string; org_id: string },
  referenceTime: string,
  candidateBindings: SourceBinding[],
): ResolveSourceBindingResult {
  const scoped = candidateBindings.filter(b =>
    b.source_role_id === sourceRole.id && b.job_id === sourceRole.job_id && b.org_id === sourceRole.org_id,
  )
  const foreign = candidateBindings.filter(b => b.job_id !== sourceRole.job_id || b.org_id !== sourceRole.org_id)
  if (foreign.length > 0) {
    return { status: 'no_match', reason: `${foreign.length} candidate binding(s) belong to another job/org and were excluded — resolution must never cross job/org boundaries` }
  }
  const matches = scoped.filter(b => isSourceBindingEffectiveAt(b, referenceTime))
  if (matches.length === 0) {
    return { status: 'no_match', reason: `no binding for source_role ${sourceRole.id} is effective at ${referenceTime}` }
  }
  if (matches.length > 1) {
    return { status: 'ambiguous', reason: `${matches.length} bindings for source_role ${sourceRole.id} are simultaneously effective at ${referenceTime} — overlapping effective periods should be prevented at write time; this is a data-integrity fault, not a normal outcome`, matches }
  }
  return { status: 'resolved', binding: matches[0] }
}
