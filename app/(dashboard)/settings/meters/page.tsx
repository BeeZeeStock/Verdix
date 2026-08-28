'use client'

import { useEffect, useState, useCallback } from 'react'

type Meter = {
  id:                  string
  org_id:              string | null
  meter_key:           string
  display_name:        string
  unit_label:          string
  description:         string | null
  semantic_input_key:  string | null
  pull_endpoint_url:   string | null
  pull_param_name:     string
  pull_auth_token_set: boolean
  mode:                'test' | 'live'
  test_usage_value:    number | null
  connector:           string | null
  response_metric_key: string | null
  created_at:          string
}

// Per-connector docs for pre-configured (org_id: null) meters — these are
// wired directly by Verdix, not through the generic pull_endpoint_url
// mechanism, so what "Verdix sends" is a fixed, real contract per connector
// rather than something the org configures. Keyed by billing_meters.connector;
// add an entry here whenever a new connector partner comes online.
const CONNECTOR_DOCS: Record<string, {
  title: string; blurb: string; request: string; response: string
}> = {
  remembill: {
    title: 'How Verdix pulls your Remembill meters',
    blurb: 'These meters are wired directly to the Remembill usage API — there is nothing to configure below. Verdix calls this automatically at billing time, using the Remembill connection from Integrations.',
    request: `GET https://api.remembill.com/integrations/verdix/v1/customers/{customer_id}/usage
  ?start=20260801
  &end=20260831

Authorization: Bearer <your Remembill API key, from Integrations>`,
    response: `{
  "data": {
    "customer_id": "cus_...",
    "period": { "start": "20260801", "end": "20260831" },
    "usage": [
      { "metric": "INVOICE_SENT",  "quantity": 19 },
      { "metric": "EMAIL_SENT",    "quantity": 44 },
      { "metric": "SMS_SENT",      "quantity": 11 },
      { "metric": "LETTER_SENT",   "quantity": 2 },
      { "metric": "REMINDER_SENT", "quantity": 6 }
    ]
  }
}`,
  },
}

function ConnectorLogo({ connector }: { connector: string }) {
  const initial = connector.slice(0, 1).toUpperCase()
  const bg = connector === 'remembill' ? '#4F46E5' : '#6B6660'
  return (
    <div className="w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0" style={{ background: bg }}>
      <span className="text-white text-[10px] font-bold leading-none">{initial}</span>
    </div>
  )
}

// Step 17D.2, item B — a customer org admin creates a connector-backed
// meter (e.g. Remembill's) through this same form now, not just a
// generic pull-endpoint one. 'generic' keeps today's exact endpoint/token
// fields; a real connector (currently only 'remembill') replaces them
// with response_metric_key — the field the connector dispatch actually
// keys its pull on (lib/meter-quantity-pull.ts) — which must therefore be
// a real, editable field here, never display-only.
type SourceType = 'generic' | 'remembill'

type FormState = {
  meter_key:           string
  display_name:        string
  unit_label:          string
  description:         string
  semantic_input_key:  string
  source_type:         SourceType
  response_metric_key: string
  pull_endpoint_url:   string
  pull_auth_token:     string
  pull_param_name:     string
}

type EndpointDraft = {
  url:               string
  token:             string
  paramName:         string
  semanticKey:       string
  responseMetricKey: string
}

