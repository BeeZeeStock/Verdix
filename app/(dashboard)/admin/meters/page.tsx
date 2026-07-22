'use client'

import { useEffect, useState, useCallback } from 'react'

type Meter = {
  id:                  string
  org_id:              string | null
  org_name:            string | null
  meter_key:           string
  display_name:        string
  unit_label:          string
  description:         string | null
  pull_endpoint_url:   string | null
  pull_param_name:     string
  pull_auth_token_set: boolean
  created_at:          string
}

type EditState = {
  display_name:      string
  unit_label:        string
  description:       string
  pull_endpoint_url: string
  pull_param_name:   string
  pull_auth_token:   string
  replace_token:     boolean
  clear_token:       boolean
}

type AddState = {
  meter_key:         string
  display_name:      string
  unit_label:        string
  description:       string
  pull_endpoint_url: string
  pull_param_name:   string
  pull_auth_token:   string
}

const EMPTY_ADD: AddState = {
  meter_key: '', display_name: '', unit_label: '',
  description: '', pull_endpoint_url: '', pull_param_name: 'billing_parameter', pull_auth_token: '',
}

function TokenField({
  tokenSet, value, onChange, onReplace, replacing,
}: {
  tokenSet:   boolean
  value:      string
  replacing:  boolean
  onChange:   (v: string) => void
  onReplace:  (v: boolean) => void
}) {
  if (tokenSet && !replacing) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex-1 bg-cream border border-forest/15 rounded-xl px-3 py-2 text-sm text-stone/60 flex items-center gap-2">
          <i className="ti ti-lock text-forest/50" style={{ fontSize: 13 }} />
          Token configured
        </div>
        <button onClick={() => onReplace(true)}
          className="text-xs px-2.5 py-2 rounded-xl border border-forest/20 text-stone hover:bg-forest/5 transition-colors flex-shrink-0">
          Replace
        </button>
      </div>
    )
  }
  return (
    <input type="password" value={value} onChange={e => onChange(e.target.value)}
      placeholder="Bearer token…"
      className="w-full bg-cream border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest font-mono" />
  )
}

