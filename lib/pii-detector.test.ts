import { describe, it, expect } from 'vitest'
import { detectPII, maskText, restoreTokensInObject, aliasGroupRoot, resolveGroupMemberIds, deriveGroupReviewState } from './pii-detector'

// ═══════════════════════════════════════════════════════════════════════════
// Step 17A — PII/anonymization correctness regressions, grounded in the
// actual Remembill_Kundavtal_SV.pdf false positives (contaminated test job
// deleted this same step).
// ═══════════════════════════════════════════════════════════════════════════

describe('genuine PERSON detection still works (regression — must not be weakened by item 2)', () => {
  it('detects a name after a context label', () => {
    const { entities } = detectPII('This agreement is signed by John Smith.')
    expect(entities.some(e => e.type === 'PERSON' && e.value === 'John Smith')).toBe(true)
  })

  it('detects a role-labelled name', () => {
    const { entities } = detectPII('Director John Smith approved this contract.')
    expect(entities.some(e => e.type === 'PERSON' && e.value.includes('John Smith'))).toBe(true)
  })

  it('NLP pass still detects a plausible real name embedded in prose', () => {
    const { entities } = detectPII('The contract was reviewed by Anna Andersson before signature.')
    expect(entities.some(e => e.type === 'PERSON' && /Anna Andersson/.test(e.value))).toBe(true)
  })

  it('detects an accented Nordic name', () => {
    const { entities } = detectPII('Signatory: Åsa Söderström')
    expect(entities.some(e => e.type === 'PERSON' && e.value.includes('Åsa Söderström'))).toBe(true)
  })
})

describe('item 2 — "mätt värdeviktat." can never survive as a PERSON candidate', () => {
  const CLAUSE = 'Betalgrad efter uppföljning är utfallet, mätt värdeviktat.'

  it('detects no PERSON entity anywhere in the actual source clause', () => {
    const { entities } = detectPII(CLAUSE)
    expect(entities.filter(e => e.type === 'PERSON')).toHaveLength(0)
  })

  it('rejects the phrase even when isolated (proves the fix is structural, not context-dependent)', () => {
    const { entities } = detectPII('mätt värdeviktat.')
    expect(entities.filter(e => e.type === 'PERSON')).toHaveLength(0)
  })

  it('rejects other lowercase Swedish sentence fragments ending in a period, generically — not a hardcoded phrase list', () => {
    const { entities } = detectPII('Detta är en beräkning, gjord löpande varje månad.')
    expect(entities.filter(e => e.type === 'PERSON')).toHaveLength(0)
  })

  it('the clause survives masking byte/text-equivalent — no PII token inserted into commercial prose', () => {
    const { tokenMap } = detectPII(CLAUSE)
    expect(maskText(CLAUSE, tokenMap)).toBe(CLAUSE)
  })
})

describe('item 2 — overlapping organization spans canonicalize to one entity', () => {
  it('"CoAccept AB" and "För CoAccept AB" collapse to the canonical "CoAccept AB" only', () => {
    const text = 'This agreement is between CoAccept AB and the customer.\n\nFör CoAccept AB\n_________________________'
    const { entities } = detectPII(text)
    const orgValues = entities.filter(e => e.type === 'ORG').map(e => e.value)
    expect(orgValues).toContain('CoAccept AB')
    expect(orgValues).not.toContain('För CoAccept AB')
  })

  it('the same canonicalization applies to any organisation, not just CoAccept — proves it is generic', () => {
    const text = 'The customer is NordicFit Test AB. The supplier is CoAccept AB.\n\nFör NordicFit Test AB\n_________________________'
    const { entities } = detectPII(text)
    const orgValues = entities.filter(e => e.type === 'ORG').map(e => e.value)
    expect(orgValues).toContain('NordicFit Test AB')
    expect(orgValues).not.toContain('För NordicFit Test AB')
  })

  it('does not canonicalize two genuinely different organizations that happen to share a suffix', () => {
    const text = 'This agreement is with Acme Corp. A separate matter concerns Example Corp.'
    const { entities } = detectPII(text)
    const orgValues = entities.filter(e => e.type === 'ORG').map(e => e.value)
    expect(orgValues).toContain('Acme Corp')
    expect(orgValues).toContain('Example Corp')
  })

  it('masking replaces the canonical span wherever it occurs, including inside the longer duplicate span', () => {
    const text = 'The supplier is CoAccept AB.\n\nFör CoAccept AB\n_________________________'
    const { tokenMap } = detectPII(text)
    const masked = maskText(text, tokenMap)
    expect(masked).toMatch(/För \[ORG_\d+\]/)
    expect(masked).not.toContain('CoAccept AB')
  })
})

