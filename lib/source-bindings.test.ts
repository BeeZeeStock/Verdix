import { describe, it, expect } from 'vitest'
import { isSourceBindingEffectiveAt, resolveSourceBindingFromCandidates, type SourceBinding } from './source-bindings'

const ROLE = { id: 'role-crm', job_id: 'job-1', org_id: 'org-1' }

function binding(overrides: Partial<SourceBinding> & { id: string }): SourceBinding {
  return {
    source_role_id: ROLE.id,
    job_id: ROLE.job_id,
    org_id: ROLE.org_id,
    label: 'Salesforce',
    effective_from: '2026-01-01T00:00:00Z',
    effective_to: null,
    supersedes_binding_id: null,
    status: 'active',
    ...overrides,
  }
}

describe('isSourceBindingEffectiveAt', () => {
  it('open-ended binding (effective_to null) is effective at any time at-or-after effective_from', () => {
    const b = binding({ id: 'b1', effective_from: '2026-01-01T00:00:00Z', effective_to: null })
    expect(isSourceBindingEffectiveAt(b, '2026-01-01T00:00:00Z')).toBe(true)
    expect(isSourceBindingEffectiveAt(b, '2030-01-01T00:00:00Z')).toBe(true)
    expect(isSourceBindingEffectiveAt(b, '2025-12-31T23:59:59Z')).toBe(false)
  })

  it('closed binding is effective on [effective_from, effective_to) — inclusive start, exclusive end', () => {
    const b = binding({ id: 'b1', effective_from: '2026-01-01T00:00:00Z', effective_to: '2026-06-01T00:00:00Z' })
    expect(isSourceBindingEffectiveAt(b, '2026-01-01T00:00:00Z')).toBe(true)
    expect(isSourceBindingEffectiveAt(b, '2026-05-31T23:59:59Z')).toBe(true)
    expect(isSourceBindingEffectiveAt(b, '2026-06-01T00:00:00Z')).toBe(false)
  })
})

describe('resolveSourceBindingFromCandidates — never "currently active," never Date.now(), never "latest"', () => {
  it('resolves the ONE binding effective at a historical referenceTime, even when a later binding now supersedes it', () => {
    const old = binding({ id: 'b-old', effective_from: '2026-01-01T00:00:00Z', effective_to: '2026-06-01T00:00:00Z', status: 'superseded' })
    const current = binding({ id: 'b-new', effective_from: '2026-06-01T00:00:00Z', effective_to: null, supersedes_binding_id: 'b-old', status: 'active' })

    const result = resolveSourceBindingFromCandidates(ROLE, '2026-03-15T00:00:00Z', [old, current])
    expect(result).toEqual({ status: 'resolved', binding: old })

    // The currently-active binding is NOT what a historical reference
    // time resolves to — this is the whole point of the resolver.
    const resultLater = resolveSourceBindingFromCandidates(ROLE, '2026-07-01T00:00:00Z', [old, current])
    expect(resultLater).toEqual({ status: 'resolved', binding: current })
  })

  it('fails closed when no binding matches', () => {
    const b = binding({ id: 'b1', effective_from: '2026-06-01T00:00:00Z', effective_to: null })
    const result = resolveSourceBindingFromCandidates(ROLE, '2026-01-01T00:00:00Z', [b])
    expect(result.status).toBe('no_match')
  })

  it('fails closed (never picks arbitrarily) when multiple bindings simultaneously match — a data-integrity fault, not a normal outcome', () => {
    const b1 = binding({ id: 'b1', effective_from: '2026-01-01T00:00:00Z', effective_to: null })
    const b2 = binding({ id: 'b2', effective_from: '2026-01-01T00:00:00Z', effective_to: null })
    const result = resolveSourceBindingFromCandidates(ROLE, '2026-03-01T00:00:00Z', [b1, b2])
    expect(result.status).toBe('ambiguous')
    if (result.status === 'ambiguous') expect(result.matches).toHaveLength(2)
  })

  it('fails closed when a candidate binding belongs to another job/org, never silently resolving across the boundary', () => {
    const foreign = binding({ id: 'b-foreign', job_id: 'job-OTHER', effective_from: '2026-01-01T00:00:00Z', effective_to: null })
    const result = resolveSourceBindingFromCandidates(ROLE, '2026-03-01T00:00:00Z', [foreign])
    expect(result.status).toBe('no_match')
  })
})
