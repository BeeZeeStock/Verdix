'use client'

import { useState, useEffect, use } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

type PIIEntity = {
  id: string
  entity_type: string
  original_value: string
  token: string
  approved: boolean
  // Hardening item 2 — populated server-side (app/api/jobs/[id]/pii/route.ts)
  // from the shared-token entity-group, not client-computed. `aliases` is
  // non-empty only on the canonical row of a group; `aliasOf` is set only
  // on an alias row, naming its canonical's original_value.
  aliases?: string[]
  aliasOf?: string | null
}

type PIIOccurrence = {
  id: string
  detection_source: string
  confidence_pct: number
  pii_entity: PIIEntity
}

const TYPE_LABEL: Record<string, string> = {
  PERSON:                 'Person',
  ORG:                    'Organisation',
  EMAIL:                  'Email',
  PHONE:                  'Phone',
  IBAN:                   'IBAN',
  VAT_NUMBER:             'VAT No.',
  ADDRESS:                'Address',
  ORGANIZATION_IDENTIFIER: 'Org. reg. no.',
}

const TYPE_COLOR: Record<string, string> = {
  PERSON:                 '#7C3AED',
  ORG:                    '#2563EB',
  EMAIL:                  '#D97706',
  PHONE:                  '#0891B2',
  IBAN:                   '#DC2626',
  VAT_NUMBER:             '#DC2626',
  ADDRESS:                '#059669',
  ORGANIZATION_IDENTIFIER: '#2563EB',
}

const ENTITY_TYPES = ['PERSON', 'ORG', 'EMAIL', 'PHONE', 'IBAN', 'VAT_NUMBER', 'ADDRESS', 'ORGANIZATION_IDENTIFIER']