describe('hardening item 1 — a prefix-overcaptured span never persists as a second organization entity', () => {
  it('detectPII (the sole input to DB persistence) emits exactly one ORG entity for "CoAccept AB" regardless of how many capitalized-word-prefixed variants appear in the source', () => {
    // Each prefix line reproduces the actual overcapture mechanism: the
    // company-suffix regex's optional continuation group accepts ANY
    // capitalized word, not just "För" — so any standalone capitalized
    // word directly preceding the real org name gets swept into a longer
    // span, all of which must canonicalize down to the same entity.
    const text = [
      'The supplier is CoAccept AB.',
      'För CoAccept AB',
      '_________________________',
      'Genom CoAccept AB',
      'Undertecknat CoAccept AB',
    ].join('\n')
    const { entities } = detectPII(text)
    const orgValues = entities.filter(e => e.type === 'ORG').map(e => e.value)
    // Exactly one organization entity total — never a second one for any
    // of the 3 differently-prefixed overcaptured variants.
    expect(orgValues).toEqual(['CoAccept AB'])
  })

  it('the generic rule applies to any organization, not just CoAccept — proves it is structural, not a hardcoded phrase', () => {
    const text = 'The supplier is Example Corp.\n\nGenom Example Corp\nUndertecknat Example Corp'
    const { entities } = detectPII(text)
    const orgValues = entities.filter(e => e.type === 'ORG').map(e => e.value)
    expect(orgValues).toEqual(['Example Corp'])
  })
})

describe('item 3 — organization alias handling (CoAccept AB / Remembill)', () => {
  it('detects "CoAccept AB (Remembill)" as two distinct, traceable spans, with the alias linked to the canonical org', () => {
    const { entities } = detectPII('The supplier, CoAccept AB (Remembill), provides the service.')
    const canonical = entities.find(e => e.type === 'ORG' && e.value === 'CoAccept AB')
    const alias = entities.find(e => e.type === 'ORG' && e.value === 'Remembill')
    expect(canonical).toBeDefined()
    expect(alias).toBeDefined()
    expect(alias!.aliasOf).toBe('CoAccept AB')
    expect(canonical!.aliasOf).toBeUndefined()
  })

  it('masking replaces BOTH the canonical name and its alias wherever each appears — approving CoAccept AB never leaves Remembill visible', () => {
    const text = 'CoAccept AB (Remembill) is the supplier. Remembill will invoice monthly. Contact CoAccept AB for support.'
    const { tokenMap } = detectPII(text)
    const masked = maskText(text, tokenMap)
    expect(masked).not.toContain('CoAccept AB')
    expect(masked).not.toContain('Remembill')
  })

  it('does not treat an ordinary parenthetical (not immediately after an org) as an alias', () => {
    const { entities } = detectPII('CoAccept AB provides the service (subject to the terms below).')
    const alias = entities.find(e => e.type === 'ORG' && e.aliasOf)
    expect(alias).toBeUndefined()
  })
})

