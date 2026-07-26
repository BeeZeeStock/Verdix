'use client'

import { useEffect, useState, useCallback } from 'react'

type Meter = {
  id:                  string
  org_id:              string
  meter_key:           string
  display_name:        string
  unit_label:          string
  description:         string | null
  pull_endpoint_url:   string | null
  pull_param_name:     string
  pull_auth_token_set: boolean
  created_at:          string
}

type FormState = {
  meter_key:           string
  display_name:        string
  unit_label:          string
  description:         string
  pull_endpoint_url:   string
  pull_auth_token:     string
  pull_param_name:     string
}

type EndpointDraft = {
  url:        string
  token:      string
  paramName:  string
}

const EMPTY_FORM: FormState = {
  meter_key: '', display_name: '', unit_label: '', description: '',
  pull_endpoint_url: '', pull_auth_token: '', pull_param_name: '',
}

function CopyButton({ text, label }: { text: string; label?: string }) {
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
      {copied ? 'Copied' : (label ?? 'Copy')}
    </button>
  )
}

function StatusBadge({ configured }: { configured: boolean }) {
  if (configured) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-forest bg-forest/8 px-2 py-0.5 rounded-full">
        <span className="w-1.5 h-1.5 rounded-full bg-forest inline-block" />
        Endpoint configured
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full">
      <span className="w-1.5 h-1.5 rounded-full bg-amber-500 inline-block" />
      No endpoint
    </span>
  )
}

