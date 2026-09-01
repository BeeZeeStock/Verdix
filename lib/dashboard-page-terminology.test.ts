import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// Step E9D §6/§10 — "contract-review wording distinct from Billing
// Actions" has no existing render-test harness to hang a component test
// on (app/(dashboard)/dashboard/page.tsx has no test file today, same
// situation already worked around for the Configure page in Step E9C.3 —
// see lib/configure-page-section-order.test.ts, the precedent this file
// follows). Instead: read the page's own source and assert, at the text
// level, that the two concepts this pass deliberately separated —
// "Billing actions" (billing EXECUTION intervention) and "Needs contract
// review" (agreement/commercial SETUP awaiting reviewer approval) — use
// distinct visible copy, and that the old collapsed "Needs attention"
// wording is gone. A real regression guard against the two labels
// silently drifting back into the same word, without asserting anything
// about pixels/styling/spacing.
describe('Dashboard page — Billing Actions vs contract-review terminology (Step E9D §6)', () => {
  const source = readFileSync(
    join(process.cwd(), 'app/(dashboard)/dashboard/page.tsx'),
    'utf-8',
  )

  it('renders a distinct "Billing actions" heading', () => {
    expect(source).toContain('>Billing actions</h2>')
  })

  it('renders "Needs contract review" for the agreement/commercial-setup list, not the old collapsed "Needs attention" wording', () => {
    expect(source).toContain('Needs contract review · {actionItems.length}')
    // The old label may still appear inside explanatory code comments
    // documenting the rename — only the rendered JSX text is asserted on.
    expect(source).not.toContain('>Needs attention')
    expect(source).not.toContain('Needs attention ·')
  })
})
