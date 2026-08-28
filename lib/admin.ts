import { auth } from './auth'
import { isAdminEmail } from './admin-identity'

// isAdminEmail re-exported here (unchanged) so every existing caller keeps
// importing from '@/lib/admin' — see lib/admin-identity.ts for why the
// pure check itself now lives there instead of being defined in this file.
export { isAdminEmail }

export async function requireAdmin(): Promise<string> {
  const session = await auth()
  const email = session?.user?.email ?? ''
  if (!isAdminEmail(email)) {
    throw new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })
  }
  return email
}

export async function isAdmin(): Promise<boolean> {
  const session = await auth()
  return isAdminEmail(session?.user?.email)
}
