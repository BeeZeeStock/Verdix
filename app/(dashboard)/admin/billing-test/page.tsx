'use client'

import { useEffect, useState, useCallback } from 'react'

type OrgRow = {
  org_id:                 string
  org_name:               string
  plan_id:                string
  usage_counters:         Record<string, number>
  stripe_customer_id:     string | null
  stripe_subscription_id: string | null
}

type JobRow = {
  id:         string
  org_id:     string
  org_name:   string
  created_at: string
}

type PreviewRow = {
  metric_type:    string
  count:          number
  included:       number | null
  overage:        number
  price_per_unit: number
  total_eur:      number
}

type SimRow = {
  meter_key:   string
  count:       number
  included:    number
  overage:     number
  overage_eur: number
  source:      string
  tiers_count: number
}

const PLAN_COLORS: Record<string, string> = {
  trial:      '#9CA3AF',
  core:       '#2563EB',
  pro:        '#7C3AED',
  enterprise: '#1A3D2B',
}

function CounterBadges({ counters }: { counters: Record<string, number> }) {
  const entries = Object.entries(counters)
  if (entries.length === 0) return <span className="text-xs text-stone/50">no counters</span>
  return (
    <span className="flex flex-wrap gap-1">
      {entries.map(([k, v]) => (
        <span key={k} className="inline-flex items-center gap-1 text-[10px] bg-forest/8 text-forest px-1.5 py-0.5 rounded font-mono font-medium">
          {k}: {v}
        </span>
      ))}
    </span>
  )
}

function DayBarChart({ byDay }: { byDay: Record<string, number> }) {
  const entries = Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b))
  const maxVal  = Math.max(...entries.map(([, v]) => v), 1)
  const showLabel = entries.length <= 31

  return (
    <div>
      <div className="flex items-end gap-px h-14">
        {entries.map(([day, count]) => (
          <div key={day} className="flex flex-col items-center flex-1 min-w-0 relative group">
            <div
              className="w-full bg-forest/30 hover:bg-forest/60 transition-colors rounded-sm cursor-default"
              style={{ height: `${Math.max(4, Math.round((count / maxVal) * 100))}%` }}
            />
            <div className="absolute bottom-full mb-1 hidden group-hover:flex flex-col items-center pointer-events-none z-10">
              <div className="bg-ink text-white text-[9px] font-mono px-1.5 py-0.5 rounded whitespace-nowrap">
                {day.slice(5)}: {count}
              </div>
            </div>
          </div>
        ))}
      </div>
      {showLabel && (
        <div className="flex mt-1 text-[8px] text-stone/40 font-mono overflow-hidden">
          <span>{entries[0]?.[0]?.slice(5)}</span>
          <span className="flex-1" />
          <span>{entries[entries.length - 1]?.[0]?.slice(5)}</span>
        </div>
      )}
    </div>
  )
}

function defaultPeriod() {
  const now   = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0]
  const end   = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0]
  return { start, end }
}