describe('hardening item 1 (second pass) — explicit alias_of_entity_id grouping, distinct tokens, exact restoration', () => {
  it('"CoAccept AB (Remembill)" masks to two DISTINCT tokens, and restoration recovers the EXACT original text for each — never a shared/overloaded token', () => {
    const text = 'CoAccept AB (Remembill), org.nr 559548-7405, is the supplier. Remembill will invoice monthly at a rate of 0,38 EUR per request.'
    const { entities, tokenMap, reverseMap } = detectPII(text)

    const canonical = entities.find(e => e.type === 'ORG' && e.value === 'CoAccept AB')!
    const alias = entities.find(e => e.type === 'ORG' && e.value === 'Remembill')!
    expect(canonical).toBeDefined()
    expect(alias).toBeDefined()

    // Distinct tokens — grouping lives in aliasOf, never in a shared token.
    expect(alias.token).not.toBe(canonical.token)
    expect(alias.aliasOf).toBe('CoAccept AB')

    const masked = maskText(text, tokenMap)
    expect(masked).toContain(`${canonical.token} (${alias.token})`)
    expect(masked).not.toContain('CoAccept AB')
    expect(masked).not.toContain('Remembill')
    expect(masked).toContain('0,38') // commercial figures untouched

    // Each token restores back to its OWN exact original string — never
    // cross-contaminated (the alias's token must never restore to the
    // canonical's text, or vice versa).
    const restored = restoreTokensInObject(
      { vendor_name: canonical.token, vendor_short_name: alias.token },
      reverseMap,
    )
    expect(restored.vendor_name).toBe('CoAccept AB')
    expect(restored.vendor_short_name).toBe('Remembill')

    // Full round-trip on the masked TEXT itself (not just field values):
    // masking then restoring the whole document reproduces it exactly.
    let roundTripped = masked
    for (const [token, original] of reverseMap) roundTripped = roundTripped.split(token).join(original)
    expect(roundTripped).toBe(text)
  })

  it('source_clause fidelity: a clause that says "Remembill" restores to "Remembill", never canonicalized into "CoAccept AB"', () => {
    const text = 'CoAccept AB (Remembill) is the supplier. Remembill will invoice monthly for services rendered.'
    const { tokenMap, reverseMap } = detectPII(text)
    const sourceClause = 'Remembill will invoice monthly for services rendered.'

    const maskedClause = maskText(sourceClause, tokenMap)
    expect(maskedClause).not.toContain('CoAccept AB')
    expect(maskedClause).not.toContain('Remembill')

    // Simulates restoreTokensInObject running on an extracted field whose
    // source_clause preserved the ALIAS wording verbatim — restoration
    // must reproduce "Remembill", not silently substitute the canonical
    // organisation's own name.
    const restored = restoreTokensInObject({ source_clause: maskedClause }, reverseMap)
    expect(restored.source_clause).toBe(sourceClause)
    expect(restored.source_clause).toContain('Remembill')
    expect(restored.source_clause).not.toContain('CoAccept AB')
  })

  it('simulating buildMaskFromDB\'s alias_of_entity_id traversal: approving only the canonical entity ID still masks the alias occurrence, each via its OWN token', () => {
    const text = 'CoAccept AB (Remembill) is the supplier. Remembill will invoice monthly.'
    const { entities } = detectPII(text)
    const canonical = entities.find(e => e.type === 'ORG' && e.value === 'CoAccept AB')!
    const alias = entities.find(e => e.type === 'ORG' && e.value === 'Remembill')!

    // Simulates the real pii_entities rows buildMaskFromDB reads: distinct
    // ids/tokens, alias.alias_of_entity_id -> canonical.id.
    const dbRows = [
      { id: 'A', original_value: canonical.value, token: canonical.token, alias_of_entity_id: null as string | null },
      { id: 'B', original_value: alias.value, token: alias.token, alias_of_entity_id: 'A' },
    ]
    const approvedIds = new Set(['A']) // only the canonical is approved

    const rootById = new Map(dbRows.map(r => [r.id, aliasGroupRoot(r)]))
    const approvedRoots = new Set([...approvedIds].map(id => rootById.get(id) ?? id))
    const tokenMap = new Map<string, string>()
    const reverseMap = new Map<string, string>()
    for (const row of dbRows) {
      if (!approvedRoots.has(aliasGroupRoot(row))) continue
      tokenMap.set(row.original_value, row.token)
      reverseMap.set(row.token, row.original_value)
    }

    const masked = maskText(text, tokenMap)
    expect(masked).not.toContain('CoAccept AB')
    expect(masked).not.toContain('Remembill')
    // Each entity's own token/value pair survives round-trip independently.
    expect(reverseMap.get(canonical.token)).toBe('CoAccept AB')
    expect(reverseMap.get(alias.token)).toBe('Remembill')
  })
})

