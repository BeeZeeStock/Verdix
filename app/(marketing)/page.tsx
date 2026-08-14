'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { VerdixLogo } from '@/components/VerdixLogo'

const DEMO_ARTIFACT_URL = '/demos/contract-to-billing.html'

/* ─────────────── NAV ─────────────── */
function Nav() {
  const [shadow, setShadow] = useState(false)
  const [resOpen, setResOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const navRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const onScroll = () => setShadow(window.scrollY > 16)
    window.addEventListener('scroll', onScroll)
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (navRef.current && !navRef.current.contains(e.target as Node)) {
        setResOpen(false)
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  return (
    <nav
      id="nav"
      ref={navRef}
      className="sticky top-0 z-50 bg-cream/95 backdrop-blur-md border-b border-forest/10"
      style={{ boxShadow: shadow ? '0 1px 8px rgba(26,61,43,.08)' : 'none' }}
    >
      <div className="max-w-6xl mx-auto px-6 py-3.5 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <VerdixLogo size={28} />
          <span className="font-sans font-semibold text-[16px]" style={{ color: '#1A3D2B', letterSpacing: '0.02em' }}>Verdix</span>
        </div>

        {/* Desktop nav */}
        <div className="hidden md:flex items-center gap-8 text-sm font-medium text-stone">
          <a href="#verify" className="hover:text-forest transition-colors">Billing automation</a>
          <a href="#configure" className="hover:text-forest transition-colors">Auto-configure</a>
          <a href="#partner" className="hover:text-forest transition-colors">Partner reconciliation</a>
          <a href="#security" className="hover:text-forest transition-colors">Security</a>
          <a href="#pricing" className="hover:text-forest transition-colors">Pricing</a>

          {/* Resources dropdown */}
          <div className="relative">
            <button
              onClick={() => setResOpen(v => !v)}
              className={`flex items-center gap-1 transition-colors ${resOpen ? 'text-forest' : 'hover:text-forest'}`}
            >
              Resources
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                style={{ transform: resOpen ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }}>
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>

            {resOpen && (
              <div
                className="absolute top-full right-0 mt-3 bg-white border border-forest/10 rounded-2xl shadow-2xl overflow-hidden"
                style={{ width: 680, boxShadow: '0 20px 60px rgba(26,61,43,.14), 0 4px 12px rgba(26,61,43,.06)' }}
              >
                <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr 200px' }}>

                  {/* Left – Resource Centre card */}
                  <div className="p-6 flex flex-col justify-between border-r border-forest/8" style={{ background: '#FAFAF8' }}>
                    <div>
                      <div className="w-9 h-9 rounded-xl flex items-center justify-center mb-4" style={{ background: '#EAF3DE' }}>
                        <VerdixLogo size={20} />
                      </div>
                      <div className="text-sm font-semibold text-ink mb-2">Resource Centre</div>
                      <p className="text-xs text-stone leading-relaxed">
                        Learn how modern contract billing and partner reconciliation works for B2B/B2B2C companies.
                      </p>
                    </div>
                    <a href="#" className="mt-5 flex items-center gap-1.5 text-xs font-semibold text-forest transition-all hover:gap-2.5">
                      Explore resources
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
                    </a>
                  </div>

                  {/* Middle – Explore links */}
                  <div className="p-6 border-r border-forest/8">
                    <div className="text-[10px] font-semibold uppercase tracking-widest text-stone mb-5">Explore</div>
                    <div className="space-y-4">
                      {([
                        { icon: 'ti-article',                   label: 'Blog',         desc: 'News and updates from Verdix', href: '/blog' },
                        { icon: 'ti-device-desktop-analytics',  label: 'Demos',        desc: 'See Verdix in action', href: DEMO_ARTIFACT_URL },
                        { icon: 'ti-book',                      label: 'Guides',       desc: 'How-to guides and documentation' },
                        { icon: 'ti-users',                     label: 'Case studies', desc: 'How teams use Verdix', soon: true },
                      ] as { icon: string; label: string; desc: string; href?: string; soon?: boolean }[]).map(item => (
                        <a
                          key={item.label}
                          href={item.href ?? '#'}
                          target={item.href ? '_blank' : undefined}
                          rel={item.href ? 'noopener noreferrer' : undefined}
                          className="flex items-start gap-3 group"
                          onClick={() => setResOpen(false)}
                        >
                          <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5" style={{ background: '#EAF3DE' }}>
                            <i className={`ti ${item.icon}`} style={{ fontSize: 15, color: '#1A3D2B' }} />
                          </div>
                          <div>
                            <div className="text-sm font-medium text-ink group-hover:text-forest transition-colors flex items-center gap-2">
                              {item.label}
                              {item.soon && (
                                <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded uppercase tracking-wider" style={{ background: 'rgba(26,61,43,.07)', color: '#9CA3AF' }}>Soon</span>
                              )}
                            </div>
                            <div className="text-xs text-stone mt-0.5">{item.desc}</div>
                          </div>
                        </a>
                      ))}
                    </div>
                  </div>

                  {/* Right – Featured demo card */}
                  <div className="p-5">
                    <div className="text-[10px] font-semibold uppercase tracking-widest text-stone mb-4">Featured</div>
                    <a
                      href={DEMO_ARTIFACT_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block group"
                      onClick={() => setResOpen(false)}
                    >
                      {/* Preview tile */}
                      <div
                        className="rounded-xl mb-3 flex flex-col items-center justify-center gap-2 transition-opacity group-hover:opacity-90"
                        style={{ background: '#fff', border: '1px solid rgba(26,61,43,0.12)', height: 110 }}
                      >
                        <svg width="32" height="32" viewBox="0 0 28 28" fill="none">
                          <rect width="28" height="28" rx="7" fill="#EAF3DE" />
                          <path d="M7.5 7L11 7L14 18.5L17 7L20.5 7L14 22Z" fill="#1A3D2B" />
                          <rect x="11" y="24" width="6" height="1.5" rx=".75" fill="#27AE60" />
                        </svg>
                        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase', color: '#9CA3AF' }}>
                          Interactive Demo
                        </span>
                      </div>
                      <div className="text-[10px] font-semibold uppercase tracking-widest mb-1" style={{ color: '#4A7C59' }}>Demo</div>
                      <div className="text-sm font-semibold text-ink group-hover:text-forest transition-colors leading-snug mb-1">
                        Contract to billing schedule
                      </div>
                      <div className="text-xs text-stone leading-relaxed">
                        5-step walkthrough: upload, PII review, term extraction, waterfall and billing timeline.
                      </div>
                    </a>
                  </div>

                </div>
              </div>
            )}
          </div>

          <Link href="/login" className="hover:text-forest transition-colors">Sign in</Link>
        </div>

        {/* Mobile: sign in + hamburger */}
        <div className="flex md:hidden items-center gap-3">
          <Link href="/login" className="text-sm text-stone hover:text-forest transition-colors">Sign in</Link>
          <button
            onClick={() => { setMenuOpen(v => !v); setResOpen(false) }}
            className="p-1.5 rounded-lg hover:bg-forest/8 transition-colors"
            aria-label="Toggle menu"
          >
            {menuOpen ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: '#1A3D2B' }}>
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: '#1A3D2B' }}>
                <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {menuOpen && (
        <div className="md:hidden border-t border-forest/8" style={{ background: '#fff' }}>
          <div className="px-6 py-4 flex flex-col">
            {[
              { href: '#verify', label: 'Billing automation' },
              { href: '#configure', label: 'Auto-configure' },
              { href: '#partner', label: 'Partner reconciliation' },
              { href: '#security', label: 'Security' },
              { href: '#pricing', label: 'Pricing' },
            ].map(item => (
              <a
                key={item.label}
                href={item.href}
                onClick={() => setMenuOpen(false)}
                className="py-3 text-sm text-stone hover:text-forest transition-colors border-b border-forest/6 last:border-0"
              >
                {item.label}
              </a>
            ))}
            <div className="pt-4 pb-1">
              <div className="text-[10px] font-semibold uppercase tracking-widest mb-3" style={{ color: '#9CA3AF' }}>Resources</div>
              <Link href="/blog" onClick={() => setMenuOpen(false)} className="flex items-center gap-2 py-2.5 text-sm text-stone hover:text-forest transition-colors">
                <i className="ti ti-article" style={{ fontSize: 15, color: '#1A3D2B' }} /> Blog
              </Link>
              <a href={DEMO_ARTIFACT_URL} target="_blank" rel="noopener noreferrer" onClick={() => setMenuOpen(false)} className="flex items-center gap-2 py-2.5 text-sm text-stone hover:text-forest transition-colors">
                <i className="ti ti-device-desktop-analytics" style={{ fontSize: 15, color: '#1A3D2B' }} /> Interactive demo
              </a>
            </div>
            <Link
              href="/signup"
              onClick={() => setMenuOpen(false)}
              className="mt-3 w-full text-center text-white font-medium py-3 rounded-xl text-sm"
              style={{ background: '#27AE60' }}
            >
              Get started →
            </Link>
          </div>
        </div>
      )}
    </nav>
  )
}

