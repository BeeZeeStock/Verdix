'use client'

import { useEffect, useState, useCallback } from 'react'

type Meter = {
  id:           string
  org_id:       string
  meter_key:    string
  display_name: string
  unit_label:   string
  description:  string | null
  created_at:   string
}

type FormState = {
  meter_key:    string
  display_name: string
  unit_label:   string
  description:  string
}

const EMPTY_FORM: FormState = {
  meter_key: '', display_name: '', unit_label: '', description: '',
}

const BASE_URL = typeof window !== 'undefined'
  ? window.location.origin
  : 'https://lynoraai.com'

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }
  return (
    <button onClick={copy}
      className="text-[10px] font-medium px-2 py-1 rounded-lg border border-forest/20 text-stone hover:bg-forest/5 transition-colors flex items-center gap-1 flex-shrink-0">
      <i className={`ti ${copied ? 'ti-check text-forest' : 'ti-copy'}`} style={{ fontSize: 10 }} />
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

export default function MetersSettingsPage() {
  const [orgMeters,    setOrgMeters]    = useState<Meter[]>([])
  const [loading,      setLoading]      = useState(true)
  const [apiKey,       setApiKey]       = useState<string | null>(null)
  const [keyLoading,   setKeyLoading]   = useState(true)
  const [regenerating, setRegenerating] = useState(false)
  const [msg,          setMsg]          = useState<{ ok: boolean; text: string } | null>(null)
  const [showForm,     setShowForm]     = useState(false)
  const [form,         setForm]         = useState<FormState>(EMPTY_FORM)
  const [adding,       setAdding]       = useState(false)
  const [deleting,     setDeleting]     = useState<string | null>(null)
  const [keyVisible,   setKeyVisible]   = useState(false)

  const set = (k: keyof FormState) => (v: string) => setForm(f => ({ ...f, [k]: v }))

  const applyData = useCallback((res: { org_meters: Meter[] }) => {
    setOrgMeters(res.org_meters ?? [])
  }, [])

  useEffect(() => {
    Promise.all([
      fetch('/api/meters').then(r => r.json()),
      fetch('/api/meters/api-key').then(r => r.json()),
    ]).then(([metersRes, keyRes]) => {
      applyData(metersRes as { org_meters: Meter[] })
      setApiKey((keyRes as { api_key: string }).api_key ?? null)
      setLoading(false)
      setKeyLoading(false)
    }).catch(() => { setLoading(false); setKeyLoading(false) })
  }, [applyData])

  const reload = useCallback(async () => {
    const res = await fetch('/api/meters').then(r => r.json()).catch(() => null)
    if (res) applyData(res as { org_meters: Meter[] })
  }, [applyData])

  const handleRegenerate = async () => {
    if (!confirm('Regenerate API key? The current key will stop working immediately.')) return
    setRegenerating(true)
    const res = await fetch('/api/meters/api-key', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'regenerate' }),
    })
    const data = await res.json() as { api_key: string }
    if (res.ok) { setApiKey(data.api_key); setKeyVisible(true) }
    setRegenerating(false)
  }

  const handleAdd = async () => {
    setAdding(true); setMsg(null)
    const res = await fetch('/api/meters', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        meter_key:    form.meter_key.trim(),
        display_name: form.display_name.trim(),
        unit_label:   form.unit_label.trim(),
        description:  form.description.trim() || undefined,
      }),
    })
    const data = await res.json()
    if (res.ok) {
      setMsg({ ok: true, text: `Meter '${(data as { meter: { meter_key: string } }).meter?.meter_key}' registered ✓` })
      setForm(EMPTY_FORM); setShowForm(false)
      await reload()
    } else {
      setMsg({ ok: false, text: (data as { error: string }).error ?? 'Registration failed' })
    }
    setAdding(false)
  }

  const handleDelete = async (id: string, key: string) => {
    if (!confirm(`Remove meter '${key}'? This cannot be undone.`)) return
    setDeleting(id); setMsg(null)
    const res = await fetch('/api/admin/meters', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'delete', id }),
    })
    const data = await res.json()
    if (res.ok) { setMsg({ ok: true, text: `Removed '${key}' ✓` }); await reload() }
    else          setMsg({ ok: false, text: (data as { error: string }).error ?? 'Delete failed' })
    setDeleting(null)
  }

  if (loading) return <div className="p-8 text-stone text-sm">Loading…</div>

  const maskedKey = apiKey
    ? (keyVisible ? apiKey : `${apiKey.slice(0, 16)}${'•'.repeat(apiKey.length - 16)}`)
    : null

  const codeSnippet = apiKey
    ? `curl -X POST ${BASE_URL}/api/v1/usage \\
  -H "Authorization: Bearer <your-api-key>" \\
  -H "Content-Type: application/json" \\
  -d '{"meter_key":"api_calls","quantity":15420}'`
    : ''

  return (
    <div className="p-4 md:p-8 max-w-3xl space-y-8">
      <div>
        <h1 className="font-display font-light text-ink text-2xl mb-1">Billing Meters</h1>
        <p className="text-stone text-sm">
          Register the usage parameters you use to bill your customers, like number of API calls,
          active seats, etc. At the end of each billing cycle, send Verdix the total count per
          meter using your ingest API key — Verdix applies your contract pricing and generates
          the invoice.
        </p>
      </div>

      {/* ── Ingest API key ──────────────────────────────────────────────────────── */}
      <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden">
        <div className="px-6 py-4 border-b border-forest/8">
          <div className="text-sm font-semibold text-ink flex items-center gap-2">
            <i className="ti ti-key text-forest/60" style={{ fontSize: 14 }} />
            Ingest API key
          </div>
          <p className="text-xs text-stone mt-0.5">Use this key to push usage events to Verdix from your infrastructure.</p>
        </div>
        <div className="px-6 py-5 space-y-4">
          {/* Key display */}
          <div>
            <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-2">Your key</label>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-cream border border-forest/15 rounded-xl px-3 py-2 text-xs font-mono text-ink truncate">
                {keyLoading ? '…' : (maskedKey ?? 'Not generated')}
              </code>
              <button onClick={() => setKeyVisible(v => !v)}
                className="text-[10px] font-medium px-2 py-1.5 rounded-lg border border-forest/20 text-stone hover:bg-forest/5 transition-colors flex-shrink-0">
                <i className={`ti ${keyVisible ? 'ti-eye-off' : 'ti-eye'}`} style={{ fontSize: 11 }} />
              </button>
              {apiKey && <CopyButton text={apiKey} />}
              <button onClick={handleRegenerate} disabled={regenerating}
                className="text-[10px] font-medium px-2 py-1.5 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 transition-colors flex-shrink-0 disabled:opacity-40">
                {regenerating ? '…' : 'Rotate'}
              </button>
            </div>
          </div>

          {/* Code example */}
          {apiKey && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest">Example</label>
                <CopyButton text={codeSnippet} />
              </div>
              <pre className="bg-ink text-green-400 text-[10px] font-mono rounded-xl px-4 py-3 overflow-x-auto leading-relaxed whitespace-pre">
                {codeSnippet}
              </pre>
              <p className="text-[10px] text-stone mt-1.5">
                Send this once at the end of your billing cycle with the total count for each meter. Replace <code className="bg-cream px-1 rounded">api_calls</code> with your meter key.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ── Your registered meters ──────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">Your meters</h2>
            <p className="text-xs text-stone">Each meter key maps to a billing dimension in your contract</p>
          </div>
          <div className="flex items-center gap-2">
            {msg && (
              <span className={`text-xs font-medium ${msg.ok ? 'text-forest' : 'text-red-600'}`}>{msg.text}</span>
            )}
            <button
              onClick={() => { setShowForm(!showForm); setMsg(null); setForm(EMPTY_FORM) }}
              className="text-xs font-medium px-3 py-1.5 rounded-lg bg-forest text-white hover:bg-sage transition-colors flex items-center gap-1.5"
            >
              <i className="ti ti-plus" style={{ fontSize: 12 }} />
              Add meter
            </button>
          </div>
        </div>

        {showForm && (
          <div className="bg-white border border-forest/10 rounded-2xl px-6 py-5 mb-4 space-y-4">
            <div className="text-xs font-semibold text-stone uppercase tracking-widest">New meter</div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">
                  Meter key <span className="text-red-400 normal-case font-normal">required</span>
                </label>
                <input value={form.meter_key} onChange={e => set('meter_key')(e.target.value)}
                  placeholder="e.g. api_call"
                  className="w-full bg-cream border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest font-mono" />
                <p className="text-[10px] text-stone/60 mt-1">Snake_case, letters and digits only</p>
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">
                  Display name <span className="text-red-400 normal-case font-normal">required</span>
                </label>
                <input value={form.display_name} onChange={e => set('display_name')(e.target.value)}
                  placeholder="e.g. API Call"
                  className="w-full bg-cream border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest" />
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">
                  Unit label <span className="text-red-400 normal-case font-normal">required</span>
                </label>
                <input value={form.unit_label} onChange={e => set('unit_label')(e.target.value)}
                  placeholder="e.g. call"
                  className="w-full bg-cream border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest" />
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">Description</label>
                <input value={form.description} onChange={e => set('description')(e.target.value)}
                  placeholder="What this meter tracks (optional)"
                  className="w-full bg-cream border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest" />
              </div>
            </div>
            <div className="flex items-center gap-2 pt-1">
              <button onClick={handleAdd}
                disabled={adding || !form.meter_key || !form.display_name || !form.unit_label}
                className="bg-forest text-white text-sm font-medium px-4 py-2 rounded-xl hover:bg-sage transition-colors disabled:opacity-40">
                {adding ? 'Registering…' : 'Register'}
              </button>
              <button onClick={() => setShowForm(false)}
                className="text-sm px-4 py-2 rounded-xl border border-forest/20 text-stone hover:bg-forest/5 transition-colors">
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden">
          {orgMeters.length === 0 ? (
            <div className="px-6 py-10 text-center">
              <div className="w-10 h-10 rounded-xl bg-forest/8 flex items-center justify-center mx-auto mb-3">
                <i className="ti ti-antenna text-forest/50" style={{ fontSize: 18 }} />
              </div>
              <div className="text-sm font-medium text-ink mb-1">No meters registered yet</div>
              <p className="text-xs text-stone max-w-xs mx-auto">
                Add each billing dimension your platform tracks. Use the meter key in your
                API calls to attribute events to the right counter.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-forest/5">
              {orgMeters.map(m => (
                <div key={m.id} className="px-6 py-4 flex items-center gap-4">
                  <code className="text-xs font-mono font-semibold text-forest bg-forest/8 px-2 py-1 rounded-lg w-32 flex-shrink-0 truncate">
                    {m.meter_key}
                  </code>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-ink">{m.display_name}</div>
                    {m.description && <div className="text-xs text-stone truncate">{m.description}</div>}
                  </div>
                  <div className="text-xs text-stone/60 font-mono flex-shrink-0">{m.unit_label}</div>
                  <button
                    onClick={() => handleDelete(m.id, m.meter_key)}
                    disabled={deleting === m.id}
                    className="text-xs px-2.5 py-1 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 transition-colors disabled:opacity-40 flex-shrink-0">
                    {deleting === m.id ? '…' : 'Remove'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── How it works ───────────────────────────────────────────────────────── */}
      <div className="bg-white border border-forest/10 rounded-2xl px-6 py-5">
        <div className="text-xs font-semibold text-stone uppercase tracking-widest mb-4">How it works</div>
        <ol className="space-y-3">
          {[
            { n: '1', title: 'Register your meters', body: 'Add each billing dimension with a snake_case key. The key is what you send in the API call body.' },
            { n: '2', title: 'Send totals at cycle end', body: 'At the end of each billing cycle, POST the total count per meter to /api/v1/usage using your API key.' },
            { n: '3', title: 'Upload a contract', body: 'When an agreement is uploaded, Verdix auto-maps the contract\'s unit types to your registered meters. A human confirms before approval.' },
            { n: '4', title: 'Verdix invoices at cycle end', body: 'At each billing cycle end, Verdix sums the ledger per meter, applies your contract\'s overage tiers, and pushes the invoice line items to Stripe.' },
          ].map(step => (
            <li key={step.n} className="flex gap-3">
              <span className="w-5 h-5 rounded-full bg-forest/10 text-forest text-[10px] font-bold flex items-center justify-center flex-shrink-0 mt-0.5">{step.n}</span>
              <div>
                <div className="text-xs font-semibold text-ink">{step.title}</div>
                <div className="text-xs text-stone mt-0.5">{step.body}</div>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}
