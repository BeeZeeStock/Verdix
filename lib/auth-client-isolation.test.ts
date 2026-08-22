import { describe, it, expect } from 'vitest'
import { createServerClient, createBrowserClient, supabaseServer } from './supabase'

// ═══════════════════════════════════════════════════════════════════════════
// Regression coverage for a real, confirmed production bug found while
// verifying Step 13's execution-state work: lib/auth.ts's Credentials
// authorize() used to call `.auth.signInWithPassword()` directly on the
// shared, module-singleton `supabaseServer` client. supabase-js attaches
// whichever session currently exists on a client instance to the
// Authorization header of every later request from that SAME instance,
// regardless of `persistSession: false` — so any successful Credentials
// login anywhere in the process silently downgraded every subsequent
// server-side query from service_role to that end-user's own `authenticated`
// role, which has no grants on tables locked down to service-role-only
// (org_memberships, jobs, operational_event_evidence, ...). This made
// authorization behave in a process-order-dependent way and produced
// intermittent "Access by invitation only" failures unrelated to any real
// membership problem.
//
// Fix: lib/auth.ts now calls `createServerClient()` (a fresh, disposable
// client) for the one-off password check, never the shared `supabaseServer`
// singleton — see that file's own comment on the change.
// ═══════════════════════════════════════════════════════════════════════════

describe('createServerClient never returns the shared singleton', () => {
  it('two calls return two distinct client instances', () => {
    expect(createServerClient()).not.toBe(createServerClient())
  })

  it('a freshly created client is never the same object as the module-level supabaseServer singleton', () => {
    expect(createServerClient()).not.toBe(supabaseServer)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Live proof, against the real dev server + real Supabase project. This
// cannot be reproduced by importing lib/supabase.ts inside this test file —
// vitest runs in its own Node process, entirely separate from `next dev`'s,
// so this process's own `supabaseServer` import is not the object that was
// ever at risk. The only way to observe the RUNNING SERVER's shared
// singleton state is through its own HTTP responses — this test drives real
// logins and real requests against existing, already-authenticated routes
// (never a bespoke debug route) and asserts on what the server actually
// returns. If the bug regressed, step 2 below would fail with 403 "Access by
// invitation only" even though the membership genuinely exists — exactly
// what was observed live before this fix.
//
// SKIPPED BY DEFAULT — needs `npm run dev` running on localhost:3000 (or
// LIVE_TEST_BASE_URL) in addition to the real Supabase project. Run
// deliberately:
//   RUN_LIVE_AUTH_ISOLATION_TEST=true npx vitest run lib/auth-client-isolation.test.ts
// ═══════════════════════════════════════════════════════════════════════════

const RUN = process.env.RUN_LIVE_AUTH_ISOLATION_TEST === 'true'
const describeIf = RUN ? describe : describe.skip
const BASE = process.env.LIVE_TEST_BASE_URL ?? 'http://localhost:3000'

type Session = { jar: Map<string, string> }

async function login(email: string, password: string): Promise<Session> {
  const jar = new Map<string, string>()
  const capture = (res: Response) => {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';')
      const [k, v] = pair.split('=')
      jar.set(k, v)
    }
  }
  const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')

  const csrfRes = await fetch(`${BASE}/api/auth/csrf`)
  capture(csrfRes)
  const { csrfToken } = await csrfRes.json()

  const loginRes = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader() },
    body: new URLSearchParams({ email, password, csrfToken, json: 'true' }),
    redirect: 'manual',
  })
  capture(loginRes)
  return { jar }
}

