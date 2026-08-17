import { NextResponse } from 'next/server'
import { isSelfServiceSignupEnabled } from '@/lib/feature-flags'

// Public, unauthenticated — safe to expose a boolean. Needed because the
// marketing/login pages are client components and must not import
// supabaseServer (service-role key) directly.
export async function GET() {
  const selfServiceSignupEnabled = await isSelfServiceSignupEnabled()
  return NextResponse.json({ selfServiceSignupEnabled })
}
