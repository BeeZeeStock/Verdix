'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { VerdixLogo } from '@/components/VerdixLogo'

/* ─────────────── NAV ─────────────── */
function Nav() {
  const [shadow, setShadow] = useState(false)
  useEffect(() => {
    const fn = () => setShadow(window.scrollY > 16)
    window.addEventListener('scroll', fn)
    return () => window.removeEventListener('scroll', fn)
  }, [])
  return (
    <nav
      id="nav"
      className="sticky top-0 z-50 bg-cream/95 backdrop-blur-md border-b border-forest/10 px-6 py-3.5"
      style={{ boxShadow: shadow ? '0 1px 8px rgba(26,61,43,.08)' : 'none' }}
    >
      <div className="max-w-6xl mx-auto flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <VerdixLogo size={28} />
          <span className="font-sans font-semibold text-[16px]" style={{ color: '#1A3D2B', letterSpacing: '0.02em' }}>Verdix</span>
        </div>
        <div className="hidden md:flex items-center gap-8 text-sm font-medium text-stone">
          <a href="#verify" className="hover:text-forest transition-colors">Billing verification</a>
          <a href="#configure" className="hover:text-forest transition-colors">Auto-configure</a>
          <a href="#partner" className="hover:text-forest transition-colors">Partner reconciliation</a>
          <a href="#security" className="hover:text-forest transition-colors">Security</a>
          <a href="#pricing" className="hover:text-forest transition-colors">Pricing</a>
          <Link href="/login" className="hover:text-forest transition-colors">Sign in</Link>
        </div>
        <Link href="/signup" className="bg-forest text-white text-sm font-medium px-5 py-2.5 rounded-xl hover:bg-sage transition-colors shadow-sm">
          Start free check →
        </Link>
      </div>
    </nav>
  )
}

/* ─────────────── HERO ─────────────── */
function Hero() {
  return (
    <section className="relative px-6 pt-12 md:pt-20 pb-12 md:pb-16 overflow-hidden">
      <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 80% 60% at 50% -10%,#D4EAD9 0%,transparent 70%)' }} />
      <div className="max-w-4xl mx-auto text-center relative">
        <div className="inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-xs font-medium mb-8" style={{ color: '#27500A', background: '#EAF3DE', border: '1px solid #C0DD97' }}>
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#27500A' }} />
          Revenue intelligence for B2B SaaS
        </div>
        <h1 className="font-display font-light text-ink leading-tight mb-5" style={{ fontSize: 'clamp(2.2rem,4.5vw,3.4rem)' }}>
          Is your billing configured<br /><span className="text-forest">exactly as your contracts say?</span>
        </h1>
        <p className="text-stone text-lg max-w-xl mx-auto leading-relaxed mb-10">
          Verdix reads your signed contracts and checks your billing setup against them — surfacing mismatches before they cost you revenue. Then automates the setup for every new deal.
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-4">
          <Link href="/signup" className="w-full sm:w-auto bg-forest text-white font-medium px-8 py-4 rounded-xl hover:bg-sage transition-colors shadow-md text-center">
            Check your billing accuracy →
          </Link>
          <a href="#how" className="w-full sm:w-auto bg-white border border-sage text-sage font-medium px-8 py-4 rounded-xl hover:bg-mint transition-colors text-center">
            See how it works
          </a>
        </div>
        <p className="text-center mb-10" style={{ fontSize: 11, color: '#6B6660' }}>
          Billing platforms supported: <span style={{ color: '#1A3D2B', fontWeight: 500 }}>Stripe</span>
          <span style={{ color: '#9CA3AF' }}> · Others coming soon · </span><span style={{ color: '#6B6660' }}>available on request</span>
        </p>
        <div className="grid grid-cols-3 gap-3 max-w-2xl mx-auto">
          <div className="bg-white border border-forest/10 rounded-2xl p-5 text-center">
            <div className="font-mono font-medium text-2xl mb-1" style={{ color: '#27500A' }}>3–9%</div>
            <div className="text-stone text-xs leading-snug">Average ARR leakage in B2B SaaS</div>
            <div className="mt-1.5" style={{ fontSize: 10, color: '#9CA3AF' }}>MGI Research / EY</div>
          </div>
          <div className="bg-white border border-forest/10 rounded-2xl p-5 text-center">
            <div className="font-mono font-medium text-2xl mb-1" style={{ color: '#27500A' }}>$9B+</div>
            <div className="text-stone text-xs leading-snug">Lost annually across the industry</div>
            <div className="mt-1.5" style={{ fontSize: 10, color: '#9CA3AF' }}>$299B market × 3% floor</div>
          </div>
          <div className="bg-white border border-forest/10 rounded-2xl p-5 text-center">
            <div className="font-mono font-medium text-2xl mb-1" style={{ color: '#27500A' }}>73%</div>
            <div className="text-stone text-xs leading-snug">Companies with no automated detection</div>
            <div className="mt-1.5" style={{ fontSize: 10, color: '#9CA3AF' }}>BCG, 2020</div>
          </div>
        </div>
      </div>
    </section>
  )
}