export default function BillingTestPage() {
  const [orgs, setOrgs]               = useState<OrgRow[]>([])
  const [jobs, setJobs]               = useState<JobRow[]>([])
  const [loading, setLoading]         = useState(true)
  const [selectedOrg, setSelectedOrg] = useState<OrgRow | null>(null)

  // Panel 2: Record usage
  const [recordJobId,  setRecordJobId]  = useState('')
  const [recordMetric, setRecordMetric] = useState('sync')
  const [recordQty,    setRecordQty]    = useState('1')
  const [recording,    setRecording]    = useState(false)
  const [recordMsg,    setRecordMsg]    = useState<{ ok: boolean; text: string } | null>(null)

  // Panel 3: Seed / reset
  const [seedMetric, setSeedMetric] = useState('sync')
  const [seedAmount, setSeedAmount] = useState('1')
  const [seeding,    setSeeding]    = useState(false)
  const [seedMsg,    setSeedMsg]    = useState<{ ok: boolean; text: string } | null>(null)
  const [resetting,  setResetting]  = useState(false)
  const [resetMsg,   setResetMsg]   = useState<{ ok: boolean; text: string } | null>(null)

  // Panel 4: Billing preview
  const [preview,        setPreview]        = useState<PreviewRow[] | null>(null)
  const [previewPlanId,  setPreviewPlanId]  = useState<string>('')
  const [previewTotal,   setPreviewTotal]   = useState<number>(0)
  const [previewing,     setPreviewing]     = useState(false)

  // Panel 5: Period simulation
  const [simStart,       setSimStart]       = useState(() => defaultPeriod().start)
  const [simEnd,         setSimEnd]         = useState(() => defaultPeriod().end)
  const [simMeter,       setSimMeter]       = useState('sync')
  const [simEvents,      setSimEvents]      = useState('100')
  const [simDistrib,     setSimDistrib]     = useState<'even' | 'random' | 'front'>('even')
  const [simSeeding,     setSimSeeding]     = useState(false)
  const [simSeedMsg,     setSimSeedMsg]     = useState<{ ok: boolean; text: string } | null>(null)
  const [simByDay,       setSimByDay]       = useState<Record<string, number> | null>(null)
  const [simClearing,    setSimClearing]    = useState(false)
  const [simClearMsg,    setSimClearMsg]    = useState<{ ok: boolean; text: string } | null>(null)
  const [simRunning,     setSimRunning]     = useState(false)
  const [simResult,      setSimResult]      = useState<SimRow[] | null>(null)
  const [simResultTotal, setSimResultTotal] = useState(0)

  const applyData = useCallback((res: { orgs: OrgRow[]; jobs: JobRow[] }) => {
    setOrgs(res.orgs ?? [])
    setJobs(res.jobs ?? [])
    setSelectedOrg(prev => {
      if (!prev) return prev
      return (res.orgs as OrgRow[]).find(o => o.org_id === prev.org_id) ?? prev
    })
  }, [])

  const loadData = useCallback(() => {
    return fetch('/api/admin/usage-test')
      .then(r => r.json())
      .then((res: { orgs: OrgRow[]; jobs: JobRow[] }) => applyData(res))
      .catch(() => {})
  }, [applyData])

  useEffect(() => {
    fetch('/api/admin/usage-test')
      .then(r => r.json())
      .then((res: { orgs: OrgRow[]; jobs: JobRow[] }) => { applyData(res); setLoading(false) })
      .catch(() => setLoading(false))
  }, [applyData])

  useEffect(() => {
    const id = setInterval(loadData, 10_000)
    return () => clearInterval(id)
  }, [loadData])

  const orgJobs = jobs.filter(j => selectedOrg && j.org_id === selectedOrg.org_id)

  // ── Panel 2: Record usage ─────────────────────────────────────────────────────
  const handleRecord = async () => {
    if (!recordJobId) { setRecordMsg({ ok: false, text: 'Select a job first' }); return }
    setRecording(true); setRecordMsg(null)
    const res  = await fetch('/api/usage/record', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ job_id: recordJobId, metric_type: recordMetric, quantity: Number(recordQty) }),
    })
    const data = await res.json()
    if (res.ok) { setRecordMsg({ ok: true, text: `Recorded ${recordQty}× ${recordMetric} ✓` }); await loadData() }
    else          setRecordMsg({ ok: false, text: data.error ?? 'Failed' })
    setRecording(false)
  }

  // ── Panel 3: Seed / reset ─────────────────────────────────────────────────────
  const handleSeed = async () => {
    if (!selectedOrg) return
    setSeeding(true); setSeedMsg(null)
    const res  = await fetch('/api/admin/usage-test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'seed', org_id: selectedOrg.org_id, metric_type: seedMetric, amount: Number(seedAmount) }),
    })
    const data = await res.json()
    if (res.ok) { setSeedMsg({ ok: true, text: `Seeded ${seedAmount}× ${seedMetric} ✓` }); await loadData() }
    else          setSeedMsg({ ok: false, text: data.error ?? 'Failed' })
    setSeeding(false)
  }

  const handleReset = async (metricType?: string) => {
    if (!selectedOrg) return
    setResetting(true); setResetMsg(null)
    const res  = await fetch('/api/admin/usage-test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'reset', org_id: selectedOrg.org_id, metric_type: metricType }),
    })
    const data = await res.json()
    if (res.ok) { setResetMsg({ ok: true, text: metricType ? `Reset ${metricType} to 0 ✓` : 'All counters reset ✓' }); await loadData() }
    else          setResetMsg({ ok: false, text: data.error ?? 'Failed' })
    setResetting(false)
  }

  // ── Panel 4: Billing preview ──────────────────────────────────────────────────
  const handlePreview = async () => {
    if (!selectedOrg) return
    setPreviewing(true); setPreview(null)
    const res  = await fetch('/api/admin/usage-test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'preview', org_id: selectedOrg.org_id }),
    })
    const data = await res.json()
    if (res.ok) {
      setPreview(data.breakdown ?? [])
      setPreviewTotal(data.total_eur ?? 0)
      setPreviewPlanId(data.plan_id ?? '')
    }
    setPreviewing(false)
  }

  // ── Panel 5: Period simulation ────────────────────────────────────────────────
  const handleSeedPeriod = async () => {
    if (!selectedOrg) return
    setSimSeeding(true); setSimSeedMsg(null); setSimByDay(null)
    const res  = await fetch('/api/admin/usage-test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action:       'seed_period',
        org_id:       selectedOrg.org_id,
        meter_key:    simMeter,
        period_start: simStart,
        period_end:   simEnd,
        total_events: Number(simEvents),
        distribution: simDistrib,
      }),
    })
    const data = await res.json()
    if (res.ok) {
      setSimSeedMsg({ ok: true, text: `Seeded ${data.total} events ✓` })
      setSimByDay(data.by_day ?? {})
    } else {
      setSimSeedMsg({ ok: false, text: data.error ?? 'Failed' })
    }
    setSimSeeding(false)
  }

  const handleClearSimulated = async () => {
    if (!selectedOrg) return
    setSimClearing(true); setSimClearMsg(null)
    const res  = await fetch('/api/admin/usage-test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'clear_simulated', org_id: selectedOrg.org_id }),
    })
    const data = await res.json()
    if (res.ok) {
      setSimClearMsg({ ok: true, text: `Cleared ${data.deleted} simulated entries ✓` })
      setSimByDay(null); setSimResult(null)
    } else {
      setSimClearMsg({ ok: false, text: data.error ?? 'Failed' })
    }
    setSimClearing(false)
  }

  const handleSimulateBilling = async () => {
    if (!selectedOrg) return
    setSimRunning(true); setSimResult(null)
    const res  = await fetch('/api/admin/usage-test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action:       'simulate_billing',
        org_id:       selectedOrg.org_id,
        period_start: simStart,
        period_end:   simEnd,
      }),
    })
    const data = await res.json()
    if (res.ok) {
      setSimResult(data.breakdown ?? [])
      setSimResultTotal(data.total_eur ?? 0)
    }
    setSimRunning(false)
  }

  if (loading) return <div className="p-8 text-stone text-sm">Loading…</div>

  return (
    <div className="p-4 md:p-8 max-w-5xl space-y-6">
      <div>
        <h1 className="font-display font-light text-ink text-2xl mb-1">Billing Test Lab</h1>
        <p className="text-stone text-sm">Seed counters, fire usage events, simulate billing periods — without touching production invoicing.</p>
      </div>

      {/* ── Panel 1: Org selector ─────────────────────────────────────────────── */}
      <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden">
        <div className="px-6 py-4 border-b border-forest/8 flex items-center justify-between">
          <div className="text-sm font-medium text-ink flex items-center gap-2">
            <i className="ti ti-users-group" style={{ fontSize: 15 }} />
            Select organisation
          </div>
          <button onClick={loadData} className="text-xs text-stone hover:text-forest transition-colors flex items-center gap-1">
            <i className="ti ti-refresh" style={{ fontSize: 12 }} />
            Refresh
          </button>
        </div>
        <div className="divide-y divide-forest/5">
          {orgs.length === 0 && (
            <div className="px-6 py-4 text-sm text-stone">No organisations found.</div>
          )}
          {orgs.map(org => {
            const isActive = selectedOrg?.org_id === org.org_id
            return (
              <button
                key={org.org_id}
                onClick={() => {
                  setSelectedOrg(isActive ? null : org)
                  setPreview(null); setRecordJobId('')
                  setSimResult(null); setSimByDay(null)
                }}
                className="w-full text-left px-6 py-3.5 flex items-center gap-4 transition-colors hover:bg-forest/3"
                style={{ background: isActive ? '#EAF3DE' : undefined }}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-ink truncate">{org.org_name}</span>
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full text-white"
                      style={{ background: PLAN_COLORS[org.plan_id] ?? '#9CA3AF' }}>
                      {org.plan_id}
                    </span>
                    {org.stripe_customer_id && (
                      <span className="text-[10px] text-stone/60 font-mono">{org.stripe_customer_id}</span>
                    )}
                  </div>
                  <CounterBadges counters={org.usage_counters ?? {}} />
                </div>
                <i className={`ti ${isActive ? 'ti-check' : 'ti-chevron-right'} text-forest/40`}
                  style={{ fontSize: 14, flexShrink: 0 }} />
              </button>
            )
          })}
        </div>
      </div>

      {selectedOrg && (
        <div className="grid md:grid-cols-2 gap-6">
          {/* ── Panel 2: Record usage ────────────────────────────────────────── */}
          <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-forest/8">
              <div className="text-sm font-medium text-ink flex items-center gap-2 mb-0.5">
                <i className="ti ti-activity" style={{ fontSize: 15 }} />
                Record usage event
              </div>
              <p className="text-xs text-stone">Calls <code className="bg-cream px-1 rounded font-mono text-[10px]">/api/usage/record</code> — real job → org path + writes ledger.</p>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">Job</label>
                {orgJobs.length === 0 ? (
                  <div className="text-xs text-stone/60 italic">No jobs found for this org</div>
                ) : (
                  <select
                    value={recordJobId}
                    onChange={e => setRecordJobId(e.target.value)}
                    className="w-full bg-cream border border-forest/15 rounded-xl px-3 py-2 text-xs text-ink outline-none focus:border-forest"
                  >
                    <option value="">Select a job…</option>
                    {orgJobs.map(j => (
                      <option key={j.id} value={j.id}>
                        {j.id.slice(0, 8)}… — {new Date(j.created_at as string).toLocaleDateString()}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">Metric type</label>
                  <input value={recordMetric} onChange={e => setRecordMetric(e.target.value)}
                    className="w-full bg-cream border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest font-mono"
                    placeholder="sync" />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">Quantity</label>
                  <input type="number" min={1} value={recordQty} onChange={e => setRecordQty(e.target.value)}
                    className="w-full bg-cream border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest" />
                </div>
              </div>
              <div className="flex items-center gap-3">
                <button onClick={handleRecord} disabled={recording || !recordJobId}
                  className="bg-forest text-white text-sm font-medium px-4 py-2 rounded-xl hover:bg-sage transition-colors disabled:opacity-40">
                  {recording ? 'Recording…' : 'Record'}
                </button>
                {recordMsg && (
                  <span className={`text-xs font-medium ${recordMsg.ok ? 'text-forest' : 'text-red-600'}`}>{recordMsg.text}</span>
                )}
              </div>
            </div>
          </div>

          {/* ── Panel 3: Seed / reset ────────────────────────────────────────── */}
          <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-forest/8">
              <div className="text-sm font-medium text-ink flex items-center gap-2 mb-0.5">
                <i className="ti ti-database-edit" style={{ fontSize: 15 }} />
                Seed / reset counters
              </div>
              <p className="text-xs text-stone">Directly manipulates counter cache via admin RPC — also writes to ledger.</p>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">Current counters</label>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  <CounterBadges counters={selectedOrg.usage_counters ?? {}} />
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {Object.keys(selectedOrg.usage_counters ?? {}).map(k => (
                    <button key={k} onClick={() => handleReset(k)} disabled={resetting}
                      className="text-[10px] border border-red-200 text-red-600 hover:bg-red-50 px-2 py-0.5 rounded transition-colors disabled:opacity-40 font-mono">
                      reset {k}
                    </button>
                  ))}
                  {Object.keys(selectedOrg.usage_counters ?? {}).length > 1 && (
                    <button onClick={() => handleReset()} disabled={resetting}
                      className="text-[10px] border border-red-300 text-red-700 hover:bg-red-50 px-2 py-0.5 rounded transition-colors disabled:opacity-40 font-semibold">
                      reset all
                    </button>
                  )}
                </div>
                {resetMsg && (
                  <span className={`block mt-2 text-xs font-medium ${resetMsg.ok ? 'text-forest' : 'text-red-600'}`}>{resetMsg.text}</span>
                )}
              </div>
              <div className="border-t border-forest/8 pt-4">
                <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-2">Add to counter</label>
                <div className="grid grid-cols-2 gap-3 mb-3">
                  <input value={seedMetric} onChange={e => setSeedMetric(e.target.value)}
                    className="bg-cream border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest font-mono"
                    placeholder="sync" />
                  <input type="number" min={1} value={seedAmount} onChange={e => setSeedAmount(e.target.value)}
                    className="bg-cream border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest"
                    placeholder="1" />
                </div>
                <div className="flex items-center gap-3">
                  <button onClick={handleSeed} disabled={seeding}
                    className="bg-forest text-white text-sm font-medium px-4 py-2 rounded-xl hover:bg-sage transition-colors disabled:opacity-40">
                    {seeding ? 'Seeding…' : 'Seed'}
                  </button>
                  {seedMsg && (
                    <span className={`text-xs font-medium ${seedMsg.ok ? 'text-forest' : 'text-red-600'}`}>{seedMsg.text}</span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Panel 4: Billing preview ──────────────────────────────────────────── */}
      {selectedOrg && (
        <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden">
          <div className="px-6 py-4 border-b border-forest/8 flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-ink flex items-center gap-2 mb-0.5">
                <i className="ti ti-receipt-euro" style={{ fontSize: 15 }} />
                Billing preview — current counters
                {previewPlanId && (
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full text-white"
                    style={{ background: PLAN_COLORS[previewPlanId] ?? '#9CA3AF' }}>{previewPlanId}</span>
                )}
              </div>
              <p className="text-xs text-stone">Dry-run using current <code className="bg-cream px-1 rounded font-mono text-[10px]">usage_counters</code> and plan pricing. No Stripe writes.</p>
            </div>
            <button onClick={handlePreview} disabled={previewing}
              className="bg-forest text-white text-sm font-medium px-4 py-2 rounded-xl hover:bg-sage transition-colors disabled:opacity-40 flex-shrink-0">
              {previewing ? 'Computing…' : 'Run preview'}
            </button>
          </div>
          {preview === null && !previewing && (
            <div className="px-6 py-8 text-center text-sm text-stone/60">Click &ldquo;Run preview&rdquo; to see the billing breakdown.</div>
          )}
          {preview !== null && (
            <div className="p-6">
              {preview.length === 0 ? (
                <div className="text-sm text-stone">No counters with billable overage.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left">
                        {['Metric', 'Count', 'Included', 'Overage', '€/unit', 'Total (€)'].map(h => (
                          <th key={h} className="text-[10px] font-semibold text-stone uppercase tracking-widest pb-3 pr-6">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-forest/5">
                      {preview.map(row => (
                        <tr key={row.metric_type}>
                          <td className="py-2.5 pr-6 font-mono text-ink text-xs">{row.metric_type}</td>
                          <td className="py-2.5 pr-6 font-mono text-ink tabular-nums">{row.count.toLocaleString()}</td>
                          <td className="py-2.5 pr-6 font-mono text-stone tabular-nums">{row.included != null ? row.included.toLocaleString() : '∞'}</td>
                          <td className="py-2.5 pr-6 font-mono tabular-nums" style={{ color: row.overage > 0 ? '#C2410C' : '#6B6660' }}>{row.overage.toLocaleString()}</td>
                          <td className="py-2.5 pr-6 font-mono text-stone tabular-nums">€{row.price_per_unit}</td>
                          <td className="py-2.5 font-mono font-semibold tabular-nums" style={{ color: row.total_eur > 0 ? '#1A3D2B' : '#9CA3AF' }}>€{row.total_eur.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-forest/15">
                        <td colSpan={5} className="pt-3 text-xs font-semibold text-ink">Total overage to invoice</td>
                        <td className="pt-3 font-mono font-bold text-ink tabular-nums">€{previewTotal.toFixed(2)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Panel 5: Period simulation ────────────────────────────────────────── */}
      {selectedOrg && (
        <div className="bg-white border border-indigo-100 rounded-2xl overflow-hidden" style={{ background: '#FAFAFE' }}>
          <div className="px-6 py-4 border-b border-indigo-100/70">
            <div className="text-sm font-medium text-ink flex items-center gap-2 mb-0.5">
              <i className="ti ti-clock-play text-indigo-500" style={{ fontSize: 15 }} />
              Period simulation
              <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600 border border-indigo-100">
                TEST ONLY
              </span>
            </div>
            <p className="text-xs text-stone">
              Seed timestamped usage events spread across a billing period, then run a billing simulation
              using <code className="bg-cream px-1 rounded font-mono text-[10px]">org_billing_config</code> tiered pricing. Simulated entries are tagged and never affect real invoices.
            </p>
          </div>

          <div className="p-6 space-y-5">
            {/* Period + meter controls */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="col-span-2 md:col-span-1">
                <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">Period start</label>
                <input type="date" value={simStart} onChange={e => setSimStart(e.target.value)}
                  className="w-full bg-white border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-indigo-400" />
              </div>
              <div className="col-span-2 md:col-span-1">
                <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">Period end</label>
                <input type="date" value={simEnd} onChange={e => setSimEnd(e.target.value)}
                  className="w-full bg-white border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-indigo-400" />
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">Meter</label>
                <input value={simMeter} onChange={e => setSimMeter(e.target.value)}
                  className="w-full bg-white border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-indigo-400 font-mono"
                  placeholder="sync" />
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">Events</label>
                <input type="number" min={1} max={5000} value={simEvents} onChange={e => setSimEvents(e.target.value)}
                  className="w-full bg-white border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-indigo-400"
                  placeholder="100" />
              </div>
            </div>

            {/* Distribution + actions */}
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">Distribution</label>
                <div className="flex gap-1.5">
                  {(['even', 'front', 'random'] as const).map(d => (
                    <button key={d} onClick={() => setSimDistrib(d)}
                      className="text-xs px-3 py-1.5 rounded-lg border transition-colors capitalize"
                      style={simDistrib === d
                        ? { background: '#4F46E5', color: 'white', borderColor: '#4F46E5' }
                        : { background: 'white', color: '#6B7280', borderColor: '#E5E7EB' }
                      }>
                      {d}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2 pb-0.5">
                <button onClick={handleSeedPeriod} disabled={simSeeding}
                  className="text-sm font-medium px-4 py-2 rounded-xl transition-colors disabled:opacity-40 flex items-center gap-1.5"
                  style={{ background: '#4F46E5', color: 'white' }}>
                  <i className="ti ti-player-play" style={{ fontSize: 13 }} />
                  {simSeeding ? 'Seeding…' : 'Seed events'}
                </button>
                <button onClick={handleClearSimulated} disabled={simClearing}
                  className="text-xs px-3 py-2 rounded-xl border border-red-200 text-red-600 hover:bg-red-50 transition-colors disabled:opacity-40">
                  {simClearing ? 'Clearing…' : 'Clear simulated'}
                </button>
                {simSeedMsg && (
                  <span className={`text-xs font-medium ${simSeedMsg.ok ? 'text-forest' : 'text-red-600'}`}>{simSeedMsg.text}</span>
                )}
                {simClearMsg && (
                  <span className={`text-xs font-medium ${simClearMsg.ok ? 'text-forest' : 'text-red-600'}`}>{simClearMsg.text}</span>
                )}
              </div>
            </div>

            {/* Day bar chart */}
            {simByDay && Object.keys(simByDay).length > 0 && (
              <div className="bg-white border border-indigo-100 rounded-xl p-4">
                <div className="text-[10px] font-semibold text-stone uppercase tracking-widest mb-3">
                  Usage distribution — {simMeter} — {Object.values(simByDay).reduce((s, v) => s + v, 0)} events
                </div>
                <DayBarChart byDay={simByDay} />
              </div>
            )}

            {/* Simulate billing run */}
            <div className="border-t border-indigo-100/70 pt-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <div className="text-sm font-medium text-ink mb-0.5">Simulate billing run</div>
                  <p className="text-xs text-stone">
                    Sums <code className="bg-cream px-1 rounded font-mono text-[10px]">usage_ledger</code> (real + simulated) for the period above,
                    applies <code className="bg-cream px-1 rounded font-mono text-[10px]">org_billing_config</code> tiered pricing.
                    Falls back to plan pricing if no billing config is set.
                  </p>
                </div>
                <button onClick={handleSimulateBilling} disabled={simRunning}
                  className="flex-shrink-0 text-sm font-semibold px-4 py-2 rounded-xl transition-colors disabled:opacity-40"
                  style={{ background: '#1A3D2B', color: 'white' }}>
                  {simRunning ? 'Running…' : 'Simulate billing'}
                </button>
              </div>

              {simResult !== null && (
                simResult.length === 0 ? (
                  <div className="text-sm text-stone bg-white border border-forest/10 rounded-xl px-5 py-4">
                    No usage found in this period — seed some events first, or widen the date range.
                  </div>
                ) : (
                  <div className="bg-white border border-forest/10 rounded-xl overflow-hidden">
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left border-b border-forest/8">
                            {['Meter', 'Count', 'Included', 'Overage', 'Tiers', 'Source', 'Overage (€)'].map(h => (
                              <th key={h} className="text-[10px] font-semibold text-stone uppercase tracking-widest px-5 py-3 pr-4">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-forest/5">
                          {simResult.map(row => (
                            <tr key={row.meter_key}>
                              <td className="px-5 py-3 pr-4 font-mono text-ink text-xs">{row.meter_key}</td>
                              <td className="px-5 py-3 pr-4 font-mono text-ink tabular-nums">{row.count.toLocaleString()}</td>
                              <td className="px-5 py-3 pr-4 font-mono text-stone tabular-nums">{row.included.toLocaleString()}</td>
                              <td className="px-5 py-3 pr-4 font-mono tabular-nums"
                                style={{ color: row.overage > 0 ? '#C2410C' : '#6B6660' }}>
                                {row.overage.toLocaleString()}
                              </td>
                              <td className="px-5 py-3 pr-4 text-stone text-xs">
                                {row.tiers_count > 0
                                  ? <span className="bg-indigo-50 text-indigo-600 text-[10px] font-medium px-1.5 py-0.5 rounded">{row.tiers_count} tier{row.tiers_count !== 1 ? 's' : ''}</span>
                                  : <span className="text-stone/40 text-[10px]">flat</span>
                                }
                              </td>
                              <td className="px-5 py-3 pr-4 text-xs">
                                <span className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                                  style={row.source === 'agreement'
                                    ? { background: '#D4EAD9', color: '#1A3D2B' }
                                    : { background: '#EFF6FF', color: '#1D4ED8' }
                                  }>
                                  {row.source}
                                </span>
                              </td>
                              <td className="px-5 py-3 font-mono font-semibold tabular-nums"
                                style={{ color: row.overage_eur > 0 ? '#1A3D2B' : '#9CA3AF' }}>
                                €{row.overage_eur.toFixed(2)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr className="border-t border-forest/15">
                            <td colSpan={6} className="px-5 pt-3 pb-3 text-xs font-semibold text-ink">Total overage (simulation)</td>
                            <td className="px-5 pt-3 pb-3 font-mono font-bold text-ink tabular-nums">€{simResultTotal.toFixed(2)}</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </div>
                )
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