/* ─────────────── HERO ─────────────── */
function Hero() {
  return (
    <section className="relative px-6 pt-12 md:pt-20 pb-12 md:pb-16 overflow-hidden">
      <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 80% 60% at 50% -10%,#D4EAD9 0%,transparent 70%)' }} />
      <div className="max-w-4xl mx-auto text-center relative">
        <div className="inline-flex items-center gap-2 text-xs font-medium mb-8" style={{ color: '#27500A' }}>
          <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: '#27500A' }} />
          Agreement-to-billing for complex B2B contracts
        </div>
        <h1 className="font-display font-light text-ink leading-tight mb-5" style={{ fontSize: 'clamp(2.2rem,4.5vw,3.4rem)' }}>
          Your contracts already say what to bill.<br /><span className="text-forest">Your billing system doesn&apos;t know it.</span>
        </h1>
        <div className="text-stone text-lg max-w-2xl mx-auto leading-relaxed mb-6 space-y-3">
          <p>Verdix reads the signed agreement, pulls the usage it requires, and turns both into approved billing instructions for the systems you already use.</p>
        </div>
        <p className="text-center mb-10 text-sm font-medium" style={{ color: '#27500A' }}>
          No billing migration · No new usage pipeline · Every calculation traceable to the contract
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-4">
          <a href="#how" className="w-full sm:w-auto text-white font-medium px-8 py-4 rounded-xl transition-colors shadow-md text-center" style={{ background: '#27AE60' }}
            onMouseOver={e => (e.currentTarget.style.background = '#219150')}
            onMouseOut={e => (e.currentTarget.style.background = '#27AE60')}
          >
            See how Verdix works →
          </a>
          <Link href="/design-partner" className="w-full sm:w-auto bg-white border border-sage text-sage font-medium px-8 py-4 rounded-xl hover:bg-mint transition-colors text-center">
            Book a 30-minute working session →
          </Link>
        </div>
        <p className="text-center mb-10" style={{ fontSize: 11, color: '#9CA3AF' }}>
          EU-hosted · GDPR-first · Direct identifiers masked locally before AI processing
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-2xl mx-auto">
          {[
            {
              icon: 'ti-file-invoice',
              label: 'Customer contract-to-cash',
              subtitle: 'From signed agreement to billing schedule',
              body: 'Verdix extracts pricing, tiers, commitments and billing dates, pulls live usage, and prepares the correct invoice instructions.',
            },
            {
              icon: 'ti-scale',
              label: 'Partner reconciliation',
              subtitle: 'Validate before you pay',
              body: 'Compare partner invoices against agreed rates, operational activity, discounts, credits and thresholds.',
            },
            {
              icon: 'ti-plug-connected',
              label: 'Keep your existing stack',
              subtitle: 'No billing-platform migration',
              body: 'Continue using your ERP, payment rails and accounting systems. Verdix adds the agreement-operations layer.',
            },
          ].map(card => (
            <div key={card.label} className="bg-white border border-forest/10 rounded-2xl p-5 flex flex-col items-center text-center">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-3 flex-shrink-0" style={{ background: '#EAF3DE' }}>
                <i className={`ti ${card.icon}`} style={{ fontSize: 20, color: '#1A3D2B' }} />
              </div>
              <div className="text-xs font-semibold uppercase tracking-widest mb-1.5 w-full" style={{ color: '#27500A', minHeight: '2.6rem', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>{card.label}</div>
              <div className="text-sm font-medium text-ink mb-2 w-full" style={{ minHeight: '2.5rem', display: 'flex', alignItems: 'flex-start', justifyContent: 'center' }}>{card.subtitle}</div>
              <div className="text-xs text-stone leading-snug">{card.body}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

/* ─────────────── PROBLEM SECTION ─────────────── */
function ProblemSection() {
  const cards = [
    {
      icon: 'ti-file-text',
      title: 'Terms live in the agreement',
      body: 'Rates, tiers, commitments and exceptions sit in contracts and amendments — not in the billing configuration.',
    },
    {
      icon: 'ti-database',
      title: 'The invoice depends on data elsewhere',
      body: 'Seats, transactions, API calls or other usage live in product and operational systems — outside the billing workflow.',
    },
    {
      icon: 'ti-calculator',
      title: 'Billing teams connect the two manually',
      body: 'Teams re-read agreements, pull usage and rebuild the billing logic every cycle. Errors are often found only after invoicing.',
    },
  ]
  return (
    <section className="px-6 py-24 border-t border-forest/8">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-12 max-w-2xl mx-auto">
          <div className="text-xs font-medium uppercase tracking-widest text-sage mb-3">The problem</div>
          <h2 className="font-display font-light text-ink text-3xl leading-tight mb-4">Bespoke contracts move faster than billing systems</h2>
          <p className="text-stone leading-relaxed">Usage tiers, minimum commitments, credits, ramp discounts and amendments get negotiated in the contract — but billing teams still have to translate them into executable billing logic.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          {cards.map(card => (
            <div key={card.title} className="bg-white border border-forest/10 rounded-2xl p-6">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-4" style={{ background: '#EAF3DE' }}>
                <i className={`ti ${card.icon}`} style={{ fontSize: 20, color: '#1A3D2B' }} />
              </div>
              <div className="text-sm font-semibold text-ink mb-2">{card.title}</div>
              <div className="text-sm text-stone leading-relaxed">{card.body}</div>
            </div>
          ))}
        </div>
        <p className="text-stone text-sm mb-6 text-center">Best fit: negotiated B2B contracts · recurring or usage-linked pricing · manual contract-to-billing operations</p>
        <div className="rounded-2xl px-5 py-4 flex items-center gap-3 flex-wrap" style={{ background: '#F0EBE1' }}>
          <i className="ti ti-trending-down flex-shrink-0" style={{ fontSize: 18, color: '#D97706' }} />
          <p className="text-sm font-medium text-ink">The result: billing rework · revenue leakage · delayed invoices · slower close</p>
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
          <div className="text-xs font-medium uppercase tracking-widest text-sage mb-3">The solution</div>
          <h2 className="font-display font-light text-ink text-3xl leading-tight mb-4">Verdix turns the signed agreement into the billing instruction</h2>
        </div>

        {/* Architecture: Agreement + Usage → Verdix → Existing stack */}
        <div className="flex flex-col lg:flex-row items-stretch gap-3 mb-8">
          <div className="flex-1 flex flex-col gap-3">
            <div className="bg-white border border-forest/10 rounded-2xl p-5">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: '#27500A' }}>
                <i className="ti ti-file-text" style={{ fontSize: 14 }} /> Signed agreement
              </div>
              <p className="text-sm text-stone leading-relaxed">Rates · tiers · commitments · discounts &amp; escalators · amendments</p>
            </div>
            <div className="bg-white border border-forest/10 rounded-2xl p-5">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: '#27500A' }}>
                <i className="ti ti-database" style={{ fontSize: 14 }} /> Required usage
              </div>
              <p className="text-sm text-stone leading-relaxed">Transactions · seats · API calls · orders · consumption</p>
              <p className="text-xs text-stone/60 mt-2">Pulled from your existing endpoints</p>
            </div>
          </div>

          <div className="flex items-center justify-center flex-shrink-0 lg:rotate-0 rotate-90 py-1">
            <i className="ti ti-arrow-right text-sage" style={{ fontSize: 22 }} />
          </div>

          <div className="flex-1 rounded-2xl p-5" style={{ background: '#1A3D2B' }}>
            <div className="flex items-center gap-2 text-sm font-semibold text-white mb-4">
              <VerdixLogo size={18} /> Verdix
            </div>
            <div className="grid grid-cols-2 gap-3">
              {[
                { title: 'Reads', body: 'Extracts the commercial terms and amendments.' },
                { title: 'Pulls', body: 'Retrieves only the operational data the contract requires.' },
                { title: 'Calculates', body: 'Applies the agreed rates, tiers and billing rules.' },
                { title: 'Reviews', body: 'The billing owner reviews the result before anything is sent downstream.' },
              ].map(step => (
                <div key={step.title} className="rounded-xl p-3" style={{ background: 'rgba(255,255,255,0.06)' }}>
                  <div className="text-xs font-semibold uppercase tracking-widest mb-1.5" style={{ color: '#8FD19E' }}>{step.title}</div>
                  <div className="text-xs leading-relaxed" style={{ color: 'rgba(255,255,255,0.78)' }}>{step.body}</div>
                </div>
              ))}
            </div>
            <p className="text-xs mt-4 leading-relaxed" style={{ color: '#8FD19E' }}>Billing that matches the agreement — without rebuilding your finance stack.</p>
          </div>

          <div className="flex items-center justify-center flex-shrink-0 lg:rotate-0 rotate-90 py-1">
            <i className="ti ti-arrow-right text-sage" style={{ fontSize: 22 }} />
          </div>

          <div className="flex-1 bg-white border border-forest/10 rounded-2xl p-5">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: '#27500A' }}>
              <i className="ti ti-plug-connected" style={{ fontSize: 14 }} /> Your existing stack
            </div>
            <div className="space-y-2 mb-3">
              {[
                { name: 'Remembill', desc: 'Invoice delivery & payment workflow' },
                { name: 'Stripe', desc: 'Billing / payment workflow' },
              ].map(p => (
                <div key={p.name} className="rounded-xl px-3 py-2" style={{ background: '#F7F5F0' }}>
                  <div className="text-sm font-medium text-ink">{p.name}</div>
                  <div className="text-xs text-stone">{p.desc}</div>
                </div>
              ))}
            </div>
            <p className="text-xs text-stone/60">Or connect Verdix to the systems you already use via API.</p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-12 max-w-4xl mx-auto text-center">
          {[
            { title: 'No billing migration', body: 'Keep your existing billing and finance stack.' },
            { title: 'No new usage pipeline', body: 'Verdix pulls only the usage the agreement requires.' },
            { title: 'Clause-level traceability', body: 'Every rate and calculation traces back to its source.' },
          ].map(p => (
            <div key={p.title}>
              <div className="text-sm font-semibold text-ink mb-1">{p.title}</div>
              <div className="text-xs text-stone leading-relaxed">{p.body}</div>
            </div>
          ))}
        </div>

        {/* Real UI mockup — billing schedule + timeline */}
        <div className="overflow-x-auto -mx-6 px-6 md:mx-0 md:px-0">
        <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden shadow-sm mx-auto" style={{ fontSize: 12, maxWidth: 900, minWidth: 640 }}>

          {/* Window chrome */}
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-forest/8" style={{ background: '#F5F3EE' }}>
            <div className="tl-r" /><div className="tl-y" /><div className="tl-g" />
            <span className="font-mono text-xs text-stone ml-2">verdix — Acme Enterprise Subscription Agreement</span>
          </div>

          <div className="flex" style={{ minHeight: 520 }}>
            {/* Sidebar */}
            <div className="border-r border-forest/8 py-3 flex-shrink-0" style={{ width: 154, background: '#FAFAF8' }}>
              <div className="flex items-center gap-2 px-3 pb-3 mb-1 border-b border-forest/8">
                <VerdixLogo size={20} />
                <span className="font-sans font-semibold" style={{ fontSize: 11, color: '#1A3D2B', letterSpacing: '0.02em' }}>Verdix</span>
              </div>
              {[
                { section: 'Insights', items: [{ icon: 'ti-layout-dashboard', label: 'Dashboard' }, { icon: 'ti-file-certificate', label: 'Contract ARR' }, { icon: 'ti-chart-bar', label: 'Partner trends' }] },
                { section: 'Verification', items: [{ icon: 'ti-file-check', label: 'Billing checks' }, { icon: 'ti-plus', label: 'New verification' }] },
                { section: 'Auto-configure', items: [{ icon: 'ti-bolt', label: 'New contracts', active: true }, { icon: 'ti-plus', label: 'Upload contract' }] },
                { section: 'Partner Recon', items: [{ icon: 'ti-receipt', label: 'Partner checks' }, { icon: 'ti-plus', label: 'New reconciliation' }] },
              ].map(s => (
                <div key={s.section}>
                  <div className="px-3 pt-3 pb-1" style={{ fontSize: 9, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '.07em', color: '#9CA3AF' }}>{s.section}</div>
                  {s.items.map(item => (
                    <div key={item.label} className="flex items-center gap-2 px-3 py-1.5 mx-1 rounded-lg" style={{ background: (item as {active?: boolean}).active ? '#EAF3DE' : 'transparent' }}>
                      <i className={`ti ${item.icon}`} style={{ fontSize: 12, color: (item as {active?: boolean}).active ? '#1A3D2B' : '#6B6660' }} />
                      <span style={{ fontSize: 11, color: (item as {active?: boolean}).active ? '#1A3D2B' : '#6B6660', fontWeight: (item as {active?: boolean}).active ? 500 : 400 }}>{item.label}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>

            {/* Main content */}
            <div className="flex-1 overflow-hidden flex flex-col">

              {/* Contract page header with tabs */}
              <div className="flex items-center justify-between px-5 py-3 border-b border-forest/8">
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: '#1C1917' }}>Acme Enterprise Subscription Agreement</div>
                  <div style={{ fontSize: 10, color: '#9CA3AF', marginTop: 1 }}>Acme Software AB · VDX-ESA-2026-014</div>
                </div>
                <span style={{ fontSize: 10, padding: '3px 10px', background: '#EAF3DE', border: '0.5px solid #C0DD97', color: '#27500A', borderRadius: 999, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <i className="ti ti-circle-check" style={{ fontSize: 11 }} /> Configured in Stripe
                </span>
              </div>
              <div className="flex border-b border-forest/8 px-5">
                {['Contract · Commercials', 'Revenue model', 'Processed invoices', 'Configured in Stripe'].map((t, i) => (
                  <div key={t} className="py-2 px-3 text-stone" style={{ fontSize: 11, color: i === 1 ? '#1A3D2B' : '#6B6660', borderBottom: i === 1 ? '2px solid #1A3D2B' : '2px solid transparent', fontWeight: i === 1 ? 500 : 400 }}>{t}</div>
                ))}
              </div>

              <div className="p-4 space-y-3 overflow-auto">

                {/* Waterfall card */}
                <div className="border border-forest/8 rounded-xl p-4" style={{ background: '#fff' }}>
                  <div className="flex items-center justify-between mb-3">
                    <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.1em', color: '#6B6660' }}>Configured Billing Schedule</div>
                    <span style={{ fontSize: 10, color: '#9CA3AF', display: 'flex', alignItems: 'center', gap: 3 }}>
                      <i className="ti ti-external-link" style={{ fontSize: 10 }} /> Stripe
                    </span>
                  </div>
                  {/*
                    True waterfall: each bar floats starting at the previous bar's top.
                    Chart: y=25 (€125k top) → y=145 (€0 baseline). Height = 120px = €125k.
                    Scale: 120/125 ≈ 0.96 px per €1k.
                    OF  €12k → height 11.5 → bottom=145 top=133.5 ≈ 133
                    Y1  €53k → height 50.9 → bottom=133  top=82
                    Y2  €60k → height 57.6 → bottom=82   top=24  ≈ 25
                    TCV €125k→ height 120  → bottom=145  top=25 (full reference bar)
                  */}
                  <svg viewBox="0 0 680 185" style={{ width: '100%', height: 185, display: 'block' }}>
                    {/* Grid lines */}
                    <line x1="60" y1="25" x2="660" y2="25" stroke="#F0F2EE" strokeWidth="0.75" />
                    <line x1="60" y1="85" x2="660" y2="85" stroke="#F0F2EE" strokeWidth="0.75" />
                    <line x1="60" y1="145" x2="660" y2="145" stroke="#D1D5DB" strokeWidth="1" />
                    <text x="54" y="29" textAnchor="end" fontSize="9" fill="#9CA3AF">€125k</text>
                    <text x="54" y="89" textAnchor="end" fontSize="9" fill="#9CA3AF">€63k</text>
                    <text x="54" y="149" textAnchor="end" fontSize="9" fill="#9CA3AF">€0</text>

                    {/* Onboarding Fee — amber, floats €0 → €12k */}
                    <rect x="110" y="133" width="90" height="12" rx="3" fill="#D9A35A" />
                    {/* Dashed connector: top of OF → bottom of Y1 */}
                    <line x1="200" y1="133" x2="240" y2="133" stroke="#C9CCC6" strokeWidth="1" strokeDasharray="3 2" />

                    {/* Year 1 — mint green, floats €12k → €65k */}
                    <rect x="240" y="82" width="110" height="51" rx="3" fill="#73C99B" />
                    {/* Dashed connector: top of Y1 → bottom of Y2 */}
                    <line x1="350" y1="82" x2="390" y2="82" stroke="#C9CCC6" strokeWidth="1" strokeDasharray="3 2" />

                    {/* Year 2 — green, floats €65k → €125k */}
                    <rect x="390" y="25" width="110" height="57" rx="3" fill="#27AE60" />

                    {/* TCV — forest, full reference bar €0 → €125k */}
                    <rect x="540" y="25" width="110" height="120" rx="3" fill="#1A3D2B" />

                    {/* Increment amount labels above each bar */}
                    <text x="155" y="126" textAnchor="middle" fontSize="10" fontWeight="600" fill="#3A3A38">€12k</text>
                    <text x="295" y="75" textAnchor="middle" fontSize="10" fontWeight="600" fill="#3A3A38">€53k</text>
                    <text x="445" y="18" textAnchor="middle" fontSize="10" fontWeight="600" fill="#3A3A38">€60k</text>
                    <text x="595" y="18" textAnchor="middle" fontSize="11" fontWeight="700" fill="#3A3A38">€125k</text>

                    {/* X-axis labels */}
                    <text x="155" y="163" textAnchor="middle" fontSize="10" fill="#6B6660">Onboarding Fee</text>
                    <text x="155" y="174" textAnchor="middle" fontSize="9" fill="#9CA3AF">27 Jul 26</text>
                    <text x="295" y="163" textAnchor="middle" fontSize="10" fill="#6B6660">Year 1</text>
                    <text x="295" y="174" textAnchor="middle" fontSize="9" fill="#9CA3AF">1 Aug 26</text>
                    <text x="445" y="163" textAnchor="middle" fontSize="10" fill="#6B6660">Year 2</text>
                    <text x="445" y="174" textAnchor="middle" fontSize="9" fill="#9CA3AF">1 Aug 27</text>
                    <text x="595" y="163" textAnchor="middle" fontSize="10" fontWeight="700" fill="#1A3D2B">TCV</text>
                  </svg>
                  {/* Footer */}
                  <div className="flex items-center justify-between pt-3 mt-1" style={{ borderTop: '0.5px solid rgba(26,61,43,0.08)' }}>
                    <div className="flex gap-8">
                      <div>
                        <div style={{ fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.08em', color: '#9CA3AF' }}>Configured in Stripe</div>
                        <div className="font-mono" style={{ fontSize: 15, fontWeight: 500, color: '#1C1917' }}>€125,184.00</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.08em', color: '#9CA3AF' }}>Contract TCV</div>
                        <div className="font-mono" style={{ fontSize: 15, color: '#9CA3AF' }}>€125,184.00</div>
                      </div>
                    </div>
                    <span style={{ fontSize: 11, fontWeight: 500, color: '#27AE60', display: 'flex', alignItems: 'center', gap: 4 }}>
                      <i className="ti ti-circle-check" style={{ fontSize: 13 }} /> Matches contract
                    </span>
                  </div>
                </div>

                {/* Billing timeline card */}
                <div className="border border-forest/8 rounded-xl overflow-hidden" style={{ background: '#fff' }}>
                  <div className="flex items-center justify-between px-4 py-2.5 border-b border-forest/8">
                    <div>
                      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.1em', color: '#6B6660' }}>Billing Setup</div>
                      <div style={{ fontSize: 9, color: '#9CA3AF' }}>Live configuration pulled from your Stripe account</div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span style={{ fontSize: 9, color: '#9CA3AF', display: 'flex', alignItems: 'center', gap: 3 }}><i className="ti ti-circle-dashed" style={{ fontSize: 11 }} /> Draft</span>
                      <span style={{ fontSize: 9, color: '#6366F1', display: 'flex', alignItems: 'center', gap: 3 }}><i className="ti ti-test-pipe" style={{ fontSize: 11 }} /> Test mode</span>
                      <span style={{ fontSize: 9, padding: '2px 8px', background: '#F5F3EE', border: '0.5px solid rgba(26,61,43,0.12)', color: '#6B6660', borderRadius: 6, display: 'flex', alignItems: 'center', gap: 3 }}><i className="ti ti-refresh" style={{ fontSize: 10 }} /> Refresh</span>
                    </div>
                  </div>
                  <div className="px-4 pt-3 pb-1" style={{ fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.09em', color: '#6B6660' }}>Billing Timeline</div>
                  <div className="px-4 pb-3">
                    {[
                      { label: 'Onboarding Fee', sub: 'Issued 27 Jul 2026', amount: '€12,000.00', status: 'open', statusLabel: 'Awaiting payment', statusColor: '#D97706', dot: 'ring', past: true },
                      { label: 'Aug 2026', sub: 'Issued 1 Aug 2026', amount: '€4,080.00', status: 'draft', statusLabel: 'Draft', statusColor: '#9CA3AF', dot: 'empty', past: true },
                      { label: 'Year 1 commitment', sub: 'Issued 1 Aug 2026', amount: '€53,280.00', status: 'draft', statusLabel: 'Draft', statusColor: '#9CA3AF', dot: 'empty', past: true },
                      { label: 'TODAY', sub: '1 Aug 2026', amount: '', status: '', statusLabel: '', statusColor: '', dot: 'today', past: false },
                      { label: 'Sep 2026', sub: 'Will be issued 1 Sep 2026', amount: '€4,080.00', status: 'draft', statusLabel: 'Draft', statusColor: '#9CA3AF', dot: 'empty', past: false },
                      { label: 'Oct 2026', sub: 'Will be issued 1 Oct 2026', amount: '€4,080.00', status: 'draft', statusLabel: 'Draft', statusColor: '#9CA3AF', dot: 'empty', past: false },
                      { label: 'Nov 2026', sub: 'Will be issued 1 Nov 2026', amount: '€4,080.00', status: 'draft', statusLabel: 'Draft', statusColor: '#9CA3AF', dot: 'empty', past: false },
                    ].map((row, i) => (
                      <div key={i} className="flex items-start gap-3 py-2" style={{ borderBottom: i < 6 ? '0.5px solid rgba(26,61,43,0.06)' : 'none' }}>
                        {/* Timeline dot */}
                        <div className="flex-shrink-0 flex flex-col items-center" style={{ width: 18, paddingTop: 2 }}>
                          {row.dot === 'today' ? (
                            <div style={{ width: 14, height: 14, borderRadius: '50%', background: '#1A3D2B', border: '2px solid #1A3D2B', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                              <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#fff' }} />
                            </div>
                          ) : row.dot === 'ring' ? (
                            <div style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid #D97706', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                              <i className="ti ti-clock" style={{ fontSize: 8, color: '#D97706' }} />
                            </div>
                          ) : (
                            <div style={{ width: 14, height: 14, borderRadius: '50%', border: '1.5px solid #D1D5DB', background: '#fff' }} />
                          )}
                        </div>
                        {/* Content */}
                        <div className="flex-1">
                          <div style={{ fontSize: row.dot === 'today' ? 10 : 11, fontWeight: row.dot === 'today' ? 700 : 500, color: row.dot === 'today' ? '#1A3D2B' : '#1C1917', textTransform: row.dot === 'today' ? 'uppercase' : 'none', letterSpacing: row.dot === 'today' ? '.06em' : 'normal' }}>{row.label}</div>
                          <div style={{ fontSize: 9, color: '#9CA3AF' }}>{row.sub}</div>
                        </div>
                        {/* Amount + status */}
                        {row.amount && (
                          <div className="text-right flex-shrink-0">
                            <div className="font-mono" style={{ fontSize: 11, fontWeight: 500, color: '#1C1917' }}>{row.amount}</div>
                            <div style={{ fontSize: 9, color: row.statusColor, display: 'flex', alignItems: 'center', gap: 2, justifyContent: 'flex-end' }}>
                              <i className={`ti ${row.status === 'open' ? 'ti-clock' : 'ti-circle-dashed'}`} style={{ fontSize: 10 }} />
                              {row.statusLabel}
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
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

/* ─────────────── REMEMBILL LIVE PROOF SECTION ─────────────── */
function RemembillProofSection() {
  const steps = [
    { num: '01', title: 'Agreement', body: 'Commercial terms extracted from Remembill’s signed contract.' },
    { num: '02', title: 'Usage', body: 'Required billing metric pulled from the Remembill platform.' },
    { num: '03', title: 'Billing logic', body: 'Verdix applies the agreed rates, tiers and billing period.' },
    { num: '04', title: 'Review', body: 'The billing owner reviews the result with clause-level evidence.' },
  ]
  return (
    <section className="px-6 py-24 border-t border-forest/8">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-10 max-w-2xl mx-auto">
          <div className="text-xs font-medium uppercase tracking-widest text-sage mb-3">Live design partner pilot</div>
          <h2 className="font-display font-light text-ink text-3xl leading-tight mb-4">Remembill is using Verdix on its own enterprise contract</h2>
          <p className="text-stone leading-relaxed">Its signed agreement enters Verdix, usage is pulled directly from the Remembill platform, and the resulting billing logic stays reviewable by the billing owner.</p>
        </div>

        <div className="bg-white border border-forest/10 rounded-2xl p-6 mb-6">
          <div className="text-xs font-semibold uppercase tracking-widest mb-4" style={{ color: '#27500A' }}>Remembill using Verdix</div>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            {steps.map((s, i) => (
              <div key={s.num} className="flex items-start gap-2">
                <div className="flex-1 rounded-xl p-4" style={{ background: '#F7F5F0' }}>
                  <div className="text-xs font-semibold mb-1.5" style={{ color: '#27500A' }}>{s.num} — {s.title}</div>
                  <div className="text-xs text-stone leading-relaxed">{s.body}</div>
                </div>
                {i < steps.length - 1 && (
                  <i className="ti ti-arrow-right hidden sm:block flex-shrink-0 mt-4" style={{ fontSize: 16, color: '#C0DD97' }} />
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl p-6" style={{ background: '#1A3D2B' }}>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <div className="text-xs font-semibold uppercase tracking-widest mb-1.5" style={{ color: '#8FD19E' }}>Approved billing flows into your existing stack</div>
              <p className="text-sm" style={{ color: 'rgba(255,255,255,0.78)' }}>Nothing moves until the result is approved.</p>
            </div>
            <div className="flex items-center gap-2 text-sm flex-wrap">
              <span className="rounded-full px-3 py-1.5 font-medium whitespace-nowrap" style={{ background: 'rgba(255,255,255,0.1)', color: '#fff' }}>Verdix</span>
              <i className="ti ti-arrow-right flex-shrink-0" style={{ color: '#8FD19E', fontSize: 14 }} />
              <span className="text-xs whitespace-nowrap" style={{ color: 'rgba(255,255,255,0.6)' }}>Approved invoice</span>
              <i className="ti ti-arrow-right flex-shrink-0" style={{ color: '#8FD19E', fontSize: 14 }} />
              <span className="rounded-full px-3 py-1.5 font-medium whitespace-nowrap" style={{ background: 'rgba(255,255,255,0.1)', color: '#fff' }}>Remembill · Stripe</span>
            </div>
          </div>
        </div>
        <p className="text-stone text-sm mt-6 max-w-3xl mx-auto text-center">Verdix connects the agreement to the operational data, then sends the approved billing result into the billing and finance stack you already run.</p>
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
          <div className="overflow-x-auto order-2 lg:order-1 -mx-6 px-6 lg:mx-0 lg:px-0">
          <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden shadow-sm" style={{ fontSize: 12, minWidth: 480 }}>
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
          </div>
          {/* Copy */}
          <div className="order-1 lg:order-2">
            <div className="text-xs font-medium uppercase tracking-widest text-sage mb-3">Agreement-to-billing automation</div>
            <h2 className="font-display font-light text-ink text-3xl leading-tight mb-4">From signed agreement to reviewed billing configuration</h2>
            <p className="text-stone leading-relaxed mb-8">Verdix extracts the commercial logic, identifies the required usage, calculates the billing instruction and sends the approved result into your existing stack. For connected workflows, processing can begin automatically when a deal is signed or marked Closed Won.</p>
            <ul className="space-y-3">
              {[
                'Commercial terms extracted and structured from the signed contract',
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
              <span style={{ fontSize: 10, fontWeight: 500, color: '#27500A' }}>ALSO BUILT ON THE SAME AGREEMENT LOGIC</span>
            </div>
            <div className="text-xs font-medium uppercase tracking-widest text-sage mb-3">Partner reconciliation</div>
            <h2 className="font-display font-light text-ink text-3xl leading-tight mb-4">Verify partner charges before you pay them</h2>
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
          <div className="overflow-x-auto -mx-6 px-6 lg:mx-0 lg:px-0">
          <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden shadow-sm" style={{ fontSize: 12, minWidth: 480 }}>
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
                  <div key={i} className="font-mono" style={{ fontSize: 8, fontWeight: 500, background: '#EAF3DE', color: '#27500A', borderRadius: 4, padding: '2px 5px', display: 'inline-block', marginBottom: 3 }}>{label}</div>
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
                <div className="font-mono" style={{ fontSize: 9, fontWeight: 500, background: '#EAF3DE', color: '#27500A', borderRadius: 5, padding: '3px 7px', display: 'inline-block' }}>sub_abc123 created</div>
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
          <div className="text-xs font-medium uppercase tracking-widest text-sage mb-3">Built for finance &amp; RevOps to trust</div>
          <h2 className="font-display font-light text-ink text-3xl leading-tight mb-4">Click any rate. Land on the clause that set it.</h2>
          <p className="text-stone leading-relaxed">Every billing calculation keeps its evidence — the contract term, source usage and applied logic. No black-box billing decisions.</p>
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
                      <td className="font-mono" style={{ padding: '5px 8px', fontSize: 9, color: r.red ? '#791F1F' : '#6B6660' }}>{r.calc}</td>
                      <td className="font-mono" style={{ padding: '5px 0 5px 8px', fontSize: 10, fontWeight: 500, color: r.red ? '#A32D2D' : '#1A3D2B', textAlign: 'right' }}>{r.inv}</td>
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
          <div className="text-xs font-medium uppercase tracking-widest text-sage mb-3">Built for sensitive commercial agreements</div>
          <h2 className="font-display font-light text-ink text-2xl mb-3">Designed around European data requirements</h2>
          <p className="text-stone text-sm max-w-lg mx-auto">Designed around GDPR and European data-residency requirements.</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-3xl mx-auto">
          {[
            { icon: 'ti-shield-lock', title: 'EU-based architecture', desc: 'Customer data is processed within European infrastructure.' },
            { icon: 'ti-eye-off', title: 'Masked before AI processing', desc: 'Sensitive identifiers are masked before contract text reaches the model layer.' },
            { icon: 'ti-ban', title: 'No training on your contracts', desc: 'Your agreements are not used to train AI models.' },
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

/* ─────────────── PRICING ─────────────── */
function Pricing() {
  const plans = [
    {
      id: 'free',
      name: 'Free',
      price: '€0',
      period: '',
      badge: null,
      highlight: false,
      features: [
        'Manual upload – Contractual agreements',
        '3 agreements processed: customer billing or partner reconciliation',
        'Contract terms extracted automatically',
        'Usage pulled from your connected endpoint',
        'Approved billing schedules sent to your preferred billing platform',
        'PII masking included',
      ],
      bestFor: 'Founders and Finance or RevOps teams that want to test Verdix using a small number of bespoke customer or partner agreements.',
      cta: 'Try 3 runs free',
      href: '/signup',
    },
    {
      id: 'payg',
      name: 'Pay as you go',
      price: '€10',
      period: 'per agreement processed',
      badge: 'Best for getting started',
      badgeHighlight: false,
      highlight: false,
      features: [
        'Manual upload – Contractual agreements',
        'Customer billing or partner invoice reconciliation',
        'No monthly subscription',
        'Automated usage retrieval from your connected endpoint',
        'Approved billing schedules sent to your preferred billing platform',
        'Agreement-linked calculation trace',
        'PII masking included',
      ],
      bestFor: 'Early-stage and smaller B2B SaaS, AI, fintech and platform companies with irregular processing volumes or fewer than approximately 40 agreement workflows per month.',
      cta: 'Start pay as you go',
      href: '/signup?plan=payg',
    },
    {
      id: 'scale',
      name: 'Scale',
      price: '€399',
      period: '/month',
      badge: 'Best value',
      badgeHighlight: true,
      highlight: true,
      features: [
        'Manual upload – Contractual agreements',
        '100 agreements processed included: customer billing or partner reconciliation',
        '€3 per additional agreement processed',
        'Automated usage retrieval from multiple connected endpoints',
        'Approved billing schedules sent to your preferred billing platforms',
        'Multiple customer and partner agreements',
        'Team access and priority support',
        'PII masking included',
      ],
      bestFor: 'Growing B2B SaaS, fintech, marketplace and digital-platform companies with recurring bespoke billing, multiple partner agreements and collaborative Finance, RevOps or Partner Operations teams.',
      cta: 'Start with Scale',
      href: '/signup?plan=scale',
    },
    {
      id: 'enterprise',
      name: 'Enterprise',
      price: 'Custom',
      period: '',
      badge: null,
      highlight: false,
      features: [
        'Custom agreement-processing volumes',
        'Volume-based pricing',
        'Dedicated EU environment',
        'SSO and role-based access',
        'Advanced audit logs and retention controls',
        'Custom billing, ERP and payment integrations',
        'SLA and dedicated support',
      ],
      bestFor: 'Larger Nordic and European companies, regulated businesses and multi-entity organisations with complex customer and partner agreements, advanced security requirements and custom finance infrastructure.',
      cta: 'Talk to us',
      href: 'mailto:bilal@lynoraai.com?subject=Verdix Enterprise',
    },
  ]

  return (
    <section id="pricing" className="px-6 py-24 border-t border-forest/8">
      <div className="max-w-5xl mx-auto">
        <div className="text-center mb-4">
          <div className="text-xs font-medium uppercase tracking-widest text-sage mb-3">Pricing</div>
          <h2 className="font-display font-light text-ink text-3xl leading-tight mb-4">Pay only when Verdix completes an agreement workflow</h2>
          <p className="text-stone max-w-2xl mx-auto leading-relaxed mb-2">No percentage of revenue, no charge per raw usage event, and no requirement to replace your billing or payment infrastructure.</p>
          <p className="text-stone text-sm max-w-2xl mx-auto leading-relaxed mb-10">Built for B2B SaaS, AI, fintech, marketplace and digital-platform companies managing bespoke customer or partner agreements—especially Finance, RevOps, Billing Operations and Partner Operations teams that want automation while keeping their existing systems.</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          {plans.map(plan => (
            <div
              key={plan.id}
              className="bg-white rounded-2xl flex flex-col overflow-hidden"
              style={{ border: plan.highlight ? '1.5px solid #1A3D2B' : '1px solid rgba(26,61,43,0.10)' }}
            >
              {plan.badge ? (
                <div
                  className="text-center text-[11px] font-semibold py-1.5 tracking-wide"
                  style={{ background: (plan as {badgeHighlight?: boolean}).badgeHighlight ? '#1A3D2B' : '#EAF3DE', color: (plan as {badgeHighlight?: boolean}).badgeHighlight ? '#fff' : '#27500A' }}
                >
                  {plan.badge}
                </div>
              ) : <div className="h-[26px]" />}

              <div className="p-5 flex flex-col flex-1">
                {/* Price section — min-h so all cards reach the same baseline */}
                <div className="mb-4 min-h-[56px]">
                  <div className="text-[11px] font-semibold text-stone uppercase tracking-widest mb-2">{plan.name}</div>
                  <div className="flex items-baseline gap-1 flex-wrap">
                    <span className="text-2xl font-semibold text-ink">{plan.price}</span>
                    {plan.period && <span className="text-stone text-xs leading-tight">{plan.period}</span>}
                  </div>
                </div>

                {/* Best suited for — immediately after price so it aligns across all cards */}
                <div className="mb-4 pb-4" style={{ borderBottom: '0.5px solid rgba(26,61,43,0.08)' }}>
                  <div className="text-[10px] font-semibold uppercase tracking-widest text-stone mb-1.5">Best suited for</div>
                  <p className="text-[11px] text-stone leading-relaxed">{plan.bestFor}</p>
                </div>

                <ul className="space-y-2 mb-4 flex-1">
                  {plan.features.map(f => (
                    <li key={f} className="flex items-start gap-2 text-xs text-stone leading-relaxed">
                      <div className="w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5" style={{ background: '#EAF3DE' }}>
                        <i className="ti ti-check" style={{ fontSize: 9, color: '#27500A' }} />
                      </div>
                      {f}
                    </li>
                  ))}
                </ul>

                <div />

                <Link
                  href={plan.href}
                  className="block text-center text-sm font-medium py-2.5 rounded-xl transition-colors"
                  style={
                    plan.highlight
                      ? { background: '#27AE60', color: '#fff' }
                      : { background: 'transparent', color: '#1A3D2B', border: '1px solid rgba(26,61,43,0.25)' }
                  }
                >
                  {plan.cta}
                </Link>
              </div>
            </div>
          ))}
        </div>

        {/* What counts as one agreement processed */}
        <div className="bg-white border border-forest/10 rounded-2xl p-6 mb-8">
          <div className="text-[11px] font-semibold uppercase tracking-widest text-stone mb-3">What counts as one agreement processed?</div>
          <p className="text-sm text-stone leading-relaxed mb-3">One agreement processed is either:</p>
          <ul className="space-y-1.5 mb-4">
            {[
              'one customer billing cycle generated from an agreement and its associated usage data; or',
              'one partner invoice reconciled against the relevant agreement and operational data.',
            ].map(item => (
              <li key={item} className="flex items-start gap-2 text-sm text-stone leading-relaxed">
                <div className="w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5" style={{ background: '#EAF3DE' }}>
                  <i className="ti ti-check" style={{ fontSize: 9, color: '#27500A' }} />
                </div>
                {item}
              </li>
            ))}
          </ul>
          <p className="text-sm text-stone leading-relaxed">Start free or use Pay as you go, then move to Scale as your processing volume grows.</p>
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
          <h2 className="font-display font-light text-3xl mb-4" style={{ color: '#1A3D2B' }}>From signed agreement to billing and reconciliation—automatically</h2>
          <p className="leading-relaxed mb-10" style={{ color: '#27500A' }}>Connect a customer or partner agreement, your usage endpoint, and your preferred billing or payment system. Verdix pulls the required operational data, creates customer billing schedules, sends invoice instructions to your existing stack, and validates partner charges before payment.</p>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
            <Link href="/signup" className="inline-block text-white font-medium px-8 py-4 rounded-xl transition-colors shadow-md text-sm" style={{ background: '#27AE60' }}
              onMouseOver={e => (e.currentTarget.style.background = '#219150')}
              onMouseOut={e => (e.currentTarget.style.background = '#27AE60')}
            >
              Automate your first agreement →
            </Link>
            <Link href="/design-partner" className="inline-block font-medium px-8 py-4 rounded-xl text-sm" style={{ background: '#EAF3DE', color: '#1A3D2B', border: '0.5px solid #C0DD97' }}>
              Apply as a Design Partner →
            </Link>
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
          <div>
            <div className="font-sans font-semibold leading-tight" style={{ color: '#1A3D2B', letterSpacing: '0.02em' }}>Verdix — Agreement-to-billing for complex B2B contracts</div>
            <div className="text-stone text-xs leading-tight">A product by Lynora AB · Sweden</div>
          </div>
        </div>
        <div className="flex items-center gap-8 text-sm text-stone">
          <Link href="/privacy" className="hover:text-forest transition-colors">Privacy Policy</Link>
          <Link href="/terms" className="hover:text-forest transition-colors">Terms</Link>
          <a href="mailto:bilal@lynoraai.com" className="hover:text-forest transition-colors">Contact</a>
        </div>
        <div className="text-xs text-stone">© 2026 Verdix. All rights reserved.</div>
      </div>
      <div className="max-w-6xl mx-auto mt-5 pt-5 border-t border-forest/8 text-center text-xs text-stone/60">
        Verdix is a product by Lynora AB · Org. nr 559516-1190 · Sweden
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
      <ProblemSection />
      <BillingVerificationSection />
      <RemembillProofSection />
      <HowItWorks />
      <CalculationBreakdown />
      <Security />
      <AutoConfigureSection />
      <PartnerReconciliationSection />
      <Pricing />
      <CTA />
      <Footer />
    </>
  )
}
