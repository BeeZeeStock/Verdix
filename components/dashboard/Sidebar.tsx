'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { useState, useEffect } from 'react'
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

const settingsItems = [
  { href: '/setup', icon: 'ti-rocket', label: 'Setup guide', exact: true },
  { href: '/settings', icon: 'ti-settings', label: 'Settings', exact: true },
  { href: '/settings/integrations', icon: 'ti-plug-connected', label: 'Integrations', exact: false },
  { href: '/settings/team', icon: 'ti-users', label: 'Team', exact: false },
  { href: '/settings/learned-rules', icon: 'ti-brain', label: 'Learned rules', exact: false },
]

function NavContent({ onNav }: { onNav?: () => void }) {
  const pathname = usePathname()
  const { data: session } = useSession()

  const userName  = session?.user?.name  ?? session?.user?.email?.split('@')[0] ?? 'Account'
  const userEmail = session?.user?.email ?? ''
  const initials  = userName.slice(0, 1).toUpperCase()

  const isActive = (href: string, exact = false) => {
    if (exact || href === '/dashboard') return pathname === href
    return pathname.startsWith(href)
  }

  const linkCls = (active: boolean) => ({
    background: active ? '#EAF3DE' : 'transparent',
    color: active ? '#1A3D2B' : '#6B6660',
    fontWeight: active ? 500 : 400,
  } as React.CSSProperties)

  return (
    <div className="flex flex-col h-full" style={{ background: '#FAFAF8' }}>
      {/* Logo — only shown in desktop sidebar */}
      <div className="hidden md:flex items-center gap-3 px-4 py-4 border-b border-forest/10">
        <VerdixLogo size={26} />
        <span className="font-sans font-semibold text-[15px]" style={{ color: '#1A3D2B', letterSpacing: '0.02em' }}>Verdix</span>
      </div>

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
                onClick={onNav}
                className="flex items-center gap-2.5 mx-2 px-3 py-2 rounded-lg text-sm transition-colors"
                style={linkCls(isActive(item.href))}
              >
                <i className={`ti ${item.icon}`} style={{ fontSize: 16 }} />
                {item.label}
              </Link>
            ))}
          </div>
        ))}

        <div className="mb-1 mt-2">
          <div className="px-4 pt-3 pb-1 text-xs font-medium uppercase tracking-widest" style={{ color: '#9CA3AF', letterSpacing: '.07em' }}>Account</div>
          {settingsItems.map(item => (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNav}
              className="flex items-center gap-2.5 mx-2 px-3 py-2 rounded-lg text-sm transition-colors"
              style={linkCls(isActive(item.href, item.exact))}
            >
              <i className={`ti ${item.icon}`} style={{ fontSize: 16 }} />
              {item.label}
            </Link>
          ))}
        </div>
      </nav>

      <div className="border-t border-forest/10 px-4 py-3 flex items-center gap-3">
        <div className="w-7 h-7 rounded-full bg-forest flex items-center justify-center flex-shrink-0 text-white text-xs font-semibold">
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
    </div>
  )
}

export function Sidebar() {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()
  const { data: session } = useSession()
  const userName = session?.user?.name ?? session?.user?.email?.split('@')[0] ?? 'Account'
  const initials = userName.slice(0, 1).toUpperCase()

  useEffect(() => { setOpen(false) }, [pathname])

  return (
    <>
      {/* ── Desktop sidebar ─────────────────────────────────────── */}
      <aside className="hidden md:flex w-56 flex-shrink-0 border-r border-forest/10 h-screen sticky top-0 flex-col" style={{ background: '#FAFAF8' }}>
        <NavContent />
      </aside>

      {/* ── Mobile: top bar ─────────────────────────────────────── */}
      <header className="md:hidden flex items-center justify-between px-4 py-3 border-b border-forest/10 sticky top-0 z-30" style={{ background: '#FAFAF8' }}>
        <div className="flex items-center gap-2.5">
          <VerdixLogo size={22} />
          <span className="font-sans font-semibold text-[14px]" style={{ color: '#1A3D2B' }}>Verdix</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-full bg-forest flex items-center justify-center text-white text-xs font-semibold">
            {initials}
          </div>
          <button onClick={() => setOpen(true)} className="p-1.5 rounded-lg hover:bg-forest/5 transition-colors" aria-label="Open menu">
            <i className="ti ti-menu-2" style={{ fontSize: 20, color: '#1A3D2B' }} />
          </button>
        </div>
      </header>

      {/* ── Mobile: drawer backdrop ──────────────────────────────── */}
      {open && (
        <div
          className="fixed inset-0 bg-black/40 z-40 md:hidden"
          onClick={() => setOpen(false)}
        />
      )}

      {/* ── Mobile: slide-out drawer ─────────────────────────────── */}
      <div
        className={`fixed top-0 left-0 h-full w-72 z-50 md:hidden shadow-xl transition-transform duration-300 ease-in-out ${open ? 'translate-x-0' : '-translate-x-full'}`}
        style={{ background: '#FAFAF8' }}
      >
        {/* Drawer header */}
        <div className="flex items-center justify-between px-4 py-4 border-b border-forest/10">
          <div className="flex items-center gap-2.5">
            <VerdixLogo size={24} />
            <span className="font-sans font-semibold text-[15px]" style={{ color: '#1A3D2B' }}>Verdix</span>
          </div>
          <button onClick={() => setOpen(false)} className="p-1.5 rounded-lg hover:bg-forest/5" aria-label="Close menu">
            <i className="ti ti-x" style={{ fontSize: 18, color: '#6B6660' }} />
          </button>
        </div>
        <div className="h-[calc(100%-57px)] overflow-y-auto">
          <NavContent onNav={() => setOpen(false)} />
        </div>
      </div>
    </>
  )
}