function cookieHeader(session: Session): string {
  return [...session.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

describeIf('live: Credentials login must never contaminate the shared service-role client', () => {
  it('two real users can log in, in either order, and every server-side (requireOrg-gated) query keeps working as service_role throughout', async () => {
    const stamp = Date.now().toString(36)
    const password = 'Test-Password-12345!'
    const emailA = `authiso-a-${stamp}@verdix-test.local`
    const emailB = `authiso-b-${stamp}@verdix-test.local`

    const { data: userA, error: userAErr } = await supabaseServer.auth.admin.createUser({ email: emailA, password, email_confirm: true })
    const { data: userB, error: userBErr } = await supabaseServer.auth.admin.createUser({ email: emailB, password, email_confirm: true })
    expect(userAErr).toBeNull()
    expect(userBErr).toBeNull()

    const { data: orgA } = await supabaseServer.from('organizations').insert({ name: `AuthIso A ${stamp}`, slug: `authiso-a-${stamp}` }).select('id').single()
    const { data: orgB } = await supabaseServer.from('organizations').insert({ name: `AuthIso B ${stamp}`, slug: `authiso-b-${stamp}` }).select('id').single()
    await supabaseServer.from('org_memberships').insert({ org_id: orgA!.id, user_email: emailA, role: 'member', status: 'active' })
    await supabaseServer.from('org_memberships').insert({ org_id: orgB!.id, user_email: emailB, role: 'member', status: 'active' })

    try {
      // Step 1 — baseline: the running dev server's own service-role
      // client can already reach an org-scoped route before any of this
      // test's logins happen. (Implicitly true if the server is up; the
      // real assertions are steps 2-5.)

      // Step 2 — user A logs in, then immediately hits a real, existing,
      // requireOrg()-gated route. If the singleton got contaminated by A's
      // OWN login, this is exactly where it would surface first.
      const sessionA = await login(emailA, password)
      const resA1 = await fetch(`${BASE}/api/jobs`, { headers: { Cookie: cookieHeader(sessionA) } })
      expect(resA1.status).toBe(200)
      const bodyA1 = await resA1.json()
      expect(bodyA1.error).toBeUndefined()

      // Step 3 — a SECOND, different user logs in on the same server
      // process. This is the actual contamination trigger the bug had:
      // B's session must not leak onto, or interfere with, anything.
      const sessionB = await login(emailB, password)
      const resB = await fetch(`${BASE}/api/jobs`, { headers: { Cookie: cookieHeader(sessionB) } })
      expect(resB.status).toBe(200)
      const bodyB = await resB.json()
      expect(bodyB.error).toBeUndefined()

      // Step 4 — user A's ORIGINAL session must still work after B's later
      // login. Before the fix, whichever login happened LAST silently
      // became "the" identity every subsequent service-role query
      // effectively ran as — this is the process-order-dependence the fix
      // removes entirely (the shared client should never carry ANY
      // end-user session, so ordering must not matter at all).
      const resA2 = await fetch(`${BASE}/api/jobs`, { headers: { Cookie: cookieHeader(sessionA) } })
      expect(resA2.status).toBe(200)
      const bodyA2 = await resA2.json()
      expect(bodyA2.error).toBeUndefined()

      // Step 5 — item B's third required proof point: operational_event_
      // evidence remains unreachable to a plain anon/browser client even
      // after all of the above real login activity on this same server
      // process — the RLS lockdown is a database-layer guarantee,
      // independent of and unaffected by this application-layer fix.
      const anon = createBrowserClient()
      const anonRead = await anon.from('operational_event_evidence').select('id').limit(1)
      // Same "either RLS denies with an error, or returns zero rows" check
      // as lib/operational-event-evidence-rls.test.ts — either way, no data.
      if (!anonRead.error) expect(anonRead.data ?? []).toHaveLength(0)
    } finally {
      await supabaseServer.from('org_memberships').delete().in('org_id', [orgA!.id, orgB!.id])
      await supabaseServer.from('organizations').delete().in('id', [orgA!.id, orgB!.id])
      if (userA?.user) await supabaseServer.auth.admin.deleteUser(userA.user.id)
      if (userB?.user) await supabaseServer.auth.admin.deleteUser(userB.user.id)
    }
  })
})
