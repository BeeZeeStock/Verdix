// Step 17D rollout — real-Postgres/RLS integration testing exposed a
// genuine defect: lib/admin.ts's top-level `import { auth } from './auth'`
// means EVEN a dynamic `await import('./admin')` (the workaround used
// elsewhere in this codebase, e.g. app/api/jobs/[id]/meter-mappings/
// route.ts's own `await import('@/lib/auth')`) still transitively pulls in
// next-auth's full chain the moment it actually runs — deferring the
// import only delays module resolution, it doesn't avoid it. That chain
// fails to resolve `next/server` inside vitest specifically (a vitest-
// environment-only quirk; it resolves fine under the real Next.js
// runtime), so lib/org-lifecycle.ts's resolveSourceManagementAuthorization
// — a real, DB-touching function genuinely exercised by real-Postgres
// integration tests, unlike route handlers, which this codebase never
// calls directly under vitest — crashed the moment it actually ran.
//
// The fix: split the PURE identity check (an explicit email allowlist,
// no session, no DB, no auth.ts dependency at all) out of lib/admin.ts
// into this standalone module. lib/admin.ts re-exports from here so every
// existing caller (route handlers importing isAdminEmail/requireAdmin
// from '@/lib/admin') is unaffected; lib/org-lifecycle.ts imports
// isAdminEmail directly from here instead, avoiding the auth.ts chain
// entirely — no dynamic import needed, since there is nothing left to
// defer.
export const ADMIN_EMAILS = ['bilal.zahoor@yahoo.com', 'bilal@lynoraai.com']

export function isAdminEmail(email: string | null | undefined): boolean {
  return ADMIN_EMAILS.includes(email ?? '')
}
