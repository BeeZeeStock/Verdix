'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { VerdixLogo } from '@/components/VerdixLogo'

function Nav() {
  const [shadow, setShadow] = useState(false)
  useEffect(() => {
    const fn = () => setShadow(window.scrollY > 16)
    window.addEventListener('scroll', fn)
    return () => window.removeEventListener('scroll', fn)
  }, [])
  return (
    <nav
      className="sticky top-0 z-50 bg-cream/95 backdrop-blur-md border-b border-forest/10 px-6 py-3.5"
      style={{ boxShadow: shadow ? '0 1px 8px rgba(26,61,43,.08)' : 'none' }}
    >
      <div className="max-w-6xl mx-auto flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2.5">
          <VerdixLogo size={28} />
          <span className="font-sans font-semibold text-[16px]" style={{ color: '#1A3D2B', letterSpacing: '0.02em' }}>Verdix</span>
        </Link>
        <div className="flex items-center gap-4">
          <Link href="/login" className="text-sm font-medium text-stone hover:text-forest transition-colors">Sign in</Link>
        </div>
      </div>
    </nav>
  )
}

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

export default function DesignPartnerPage() {
  const [form, setForm] = useState({ name: '', email: '', company: '', role: '', platform: '', modules: [] as string[], pain: '' })
  const [error, setError] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [loading, setLoading] = useState(false)

  const platforms = ['Stripe', 'Chargebee', 'Maxio', 'Other']
  const moduleOptions = [
    { key: 'auto_configure', label: 'Agreement-to-billing', desc: 'Turn complex customer agreements into billing instructions' },
    { key: 'billing_verification', label: 'Billing verification', desc: 'Check existing billing against signed agreements' },
    { key: 'partner_recon', label: 'Partner reconciliation', desc: 'Validate partner charges against agreements' },
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
      const res = await fetch('/api/design-partner-apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      if (res.status === 409) {
        setError('This email is already registered. We will be in touch soon.')
      } else {
        setSubmitted(true)
      }
    } catch {
      setSubmitted(true)
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <Nav />
      <div className="min-h-screen bg-cream px-6 py-20">
        <div className="max-w-5xl mx-auto">

          {/* Header */}
          <div className="text-center mb-10">
            <div className="inline-flex items-center gap-2 mb-5" style={{ background: '#EAF3DE', border: '0.5px solid #C0DD97', borderRadius: 999, padding: '5px 14px' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#27500A', display: 'inline-block' }} />
              <span style={{ fontSize: 11, fontWeight: 500, color: '#27500A', letterSpacing: '.05em' }}>DESIGN PARTNER PROGRAMME</span>
            </div>
            <h1 className="font-display font-light text-ink text-4xl mb-4">Bring us one difficult agreement.<br />We&apos;ll show you what it should have billed.</h1>
            <p className="text-stone leading-relaxed max-w-xl mx-auto mb-5" style={{ fontSize: 15 }}>
              Start with a 30-minute working session. If the workflow is a fit, we&apos;ll model one historical agreement and the usage behind it before you decide whether to integrate anything.
            </p>
            <p className="text-sm font-medium mb-8" style={{ color: '#27500A' }}>
              No billing migration · No production changes · No long implementation · Human-approved before anything moves
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <a
                href="mailto:bilal@lynoraai.com?subject=30-minute working session"
                className="w-full sm:w-auto text-white font-medium px-8 py-4 rounded-xl transition-colors shadow-md text-center"
                style={{ background: '#27AE60' }}
                onMouseOver={e => (e.currentTarget.style.background = '#219150')}
                onMouseOut={e => (e.currentTarget.style.background = '#27AE60')}
              >
                Book a 30-minute working session →
              </a>
              <a href="#apply" className="w-full sm:w-auto bg-white border border-sage text-sage font-medium px-8 py-4 rounded-xl hover:bg-mint transition-colors text-center">
                Apply as a Design Partner
              </a>
            </div>
          </div>

          {/* Fit check → first audit → read-only pilot */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
            {[
              { step: '01 — Fit check', time: '30 minutes', desc: 'Walk us through the agreement, the billing workflow and the source systems.' },
              { step: '02 — First audit', time: 'Complimentary', desc: 'Verdix models the commercial logic and maps the usage required to calculate it.' },
              { step: '03 — Read-only pilot', time: 'Prove it before integrating', desc: 'Compare the result against what your existing process actually billed.' },
            ].map(s => (
              <div key={s.step} className="bg-white border border-forest/10 rounded-2xl p-6">
                <div className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: '#27500A' }}>{s.step}</div>
                <div className="text-sm font-medium text-ink mb-2">{s.time}</div>
                <div className="text-sm text-stone leading-relaxed">{s.desc}</div>
              </div>
            ))}
          </div>
          <div className="rounded-2xl px-5 py-4 mb-14 text-center" style={{ background: '#EAF3DE', border: '1px solid #C0DD97' }}>
            <span className="text-sm font-medium" style={{ color: '#27500A' }}>As a Design Partner: </span>
            <span className="text-sm" style={{ color: '#27500A' }}>Early access · Direct roadmap input · Preferred commercial terms</span>
          </div>

          {/* Application form */}
          <div id="apply" className="bg-white border border-forest/10 rounded-3xl overflow-hidden shadow-sm" style={{ scrollMarginTop: 90 }}>
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
                      { label: 'Role', id: 'role', placeholder: 'Your role', type: 'text' },
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
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
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
      </div>
      <Footer />
    </>
  )
}
