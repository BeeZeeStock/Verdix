import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { supabaseServer, createBrowserClient } from './supabase'

// ═══════════════════════════════════════════════════════════════════════════
// Integration tests for set_proposal_cache_entry's actual atomicity — real
// Postgres row-level locking under genuine concurrency is not something a
// JS mock can meaningfully verify, so these run against the real
// (post-migration) database using the service-role client, same pattern as
// lib/credit-ledger-integration.test.ts. Self-contained: creates its own
// scratch job/contract_terms row and cleans up regardless of pass/fail.
//
// Reproduces the exact production incident (OS-2026-09, 2026-08-26): two
// propose-rule requests for different service credits on the same job
// mounted concurrently; each read contract_terms.ai_proposal_cache before
// either write landed, so the later whole-column write silently reverted
// the earlier request's key. See supabase/migrations/
// 20260830000006_proposal_cache_atomic_upsert.sql.
//
// SKIPPED BY DEFAULT. Run after applying that migration:
//   RUN_RLS_INTEGRATION_TESTS=true npx vitest run lib/proposal-cache-atomicity.test.ts
// ═══════════════════════════════════════════════════════════════════════════

const RUN = process.env.RUN_RLS_INTEGRATION_TESTS === 'true'
const describeIf = RUN ? describe : describe.skip

describeIf('set_proposal_cache_entry — real Postgres atomicity', () => {
  let orgId: string
  let jobId: string
  let termsId: string

  beforeAll(async () => {
    const slug = `proposal-cache-atomicity-test-${Date.now()}`
    const { data: org, error: orgError } = await supabaseServer.from('organizations').insert({ name: 'proposal-cache-atomicity-test-org', slug }).select('id').single()
    if (orgError) throw new Error(`organizations insert failed: ${orgError.message}`)
    orgId = org!.id
    const { data: job, error: jobError } = await supabaseServer.from('jobs').insert({
      org_id: orgId, name: 'proposal-cache-atomicity-test-job', module: 'AUTO_CONFIGURE', status: 'PENDING',
    }).select('id').single()
    if (jobError) throw new Error(`jobs insert failed: ${jobError.message}`)
    jobId = job!.id
  })

  afterAll(async () => {
    await supabaseServer.from('contract_terms').delete().eq('job_id', jobId)
    await supabaseServer.from('jobs').delete().eq('id', jobId)
    await supabaseServer.from('organizations').delete().eq('id', orgId)
  })

  async function seedTerms(cache: Record<string, unknown>): Promise<string> {
    const { data, error } = await supabaseServer.from('contract_terms')
      .insert({ job_id: jobId, ai_proposal_cache: cache })
      .select('id').single()
    if (error) throw new Error(`contract_terms insert failed: ${error.message}`)
    return data!.id as string
  }

  async function readCache(id: string): Promise<Record<string, unknown>> {
    const { data, error } = await supabaseServer.from('contract_terms').select('ai_proposal_cache').eq('id', id).single()
    if (error) throw new Error(`readCache failed: ${error.message}`)
    return data!.ai_proposal_cache as Record<string, unknown>
  }

  it('two concurrent writes to DIFFERENT keys: both survive (the exact lost-update shape observed in production)', async () => {
    termsId = await seedTerms({
      'service_credit:A': { old: true },
      'service_credit:B': { old: true },
    })

    await Promise.all([
      supabaseServer.rpc('set_proposal_cache_entry', {
        p_contract_terms_id: termsId, p_cache_key: 'service_credit:A', p_cache_entry: { new: true, who: 'request-1' },
      }),
      supabaseServer.rpc('set_proposal_cache_entry', {
        p_contract_terms_id: termsId, p_cache_key: 'service_credit:B', p_cache_entry: { new: true, who: 'request-2' },
      }),
    ])

    const cache = await readCache(termsId)
    // Neither key was reverted to its stale pre-write value by the other
    // request's write — this is the exact invariant the JS whole-column
    // read-modify-write violated in production.
    expect(cache['service_credit:A']).toEqual({ new: true, who: 'request-1' })
    expect(cache['service_credit:B']).toEqual({ new: true, who: 'request-2' })
  })

  it('a third key added after both A/B writes still coexists with them (no accumulated loss across sequential requests either)', async () => {
    await supabaseServer.rpc('set_proposal_cache_entry', {
      p_contract_terms_id: termsId, p_cache_key: 'meter_match:SQM', p_cache_entry: { meter_key: 'sqm' },
    })
    const cache = await readCache(termsId)
    expect(cache['service_credit:A']).toEqual({ new: true, who: 'request-1' })
    expect(cache['service_credit:B']).toEqual({ new: true, who: 'request-2' })
    expect(cache['meter_match:SQM']).toEqual({ meter_key: 'sqm' })
  })

  it('two concurrent writes to the SAME key: last committed write wins (ordering between the two is not guaranteed), exactly one of the two values persists, no unrelated key is lost', async () => {
    const sameKeyTermsId = await seedTerms({
      'service_credit:A': { untouched: true },
      'service_credit:C': { old: true },
    })

    const [r1, r2] = await Promise.all([
      supabaseServer.rpc('set_proposal_cache_entry', {
        p_contract_terms_id: sameKeyTermsId, p_cache_key: 'service_credit:C', p_cache_entry: { writer: 'req1' },
      }),
      supabaseServer.rpc('set_proposal_cache_entry', {
        p_contract_terms_id: sameKeyTermsId, p_cache_key: 'service_credit:C', p_cache_entry: { writer: 'req2' },
      }),
    ])
    expect(r1.error).toBeNull()
    expect(r2.error).toBeNull()

    const cache = await readCache(sameKeyTermsId)
    // Exactly one writer's value survives — not a merge, not corruption,
    // not both silently dropped. Which one wins is a genuine race and
    // intentionally not asserted; only that the result is one of the two
    // valid outcomes.
    expect(['req1', 'req2']).toContain((cache['service_credit:C'] as { writer: string }).writer)
    // The unrelated key, present before either concurrent write, must
    // survive untouched regardless of which same-key writer won.
    expect(cache['service_credit:A']).toEqual({ untouched: true })

    await supabaseServer.from('contract_terms').delete().eq('id', sameKeyTermsId)
  })

  it('a missing contract_terms row is a no-op, not an error (no such id) — the UPDATE simply matches zero rows', async () => {
    const { error } = await supabaseServer.rpc('set_proposal_cache_entry', {
      p_contract_terms_id: '00000000-0000-0000-0000-000000000000', p_cache_key: 'x', p_cache_entry: { a: 1 },
    })
    expect(error).toBeNull()
  })
})

describeIf('set_proposal_cache_entry — anon key must not reach it', () => {
  const anon = createBrowserClient()

  it('the RPC is not callable with the anon key', async () => {
    const { error } = await anon.rpc('set_proposal_cache_entry', {
      p_contract_terms_id: '00000000-0000-0000-0000-000000000000', p_cache_key: 'x', p_cache_entry: { a: 1 },
    })
    expect(error).toBeTruthy()
  })
})
