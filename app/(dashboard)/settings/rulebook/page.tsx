'use client'

import { useEffect, useState, useCallback } from 'react'
import type { OrganizationRuleRecord } from '@/lib/rulebook/organization-rules'

// Kept in sync by hand with lib/rulebook/organization-rulebook-display.ts —
// that module has zero DB/React imports and is safe to import directly
// from a 'use client' component, so this page imports it rather than
// re-deriving the same formatting.
import {
  describeTargetField, describeTreatment, describeMatchConditions,
  describeEffectivePeriod, describeSourceKind, groupForDisplay,
  type RulebookDisplayGroup,
} from '@/lib/rulebook/organization-rulebook-display'

const GROUP_ORDER: { key: RulebookDisplayGroup; label: string; blurb: string }[] = [
  { key: 'active', label: 'Active', blurb: 'Currently resolving genuinely silent contract fields.' },
  { key: 'future', label: 'Future', blurb: 'Approved and scheduled, not yet in effect.' },
  { key: 'draft', label: 'Draft', blurb: 'Not yet approved — has no effect on any agreement.' },
  { key: 'superseded', label: 'Superseded', blurb: 'Retired by a later version — kept for historical resolution.' },
  { key: 'disabled', label: 'Disabled', blurb: 'Discarded drafts and manually disabled policies.' },
]

const STATUS_COLOR: Record<string, { bg: string; fg: string }> = {
  active: { bg: 'rgba(11,92,54,0.1)', fg: '#0B5C36' },
  draft: { bg: 'rgba(120,113,108,0.14)', fg: '#57534E' },
  superseded: { bg: 'rgba(180,83,9,0.1)', fg: '#92400E' },
  disabled: { bg: 'rgba(153,27,27,0.08)', fg: '#7F1D1D' },
}

function StatusBadge({ status }: { status: string }) {
  const c = STATUS_COLOR[status] ?? STATUS_COLOR.disabled
  return (
    <span className="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full" style={{ background: c.bg, color: c.fg }}>
      {status}
    </span>
  )
}

function RuleDetails({ rule }: { rule: OrganizationRuleRecord }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-2">
      <button onClick={() => setOpen(o => !o)} className="text-xs text-stone hover:text-forest transition-colors flex items-center gap-1">
        <i className={`ti ${open ? 'ti-chevron-down' : 'ti-chevron-right'}`} style={{ fontSize: 12 }} />
        Technical details
      </button>
      {open && (
        <pre className="mt-2 text-[11px] bg-cream/50 border border-forest/8 rounded-lg p-3 overflow-x-auto text-stone">
{JSON.stringify({
  id: rule.id, target_field: rule.targetField, value: rule.value, match_conditions: rule.matchConditions,
  lineage_id: rule.lineageId, supersedes_rule_id: rule.supersedesRuleId, effective_from: rule.effectiveFrom, effective_to: rule.effectiveTo,
}, null, 2)}
        </pre>
      )}
    </div>
  )
}

