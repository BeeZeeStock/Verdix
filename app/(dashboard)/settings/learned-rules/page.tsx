'use client'

import { useState, useEffect } from 'react'

type Correction = {
  id: string
  field_name: string
  extracted_value: string | null
  corrected_value: string
  correction_reason: string | null
  customer_name: string | null
  apply_to_future: boolean
  created_at: string
}

export default function LearnedRulesPage() {
  const [rules, setRules] = useState<Correction[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  useEffect(() => {
    fetch('/api/corrections')
      .then(r => r.json())
      .then(data => { setRules(data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  const handleDelete = async (id: string) => {
    setRules(r => r.filter(x => x.id !== id))
  }

  const filtered = rules.filter(r =>
    !search ||
    r.field_name.toLowerCase().includes(search.toLowerCase()) ||
    r.corrected_value.toLowerCase().includes(search.toLowerCase()) ||
    r.customer_name?.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="font-display font-light text-ink text-2xl mb-1">Learned rules</h1>
          <p className="text-stone text-sm">Corrections your team has taught Verdix to apply automatically</p>
        </div>
        <div className="flex items-center gap-2 bg-white border border-forest/10 rounded-xl px-3 py-2">
          <i className="ti ti-search text-stone/50" style={{ fontSize: 14 }} />
          <input
            type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search rules..." className="text-sm outline-none bg-transparent text-ink placeholder:text-stone/40 w-52"
          />
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        {[
          { label: 'Total rules', value: rules.length, icon: 'ti-bolt' },
          { label: 'Global rules', value: rules.filter(r => !r.customer_name).length, icon: 'ti-world' },
          { label: 'Customer-specific', value: rules.filter(r => !!r.customer_name).length, icon: 'ti-building' },
        ].map(stat => (
          <div key={stat.label} className="bg-white border border-forest/10 rounded-2xl p-5 flex items-center gap-4">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: '#EAF3DE' }}>
              <i className={`ti ${stat.icon} text-forest`} style={{ fontSize: 18 }} />
            </div>
            <div>
              <div className="font-mono text-xl font-medium text-ink">{stat.value}</div>
              <div className="text-xs text-stone">{stat.label}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden">
        <div className="px-6 py-4 border-b border-forest/8">
          <span className="text-sm font-medium text-ink">{filtered.length} rule{filtered.length !== 1 ? 's' : ''}</span>
        </div>

        {loading ? (
          <div className="px-6 py-16 flex justify-center">
            <div className="w-8 h-8 border-2 border-forest border-t-transparent rounded-full animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <i className="ti ti-bolt text-stone/30 block mb-3" style={{ fontSize: 32 }} />
            <p className="text-sm text-stone mb-2">No learned rules yet.</p>
            <p className="text-xs text-stone/60">When you correct an extraction and check "Remember this", it appears here.</p>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-forest/8">
                {['Field', 'Extracted', 'Corrected value', 'Reason', 'Scope', 'Date', ''].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-medium text-stone uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(rule => (
                <tr key={rule.id} className="border-b border-forest/6 hover:bg-cream/30">
                  <td className="px-4 py-3 text-xs font-mono font-medium text-forest">{rule.field_name}</td>
                  <td className="px-4 py-3 text-xs text-stone/60 line-through max-w-xs truncate">{rule.extracted_value ?? '—'}</td>
                  <td className="px-4 py-3 text-sm text-ink font-medium max-w-xs truncate">{rule.corrected_value}</td>
                  <td className="px-4 py-3 text-xs text-stone max-w-xs truncate">{rule.correction_reason ?? '—'}</td>
                  <td className="px-4 py-3">
                    {rule.customer_name ? (
                      <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: '#EAF3DE', color: '#27500A' }}>
                        {rule.customer_name}
                      </span>
                    ) : (
                      <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: '#F0EBE1', color: '#6B6660' }}>
                        Global
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-stone/50">{new Date(rule.created_at).toLocaleDateString()}</td>
                  <td className="px-4 py-3">
                    <button onClick={() => handleDelete(rule.id)} className="text-xs text-danger/50 hover:text-danger transition-colors">
                      <i className="ti ti-trash" style={{ fontSize: 14 }} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
