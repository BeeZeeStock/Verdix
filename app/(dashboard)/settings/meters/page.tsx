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
  meter_key:         string
  display_name:      string
  unit_label:        string
  description:       string
  pull_endpoint_url: string
  pull_param_name:   string
  pull_auth_token:   string
}

const EMPTY_FORM: FormState = {
  meter_key: '', display_name: '', unit_label: '',
  description: '', pull_endpoint_url: '', pull_param_name: 'billing_parameter', pull_auth_token: '',
}

function EndpointSection({
  endpointUrl, paramName, tokenSet,
  onEndpointChange, onParamChange, onTokenChange, tokenValue,
}: {
  endpointUrl: string
  paramName:   string
  tokenSet?:   boolean
  tokenValue:  string
  onEndpointChange: (v: string) => void
  onParamChange:    (v: string) => void
  onTokenChange:    (v: string) => void
}) {
  const [replaceToken, setReplaceToken] = useState(!tokenSet)
  return (
    <div className="border-t border-forest/8 pt-4 space-y-3">
      <div className="text-[10px] font-semibold text-stone uppercase tracking-widest">Pull endpoint</div>
      <div>
        <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">
          Endpoint URL
        </label>
        <input
          type="url"
          value={endpointUrl}
          onChange={e => onEndpointChange(e.target.value)}
          placeholder="https://your-api.com/usage"
          className="w-full bg-cream border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest font-mono"
        />
        <p className="text-[10px] text-stone/60 mt-1">
          Verdix will call <code className="bg-cream px-1 rounded">GET &lt;url&gt;?customer_id=&amp;period_start=&amp;period_end=&amp;&lt;param&gt;=&lt;meter_key&gt;</code>
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">
            Billing parameter name
          </label>
          <input
            value={paramName}
            onChange={e => onParamChange(e.target.value)}
            placeholder="billing_parameter"
            className="w-full bg-cream border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest font-mono"
          />
          <p className="text-[10px] text-stone/60 mt-1">Query param used for the meter key</p>
        </div>
        <div>
          <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1.5">
            Auth token <span className="normal-case font-normal text-stone/50">(Bearer)</span>
          </label>
          {tokenSet && !replaceToken ? (
            <div className="flex items-center gap-2">
              <div className="flex-1 bg-cream border border-forest/15 rounded-xl px-3 py-2 text-sm text-stone/60 flex items-center gap-2">
                <i className="ti ti-lock text-forest/50" style={{ fontSize: 13 }} />
                Token configured
              </div>
              <button onClick={() => setReplaceToken(true)}
                className="text-xs px-2.5 py-2 rounded-xl border border-forest/20 text-stone hover:bg-forest/5 transition-colors flex-shrink-0">
                Replace
              </button>
            </div>
          ) : (
            <input
              type="password"
              value={tokenValue}
              onChange={e => onTokenChange(e.target.value)}
              placeholder="sk-…"
              className="w-full bg-cream border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest font-mono"
            />
          )}
          <p className="text-[10px] text-stone/60 mt-1">Write-once — never shown after saving</p>
        </div>
      </div>
    </div>
  )
}

