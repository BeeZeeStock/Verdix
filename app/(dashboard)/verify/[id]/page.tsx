'use client'

import { useState, useEffect, use } from 'react'
import Link from 'next/link'

const STATUS_MESSAGES = [
  'Reading your contracts...',
  'Extracting commercial terms...',
  'Comparing against billing data...',
  'Calculating leakage...',
]

const PRIORITY_COLORS: Record<string, string> = {
  CRITICAL: '#DC2626',
  HIGH:     '#D97706',
  MEDIUM:   '#1A3D2B',
}

const TYPE_LABELS: Record<string, string> = {
  ESCALATOR_MISS:    'Escalator miss',
  DISCOUNT_OVERHANG: 'Discount overhang',
  OVERAGE_UNBILLED:  'Overages not set up',
}

type Finding = {
  id: string; finding_id: string; leakage_type: string; customer_name: string
  contract_id: string; billing_month: string; description: string
  contracted_amount: number; billed_amount: number; leakage_amount: number
  evidence: string; confidence: string; priority: string; status: string
}

type Job = {
  id: string; name: string; status: string; total_contracts: number
  total_invoices: number; total_leakage: number; findings_count: number
  error_message: string; leakage_findings: Finding[]
}

// ── Summary helpers ────────────────────────────────────────────────────────

type SummaryRow = {
  leakage_type: string
  priority: string
  periodStart: string
  periodEnd: string
  months: number
  contractedPerMonth: number
  billedPerMonth: number
  leakagePerMonth: number
  totalLeakage: number
  structural: boolean
}

function buildSummary(findings: Finding[]): SummaryRow[] {
  // Group by leakage_type + priority (a customer may have escalator miss as HIGH
  // and discount overhang as HIGH, but they're separate finding types)
  const groups: Record<string, Finding[]> = {}
  for (const f of findings) {
    const key = `${f.leakage_type}::${f.priority}`
    if (!groups[key]) groups[key] = []
    groups[key].push(f)
  }

  return Object.entries(groups).map(([key, group]) => {
    const [leakage_type, prio] = key.split('::')
    const structural = leakage_type === 'OVERAGE_UNBILLED'
    const months = group.filter(f => f.billing_month).map(f => f.billing_month).sort()
    const avgContracted = group.reduce((s, f) => s + f.contracted_amount, 0) / group.length
    const avgBilled = group.reduce((s, f) => s + f.billed_amount, 0) / group.length
    const avgLeakage = group.reduce((s, f) => s + f.leakage_amount, 0) / group.length
    const totalLeakage = group.reduce((s, f) => s + f.leakage_amount, 0)
    return {
      leakage_type,
      priority: prio,
      periodStart: months[0] ?? '—',
      periodEnd: months[months.length - 1] ?? '—',
      months: group.length,
      contractedPerMonth: avgContracted,
      billedPerMonth: avgBilled,
      leakagePerMonth: avgLeakage,
      totalLeakage,
      structural,
    }
  }).sort((a, b) => {
    const order: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2 }
    return (order[a.priority] ?? 3) - (order[b.priority] ?? 3)
  })
}

