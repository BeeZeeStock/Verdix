'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function DeleteJobButton({
  jobId,
  label = 'job',
  isConfigured = false,
}: {
  jobId: string
  label?: string
  isConfigured?: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function handleDelete() {
    const msg = isConfigured
      ? `Delete this ${label}? This will also cancel the active billing subscription in Stripe. This cannot be undone.`
      : `Delete this ${label}? This cannot be undone.`
    if (!window.confirm(msg)) return
    setBusy(true)
    try {
      const res = await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `Delete failed (${res.status})`)
      }
      router.refresh()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete. Please try again.')
      setBusy(false)
    }
  }

  return (
    <button
      onClick={handleDelete}
      disabled={busy}
      title={`Delete ${label}`}
      aria-label={`Delete ${label}`}
      className="flex items-center justify-center w-7 h-7 rounded-lg text-red-500 hover:text-red-700 hover:bg-red-50 transition-colors disabled:opacity-40"
    >
      <i className={busy ? 'ti ti-loader-2 animate-spin' : 'ti ti-trash'} style={{ fontSize: 16 }} />
    </button>
  )
}
