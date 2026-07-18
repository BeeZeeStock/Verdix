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
}

type PIIOccurrence = {
  id: string
  detection_source: string
  confidence_pct: number
  pii_entity: PIIEntity
}

const TYPE_LABEL: Record<string, string> = {
  PERSON:     'Person',
  ORG:        'Organisation',
  EMAIL:      'Email',
  PHONE:      'Phone',
  IBAN:       'IBAN',
  VAT_NUMBER: 'VAT No.',
  ADDRESS:    'Address',
}

const TYPE_COLOR: Record<string, string> = {
  PERSON:     '#7C3AED',
  ORG:        '#2563EB',
  EMAIL:      '#D97706',
  PHONE:      '#0891B2',
  IBAN:       '#DC2626',
  VAT_NUMBER: '#DC2626',
  ADDRESS:    '#059669',
}

const ENTITY_TYPES = ['PERSON', 'ORG', 'EMAIL', 'PHONE', 'IBAN', 'VAT_NUMBER', 'ADDRESS']

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

  const fetchEntities = async () => {
    const res = await fetch(`/api/jobs/${id}/pii`)
    if (res.ok) setOccurrences(await res.json())
    setLoading(false)
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { fetchEntities() }, [id])

  const approve = async (entityId: string) => {
    setOccurrences(prev => prev.map(o =>
      o.pii_entity.id === entityId
        ? { ...o, pii_entity: { ...o.pii_entity, approved: true } }
        : o
    ))
    await fetch(`/api/jobs/${id}/pii`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve', entityId }),
    })
  }

  const reject = async (occurrenceId: string, entityId: string) => {
    setOccurrences(prev => prev.filter(o => o.id !== occurrenceId))
    await fetch(`/api/jobs/${id}/pii`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reject', entityId }),
    })
  }

  const ignore = async (occurrenceId: string, entityId: string) => {
    setOccurrences(prev => prev.filter(o => o.id !== occurrenceId))
    await fetch(`/api/jobs/${id}/pii`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'ignore', entityId }),
    })
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
    await fetch(`/api/jobs/${id}/execute`, { method: 'POST' })
    router.push(`/configure/${id}`)
  }

  const approvedCount = occurrences.filter(o => o.pii_entity.approved).length
  const pendingCount  = occurrences.filter(o => !o.pii_entity.approved).length

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <div className="mb-8">
        <Link href="/configure" className="text-sm text-stone hover:text-forest flex items-center gap-1 mb-4">
          <i className="ti ti-arrow-left" style={{ fontSize: 13 }} /> Back to contracts
        </Link>
        <h1 className="font-display font-light text-ink text-2xl mb-1">PII Review</h1>
        <p className="text-stone text-sm">
          These values were detected in your contract. Approve the ones that should be masked before the document is sent to AI, or remove false positives.
        </p>
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
                    <td className="px-4 py-3 text-sm text-ink font-mono">{e.original_value}</td>
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
                          onClick={() => reject(occ.id, e.id)}
                          className="text-xs text-stone hover:text-red-600 transition-colors"
                          title="Remove from this contract"
                        >
                          <i className="ti ti-x" style={{ fontSize: 13 }} />
                        </button>
                        <button
                          onClick={() => ignore(occ.id, e.id)}
                          className="text-xs text-stone hover:text-red-600 transition-colors"
                          title="Never flag this value again"
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
        {pendingCount === 0 && approvedCount > 0 && (
          <button
            onClick={() => {
              fetch(`/api/jobs/${id}/execute`, { method: 'POST' })
              router.push(`/configure/${id}`)
            }}
            disabled={processing}
            className="text-sm text-stone hover:text-ink transition-colors px-4 py-3"
          >
            Extract with approved only
          </button>
        )}
      </div>
      <p className="text-xs text-stone mt-3 text-center">
        Approved entities will be masked in the document before it is sent to AI. Rejected ones pass through as-is.
      </p>
    </div>
  )
}