export default function MetersSettingsPage() {
  const [orgMeters,   setOrgMeters]   = useState<Meter[]>([])
  const [loading,     setLoading]     = useState(true)
  const [msg,         setMsg]         = useState<{ ok: boolean; text: string } | null>(null)
  const [showForm,    setShowForm]    = useState(false)
  const [form,        setForm]        = useState<FormState>(EMPTY_FORM)
  const [adding,      setAdding]      = useState(false)
  const [deleting,    setDeleting]    = useState<string | null>(null)
  const [expandedId,  setExpandedId]  = useState<string | null>(null)
  const [drafts,      setDrafts]      = useState<Record<string, EndpointDraft>>({})
  const [saving,      setSaving]      = useState<string | null>(null)

  const set = (k: keyof FormState) => (v: string) => setForm(f => ({ ...f, [k]: v }))

  const applyData = useCallback((res: { org_meters: Meter[] }) => {
    setOrgMeters(res.org_meters ?? [])
  }, [])

  useEffect(() => {
    fetch('/api/meters').then(r => r.json())
      .then(res => { applyData(res as { org_meters: Meter[] }); setLoading(false) })
      .catch(() => setLoading(false))
  }, [applyData])

  const reload = useCallback(async () => {
    const res = await fetch('/api/meters').then(r => r.json()).catch(() => null)
    if (res) applyData(res as { org_meters: Meter[] })
  }, [applyData])

  const openEndpoint = (m: Meter) => {
    if (expandedId === m.id) { setExpandedId(null); return }
    setExpandedId(m.id)
    setDrafts(d => ({
      ...d,
      [m.id]: d[m.id] ?? {
        url:       m.pull_endpoint_url ?? '',
        token:     '',
        paramName: m.pull_param_name ?? 'billing_parameter',
      },
    }))
  }

  const updateDraft = (id: string, key: keyof EndpointDraft, val: string) =>
    setDrafts(d => ({ ...d, [id]: { ...d[id], [key]: val } }))

  const saveEndpoint = async (m: Meter) => {
    const draft = drafts[m.id]
    if (!draft) return
    setSaving(m.id)
    const body: Record<string, unknown> = {
      id:                 m.id,
      pull_endpoint_url:  draft.url.trim() || null,
      pull_param_name:    draft.paramName.trim() || 'billing_parameter',
    }
    if (draft.token.trim()) body.pull_auth_token = draft.token.trim()

    const res  = await fetch('/api/meters', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const data = await res.json()
    if (res.ok) {
      setMsg({ ok: true, text: `Endpoint saved for '${m.meter_key}' ✓` })
      setExpandedId(null)
      await reload()
    } else {
      setMsg({ ok: false, text: (data as { error: string }).error ?? 'Save failed' })
    }
    setSaving(null)
  }

  const handleAdd = async () => {
    setAdding(true); setMsg(null)
    const body: Record<string, unknown> = {
      meter_key:    form.meter_key.trim(),
      display_name: form.display_name.trim(),
      unit_label:   form.unit_label.trim(),
      description:  form.description.trim() || undefined,
      pull_param_name: form.pull_param_name.trim() || 'billing_parameter',
    }
    if (form.pull_endpoint_url.trim()) body.pull_endpoint_url = form.pull_endpoint_url.trim()
    if (form.pull_auth_token.trim())   body.pull_auth_token   = form.pull_auth_token.trim()

    const res  = await fetch('/api/meters', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
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
    const res  = await fetch('/api/admin/meters', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'delete', id }) })
    const data = await res.json()
    if (res.ok) { setMsg({ ok: true, text: `Removed '${key}' ✓` }); await reload() }
    else          setMsg({ ok: false, text: (data as { error: string }).error ?? 'Delete failed' })
    setDeleting(null)
  }

  if (loading) return <div className="p-8 text-stone text-sm">Loading…</div>

  return (
    <div className="p-4 md:p-8 max-w-3xl space-y-8">

      {/* ── Page header ── */}
      <div>
        <h1 className="font-display font-light text-ink text-2xl mb-1">Billing Meters</h1>
        <p className="text-stone text-sm leading-relaxed">
          Register each usage parameter you want Verdix to bill your customers. At the end of each billing cycle,
          Verdix calls your endpoint — passing the billing period and customer ID — and generates
          invoices based on the totals you return.
        </p>
      </div>

      {/* ── Request format ── */}
      <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden">
        <div className="px-6 py-4 border-b border-forest/8">
          <div className="text-sm font-semibold text-ink flex items-center gap-2">
            <i className="ti ti-arrows-exchange text-forest/60" style={{ fontSize: 14 }} />
            What Verdix sends to your endpoint
          </div>
          <p className="text-xs text-stone mt-0.5">
            Configure one endpoint URL per meter. Verdix calls it with these parameters and expects the total back.
          </p>
        </div>
        <div className="px-6 py-5 space-y-4">
          {/* Request */}
          <div>
            <div className="text-[10px] font-semibold text-stone uppercase tracking-widest mb-2">Request</div>
            <div className="bg-ink rounded-xl overflow-hidden">
              <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-white/5">
                <span className="w-2 h-2 rounded-full bg-[#FF5F56]" />
                <span className="w-2 h-2 rounded-full bg-[#FFBD2E]" />
                <span className="w-2 h-2 rounded-full bg-[#27C93F]" />
                <span className="ml-auto text-[10px] text-white/25 font-mono">bash</span>
              </div>
              <pre className="text-green-400 text-[10px] font-mono px-4 py-3 overflow-x-auto leading-[1.9] whitespace-pre">{`GET https://your-api.example.com/billing/usage
  ?period_start=2026-01-01T00:00:00Z
  &period_end=2026-02-01T00:00:00Z
  &crm_id=<customer-crm-id>
  &<meter_param>=api_calls

Authorization: Bearer <your-auth-token>`}</pre>
            </div>
          </div>
          {/* Response */}
          <div>
            <div className="text-[10px] font-semibold text-stone uppercase tracking-widest mb-2">Expected response</div>
            <div className="bg-ink rounded-xl overflow-hidden">
              <pre className="text-blue-300 text-[10px] font-mono px-4 py-3 leading-relaxed whitespace-pre">{`{
  "total_billable_units": 15420
}`}</pre>
            </div>
          </div>
          {/* Params table */}
          <div>
            <div className="text-[10px] font-semibold text-stone uppercase tracking-widest mb-2">Query parameters Verdix always sends</div>
            <div className="border border-forest/10 rounded-xl overflow-hidden">
              {[
                { name: 'period_start', desc: 'ISO 8601 UTC — start of the billing period (inclusive)', example: '2026-01-01T00:00:00Z' },
                { name: 'period_end',   desc: 'ISO 8601 UTC — end of the billing period (exclusive)',  example: '2026-02-01T00:00:00Z' },
                { name: 'crm_id',       desc: 'Customer ID from the contract — use this to look up the customer in your system', example: 'ABC-123' },
                { name: '<meter_param>', desc: 'The meter key being queried. Param name is the one you configure per meter below.', example: 'api_calls' },
              ].map((p, i, arr) => (
                <div key={p.name} className={`flex gap-3 px-4 py-2.5 text-xs ${i < arr.length - 1 ? 'border-b border-forest/8' : ''}`}>
                  <code className="font-mono text-[11px] text-forest bg-forest/6 px-1.5 py-0.5 rounded self-start flex-shrink-0 w-32 truncate">{p.name}</code>
                  <span className="text-stone flex-1 leading-relaxed">{p.desc}</span>
                  <code className="font-mono text-[11px] text-stone/60 flex-shrink-0 self-start">{p.example}</code>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── Your meters ── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">Your meters</h2>
            <p className="text-xs text-stone">Configure one pull endpoint per meter</p>
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

        {/* Add form */}
        {showForm && (
          <div className="bg-white border border-forest/10 rounded-2xl mb-4 overflow-hidden">
            <div className="px-6 py-4 border-b border-forest/8 text-xs font-semibold text-stone uppercase tracking-widest">
              New meter
            </div>
            <div className="px-6 py-5 space-y-5">
              {/* Meter details */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">
                    Meter key <span className="text-red-400 normal-case font-normal">required</span>
                  </label>
                  <input value={form.meter_key} onChange={e => set('meter_key')(e.target.value)}
                    placeholder="e.g. api_calls"
                    className="w-full bg-cream border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest font-mono" />
                  <p className="text-[10px] text-stone/60 mt-1">snake_case — this is what you pass in <code className="font-mono">billing_parameter=…</code></p>
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">
                    Display name <span className="text-red-400 normal-case font-normal">required</span>
                  </label>
                  <input value={form.display_name} onChange={e => set('display_name')(e.target.value)}
                    placeholder="e.g. API Calls"
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

              {/* Pull endpoint (collapsible within form) */}
              <div className="border-t border-forest/8 pt-4 space-y-4">
                <div className="text-[10px] font-semibold text-stone uppercase tracking-widest">Pull endpoint (optional — can be added later)</div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="col-span-2">
                    <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">Endpoint URL</label>
                    <input value={form.pull_endpoint_url} onChange={e => set('pull_endpoint_url')(e.target.value)}
                      placeholder="https://your-api.example.com/billing/usage"
                      autoComplete="off"
                      className="w-full bg-cream border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest font-mono" />
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">Bearer token</label>
                    <input value={form.pull_auth_token} onChange={e => set('pull_auth_token')(e.target.value)}
                      type="password"
                      placeholder="Token Verdix will send in Authorization header"
                      className="w-full bg-cream border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest" />
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">Meter key param name</label>
                    <input value={form.pull_param_name} onChange={e => set('pull_param_name')(e.target.value)}
                      placeholder="billing_parameter"
                      className="w-full bg-cream border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest font-mono" />
                    <p className="text-[10px] text-stone/60 mt-1">Query param name that carries the meter key</p>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <button onClick={handleAdd}
                  disabled={adding || !form.meter_key || !form.display_name || !form.unit_label}
                  className="bg-forest text-white text-sm font-medium px-4 py-2 rounded-xl hover:bg-sage transition-colors disabled:opacity-40">
                  {adding ? 'Registering…' : 'Register meter'}
                </button>
                <button onClick={() => setShowForm(false)}
                  className="text-sm px-4 py-2 rounded-xl border border-forest/20 text-stone hover:bg-forest/5 transition-colors">
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Meter list */}
        <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden">
          {orgMeters.length === 0 ? (
            <div className="px-6 py-10 text-center">
              <div className="w-10 h-10 rounded-xl bg-forest/8 flex items-center justify-center mx-auto mb-3">
                <i className="ti ti-antenna text-forest/50" style={{ fontSize: 18 }} />
              </div>
              <div className="text-sm font-medium text-ink mb-1">No meters registered yet</div>
              <p className="text-xs text-stone max-w-xs mx-auto">
                Add each billing dimension you track. Verdix will call your endpoint once per meter at the end of each cycle.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-forest/5">
              {orgMeters.map(m => {
                const isExpanded = expandedId === m.id
                const draft      = drafts[m.id]
                return (
                  <div key={m.id}>
                    {/* Meter row */}
                    <div className="px-6 py-4 flex items-center gap-4">
                      <code className="text-xs font-mono font-semibold text-forest bg-forest/8 px-2 py-1 rounded-lg w-36 flex-shrink-0 truncate">
                        {m.meter_key}
                      </code>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-ink">{m.display_name}</div>
                        {m.description && <div className="text-xs text-stone truncate">{m.description}</div>}
                      </div>
                      <div className="text-xs text-stone/60 font-mono flex-shrink-0">{m.unit_label}</div>
                      <StatusBadge configured={Boolean(m.pull_endpoint_url)} />
                      <button
                        onClick={() => openEndpoint(m)}
                        className="text-xs font-medium px-2.5 py-1 rounded-lg border border-forest/20 text-stone hover:bg-forest/5 transition-colors flex-shrink-0 flex items-center gap-1"
                      >
                        <i className={`ti ${isExpanded ? 'ti-chevron-up' : 'ti-settings'}`} style={{ fontSize: 11 }} />
                        {isExpanded ? 'Close' : (m.pull_endpoint_url ? 'Edit endpoint' : 'Configure endpoint')}
                      </button>
                      <button
                        onClick={() => handleDelete(m.id, m.meter_key)}
                        disabled={deleting === m.id}
                        className="text-xs px-2.5 py-1 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 transition-colors disabled:opacity-40 flex-shrink-0">
                        {deleting === m.id ? '…' : 'Remove'}
                      </button>
                    </div>

                    {/* Endpoint config (expanded) */}
                    {isExpanded && draft && (
                      <div className="px-6 pb-5 pt-1 bg-forest/2 border-t border-forest/6">
                        <div className="text-[10px] font-semibold text-stone uppercase tracking-widest mb-3 pt-3">
                          Pull endpoint — <span className="font-mono normal-case">{m.meter_key}</span>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div className="col-span-2">
                            <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">Endpoint URL</label>
                            <input
                              value={draft.url}
                              onChange={e => updateDraft(m.id, 'url', e.target.value)}
                              placeholder="https://your-api.example.com/billing/usage"
                              autoComplete="off"
                              className="w-full bg-white border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest font-mono"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">
                              Bearer token{m.pull_auth_token_set && <span className="ml-1 text-forest font-normal normal-case">● set</span>}
                            </label>
                            <input
                              value={draft.token}
                              onChange={e => updateDraft(m.id, 'token', e.target.value)}
                              type="password"
                              placeholder={m.pull_auth_token_set ? 'Leave blank to keep existing token' : 'Token for Authorization header'}
                              className="w-full bg-white border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">Meter key param name</label>
                            <input
                              value={draft.paramName}
                              onChange={e => updateDraft(m.id, 'paramName', e.target.value)}
                              placeholder="billing_parameter"
                              className="w-full bg-white border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest font-mono"
                            />
                            <p className="text-[10px] text-stone/60 mt-1">Query param name Verdix uses to pass the meter key</p>
                          </div>
                        </div>

                        {/* Live URL preview */}
                        {draft.url && (
                          <div className="mt-4">
                            <div className="text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">Verdix will call</div>
                            <div className="bg-ink rounded-xl overflow-hidden">
                              <div className="flex items-center gap-1.5 px-3 py-2 border-b border-white/5">
                                <span className="w-1.5 h-1.5 rounded-full bg-[#FF5F56]" />
                                <span className="w-1.5 h-1.5 rounded-full bg-[#FFBD2E]" />
                                <span className="w-1.5 h-1.5 rounded-full bg-[#27C93F]" />
                                <span className="ml-auto text-[9px] text-white/20 font-mono">preview</span>
                              </div>
                              <pre className="text-green-400 text-[10px] font-mono px-3 py-2.5 overflow-x-auto leading-[1.9] whitespace-pre">{`GET ${draft.url}
  ?period_start=<period-start>
  &period_end=<period-end>
  &crm_id=<customer-crm-id>
  &${draft.paramName || 'billing_parameter'}=${m.meter_key}

Authorization: Bearer <your-token>

→ Expected response:
  { "total_billable_units": <number> }`}</pre>
                            </div>
                          </div>
                        )}
                        <div className="flex items-center gap-2 mt-4">
                          <button
                            onClick={() => saveEndpoint(m)}
                            disabled={saving === m.id}
                            className="bg-forest text-white text-sm font-medium px-4 py-2 rounded-xl hover:bg-sage transition-colors disabled:opacity-40"
                          >
                            {saving === m.id ? 'Saving…' : 'Save endpoint'}
                          </button>
                          <button
                            onClick={() => setExpandedId(null)}
                            className="text-sm px-4 py-2 rounded-xl border border-forest/20 text-stone hover:bg-forest/5 transition-colors"
                          >
                            Cancel
                          </button>
                          {m.pull_endpoint_url && (
                            <CopyButton
                              label="Copy URL"
                              text={`${m.pull_endpoint_url}?period_start=<start>&period_end=<end>&crm_id=<id>&${draft.paramName || 'billing_parameter'}=${m.meter_key}`}
                            />
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