describe('hardening item 2 (review pass 3) — alias approval is group-consistent in BOTH directions', () => {
  // Mirrors exactly what buildMaskFromDB (app/api/jobs/[id]/execute/
  // route.ts) does against real pii_entities rows: group root = own id for
  // a canonical, or alias_of_entity_id for an alias; approving ANY member
  // whose root matches an approved entity's root masks the WHOLE group.
  function maskFromApproval(
    dbRows: Array<{ id: string; original_value: string; token: string; alias_of_entity_id: string | null }>,
    approvedIds: string[],
  ) {
    const rootById = new Map(dbRows.map(r => [r.id, aliasGroupRoot(r)]))
    const approvedRoots = new Set(approvedIds.map(id => rootById.get(id) ?? id))
    const tokenMap = new Map<string, string>()
    const reverseMap = new Map<string, string>()
    for (const row of dbRows) {
      if (!approvedRoots.has(aliasGroupRoot(row))) continue
      tokenMap.set(row.original_value, row.token)
      reverseMap.set(row.token, row.original_value)
    }
    return { tokenMap, reverseMap }
  }

  const TEXT = 'CoAccept AB (Remembill) is the supplier. Remembill will invoice monthly.'

  function buildRows() {
    const { entities } = detectPII(TEXT)
    const canonical = entities.find(e => e.type === 'ORG' && e.value === 'CoAccept AB')!
    const alias = entities.find(e => e.type === 'ORG' && e.value === 'Remembill')!
    return {
      canonical, alias,
      rows: [
        { id: 'A', original_value: canonical.value, token: canonical.token, alias_of_entity_id: null as string | null },
        { id: 'B', original_value: alias.value, token: alias.token, alias_of_entity_id: 'A' },
      ],
    }
  }

  it('approve CoAccept AB (canonical) -> masks CoAccept AB AND Remembill', () => {
    const { rows } = buildRows()
    const { tokenMap } = maskFromApproval(rows, ['A'])
    const masked = maskText(TEXT, tokenMap)
    expect(masked).not.toContain('CoAccept AB')
    expect(masked).not.toContain('Remembill')
  })

  it('approve Remembill (alias) -> masks Remembill AND CoAccept AB — the reverse direction, previously broken', () => {
    const { rows } = buildRows()
    const { tokenMap } = maskFromApproval(rows, ['B'])
    const masked = maskText(TEXT, tokenMap)
    expect(masked).not.toContain('Remembill')
    expect(masked).not.toContain('CoAccept AB') // this is the invariant that must never fail
  })

  it('both approval directions preserve distinct tokens and exact mask -> restore round trip', () => {
    const { canonical, alias, rows } = buildRows()

    for (const approvedIds of [['A'], ['B']]) {
      const { tokenMap, reverseMap } = maskFromApproval(rows, approvedIds)
      // Distinct tokens regardless of which row triggered the approval.
      expect(tokenMap.get(canonical.value)).toBe(canonical.token)
      expect(tokenMap.get(alias.value)).toBe(alias.token)
      expect(canonical.token).not.toBe(alias.token)

      const masked = maskText(TEXT, tokenMap)
      let restored = masked
      for (const [token, original] of reverseMap) restored = restored.split(token).join(original)
      expect(restored).toBe(TEXT)
    }
  })

  it('neither row approved -> neither is masked (no accidental group-wide default-approval)', () => {
    const { rows } = buildRows()
    const { tokenMap } = maskFromApproval(rows, [])
    const masked = maskText(TEXT, tokenMap)
    expect(masked).toBe(TEXT)
  })
})

