import { auth } from './auth'

const ADMIN_EMAILS = ['bilal.zahoor@yahoo.com', 'bilal@lynoraai.com']

export async function requireAdmin(): Promise<string> {
  const session = await auth()
  const email = session?.user?.email ?? ''
  if (!ADMIN_EMAILS.includes(email)) {
    throw new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })
  }
  return email
}

export async function isAdmin(): Promise<boolean> {
  const session = await auth()
  return ADMIN_EMAILS.includes(session?.user?.email ?? '')
}
