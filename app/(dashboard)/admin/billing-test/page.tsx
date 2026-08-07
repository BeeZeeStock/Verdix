'use client'

import { useEffect, useState, useCallback } from 'react'
import { BillingTestSimulator } from '@/app/_components/BillingTestSimulator'

type OrgRow = {
  org_id:                 string
  org_name:               string
  plan_id:                string
  usage_counters:         Record<string, number>
  stripe_customer_id:     string | null
  stripe_subscription_id: string | null
  current_period_start:   string | null
  current_period_end:     string | null
}

type BillingRunResult = {
  org_id:        string
  period_start:  string
  period_end:    string
  line_items:    { description: string; amount_eur: number }[]
  total_eur:     number
  invoice_id:    string | null
  invoice_url:   string | null
  dry_run:       boolean
  is_enterprise: boolean
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

  // Panel 6: Bill now
  const [billDryRun,     setBillDryRun]     = useState(true)
  const [billStart,      setBillStart]      = useState(() => defaultPeriod().start)
  const [billEnd,        setBillEnd]        = useState(() => defaultPeriod().end)
  const [billing,        setBilling]        = useState(false)
  const [billResult,     setBillResult]     = useState<BillingRunResult | null>(null)
  const [billError,      setBillError]      = useState<string | null>(null)

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

  // ── Panel 6: Bill now ────────────────────────────────────────────────────────
  const handleBillNow = async () => {
    if (!selectedOrg) return
    setBilling(true); setBillResult(null); setBillError(null)
    const res  = await fetch('/api/admin/billing/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        org_id:       selectedOrg.org_id,
        dry_run:      billDryRun,
        period_start: billStart ? new Date(billStart).toISOString() : undefined,
        period_end:   billEnd   ? new Date(billEnd  ).toISOString() : undefined,
      }),
    })
    const data = await res.json()
    if (res.ok) {
      setBillResult(data as BillingRunResult)
      if (!billDryRun) await loadData()
    } else {
      setBillError(data.error ?? 'Unknown error')
    }
    setBilling(false)
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
                  setBillResult(null); setBillError(null)
                  if (!isActive) {
                    setBillStart(org.current_period_start?.split('T')[0] ?? defaultPeriod().start)
                    setBillEnd(org.current_period_end?.split('T')[0]   ?? defaultPeriod().end)
                  }
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

      {/* ── Panel 5: Contract usage simulation ───────────────────────────────────── */}
      {selectedOrg && (
        <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden">
          <div className="px-6 py-4 border-b border-forest/8">
            <div className="text-sm font-medium text-ink flex items-center gap-2 mb-0.5">
              <i className="ti ti-flask text-forest" style={{ fontSize: 15 }} />
              Contract usage simulation
            </div>
            <p className="text-xs text-stone">
              Simulate a usage reading for one of this org&apos;s meters and preview the overage it would produce on
              each confirmed contract — using the exact same math the real billing cron runs. Preview only; never
              creates invoices or touches Stripe/Remembill.
            </p>
          </div>
          <div className="p-6">
            <BillingTestSimulator orgId={selectedOrg.org_id} />
          </div>
        </div>
      )}

      {/* ── Panel 6: Bill now ─────────────────────────────────────────────────── */}
      {selectedOrg && (
        <div className="bg-white border border-amber-200 rounded-2xl overflow-hidden" style={{ background: '#FFFDF5' }}>
          <div className="px-6 py-4 border-b border-amber-100">
            <div className="text-sm font-medium text-ink flex items-center gap-2 mb-0.5">
              <i className="ti ti-bolt text-amber-500" style={{ fontSize: 15 }} />
              Bill now — Verdix billing engine
              {billDryRun && (
                <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
                  DRY RUN
                </span>
              )}
            </div>
            <p className="text-xs text-stone">
              Runs <code className="bg-cream px-1 rounded font-mono text-[10px]">runBillingForOrg()</code> — computes real invoice from ledger + plan pricing.
              Dry run previews without writing. Live run creates a Stripe invoice and advances the billing period.
            </p>
          </div>

          <div className="p-6 space-y-5">
            {/* Mode toggle */}
            <div className="flex items-center gap-3">
              <label className="text-[10px] font-semibold text-stone uppercase tracking-widest">Mode</label>
              <div className="flex gap-1.5">
                {([true, false] as const).map(isDry => (
                  <button
                    key={String(isDry)}
                    onClick={() => { setBillDryRun(isDry); setBillResult(null); setBillError(null) }}
                    className="text-xs px-3 py-1.5 rounded-lg border transition-colors"
                    style={billDryRun === isDry
                      ? { background: isDry ? '#92400E' : '#1A3D2B', color: 'white', borderColor: isDry ? '#92400E' : '#1A3D2B' }
                      : { background: 'white', color: '#6B7280', borderColor: '#E5E7EB' }
                    }>
                    {isDry ? 'Dry run' : 'Live — creates Stripe invoice'}
                  </button>
                ))}
              </div>
            </div>

            {/* Period pickers */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">Period start</label>
                <input type="date" value={billStart} onChange={e => setBillStart(e.target.value)}
                  className="w-full bg-white border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-amber-400" />
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">Period end</label>
                <input type="date" value={billEnd} onChange={e => setBillEnd(e.target.value)}
                  className="w-full bg-white border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-amber-400" />
              </div>
            </div>

            {/* Action */}
            <div className="flex items-center gap-3">
              <button
                onClick={handleBillNow}
                disabled={billing}
                className="text-sm font-semibold px-5 py-2.5 rounded-xl transition-colors disabled:opacity-40 flex items-center gap-2"
                style={{ background: billDryRun ? '#92400E' : '#1A3D2B', color: 'white' }}
              >
                <i className={`ti ${billDryRun ? 'ti-eye' : 'ti-bolt'}`} style={{ fontSize: 14 }} />
                {billing ? 'Running…' : billDryRun ? 'Preview billing' : 'Issue invoice now'}
              </button>
              {!billDryRun && (
                <span className="text-xs text-amber-700 font-medium">
                  This creates a real Stripe invoice and advances the billing period.
                </span>
              )}
            </div>

            {/* Error */}
            {billError && (
              <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">
                {billError}
              </div>
            )}

            {/* Result */}
            {billResult && (
              <div className="bg-white border border-forest/10 rounded-xl overflow-hidden">
                <div className="px-5 py-3 border-b border-forest/8 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-ink">
                      {billResult.dry_run ? 'Dry run result' : 'Invoice created'}
                    </span>
                    {billResult.is_enterprise && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-forest/10 text-forest">enterprise</span>
                    )}
                    <span className="text-[10px] text-stone font-mono">
                      {new Date(billResult.period_start).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                      {' → '}
                      {new Date(billResult.period_end).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </span>
                  </div>
                  {billResult.invoice_id && (
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-mono text-stone">{billResult.invoice_id}</span>
                      <a
                        href={billResult.invoice_url ?? `https://dashboard.stripe.com/test/invoices/${billResult.invoice_id}`}
                        target="_blank" rel="noreferrer"
                        className="text-[10px] font-medium text-forest underline hover:text-sage">
                        View in Stripe →
                      </a>
                    </div>
                  )}
                </div>
                {billResult.line_items.length === 0 ? (
                  <div className="px-5 py-4 text-sm text-stone">Nothing to bill for this period.</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left border-b border-forest/8">
                          <th className="text-[10px] font-semibold text-stone uppercase tracking-widest px-5 py-3">Description</th>
                          <th className="text-[10px] font-semibold text-stone uppercase tracking-widest px-5 py-3">Amount (€)</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-forest/5">
                        {billResult.line_items.map((item, i) => (
                          <tr key={i}>
                            <td className="px-5 py-3 text-ink text-xs">{item.description}</td>
                            <td className="px-5 py-3 font-mono font-semibold tabular-nums text-ink">
                              €{item.amount_eur.toFixed(2)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="border-t-2 border-forest/15">
                          <td className="px-5 pt-3 pb-3 text-xs font-semibold text-ink">Total</td>
                          <td className="px-5 pt-3 pb-3 font-mono font-bold text-ink tabular-nums text-base">
                            €{billResult.total_eur.toFixed(2)}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
                {!billResult.dry_run && billResult.invoice_id && (
                  <div className="px-5 py-3 bg-forest/5 border-t border-forest/8 text-xs text-forest font-medium">
                    Period advanced. Next billing period starts {new Date(billResult.period_end).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