describe('resolveGroupMemberIds — hardening item 3 (review pass 5): group-consistent DECISIONS, not only masking', () => {
  const CANONICAL = { id: 'A', alias_of_entity_id: null as string | null }
  const ALIAS = { id: 'B', alias_of_entity_id: 'A' as string | null }
  const UNRELATED = { id: 'C', alias_of_entity_id: null as string | null }
  const entities = [CANONICAL, ALIAS, UNRELATED]

  it('resolving by the canonical id returns both canonical and alias, never the unrelated entity', () => {
    expect(resolveGroupMemberIds('A', entities).sort()).toEqual(['A', 'B'])
  })

  it('resolving by the ALIAS\'s own group root (which is the canonical id) returns the same group', () => {
    expect(resolveGroupMemberIds(aliasGroupRoot(ALIAS), entities).sort()).toEqual(['A', 'B'])
  })

  it('an entity with no alias relationship resolves to a group of just itself', () => {
    expect(resolveGroupMemberIds('C', entities)).toEqual(['C'])
  })

  // Simulates exactly what app/api/jobs/[id]/pii/route.ts's PATCH handler
  // does: resolve the group, then apply ONE action to every member's
  // persisted state. Proves the supported API flow structurally cannot
  // produce "approve CoAccept AB, then reject Remembill" — every action
  // request against ANY group member ends with all members in the SAME
  // final state, since resolveAliasGroupIds always widens a single
  // entityId into the whole group before the write happens.
  type FakeRow = { id: string; alias_of_entity_id: string | null; approved: boolean; ignored: boolean; hasOccurrence: boolean }
  function applyAction(rows: FakeRow[], entityId: string, action: 'approve' | 'reject' | 'ignore') {
    const target = rows.find(r => r.id === entityId)!
    const canonicalId = aliasGroupRoot(target)
    const groupIds = resolveGroupMemberIds(canonicalId, rows)
    for (const row of rows) {
      if (!groupIds.includes(row.id)) continue
      if (action === 'approve') row.approved = true
      else if (action === 'reject') row.hasOccurrence = false
      else if (action === 'ignore') { row.approved = false; row.ignored = true; row.hasOccurrence = false }
    }
  }

  it('approve CoAccept AB (canonical) then reject Remembill (alias) -> the SECOND action wins for BOTH, never a split state', () => {
    const rows: FakeRow[] = [
      { id: 'A', alias_of_entity_id: null, approved: false, ignored: false, hasOccurrence: true },
      { id: 'B', alias_of_entity_id: 'A', approved: false, ignored: false, hasOccurrence: true },
    ]
    applyAction(rows, 'A', 'approve')
    expect(rows.find(r => r.id === 'A')!.approved).toBe(true)
    expect(rows.find(r => r.id === 'B')!.approved).toBe(true) // group-approved too

    applyAction(rows, 'B', 'reject') // rejecting the ALIAS this time
    // Both members lose their job occurrence together — never "A stays
    // approved-and-present while B is rejected", which would be the
    // contradictory state this mechanism exists to prevent.
    expect(rows.find(r => r.id === 'A')!.hasOccurrence).toBe(false)
    expect(rows.find(r => r.id === 'B')!.hasOccurrence).toBe(false)
  })

  it('reject canonical then approve alias -> both end up approved (last action wins for the whole group, never a mix)', () => {
    const rows: FakeRow[] = [
      { id: 'A', alias_of_entity_id: null, approved: false, ignored: false, hasOccurrence: true },
      { id: 'B', alias_of_entity_id: 'A', approved: false, ignored: false, hasOccurrence: true },
    ]
    applyAction(rows, 'A', 'reject')
    expect(rows.every(r => !r.hasOccurrence)).toBe(true)

    applyAction(rows, 'B', 'approve')
    expect(rows.find(r => r.id === 'A')!.approved).toBe(true)
    expect(rows.find(r => r.id === 'B')!.approved).toBe(true)
  })

  it('ignore either member permanently whitelists BOTH — never one ignored while the other remains reviewable', () => {
    const rows: FakeRow[] = [
      { id: 'A', alias_of_entity_id: null, approved: true, ignored: false, hasOccurrence: true },
      { id: 'B', alias_of_entity_id: 'A', approved: true, ignored: false, hasOccurrence: true },
    ]
    applyAction(rows, 'B', 'ignore')
    expect(rows.find(r => r.id === 'A')!.ignored).toBe(true)
    expect(rows.find(r => r.id === 'B')!.ignored).toBe(true)
    expect(rows.every(r => !r.approved && !r.hasOccurrence)).toBe(true)
  })

  it('an UNRELATED entity in the same org is never swept into someone else\'s group action', () => {
    const rows: FakeRow[] = [
      { id: 'A', alias_of_entity_id: null, approved: false, ignored: false, hasOccurrence: true },
      { id: 'B', alias_of_entity_id: 'A', approved: false, ignored: false, hasOccurrence: true },
      { id: 'C', alias_of_entity_id: null, approved: false, ignored: false, hasOccurrence: true },
    ]
    applyAction(rows, 'A', 'approve')
    expect(rows.find(r => r.id === 'C')!.approved).toBe(false)
  })
})

