'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function DeleteJobButton({ jobId, label = 'job' }: { jobId: string; label?: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function handleDelete() {
    if (!window.confirm(`Delete this ${label}? This cannot be undone.`)) return
    setBusy(true)
    try {
      const res = await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Delete failed')
      router.refresh()
    } catch {
      alert('Failed to delete. Please try again.')
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
