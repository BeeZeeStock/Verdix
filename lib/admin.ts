import { auth } from './auth'

const ADMIN_EMAILS = ['bilal.zahoor@yahoo.com', 'bilal@lynoraai.com']

// Synchronous check for callers that already have the session's email (e.g.
// alongside another auth()-derived value) and don't want a second auth() call.
export function isAdminEmail(email: string | null | undefined): boolean {
  return ADMIN_EMAILS.includes(email ?? '')
}

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

// Remembill/CoAccept AB is a billing-connector partner (lib/connectors/usage/remembill.ts),
// not a Verdix customer — their team needs to see the Remembill platform meters
// (invoice_sent, email_sent, ...) in their own self-service Billing Test page,
// same as Verdix admins can, while every other org sees nothing there.
const REMEMBILL_TEAM_DOMAINS = ['coaccept.com']

export function isRemembillTeam(email: string | null | undefined): boolean {
  const domain = email?.split('@')[1]?.toLowerCase()
  return !!domain && REMEMBILL_TEAM_DOMAINS.includes(domain)
}
