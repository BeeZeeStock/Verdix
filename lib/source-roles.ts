// SourceRole — Step 16B.1's identity boundary for qualification evidence.
//
// Deliberately identity vocabulary only, not connector infrastructure: no
// auth, no endpoints, no pull mechanics. A SourceRole is just "this job
// recognizes a source called X" — the smallest registration needed so
// evidence/rules can reference a stable, job-scoped role_key without ever
// accepting an arbitrary, unregistered string.
//
// Deliberately NOT a globally closed enum: the first real fixture
// (OS-2026-09) already needs seven roles (crm, enrichment, calendar,
// conferencing, portal, public_materials, reviewer_attestation), and a
// different contract could reasonably need erp/helpdesk/logistics/claims/
// agent_logs — hardcoding a tiny enum would fail on contact with the first
// fixture and require a code change for every new contract vocabulary.
// Registration (a per-job data operation) is the boundary instead: a
// role_key must be registered here before evidence/watermarks/bindings
// (SourceBinding — 16B.2, not implemented here) may reference it.
//
// 'reviewer_attestation' is the one GLOBAL exception — a structural
// capability of the product itself (a human can always attest), not
// something a specific contract's evidence model opts into. Every job
// should have it registered so reviewer-attested evidence always has a
// real, non-null source identity — no implicit null-binding exception
// anywhere in this model.
export const RESERVED_SOURCE_ROLE_KEY = 'reviewer_attestation' as const

export interface SourceRole {
  id: string
  job_id: string
  org_id: string
  role_key: string
}

// Lowercase snake_case, 2-64 chars — deliberately permissive on WHICH
// words are allowed (that's the whole point: no fixed vocabulary), strict
// on SHAPE, so a role_key can never smuggle in something that isn't a
// plain identifier (no spaces, no punctuation, no arbitrary JSON/expression
// text masquerading as a role name).
const ROLE_KEY_RE = /^[a-z][a-z0-9_]{1,63}$/

export function isValidSourceRoleKey(key: string): boolean {
  return ROLE_KEY_RE.test(key)
}
