'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { UPLOAD_PROGRESS_STAGES, type UploadProgressStage } from '@/lib/upload-progress-stages'

export default function NewConfigurePage() {
  const router = useRouter()
  const [file, setFile] = useState<File | null>(null)
  const [dragging, setDragging] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<{ text: string; billing?: boolean } | null>(null)
  // Preserved once job creation + Storage upload succeed, so a later
  // processing (detect-pii) failure can retry against the SAME job and the
  // SAME already-uploaded file — see runProcessing/handleRetryProcessing.
  // Never cleared on a processing failure; only ever set once, on success.
  const [jobId, setJobId] = useState<string | null>(null)
  // True only for a processing-stage failure that happened AFTER job
  // creation + upload were already durable — gates the graceful "we
  // couldn't finish processing" panel instead of the generic error banner.
  // The raw exception (e.g. the Bedrock/AWS infra timeout text) is never
  // read into this state — it stays server-side, in the job's own
  // error_message, for diagnostics only.
  const [processingFailed, setProcessingFailed] = useState(false)
  const [stage, setStage] = useState<UploadProgressStage | null>(null)

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false)
    const f = e.dataTransfer.files[0]
    if (f) setFile(f)
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f) setFile(f)
  }

  // Processing only — never touches job creation or file upload. Shared by
  // the first attempt (called right after a fresh upload succeeds) and by
  // Retry processing (called again for an already-created job, skipping
  // straight to this step).
  //
  // Step 17A, item 6 — 'reading'->'checking' used to be inferred purely
  // from this function's own fetch-call boundaries (an instant, fake
  // transition the instant the SINGLE detect-pii request resolved, with no
  // way to ever visually show "checking" as genuinely in progress, since
  // that route does the text extraction AND the PII pass inside one call).
  // Now driven by the job's own real execute_status, polled concurrently
  // from GET /api/jobs/[id] while the request is in flight — the same
  // 'DETECTING_PII' -> 'CHECKING_PII' transition detect-pii/route.ts itself
  // writes. 'done' (both checkmarks) is only ever set AFTER the detect-pii
  // request has actually resolved successfully — never claimed early.
  const runProcessing = async (id: string) => {
    setStage('reading')
    let polling = true
    const pollStatus = async () => {
      while (polling) {
        await new Promise(resolve => setTimeout(resolve, 400))
        if (!polling) return
        try {
          const res = await fetch(`/api/jobs/${id}`)
          if (!res.ok) continue
          const data = await res.json()
          if (!polling) return
          if (data.execute_status === 'CHECKING_PII') setStage('checking')
        } catch {
          // Best-effort only — the detect-pii request below is the
          // authoritative signal for success/failure regardless.
        }
      }
    }
    const pollPromise = pollStatus()

    try {
      const piiRes = await fetch(`/api/jobs/${id}/detect-pii`, { method: 'POST' })
      polling = false
      await pollPromise
      if (!piiRes.ok) {
        if (piiRes.status === 403) {
          // PII masking not on plan — skip PII review, trigger extraction directly
          await fetch(`/api/jobs/${id}/execute`, { method: 'POST' })
          router.push(`/configure/${id}`)
          return
        }
        // Processing failed, but the job + uploaded document are already
        // durable — the graceful retry panel, never the raw error text.
        setProcessingFailed(true)
        setLoading(false)
        setStage(null)
        return
      }
      setStage('done')
      // A brief, deliberate pause so the completed checklist (both
      // checkmarks) is actually visible before navigating away — not a
      // fake progress delay, the work itself is already genuinely done by
      // this point.
      await new Promise(resolve => setTimeout(resolve, 500))
      router.push(`/configure/${id}/pii-review`)
    } catch {
      polling = false
      await pollPromise
      setProcessingFailed(true)
      setLoading(false)
      setStage(null)
    }
  }

  const handleUpload = async () => {
    if (!file) return
    setLoading(true)
    setError(null)
    setProcessingFailed(false)
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name.replace(/\.[^/.]+$/, ''), module: 'AUTO_CONFIGURE', currency: 'USD' }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError({ text: body.error ?? 'Could not create this job. Please try again.' })
        setLoading(false)
        return
      }
      const { jobId: newJobId } = await res.json()
      setJobId(newJobId)

      const fd = new FormData(); fd.append('file', file); fd.append('jobId', newJobId); fd.append('fileType', 'signed_contract')
      const uploadRes = await fetch('/api/upload', { method: 'POST', body: fd })
      if (!uploadRes.ok) {
        const body = await uploadRes.json().catch(() => ({}))
        setError({ text: body.error ?? 'File upload failed. Please try again.' })
        setLoading(false)
        return
      }

      await runProcessing(newJobId)
    } catch { setLoading(false) }
  }

  // Retries processing ONLY, against the same job ID and the file already
  // sitting in Storage from the original upload. Never POSTs /api/jobs or
  // /api/upload again — no duplicate job, no duplicate Storage object.
  const handleRetryProcessing = async () => {
    if (!jobId) return
    setLoading(true)
    setProcessingFailed(false)
    await runProcessing(jobId)
  }

  if (processingFailed && jobId) {
    return (
      <div className="p-4 md:p-8 max-w-2xl mx-auto">
        <div className="mb-8">
          <Link href="/configure" className="text-sm text-stone hover:text-forest flex items-center gap-1 mb-4">
            <i className="ti ti-arrow-left" style={{ fontSize: 13 }} /> Back
          </Link>
        </div>
        <div className="bg-white border border-amber-200 rounded-2xl p-8 text-center space-y-4">
          <i className="ti ti-alert-triangle text-amber-600 block" style={{ fontSize: 32 }} />
          <h1 className="font-display font-light text-ink text-xl">We couldn&apos;t finish processing this agreement</h1>
          <p className="text-stone text-sm leading-relaxed">
            Your agreement is saved, but document analysis did not complete.
            <br />
            No billing configuration has been activated.
          </p>
          <div className="flex items-center justify-center gap-3 pt-2">
            <button
              onClick={handleRetryProcessing}
              disabled={loading}
              className="bg-forest text-white text-sm font-medium px-5 py-2.5 rounded-xl hover:bg-sage transition-colors disabled:opacity-40 flex items-center gap-2"
            >
              {loading
                ? <><i className="ti ti-loader-2 animate-spin" style={{ fontSize: 14 }} /> Retrying…</>
                : 'Retry processing'
              }
            </button>
            <Link
              href="/configure"
              className="text-sm font-medium px-5 py-2.5 rounded-xl border border-forest/20 text-forest hover:bg-forest/5 transition-colors"
            >
              Back to agreements
            </Link>
          </div>
        </div>
      </div>
    )
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

        {/* Progress — distinguishes the PDF-reading sub-step from local PII
            checking (and previews the later, separate commercial-term
            extraction step) rather than labeling everything "Processing"
            or implying the slow Bedrock extraction call IS PII masking.
            See lib/upload-progress-stages.ts for exactly what each stage
            does and doesn't correspond to. */}
        {loading && (
          <ul className="space-y-1.5" aria-label="Processing steps">
            {UPLOAD_PROGRESS_STAGES.map((s, i) => {
              // 'done' is a terminal marker past the last real stage — both
              // items render as complete, none active.
              const activeIndex = stage === 'done'
                ? UPLOAD_PROGRESS_STAGES.length
                : UPLOAD_PROGRESS_STAGES.findIndex(x => x.key === stage)
              const isActive = s.key === stage
              const isDone = activeIndex > -1 && i < activeIndex
              return (
                <li
                  key={s.key}
                  className={`text-xs flex items-center gap-1.5 ${isActive ? 'text-ink font-medium' : 'text-stone'}`}
                >
                  <i
                    className={`ti ${isDone ? 'ti-circle-check' : isActive ? 'ti-loader-2 animate-spin' : 'ti-circle-dashed'}`}
                    style={{ fontSize: 12 }}
                  />
                  {s.label}
                </li>
              )
            })}
          </ul>
        )}

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