function RuleCard({ rule, onChanged }: { rule: OrganizationRuleRecord; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [conflict, setConflict] = useState<{ currentPolicy: OrganizationRuleRecord } | null>(null)
  const [editingValue, setEditingValue] = useState(false)
  const [pendingValue, setPendingValue] = useState(rule.value === true)

  async function activate(confirmReplace = false) {
    setBusy(true); setMsg(null)
    const res = await fetch(`/api/org/rulebook/${rule.id}/activate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(confirmReplace ? { confirmReplace: true } : {}),
    })
    const data = await res.json().catch(() => ({}))
    setBusy(false)
    if (res.status === 409 && data.conflict) { setConflict({ currentPolicy: data.currentPolicy }); return }
    if (!res.ok) { setMsg({ ok: false, text: data.error ?? 'Failed to activate' }); return }
    setConflict(null)
    onChanged()
  }

  async function discard() {
    if (!confirm('Discard this draft? It has never had any production effect.')) return
    setBusy(true); setMsg(null)
    const res = await fetch(`/api/org/rulebook/${rule.id}/discard`, { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    setBusy(false)
    if (!res.ok) { setMsg({ ok: false, text: data.error ?? 'Failed to discard' }); return }
    onChanged()
  }

  async function saveEdit() {
    setBusy(true); setMsg(null)
    const res = await fetch(`/api/org/rulebook/${rule.id}/supersede`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: pendingValue }),
    })
    const data = await res.json().catch(() => ({}))
    setBusy(false)
    setEditingValue(false)
    if (!res.ok) { setMsg({ ok: false, text: data.error ?? 'Failed to create new version' }); return }
    setMsg({ ok: true, text: 'New draft version created — approve it below to make it effective.' })
    onChanged()
  }

  return (
    <div className="rounded-2xl p-5 bg-white border border-forest/10">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-semibold text-ink">{rule.name}</span>
            <StatusBadge status={rule.status} />
            <span className="text-[11px] text-stone/60">v{rule.version}</span>
          </div>
          <p className="text-xs text-stone">{describeTargetField(rule.targetField)}</p>
        </div>
      </div>

      {rule.description && <p className="text-xs text-stone/80 mb-2 italic">{rule.description}</p>}

      <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs mb-2">
        <div>
          <span className="text-stone/60">Applies when</span>
          <div className="text-ink">{describeMatchConditions(rule.matchConditions).join(' · ') || 'No conditions (broad default)'}</div>
        </div>
        <div>
          <span className="text-stone/60">Verdix will do</span>
          <div className="text-ink font-medium">{describeTreatment(rule.targetField, rule.value)}</div>
        </div>
        <div>
          <span className="text-stone/60">Effective period</span>
          <div className="text-ink">{describeEffectivePeriod(rule.effectiveFrom, rule.effectiveTo)}</div>
        </div>
        <div>
          <span className="text-stone/60">Source</span>
          <div className="text-ink">{describeSourceKind(rule.sourceKind)}</div>
        </div>
        <div>
          <span className="text-stone/60">Created by</span>
          <div className="text-ink">{rule.createdBy}</div>
        </div>
        <div>
          <span className="text-stone/60">Approved by</span>
          <div className="text-ink">{rule.approvedBy ?? '—'}</div>
        </div>
      </div>

      <RuleDetails rule={rule} />

      {conflict && (
        <div className="mt-3 rounded-xl p-3" style={{ background: '#FEF2F2', border: '1px solid #FECACA' }}>
          <p className="text-xs font-semibold mb-1" style={{ color: '#991B1B' }}>An active organization policy already covers this scope.</p>
          <p className="text-xs mb-2" style={{ color: '#7F1D1D' }}>
            Current policy: <strong>{describeTreatment(conflict.currentPolicy.targetField, conflict.currentPolicy.value)}</strong>
            {' '}({conflict.currentPolicy.name})<br />
            Proposed policy: <strong>{describeTreatment(rule.targetField, rule.value)}</strong> ({rule.name})
          </p>
          <div className="flex gap-2">
            <button disabled={busy} onClick={() => activate(true)} className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-forest text-white disabled:opacity-50">
              Replace from effective date
            </button>
            <button disabled={busy} onClick={() => setConflict(null)} className="text-xs px-3 py-1.5 rounded-lg border border-forest/20 text-stone">
              Cancel
            </button>
          </div>
        </div>
      )}

      {editingValue && (
        <div className="mt-3 rounded-xl p-3" style={{ background: '#FAFAF9', border: '1px solid rgba(26,61,43,0.1)' }}>
          <p className="text-xs font-medium text-ink mb-2">New treatment (this creates a new version — the current one is untouched until this is approved)</p>
          <div className="flex flex-col gap-1.5 mb-2">
            <label className="flex items-center gap-2 text-xs text-ink">
              <input type="radio" checked={pendingValue === true} onChange={() => setPendingValue(true)} /> Carry forward until fully used
            </label>
            <label className="flex items-center gap-2 text-xs text-ink">
              <input type="radio" checked={pendingValue === false} onChange={() => setPendingValue(false)} /> Does not carry forward past the period earned
            </label>
          </div>
          <div className="flex gap-2">
            <button disabled={busy} onClick={saveEdit} className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-forest text-white disabled:opacity-50">Create new version</button>
            <button disabled={busy} onClick={() => setEditingValue(false)} className="text-xs px-3 py-1.5 rounded-lg border border-forest/20 text-stone">Cancel</button>
          </div>
        </div>
      )}

      {msg && <p className={`text-xs mt-2 ${msg.ok ? 'text-forest' : 'text-red-600'}`}>{msg.text}</p>}

      <div className="flex items-center gap-3 mt-3 pt-3 border-t border-forest/8">
        {rule.status === 'draft' && (
          <>
            <button disabled={busy} onClick={() => activate(false)} className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-forest text-white disabled:opacity-50">
              {busy ? 'Working…' : 'Approve & activate'}
            </button>
            <button disabled={busy} onClick={discard} className="text-xs text-red-500 hover:text-red-700 transition-colors">Discard draft</button>
          </>
        )}
        {rule.status === 'active' && !editingValue && (
          <button disabled={busy} onClick={() => { setPendingValue(rule.value === true); setEditingValue(true) }} className="text-xs font-semibold text-forest hover:text-sage transition-colors">
            Edit (creates a new version)
          </button>
        )}
      </div>
    </div>
  )
}

export default function OrganizationRulebookPage() {
  const [rules, setRules] = useState<OrganizationRuleRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const res = await fetch('/api/org/rulebook')
    // GET is requireOrg('admin') — a clear, specific message here instead
    // of a generic "failed to load" is the low-risk half of the fix this
    // page needs; the button-level hide/disable work lives in
    // OrganizationPolicyControls (configure/[id]/page.tsx), the other
    // surface that talks to these same admin-only routes.
    if (res.status === 403) { setError('Organization Rulebook management is limited to organization admins.'); setLoading(false); return }
    if (!res.ok) { setError('Failed to load organization rules'); setLoading(false); return }
    const data = await res.json()
    setRules(data.rules ?? [])
    setLoading(false)
  }, [])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [load])

  if (loading) return <div className="p-4 md:p-8 text-stone text-sm">Loading…</div>
  if (error) {
    return (
      <div className="p-4 md:p-8 max-w-4xl">
        <div className="bg-white border border-forest/10 rounded-2xl px-6 py-16 text-center">
          <i className="ti ti-lock text-stone/25 block mb-4" style={{ fontSize: 32 }} />
          <p className="text-sm font-medium text-ink mb-1">{error}</p>
        </div>
      </div>
    )
  }

  const grouped = GROUP_ORDER.map(g => ({ ...g, rules: rules.filter(r => groupForDisplay(r) === g.key) }))

  return (
    <div className="p-4 md:p-8 max-w-4xl">
      <div className="mb-8">
        <h1 className="font-display font-light text-ink text-2xl mb-1">Organization Rulebook</h1>
        <p className="text-stone text-sm">
          Private defaults that fill genuinely silent contract fields — never override what a contract or a reviewer already decided.
          Currently supports one field: unused-balance carry-forward for service credits, rebates, and conditional credits.
        </p>
      </div>

      {rules.length === 0 && (
        <div className="bg-white border border-forest/10 rounded-2xl px-6 py-16 text-center">
          <i className="ti ti-gavel text-stone/25 block mb-4" style={{ fontSize: 32 }} />
          <p className="text-sm font-medium text-ink mb-1">No organization policies yet</p>
          <p className="text-sm text-stone">Promote a reviewer decision from a contract review to create your first one.</p>
        </div>
      )}

      {grouped.filter(g => g.rules.length > 0).map(g => (
        <div key={g.key} className="mb-8">
          <div className="flex items-baseline gap-2 mb-3">
            <h2 className="text-sm font-semibold text-ink">{g.label}</h2>
            <span className="text-xs text-stone/60">{g.rules.length}</span>
          </div>
          <p className="text-xs text-stone/60 mb-3">{g.blurb}</p>
          <div className="flex flex-col gap-3">
            {g.rules.map(rule => <RuleCard key={rule.id} rule={rule} onChanged={load} />)}
          </div>
        </div>
      ))}
    </div>
  )
}
