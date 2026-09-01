import { describe, it, expect } from 'vitest'
import { supabaseServer } from './supabase'
import { cleanupStalePlannedInvoicesAndLoadOccupiedKeys } from './billing-writer'

// ═══════════════════════════════════════════════════════════════════════════
// Step 17H.2A items 3/4 — regression coverage for the rebuild-schedule
// cleanup correctness fix (lib/billing-writer.ts's
// cleanupStalePlannedInvoicesAndLoadOccupiedKeys, shared by configureStripe
// and configureRememhill). Before this fix, the cleanup deleted every
// 'processing' row unconditionally (risking deletion of an in-flight row
// mid-provider-operation, possibly already reflected as a real invoice at
// the provider) and never accounted for 'failed' rows in its dedup set
// (risking a duplicate scheduled/parked row being generated alongside a
// permanently-stuck failed one).
//
// Route handlers cannot be imported into vitest in this codebase (next-auth
// import failure — see lib/operational-event-evidence-rls.test.ts's note),
// so this tests the exported helper directly against a real database,
// same gated-integration pattern used throughout this project.
//
// SKIPPED BY DEFAULT — real network calls:
//   RUN_RLS_INTEGRATION_TESTS=true npx vitest run lib/planned-invoices-rebuild-cleanup-integration.test.ts
// ═══════════════════════════════════════════════════════════════════════════

const RUN = process.env.RUN_RLS_INTEGRATION_TESTS === 'true'
const describeIf = RUN ? describe : describe.skip

async function createTestOrg(name: string): Promise<string> {
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const { data, error } = await supabaseServer.from('organizations').insert({ name, slug }).select('id').single()
  if (error || !data) throw new Error(`createTestOrg failed: ${error?.message}`)
  return data.id as string
}

async function createTestJob(orgId: string): Promise<string> {
  const { data, error } = await supabaseServer
    .from('jobs')
    .insert({ name: 'Rebuild-cleanup test job', module: 'BILLING_VERIFICATION', currency: 'SEK', org_id: orgId, user_id: 'rebuild-cleanup-test@isolation-test.invalid' })
    .select('id').single()
  if (error || !data) throw new Error(`createTestJob failed: ${error?.message}`)
  return data.id as string
}

// One row per status, each on its own period_start (2026-01-01 .. 2026-07-01)
// so every row has a distinct planComponentKey and none collide.
const STATUS_PERIODS: Array<{ status: string; month: string }> = [
  { status: 'sent', month: '01' },
  { status: 'paid', month: '02' },
  { status: 'processing', month: '03' },
  { status: 'failed', month: '04' },
  { status: 'scheduled', month: '05' },
  { status: 'parked', month: '06' },
  { status: 'draft', month: '07' },
]

async function insertRowsForEveryStatus(jobId: string, orgId: string) {
  const rows = STATUS_PERIODS.map(({ status, month }) => ({
    job_id: jobId, org_id: orgId, year_num: 1,
    period_start: `2026-${month}-01`, period_end: `2026-${month}-28`,
    base_amount: 1000, currency: 'SEK', invoice_type: 'period', status,
  }))
  const { error } = await supabaseServer.from('planned_invoices').insert(rows)
  if (error) throw new Error(`insertRowsForEveryStatus failed: ${error.message}`)
}

describeIf('cleanupStalePlannedInvoicesAndLoadOccupiedKeys (Step 17H.2A items 3/4)', () => {
  it('protects processing/failed rows from deletion, deletes only scheduled/parked/draft, and occupies keys for sent/paid/processing/failed (never scheduled/parked/draft)', async () => {
    const orgId = await createTestOrg('Rebuild Cleanup Test')
    const jobId = await createTestJob(orgId)
    try {
      await insertRowsForEveryStatus(jobId, orgId)

      const occupiedKeys = await cleanupStalePlannedInvoicesAndLoadOccupiedKeys(jobId, 'test')

      const keyFor = (month: string) => `period:1:2026-${month}-01`
      // Occupied (must never be regenerated as a fresh row).
      expect(occupiedKeys.has(keyFor('01'))).toBe(true) // sent
      expect(occupiedKeys.has(keyFor('02'))).toBe(true) // paid
      expect(occupiedKeys.has(keyFor('03'))).toBe(true) // processing — item 3
      expect(occupiedKeys.has(keyFor('04'))).toBe(true) // failed — item 4
      // Not occupied — these were always meant to be cleared and rebuilt.
      expect(occupiedKeys.has(keyFor('05'))).toBe(false) // scheduled
      expect(occupiedKeys.has(keyFor('06'))).toBe(false) // parked
      expect(occupiedKeys.has(keyFor('07'))).toBe(false) // draft

      const { data: remaining } = await supabaseServer
        .from('planned_invoices')
        .select('status')
        .eq('job_id', jobId)
      const remainingStatuses = (remaining ?? []).map(r => r.status).sort()
      // processing/failed survive the cleanup untouched (item 3: no orphaned
      // in-flight row; item 4: failed preserved as a permanent audit record).
      expect(remainingStatuses).toEqual(['failed', 'paid', 'processing', 'sent'])
    } finally {
      await supabaseServer.from('planned_invoices').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('a job with only scheduled/parked/draft rows and no evidence-relevant history ends up with an empty occupied-key set and zero remaining rows', async () => {
    const orgId = await createTestOrg('Rebuild Cleanup Empty Test')
    const jobId = await createTestJob(orgId)
    try {
      const { error } = await supabaseServer.from('planned_invoices').insert([
        { job_id: jobId, org_id: orgId, year_num: 1, period_start: '2026-01-01', period_end: '2026-01-31', base_amount: 500, currency: 'SEK', invoice_type: 'period', status: 'scheduled' },
        { job_id: jobId, org_id: orgId, year_num: 1, period_start: '2026-02-01', period_end: '2026-02-28', base_amount: 500, currency: 'SEK', invoice_type: 'period', status: 'parked' },
      ])
      if (error) throw new Error(`insert failed: ${error.message}`)

      const occupiedKeys = await cleanupStalePlannedInvoicesAndLoadOccupiedKeys(jobId, 'test')
      expect(occupiedKeys.size).toBe(0)

      const { data: remaining } = await supabaseServer.from('planned_invoices').select('id').eq('job_id', jobId)
      expect(remaining ?? []).toHaveLength(0)
    } finally {
      await supabaseServer.from('planned_invoices').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })
})
