import { Sidebar } from '@/components/dashboard/Sidebar'
import { OnboardingBanner } from '@/components/dashboard/OnboardingBanner'
import { getActiveOrg } from '@/lib/org'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
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
