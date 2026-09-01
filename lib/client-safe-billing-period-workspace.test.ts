import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

// Step 17F.7 (still load-bearing after Step 17H.2C's removal of the
// standalone BillingPeriodWorkspaceCard) — regression guardrail for the
// exact production crash: this file is imported by the client-side
// BillingSummaryCard (the now-sole consumer of derivePeriodExecutionModel
// for the enriched Billing Timeline), so it (and everything it imports)
// ships in the BROWSER bundle. lib/billing-writer.ts
// eagerly instantiates a service-role Supabase client (and imports Stripe)
// at module scope — pulling it into client code crashes the whole page on
// load the moment the browser evaluates it (SUPABASE_SERVICE_ROLE_KEY is
// never available client-side). A plain source-text check, not a bundler
// integration test, but cheap and exact: this module must never import from
// './billing-writer' (or '@/lib/billing-writer') again.
describe('lib/billing-period-workspace.ts stays free of server-only imports (Step 17F.7 regression guard)', () => {
  it('does not import from billing-writer (which eagerly instantiates supabaseServer/Stripe at module scope)', () => {
    const source = readFileSync(path.join(__dirname, 'billing-period-workspace.ts'), 'utf-8')
    const importLines = source.split('\n').filter(l => /^\s*import\b/.test(l))
    const violation = importLines.find(l => /['"](\.\/|@\/lib\/)billing-writer['"]/.test(l))
    expect(violation).toBeUndefined()
  })

  it('does not import from lib/supabase directly either', () => {
    const source = readFileSync(path.join(__dirname, 'billing-period-workspace.ts'), 'utf-8')
    const importLines = source.split('\n').filter(l => /^\s*import\b/.test(l))
    const violation = importLines.find(l => /['"](\.\/|@\/lib\/)supabase['"]/.test(l))
    expect(violation).toBeUndefined()
  })
})
