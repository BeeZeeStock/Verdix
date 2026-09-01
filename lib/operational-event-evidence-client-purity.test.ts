import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

// Step 17H.2A regression guardrail — same exact bug class as Step 17F.7
// (see lib/client-safe-billing-period-workspace.test.ts): this module is
// transitively imported into the CLIENT bundle via
// app/(dashboard)/configure/[id]/page.tsx ('use client') ->
// lib/committed-fixed-fee-resolver.ts -> lib/commercial-rule-status.ts ->
// lib/operational-event-evidence.ts. lib/supabase.ts eagerly instantiates a
// service-role Supabase client at module scope — pulling it into client
// code crashes the whole page the moment the browser evaluates it
// (SUPABASE_SERVICE_ROLE_KEY is never available client-side).
//
// This exact regression happened once already this step: a DB-loading
// helper (loadActiveOperationalEventEvidence) was briefly added directly
// to lib/operational-event-evidence.ts with an `import { supabaseServer }
// from './supabase'`, which broke /configure/[id] and /configure with an
// uncaught "supabaseKey is required" module-evaluation error the moment
// either page loaded — caught live, reverted, and the loader moved to the
// server-only lib/operational-event-evidence-loader.ts instead. This test
// is what should have caught it before a human had to.
function importLinesOf(relativeFile: string): string[] {
  const source = readFileSync(path.join(__dirname, relativeFile), 'utf-8')
  return source.split('\n').filter(l => /^\s*import\b/.test(l))
}

function hasImportFrom(importLines: string[], moduleBasename: string): boolean {
  const re = new RegExp(`['"](\\./|@/lib/)${moduleBasename}['"]`)
  return importLines.some(l => re.test(l))
}

describe('lib/operational-event-evidence.ts stays free of server-only imports (Step 17H.2A regression guard)', () => {
  it('does not import from lib/supabase directly', () => {
    expect(hasImportFrom(importLinesOf('operational-event-evidence.ts'), 'supabase')).toBe(false)
  })

  it('does not import from the server-only loader (which itself imports supabase)', () => {
    expect(hasImportFrom(importLinesOf('operational-event-evidence.ts'), 'operational-event-evidence-loader')).toBe(false)
  })
})

describe('lib/commercial-rule-status.ts stays free of server-only imports — it is reachable from the client bundle', () => {
  it('does not import from lib/supabase directly', () => {
    expect(hasImportFrom(importLinesOf('commercial-rule-status.ts'), 'supabase')).toBe(false)
  })

  it('does not import from the server-only evidence loader', () => {
    expect(hasImportFrom(importLinesOf('commercial-rule-status.ts'), 'operational-event-evidence-loader')).toBe(false)
  })
})

describe('lib/committed-fixed-fee-resolver.ts stays free of server-only imports — imported directly by the client component page.tsx', () => {
  it('does not import from lib/supabase directly', () => {
    expect(hasImportFrom(importLinesOf('committed-fixed-fee-resolver.ts'), 'supabase')).toBe(false)
  })

  it('does not import from the server-only evidence loader', () => {
    expect(hasImportFrom(importLinesOf('committed-fixed-fee-resolver.ts'), 'operational-event-evidence-loader')).toBe(false)
  })
})
