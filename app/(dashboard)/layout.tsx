import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Sidebar } from '@/components/dashboard/Sidebar'
import { OnboardingBanner } from '@/components/dashboard/OnboardingBanner'
import { getActiveOrg } from '@/lib/org'
import { auth } from '@/lib/auth'
import { supabaseServer } from '@/lib/supabase'
import { TERMS_VERSION } from '@/lib/terms-version'
import { getBillingContext } from '@/lib/billing'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth()
  if (!session?.user?.email) redirect('/login')

  const { data: consent } = await supabaseServer
    .from('user_consents')
    .select('terms_version')
    .eq('email', session.user.email)
    .maybeSingle()

  if (!consent || consent.terms_version !== TERMS_VERSION) redirect('/consent')

  const org = await getActiveOrg()

  const billing = org ? await getBillingContext(org.orgId).catch(() => null) : null

  return (
    <div className="flex flex-col md:flex-row md:h-screen bg-cream">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        {billing?.isOverLimit && (
          <div className="px-4 py-2.5 text-sm flex items-center justify-between gap-3" style={{ background: '#FEF2F2', borderBottom: '1px solid #FECACA' }}>
            <span className="text-red-700">
              <strong>Sync limit reached</strong> — you&apos;ve used {billing.subscription.syncs_used} of {billing.syncLimit} agreement syncs this month.
              {billing.plan.overage_price_eur ? ` Additional syncs are billed at €${billing.plan.overage_price_eur}/sync at month end.` : ''}
            </span>
            <Link href="/settings/billing" className="flex-shrink-0 text-xs font-semibold text-red-700 underline hover:text-red-900">
              Upgrade plan →
            </Link>
          </div>
        )}
        {billing?.isNearLimit && !billing.isOverLimit && (
          <div className="px-4 py-2.5 text-sm flex items-center justify-between gap-3" style={{ background: '#FFFBEB', borderBottom: '1px solid #FDE68A' }}>
            <span className="text-amber-700">
              <strong>Approaching sync limit</strong> — {billing.subscription.syncs_used} of {billing.syncLimit} agreement syncs used this month.
            </span>
            <Link href="/settings/billing" className="flex-shrink-0 text-xs font-semibold text-amber-700 underline hover:text-amber-900">
              View plan →
            </Link>
          </div>
        )}
        {org && (
          <OnboardingBanner orgName={org.orgName} orgId={org.orgId} />
        )}
        {children}
      </main>
    </div>
  )
}
