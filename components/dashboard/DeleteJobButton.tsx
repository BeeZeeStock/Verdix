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
      className="p-1.5 rounded-lg text-stone/50 hover:text-red-500 hover:bg-red-50 transition-colors disabled:opacity-40"
    >
      <i className="ti ti-trash" style={{ fontSize: 14 }} />
    </button>
  )
}
