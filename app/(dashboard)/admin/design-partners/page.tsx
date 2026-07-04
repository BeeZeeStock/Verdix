'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect } from 'react'

type Application = {
  id: string
  company: string
  contact_name: string
  contact_email: string
  contact_role: string | null
  company_size: string | null
  pain_point: string | null
  status: 'new' | 'contacted' | 'approved' | 'declined'
  created_at: string
}

const STATUS_STYLES: Record<Application['status'], { bg: string; color: string; border: string; label: string }> = {
  new:       { bg: '#EEF2FF', color: '#3730A3', border: '#C7D2FE', label: 'New' },
  contacted: { bg: '#FAEEDA', color: '#633806', border: '#FAC775', label: 'Contacted' },
  approved:  { bg: '#EAF3DE', color: '#27500A', border: '#A3C98A', label: 'Approved' },
  declined:  { bg: '#FEE2E2', color: '#791F1F', border: '#F09595', label: 'Declined' },
}

export default function AdminDesignPartnersPage() {
  const [applications, setApplications] = useState<Application[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    // Direct Supabase fetch from client — in production this should be an admin-protected API route
    fetch('/api/admin/design-partners')
      .then(r => r.json())
      .then(data => { setApplications(Array.isArray(data) ? data : []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  const updateStatus = async (id: string, status: Application['status']) => {
    setApplications(prev => prev.map(a => a.id === id ? { ...a, status } : a))
  }

  const byStatus = (s: Application['status']) => applications.filter(a => a.status === s)

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="font-display font-light text-ink text-2xl mb-1">Design Partner applications</h1>
        <p className="text-stone text-sm">Companies interested in the Design Partner Programme</p>
      </div>

      {/* Summary row */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        {(['new', 'contacted', 'approved', 'declined'] as const).map(s => {
          const st = STATUS_STYLES[s]
          return (
            <div key={s} className="bg-white border border-forest/10 rounded-2xl p-5">
              <div className="text-2xl font-mono font-medium text-ink mb-1">{byStatus(s).length}</div>
              <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: st.bg, color: st.color, border: `0.5px solid ${st.border}` }}>
                {st.label}
              </span>
            </div>
          )
        })}
      </div>

      <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden">
        <div className="px-6 py-4 border-b border-forest/8">
          <span className="text-sm font-medium text-ink">{applications.length} total applications</span>
        </div>

        {loading ? (
          <div className="px-6 py-16 flex justify-center">
            <div className="w-8 h-8 border-2 border-forest border-t-transparent rounded-full animate-spin" />
          </div>
        ) : applications.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <i className="ti ti-users text-stone/30 block mb-3" style={{ fontSize: 32 }} />
            <p className="text-sm text-stone">No applications yet.</p>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-forest/8">
                {['Company', 'Contact', 'Role', 'Size', 'Applied', 'Status', 'Actions'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-medium text-stone uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {applications.map(app => {
                const st = STATUS_STYLES[app.status]
                const isOpen = expanded === app.id
                return (
                  <>
                    <tr key={app.id} className="border-b border-forest/6 hover:bg-cream/30 cursor-pointer" onClick={() => setExpanded(isOpen ? null : app.id)}>
                      <td className="px-4 py-3 text-sm font-medium text-ink">{app.company}</td>
                      <td className="px-4 py-3">
                        <div className="text-sm text-ink">{app.contact_name}</div>
                        <div className="text-xs text-stone">{app.contact_email}</div>
                      </td>
                      <td className="px-4 py-3 text-xs text-stone">{app.contact_role ?? '—'}</td>
                      <td className="px-4 py-3 text-xs text-stone">{app.company_size ?? '—'}</td>
                      <td className="px-4 py-3 text-xs text-stone/60">{new Date(app.created_at).toLocaleDateString()}</td>
                      <td className="px-4 py-3">
                        <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: st.bg, color: st.color, border: `0.5px solid ${st.border}` }}>
                          {st.label}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2" onClick={e => e.stopPropagation()}>
                          <button onClick={() => updateStatus(app.id, 'contacted')}
                            className="text-xs px-2 py-1 rounded-lg border border-forest/20 text-stone hover:bg-cream transition-colors">
                            Contact
                          </button>
                          <button onClick={() => updateStatus(app.id, 'approved')}
                            className="text-xs px-2 py-1 rounded-lg bg-forest text-white hover:bg-sage transition-colors">
                            Approve
                          </button>
                        </div>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr key={`${app.id}-expand`} className="bg-cream/40">
                        <td colSpan={7} className="px-6 py-4">
                          <div className="text-xs text-stone font-medium uppercase tracking-widest mb-2">Pain point</div>
                          <p className="text-sm text-ink leading-relaxed">{app.pain_point ?? 'Not provided'}</p>
                        </td>
                      </tr>
                    )}
                  </>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
