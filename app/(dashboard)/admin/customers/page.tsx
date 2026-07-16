'use client'

import { useEffect, useState } from 'react'

type OrgRow = {
  id: string
  name: string
  slug: string
  created_at: string
  member_count: number
  subscription: {
    plan_id: string
    syncs_used: number
    trial_sync_limit_override: number | null
    stripe_customer_id: string | null
    status: string
  }
}

const PLAN_LABELS: Record<string, string> = { trial: 'Trial', core: 'Core', pro: 'Pro', enterprise: 'Enterprise' }
const PLAN_COLORS: Record<string, string> = { trial: '#9CA3AF', core: '#2563EB', pro: '#7C3AED', enterprise: '#1A3D2B' }

export default function AdminCustomersPage() {
  const [rows, setRows]         = useState<OrgRow[]>([])
  const [loading, setLoading]   = useState(true)
  const [editing, setEditing]   = useState<string | null>(null)
  const [editVals, setEditVals] = useState<{ plan_id: string; trial_sync_limit_override: string }>({ plan_id: 'trial', trial_sync_limit_override: '' })
  const [saving, setSaving]     = useState(false)
  const [msg, setMsg]           = useState<{ id: string; ok: boolean; text: string } | null>(null)

  useEffect(() => {
    fetch('/api/admin/customers')
      .then(r => r.json())
      .then(d => { setRows(Array.isArray(d) ? d : []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  const openEdit = (row: OrgRow) => {
    setEditing(row.id)
    setEditVals({
      plan_id: row.subscription.plan_id,
      trial_sync_limit_override: row.subscription.trial_sync_limit_override != null ? String(row.subscription.trial_sync_limit_override) : '',
    })
    setMsg(null)
  }

  const saveEdit = async (orgId: string) => {
    setSaving(true)
    const res = await fetch('/api/admin/customers', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        org_id: orgId,
        plan_id: editVals.plan_id,
        trial_sync_limit_override: editVals.trial_sync_limit_override !== '' ? Number(editVals.trial_sync_limit_override) : null,
      }),
    })
    setSaving(false)
    if (res.ok) {
      setRows(prev => prev.map(r => r.id !== orgId ? r : {
        ...r,
        subscription: {
          ...r.subscription,
          plan_id: editVals.plan_id,
          trial_sync_limit_override: editVals.trial_sync_limit_override !== '' ? Number(editVals.trial_sync_limit_override) : null,
        },
      }))
      setEditing(null)
      setMsg({ id: orgId, ok: true, text: 'Updated ✓' })
    } else {
      const d = await res.json()
      setMsg({ id: orgId, ok: false, text: d.error ?? 'Error' })
    }
  }

  if (loading) return <div className="p-8 text-stone text-sm">Loading…</div>

  return (
    <div className="p-4 md:p-8">
      <div className="mb-8">
        <h1 className="font-display font-light text-ink text-2xl mb-1">Customers</h1>
        <p className="text-stone text-sm">{rows.length} organisation{rows.length !== 1 ? 's' : ''}</p>
      </div>

      <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-forest/8">
                {['Organisation', 'Plan', 'Syncs used', 'Trial limit override', 'Members', 'Stripe', 'Actions'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-[10px] font-semibold text-stone uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.id} className="border-b border-forest/6 last:border-0 hover:bg-cream/40 transition-colors">
                  <td className="px-4 py-3">
                    <div className="text-sm font-medium text-ink">{row.name}</div>
                    <div className="text-xs text-stone/60">{row.slug}</div>
                  </td>
                  <td className="px-4 py-3">
                    {editing === row.id ? (
                      <select
                        value={editVals.plan_id}
                        onChange={e => setEditVals(v => ({ ...v, plan_id: e.target.value }))}
                        className="text-xs border border-forest/20 rounded-lg px-2 py-1 bg-white"
                      >
                        {['trial', 'core', 'pro', 'enterprise'].map(p => (
                          <option key={p} value={p}>{PLAN_LABELS[p]}</option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-xs font-semibold" style={{ color: PLAN_COLORS[row.subscription.plan_id] ?? '#6B6660' }}>
                        {PLAN_LABELS[row.subscription.plan_id] ?? row.subscription.plan_id}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-stone font-mono">{row.subscription.syncs_used}</td>
                  <td className="px-4 py-3">
                    {editing === row.id ? (
                      <input
                        type="number"
                        value={editVals.trial_sync_limit_override}
                        onChange={e => setEditVals(v => ({ ...v, trial_sync_limit_override: e.target.value }))}
                        placeholder="Global default"
                        className="w-28 text-xs border border-forest/20 rounded-lg px-2 py-1 bg-white"
                      />
                    ) : (
                      <span className="text-sm text-stone">
                        {row.subscription.trial_sync_limit_override != null ? row.subscription.trial_sync_limit_override : <span className="text-stone/40">—</span>}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-stone">{row.member_count}</td>
                  <td className="px-4 py-3">
                    {row.subscription.stripe_customer_id ? (
                      <a
                        href={`https://dashboard.stripe.com/customers/${row.subscription.stripe_customer_id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-forest hover:underline"
                      >
                        View ↗
                      </a>
                    ) : <span className="text-xs text-stone/40">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    {editing === row.id ? (
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => saveEdit(row.id)}
                          disabled={saving}
                          className="text-xs bg-forest text-white px-3 py-1.5 rounded-lg hover:bg-sage transition-colors disabled:opacity-50"
                        >
                          {saving ? '…' : 'Save'}
                        </button>
                        <button onClick={() => setEditing(null)} className="text-xs text-stone hover:text-ink">Cancel</button>
                        {msg?.id === row.id && (
                          <span className={`text-xs ${msg.ok ? 'text-forest' : 'text-red-600'}`}>{msg.text}</span>
                        )}
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <button onClick={() => openEdit(row)} className="text-xs text-forest hover:underline">Edit</button>
                        {msg?.id === row.id && (
                          <span className={`text-xs ${msg.ok ? 'text-forest' : 'text-red-600'}`}>{msg.text}</span>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
