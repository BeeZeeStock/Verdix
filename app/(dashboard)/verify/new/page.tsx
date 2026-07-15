'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

const currencies = ['USD', 'EUR', 'GBP', 'SEK', 'NOK', 'DKK']

type FileItem = { file: File; id: string }

function UploadZone({ label, sublabel, accept, multiple, files, onFiles }: {
  label: string; sublabel: string; accept: string; multiple: boolean
  files: FileItem[]; onFiles: (files: FileItem[]) => void
}) {
  const [dragging, setDragging] = useState(false)

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false)
    const dropped = Array.from(e.dataTransfer.files).map(f => ({ file: f, id: crypto.randomUUID() }))
    onFiles(multiple ? [...files, ...dropped] : [dropped[0]])
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files ?? []).map(f => ({ file: f, id: crypto.randomUUID() }))
    onFiles(multiple ? [...files, ...selected] : [selected[0]])
    e.target.value = ''
  }

  const remove = (id: string) => onFiles(files.filter(f => f.id !== id))

  return (
    <div className="flex-1">
      <label className="block text-xs font-medium text-stone uppercase tracking-widest mb-2">{label}</label>
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        className="relative border-2 border-dashed rounded-2xl p-8 text-center transition-colors cursor-pointer"
        style={{ borderColor: dragging ? '#1A3D2B' : 'rgba(26,61,43,0.2)', background: dragging ? '#EAF3DE' : 'transparent' }}
        onClick={() => document.getElementById(`upload-${label}`)?.click()}
      >
        <input id={`upload-${label}`} type="file" accept={accept} multiple={multiple} className="sr-only" onChange={handleChange} />
        <i className="ti ti-cloud-upload text-forest/40 mb-3 block" style={{ fontSize: 28 }} />
        <p className="text-sm text-stone mb-1">{sublabel}</p>
        <p className="text-xs text-stone/50">or click to browse</p>
      </div>
      {files.length > 0 && (
        <div className="mt-3 space-y-2">
          {files.map(({ file, id }) => (
            <div key={id} className="flex items-center gap-2 bg-parchment rounded-xl px-4 py-2 text-sm min-w-0 overflow-hidden">
              <i className="ti ti-file text-forest flex-shrink-0" style={{ fontSize: 14 }} />
              <span className="truncate text-ink flex-1 min-w-0">{file.name}</span>
              <span className="text-stone text-xs flex-shrink-0 whitespace-nowrap">({(file.size / 1024).toFixed(0)} KB)</span>
              <button onClick={e => { e.stopPropagation(); remove(id) }} className="text-stone hover:text-danger flex-shrink-0">
                <i className="ti ti-x" style={{ fontSize: 12 }} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function NewVerifyPage() {
  const router = useRouter()
  const [step, setStep] = useState(1)
  const [name, setName] = useState('')
  const [currency, setCurrency] = useState('EUR')
  const [contracts, setContracts] = useState<FileItem[]>([])
  const [billing, setBilling] = useState<FileItem[]>([])
  const [loading, setLoading] = useState(false)
  const [uploadError, setUploadError] = useState('')

  const canProceedStep2 = contracts.length > 0 && billing.length > 0

  const handleStart = async () => {
    setLoading(true)
    setUploadError('')
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, module: 'BILLING_VERIFICATION', currency }),
      })
      const { jobId } = await res.json()

      for (const { file } of contracts) {
        const fd = new FormData(); fd.append('file', file); fd.append('jobId', jobId); fd.append('fileType', 'contract')
        const up = await fetch('/api/upload', { method: 'POST', body: fd })
        if (!up.ok) {
          const err = await up.json()
          throw new Error(err.error ?? 'Contract upload failed')
        }
      }
      for (const { file } of billing) {
        const fd = new FormData(); fd.append('file', file); fd.append('jobId', jobId); fd.append('fileType', 'billing')
        const up = await fetch('/api/upload', { method: 'POST', body: fd })
        if (!up.ok) {
          const err = await up.json()
          throw new Error(err.error ?? 'Billing upload failed')
        }
      }
      await fetch(`/api/jobs/${jobId}/audit`, { method: 'POST' })
      router.push(`/verify/${jobId}`)
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : 'Upload failed')
      setLoading(false)
    }
  }

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto">
      <div className="mb-8">
        <Link href="/verify" className="text-sm text-stone hover:text-forest flex items-center gap-1 mb-4">
          <i className="ti ti-arrow-left" style={{ fontSize: 13 }} /> Back to billing checks
        </Link>
        <h1 className="font-display font-light text-ink text-2xl">New billing check</h1>
      </div>

      {/* Progress */}
      <div className="flex items-center gap-3 mb-10">
        {[1, 2, 3].map(s => (
          <div key={s} className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium transition-colors"
                style={{ background: s <= step ? '#1A3D2B' : '#E5E0D8', color: s <= step ? '#fff' : '#6B6660' }}>
                {s < step ? <i className="ti ti-check" style={{ fontSize: 11 }} /> : s}
              </div>
              <span className="text-sm" style={{ color: s === step ? '#1A3D2B' : '#6B6660', fontWeight: s === step ? 500 : 400 }}>
                {['Name your audit', 'Upload files', 'Review & start'][s - 1]}
              </span>
            </div>
            {s < 3 && <div className="flex-1 h-px bg-forest/15 w-8" />}
          </div>
        ))}
      </div>

      {/* Step 1 */}
      {step === 1 && (
        <div className="bg-white border border-forest/10 rounded-2xl p-8 space-y-6">
          <div>
            <label className="block text-xs font-medium text-stone uppercase tracking-widest mb-2">Audit name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Q2 2025 Revenue Audit"
              className="w-full bg-cream border border-forest/15 rounded-xl px-4 py-3 text-sm text-ink outline-none focus:border-forest focus:bg-white transition-colors"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-stone uppercase tracking-widest mb-2">Billing currency</label>
            <select
              value={currency}
              onChange={e => setCurrency(e.target.value)}
              className="w-full bg-cream border border-forest/15 rounded-xl px-4 py-3 text-sm text-ink outline-none focus:border-forest focus:bg-white transition-colors"
            >
              {currencies.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="flex justify-end">
            <button
              onClick={() => setStep(2)}
              disabled={!name}
              className="bg-forest text-white text-sm font-medium px-6 py-3 rounded-xl hover:bg-sage transition-colors disabled:opacity-40"
            >
              Next →
            </button>
          </div>
        </div>
      )}

      {/* Step 2 */}
      {step === 2 && (
        <div className="bg-white border border-forest/10 rounded-2xl p-6 md:p-8">
          <div className="flex flex-col sm:flex-row gap-6">
            <UploadZone
              label="Contract PDFs"
              sublabel="Drop signed order forms here"
              accept=".pdf,.docx"
              multiple={true}
              files={contracts}
              onFiles={setContracts}
            />
            <UploadZone
              label="Billing Export"
              sublabel="Stripe or Chargebee CSV export"
              accept=".csv,.xlsx"
              multiple={false}
              files={billing}
              onFiles={setBilling}
            />
          </div>
          <div className="flex justify-between mt-8">
            <button onClick={() => setStep(1)} className="border border-forest/20 text-stone text-sm font-medium px-6 py-3 rounded-xl hover:bg-cream transition-colors">
              ← Back
            </button>
            <button
              onClick={() => setStep(3)}
              disabled={!canProceedStep2}
              className="bg-forest text-white text-sm font-medium px-6 py-3 rounded-xl hover:bg-sage transition-colors disabled:opacity-40"
            >
              Next →
            </button>
          </div>
        </div>
      )}

      {/* Step 3 */}
      {step === 3 && (
        <div className="bg-white border border-forest/10 rounded-2xl p-8 space-y-6">
          <div className="bg-parchment border border-forest/10 rounded-xl p-5 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-stone">Audit name</span><span className="font-medium text-ink">{name}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-stone">Currency</span><span className="font-medium text-ink">{currency}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-stone">Contracts</span><span className="font-medium text-ink">{contracts.length} file(s)</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-stone">Billing file</span><span className="font-medium text-ink">{billing[0]?.file.name}</span>
            </div>
          </div>
          <div className="bg-mint/40 border border-sage/20 rounded-xl p-4 text-xs text-forest/70 leading-relaxed">
            Files encrypted and stored in Frankfurt, Germany (EU). Contract text sent to AI processor for extraction, raw text not retained.
          </div>
          {uploadError && (
            <p className="text-xs text-danger bg-red-50 border border-red-200 rounded-xl px-4 py-3">{uploadError}</p>
          )}
          <div className="flex justify-between">
            <button onClick={() => setStep(2)} className="border border-forest/20 text-stone text-sm font-medium px-6 py-3 rounded-xl hover:bg-cream transition-colors">
              ← Back
            </button>
            <button
              onClick={handleStart}
              disabled={loading}
              className="bg-forest text-white text-sm font-medium px-8 py-3 rounded-xl hover:bg-sage transition-colors disabled:opacity-60 flex items-center gap-2"
            >
              {loading ? <><i className="ti ti-loader-2 animate-spin" style={{ fontSize: 14 }} /> Processing...</> : 'Start audit →'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