function fmtMonth(m: string) {
  if (!m || m === '—') return '—'
  const [y, mo] = m.split('-')
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${months[parseInt(mo) - 1]} ${y}`
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function VerifyResultsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [job, setJob]         = useState<Job | null>(null)
  const [msgIdx, setMsgIdx]   = useState(0)
  const [tab, setTab]         = useState<'summary' | 'all' | 'CRITICAL' | 'HIGH' | 'MEDIUM'>('summary')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [fixModal, setFixModal]     = useState<Finding | null>(null)

  useEffect(() => {
    const poll = async () => {
      const res = await fetch(`/api/jobs/${id}`)
      if (!res.ok) return
      const data = await res.json()
      setJob(data)
      if (data.status === 'COMPLETED' || data.status === 'FAILED') return
      setTimeout(poll, 3000)
    }
    poll()
    const cycle = setInterval(() => setMsgIdx(i => (i + 1) % STATUS_MESSAGES.length), 2000)
    return () => clearInterval(cycle)
  }, [id])

  // ── Loading states ─────────────────────────────────────────────────────

  if (!job) return (
    <div className="flex items-center justify-center h-full">
      <div className="w-10 h-10 border-2 border-forest border-t-transparent rounded-full animate-spin" />
    </div>
  )

  if (job.status !== 'COMPLETED' && job.status !== 'FAILED') return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center max-w-sm">
        <div className="w-12 h-12 border-2 border-forest border-t-transparent rounded-full animate-spin mx-auto mb-6" />
        <p className="text-ink font-medium mb-2">{STATUS_MESSAGES[msgIdx]}</p>
        <p className="text-stone text-sm">This usually takes 1–2 minutes</p>
      </div>
    </div>
  )

  if (job.status === 'FAILED') return (
    <div className="p-8 flex items-center justify-center h-full">
      <div className="text-center max-w-sm">
        <i className="ti ti-alert-circle text-danger block mb-4" style={{ fontSize: 40 }} />
        <h2 className="font-medium text-ink text-lg mb-2">Audit failed</h2>
        <p className="text-stone text-sm mb-6">{job.error_message || 'An unexpected error occurred.'}</p>
        <div className="flex gap-3 justify-center">
          <Link href="/verify/new" className="bg-forest text-white text-sm font-medium px-4 py-2 rounded-xl hover:bg-sage transition-colors">Try again</Link>
          <a href="mailto:support@verdix.io" className="border border-forest/20 text-stone text-sm font-medium px-4 py-2 rounded-xl hover:bg-cream transition-colors">Contact support</a>
        </div>
      </div>
    </div>
  )

  // ── Results ────────────────────────────────────────────────────────────

  const findings = job.leakage_findings || []
  const filtered = tab === 'all' || tab === 'summary' ? findings : findings.filter(f => f.priority === tab)
  const counts = {
    all:      findings.length,
    CRITICAL: findings.filter(f => f.priority === 'CRITICAL').length,
    HIGH:     findings.filter(f => f.priority === 'HIGH').length,
    MEDIUM:   findings.filter(f => f.priority === 'MEDIUM').length,
  }
  const summary = buildSummary(findings)

  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n)

  return (
    <div className="p-4 md:p-8">
      {/* Top summary bar */}
      <div className="bg-forest text-white rounded-2xl px-6 py-5 mb-6 flex items-center justify-between">
        <div>
          <div className="font-medium text-lg mb-1">{job.name}</div>
          <div className="text-mint/80 text-sm">{job.total_contracts} contracts · {job.total_invoices} invoices reviewed</div>
        </div>
        <div className="text-right">
          <div className="text-xs text-mint/60 mb-1">Total recoverable</div>
          <div className="font-mono text-2xl font-semibold">{fmt(job.total_leakage || 0)}</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-parchment rounded-xl p-1 overflow-x-auto">
        {([
          { key: 'summary', label: 'Summary' },
          { key: 'all',      label: `All (${counts.all})` },
          { key: 'CRITICAL', label: `Critical (${counts.CRITICAL})` },
          { key: 'HIGH',     label: `High (${counts.HIGH})` },
          { key: 'MEDIUM',   label: `Medium (${counts.MEDIUM})` },
        ] as const).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className="px-4 py-1.5 rounded-lg text-sm font-medium transition-colors"
            style={{
              background: tab === key ? '#fff' : 'transparent',
              color: tab === key ? '#1A3D2B' : '#6B6660',
              boxShadow: tab === key ? '0 1px 3px rgba(0,0,0,.06)' : 'none',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ── Summary tab ─────────────────────────────────────────────────── */}
      {tab === 'summary' && (
        <div className="space-y-4">
          {/* Discrepancy summary table */}
          <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-forest/8">
              <h2 className="font-medium text-ink">Discrepancy summary</h2>
              <p className="text-xs text-stone mt-0.5">One row per finding type · individual months in the All tab</p>
            </div>
            <div className="overflow-x-auto"><table className="w-full">
              <thead>
                <tr className="border-b border-forest/8">
                  {['Priority', 'Finding', 'Period', 'Contracted / mo', 'Billed / mo', 'Gap / mo', 'Months', 'Total leakage'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-[10px] font-semibold text-stone uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {summary.length === 0 && (
                  <tr><td colSpan={8} className="px-6 py-10 text-center text-sm text-stone">No discrepancies found.</td></tr>
                )}
                {summary.map((row, i) => {
                  const color = PRIORITY_COLORS[row.priority] ?? '#1A3D2B'
                  const isSamePeriod = row.periodStart === row.periodEnd
                  const period = row.structural
                    ? 'All periods'
                    : isSamePeriod
                      ? fmtMonth(row.periodStart)
                      : `${fmtMonth(row.periodStart)} – ${fmtMonth(row.periodEnd)}`
                  return (
                    <tr key={i} className="border-b border-forest/6 last:border-0">
                      <td className="px-4 py-4">
                        <span className="text-xs font-semibold" style={{ color }}>{row.priority}</span>
                      </td>
                      <td className="px-4 py-4">
                        <span className="text-sm font-medium" style={{ color }}>{TYPE_LABELS[row.leakage_type] ?? row.leakage_type}</span>
                        {row.structural && (
                          <span className="ml-2 text-[9px] font-semibold text-red-600 align-middle">structural</span>
                        )}
                      </td>
                      <td className="px-4 py-4 text-sm text-stone">{period}</td>
                      <td className="px-4 py-4 font-mono text-sm" style={{ color: '#1A3D2B' }}>
                        {row.structural ? '—' : fmt(row.contractedPerMonth)}
                      </td>
                      <td className="px-4 py-4 font-mono text-sm text-stone line-through">
                        {row.structural ? '—' : fmt(row.billedPerMonth)}
                      </td>
                      <td className="px-4 py-4 font-mono text-sm font-semibold text-danger">
                        {row.structural ? 'unknown' : fmt(row.leakagePerMonth)}
                      </td>
                      <td className="px-4 py-4 text-sm text-center text-stone">
                        {row.structural ? `${row.months}` : `× ${row.months}`}
                      </td>
                      <td className="px-4 py-4 font-mono text-base font-bold text-danger">
                        {row.structural
                          ? <span className="text-xs font-semibold text-stone">investigate</span>
                          : fmt(row.totalLeakage)
                        }
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              {summary.some(r => !r.structural) && (
                <tfoot>
                  <tr className="bg-cream/60 border-t-2 border-forest/15">
                    <td colSpan={7} className="px-4 py-3 text-xs font-semibold text-stone uppercase tracking-wider">Total quantified leakage</td>
                    <td className="px-4 py-3 font-mono text-lg font-bold text-danger">
                      {fmt(summary.filter(r => !r.structural).reduce((s, r) => s + r.totalLeakage, 0))}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table></div>
          </div>

          {/* Quick count cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {([['CRITICAL', counts.CRITICAL], ['HIGH', counts.HIGH], ['MEDIUM', counts.MEDIUM]] as const).map(([p, n]) => {
              const color = PRIORITY_COLORS[p]
              return (
                <button
                  key={p}
                  onClick={() => setTab(p)}
                  className="bg-white border border-forest/10 rounded-xl px-5 py-4 text-left hover:border-forest/25 transition-colors group"
                >
                  <span className="text-xs font-semibold" style={{ color }}>{p}</span>
                  <div className="mt-3 text-3xl font-medium text-ink">{n}</div>
                  <div className="text-xs text-stone mt-0.5 group-hover:text-forest transition-colors">
                    finding{n !== 1 ? 's' : ''} · view all →
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* ── All / priority-filtered tabs ────────────────────────────────── */}
      {tab !== 'summary' && (
        <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden">
          <div className="overflow-x-auto"><table className="w-full">
            <thead>
              <tr className="border-b border-forest/8">
                {['Priority', 'Type', 'Customer', 'Period', 'Contracted', 'Billed', 'Leakage', 'Status', ''].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-[10px] font-semibold text-stone uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={9} className="px-6 py-12 text-center text-sm text-stone">No findings in this category.</td></tr>
              )}
              {filtered.map(f => {
                const color = PRIORITY_COLORS[f.priority] ?? '#1A3D2B'
                return (
                  <>
                    <tr
                      key={f.id}
                      className="border-b border-forest/6 hover:bg-cream/50 cursor-pointer transition-colors"
                      onClick={() => setExpandedId(expandedId === f.id ? null : f.id)}
                    >
                      <td className="px-4 py-3">
                        <span className="text-xs font-semibold" style={{ color }}>{f.priority}</span>
                      </td>
                      <td className="px-4 py-3 text-sm font-medium" style={{ color }}>{TYPE_LABELS[f.leakage_type] ?? f.leakage_type}</td>
                      <td className="px-4 py-3 text-sm font-medium text-ink">{f.customer_name}</td>
                      <td className="px-4 py-3 text-xs text-stone">{fmtMonth(f.billing_month)}</td>
                      <td className="px-4 py-3 font-mono text-sm" style={{ color: '#1A3D2B' }}>{fmt(f.contracted_amount)}</td>
                      <td className="px-4 py-3 font-mono text-sm text-stone line-through">{fmt(f.billed_amount)}</td>
                      <td className="px-4 py-3 font-mono text-sm font-semibold text-danger">{fmt(f.leakage_amount)}</td>
                      <td className="px-4 py-3 text-xs capitalize" style={{ color: f.status === 'fixed' ? '#1A3D2B' : '#6B6660' }}>
                        {f.status}
                      </td>
                      <td className="px-4 py-3">
                        <i className={`ti ti-chevron-${expandedId === f.id ? 'up' : 'down'} text-stone`} style={{ fontSize: 13 }} />
                      </td>
                    </tr>
                    {expandedId === f.id && (
                      <tr key={`${f.id}-exp`} className="border-b border-forest/6 bg-cream/30">
                        <td colSpan={9} className="px-6 py-5">
                          <p className="text-sm text-stone mb-3">{f.description}</p>
                          {f.evidence && (
                            <blockquote className="font-mono text-sm bg-parchment border-l-4 border-sage p-4 rounded-r-lg mb-4">
                              {f.evidence}
                            </blockquote>
                          )}
                          {f.status === 'open' && (
                            <div className="flex gap-3">
                              <button
                                onClick={() => setFixModal(f)}
                                className="bg-forest text-white text-xs font-medium px-4 py-2 rounded-lg hover:bg-sage transition-colors flex items-center gap-2"
                              >
                                <i className="ti ti-tool" style={{ fontSize: 12 }} /> Fix via API →
                              </button>
                              <button className="border border-forest/20 text-stone text-xs font-medium px-4 py-2 rounded-lg hover:bg-cream transition-colors">
                                Mark as fixed
                              </button>
                              <button className="text-stone/60 text-xs px-4 py-2 hover:text-stone transition-colors">
                                Dismiss
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </>
                )
              })}
            </tbody>
          </table></div>
        </div>
      )}

      {/* Fix modal */}
      {fixModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4" onClick={() => setFixModal(null)}>
          <div className="bg-white rounded-2xl p-8 max-w-md w-full shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="font-medium text-ink text-lg mb-2">Fix via billing platform API</h3>
            <p className="text-stone text-sm mb-4">The following change will be pushed to your billing platform:</p>
            <div className="bg-parchment rounded-xl p-4 font-mono text-sm mb-6 space-y-1">
              <div><span className="text-stone">Finding:</span> <span className="text-ink">{TYPE_LABELS[fixModal.leakage_type]}</span></div>
              <div><span className="text-stone">Customer:</span> <span className="text-ink">{fixModal.customer_name}</span></div>
              <div><span className="text-stone">Leakage:</span> <span className="text-danger font-semibold">{fmt(fixModal.leakage_amount)}</span></div>
            </div>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setFixModal(null)} className="text-stone text-sm px-4 py-2 hover:text-ink transition-colors">Cancel</button>
              <button
                onClick={async () => {
                  await fetch(`/api/jobs/${id}/fix-finding`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ findingId: fixModal.id }),
                  })
                  setFixModal(null)
                }}
                className="bg-forest text-white text-sm font-medium px-6 py-2.5 rounded-xl hover:bg-sage transition-colors"
              >
                Confirm fix →
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