export default function MetersSettingsPage() {
  const [orgMeters, setOrgMeters] = useState<Meter[]>([])
  const [loading,   setLoading]   = useState(true)
  const [msg,            setMsg]            = useState<{ ok: boolean; text: string } | null>(null)
  const [showForm,       setShowForm]       = useState(false)
  const [form,           setForm]           = useState<FormState>(EMPTY_FORM)
  const [adding,         setAdding]         = useState(false)
  const [deleting,       setDeleting]       = useState<string | null>(null)

  const set = (k: keyof FormState) => (v: string) => setForm(f => ({ ...f, [k]: v }))

  const applyData = useCallback((res: { org_meters: Meter[] }) => {
    setOrgMeters(res.org_meters ?? [])
  }, [])

  useEffect(() => {
    fetch('/api/meters')
      .then(r => r.json())
      .then((res: { org_meters: Meter[] }) => {
        applyData(res); setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [applyData])

  const reload = useCallback(async () => {
    const res = await fetch('/api/meters').then(r => r.json()).catch(() => null)
    if (res) applyData(res)
  }, [applyData])

  const handleAdd = async () => {
    setAdding(true); setMsg(null)
    const res = await fetch('/api/meters', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        meter_key:         form.meter_key.trim(),
        display_name:      form.display_name.trim(),
        unit_label:        form.unit_label.trim(),
        description:       form.description.trim() || undefined,
        pull_endpoint_url: form.pull_endpoint_url.trim() || undefined,
        pull_param_name:   form.pull_param_name.trim() || 'billing_parameter',
        pull_auth_token:   form.pull_auth_token.trim() || undefined,
      }),
    })
    const data = await res.json()
    if (res.ok) {
      setMsg({ ok: true, text: `Meter '${data.meter?.meter_key}' registered ✓` })
      setForm(EMPTY_FORM); setShowForm(false)
      await reload()
    } else {
      setMsg({ ok: false, text: data.error ?? 'Registration failed' })
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
    else          setMsg({ ok: false, text: data.error ?? 'Delete failed' })
    setDeleting(null)
  }

  if (loading) return <div className="p-8 text-stone text-sm">Loading…</div>

  return (
    <div className="p-4 md:p-8 max-w-3xl space-y-8">
      <div>
        <h1 className="font-display font-light text-ink text-2xl mb-1">Billing Meters</h1>
        <p className="text-stone text-sm">
          Register the usage dimensions your platform tracks and the endpoint Verdix calls at billing
          time to pull the usage count. Verdix maps these to your contract terms and queries the right
          endpoint for each meter at the end of each billing cycle.
        </p>
      </div>

      {/* ── Your registered meters ──────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">Your meters</h2>
            <p className="text-xs text-stone">Each meter has a pull endpoint Verdix calls at invoice time</p>
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
              Register meter
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
            <EndpointSection
              endpointUrl={form.pull_endpoint_url} paramName={form.pull_param_name}
              tokenSet={false} tokenValue={form.pull_auth_token}
              onEndpointChange={set('pull_endpoint_url')} onParamChange={set('pull_param_name')}
              onTokenChange={set('pull_auth_token')}
            />
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
                Register each billing dimension your platform tracks, along with the endpoint
                Verdix should call to pull usage counts at invoice time.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-forest/5">
              {orgMeters.map(m => (
                <div key={m.id} className="px-6 py-4 flex items-start gap-4">
                  <code className="text-xs font-mono font-semibold text-forest bg-forest/8 px-2 py-1 rounded-lg w-32 flex-shrink-0 truncate mt-0.5">
                    {m.meter_key}
                  </code>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-ink">{m.display_name}</div>
                    {m.description && <div className="text-xs text-stone">{m.description}</div>}
                    {m.pull_endpoint_url ? (
                      <div className="text-[10px] font-mono text-stone/50 truncate mt-1">
                        <i className="ti ti-plug-connected mr-1" style={{ fontSize: 10 }} />
                        {m.pull_endpoint_url}
                        {' · '}
                        <span className="text-stone/40">{m.pull_param_name}</span>
                        {m.pull_auth_token_set && (
                          <span className="ml-1 text-forest/60">
                            <i className="ti ti-lock" style={{ fontSize: 9 }} /> token set
                          </span>
                        )}
                      </div>
                    ) : (
                      <div className="text-[10px] text-amber-600 mt-1 flex items-center gap-1">
                        <i className="ti ti-alert-triangle" style={{ fontSize: 10 }} />
                        No pull endpoint configured — billing will skip this meter
                      </div>
                    )}
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
            { n: '1', title: 'Register your meters', body: 'Add each billing dimension and the URL Verdix should call to pull usage counts at invoice time.' },
            { n: '2', title: 'Upload a contract', body: 'When an agreement containing overage tiers is uploaded, Verdix auto-maps the contract\'s unit types to your registered meters. A human confirms before the contract is approved.' },
            { n: '3', title: 'Verdix pulls usage at billing time', body: 'At each cycle end, Verdix calls your endpoint per meter: GET <url>?customer_id=X&period_start=Y&period_end=Z&billing_parameter=<meter_key>. Your endpoint returns { total_billable_units: N }.' },
            { n: '4', title: 'Overage computed and invoiced', body: 'Verdix applies the contract\'s overage tiers to the returned count and pushes the invoice line item to Stripe.' },
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