export default function PIIReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()

  const [occurrences, setOccurrences] = useState<PIIOccurrence[]>([])
  const [loading, setLoading] = useState(true)
  const [processing, setProcessing] = useState(false)
  const [newType, setNewType] = useState('PERSON')
  const [newValue, setNewValue] = useState('')
  const [adding, setAdding] = useState(false)
  const [showAddForm, setShowAddForm] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [discardError, setDiscardError] = useState<string | null>(null)

  const fetchEntities = async () => {
    const res = await fetch(`/api/jobs/${id}/pii`)
    if (res.ok) setOccurrences(await res.json())
    setLoading(false)
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { fetchEntities() }, [id])

  // Hardening item 3 (review pass 5) — approve/reject/ignore now apply
  // group-wide server-side (an alias and its canonical are the same
  // organisation identity — see the PATCH route's resolveAliasGroupIds).
  // A single-row optimistic local update would leave the OTHER group
  // member's row showing stale state until the next full reload, which
  // could read as "contradictory" even though the persisted decision is
  // already correct — refetching the real, group-consistent state from
  // the server after each action is simpler than duplicating the group-
  // resolution logic client-side and can never drift from what's actually
  // persisted.
  const approve = async (entityId: string) => {
    await fetch(`/api/jobs/${id}/pii`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve', entityId }),
    })
    await fetchEntities()
  }

  const reject = async (entityId: string) => {
    await fetch(`/api/jobs/${id}/pii`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reject', entityId }),
    })
    await fetchEntities()
  }

  const ignore = async (entityId: string) => {
    await fetch(`/api/jobs/${id}/pii`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'ignore', entityId }),
    })
    await fetchEntities()
  }

  const addManual = async () => {
    if (!newValue.trim()) return
    setAdding(true)
    const res = await fetch(`/api/jobs/${id}/pii`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity_type: newType, original_value: newValue.trim() }),
    })
    if (res.ok) {
      const saved = await res.json()
      setOccurrences(prev => [...prev, {
        id: saved.id,
        detection_source: 'manual',
        confidence_pct: 100,
        pii_entity: saved,
      }])
    }
    setNewValue('')
    setAdding(false)
    setShowAddForm(false)
  }

  // This is the ONLY path in this file that may start extraction — every
  // row action (approve/reject/ignore) above is PATCH-then-refetch and
  // deliberately never reaches /execute or navigates away, even once
  // pendingCount hits 0 (a previous "Extract with approved only" button
  // used to auto-appear the instant the last pending row was resolved,
  // causing an accidental click straight into extraction — removed). The
  // POST is awaited before navigating so a network failure here surfaces as
  // a real error rather than a navigation to a job that never actually
  // started.
  const approveAllAndExtract = async () => {
    setProcessing(true)
    // Approve all pending detections at once
    const pending = occurrences.filter(o => !o.pii_entity.approved)
    await Promise.all(pending.map(o =>
      fetch(`/api/jobs/${id}/pii`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve', entityId: o.pii_entity.id }),
      })
    ))
    // Kick off the main extraction pipeline
    const res = await fetch(`/api/jobs/${id}/execute`, { method: 'POST' })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setProcessing(false)
      setDiscardError(data.error ?? 'Could not start extraction — please try again.')
      return
    }
    router.push(`/configure/${id}`)
  }

  // Destructive, explicitly confirmed, exact-ID only. Mirrors the job
  // deletion discipline established earlier in Step 17A: delete this job
  // and its exclusively-owned derived rows (via DELETE /api/jobs/[id]'s
  // existing cascade), never touch pii_entities — that table is org-scoped
  // and shared across every job that has ever referenced the same
  // person/org/etc., so a discard here must never remove another job's
  // detections.
  const discardUpload = async () => {
    const confirmed = window.confirm(
      'Discard this contract upload? This will remove this job and its derived PII-review data.'
    )
    if (!confirmed) return
    setDiscarding(true)
    setDiscardError(null)
    try {
      const res = await fetch(`/api/jobs/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setDiscardError(data.error ?? 'Could not discard this upload — please try again.')
        setDiscarding(false)
        return
      }
      router.push('/configure')
    } catch {
      setDiscardError('Network error — please check your connection and try again.')
      setDiscarding(false)
    }
  }

  const approvedCount = occurrences.filter(o => o.pii_entity.approved).length
  const pendingCount  = occurrences.filter(o => !o.pii_entity.approved).length

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <Link href="/configure" className="text-sm text-stone hover:text-forest flex items-center gap-1">
            <i className="ti ti-arrow-left" style={{ fontSize: 13 }} /> Back to contracts
          </Link>
          <button
            onClick={discardUpload}
            disabled={discarding}
            aria-label="Discard this contract upload"
            title="Delete this job and its PII-review data — cannot be undone"
            className="text-xs text-stone hover:text-red-600 transition-colors flex items-center gap-1 disabled:opacity-40"
          >
            <i className="ti ti-trash" style={{ fontSize: 12 }} />
            {discarding ? 'Discarding…' : 'Discard upload'}
          </button>
        </div>
        <h1 className="font-display font-light text-ink text-2xl mb-1">PII Review</h1>
        <p className="text-stone text-sm">
          These values were detected in your contract. Approve the ones that should be masked before the document is sent to AI, or remove false positives.
        </p>
        <p className="text-stone text-xs mt-1">
          Leaving this page via &quot;Back to contracts&quot; does not delete anything — you can resume this job&apos;s PII review later.
        </p>
        {discardError && (
          <p className="text-xs text-red-600 mt-2">{discardError}</p>
        )}
      </div>

      <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden mb-4">
        <div className="px-6 py-4 border-b border-forest/8 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-ink">Detected entities</span>
            {!loading && (
              <span className="text-xs text-stone">
                {approvedCount} approved · {pendingCount} pending
              </span>
            )}
          </div>
          <button
            onClick={() => setShowAddForm(v => !v)}
            className="text-xs text-forest hover:underline flex items-center gap-1"
          >
            <i className="ti ti-plus" style={{ fontSize: 11 }} /> Add manually
          </button>
        </div>

        {showAddForm && (
          <div className="px-6 py-4 border-b border-forest/8 bg-cream/30 flex items-center gap-3">
            <select
              value={newType}
              onChange={e => setNewType(e.target.value)}
              className="text-xs border border-forest/20 rounded-lg px-2 py-1.5 bg-white text-ink"
            >
              {ENTITY_TYPES.map(t => (
                <option key={t} value={t}>{TYPE_LABEL[t] ?? t}</option>
              ))}
            </select>
            <input
              type="text"
              value={newValue}
              onChange={e => setNewValue(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addManual()}
              placeholder="Enter value to mask…"
              className="flex-1 text-sm border border-forest/20 rounded-lg px-3 py-1.5 bg-white text-ink placeholder:text-stone/50 focus:outline-none focus:border-forest/40"
            />
            <button
              onClick={addManual}
              disabled={adding || !newValue.trim()}
              className="text-xs bg-forest text-white px-3 py-1.5 rounded-lg hover:bg-sage transition-colors disabled:opacity-40"
            >
              {adding ? 'Adding…' : 'Add'}
            </button>
          </div>
        )}

        {loading ? (
          <div className="px-6 py-12 text-center text-sm text-stone">
            <i className="ti ti-loader-2 animate-spin mr-2" style={{ fontSize: 16 }} />
            Loading…
          </div>
        ) : occurrences.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <i className="ti ti-shield-check text-forest/40 block mb-3" style={{ fontSize: 36 }} />
            <p className="text-sm font-medium text-ink mb-1">No PII detected</p>
            <p className="text-sm text-stone">No personal or sensitive data was found in this contract.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-forest/8">
                {['Type', 'Value', 'Masked as', 'Source', 'Confidence', ''].map((h, i) => (
                  <th key={h} className={`py-3 text-left text-[10px] font-semibold text-stone uppercase tracking-wider ${i === 5 ? 'pl-4 pr-6' : 'px-4'}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {occurrences.map(occ => {
                const e = occ.pii_entity
                const color = TYPE_COLOR[e.entity_type] ?? '#9CA3AF'
                return (
                  <tr key={occ.id} className="border-b border-forest/6 last:border-0 hover:bg-cream/30 transition-colors">
                    <td className="px-4 py-3">
                      <span
                        className="text-xs font-semibold px-2 py-0.5 rounded-full"
                        style={{ color, background: `${color}15` }}
                      >
                        {TYPE_LABEL[e.entity_type] ?? e.entity_type}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-ink font-mono">
                      {e.original_value}
                      {e.aliasOf && (
                        <div className="text-[11px] text-stone font-sans mt-0.5">Alias of {e.aliasOf} — approving here also covers it</div>
                      )}
                      {!!e.aliases?.length && (
                        <div className="text-[11px] text-stone font-sans mt-0.5">
                          Alias: {e.aliases.join(', ')} — approval here covers both
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-stone font-mono">{e.token}</td>
                    <td className="px-4 py-3 text-xs text-stone capitalize">{occ.detection_source?.replace('_', ' ')}</td>
                    <td className="px-4 py-3 text-xs text-stone">{occ.confidence_pct != null ? `${occ.confidence_pct}%` : '—'}</td>
                    <td className="pl-4 pr-6 py-3">
                      <div className="flex items-center gap-2 justify-end">
                        {e.approved ? (
                          <span className="text-xs text-forest flex items-center gap-1">
                            <i className="ti ti-check" style={{ fontSize: 12 }} /> Approved
                          </span>
                        ) : (
                          <button
                            onClick={() => approve(e.id)}
                            className="text-xs bg-forest/10 text-forest px-2.5 py-1 rounded-lg hover:bg-forest/20 transition-colors"
                          >
                            Approve
                          </button>
                        )}
                        <button
                          onClick={() => reject(e.id)}
                          className="text-xs text-stone hover:text-red-600 transition-colors"
                          title="Reject detection — remove from this contract only. It may be detected again in future contracts."
                          aria-label="Reject detection"
                        >
                          <i className="ti ti-x" style={{ fontSize: 13 }} />
                        </button>
                        <button
                          onClick={() => ignore(e.id)}
                          className="text-xs text-stone hover:text-red-600 transition-colors"
                          title="Ignore — do not mask. Whitelists this value for your whole organisation; it will never be flagged again."
                          aria-label="Ignore, do not mask"
                        >
                          <i className="ti ti-ban" style={{ fontSize: 13 }} />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={approveAllAndExtract}
          disabled={processing}
          className="flex-1 bg-forest text-white text-sm font-medium py-3 rounded-xl hover:bg-sage transition-colors disabled:opacity-40 flex items-center justify-center gap-2"
        >
          {processing
            ? <><i className="ti ti-loader-2 animate-spin" style={{ fontSize: 14 }} /> Processing…</>
            : <>Approve all & extract contract terms →</>
          }
        </button>
      </div>
      <p className="text-xs text-stone mt-3 text-center">
        Approved entities will be masked in the document before it is sent to AI. Rejected ones pass through as-is.
      </p>
    </div>
  )
}