describe('deriveGroupReviewState — hardening (review pass 8): fresh-job initial state must never split canonical/alias approval', () => {
  // The exact reported bug: pii_entities.approved is an intentionally
  // org-scoped, REUSED flag (the same "CoAccept AB" row is shared across
  // every contract that mentions it), so a canonical approved in an
  // EARLIER job and an alias just detected for the first time in a FRESH
  // job start out with genuinely different raw `approved` values, even
  // though masking already treats them as one identity.
  it('REQUIRED — existing canonical entity from an earlier job (approved) + newly discovered alias in a fresh job (not yet approved) -> derives BOTH as approved, no mixed initial state', () => {
    const jobOccurrenceEntities = [
      { id: 'canonical-coaccept', alias_of_entity_id: null, approved: true, ignored: false },  // from an earlier job
      { id: 'alias-remembill', alias_of_entity_id: 'canonical-coaccept', approved: false, ignored: false }, // brand new in this job
    ]
    const derived = deriveGroupReviewState(jobOccurrenceEntities)
    expect(derived.get('canonical-coaccept')).toEqual({ approved: true, ignored: false })
    expect(derived.get('alias-remembill')).toEqual({ approved: true, ignored: false }) // no longer "Pending"
  })

  it('the reverse direction: alias already approved from an earlier context, canonical freshly detected and not yet approved -> both derive approved', () => {
    const entities = [
      { id: 'canonical', alias_of_entity_id: null, approved: false, ignored: false },
      { id: 'alias', alias_of_entity_id: 'canonical', approved: true, ignored: false },
    ]
    const derived = deriveGroupReviewState(entities)
    expect(derived.get('canonical')!.approved).toBe(true)
    expect(derived.get('alias')!.approved).toBe(true)
  })

  it('neither member approved -> both derive pending (no accidental default-approval)', () => {
    const entities = [
      { id: 'canonical', alias_of_entity_id: null, approved: false, ignored: false },
      { id: 'alias', alias_of_entity_id: 'canonical', approved: false, ignored: false },
    ]
    const derived = deriveGroupReviewState(entities)
    expect(derived.get('canonical')!.approved).toBe(false)
    expect(derived.get('alias')!.approved).toBe(false)
  })

  it('if either member is ignored, the WHOLE group derives ignored, and never simultaneously approved', () => {
    const entities = [
      { id: 'canonical', alias_of_entity_id: null, approved: true, ignored: false },
      { id: 'alias', alias_of_entity_id: 'canonical', approved: false, ignored: true },
    ]
    const derived = deriveGroupReviewState(entities)
    expect(derived.get('canonical')).toEqual({ approved: false, ignored: true })
    expect(derived.get('alias')).toEqual({ approved: false, ignored: true })
  })

  it('an unrelated entity in the same set never inherits another group\'s approval', () => {
    const entities = [
      { id: 'canonical', alias_of_entity_id: null, approved: true, ignored: false },
      { id: 'alias', alias_of_entity_id: 'canonical', approved: false, ignored: false },
      { id: 'unrelated', alias_of_entity_id: null, approved: false, ignored: false },
    ]
    const derived = deriveGroupReviewState(entities)
    expect(derived.get('unrelated')!.approved).toBe(false)
  })

  it('a non-grouped (no alias relationship at all) entity simply reflects its own state unchanged', () => {
    const entities = [
      { id: 'solo-approved', alias_of_entity_id: null, approved: true, ignored: false },
      { id: 'solo-pending', alias_of_entity_id: null, approved: false, ignored: false },
    ]
    const derived = deriveGroupReviewState(entities)
    expect(derived.get('solo-approved')!.approved).toBe(true)
    expect(derived.get('solo-pending')!.approved).toBe(false)
  })

  // End-to-end simulation of the GET /api/jobs/[id]/pii route's actual
  // fix: scoped to THIS JOB's own occurrence entities (job-level
  // occurrence state), exactly reproducing the reported scenario with
  // realistic CoAccept AB / Remembill values and asserting the API-shaped
  // output a reviewer would see.
  it('simulates the GET /pii route fix end-to-end: job-level occurrence state, not a blind global inheritance', () => {
    type OccurrenceEntity = { id: string; original_value: string; alias_of_entity_id: string | null; approved: boolean; ignored: boolean }
    const thisJobsOccurrenceEntities: OccurrenceEntity[] = [
      { id: 'e-coaccept', original_value: 'CoAccept AB', alias_of_entity_id: null, approved: true, ignored: false },
      { id: 'e-remembill', original_value: 'Remembill', alias_of_entity_id: 'e-coaccept', approved: false, ignored: false },
      { id: 'e-nordicfit', original_value: 'NordicFit Test AB', alias_of_entity_id: null, approved: false, ignored: false }, // unrelated org, must stay untouched
    ]
    const derived = deriveGroupReviewState(thisJobsOccurrenceEntities)
    const presented = thisJobsOccurrenceEntities.map(e => ({ original_value: e.original_value, approved: derived.get(e.id)!.approved }))
    expect(presented).toEqual([
      { original_value: 'CoAccept AB', approved: true },
      { original_value: 'Remembill', approved: true },
      { original_value: 'NordicFit Test AB', approved: false },
    ])
  })
})

