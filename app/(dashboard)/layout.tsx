import { redirect } from 'next/navigation'
import { Sidebar } from '@/components/dashboard/Sidebar'
import { OnboardingBanner } from '@/components/dashboard/OnboardingBanner'
import { getActiveOrg } from '@/lib/org'
import { auth } from '@/lib/auth'
import { supabaseServer } from '@/lib/supabase'
import { TERMS_VERSION } from '@/lib/terms-version'

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

  return (
    <div className="flex flex-col md:flex-row md:h-screen bg-cream">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        {org && (
          <OnboardingBanner orgName={org.orgName} orgId={org.orgId} />
        )}
        {children}
      </main>
    </div>
  )
}
