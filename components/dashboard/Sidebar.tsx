'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { VerdixLogo } from '@/components/VerdixLogo'

const navSections = [
  {
    label: 'Insights',
    items: [
      { href: '/dashboard', icon: 'ti-layout-dashboard', label: 'Dashboard' },
      { href: '/dashboard/trends', icon: 'ti-chart-line', label: 'Leakage trends' },
      { href: '/dashboard/contract-trends', icon: 'ti-file-certificate', label: 'Contract ARR' },
      { href: '/dashboard/partner-trends', icon: 'ti-chart-bar', label: 'Partner trends' },
    ],
  },
  {
    label: 'Verification',
    items: [
      { href: '/verify', icon: 'ti-file-check', label: 'Billing checks' },
      { href: '/verify/new', icon: 'ti-plus', label: 'New verification' },
    ],
  },
  {
    label: 'Auto-configure',
    items: [
      { href: '/configure', icon: 'ti-bolt', label: 'New contracts' },
      { href: '/configure/new', icon: 'ti-plus', label: 'Upload contract' },
    ],
  },
  {
    label: 'Partner Recon',
    items: [
      { href: '/partner', icon: 'ti-receipt', label: 'Partner checks' },
      { href: '/partner/new', icon: 'ti-plus', label: 'New reconciliation' },
    ],
  },
]

export function Sidebar() {
  const pathname = usePathname()
  const { data: session } = useSession()

  const userName  = session?.user?.name  ?? session?.user?.email?.split('@')[0] ?? 'Account'
  const userEmail = session?.user?.email ?? ''
  const initials  = userName.slice(0, 1).toUpperCase()

  const isActive = (href: string) => {
    if (href === '/dashboard') return pathname === '/dashboard'
    return pathname.startsWith(href)
  }

  return (
    <aside className="w-56 flex-shrink-0 border-r border-forest/10 h-screen sticky top-0 flex flex-col" style={{ background: '#FAFAF8' }}>
      {/* Logo */}
      <div className="flex items-center gap-3 px-4 py-4 border-b border-forest/10">
        <VerdixLogo size={26} />
        <span className="font-sans font-semibold text-[15px]" style={{ color: '#1A3D2B', letterSpacing: '0.02em' }}>Verdix</span>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-3">
        {navSections.map(section => (
          <div key={section.label} className="mb-1">
            <div className="px-4 pt-3 pb-1 text-xs font-medium uppercase tracking-widest" style={{ color: '#9CA3AF', letterSpacing: '.07em' }}>
              {section.label}
            </div>
            {section.items.map(item => (
              <Link
                key={item.href}
                href={item.href}
                className="flex items-center gap-2.5 mx-2 px-3 py-1.5 rounded-lg text-sm transition-colors"
                style={{
                  background: isActive(item.href) ? '#EAF3DE' : 'transparent',
                  color: isActive(item.href) ? '#1A3D2B' : '#6B6660',
                  fontWeight: isActive(item.href) ? 500 : 400,
                }}
              >
                <i className={`ti ${item.icon}`} style={{ fontSize: 14 }} />
                {item.label}
              </Link>
            ))}
          </div>
        ))}

        {/* Settings */}
        <div className="mb-1 mt-2">
          <div className="px-4 pt-3 pb-1 text-xs font-medium uppercase tracking-widest" style={{ color: '#9CA3AF', letterSpacing: '.07em' }}>Settings</div>
          <Link href="/settings"
            className="flex items-center gap-2.5 mx-2 px-3 py-1.5 rounded-lg text-sm transition-colors"
            style={{ background: isActive('/settings') && !pathname.startsWith('/settings/') ? '#EAF3DE' : 'transparent', color: isActive('/settings') && !pathname.startsWith('/settings/') ? '#1A3D2B' : '#6B6660' }}
          >
            <i className="ti ti-settings" style={{ fontSize: 14 }} /> Settings
          </Link>
          <Link href="/settings/team"
            className="flex items-center gap-2.5 mx-2 px-3 py-1.5 rounded-lg text-sm transition-colors"
            style={{ background: pathname.startsWith('/settings/team') ? '#EAF3DE' : 'transparent', color: pathname.startsWith('/settings/team') ? '#1A3D2B' : '#6B6660', fontWeight: pathname.startsWith('/settings/team') ? 500 : 400 }}
          >
            <i className="ti ti-users" style={{ fontSize: 14 }} /> Team
          </Link>
          <Link href="/settings/learned-rules"
            className="flex items-center gap-2.5 mx-2 px-3 py-1.5 rounded-lg text-sm transition-colors"
            style={{ background: pathname.startsWith('/settings/learned-rules') ? '#EAF3DE' : 'transparent', color: pathname.startsWith('/settings/learned-rules') ? '#1A3D2B' : '#6B6660', fontWeight: pathname.startsWith('/settings/learned-rules') ? 500 : 400 }}
          >
            <i className="ti ti-brain" style={{ fontSize: 14 }} /> Learned rules
          </Link>
        </div>
      </nav>

      {/* User */}
      <div className="border-t border-forest/10 px-4 py-3 flex items-center gap-3">
        <div className="w-7 h-7 rounded-full bg-forest flex items-center justify-center flex-shrink-0 text-white text-xs font-semibold flex-shrink-0">
          {initials}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-ink truncate">{userName}</div>
          {userEmail && <div className="text-xs text-stone truncate">{userEmail}</div>}
        </div>
        <a href="/api/auth/signout?callbackUrl=/" className="text-stone hover:text-forest transition-colors">
          <i className="ti ti-logout" style={{ fontSize: 14 }} />
        </a>
      </div>
    </aside>
  )
}