describe('item 4 — organization registration numbers, never PERSON/SSN', () => {
  it('classifies a Swedish organisationsnummer as ORGANIZATION_IDENTIFIER, associated with the nearest organisation', () => {
    const text = 'CoAccept AB, org.nr 559548-7405, is the supplier.'
    const { entities } = detectPII(text)
    const idEntity = entities.find(e => e.type === 'ORGANIZATION_IDENTIFIER')
    expect(idEntity).toBeDefined()
    expect(idEntity!.value).toBe('559548-7405')
    expect(idEntity!.associatedOrg).toBe('CoAccept AB')
    expect(entities.some(e => e.type === 'PERSON' && e.value.includes('559548'))).toBe(false)
  })

  it('classifies both org numbers from the actual contract correctly', () => {
    const text = 'Supplier: CoAccept AB, 559548-7405. Customer: NordicFit Test AB, 559999-1234.'
    const { entities } = detectPII(text)
    const ids = entities.filter(e => e.type === 'ORGANIZATION_IDENTIFIER').map(e => e.value)
    expect(ids).toContain('559548-7405')
    expect(ids).toContain('559999-1234')
  })

  it('stays silent (never ORGANIZATION_IDENTIFIER, never PERSON/SSN) when the digits could plausibly be a real personnummer date', () => {
    // 03-15 is a valid month/day-like prefix (month digits = 03, a real month) — genuinely ambiguous with a personnummer.
    const text = 'Reference number 850315-1234 noted on file.'
    const { entities } = detectPII(text)
    expect(entities.filter(e => e.type === 'ORGANIZATION_IDENTIFIER')).toHaveLength(0)
    expect(entities.filter(e => e.type === 'PERSON')).toHaveLength(0)
  })
})

describe('item 5 — PII/anonymization must never mask commercial language', () => {
  const CLAUSE = 'Betalgrad efter uppföljning är utfallet, mätt värdeviktat.'
  const COMMERCIAL_TERMS = [
    '0,38', '1,70', '0,60', '4,50 %', '5 000', '90 dagar', 'värdeviktad betalgrad', 'tremånaderssnitt',
  ]
  const DOCUMENT = [
    'CoAccept AB (Remembill) och NordicFit Test AB har ingått detta avtal.',
    'Avgift per betalningsförfrågan: 0,38 EUR. Framgångsavgift: 1,70 EUR.',
    'Överskjutande förfrågningar utöver avtalad volym: 0,60 EUR.',
    'Resultatandelen är 4,50 % vid full betalningsgrad, beräknad på ett tremånaderssnitt.',
    'Avtalad volym: 5 000 betalningsförfrågningar per månad.',
    '90 dagars pilot utan plattformsavgift.',
    CLAUSE,
    'Resultatandelen baseras på värdeviktad betalgrad.',
  ].join('\n')

  it('none of the numeric/rate/term commercial language is present in the tokenMap as a maskable span', () => {
    const { tokenMap } = detectPII(DOCUMENT)
    for (const term of COMMERCIAL_TERMS) {
      expect(tokenMap.has(term)).toBe(false)
    }
  })

  it('every commercial number/term survives masking byte/text-equivalent, even after organization masking is applied', () => {
    const { tokenMap } = detectPII(DOCUMENT)
    const masked = maskText(DOCUMENT, tokenMap)
    for (const term of COMMERCIAL_TERMS) {
      expect(masked).toContain(term)
    }
  })

  it('no PERSON entity is produced anywhere in the full document', () => {
    const { entities } = detectPII(DOCUMENT)
    expect(entities.filter(e => e.type === 'PERSON')).toHaveLength(0)
  })

  it('restoring tokens back onto extracted terms never touches numeric/date fields (existing guarantee, reconfirmed)', () => {
    const { reverseMap } = detectPII(DOCUMENT)
    const extracted = { base_monthly_fee: 2000, included_units: 5000, currency: 'EUR', vendor_name: '[ORG_1]' }
    const restored = restoreTokensInObject(extracted, reverseMap)
    expect(restored.base_monthly_fee).toBe(2000)
    expect(restored.included_units).toBe(5000)
    expect(restored.currency).toBe('EUR')
  })
})
