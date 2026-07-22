'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

export default function NewConfigurePage() {
  const router = useRouter()
  const [file, setFile] = useState<File | null>(null)
  const [dragging, setDragging] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<{ text: string; billing?: boolean } | null>(null)

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false)
    const f = e.dataTransfer.files[0]
    if (f) setFile(f)
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f) setFile(f)
  }

  const handleUpload = async () => {
    if (!file) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name.replace(/\.[^/.]+$/, ''), module: 'AUTO_CONFIGURE', currency: 'USD' }),
      })
      const { jobId } = await res.json()
      const fd = new FormData(); fd.append('file', file); fd.append('jobId', jobId); fd.append('fileType', 'signed_contract')
      const uploadRes = await fetch('/api/upload', { method: 'POST', body: fd })
      if (!uploadRes.ok) {
        const body = await uploadRes.json().catch(() => ({}))
        setError({ text: body.error ?? 'File upload failed. Please try again.' })
        setLoading(false)
        return
      }
      // Detect PII before extraction — user reviews findings first
      const piiRes = await fetch(`/api/jobs/${jobId}/detect-pii`, { method: 'POST' })
      if (!piiRes.ok) {
        if (piiRes.status === 403) {
          // PII masking not on plan — skip PII review, go straight to extraction
          router.push(`/configure/${jobId}`)
          return
        }
        const body = await piiRes.json().catch(() => ({}))
        setError({ text: body.error ?? 'PII detection failed. Please try again.' })
        setLoading(false)
        return
      }
      router.push(`/configure/${jobId}/pii-review`)
    } catch { setLoading(false) }
  }

  return (
    <div className="p-4 md:p-8 max-w-2xl mx-auto">
      <div className="mb-8">
        <Link href="/configure" className="text-sm text-stone hover:text-forest flex items-center gap-1 mb-4">
          <i className="ti ti-arrow-left" style={{ fontSize: 13 }} /> Back
        </Link>
        <h1 className="font-display font-light text-ink text-2xl">Upload new contract</h1>
        <p className="text-stone text-sm mt-1">Verdix will extract commercial terms and propose billing configuration</p>
      </div>

      <div className="bg-white border border-forest/10 rounded-2xl p-8 space-y-6">
        {/* Manual upload */}
        <div>
          <h2 className="font-medium text-ink text-sm mb-4 flex items-center gap-2">
            <i className="ti ti-upload text-forest" style={{ fontSize: 14 }} /> Manual upload
          </h2>
          <div
            onDragOver={e => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={() => document.getElementById('contract-file')?.click()}
            className="border-2 border-dashed rounded-2xl p-10 text-center cursor-pointer transition-colors"
            style={{ borderColor: dragging ? '#1A3D2B' : 'rgba(26,61,43,0.2)', background: dragging ? '#EAF3DE' : 'transparent' }}
          >
            <input id="contract-file" type="file" accept=".pdf" className="sr-only" onChange={handleChange} />
            <i className="ti ti-file-text text-forest/40 block mb-3" style={{ fontSize: 36 }} />
            {file ? (
              <div>
                <p className="text-sm font-medium text-ink mb-1">{file.name}</p>
                <p className="text-xs text-stone">{(file.size / 1024).toFixed(0)} KB · PDF</p>
              </div>
            ) : (
              <>
                <p className="text-sm text-stone mb-1">Drop your signed contract PDF here</p>
                <p className="text-xs text-stone/50">or click to browse · PDF only</p>
              </>
            )}
          </div>
        </div>


        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">
            <p className="font-medium mb-0.5">⚠ {error.text}</p>
            {error.billing && (
              <p className="text-xs text-red-600">
                Enable it in{' '}
                <Link href="/settings/billing" className="underline underline-offset-2 font-medium">
                  Settings → Billing
                </Link>
                , then try again.
              </p>
            )}
          </div>
        )}

        <button
          onClick={handleUpload}
          disabled={!file || loading}
          className="w-full bg-forest text-white text-sm font-medium py-3 rounded-xl hover:bg-sage transition-colors disabled:opacity-40 flex items-center justify-center gap-2"
        >
          {loading ? <><i className="ti ti-loader-2 animate-spin" style={{ fontSize: 14 }} /> Processing...</> : 'Upload and process →'}
        </button>
      </div>
    </div>
  )
}
