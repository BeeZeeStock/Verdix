'use client'

import { useEffect, useState, useCallback } from 'react'

type Meter = {
  id:                string
  org_id:            string | null
  meter_key:         string
  display_name:      string
  unit_label:        string
  pull_endpoint_url: string | null
  mode:              'test' | 'live'
  test_usage_value:  number | null
}

type SimulatedJob = {
  jobId:         string
  customerName:  string | null
  includedUnits: number
  billableUnits: number
  amount:        number
  description:   string
}

type SimulateResult = {
  meterKey:   string
  meterLabel: string
  unitLabel:  string
  testValue:  number
  jobs:       SimulatedJob[]
}

function fmt(amount: number) {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR' }).format(amount)
}

export function BillingTestSimulator({ orgId }: { orgId?: string }) {
  const [meters,   setMeters]   = useState<Meter[]>([])
  const [loading,  setLoading]  = useState(true)
  const [selected, setSelected] = useState<string | null>(null)
  const [value,    setValue]    = useState('')
  const [result,   setResult]   = useState<SimulateResult | null>(null)
  const [running,  setRunning]  = useState(false)
  const [error,    setError]    = useState<string | null>(null)

  const fetchMeters = useCallback(async () => {
    if (orgId) {
      const res = await fetch('/api/admin/meters').then(r => r.json()).catch(() => null)
      const all = (res?.meters ?? []) as Meter[]
      return all.filter(m => m.org_id === orgId)
    }
    const res = await fetch('/api/meters').then(r => r.json()).catch(() => null)
    return (res?.org_meters ?? []) as Meter[]
  }, [orgId])

  useEffect(() => {
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    fetchMeters().then(list => { if (!cancelled) { setMeters(list); setLoading(false) } })
    return () => { cancelled = true }
  }, [fetchMeters])

  const meter = meters.find(m => m.id === selected) ?? null

  const runSimulation = async () => {
    if (!meter) return
    const testValue = parseFloat(value)
    if (Number.isNaN(testValue) || testValue < 0) return
    setRunning(true); setError(null); setResult(null)
    try {
      const res = await fetch('/api/billing-test/simulate', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meter_id: meter.id, test_value: testValue, ...(orgId ? { org_id: orgId } : {}) }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Simulation failed'); return }
      setResult(data as SimulateResult)
    } catch {
      setError('Network error — please try again')
    } finally {
      setRunning(false)
    }
  }

  if (loading) return (
    <div className="flex items-center gap-3 py-6">
      <div className="w-4 h-4 border-2 border-forest border-t-transparent rounded-full animate-spin" />
      <span className="text-[12px] text-stone">Loading meters…</span>
    </div>
  )

  const testMeters = meters.filter(m => m.mode === 'test')
  const liveMeters  = meters.filter(m => m.mode === 'live')

  if (meters.length === 0) {
    return (
      <div className="text-center py-8">
        <i className="ti ti-antenna text-forest/30 block mb-2" style={{ fontSize: 24 }} />
        <p className="text-sm text-stone">No meters registered for this organisation yet.</p>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div>
        <label className="text-[10px] font-semibold uppercase tracking-wider text-stone block mb-1.5">Meter</label>
        <select
          value={selected ?? ''}
          onChange={e => { setSelected(e.target.value || null); setResult(null); setError(null) }}
          className="w-full text-sm border border-forest/20 rounded-lg px-3 py-2 bg-white text-ink focus:outline-none focus:border-forest/40"
        >
          <option value="">Select a meter…</option>
          {testMeters.length > 0 && (
            <optgroup label="Test mode">
              {testMeters.map(m => <option key={m.id} value={m.id}>{m.display_name} ({m.meter_key})</option>)}
            </optgroup>
          )}
          {liveMeters.length > 0 && (
            <optgroup label="Live — real billing already uses these">
              {liveMeters.map(m => <option key={m.id} value={m.id}>{m.display_name} ({m.meter_key})</option>)}
            </optgroup>
          )}
        </select>
        {meter?.mode === 'live' && (
          <p className="text-[11px] text-amber-600 mt-1.5 flex items-center gap-1">
            <i className="ti ti-alert-triangle" style={{ fontSize: 11 }} />
            This meter is live — simulating here is safe (preview only, no invoices are created), but real billing already pulls from its endpoint.
          </p>
        )}
      </div>

      {meter && (
        <div>
          <label className="text-[10px] font-semibold uppercase tracking-wider text-stone block mb-1.5">
            Simulated usage ({meter.unit_label})
          </label>
          <div className="flex items-center gap-2">
            <input
              type="number" min="0" step="1"
              value={value}
              onChange={e => setValue(e.target.value)}
              placeholder={`e.g. 15420`}
              className="flex-1 text-sm border border-forest/20 rounded-lg px-3 py-2 bg-white text-ink placeholder:text-stone/50 focus:outline-none focus:border-forest/40"
            />
            <button
              onClick={runSimulation}
              disabled={running || !value}
              className="inline-flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-xl transition-colors disabled:opacity-40 flex-shrink-0"
              style={{ background: '#1A3D2B', color: '#fff' }}
            >
              {running
                ? <><i className="ti ti-loader-2 animate-spin" style={{ fontSize: 13 }} /> Running…</>
                : <><i className="ti ti-player-play" style={{ fontSize: 13 }} /> Simulate</>
              }
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-red-600">{error}</p>}

      {result && (
        <div className="border-t border-forest/8 pt-4">
          <p className="text-[10px] font-semibold text-stone uppercase tracking-wider mb-3">
            {result.jobs.length === 0
              ? 'No confirmed contracts are mapped to this meter yet'
              : `Preview — ${result.jobs.length} confirmed contract${result.jobs.length > 1 ? 's' : ''} affected`}
          </p>
          <div className="space-y-2">
            {result.jobs.map(j => (
              <div key={j.jobId} className="bg-cream/40 border border-forest/10 rounded-xl px-4 py-3">
                <div className="flex items-center justify-between mb-1">
                  <p className="text-sm font-medium text-ink">{j.customerName ?? j.jobId}</p>
                  <p className="text-sm font-semibold" style={{ color: '#0B5C36' }}>{fmt(j.amount)}</p>
                </div>
                <p className="text-[11px] text-stone leading-snug">{j.description}</p>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-stone/60 mt-3">
            Preview only — no invoices were created and nothing was sent to Stripe or Remembill.
          </p>
        </div>
      )}
    </div>
  )
}