const EMPTY_FORM: FormState = {
  meter_key: '', display_name: '', unit_label: '', description: '', semantic_input_key: '',
  source_type: 'generic', response_metric_key: '',
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
  // Step 17D.1 — /api/meters returns one flat, org-scoped list (item A:
  // org_id is the sole ownership column — there is no separate
  // platform-wide catalog to merge in here). Connector-backed meters
  // (e.g. Remembill) and self-configured pull-endpoint meters are simply
  // grouped client-side by whether `connector` is set, for display only.
  const [meters,      setMeters]      = useState<Meter[]>([])
  const [loading,     setLoading]     = useState(true)
  const [msg,         setMsg]         = useState<{ ok: boolean; text: string } | null>(null)
  const [showForm,    setShowForm]    = useState(false)
  const [form,        setForm]        = useState<FormState>(EMPTY_FORM)
  const [adding,      setAdding]      = useState(false)
  const [deleting,    setDeleting]    = useState<string | null>(null)
  const [expandedId,  setExpandedId]  = useState<string | null>(null)
  const [drafts,      setDrafts]      = useState<Record<string, EndpointDraft>>({})
  const [saving,      setSaving]      = useState<string | null>(null)
  const [togglingId,  setTogglingId]  = useState<string | null>(null)

  const set = (k: keyof FormState) => (v: string) => setForm(f => ({ ...f, [k]: v }))

  const applyData = useCallback((res: { meters?: Meter[] }) => {
    setMeters(res.meters ?? [])
  }, [])

  useEffect(() => {
    fetch('/api/meters').then(r => r.json())
      .then(res => { applyData(res as { meters: Meter[] }); setLoading(false) })
      .catch(() => setLoading(false))
  }, [applyData])

  const reload = useCallback(async () => {
    const res = await fetch('/api/meters').then(r => r.json()).catch(() => null)
    if (res) applyData(res as { meters: Meter[] })
  }, [applyData])

  const connectorMeters = meters.filter(m => m.connector)
  const orgMeters        = meters.filter(m => !m.connector)

  const openEndpoint = (m: Meter) => {
    if (expandedId === m.id) { setExpandedId(null); return }
    setExpandedId(m.id)
    setDrafts(d => ({
      ...d,
      [m.id]: d[m.id] ?? {
        url:               m.pull_endpoint_url ?? '',
        token:             '',
        paramName:         m.pull_param_name ?? 'billing_parameter',
        semanticKey:       m.semantic_input_key ?? '',
        responseMetricKey: m.response_metric_key ?? '',
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
      semantic_input_key: draft.semanticKey.trim() || null,
    }
    // A connector-backed meter (e.g. Remembill) has no pull endpoint of
    // its own to edit — response_metric_key is the only thing this panel
    // can change for it. A generic meter keeps the existing endpoint/
    // token/param fields untouched.
    if (m.connector) {
      body.response_metric_key = draft.responseMetricKey.trim() || null
    } else {
      body.pull_endpoint_url = draft.url.trim() || null
      body.pull_param_name   = draft.paramName.trim() || 'billing_parameter'
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
      semantic_input_key: form.semantic_input_key.trim() || undefined,
    }
    if (form.source_type === 'remembill') {
      body.connector = 'remembill'
      body.response_metric_key = form.response_metric_key.trim()
    } else {
      body.pull_param_name = form.pull_param_name.trim() || 'billing_parameter'
      if (form.pull_endpoint_url.trim()) body.pull_endpoint_url = form.pull_endpoint_url.trim()
      if (form.pull_auth_token.trim())   body.pull_auth_token   = form.pull_auth_token.trim()
    }

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

  const handleToggleMode = async (m: Meter) => {
    const nextMode = m.mode === 'live' ? 'test' : 'live'
    if (nextMode === 'live' && !m.pull_endpoint_url) {
      setMsg({ ok: false, text: `'${m.meter_key}' needs a pull endpoint before it can go live` })
      return
    }
    setTogglingId(m.id); setMsg(null)
    const res  = await fetch('/api/meters', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: m.id, mode: nextMode }) })
    const data = await res.json()
    if (res.ok) { setMsg({ ok: true, text: `'${m.meter_key}' is now ${nextMode} ✓` }); await reload() }
    else          setMsg({ ok: false, text: (data as { error: string }).error ?? 'Toggle failed' })
    setTogglingId(null)
  }

  const handleDelete = async (id: string, key: string) => {
    if (!confirm(`Remove meter '${key}'? This cannot be undone.`)) return
    setDeleting(id); setMsg(null)
    const res  = await fetch(`/api/meters?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
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
          invoices based on the totals you return. New meters start in <span className="text-amber-600 font-medium">Test</span> mode
          — use the <a href="/settings/billing-test" className="text-forest underline hover:no-underline">Billing test</a> page to simulate usage before switching to <span className="text-forest font-medium">Live</span>.
        </p>
      </div>

      {/* ── Connector-backed meters (Verdix-managed connectors, e.g. Remembill) ── */}
      {connectorMeters.length > 0 && (
        <div className="space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-ink">Connector-backed meters</h2>
            <p className="text-xs text-stone">Wired up by Verdix already — nothing to set up, just confirm them when mapping a contract.</p>
          </div>

          <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden">
            <div className="divide-y divide-forest/5">
              {connectorMeters.map(m => {
                const isExpanded = expandedId === m.id
                const draft      = drafts[m.id]
                return (
                <div key={m.id}>
                <div className="px-6 py-4 flex items-center gap-4">
                  <code className="text-xs font-mono font-semibold text-forest bg-forest/8 px-2 py-1 rounded-lg w-36 flex-shrink-0 truncate">
                    {m.meter_key}
                  </code>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-ink">{m.display_name}</div>
                    {m.description && <div className="text-xs text-stone truncate">{m.description}</div>}
                    {m.semantic_input_key && (
                      <div className="text-[10px] text-stone/50 font-mono truncate">↳ {m.semantic_input_key}</div>
                    )}
                  </div>
                  <div className="text-xs text-stone/60 font-mono flex-shrink-0">{m.unit_label}</div>
                  {m.connector && (
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <ConnectorLogo connector={m.connector} />
                      <span className="text-[10px] text-stone/60 capitalize">{m.connector}</span>
                    </div>
                  )}
                  <span
                    className="text-[10px] font-semibold px-2.5 py-1 rounded-full flex-shrink-0 flex items-center gap-1.5"
                    style={m.mode === 'live'
                      ? { background: '#EEF9F2', color: '#0B5C36', border: '1px solid rgba(11,92,54,0.25)' }
                      : { background: '#FFF7ED', color: '#C2410C', border: '1px solid rgba(194,65,12,0.25)' }}
                  >
                    <span className="w-1.5 h-1.5 rounded-full" style={{ background: m.mode === 'live' ? '#0B5C36' : '#C2410C' }} />
                    {m.mode === 'live' ? 'Live' : 'Test'}
                  </span>
                  {/* Step 17D.2, item B — response_metric_key must be a
                      real, editable field for a connector-backed meter,
                      not display-only. Reuses the exact same
                      openEndpoint/updateDraft/saveEndpoint machinery the
                      generic-meter list below uses; saveEndpoint already
                      branches on m.connector to patch response_metric_key
                      instead of endpoint/param fields. */}
                  <button
                    onClick={() => openEndpoint(m)}
                    className="text-xs font-medium px-2.5 py-1 rounded-lg border border-forest/20 text-stone hover:bg-forest/5 transition-colors flex-shrink-0 flex items-center gap-1"
                  >
                    <i className={`ti ${isExpanded ? 'ti-chevron-up' : 'ti-settings'}`} style={{ fontSize: 11 }} />
                    {isExpanded ? 'Close' : 'Edit'}
                  </button>
                  <button
                    onClick={() => handleDelete(m.id, m.meter_key)}
                    disabled={deleting === m.id}
                    className="text-xs px-2.5 py-1 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 transition-colors disabled:opacity-40 flex-shrink-0">
                    {deleting === m.id ? '…' : 'Remove'}
                  </button>
                </div>
                {isExpanded && draft && (
                  <div className="px-6 pb-5 pt-1 bg-forest/2 border-t border-forest/6">
                    <div className="text-[10px] font-semibold text-stone uppercase tracking-widest mb-3 pt-3">
                      Connector config — <span className="font-mono normal-case">{m.meter_key}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="col-span-2">
                        <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">Response metric key</label>
                        <input
                          value={draft.responseMetricKey}
                          onChange={e => updateDraft(m.id, 'responseMetricKey', e.target.value)}
                          placeholder="e.g. PAYMENT_REQUEST_ISSUED"
                          autoComplete="off"
                          className="w-full bg-white border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest font-mono"
                        />
                        <p className="text-[10px] text-stone/60 mt-1">The exact metric name {m.connector} returns in its usage response.</p>
                      </div>
                      <div className="col-span-2">
                        <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">Semantic input key</label>
                        <input
                          value={draft.semanticKey}
                          onChange={e => updateDraft(m.id, 'semanticKey', e.target.value)}
                          placeholder="e.g. issued_payment_request_count (optional)"
                          className="w-full bg-white border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest font-mono"
                        />
                      </div>
                    </div>
                    <div className="flex items-center gap-2 mt-4">
                      <button
                        onClick={() => saveEndpoint(m)}
                        disabled={saving === m.id}
                        className="bg-forest text-white text-sm font-medium px-4 py-2 rounded-xl hover:bg-sage transition-colors disabled:opacity-40"
                      >
                        {saving === m.id ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        onClick={() => setExpandedId(null)}
                        className="text-sm px-4 py-2 rounded-xl border border-forest/20 text-stone hover:bg-forest/5 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                </div>
                )
              })}
            </div>
          </div>

          {/* Connector-specific docs — one block per distinct connector present */}
          {Array.from(new Set(connectorMeters.map(m => m.connector).filter((c): c is string => !!c)))
            .map(connector => {
              const docs = CONNECTOR_DOCS[connector]
              if (!docs) return null
              return (
                <div key={connector} className="bg-white border border-forest/10 rounded-2xl overflow-hidden">
                  <div className="px-6 py-4 border-b border-forest/8">
                    <div className="text-sm font-semibold text-ink flex items-center gap-2">
                      <ConnectorLogo connector={connector} />
                      {docs.title}
                    </div>
                    <p className="text-xs text-stone mt-0.5">{docs.blurb}</p>
                  </div>
                  <div className="px-6 py-5 space-y-4">
                    <div>
                      <div className="text-[10px] font-semibold text-stone uppercase tracking-widest mb-2">Request</div>
                      <div className="bg-ink rounded-xl overflow-hidden">
                        <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-white/5">
                          <span className="w-2 h-2 rounded-full bg-[#FF5F56]" />
                          <span className="w-2 h-2 rounded-full bg-[#FFBD2E]" />
                          <span className="w-2 h-2 rounded-full bg-[#27C93F]" />
                          <span className="ml-auto text-[10px] text-white/25 font-mono">bash</span>
                        </div>
                        <pre className="text-green-400 text-[10px] font-mono px-4 py-3 overflow-x-auto leading-[1.9] whitespace-pre">{docs.request}</pre>
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] font-semibold text-stone uppercase tracking-widest mb-2">Response</div>
                      <div className="bg-ink rounded-xl overflow-hidden">
                        <pre className="text-blue-300 text-[10px] font-mono px-4 py-3 leading-relaxed whitespace-pre overflow-x-auto">{docs.response}</pre>
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
        </div>
      )}

      {/* ── Request format (for meters you configure yourself) ── */}
      <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden">
        <div className="px-6 py-4 border-b border-forest/8">
          <div className="text-sm font-semibold text-ink flex items-center gap-2">
            <i className="ti ti-arrows-exchange text-forest/60" style={{ fontSize: 14 }} />
            What Verdix sends to your endpoint
          </div>
          <p className="text-xs text-stone mt-0.5">
            Configure one endpoint URL per meter. Verdix calls it with these parameters and expects the total usage back.
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
            <h2 className="text-sm font-semibold text-ink">{connectorMeters.length > 0 ? 'Your own meters' : 'Your meters'}</h2>
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

              {/* Field reference table */}
              <div className="border border-forest/10 rounded-xl overflow-hidden">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="bg-forest/4 border-b border-forest/8">
                      <th className="text-left px-3 py-2.5 text-[10px] font-semibold text-stone uppercase tracking-widest">Field</th>
                      <th className="text-left px-3 py-2.5 text-[10px] font-semibold text-stone uppercase tracking-widest">What it is</th>
                      <th className="text-left px-3 py-2.5 text-[10px] font-semibold text-stone uppercase tracking-widest hidden sm:table-cell">Example</th>
                    </tr>
                  </thead>
                  <tbody>
                    {([
                      { field: 'Meter key',           req: true,  what: 'Unique snake_case identifier. Used as the value of the meter query param Verdix sends to your endpoint.',         example: 'api_calls' },
                      { field: 'Display name',         req: true,  what: 'Human-readable name shown on invoices and in the Verdix UI.',                                                    example: 'API Calls' },
                      { field: 'Unit label',           req: true,  what: 'Singular unit name used in billing line items (e.g. "1 call overage").',                                         example: 'call' },
                      { field: 'Description',          req: false, what: 'Internal note describing what this meter tracks. Not shown on invoices.',                                        example: 'Total API requests per cycle' },
                      { field: 'Endpoint URL',         req: true,  what: 'URL Verdix GETs at billing time. Verdix appends period_start, period_end, crm_id, and the meter param.',         example: 'https://api.you.com/billing/usage' },
                      { field: 'Bearer token',         req: true,  what: 'Auth token sent in the Authorization header so your endpoint can verify the request is from Verdix.',            example: '••••••' },
                      { field: 'Meter key param name', req: false, what: 'Query param name Verdix uses to pass the meter key. Defaults to billing_parameter if left blank.',               example: 'billing_parameter' },
                    ] as { field: string; req: boolean; what: string; example: string }[]).map((r, i, arr) => (
                      <tr key={r.field} className={i < arr.length - 1 ? 'border-b border-forest/6' : ''}>
                        <td className="px-3 py-2.5 align-top whitespace-nowrap">
                          <span className="font-medium text-ink">{r.field}</span>
                          {r.req
                            ? <span className="ml-1.5 text-[9px] font-semibold text-red-400 uppercase tracking-wide">required</span>
                            : <span className="ml-1.5 text-[9px] text-stone/50 uppercase tracking-wide">optional</span>}
                        </td>
                        <td className="px-3 py-2.5 text-stone leading-relaxed align-top">{r.what}</td>
                        <td className="px-3 py-2.5 align-top hidden sm:table-cell">
                          <code className="font-mono text-[10px] text-stone/50">{r.example}</code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Meter details */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">
                    Meter key <span className="text-red-400 normal-case font-normal">required</span>
                  </label>
                  <input value={form.meter_key} onChange={e => set('meter_key')(e.target.value)}
                    placeholder="e.g. api_calls"
                    autoComplete="off"
                    className="w-full bg-cream border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest font-mono" />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">
                    Display name <span className="text-red-400 normal-case font-normal">required</span>
                  </label>
                  <input value={form.display_name} onChange={e => set('display_name')(e.target.value)}
                    placeholder="e.g. API Calls"
                    autoComplete="off"
                    className="w-full bg-cream border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest" />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">
                    Unit label <span className="text-red-400 normal-case font-normal">required</span>
                  </label>
                  <input value={form.unit_label} onChange={e => set('unit_label')(e.target.value)}
                    placeholder="e.g. call"
                    autoComplete="off"
                    className="w-full bg-cream border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest" />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">Description</label>
                  <input value={form.description} onChange={e => set('description')(e.target.value)}
                    placeholder="What this meter tracks (optional)"
                    autoComplete="off"
                    className="w-full bg-cream border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest" />
                </div>
                <div className="col-span-2">
                  <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">Semantic input key</label>
                  <input value={form.semantic_input_key} onChange={e => set('semantic_input_key')(e.target.value)}
                    placeholder="e.g. issued_payment_request_count (optional)"
                    autoComplete="off"
                    className="w-full bg-cream border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest font-mono" />
                  <p className="text-[10px] text-stone/60 mt-1">The canonical contract fact this meter supplies — lets a contract&apos;s per-unit fee, overage, and rolling pricing all reuse this one meter. Leave blank if unsure; a reviewer can set it later when mapping a contract.</p>
                </div>
              </div>

              {/* Step 17D.2, item B — source type. A connector-backed
                  meter (currently only Remembill) is dispatched by
                  lib/meter-quantity-pull.ts's own connector client, keyed
                  on response_metric_key — it has no pull endpoint of its
                  own to configure, and requires the org's Remembill
                  integration to already be connected (Settings →
                  Integrations). */}
              <div className="border-t border-forest/8 pt-4 space-y-3">
                <div className="text-[10px] font-semibold text-stone uppercase tracking-widest">Source type</div>
                <div className="flex gap-2">
                  {(['generic', 'remembill'] as SourceType[]).map(t => (
                    <button key={t} type="button" onClick={() => set('source_type')(t)}
                      className={`flex-1 text-left px-3 py-2.5 rounded-xl border text-xs transition-colors ${form.source_type === t ? 'border-forest/40 bg-forest/5' : 'border-forest/15 hover:bg-forest/5'}`}>
                      <span className="block font-semibold text-ink">{t === 'generic' ? 'Generic HTTP endpoint' : 'Remembill'}</span>
                      <span className="block text-stone/70 mt-0.5">
                        {t === 'generic' ? 'Verdix pulls usage from a URL you configure' : 'Pulled via your connected Remembill integration'}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {form.source_type === 'remembill' ? (
                <div className="border-t border-forest/8 pt-4 space-y-3">
                  <div>
                    <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">
                      Response metric key <span className="text-red-400 normal-case font-normal">required</span>
                    </label>
                    <input value={form.response_metric_key} onChange={e => set('response_metric_key')(e.target.value)}
                      placeholder="e.g. PAYMENT_REQUEST_ISSUED"
                      autoComplete="off"
                      className="w-full bg-cream border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest font-mono" />
                    <p className="text-[10px] text-stone/60 mt-1">The exact metric name Remembill returns in its usage response — this is what Verdix reads at billing time, not a display label.</p>
                  </div>
                  <p className="text-[10px] text-amber-700">Requires an active Remembill connection under Settings → Integrations.</p>
                </div>
              ) : (
                <div className="border-t border-forest/8 pt-4 space-y-4">
                  <div>
                    <div className="text-[10px] font-semibold text-stone uppercase tracking-widest">Pull endpoint</div>
                    <p className="text-[10px] text-amber-700 mt-0.5">Required for billing to work — configure before the first billing cycle runs.</p>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="col-span-2">
                      <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">Endpoint URL</label>
                      <input value={form.pull_endpoint_url} onChange={e => set('pull_endpoint_url')(e.target.value)}
                        placeholder="https://your-api.example.com/billing/usage"
                        autoComplete="url"
                        className="w-full bg-cream border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest font-mono" />
                    </div>
                    <div>
                      <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">Bearer token</label>
                      <input value={form.pull_auth_token} onChange={e => set('pull_auth_token')(e.target.value)}
                        type="password"
                        autoComplete="new-password"
                        placeholder="Token Verdix will send in Authorization header"
                        className="w-full bg-cream border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest" />
                    </div>
                    <div>
                      <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">Meter key param name</label>
                      <input value={form.pull_param_name} onChange={e => set('pull_param_name')(e.target.value)}
                        placeholder="billing_parameter"
                        autoComplete="off"
                        className="w-full bg-cream border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest font-mono" />
                      <p className="text-[10px] text-stone/60 mt-1">Query param name that carries the meter key</p>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2 pt-1">
                <button onClick={handleAdd}
                  disabled={adding || !form.meter_key || !form.display_name || !form.unit_label || (form.source_type === 'remembill' && !form.response_metric_key.trim())}
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
                Add each billing dimension you track. Verdix will call your endpoint once per meter at the end of each billing cycle.
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
                        {m.semantic_input_key && (
                          <div className="text-[10px] text-stone/50 font-mono truncate">↳ {m.semantic_input_key}</div>
                        )}
                      </div>
                      <div className="text-xs text-stone/60 font-mono flex-shrink-0">{m.unit_label}</div>
                      <StatusBadge configured={Boolean(m.pull_endpoint_url)} />
                      <button
                        onClick={() => handleToggleMode(m)}
                        disabled={togglingId === m.id}
                        title={m.mode === 'live' ? 'Live — pulls real usage at billing time' : 'Test — real billing skips this meter until you go live'}
                        className="flex items-center gap-1.5 text-[10px] font-semibold px-2.5 py-1 rounded-full flex-shrink-0 transition-colors disabled:opacity-40"
                        style={m.mode === 'live'
                          ? { background: '#EEF9F2', color: '#0B5C36', border: '1px solid rgba(11,92,54,0.25)' }
                          : { background: '#FFF7ED', color: '#C2410C', border: '1px solid rgba(194,65,12,0.25)' }}
                      >
                        <span className="w-1.5 h-1.5 rounded-full" style={{ background: m.mode === 'live' ? '#0B5C36' : '#C2410C' }} />
                        {togglingId === m.id ? '…' : m.mode === 'live' ? 'Live' : 'Test'}
                      </button>
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
                          <div className="col-span-2">
                            <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">Semantic input key</label>
                            <input
                              value={draft.semanticKey}
                              onChange={e => updateDraft(m.id, 'semanticKey', e.target.value)}
                              placeholder="e.g. issued_payment_request_count (optional)"
                              className="w-full bg-white border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest font-mono"
                            />
                            <p className="text-[10px] text-stone/60 mt-1">The canonical contract fact this meter supplies — lets one meter satisfy a per-unit fee, an overage tier, and a rolling pricing rule from the same contract.</p>
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
