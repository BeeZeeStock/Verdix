'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import type { OrganizationRuleRecord } from '@/lib/rulebook/organization-rules'

// Kept in sync by hand with lib/rulebook/organization-rulebook-display.ts /
// organization-policy-catalog.ts — both are zero-DB/React pure modules,
// safe to import directly from a 'use client' component, so this page
// imports them rather than re-deriving the same formatting or temporal
// logic (item 14).
import {
  describeTreatment, describeMatchConditions, describeEffectivePeriod, describeSourceKind,
} from '@/lib/rulebook/organization-rulebook-display'
import {
  buildOrganizationPolicySettingsModel,
  type OrganizationPolicyCardModel,
} from '@/lib/rulebook/organization-policy-catalog'

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

// One organization rule's detail + management actions. Rendered inside a
// PolicyCard's active/scheduled/draft section — several may appear in the
// same card when multiple scoped rules exist for the same policy field
// (item 13), each shown in full rather than collapsed to one value.
function RuleRow({ rule, onChanged }: { rule: OrganizationRuleRecord; onChanged: () => void }) {
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
    <div className="rounded-xl p-4 bg-cream/30 border border-forest/8">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-ink">{rule.name}</span>
          <StatusBadge status={rule.status} />
          <span className="text-[11px] text-stone/60">v{rule.version}</span>
        </div>
      </div>

      {rule.description && <p className="text-xs text-stone/80 mb-2 italic">{rule.description}</p>}

      <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs mb-2">
        <div>
          <span className="text-stone/60">Applies when</span>
          <div className="text-ink">{describeMatchConditions(rule.matchConditions).join(' · ') || 'The agreement does not specify the treatment'}</div>
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

// Read-only history row — superseded/disabled versions (item 12). No
// activate/discard/edit actions: history is kept accessible, not editable.
function HistoryRow({ rule }: { rule: OrganizationRuleRecord }) {
  return (
    <div className="rounded-xl p-3 bg-white border border-forest/8">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-xs font-medium text-ink">{rule.name}</span>
        <StatusBadge status={rule.status} />
        <span className="text-[11px] text-stone/60">v{rule.version}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[11px]">
        <div>
          <span className="text-stone/60">Value</span>
          <div className="text-ink">{describeTreatment(rule.targetField, rule.value)}</div>
        </div>
        <div>
          <span className="text-stone/60">Effective period</span>
          <div className="text-ink">{describeEffectivePeriod(rule.effectiveFrom, rule.effectiveTo)}</div>
        </div>
        <div>
          <span className="text-stone/60">Applies when</span>
          <div className="text-ink">{describeMatchConditions(rule.matchConditions).join(' · ') || 'The agreement does not specify the treatment'}</div>
        </div>
        <div>
          <span className="text-stone/60">Source</span>
          <div className="text-ink">{describeSourceKind(rule.sourceKind)}</div>
        </div>
      </div>
    </div>
  )
}

function PolicyHistoryDisclosure({ history }: { history: OrganizationRuleRecord[] }) {
  const [open, setOpen] = useState(false)
  if (history.length === 0) return null
  return (
    <div className="mt-3 pt-3 border-t border-forest/8">
      <button onClick={() => setOpen(o => !o)} className="text-xs text-stone hover:text-forest transition-colors flex items-center gap-1">
        <i className={`ti ${open ? 'ti-chevron-down' : 'ti-chevron-right'}`} style={{ fontSize: 12 }} />
        View policy history ({history.length})
      </button>
      {open && (
        <div className="flex flex-col gap-2 mt-2">
          {history.map(rule => <HistoryRow key={rule.id} rule={rule} />)}
        </div>
      )}
    </div>
  )
}

// A supported policy TYPE this organization has NOT configured — layer B
// only, no organization data to show. Deliberately does not render "Not
// configured" as a value-shaped fact about the organization's carry-
// forward treatment; it names the capability and points at the real
// workflow, nothing more (item 7).
function SupportedTypeCard({ policy }: { policy: OrganizationPolicyCardModel }) {
  return (
    <div className="rounded-2xl p-5 bg-white border border-forest/10">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-sm font-semibold text-ink">{policy.title}</span>
        <span className="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full" style={{ background: 'rgba(120,113,108,0.14)', color: '#57534E' }}>
          Not configured
        </span>
      </div>
      <p className="text-xs text-stone mb-3">{policy.description}</p>
      <Link href="/configure" className="text-xs font-semibold text-forest hover:text-sage transition-colors inline-flex items-center gap-1">
        <i className="ti ti-arrow-right" style={{ fontSize: 12 }} /> {policy.howCreated}
      </Link>
    </div>
  )
}

// An actual, organization-owned policy (layer C) — active, scheduled,
// and/or draft rules exist for this type. "Not configured" never appears
// here; a card only reaches this component once the organization has a
// real rule row for the field.
function PolicyCard({ policy, onChanged }: { policy: OrganizationPolicyCardModel; onChanged: () => void }) {
  const hasMultipleActive = policy.activeRules.length > 1

  return (
    <div className="rounded-2xl p-5 bg-white border border-forest/10">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-sm font-semibold text-ink">{policy.title}</span>
      </div>
      <p className="text-xs text-stone mb-4">{policy.description}</p>

      {(policy.state === 'active' || policy.state === 'active_with_scheduled_change') && (
        <div className="mb-3">
          {(policy.state === 'active_with_scheduled_change' || hasMultipleActive) && (
            <p className="text-[11px] font-medium text-stone/70 mb-2">
              {policy.state === 'active_with_scheduled_change' ? 'Current policy' : `${policy.activeRules.length} configured policies`}
            </p>
          )}
          <div className="flex flex-col gap-2">
            {policy.activeRules.map(rule => <RuleRow key={rule.id} rule={rule} onChanged={onChanged} />)}
          </div>
        </div>
      )}

      {(policy.state === 'scheduled' || policy.state === 'active_with_scheduled_change') && (
        <div className="mb-3">
          <p className="text-[11px] font-medium text-stone/70 mb-2">
            {policy.state === 'active_with_scheduled_change' ? 'Scheduled change' : 'Scheduled'}
          </p>
          <div className="flex flex-col gap-2">
            {policy.scheduledRules.map(rule => <RuleRow key={rule.id} rule={rule} onChanged={onChanged} />)}
          </div>
        </div>
      )}

      {policy.state === 'draft' && (
        <div className="mb-3">
          <p className="text-[11px] font-medium text-stone/70 mb-2">Draft — awaiting activation</p>
          <div className="flex flex-col gap-2">
            {policy.draftRules.map(rule => <RuleRow key={rule.id} rule={rule} onChanged={onChanged} />)}
          </div>
        </div>
      )}

      <PolicyHistoryDisclosure history={policy.history} />
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

  const model = buildOrganizationPolicySettingsModel(rules)
  // Layer C (this organization's own policies) vs layer B (what Verdix
  // supports but this organization hasn't configured) — a type appears in
  // exactly one section, never both, and moves between them purely as a
  // function of its own state (item 8).
  const configuredTypes = model.policyTypes.filter(p => p.state !== 'not_configured')
  const unconfiguredTypes = model.policyTypes.filter(p => p.state === 'not_configured')

  return (
    <div className="p-4 md:p-8 max-w-4xl">
      <div className="mb-8">
        <h1 className="font-display font-light text-ink text-2xl mb-1">Organization Rulebook</h1>
        <p className="text-stone text-sm">
          Define reusable policies for situations where an agreement does not specify the treatment. Agreement terms always take priority.
          Policies can be created from decisions your team approves during contract review.
        </p>
      </div>

      {model.summary.supportedTypes === 0 ? (
        <div className="bg-white border border-forest/10 rounded-2xl px-6 py-16 text-center">
          <i className="ti ti-gavel text-stone/25 block mb-4" style={{ fontSize: 32 }} />
          <p className="text-sm font-medium text-ink mb-1">No organization policy types are available yet</p>
        </div>
      ) : (
        <>
          <div className="mb-8">
            <div className="flex items-baseline gap-2 mb-1">
              <h2 className="text-sm font-semibold text-ink">Your organization policies</h2>
              <span className="text-xs text-stone/60">{model.summary.configuredPolicies} configured</span>
            </div>
            {configuredTypes.length === 0 ? (
              <div className="bg-white border border-forest/10 rounded-2xl px-6 py-10 text-center mt-3">
                <p className="text-sm font-medium text-ink mb-1">No organization policies configured yet.</p>
                <p className="text-xs text-stone">When your team approves a reusable decision during contract review, you can save it as an organization policy.</p>
              </div>
            ) : (
              <div className="flex flex-col gap-4 mt-3">
                {configuredTypes.map(policy => <PolicyCard key={policy.field} policy={policy} onChanged={load} />)}
              </div>
            )}
          </div>

          {unconfiguredTypes.length > 0 && (
            <div>
              <div className="flex items-baseline gap-2 mb-3">
                <h2 className="text-sm font-semibold text-ink">Supported policy types</h2>
                <span className="text-xs text-stone/60">{unconfiguredTypes.length}</span>
              </div>
              <div className="flex flex-col gap-4">
                {unconfiguredTypes.map(policy => <SupportedTypeCard key={policy.field} policy={policy} />)}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
