import { describe, it, expect, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { supabaseServer } from '@/lib/supabase'

// Step 17H.4B0D4H1B4E2 §16 — GET /api/jobs/[id] must now include
// billing_hold in its response so the configure page can render
// BillingSafetyBanner. Real-DB proof, same pattern used throughout this
// session's H1B4 passes.
const RUN = process.env.RUN_RLS_INTEGRATION_TESTS === 'true'
const describeIf = RUN ? describe : describe.skip

vi.mock('@/lib/org', () => ({ requireOrg: vi.fn() }))
// lib/admin.ts (imported transitively by this route) imports the real
// lib/auth.ts (NextAuth config) — mocked to avoid a next-auth/next
// module-resolution issue in the vitest node environment, same as every
// other route test this session that touches this import chain.
vi.mock('@/lib/auth', () => ({ auth: vi.fn().mockResolvedValue(null) }))

let orgId = ''
const cleanupJobIds: string[] = []

afterAll(async () => {
  if (!RUN || !orgId) return
  for (const jobId of cleanupJobIds) await supabaseServer.from('jobs').delete().eq('id', jobId)
  await supabaseServer.from('organizations').delete().eq('id', orgId)
})

describeIf('GET /api/jobs/[id] — billing_hold wiring', () => {
  it('returns the real persisted billing_hold value (null, and a real held reason)', async () => {
    const { data: org } = await supabaseServer.from('organizations').insert({ name: 'h1b4e2-route-test', slug: `h1b4e2-route-${Date.now()}` }).select('id').single()
    orgId = org!.id as string
    const { data: job } = await supabaseServer.from('jobs').insert({
      name: 'h1b4e2 billing_hold route test', module: 'AUTO_CONFIGURE', currency: 'EUR', org_id: orgId,
    }).select('id').single()
    cleanupJobIds.push(job!.id as string)

    const { requireOrg } = await import('@/lib/org')
    ;(requireOrg as ReturnType<typeof vi.fn>).mockResolvedValue({ orgId, orgName: 'x', orgSlug: 'x', role: 'admin', userEmail: 'x@example.com' })

    const { GET } = await import('./route')

    const res1 = await GET(new NextRequest('http://localhost/api/test'), { params: Promise.resolve({ id: job!.id as string }) })
    const body1 = await res1.json()
    expect(body1.billing_hold).toBeNull()

    await supabaseServer.from('jobs').update({ billing_hold: { reason: 'schedule_rebuild_required', started_at: '2026-01-01T00:00:00.000Z' } }).eq('id', job!.id)
    const res2 = await GET(new NextRequest('http://localhost/api/test'), { params: Promise.resolve({ id: job!.id as string }) })
    const body2 = await res2.json()
    expect(body2.billing_hold).toEqual({ reason: 'schedule_rebuild_required', started_at: '2026-01-01T00:00:00.000Z' })
  }, 30000)
})
