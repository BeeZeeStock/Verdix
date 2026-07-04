'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

const AGREEMENT_TYPES = ['Reseller', 'Payment processor', 'Technology partner', 'Supplier', 'Distribution', 'Other']

function autoName(partner: string) {
  const month = new Date().toLocaleDateString('en-IE', { month: 'long', year: 'numeric' })
  return `${partner} — ${month}`
}

export default function NewPartnerPage() {
  const router = useRouter()
  const [step, setStep] = useState(1)
  const [partnerName, setPartnerName] = useState('')
  const [agreementType, setAgreementType] = useState('')
  const [agreement, setAgreement] = useState<File | null>(null)
  const [invoice, setInvoice] = useState<File | null>(null)
  const [loading, setLoading] = useState(false)

  const handleFile = (setter: (f: File) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (f) setter(f)
  }

  const loadDemo = async () => {
    setPartnerName('Nets A/S')
    setAgreementType('Payment processor')
    const [agRes, invRes] = await Promise.all([
      fetch('/demo/nets-helios-agreement.pdf'),
      fetch('/demo/invoice-nets-2024-0847.pdf'),
    ])
    const [agBuf, invBuf] = await Promise.all([agRes.arrayBuffer(), invRes.arrayBuffer()])
    setAgreement(new File([agBuf], 'nets-helios-agreement.pdf', { type: 'application/pdf' }))
    setInvoice(new File([invBuf], 'invoice-nets-2024-0847.pdf', { type: 'application/pdf' }))
    setStep(3)
  }

  const handleStart = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: autoName(partnerName), module: 'PARTNER_RECON', currency: 'EUR' }),
      })
      const { jobId } = await res.json()
      if (agreement) {
        const fd = new FormData(); fd.append('file', agreement); fd.append('jobId', jobId); fd.append('fileType', 'contract')
        await fetch('/api/upload', { method: 'POST', body: fd })
      }
      if (invoice) {
        const fd = new FormData(); fd.append('file', invoice); fd.append('jobId', jobId); fd.append('fileType', 'billing')
        await fetch('/api/upload', { method: 'POST', body: fd })
      }
      router.push(`/partner/${jobId}`)
    } catch { setLoading(false) }
  }

  const STEPS = ['Partner details', 'Upload files', 'Review & start']

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <div className="mb-8 flex items-start justify-between">
        <div>
          <Link href="/partner" className="text-sm text-stone hover:text-forest flex items-center gap-1 mb-4">
            <i className="ti ti-arrow-left" style={{ fontSize: 13 }} /> Back
          </Link>
          <h1 className="font-display font-light text-ink text-2xl">New partner reconciliation</h1>
        </div>
        <button
          onClick={loadDemo}
          className="flex items-center gap-1.5 text-xs text-stone border border-forest/15 px-3 py-2 rounded-xl hover:bg-cream hover:text-forest transition-colors mt-2"
        >
          <i className="ti ti-sparkles" style={{ fontSize: 12 }} /> Try demo
        </button>
      </div>

      {/* Progress */}
      <div className="flex items-center gap-3 mb-10">
        {STEPS.map((label, i) => {
          const s = i + 1
          return (
            <div key={s} className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium"
                  style={{ background: s <= step ? '#1A3D2B' : '#E5E0D8', color: s <= step ? '#fff' : '#6B6660' }}>
                  {s < step ? <i className="ti ti-check" style={{ fontSize: 11 }} /> : s}
                </div>
                <span className="text-sm" style={{ color: s === step ? '#1A3D2B' : '#6B6660', fontWeight: s === step ? 500 : 400 }}>
                  {label}
                </span>
              </div>
              {s < STEPS.length && <div className="h-px bg-forest/15 w-8" />}
            </div>
          )
        })}
      </div>

      {/* Step 1 — Partner details */}
      {step === 1 && (
        <div className="bg-white border border-forest/10 rounded-2xl p-8 space-y-5">
          <div>
            <label className="block text-xs font-medium text-stone uppercase tracking-widest mb-2">Partner company</label>
            <input
              type="text"
              value={partnerName}
              onChange={e => setPartnerName(e.target.value)}
              placeholder="e.g. Nets A/S"
              className="w-full bg-cream border border-forest/15 rounded-xl px-4 py-3 text-sm text-ink outline-none focus:border-forest focus:bg-white transition-colors"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-stone uppercase tracking-widest mb-2">Agreement type</label>
            <select
              value={agreementType}
              onChange={e => setAgreementType(e.target.value)}
              className="w-full bg-cream border border-forest/15 rounded-xl px-4 py-3 text-sm text-ink outline-none focus:border-forest focus:bg-white transition-colors"
            >
              <option value="">Select type…</option>
              {AGREEMENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="flex justify-end">
            <button
              onClick={() => setStep(2)}
              disabled={!partnerName}
              className="bg-forest text-white text-sm font-medium px-6 py-3 rounded-xl hover:bg-sage transition-colors disabled:opacity-40"
            >
              Next →
            </button>
          </div>
        </div>
      )}

      {/* Step 2 — Upload files */}
      {step === 2 && (
        <div className="bg-white border border-forest/10 rounded-2xl p-8 space-y-6">
          <div className="grid grid-cols-2 gap-6">
            {[
              { label: 'Partner agreement', sub: 'Signed reseller or supplier agreement', id: 'agr', accept: '.pdf', file: agreement, set: (f: File) => setAgreement(f) },
              { label: 'Invoice received', sub: 'PDF or CSV invoice from the partner', id: 'inv', accept: '.pdf,.csv,.xlsx', file: invoice, set: (f: File) => setInvoice(f) },
            ].map(z => (
              <div key={z.id}>
                <label className="block text-xs font-medium text-stone uppercase tracking-widest mb-2">{z.label}</label>
                <div
                  onClick={() => document.getElementById(z.id)?.click()}
                  className="border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer hover:border-forest/40 transition-colors"
                  style={{ borderColor: 'rgba(26,61,43,0.2)' }}
                >
                  <input id={z.id} type="file" accept={z.accept} className="sr-only" onChange={handleFile(z.set)} />
                  {z.file ? (
                    <div>
                      <p className="text-sm font-medium text-ink">{z.file.name}</p>
                      <p className="text-xs text-stone mt-1">{(z.file.size / 1024).toFixed(0)} KB</p>
                    </div>
                  ) : (
                    <>
                      <i className="ti ti-upload text-forest/30 block mb-2" style={{ fontSize: 24 }} />
                      <p className="text-xs text-stone">{z.sub}</p>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="flex justify-between">
            <button onClick={() => setStep(1)} className="border border-forest/20 text-stone text-sm font-medium px-6 py-3 rounded-xl hover:bg-cream transition-colors">← Back</button>
            <button
              onClick={() => setStep(3)}
              disabled={!agreement || !invoice}
              className="bg-forest text-white text-sm font-medium px-6 py-3 rounded-xl hover:bg-sage transition-colors disabled:opacity-40"
            >
              Next →
            </button>
          </div>
        </div>
      )}

      {/* Step 3 — Review */}
      {step === 3 && (
        <div className="bg-white border border-forest/10 rounded-2xl p-8 space-y-6">
          <div className="bg-parchment border border-forest/10 rounded-xl p-5 space-y-2.5 text-sm">
            {[
              ['Partner', partnerName],
              ['Agreement type', agreementType || '—'],
              ['Agreement file', agreement?.name],
              ['Invoice file', invoice?.name],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between">
                <span className="text-stone">{k}</span>
                <span className="font-medium text-ink text-right max-w-xs truncate">{v}</span>
              </div>
            ))}
          </div>
          <div className="bg-mint/40 border border-sage/20 rounded-xl p-4 text-xs text-forest/70 leading-relaxed">
            Files encrypted and stored in Frankfurt, Germany (EU). Contract text sent to AI processor for extraction, raw text not retained.
          </div>
          <div className="flex justify-between">
            <button onClick={() => setStep(2)} className="border border-forest/20 text-stone text-sm font-medium px-6 py-3 rounded-xl hover:bg-cream transition-colors">← Back</button>
            <button
              onClick={handleStart}
              disabled={loading}
              className="bg-forest text-white text-sm font-medium px-8 py-3 rounded-xl hover:bg-sage transition-colors disabled:opacity-60 flex items-center gap-2"
            >
              {loading
                ? <><i className="ti ti-loader-2 animate-spin" style={{ fontSize: 14 }} /> Processing…</>
                : 'Start reconciliation →'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
