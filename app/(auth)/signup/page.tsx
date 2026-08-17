import { redirect } from 'next/navigation'
import { isSelfServiceSignupEnabled } from '@/lib/feature-flags'
import SignupForm from './SignupForm'

// Must be evaluated per-request, not baked in at build time — the whole
// point of the flag is that toggling it in the admin UI takes effect
// immediately without a redeploy.
export const dynamic = 'force-dynamic'

export default async function SignupPage() {
  if (!(await isSelfServiceSignupEnabled())) redirect('/login')
  return <SignupForm />
}