/* ─────────────── BILLING VERIFICATION SECTION ─────────────── */
function BillingVerificationSection() {
  return (
    <section id="verify" className="px-6 py-24 border-t border-forest/8">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-12 max-w-2xl mx-auto">
          <div className="text-xs font-medium uppercase tracking-widest text-sage mb-3">Billing verification</div>
          <h2 className="font-display font-light text-ink text-3xl leading-tight mb-4">Check every billing setup against the signed contract — before the first invoice goes out</h2>
          <p className="text-stone leading-relaxed mb-6">Upload your signed contracts and billing export. Verdix compares every commercial term against what&apos;s actually configured in your billing platform — wrong prices, expired discounts still running, overage tiers never set up. Find it. Fix it. One click.</p>
          <div className="flex flex-wrap justify-center gap-x-8 gap-y-2">
            {['Price escalators verified', 'Discount expiry enforced', 'Overage tiers checked', 'One-click API fix'].map(f => (
              <span key={f} className="flex items-center gap-2 text-sm text-stone">
                <div className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: '#EAF3DE', border: '1px solid #C0DD97' }}>
                  <i className="ti ti-check" style={{ fontSize: 10, color: '#27500A' }} />
                </div>
                {f}
              </span>
            ))}
          </div>
        </div>

        {/* Dashboard mockup */}
        <div className="overflow-x-auto -mx-6 px-6 md:mx-0 md:px-0">
        <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden shadow-sm mx-auto" style={{ fontSize: 12, maxWidth: 860, minWidth: 640 }}>
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-forest/8" style={{ background: '#F5F3EE' }}>
            <div className="tl-r" /><div className="tl-y" /><div className="tl-g" />
            <span className="font-mono text-xs text-stone ml-2">verdix — revenue leakage</span>
          </div>
          <div className="flex" style={{ minHeight: 420 }}>
            {/* Sidebar */}
            <div className="border-r border-forest/8 py-3 flex-shrink-0" style={{ width: 150, background: '#FAFAF8' }}>
              <div className="flex items-center gap-2 px-3 pb-3 mb-1 border-b border-forest/8">
                <VerdixLogo size={20} />
                <span className="font-sans font-semibold" style={{ fontSize: 11, color: '#1A3D2B', letterSpacing: '0.02em' }}>Verdix</span>
              </div>
              <div className="px-3 pt-2 pb-1" style={{ fontSize: 9, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '.07em', color: '#9CA3AF' }}>Insights</div>
              <div className="flex items-center gap-2 px-3 py-1.5 mx-1 rounded-lg" style={{ background: '#EAF3DE' }}>
                <i className="ti ti-layout-dashboard" style={{ fontSize: 12, color: '#1A3D2B' }} />
                <span style={{ fontSize: 11, fontWeight: 500, color: '#1A3D2B' }}>Dashboard</span>
              </div>
              <div className="flex items-center gap-2 px-3 py-1.5 text-stone"><i className="ti ti-chart-line" style={{ fontSize: 12 }} /><span style={{ fontSize: 11 }}>Leakage trends</span></div>
              <div className="px-3 pt-3 pb-1" style={{ fontSize: 9, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '.07em', color: '#9CA3AF' }}>Verification</div>
              <div className="flex items-center gap-2 px-3 py-1.5 text-stone"><i className="ti ti-file-check" style={{ fontSize: 12 }} /><span style={{ fontSize: 11 }}>Billing checks</span></div>
              <div className="flex items-center gap-2 px-3 py-1.5 text-stone"><i className="ti ti-alert-triangle" style={{ fontSize: 12 }} /><span style={{ fontSize: 11 }}>Findings</span></div>
              <div className="flex items-center gap-2 px-3 py-1.5 text-stone"><i className="ti ti-users" style={{ fontSize: 12 }} /><span style={{ fontSize: 11 }}>Customers</span></div>
              <div className="px-3 pt-3 pb-1" style={{ fontSize: 9, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '.07em', color: '#9CA3AF' }}>Auto-configure</div>
              <div className="flex items-center gap-2 px-3 py-1.5 text-stone"><i className="ti ti-bolt" style={{ fontSize: 12 }} /><span style={{ fontSize: 11 }}>New contracts</span></div>
              <div className="flex items-center gap-2 px-3 py-1.5 text-stone"><i className="ti ti-history" style={{ fontSize: 12 }} /><span style={{ fontSize: 11 }}>Audit log</span></div>
            </div>
            {/* Main */}
            <div className="flex-1 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-forest/8">
                <span className="font-medium text-ink" style={{ fontSize: 15 }}>Revenue leakage</span>
                <div className="flex items-center gap-2">
                  <span className="border border-forest/15 rounded-lg px-2.5 py-1 text-stone" style={{ fontSize: 10 }}>Last 12 months</span>
                  <div className="w-6 h-6 bg-forest rounded flex items-center justify-center"><i className="ti ti-chart-bar text-white" style={{ fontSize: 11 }} /></div>
                </div>
              </div>
              <div className="flex border-b border-forest/8 px-4">
                <div className="py-2 px-3 text-forest border-b-2 border-forest font-medium" style={{ fontSize: 11 }}>Leakage overview</div>
                <div className="py-2 px-3 text-stone" style={{ fontSize: 11 }}>By customer</div>
                <div className="py-2 px-3 text-stone" style={{ fontSize: 11 }}>By type</div>
              </div>
              <div className="p-3 space-y-3">
                {/* Metric cards */}
                <div className="grid grid-cols-4 gap-2">
                  {[
                    { label: 'Total leakage found', val: '$80,712', sub: '↓ 3 contracts audited', sc: '#A32D2D', mono: true },
                    { label: 'Open findings', val: '14', sub: '3 critical · 11 high', sc: '#A32D2D', mono: false },
                    { label: 'Recovered (fixed)', val: '$7,580', sub: '↑ 2 fixes applied', sc: '#27500A', mono: true },
                    { label: 'Billing accuracy', val: '91%', sub: '↑ +4% this month', sc: '#27500A', mono: false },
                  ].map(m => (
                    <div key={m.label} className="rounded-xl p-2.5" style={{ background: '#F5F3EE' }}>
                      <div style={{ fontSize: 9, color: '#6B6660', marginBottom: 3 }}>{m.label}</div>
                      <div className={m.mono ? 'font-mono' : ''} style={{ fontSize: 16, fontWeight: 500, color: m.label === 'Open findings' || m.label === 'Billing accuracy' ? '#1C1917' : m.sc }}>{m.val}</div>
                      <div style={{ fontSize: 9, color: m.sc }}>{m.sub}</div>
                    </div>
                  ))}
                </div>
                {/* Two col */}
                <div className="grid grid-cols-2 gap-2">
                  {/* Bar chart */}
                  <div className="border border-forest/8 rounded-xl p-3" style={{ background: '#fff' }}>
                    <div style={{ fontSize: 11, fontWeight: 500, color: '#1C1917', marginBottom: 2 }}>Leakage by month</div>
                    <div style={{ fontSize: 9, color: '#6B6660', marginBottom: 8 }}>Contracted vs billed gap over time</div>
                    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 52, marginBottom: 6 }}>
                      {[
                        { h: 18, c: '#EAF3DE', l: 'Jan' }, { h: 20, c: '#EAF3DE', l: 'Feb' }, { h: 16, c: '#EAF3DE', l: 'Mar' },
                        { h: 22, c: '#EAF3DE', l: 'Apr' }, { h: 18, c: '#EAF3DE', l: 'May' }, { h: 26, c: '#FAEEDA', l: 'Jun' },
                        { h: 30, c: '#FAEEDA', l: 'Jul' }, { h: 34, c: '#FCEBEB', l: 'Aug' }, { h: 38, c: '#FCEBEB', l: 'Sep' },
                        { h: 42, c: '#FCEBEB', l: 'Oct' }, { h: 52, c: '#E24B4A', l: 'Nov' }, { h: 36, c: '#EAF3DE', l: 'Dec' },
                      ].map(b => (
                        <div key={b.l} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
                          <div style={{ width: '100%', borderRadius: '2px 2px 0 0', height: b.h, background: b.c }} />
                          <div style={{ fontSize: 7, color: '#9CA3AF' }}>{b.l}</div>
                        </div>
                      ))}
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {[['#EAF3DE','#C0DD97','Low'],['#FAEEDA','#FAC775','Medium'],['#FCEBEB','#F09595','High'],['#E24B4A','','Critical']].map(([bg,bd,lbl]) => (
                        <div key={lbl} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 8, color: '#6B6660' }}>
                          <div style={{ width: 8, height: 8, borderRadius: 2, background: bg, border: bd ? `0.5px solid ${bd}` : 'none' }} />
                          {lbl}
                        </div>
                      ))}
                    </div>
                  </div>
                  {/* At-risk */}
                  <div className="border border-forest/8 rounded-xl p-3" style={{ background: '#fff' }}>
                    <div style={{ fontSize: 11, fontWeight: 500, color: '#1C1917', marginBottom: 2 }}>At-risk customers</div>
                    <div style={{ fontSize: 9, color: '#6B6660', marginBottom: 8 }}>By total leakage amount</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <svg width="64" height="64" viewBox="0 0 64 64">
                        <circle cx="32" cy="32" r="24" fill="none" stroke="#F1EFE8" strokeWidth="10" />
                        <circle cx="32" cy="32" r="24" fill="none" stroke="#E24B4A" strokeWidth="10" strokeDasharray="94 57" strokeDashoffset="18" strokeLinecap="round" />
                        <circle cx="32" cy="32" r="24" fill="none" stroke="#FAC775" strokeWidth="10" strokeDasharray="27 124" strokeDashoffset="-76" strokeLinecap="round" />
                        <circle cx="32" cy="32" r="24" fill="none" stroke="#C0DD97" strokeWidth="10" strokeDasharray="18 133" strokeDashoffset="-103" strokeLinecap="round" />
                        <text x="32" y="29" textAnchor="middle" fontSize="7" fill="#6B6660">Total</text>
                        <text x="32" y="39" textAnchor="middle" fontSize="9" fontWeight="500" fill="#1C1917">$80.7K</text>
                      </svg>
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {[
                          { dot: '#E24B4A', name: 'Northgate Capital', val: '$73,132', vc: '#A32D2D' },
                          { dot: '#FAC775', name: 'Meridian Health', val: '$7,040', vc: '#1C1917' },
                          { dot: '#C0DD97', name: 'Acme Corp', val: '$540', vc: '#1C1917' },
                        ].map(r => (
                          <div key={r.name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                              <div style={{ width: 7, height: 7, borderRadius: '50%', background: r.dot, flexShrink: 0 }} />
                              <span style={{ fontSize: 10, color: '#1C1917' }}>{r.name}</span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                              <span className="font-mono" style={{ fontSize: 10, color: r.vc }}>{r.val}</span>
                              <button style={{ fontSize: 9, padding: '2px 8px', background: '#EAF3DE', border: '0.5px solid #C0DD97', color: '#27500A', borderRadius: 6 }}>Fix</button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
                {/* Findings table */}
                <div className="border border-forest/8 rounded-xl overflow-hidden" style={{ background: '#fff' }}>
                  <div className="flex items-center justify-between px-3 py-2 border-b border-forest/8">
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 500, color: '#1C1917' }}>Open findings</div>
                      <div style={{ fontSize: 9, color: '#6B6660' }}>Billing mismatches requiring action</div>
                    </div>
                    <span style={{ fontSize: 9, padding: '2px 8px', background: '#FCEBEB', border: '0.5px solid #F09595', color: '#791F1F', borderRadius: 999, fontWeight: 500 }}>3 critical</span>
                  </div>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ borderBottom: '0.5px solid rgba(26,61,43,0.08)' }}>
                        {['Customer','Type','Contracted','Billed','Leakage',''].map(h => (
                          <th key={h} style={{ fontSize: 9, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '.06em', color: '#6B6660', padding: '6px 8px', textAlign: h === 'Leakage' ? 'right' : 'left' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        { name: 'Northgate Capital', ref: 'CLR-2024-0078', type: 'Overages not set up', tc: '#791F1F', cont: '$0.012/call', billed: '$0.00', leak: '$73,132', btn: '#FCEBEB', btb: '#F09595', btc: '#791F1F', btnTxt: 'Fix now' },
                        { name: 'Meridian Health', ref: 'CLR-2024-0031', type: 'Discount overhang', tc: '#633806', cont: '$3,200/mo', billed: '$2,560/mo', leak: '$7,040', btn: '#EAF3DE', btb: '#C0DD97', btc: '#27500A', btnTxt: 'Fix' },
                        { name: 'Acme Corp', ref: 'CLR-2024-0042', type: 'Escalator miss', tc: '#633806', cont: '$4,635/mo', billed: '$4,500/mo', leak: '$540', btn: '#EAF3DE', btb: '#C0DD97', btc: '#27500A', btnTxt: 'Fix' },
                      ].map((row, i) => (
                        <tr key={row.name} className="ui-tr" style={{ borderBottom: i < 2 ? '0.5px solid rgba(26,61,43,0.06)' : 'none' }}>
                          <td style={{ padding: '7px 10px' }}>
                            <div style={{ fontSize: 10, fontWeight: 500, color: '#1C1917' }}>{row.name}</div>
                            <div className="font-mono" style={{ fontSize: 8, color: '#6B6660' }}>{row.ref}</div>
                          </td>
                          <td style={{ padding: '7px 8px', fontSize: 10, color: row.tc, fontWeight: 500 }}>{row.type}</td>
                          <td style={{ padding: '7px 8px', fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: '#27500A' }}>{row.cont}</td>
                          <td style={{ padding: '7px 8px', fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: '#6B6660', textDecoration: 'line-through' }}>{row.billed}</td>
                          <td style={{ padding: '7px 8px', fontFamily: "'JetBrains Mono',monospace", fontSize: 11, fontWeight: 500, color: '#791F1F', textAlign: 'right' }}>{row.leak}</td>
                          <td style={{ padding: '7px 8px' }}>
                            <button style={{ fontSize: 9, padding: '3px 8px', background: row.btn, border: `0.5px solid ${row.btb}`, color: row.btc, borderRadius: 6, whiteSpace: 'nowrap' }}>{row.btnTxt}</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </div>
        </div>
      </div>
    </section>
  )
}

/* ─────────────── AUTO-CONFIGURE SECTION ─────────────── */
function AutoConfigureSection() {
  return (
    <section id="configure" className="px-6 py-24 bg-white border-t border-b border-forest/8">
      <div className="max-w-6xl mx-auto">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
          {/* HITL Mockup */}
          <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden shadow-sm order-2 lg:order-1" style={{ fontSize: 12 }}>
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-forest/8" style={{ background: '#F5F3EE' }}>
              <div className="tl-r" /><div className="tl-y" /><div className="tl-g" />
              <span className="font-mono text-xs text-stone ml-2">verdix — new contract · Northgate Capital</span>
            </div>
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-forest/8">
              <div style={{ fontSize: 12, fontWeight: 500, color: '#1C1917' }}>Configure billing from signed contract</div>
              <span style={{ fontSize: 9, padding: '2px 8px', background: '#FAEEDA', border: '0.5px solid #FAC775', color: '#633806', borderRadius: 999, fontWeight: 500 }}>3 items need review</span>
            </div>
            <div className="grid grid-cols-2" style={{ minHeight: 420 }}>
              {/* Left PDF panel */}
              <div className="border-r border-forest/8 p-5 overflow-y-auto" style={{ background: '#FAFAF8', maxHeight: 460 }}>
                <div style={{ fontSize: 11, color: '#9CA3AF', marginBottom: 14 }}>Ardoq AS · Enterprise MSA · Exhibit A</div>
                {[
                  { sec: '§3.1 Platform subscription', val: '$18,500 / month', sub: '50 named users · Feb 1, 2024 – Jan 31, 2025' },
                  { sec: '§3.2 Annual escalator', val: '3% fixed · from Feb 2025', sub: 'Year 2: $19,055 / month' },
                  { sec: '§3.3 Additional seats', val: '$320 / user / month', sub: 'Above 50 seats · billed monthly in arrears' },
                  { sec: '§3.4 Introductory discount', val: '15% off base fee', sub: 'Feb – Jul 2024 · expires Aug 1, 2024' },
                  { sec: '§3.5 Onboarding', val: '$12,000 one-time', sub: 'Due at execution · ref SOW-2024-01' },
                ].map(c => (
                  <div key={c.sec} style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 10, color: '#9CA3AF', marginBottom: 5 }}>{c.sec}</div>
                    <div style={{ padding: '10px 12px', background: '#fff', borderRadius: 10, border: '0.5px solid rgba(26,61,43,0.08)' }}>
                      <div style={{ fontSize: 12, fontWeight: 500, color: '#1C1917', marginBottom: 2 }}>{c.val}</div>
                      <div style={{ fontSize: 11, color: '#6B6660' }}>{c.sub}</div>
                    </div>
                  </div>
                ))}
              </div>
              {/* Right config panel */}
              <div className="p-5 flex flex-col" style={{ overflowY: 'auto', maxHeight: 460 }}>
                <div style={{ fontSize: 11, color: '#9CA3AF', marginBottom: 14 }}>Proposed billing configuration</div>
                {[
                  { name: 'Platform subscription', val: '$18,500 / month · 50 users · recurring', conf: 97, border: 'rgba(26,61,43,0.08)', cc: '#27500A', icon: 'ti-check', warn: '' },
                  { name: 'Price escalator · Year 2', val: '$19,055 / month · from Feb 1, 2025', conf: 96, border: 'rgba(26,61,43,0.08)', cc: '#27500A', icon: 'ti-check', warn: '' },
                  { name: 'Additional named users', val: '$320 / user / month · above 50 seats', conf: 74, border: '#FAC775', cc: '#BA7517', icon: 'ti-alert-triangle', warn: 'Verify billing cadence — §6 reference unclear' },
                  { name: 'Introductory discount · 15%', val: '–$2,775/mo · Feb – Jul 2024 · expires Aug 1', conf: 99, border: 'rgba(26,61,43,0.08)', cc: '#27500A', icon: 'ti-check', warn: '' },
                  { name: 'Onboarding · one-time', val: '$12,000 · ref SOW-2024-01', conf: 61, border: '#F09595', cc: '#A32D2D', icon: 'ti-alert-circle', warn: 'SOW not provided — verify before billing' },
                ].map(item => (
                  <div key={item.name} style={{ marginBottom: 8, padding: '10px 12px', background: '#fff', borderRadius: 10, border: `0.5px solid ${item.border}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                      <div style={{ fontSize: 12, fontWeight: 500, color: '#1C1917' }}>{item.name}</div>
                      <div style={{ fontSize: 10, color: item.cc, display: 'flex', alignItems: 'center', gap: 3 }}>
                        <i className={`ti ${item.icon}`} style={{ fontSize: 10 }} /> {item.conf}%
                      </div>
                    </div>
                    <div className="font-mono" style={{ fontSize: 11, color: '#6B6660' }}>{item.val}</div>
                    {item.warn && <div style={{ fontSize: 10, color: item.cc, marginTop: 4 }}>{item.warn}</div>}
                  </div>
                ))}
                <div style={{ padding: '12px 14px', borderRadius: 10, background: '#F5F3EE', display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                  <div>
                    <div style={{ fontSize: 10, color: '#6B6660', marginBottom: 1 }}>Calculated Year 1 TCV</div>
                    <div style={{ fontSize: 9, color: '#9CA3AF' }}>Discount months included · onboarding separate</div>
                  </div>
                  <div className="font-mono" style={{ fontSize: 15, fontWeight: 500, color: '#1A3D2B' }}>$200,325</div>
                </div>
                <button className="w-full bg-forest text-white font-medium py-3 rounded-xl hover:bg-sage transition-colors" style={{ fontSize: 13 }}>
                  Approve &amp; configure billing →
                </button>
              </div>
            </div>
          </div>
          {/* Copy */}
          <div className="order-1 lg:order-2">
            <div className="text-xs font-medium uppercase tracking-widest text-sage mb-3">Auto-configure</div>
            <h2 className="font-display font-light text-ink text-3xl leading-tight mb-4">Every new deal — billing configured automatically in 60 seconds</h2>
            <p className="text-stone leading-relaxed mb-8">Connect your CRM. The moment a deal is marked Closed Won, Verdix reads every clause, proposes the exact billing configuration, and sets up your billing platform after your 60-second review. No manual translation. No errors.</p>
            <ul className="space-y-3">
              {[
                'CRM webhook triggers extraction the moment a deal is Closed Won',
                'AI extracts prices, tiers, escalators, and discount terms',
                'Human reviews proposed config with PDF source side-by-side',
                'Billing platform configured — zero manual typing, full audit trail',
              ].map(item => (
                <li key={item} className="flex items-start gap-3 text-sm text-stone">
                  <div className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5" style={{ background: '#EAF3DE', border: '1px solid #C0DD97' }}>
                    <i className="ti ti-check" style={{ fontSize: 10, color: '#27500A' }} />
                  </div>
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  )
}

/* ─────────────── PARTNER RECONCILIATION SECTION ─────────────── */
function PartnerReconciliationSection() {
  return (
    <section id="partner" className="px-6 py-24 border-t border-forest/8" style={{ background: '#FAFAF6' }}>
      <div className="max-w-6xl mx-auto">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
          <div>
            <div className="inline-flex items-center gap-2 mb-4" style={{ background: '#EAF3DE', border: '0.5px solid #C0DD97', borderRadius: 999, padding: '4px 12px' }}>
              <span style={{ fontSize: 10, fontWeight: 500, color: '#27500A' }}>NEW MODULE</span>
            </div>
            <div className="text-xs font-medium uppercase tracking-widest text-sage mb-3">Partner reconciliation</div>
            <h2 className="font-display font-light text-ink text-3xl leading-tight mb-4">Validate every partner invoice against your signed agreement — before you pay</h2>
            <p className="text-stone leading-relaxed mb-8">Revenue doesn&apos;t just leak outward. You can also overpay partners, resellers, and suppliers when their invoices don&apos;t match what was agreed. Verdix reads your partner agreements and checks incoming invoices against them — line by line — before you approve payment.</p>
            <ul className="space-y-3">
              {[
                'Verify partner invoices match the agreed commission or fee structure',
                'Catch overbilling — wrong rates, duplicate charges, expired tier prices',
                'Flag invoices for dispute with the exact clause and amount discrepancy',
                'Approve clean invoices with one click — dispute wrong ones with evidence',
              ].map(item => (
                <li key={item} className="flex items-start gap-3 text-sm text-stone">
                  <div className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5" style={{ background: '#EAF3DE', border: '1px solid #C0DD97' }}>
                    <i className="ti ti-check" style={{ fontSize: 10, color: '#27500A' }} />
                  </div>
                  {item}
                </li>
              ))}
            </ul>
          </div>
          {/* Partner recon mockup */}
          <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden shadow-sm" style={{ fontSize: 12 }}>
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-forest/8" style={{ background: '#F5F3EE' }}>
              <div className="tl-r" /><div className="tl-y" /><div className="tl-g" />
              <span className="font-mono text-xs text-stone ml-2">verdix — partner reconciliation · Helios Technologies AB</span>
            </div>
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-forest/8">
              <div style={{ fontSize: 13, fontWeight: 500, color: '#1C1917' }}>Invoice INV-2024-0847 · Nets A/S</div>
              <span style={{ fontSize: 9, padding: '2px 8px', background: '#FAEEDA', border: '0.5px solid #FAC775', color: '#633806', borderRadius: 999, fontWeight: 500 }}>2 discrepancies</span>
            </div>
            <div className="p-5 border-b border-forest/8">
              <div className="grid grid-cols-2 gap-0">
                <div style={{ padding: '0 16px 0 0', borderRight: '0.5px solid rgba(26,61,43,0.08)' }}>
                  <div style={{ fontSize: 18, fontWeight: 500, color: '#1C1917', marginBottom: 16 }}>Partner Agreement</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                    {[
                      ['Partner', 'Nets A/S'], ['Agreement type', 'Payment processing'],
                      ['Invoice ref', 'INV-2024-0847'], ['Invoice date', 'May 31, 2024'],
                      ['Billing to', 'Helios Technologies AB'], ['Due date', 'Jun 30, 2024'],
                    ].map(([lbl, val]) => (
                      <div key={lbl}>
                        <div style={{ fontSize: 11, color: '#9CA3AF', marginBottom: 3 }}>{lbl}</div>
                        <div style={{ fontSize: 13, fontWeight: 500, color: '#1C1917' }}>{val}</div>
                      </div>
                    ))}
                  </div>
                </div>
                <div style={{ padding: '0 0 0 16px' }}>
                  <div style={{ fontSize: 11, color: '#9CA3AF', marginBottom: 10 }}>Discrepancies found</div>
                  <div style={{ marginBottom: 8, padding: '10px 12px', borderRadius: 10, background: '#FAFAF8', border: '0.5px solid rgba(26,61,43,0.08)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 3 }}>
                      <div style={{ fontSize: 11, fontWeight: 500, color: '#1C1917' }}>Wrong tier rate applied</div>
                      <div style={{ fontSize: 11, fontWeight: 500, color: '#BA7517' }}>–€374</div>
                    </div>
                    <div style={{ fontSize: 10, color: '#9CA3AF' }}>Billed at 0.85% · should be Tier 2 rate 0.72% · §4.2</div>
                  </div>
                  <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 10, background: '#FAFAF8', border: '0.5px solid rgba(26,61,43,0.08)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 3 }}>
                      <div style={{ fontSize: 11, fontWeight: 500, color: '#1C1917' }}>Monthly minimum charged</div>
                      <div style={{ fontSize: 11, fontWeight: 500, color: '#A32D2D' }}>–€800</div>
                    </div>
                    <div style={{ fontSize: 10, color: '#9CA3AF' }}>Waived above €100K volume · €287K processed · §4.3</div>
                  </div>
                  <div style={{ fontSize: 11, color: '#D4EAD9', background: '#1A3D2B', padding: '10px 12px', borderRadius: 10, display: 'flex', justifyContent: 'space-between', width: '100%' }}>
                    <span>Total dispute amount</span>
                    <span className="font-mono" style={{ fontWeight: 500, color: '#fff' }}>€1,174</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 10 }}>
                    <button style={{ background: '#1A3D2B', color: '#fff', border: 'none', borderRadius: 8, padding: 9, fontSize: 11, fontWeight: 500, cursor: 'pointer' }}>Raise dispute →</button>
                    <button style={{ background: '#F5F3EE', color: '#6B6660', border: 'none', borderRadius: 8, padding: 9, fontSize: 11, fontWeight: 500, cursor: 'pointer' }}>Approve partial</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

/* ─────────────── HOW IT WORKS ─────────────── */
function HowItWorks() {
  return (
    <section id="how" className="px-6 py-20 border-b border-forest/8" style={{ background: '#FAFAF6' }}>
      <div className="max-w-5xl mx-auto">
        <div className="text-center mb-14">
          <h2 className="font-display font-light text-ink text-2xl mb-3">From signed contract to verified billing in minutes</h2>
          <p className="text-stone text-sm">Verify existing billing. Automate every new deal.</p>
        </div>
        <div style={{ background: '#F5F3EE', borderRadius: 16, padding: '36px 28px 28px', overflowX: 'auto' }}>
          <div style={{ minWidth: 780 }}>
            {/* ── Row 1: cards + connectors, vertically centered ── */}
            <div style={{ display: 'flex', alignItems: 'center' }}>

              {/* Contracts — two stacked mini-cards, same total height as other cards */}
              <div style={{ width: 118, height: 132, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {[['75%','55%','40%'],['65%','50%']].map((widths, i) => (
                  <div key={i} style={{ flex: 1, background: '#fff', border: '1px solid #E0DDD6', borderRadius: 12, padding: '8px 10px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                    <div style={{ fontSize: 9, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '.08em', color: '#6B6660', marginBottom: 5, display: 'flex', alignItems: 'center', gap: 5 }}>
                      <i className="ti ti-file-text" style={{ fontSize: 11, color: '#1A3D2B' }} /> Contract
                    </div>
                    <div style={{ height: 5, borderRadius: 3, background: '#C0DD97', width: widths[0], marginBottom: 4 }} />
                    {widths.slice(1).map((w, j) => (
                      <div key={j} style={{ height: 5, borderRadius: 3, background: '#E8E5DE', width: w, marginBottom: j < widths.length - 2 ? 4 : 0 }} />
                    ))}
                  </div>
                ))}
              </div>

              <div style={{ flex: 1, height: 1, background: '#C8C5BC' }} />

              {/* PII Review */}
              <div style={{ background: '#fff', border: '1px solid #C0DD97', borderRadius: 14, padding: 14, width: 118, height: 132, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                <div style={{ fontSize: 9, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '.08em', color: '#27500A', marginBottom: 7, display: 'flex', alignItems: 'center', gap: 5 }}>
                  <i className="ti ti-shield-lock" style={{ fontSize: 11, color: '#1A3D2B' }} /> PII review
                </div>
                {['[PERSON_1]','[ORG_1]','[EMAIL_1]'].map((label, i) => (
                  <div key={i} style={{ fontSize: 8, fontWeight: 500, background: '#EAF3DE', color: '#27500A', borderRadius: 4, padding: '2px 5px', display: 'inline-block', marginBottom: 3, fontFamily: "'JetBrains Mono',monospace" }}>{label}</div>
                ))}
                <div style={{ fontSize: 9, fontWeight: 500, background: '#EAF3DE', color: '#27500A', borderRadius: 5, padding: '3px 7px', display: 'inline-block', marginTop: 4 }}>Masked before AI</div>
              </div>

              <div style={{ flex: 1, height: 1, background: '#C8C5BC' }} />

              {/* AI Extraction */}
              <div style={{ background: '#fff', border: '1px solid #E0DDD6', borderRadius: 14, padding: 14, width: 118, height: 132, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                <div style={{ fontSize: 9, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '.08em', color: '#6B6660', marginBottom: 7, display: 'flex', alignItems: 'center', gap: 5 }}>
                  <i className="ti ti-cpu" style={{ fontSize: 11, color: '#1A3D2B' }} /> AI extraction
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                  <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#639922', flexShrink: 0 }} />
                  <div style={{ height: 5, borderRadius: 3, background: '#EAF3DE', flex: 1 }} />
                </div>
                <div style={{ fontSize: 10, color: '#6B6660', margin: '4px 0', lineHeight: 1.5 }}>Price · Discount<br />Escalator · Tiers</div>
                <div style={{ fontSize: 9, fontWeight: 500, background: '#EAF3DE', color: '#27500A', borderRadius: 5, padding: '3px 7px', display: 'inline-block' }}>99% confidence</div>
              </div>

              {/* Connector with check circle */}
              <div style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
                <div style={{ width: 26, height: 26, borderRadius: '50%', background: '#1A3D2B', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <i className="ti ti-check" style={{ color: '#fff', fontSize: 12 }} />
                </div>
                <div style={{ flex: 1, height: 1, background: '#C8C5BC' }} />
              </div>

              {/* Verification */}
              <div style={{ background: '#fff', border: '1px solid #E0DDD6', borderRadius: 14, padding: 14, width: 118, height: 132, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                <div style={{ fontSize: 9, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '.08em', color: '#6B6660', marginBottom: 7, display: 'flex', alignItems: 'center', gap: 5 }}>
                  <i className="ti ti-layout-columns" style={{ fontSize: 11, color: '#1A3D2B' }} /> Verification
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5, marginBottom: 7 }}>
                  <div style={{ background: '#EAF3DE', borderRadius: 7, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <i className="ti ti-file" style={{ fontSize: 13, color: '#27500A' }} />
                  </div>
                  <div style={{ background: '#FFF3E0', borderRadius: 7, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <i className="ti ti-forms" style={{ fontSize: 13, color: '#BA7517' }} />
                  </div>
                </div>
                {['#BA7517','#639922'].map((c, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: i === 0 ? 4 : 0 }}>
                    <div style={{ width: 7, height: 7, borderRadius: '50%', background: c, flexShrink: 0 }} />
                    <div style={{ height: 5, borderRadius: 3, background: '#E8E5DE', flex: 1 }} />
                  </div>
                ))}
              </div>

              <div style={{ flex: 1, height: 1, background: '#C8C5BC' }} />

              {/* Billing Configured */}
              <div style={{ background: '#fff', border: '1px solid #E0DDD6', borderRadius: 14, padding: 14, width: 118, height: 132, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                <div style={{ fontSize: 9, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '.08em', color: '#6B6660', marginBottom: 7, display: 'flex', alignItems: 'center', gap: 5 }}>
                  <i className="ti ti-credit-card" style={{ fontSize: 11, color: '#1A3D2B' }} /> Billing configured
                </div>
                {(['#C0DD97','#EAF3DE','#EAF3DE'] as const).map((c, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: i < 2 ? 4 : 7 }}>
                    <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#639922', flexShrink: 0 }} />
                    <div style={{ height: 5, borderRadius: 3, background: c, flex: 1 }} />
                  </div>
                ))}
                <div style={{ fontSize: 9, fontWeight: 500, background: '#EAF3DE', color: '#27500A', borderRadius: 5, padding: '3px 7px', display: 'inline-block', fontFamily: "'JetBrains Mono',monospace" }}>sub_abc123 created</div>
              </div>
            </div>

            {/* ── Row 2: captions — spacers mirror connector widths above ── */}
            <div style={{ display: 'flex', alignItems: 'flex-start', marginTop: 12 }}>
              <div style={{ width: 118, textAlign: 'center', fontSize: 12, color: '#4A4540', lineHeight: 1.5 }}>Signed<br />contracts</div>
              <div style={{ flex: 1 }} />
              <div style={{ width: 118, textAlign: 'center', fontSize: 12, color: '#4A4540', lineHeight: 1.5 }}>Data masked<br />locally</div>
              <div style={{ flex: 1 }} />
              <div style={{ width: 118, textAlign: 'center', fontSize: 12, color: '#4A4540', lineHeight: 1.5 }}>AI reads<br />every clause</div>
              <div style={{ flex: 1 }} />
              <div style={{ width: 118, textAlign: 'center', fontSize: 12, color: '#4A4540', lineHeight: 1.5 }}>Human reviews<br />in 60 seconds</div>
              <div style={{ flex: 1 }} />
              <div style={{ width: 118, textAlign: 'center', fontSize: 12, color: '#4A4540', lineHeight: 1.5 }}>Billing platform<br />updated via API</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

/* ─────────────── CALCULATION BREAKDOWN ─────────────── */
function CalculationBreakdown() {
  return (
    <section className="px-6 py-24 bg-white border-b border-forest/8">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-12 max-w-2xl mx-auto">
          <div className="text-xs font-medium uppercase tracking-widest text-sage mb-3">Calculation transparency</div>
          <h2 className="font-display font-light text-ink text-3xl leading-tight mb-4">Every number traced back to the contract clause that generated it</h2>
          <p className="text-stone leading-relaxed">Verdix doesn&apos;t just flag mismatches — it shows the exact arithmetic. Every invoice amount, TCV, and leakage figure is derived step by step from the signed contract.</p>
        </div>
        <div className="overflow-x-auto -mx-6 px-6 md:mx-0 md:px-0">
        <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden shadow-sm mx-auto" style={{ maxWidth: 900, minWidth: 700, fontSize: 12 }}>
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-forest/8" style={{ background: '#F5F3EE' }}>
            <div className="tl-r" /><div className="tl-y" /><div className="tl-g" />
            <span className="font-mono text-xs text-stone ml-2">verdix — billing calculation · Ardoq AS · CLR-2024-0031</span>
          </div>
          <div className="flex items-center justify-between px-5 py-3 border-b border-forest/8">
            <div>
              <div style={{ fontSize: 14, fontWeight: 500, color: '#1C1917' }}>Ardoq AS — Year 1 billing breakdown</div>
              <div style={{ fontSize: 10, color: '#6B6660', marginTop: 1 }}>Feb 1 2024 – Jan 31 2025 · EUR · Enterprise MSA</div>
            </div>
            <div className="flex items-center gap-3">
              <span style={{ fontSize: 10, padding: '3px 10px', background: '#EAF3DE', border: '0.5px solid #C0DD97', color: '#27500A', borderRadius: 6, fontWeight: 500 }}>Verified ✓</span>
              <span style={{ fontSize: 10, color: '#6B6660' }}>TCV: <span className="font-mono" style={{ color: '#1C1917', fontWeight: 500 }}>$200,325</span></span>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-0" style={{ borderBottom: '0.5px solid rgba(26,61,43,0.08)' }}>
            <div className="p-5 border-r border-forest/8">
              <div style={{ fontSize: 9, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '.07em', color: '#6B6660', marginBottom: 12 }}>Contract terms extracted</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {[
                  ['Base platform fee', '§3.1 · 50 named users included', '$18,500/mo'],
                  ['Introductory discount', '§3.4 · 15% off base · months 1–6 only', '–15%'],
                  ['Price escalator', '§3.2 · 3% fixed · from Feb 1 2025', '+3%'],
                  ['Additional seats', '§3.3 · $320/user/month above 50', '$320/seat'],
                  ['Onboarding (one-time)', '§3.5 · ref SOW-2024-01', '$12,000'],
                ].map(([name, sub, val]) => (
                  <div key={name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '8px 10px', background: '#F5F3EE', borderRadius: 8 }}>
                    <div>
                      <div style={{ fontSize: 10, fontWeight: 500, color: '#1C1917' }}>{name}</div>
                      <div style={{ fontSize: 9, color: '#6B6660', marginTop: 1 }}>{sub}</div>
                    </div>
                    <div className="font-mono" style={{ fontSize: 11, color: val.startsWith('–') ? '#A32D2D' : '#1A3D2B', fontWeight: 500 }}>{val}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="p-5">
              <div style={{ fontSize: 9, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '.07em', color: '#6B6660', marginBottom: 12 }}>Derived invoice schedule</div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '0.5px solid rgba(26,61,43,0.08)' }}>
                    {['Month','Calculation','Invoice','Status'].map((h, i) => (
                      <th key={h} style={{ fontSize: 9, fontWeight: 500, color: '#6B6660', textTransform: 'uppercase', letterSpacing: '.05em', padding: '4px 8px 6px', textAlign: i === 2 ? 'right' : 'left' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[
                    { month: 'Feb 2024', calc: '$18,500 – 15% = $15,725', inv: '$15,725', status: '✓ match', red: false },
                    { month: 'Mar–Jul 2024', calc: '$18,500 – 15% = $15,725 × 5', inv: '$78,625', status: '✓ match', red: false },
                    { month: 'Aug 2024', calc: '$18,500 (disc. expired) ≠ $15,725', inv: '$15,725 ⚠', status: 'mismatch', red: true },
                    { month: 'Sep–Jan 2025', calc: '$18,500 × 5 ≠ $15,725 × 5', inv: '$78,625 ⚠', status: 'mismatch', red: true },
                    { month: 'Feb 2024', calc: 'SOW-2024-01 one-time', inv: '$12,000', status: '✓ match', red: false },
                  ].map((r) => (
                    <tr key={r.month + r.calc} style={{ borderBottom: '0.5px solid rgba(26,61,43,0.06)', background: r.red ? '#FCEBEB' : 'transparent' }}>
                      <td style={{ padding: '5px 8px 5px 0', fontSize: 9, color: r.red ? '#791F1F' : '#6B6660', whiteSpace: 'nowrap', fontWeight: r.red ? 500 : 400 }}>{r.month}</td>
                      <td style={{ padding: '5px 8px', fontFamily: "'JetBrains Mono',monospace", fontSize: 9, color: r.red ? '#791F1F' : '#6B6660' }}>{r.calc}</td>
                      <td style={{ padding: '5px 0 5px 8px', fontFamily: "'JetBrains Mono',monospace", fontSize: 10, fontWeight: 500, color: r.red ? '#A32D2D' : '#1A3D2B', textAlign: 'right' }}>{r.inv}</td>
                      <td style={{ padding: '5px 0 5px 8px' }}>
                        <span style={{ fontSize: 8, padding: '1px 6px', background: r.red ? '#FCEBEB' : '#EAF3DE', color: r.red ? '#791F1F' : '#27500A', borderRadius: 4 }}>{r.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {/* Leakage calc */}
          <div className="p-5">
            <div style={{ fontSize: 9, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '.07em', color: '#6B6660', marginBottom: 10 }}>Leakage calculation — discount overhang §3.4</div>
            <div className="grid grid-cols-3 gap-3">
              <div style={{ background: '#F5F3EE', borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ fontSize: 9, color: '#6B6660', marginBottom: 4 }}>Correct monthly rate (post Aug)</div>
                <div className="font-mono" style={{ fontSize: 14, fontWeight: 500, color: '#1A3D2B' }}>$18,500</div>
                <div style={{ fontSize: 9, color: '#6B6660', marginTop: 2 }}>Base fee · §3.1 · no discount</div>
              </div>
              <div style={{ background: '#FCEBEB', borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ fontSize: 9, color: '#6B6660', marginBottom: 4 }}>Actually billed (Aug–Jan)</div>
                <div className="font-mono" style={{ fontSize: 14, fontWeight: 500, color: '#A32D2D' }}>$15,725</div>
                <div style={{ fontSize: 9, color: '#A32D2D', marginTop: 2 }}>15% still applied — expired §3.4</div>
              </div>
              <div style={{ background: '#EAF3DE', border: '0.5px solid #C0DD97', borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ fontSize: 9, color: '#6B6660', marginBottom: 4 }}>Monthly leakage × 6 months</div>
                <div className="font-mono" style={{ fontSize: 14, fontWeight: 500, color: '#27500A' }}>$16,650</div>
                <div style={{ fontSize: 9, color: '#27500A', marginTop: 2 }}>($18,500 – $15,725) × 6 = $16,650</div>
              </div>
            </div>
            <div style={{ marginTop: 10, padding: '10px 14px', background: '#1A3D2B', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontSize: 10, color: '#D4EAD9' }}>Total recoverable from Ardoq AS — discount overhang finding</div>
              <div className="font-mono" style={{ fontSize: 16, fontWeight: 500, color: '#FFFFFF' }}>$16,650</div>
            </div>
          </div>
        </div>
        </div>
      </div>
    </section>
  )
}

/* ─────────────── SECURITY ─────────────── */
function Security() {
  return (
    <section id="security" className="px-6 py-20 border-b border-forest/8">
      <div className="max-w-5xl mx-auto">
        <div className="text-center mb-12">
          <h2 className="font-display font-light text-ink text-2xl mb-3">Your contracts are sensitive. We treat them that way.</h2>
          <p className="text-stone text-sm max-w-lg mx-auto">Built for the data sovereignty requirements of Nordic and European enterprises.</p>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { icon: 'ti-shield-lock', title: 'EU data residency', desc: 'All data stored within the European Economic Area. GDPR compliant by design.' },
            { icon: 'ti-eye-off', title: 'No AI training', desc: 'Contracts processed for extraction only. Raw text not retained after processing.' },
            { icon: 'ti-file-description', title: 'Full audit trail', desc: 'Every billing change logged with the contract clause that authorised it.' },
            { icon: 'ti-lock', title: 'SOC 2 Type II', desc: 'AES-256 at rest, TLS 1.3 in transit, row-level tenant isolation.' },
          ].map(item => (
            <div key={item.title} className="bg-white border border-forest/10 rounded-2xl p-5 text-center">
              <i className={`ti ${item.icon} text-forest mb-3 block`} style={{ fontSize: 24 }} />
              <div className="text-sm font-medium text-ink mb-1.5">{item.title}</div>
              <div className="text-xs text-stone leading-snug">{item.desc}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

/* ─────────────── DESIGN PARTNER SECTION ─────────────── */
function DesignPartnerSection() {
  const [form, setForm] = useState({ name: '', email: '', company: '', role: '', platform: '', modules: [] as string[], pain: '' })
  const [error, setError] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [loading, setLoading] = useState(false)

  const platforms = ['Stripe', 'Chargebee', 'Maxio', 'Other']
  const moduleOptions = [
    { key: 'billing_verification', label: 'Billing verification', desc: 'Verify customer billing matches signed contracts' },
    { key: 'auto_configure', label: 'Auto-configure', desc: 'Automate billing setup when a new contract is signed' },
    { key: 'partner_recon', label: 'Partner reconciliation', desc: 'Validate partner and supplier invoices against agreements' },
  ]

  const toggleModule = (key: string) => {
    setForm(f => ({
      ...f,
      modules: f.modules.includes(key) ? f.modules.filter(m => m !== key) : [...f.modules, key]
    }))
  }

  const handleSubmit = async () => {
    if (!form.name || !form.email || !form.company) {
      setError('Please complete your name, work email, and company before submitting.')
      return
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      setError('Please enter a valid work email address.')
      return
    }
    setError('')
    setLoading(true)
    try {
      await fetch('/api/design-partner-apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      setSubmitted(true)
    } catch {
      setSubmitted(true) // graceful fallback
    } finally {
      setLoading(false)
    }
  }

  return (
    <section id="alpha" className="px-6 py-24 border-t border-forest/8">
      <div className="max-w-5xl mx-auto">
        <div className="text-center mb-14">
          <div className="inline-flex items-center gap-2 mb-5" style={{ background: '#EAF3DE', border: '0.5px solid #C0DD97', borderRadius: 999, padding: '5px 14px' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#27500A', display: 'inline-block' }} />
            <span style={{ fontSize: 11, fontWeight: 500, color: '#27500A', letterSpacing: '.05em' }}>DESIGN PARTNER PROGRAMME · LIMITED TO 20 COMPANIES</span>
          </div>
          <h2 className="font-display font-light text-ink text-3xl mb-4">Become a Verdix Design Partner</h2>
          <p className="text-stone leading-relaxed max-w-xl mx-auto" style={{ fontSize: 15 }}>We are building Verdix with a small group of Design Partners — companies who work directly with us to shape the product. Design Partners get early access, influence the roadmap, and receive preferential terms in exchange for structured feedback and collaboration.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-14">
          {[
            { icon: 'ti-clock', title: 'Early access', desc: 'Access the platform before public launch. The first audit is complimentary, and all findings are yours to keep regardless of whether you proceed further.' },
            { icon: 'ti-message-circle', title: 'Direct input on what we build', desc: 'A monthly working session with the founding team. Contract formats, billing platforms, and workflow requirements raised by Design Partners are prioritised directly into the development cycle.' },
            { icon: 'ti-lock', title: 'Preferred pricing, permanently', desc: 'Design Partners receive a preferential rate that is locked in for the lifetime of the account — not subject to future pricing changes as the platform scales.' },
          ].map(b => (
            <div key={b.title} className="bg-white border border-forest/10 rounded-2xl p-7">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-5" style={{ background: '#EAF3DE' }}>
                <i className={`ti ${b.icon}`} style={{ fontSize: 20, color: '#1A3D2B' }} />
              </div>
              <div style={{ fontSize: 14, fontWeight: 500, color: '#1C1917', marginBottom: 8 }}>{b.title}</div>
              <div style={{ fontSize: 13, color: '#6B6660', lineHeight: 1.7 }}>{b.desc}</div>
            </div>
          ))}
        </div>
        <div className="bg-white border border-forest/10 rounded-3xl overflow-hidden shadow-sm">
          <div className="px-8 py-6 border-b border-forest/8" style={{ background: '#F5F3EE' }}>
            <div style={{ fontSize: 15, fontWeight: 500, color: '#1C1917', marginBottom: 2 }}>Apply to become a Design Partner</div>
            <div style={{ fontSize: 13, color: '#6B6660' }}>We review every application and respond within 48 hours.</div>
          </div>
          <div className="px-8 py-8">
            {submitted ? (
              <div style={{ textAlign: 'center', padding: '32px 0' }}>
                <div style={{ width: 52, height: 52, background: '#EAF3DE', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
                  <i className="ti ti-check" style={{ fontSize: 24, color: '#1A3D2B' }} />
                </div>
                <div style={{ fontSize: 18, fontWeight: 500, color: '#1C1917', marginBottom: 8 }}>Application received</div>
                <div style={{ fontSize: 14, color: '#6B6660', maxWidth: 400, margin: '0 auto', lineHeight: 1.7 }}>
                  Thank you, {form.name}. We will review your application and be in touch within 48 hours to arrange a call.
                </div>
                <div style={{ marginTop: 20, fontSize: 12, color: '#9CA3AF' }}>A confirmation has been sent to {form.email}</div>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-5">
                  {[
                    { label: 'Full name *', id: 'name', placeholder: 'Anna Lindqvist', type: 'text' },
                    { label: 'Work email *', id: 'email', placeholder: 'anna@company.com', type: 'email' },
                    { label: 'Company *', id: 'company', placeholder: 'Acme AB', type: 'text' },
                    { label: 'Role', id: 'role', placeholder: 'CFO / VP Finance / Founder', type: 'text' },
                  ].map(f => (
                    <div key={f.id}>
                      <label style={{ fontSize: 10, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '.07em', color: '#6B6660', display: 'block', marginBottom: 6 }}>{f.label}</label>
                      <input
                        type={f.type}
                        placeholder={f.placeholder}
                        value={(form as Record<string, string | string[]>)[f.id] as string ?? ''}
                        onChange={e => setForm(prev => ({ ...prev, [f.id]: e.target.value }))}
                        style={{ width: '100%', background: '#FAF8F4', border: '0.5px solid rgba(26,61,43,0.15)', borderRadius: 10, padding: '11px 14px', fontSize: 13, color: '#1C1917', outline: 'none' }}
                        onFocus={e => { e.target.style.borderColor = '#1A3D2B'; e.target.style.background = '#fff' }}
                        onBlur={e => { e.target.style.borderColor = 'rgba(26,61,43,0.15)'; e.target.style.background = '#FAF8F4' }}
                      />
                    </div>
                  ))}
                </div>
                <div className="mb-5">
                  <label style={{ fontSize: 10, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '.07em', color: '#6B6660', display: 'block', marginBottom: 6 }}>Current billing platform</label>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {platforms.map(p => (
                      <label
                        key={p}
                        onClick={() => setForm(f => ({ ...f, platform: p.toLowerCase() }))}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '10px 12px', background: form.platform === p.toLowerCase() ? '#EAF3DE' : '#FAF8F4', border: `0.5px solid ${form.platform === p.toLowerCase() ? '#1A3D2B' : 'rgba(26,61,43,0.15)'}`, borderRadius: 8, transition: '.15s' }}
                      >
                        <input type="radio" name="platform" value={p.toLowerCase()} checked={form.platform === p.toLowerCase()} onChange={() => {}} style={{ accentColor: '#1A3D2B' }} />
                        <span style={{ fontSize: 12, color: '#1C1917' }}>{p}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <div className="mb-5">
                  <label style={{ fontSize: 10, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '.07em', color: '#6B6660', display: 'block', marginBottom: 6 }}>Which capabilities are most relevant?</label>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    {moduleOptions.map(m => (
                      <label
                        key={m.key}
                        onClick={() => toggleModule(m.key)}
                        style={{ display: 'flex', alignItems: 'flex-start', gap: 9, cursor: 'pointer', padding: '12px 14px', background: form.modules.includes(m.key) ? '#EAF3DE' : '#FAF8F4', border: `0.5px solid ${form.modules.includes(m.key) ? '#1A3D2B' : 'rgba(26,61,43,0.15)'}`, borderRadius: 10, transition: '.15s' }}
                      >
                        <input type="checkbox" checked={form.modules.includes(m.key)} onChange={() => {}} style={{ marginTop: 1, accentColor: '#1A3D2B', flexShrink: 0 }} />
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 500, color: '#1C1917', marginBottom: 2 }}>{m.label}</div>
                          <div style={{ fontSize: 11, color: '#6B6660', lineHeight: 1.5 }}>{m.desc}</div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
                <div className="mb-6">
                  <label style={{ fontSize: 10, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '.07em', color: '#6B6660', display: 'block', marginBottom: 6 }}>
                    What would you most like Verdix to solve for you? <span style={{ color: '#9CA3AF', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional)</span>
                  </label>
                  <textarea
                    rows={3}
                    value={form.pain}
                    onChange={e => setForm(f => ({ ...f, pain: e.target.value }))}
                    placeholder="For example: we have 60 enterprise contracts and no systematic way to verify our billing configuration matches what was agreed..."
                    style={{ width: '100%', background: '#FAF8F4', border: '0.5px solid rgba(26,61,43,0.15)', borderRadius: 10, padding: '11px 14px', fontSize: 13, color: '#1C1917', outline: 'none', resize: 'none', lineHeight: 1.6 }}
                    onFocus={e => { e.target.style.borderColor = '#1A3D2B'; e.target.style.background = '#fff' }}
                    onBlur={e => { e.target.style.borderColor = 'rgba(26,61,43,0.15)'; e.target.style.background = '#FAF8F4' }}
                  />
                </div>
                <div style={{ borderTop: '0.5px solid rgba(26,61,43,0.08)', marginBottom: 20 }} />
                {error && (
                  <div style={{ fontSize: 12, color: '#791F1F', background: '#FCEBEB', border: '0.5px solid #F09595', borderRadius: 8, padding: '10px 14px', marginBottom: 14 }}>{error}</div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
                  <div style={{ fontSize: 11, color: '#9CA3AF', lineHeight: 1.6 }}>
                    Limited to 20 Design Partners &nbsp;·&nbsp; EU and Nordic companies preferred<br />
                    No commitment or payment required at this stage
                  </div>
                  <button
                    onClick={handleSubmit}
                    disabled={loading}
                    style={{ background: loading ? '#4A7C59' : '#1A3D2B', color: '#fff', fontWeight: 500, padding: '13px 28px', borderRadius: 12, fontSize: 14, border: 'none', cursor: 'pointer', whiteSpace: 'nowrap' }}
                    onMouseOver={e => { if (!loading) (e.target as HTMLButtonElement).style.background = '#4A7C59' }}
                    onMouseOut={e => { if (!loading) (e.target as HTMLButtonElement).style.background = '#1A3D2B' }}
                  >
                    {loading ? 'Submitting...' : 'Apply to become a Design Partner →'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

/* ─────────────── PRICING ─────────────── */
function Pricing() {
  const plans = [
    {
      id: 'trial',
      name: 'Standard',
      price: '€0',
      period: '',
      badge: 'Free',
      badgeHighlight: false,
      features: ['3 agreement syncs included', 'Contract PDF upload', 'Basic billing check', 'Leakage dashboard'],
      cta: 'Get started free',
      href: '/signup',
      highlight: false,
    },
    {
      id: 'core',
      name: 'Core',
      price: '€95',
      period: '/mo',
      badge: null,
      badgeHighlight: false,
      features: ['10 synced agreements', 'Automated contract sync', 'Native Stripe integration', 'PII masking add-on (+€45)'],
      cta: 'Start with Core',
      href: '/signup?plan=core',
      highlight: false,
    },
    {
      id: 'pro',
      name: 'Pro',
      price: '€445',
      period: '/mo',
      badge: 'Most popular',
      badgeHighlight: true,
      features: ['100 synced agreements', 'Automated contract sync', 'Native Stripe integration', 'PII masking add-on (+€45)'],
      cta: 'Start with Pro',
      href: '/signup?plan=pro',
      highlight: true,
    },
    {
      id: 'enterprise',
      name: 'Enterprise',
      price: 'Custom',
      period: '',
      badge: null,
      badgeHighlight: false,
      features: [],
      desc: 'Contact the Verdix team for a custom offer tailored to your organisation\'s specific needs.',
      cta: 'Talk to us',
      href: 'mailto:bilal@lynoraai.com?subject=Verdix Enterprise',
      highlight: false,
    },
  ]

  return (
    <section id="pricing" className="px-6 py-24 border-t border-forest/8">
      <div className="max-w-5xl mx-auto">
        <div className="text-center mb-12">
          <div className="text-xs font-medium uppercase tracking-widest text-sage mb-3">Pricing</div>
          <h2 className="font-display font-light text-ink text-3xl leading-tight mb-4">Simple, usage-based pricing</h2>
          <p className="text-stone max-w-lg mx-auto leading-relaxed">One agreement sync = one contract audit, billing check, or partner reconciliation.</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {plans.map(plan => (
            <div
              key={plan.id}
              className="bg-white rounded-2xl flex flex-col overflow-hidden"
              style={{ border: plan.highlight ? '1.5px solid #1A3D2B' : '1px solid rgba(26,61,43,0.10)' }}
            >
              {plan.badge ? (
                <div
                  className="text-center text-[11px] font-semibold py-1.5 tracking-wide"
                  style={{ background: plan.badgeHighlight ? '#1A3D2B' : '#EAF3DE', color: plan.badgeHighlight ? '#fff' : '#27500A' }}
                >
                  {plan.badge}
                </div>
              ) : <div className="h-[26px]" />}

              <div className="p-5 flex flex-col flex-1">
                <div className="mb-4">
                  <div className="text-[11px] font-semibold text-stone uppercase tracking-widest mb-2">{plan.name}</div>
                  <div className="flex items-baseline gap-1">
                    <span className="text-2xl font-semibold text-ink">{plan.price}</span>
                    {plan.period && <span className="text-stone text-sm">{plan.period}</span>}
                  </div>
                </div>

                {'desc' in plan && plan.desc ? (
                  <p className="text-xs text-stone leading-relaxed flex-1 mb-5">{plan.desc}</p>
                ) : (
                  <ul className="space-y-2 flex-1 mb-5">
                    {plan.features.map(f => (
                      <li key={f} className="flex items-start gap-2 text-xs text-stone leading-relaxed">
                        <div className="w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5" style={{ background: '#EAF3DE' }}>
                          <i className="ti ti-check" style={{ fontSize: 9, color: '#27500A' }} />
                        </div>
                        {f}
                      </li>
                    ))}
                  </ul>
                )}

                <Link
                  href={plan.href}
                  className="block text-center text-sm font-medium py-2.5 rounded-xl transition-colors"
                  style={
                    plan.highlight
                      ? { background: '#1A3D2B', color: '#fff' }
                      : { background: 'transparent', color: '#1A3D2B', border: '1px solid rgba(26,61,43,0.25)' }
                  }
                >
                  {plan.cta}
                </Link>
              </div>
            </div>
          ))}
        </div>

        <div className="text-center">
          <Link href="/pricing" className="text-sm text-forest hover:underline">
            View full pricing details, FAQs, and add-ons →
          </Link>
        </div>
      </div>
    </section>
  )
}

/* ─────────────── CTA ─────────────── */
function CTA() {
  return (
    <section className="px-6 py-24">
      <div className="max-w-3xl mx-auto">
        <div className="rounded-3xl p-8 md:p-14 text-center" style={{ background: '#EAF3DE', border: '0.5px solid #C0DD97' }}>
          <h2 className="font-display font-light text-3xl mb-4" style={{ color: '#1A3D2B' }}>Find the revenue your billing<br />system is missing</h2>
          <p className="leading-relaxed mb-10" style={{ color: '#27500A' }}>Upload a signed contract and a billing export. We&apos;ll show you exactly where they diverge — and fix it. Or validate a partner invoice against your agreement before you pay.</p>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
            <Link href="/signup" className="inline-block bg-forest text-white font-medium px-8 py-4 rounded-xl hover:bg-sage transition-colors shadow-md text-sm">
              Check your billing accuracy →
            </Link>
            <Link href="/design-partner" className="inline-block font-medium px-8 py-4 rounded-xl text-sm" style={{ background: '#EAF3DE', color: '#1A3D2B', border: '0.5px solid #C0DD97' }}>
              Apply as a Design Partner →
            </Link>
          </div>
          <div className="flex items-center justify-center gap-8 mt-6 text-xs" style={{ color: '#3B6D11' }}>
            <span className="flex items-center gap-1.5"><i className="ti ti-credit-card-off" style={{ fontSize: 13 }} /> No credit card</span>
            <span className="flex items-center gap-1.5"><i className="ti ti-shield" style={{ fontSize: 13 }} /> EU data residency</span>
            <span className="flex items-center gap-1.5"><i className="ti ti-trash" style={{ fontSize: 13 }} /> Delete anytime</span>
          </div>
        </div>
      </div>
    </section>
  )
}

/* ─────────────── FOOTER ─────────────── */
function Footer() {
  return (
    <footer className="px-6 pt-8 pb-6 border-t border-forest/10 bg-white">
      <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-5">
        <div className="flex items-center gap-2.5">
          <VerdixLogo size={24} />
          <span className="font-sans font-semibold" style={{ color: '#1A3D2B', letterSpacing: '0.02em' }}>Verdix</span>
          <span className="text-stone text-sm ml-2">Revenue intelligence for B2B SaaS</span>
        </div>
        <div className="flex items-center gap-8 text-sm text-stone">
          <Link href="/privacy" className="hover:text-forest transition-colors">Privacy Policy</Link>
          <Link href="/terms" className="hover:text-forest transition-colors">Terms</Link>
          <a href="mailto:hello@verdix.io" className="hover:text-forest transition-colors">Contact</a>
        </div>
        <div className="text-xs text-stone">© 2026 Verdix. All rights reserved.</div>
      </div>
      <div className="max-w-6xl mx-auto mt-5 pt-5 border-t border-forest/8 text-center text-xs text-stone/60">
        Verdix is a product by Lynora AB · Org. nr 559516-1190 · Vallentuna, Sweden
      </div>
    </footer>
  )
}

/* ─────────────── PAGE ─────────────── */
export default function MarketingPage() {
  return (
    <>
      <Nav />
      <Hero />
      <BillingVerificationSection />
      <AutoConfigureSection />
      <PartnerReconciliationSection />
      <HowItWorks />
      <CalculationBreakdown />
      <Security />
      <Pricing />
      <CTA />
      <Footer />
    </>
  )
}
