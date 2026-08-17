import Link from 'next/link'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { VerdixLogo } from '@/components/VerdixLogo'

export default async function NoAccessPage() {
  const session = await auth()
  if (!session?.user?.email) redirect('/login')

  return (
    <div className="min-h-screen bg-cream flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="bg-white border border-forest/10 rounded-2xl p-8 shadow-sm text-center">
          <div className="flex flex-col items-center mb-6">
            <VerdixLogo size={36} />
            <h1 className="font-display font-light text-ink text-2xl mt-4 mb-1">Invitation only</h1>
            <p className="text-stone text-sm">
              Verdix is currently invite-only. <span className="text-ink font-medium">{session.user.email}</span> doesn&apos;t have access to an organisation yet.
            </p>
          </div>

          <p className="text-xs text-stone leading-relaxed mb-6">
            If you believe this is a mistake, contact your Verdix administrator to request an invitation.
          </p>

          <Link
            href="/signout"
            className="inline-block w-full bg-forest text-white rounded-xl px-4 py-3 text-sm font-medium hover:bg-sage transition-colors"
          >
            Sign out and try a different account →
          </Link>
        </div>
      </div>
    </div>
  )
}