export default function AdminMetersPage() {
  const [meters,   setMeters]   = useState<Meter[]>([])
  const [loading,  setLoading]  = useState(true)
  const [editId,   setEditId]   = useState<string | null>(null)
  const [editVals, setEditVals] = useState<EditState>({
    display_name: '', unit_label: '', description: '',
    pull_endpoint_url: '', pull_param_name: 'billing_parameter',
    pull_auth_token: '', replace_token: false, clear_token: false,
  })
  const [saving,   setSaving]   = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [msg,      setMsg]      = useState<{ ok: boolean; text: string } | null>(null)
  const [showAdd,  setShowAdd]  = useState(false)
  const [addForm,  setAddForm]  = useState<AddState>(EMPTY_ADD)
  const [adding,   setAdding]   = useState(false)

  const setAdd = (k: keyof AddState) => (v: string) => setAddForm(f => ({ ...f, [k]: v }))

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/meters').then(r => r.json()).catch(() => null)
    if (res?.meters) { setMeters(res.meters); setLoading(false) }
    else setLoading(false)
  }, [])

  useEffect(() => {
    fetch('/api/admin/meters')
      .then(r => r.json())
      .then((res: { meters: Meter[] }) => { setMeters(res.meters ?? []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  const post = async (body: Record<string, unknown>) => {
    const res  = await fetch('/api/admin/meters', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { ok: res.ok, data: await res.json() }
  }

  const startEdit = (m: Meter) => {
    setEditId(m.id)
    setEditVals({
      display_name:      m.display_name,
      unit_label:        m.unit_label,
      description:       m.description ?? '',
      pull_endpoint_url: m.pull_endpoint_url ?? '',
      pull_param_name:   m.pull_param_name ?? 'billing_parameter',
      pull_auth_token:   '',
      replace_token:     false,
      clear_token:       false,
    })
    setMsg(null)
  }

  const handleUpdate = async () => {
    if (!editId) return
    setSaving(true); setMsg(null)
    const body: Record<string, unknown> = {
      action:            'update',
      id:                editId,
      display_name:      editVals.display_name,
      unit_label:        editVals.unit_label,
      description:       editVals.description || null,
      pull_endpoint_url: editVals.pull_endpoint_url || null,
      pull_param_name:   editVals.pull_param_name || 'billing_parameter',
    }
    if (editVals.clear_token)                          body.clear_auth_token = true
    else if (editVals.replace_token && editVals.pull_auth_token) body.pull_auth_token = editVals.pull_auth_token
    const { ok, data } = await post(body)
    if (ok) { setMsg({ ok: true, text: 'Saved ✓' }); setEditId(null); await load() }
    else      setMsg({ ok: false, text: data.error ?? 'Save failed' })
    setSaving(false)
  }

  const handleDelete = async (id: string, key: string) => {
    if (!confirm(`Delete meter '${key}'? Cannot be undone.`)) return
    setDeleting(id); setMsg(null)
    const { ok, data } = await post({ action: 'delete', id })
    if (ok) { setMsg({ ok: true, text: `Deleted '${key}' ✓` }); await load() }
    else      setMsg({ ok: false, text: data.error ?? 'Delete failed' })
    setDeleting(null)
  }

  const handleAdd = async () => {
    setAdding(true); setMsg(null)
    const row: Record<string, unknown> = {
      action:            'add',
      meter_key:         addForm.meter_key,
      display_name:      addForm.display_name,
      unit_label:        addForm.unit_label,
      description:       addForm.description || null,
      pull_endpoint_url: addForm.pull_endpoint_url || null,
      pull_param_name:   addForm.pull_param_name || 'billing_parameter',
    }
    if (addForm.pull_auth_token) row.pull_auth_token = addForm.pull_auth_token
    const { ok, data } = await post(row)
    if (ok) {
      setMsg({ ok: true, text: `Added '${data.meter?.meter_key}' ✓` })
      setShowAdd(false); setAddForm(EMPTY_ADD); await load()
    } else {
      setMsg({ ok: false, text: data.error ?? 'Add failed' })
    }
    setAdding(false)
  }

  if (loading) return <div className="p-8 text-stone text-sm">Loading…</div>

  const platformMeters = meters.filter(m => m.org_id === null)
  const orgMeters      = meters.filter(m => m.org_id !== null)
  const orgGroups      = new Map<string, { name: string; meters: Meter[] }>()
  for (const m of orgMeters) {
    const key = m.org_id!
    if (!orgGroups.has(key)) orgGroups.set(key, { name: m.org_name ?? key, meters: [] })
    orgGroups.get(key)!.meters.push(m)
  }

  function MeterRow({ m }: { m: Meter }) {
    const isEditing = editId === m.id
    if (isEditing) {
      return (
        <div className="px-6 py-4 space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1">Display name</label>
              <input value={editVals.display_name}
                onChange={e => setEditVals(v => ({ ...v, display_name: e.target.value }))}
                className="w-full bg-cream border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest" />
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1">Unit label</label>
              <input value={editVals.unit_label}
                onChange={e => setEditVals(v => ({ ...v, unit_label: e.target.value }))}
                className="w-full bg-cream border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest" />
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1">Description</label>
              <input value={editVals.description}
                onChange={e => setEditVals(v => ({ ...v, description: e.target.value }))}
                className="w-full bg-cream border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest" />
            </div>
          </div>
          <div className="border-t border-forest/8 pt-3 space-y-3">
            <div className="text-[10px] font-semibold text-stone uppercase tracking-widest">Pull endpoint</div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1">Endpoint URL</label>
                <input type="url" value={editVals.pull_endpoint_url}
                  onChange={e => setEditVals(v => ({ ...v, pull_endpoint_url: e.target.value }))}
                  placeholder="https://…/usage"
                  className="w-full bg-cream border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest font-mono" />
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1">Param name</label>
                <input value={editVals.pull_param_name}
                  onChange={e => setEditVals(v => ({ ...v, pull_param_name: e.target.value }))}
                  className="w-full bg-cream border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest font-mono" />
              </div>
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1">
                Auth token <span className="normal-case font-normal text-stone/50">(Bearer)</span>
              </label>
              <TokenField
                tokenSet={m.pull_auth_token_set}
                replacing={editVals.replace_token}
                value={editVals.pull_auth_token}
                onReplace={v => setEditVals(ev => ({ ...ev, replace_token: v }))}
                onChange={v => setEditVals(ev => ({ ...ev, pull_auth_token: v }))}
              />
              {m.pull_auth_token_set && (
                <label className="flex items-center gap-1.5 mt-1.5 cursor-pointer">
                  <input type="checkbox" checked={editVals.clear_token}
                    onChange={e => setEditVals(v => ({ ...v, clear_token: e.target.checked }))}
                    className="rounded" />
                  <span className="text-[10px] text-stone">Clear token (remove auth)</span>
                </label>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handleUpdate} disabled={saving}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-forest text-white hover:bg-sage transition-colors disabled:opacity-40">
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => setEditId(null)}
              className="text-xs px-3 py-1.5 rounded-lg border border-forest/20 text-stone hover:bg-forest/5 transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )
    }

    return (
      <div className="px-6 py-4 flex items-start gap-4">
        <code className="text-xs font-mono font-semibold text-forest bg-forest/8 px-2 py-1 rounded-lg w-28 flex-shrink-0 truncate mt-0.5">
          {m.meter_key}
        </code>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-ink">{m.display_name}</div>
          {m.description && <div className="text-xs text-stone">{m.description}</div>}
          {m.pull_endpoint_url ? (
            <div className="text-[10px] font-mono text-stone/50 truncate mt-1">
              <i className="ti ti-plug-connected mr-1" style={{ fontSize: 10 }} />
              {m.pull_endpoint_url}
              {' · '}<span className="text-stone/40">{m.pull_param_name}</span>
              {m.pull_auth_token_set && (
                <span className="ml-1 text-forest/60">
                  <i className="ti ti-lock" style={{ fontSize: 9 }} /> token set
                </span>
              )}
            </div>
          ) : (
            <div className="text-[10px] text-amber-600 mt-1 flex items-center gap-1">
              <i className="ti ti-alert-triangle" style={{ fontSize: 10 }} />
              No pull endpoint — billing will skip this meter
            </div>
          )}
        </div>
        <div className="text-xs text-stone/60 font-mono w-16 flex-shrink-0">{m.unit_label}</div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button onClick={() => startEdit(m)}
            className="text-xs px-2.5 py-1 rounded-lg border border-forest/20 text-stone hover:bg-forest/5 transition-colors">
            Edit
          </button>
          <button onClick={() => handleDelete(m.id, m.meter_key)} disabled={deleting === m.id}
            className="text-xs px-2.5 py-1 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 transition-colors disabled:opacity-40">
            {deleting === m.id ? '…' : 'Delete'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 md:p-8 max-w-4xl space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display font-light text-ink text-2xl mb-1">Billing Meters</h1>
          <p className="text-stone text-sm">
            Every meter — including Verdix&apos;s own — must have a pull endpoint registered.
            Verdix calls that endpoint at billing time to get usage counts. Same flow for platform meters and 3PP org meters.
          </p>
        </div>
        {msg && (
          <span className={`text-xs font-medium mt-1 flex-shrink-0 ${msg.ok ? 'text-forest' : 'text-red-600'}`}>{msg.text}</span>
        )}
      </div>

      {/* ── Platform meters ────────────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">Platform meters</h2>
            <p className="text-xs text-stone">
              Verdix-owned — register the pull endpoint for each one so Verdix can pull its own usage data the same way 3PP orgs do.
              For <code className="bg-cream px-1 rounded font-mono text-[10px]">sync</code>: point to <code className="bg-cream px-1 rounded font-mono text-[10px]">/api/internal/usage</code> with <code className="bg-cream px-1 rounded font-mono text-[10px]">INTERNAL_API_SECRET</code>.
            </p>
          </div>
          <button onClick={() => { setShowAdd(!showAdd); setMsg(null); setAddForm(EMPTY_ADD) }}
            className="text-xs font-medium px-3 py-1.5 rounded-lg bg-forest text-white hover:bg-sage transition-colors flex items-center gap-1.5 flex-shrink-0">
            <i className="ti ti-plus" style={{ fontSize: 12 }} />
            Add meter
          </button>
        </div>

        <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden">
          <div className="divide-y divide-forest/5">
            {platformMeters.map(m => <MeterRow key={m.id} m={m} />)}
          </div>

          {showAdd && (
            <div className="px-6 py-5 border-t border-forest/8 bg-forest/2 space-y-4">
              <div className="text-xs font-semibold text-stone uppercase tracking-widest">New platform meter</div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1">Key</label>
                  <input value={addForm.meter_key} onChange={e => setAdd('meter_key')(e.target.value)}
                    placeholder="e.g. api_call"
                    className="w-full bg-white border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest font-mono" />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1">Display name</label>
                  <input value={addForm.display_name} onChange={e => setAdd('display_name')(e.target.value)}
                    placeholder="e.g. API Call"
                    className="w-full bg-white border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest" />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1">Unit</label>
                  <input value={addForm.unit_label} onChange={e => setAdd('unit_label')(e.target.value)}
                    placeholder="e.g. call"
                    className="w-full bg-white border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest" />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1">Description</label>
                  <input value={addForm.description} onChange={e => setAdd('description')(e.target.value)}
                    placeholder="Optional"
                    className="w-full bg-white border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest" />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1">Pull endpoint URL</label>
                  <input type="url" value={addForm.pull_endpoint_url} onChange={e => setAdd('pull_endpoint_url')(e.target.value)}
                    placeholder="https://…/usage  or  /api/internal/usage"
                    className="w-full bg-white border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest font-mono" />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1">Param name</label>
                  <input value={addForm.pull_param_name} onChange={e => setAdd('pull_param_name')(e.target.value)}
                    className="w-full bg-white border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest font-mono" />
                </div>
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-stone uppercase tracking-widest mb-1">Auth token (Bearer)</label>
                <input type="password" value={addForm.pull_auth_token} onChange={e => setAdd('pull_auth_token')(e.target.value)}
                  placeholder="For /api/internal/usage use INTERNAL_API_SECRET value"
                  className="w-full bg-white border border-forest/15 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest font-mono" />
              </div>
              <div className="flex items-center gap-2">
                <button onClick={handleAdd} disabled={adding || !addForm.meter_key || !addForm.display_name || !addForm.unit_label}
                  className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-forest text-white hover:bg-sage transition-colors disabled:opacity-40">
                  {adding ? 'Adding…' : 'Add'}
                </button>
                <button onClick={() => setShowAdd(false)}
                  className="text-xs px-3 py-1.5 rounded-lg border border-forest/20 text-stone hover:bg-forest/5 transition-colors">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── 3PP org meters ─────────────────────────────────────────────────────── */}
      <div>
        <div className="mb-3">
          <h2 className="text-sm font-semibold text-ink">3PP org meters</h2>
          <p className="text-xs text-stone">Registered by partner organisations via Settings → Billing meters or <code className="bg-cream px-1 rounded font-mono text-[10px]">POST /api/meters</code></p>
        </div>

        {orgGroups.size === 0 ? (
          <div className="bg-white border border-forest/10 rounded-2xl px-6 py-8 text-center">
            <div className="text-sm text-stone/60 mb-1">No 3PP meters registered yet</div>
            <div className="text-xs text-stone/40">Partners register via Settings → Billing meters in their dashboard</div>
          </div>
        ) : (
          <div className="space-y-4">
            {Array.from(orgGroups.entries()).map(([orgId, group]) => (
              <div key={orgId} className="bg-white border border-forest/10 rounded-2xl overflow-hidden">
                <div className="px-6 py-3 border-b border-forest/8 bg-forest/2 flex items-center gap-2">
                  <i className="ti ti-building text-stone" style={{ fontSize: 13 }} />
                  <span className="text-sm font-medium text-ink">{group.name}</span>
                  <span className="text-[10px] text-stone/50 font-mono">{orgId.slice(0, 8)}…</span>
                  <span className="ml-auto text-[10px] text-stone/50">{group.meters.length} meter{group.meters.length !== 1 ? 's' : ''}</span>
                </div>
                <div className="divide-y divide-forest/5">
                  {group.meters.map(m => <MeterRow key={m.id} m={m} />)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
