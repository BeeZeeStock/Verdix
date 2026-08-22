// Verdix Global Rulebook — version-bump discipline (Step 9, item 9). Three
// independent version constants exist across three different modules; see
// lib/rulebook/README.md's "Version-bump discipline" table for WHEN to
// bump each one. These tests don't (and can't) enforce that a human
// remembered to bump the right constant for a given content change — that
// requires human judgment about what changed — but they do guard against
// the two forms of "obvious drift" this codebase CAN catch mechanically:
// a malformed/missing version string, and a version constant silently
// being defined in the wrong module (which would break the whole point of
// keeping the three axes independently addressable).
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { VERDIX_RULEBOOK_VERSION } from '@/lib/rulebook/rules'
import { RULEBOOK_AI_GUIDANCE_VERSION } from '@/lib/rulebook/ai-guidance'
import { VERDIX_RULEBOOK_ACTIVATION_VERSION } from '@/lib/rulebook/activation'

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf-8')
}

const SEMVER = /^\d+\.\d+\.\d+$/

describe('the three Rulebook version constants are well-formed and independently defined', () => {
  it('VERDIX_RULEBOOK_VERSION (rules.ts) — what the Rulebook concludes', () => {
    expect(VERDIX_RULEBOOK_VERSION).toMatch(SEMVER)
  })
  it('RULEBOOK_AI_GUIDANCE_VERSION (ai-guidance.ts) — what the AI sees', () => {
    expect(RULEBOOK_AI_GUIDANCE_VERSION).toMatch(SEMVER)
  })
  it('VERDIX_RULEBOOK_ACTIVATION_VERSION (activation.ts) — what production does with a finding', () => {
    expect(VERDIX_RULEBOOK_ACTIVATION_VERSION).toMatch(SEMVER)
  })
})

describe('version constants live in the module their own axis is about, not re-exported/aliased from elsewhere (drift guard)', () => {
  it('rules.ts does not import a version constant from ai-guidance.ts or activation.ts', () => {
    const source = readSource('lib/rulebook/rules.ts')
    const importLines = source.split('\n').filter(line => /^import /.test(line.trim()))
    for (const line of importLines) {
      expect(line).not.toMatch(/ai-guidance/)
      expect(line).not.toMatch(/\.\/activation/)
    }
  })
  it('ai-guidance.ts does not import VERDIX_RULEBOOK_VERSION or VERDIX_RULEBOOK_ACTIVATION_VERSION', () => {
    const source = readSource('lib/rulebook/ai-guidance.ts')
    expect(source).not.toMatch(/VERDIX_RULEBOOK_VERSION/)
    expect(source).not.toMatch(/VERDIX_RULEBOOK_ACTIVATION_VERSION/)
  })
  it('activation.ts does not import RULEBOOK_AI_GUIDANCE_VERSION or VERDIX_RULEBOOK_VERSION', () => {
    const source = readSource('lib/rulebook/activation.ts')
    expect(source).not.toMatch(/RULEBOOK_AI_GUIDANCE_VERSION/)
    expect(source).not.toMatch(/VERDIX_RULEBOOK_VERSION\b/)
  })
})
