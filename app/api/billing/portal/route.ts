import { NextResponse } from 'next/server'
import { getVerdixStripe } from '@/lib/stripe-verdix'
import { auth } from '@/lib/auth'
import { getActiveOrg } from '@/lib/org'
import { getOrgSubscription } from '@/lib/billing'

// POST /api/billing/portal — redirect to Stripe Customer Portal
export async function POST() {
  const session = await auth()
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const org = await getActiveOrg()
  if (!org) return NextResponse.json({ error: 'No organisation' }, { status: 400 })

  const sub = await getOrgSubscription(org.orgId)
  if (!sub.stripe_customer_id) {
    return NextResponse.json({ error: 'No Stripe customer yet' }, { status: 400 })
  }


  const stripe = await getVerdixStripe()

  const portalSession = await stripe.billingPortal.sessions.create({
    customer: sub.stripe_customer_id,
    return_url: `${process.env.AUTH_URL || process.env.NEXTAUTH_URL || 'https://lynoraai.com'}/settings/billing`,
  })

  return NextResponse.json({ url: portalSession.url })
}
