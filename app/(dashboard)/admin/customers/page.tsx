'use client'

import { Fragment, useEffect, useState } from 'react'

type Member = {
  org_id: string
  user_email: string
  role: 'owner' | 'admin' | 'member'
  status: 'active' | 'invited' | 'disabled'
  invited_by: string | null
  invite_last_sent_at: string | null
  created_at: string
}

type OrgRow = {
  id: string
  name: string
  slug: string
  created_at: string
  allowed_domain: string | null
  member_count: number
  status: 'active' | 'setup_pending' | 'no_members'
  members: Member[]
  subscription: {
    plan_id: string
    syncs_used: number
    trial_sync_limit_override: number | null
    stripe_customer_id: string | null
    status: string
  }
}

const PLAN_LABELS: Record<string, string> = { trial: 'Free', core: 'Pay as you go', pro: 'Scale', enterprise: 'Enterprise' }
const PLAN_COLORS: Record<string, string> = { trial: '#9CA3AF', core: '#2563EB', pro: '#7C3AED', enterprise: '#1A3D2B' }
const ORG_STATUS_LABELS: Record<OrgRow['status'], string> = { active: 'Active', setup_pending: 'Setup pending', no_members: 'No members' }
const ORG_STATUS_COLORS: Record<OrgRow['status'], string> = { active: '#1A3D2B', setup_pending: '#B45309', no_members: '#9CA3AF' }
const MEMBER_STATUS_COLORS: Record<Member['status'], string> = { active: '#1A3D2B', invited: '#B45309', disabled: '#DC2626' }

export default function AdminCustomersPage() {
  const [rows, setRows]         = useState<OrgRow[]>([])
  const [loading, setLoading]   = useState(true)
  const [editing, setEditing]   = useState<string | null>(null)
  const [editVals, setEditVals] = useState<{ plan_id: string; trial_sync_limit_override: string }>({ plan_id: 'trial', trial_sync_limit_override: '' })
  const [saving, setSaving]     = useState(false)
  const [msg, setMsg]           = useState<{ id: string; ok: boolean; text: string } | null>(null)

  const [expanded, setExpanded] = useState<string | null>(null)
  const [inviteForms, setInviteForms] = useState<Record<string, { email: string; role: 'admin' | 'member' }>>({})
  const [memberBusy, setMemberBusy] = useState<string | null>(null)
  const [memberMsg, setMemberMsg] = useState<{ orgId: string; ok: boolean; text: string } | null>(null)

  const [showNewOrg, setShowNewOrg] = useState(false)
  const [newOrg, setNewOrg] = useState({ name: '', initialAdminEmail: '', role: 'admin' as 'owner' | 'admin' | 'member', allowedDomain: '' })
  const [creatingOrg, setCreatingOrg] = useState(false)
  const [newOrgMsg, setNewOrgMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const [domainEdits, setDomainEdits] = useState<Record<string, string>>({})
  const [domainBusy, setDomainBusy] = useState<string | null>(null)
  const [domainMsg, setDomainMsg] = useState<{ orgId: string; ok: boolean; text: string } | null>(null)

  const [selfServiceEnabled, setSelfServiceEnabled] = useState(true)
  const [savingFlag, setSavingFlag] = useState(false)

  const refresh = () => {
    fetch('/api/admin/customers')
      .then(r => r.json())
      .then(d => { setRows(Array.isArray(d) ? d : []); setLoading(false) })
      .catch(() => setLoading(false))
  }

  useEffect(() => {
    refresh()
    fetch('/api/public/feature-flags')
      .then(r => r.json())
      .then(d => setSelfServiceEnabled(!!d.selfServiceSignupEnabled))
      .catch(() => null)
  }, [])

  const toggleSelfService = async () => {
    const next = !selfServiceEnabled
    setSavingFlag(true)
    const res = await fetch('/api/admin/billing', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'self_service_signup_enabled', value: next ? 'true' : 'false' }),
    })
    setSavingFlag(false)
    if (res.ok) setSelfServiceEnabled(next)
  }

  const openEdit = (row: OrgRow) => {
    setEditing(row.id)
    setEditVals({
      plan_id: row.subscription.plan_id,
      trial_sync_limit_override: row.subscription.trial_sync_limit_override != null ? String(row.subscription.trial_sync_limit_override) : '',
    })
    setMsg(null)
  }

  const saveEdit = async (orgId: string) => {
    setSaving(true)
    const res = await fetch('/api/admin/customers', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        org_id: orgId,
        plan_id: editVals.plan_id,
        trial_sync_limit_override: editVals.trial_sync_limit_override !== '' ? Number(editVals.trial_sync_limit_override) : null,
      }),
    })
    setSaving(false)
    if (res.ok) {
      setRows(prev => prev.map(r => r.id !== orgId ? r : {
        ...r,
        subscription: {
          ...r.subscription,
          plan_id: editVals.plan_id,
          trial_sync_limit_override: editVals.trial_sync_limit_override !== '' ? Number(editVals.trial_sync_limit_override) : null,
        },
      }))
      setEditing(null)
      setMsg({ id: orgId, ok: true, text: 'Updated ✓' })
    } else {
      const d = await res.json()
      setMsg({ id: orgId, ok: false, text: d.error ?? 'Error' })
    }
  }

  const createOrg = async () => {
    if (!newOrg.name.trim() || !newOrg.initialAdminEmail.trim()) return
    setCreatingOrg(true)
    setNewOrgMsg(null)
    const res = await fetch('/api/admin/customers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(newOrg),
    })
    const d = await res.json()
    setCreatingOrg(false)
    if (res.ok) {
      setNewOrgMsg({ ok: true, text: d.warning ?? 'Organization created and invitation sent ✓' })
      setNewOrg({ name: '', initialAdminEmail: '', role: 'admin', allowedDomain: '' })
      refresh()
    } else {
      setNewOrgMsg({ ok: false, text: d.error ?? 'Failed to create organization' })
    }
  }

  const domainFor = (row: OrgRow) => domainEdits[row.id] ?? (row.allowed_domain ?? '')

  const saveDomain = async (orgId: string, value: string) => {
    setDomainBusy(orgId)
    setDomainMsg(null)
    const res = await fetch('/api/admin/customers', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ org_id: orgId, allowedDomain: value }),
    })
    const d = await res.json()
    setDomainBusy(null)
    setDomainMsg({ orgId, ok: res.ok, text: res.ok ? 'Domain updated ✓' : (d.error ?? 'Failed to update') })
    if (res.ok) refresh()
  }

  const inviteFormFor = (orgId: string) => inviteForms[orgId] ?? { email: '', role: 'member' as const }

  const sendInvite = async (orgId: string) => {
    const form = inviteFormFor(orgId)
    if (!form.email.trim()) return
    setMemberBusy(orgId)
    setMemberMsg(null)
    const res = await fetch(`/api/admin/customers/${orgId}/invite`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(form),
    })
    const d = await res.json()
    setMemberBusy(null)
    if (res.ok) {
      setMemberMsg({ orgId, ok: true, text: 'Invitation sent ✓' })
      setInviteForms(prev => ({ ...prev, [orgId]: { email: '', role: 'member' } }))
      refresh()
    } else {
      setMemberMsg({ orgId, ok: false, text: d.error ?? 'Failed to invite' })
    }
  }

  const resendInvite = async (orgId: string, member: Member) => {
    setMemberBusy(orgId)
    setMemberMsg(null)
    const res = await fetch(`/api/admin/customers/${orgId}/invite`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: member.user_email, role: member.role }),
    })
    setMemberBusy(null)
    setMemberMsg({ orgId, ok: res.ok, text: res.ok ? 'Invitation resent ✓' : 'Failed to resend' })
    if (res.ok) refresh()
  }

  const revokeInvite = async (orgId: string, member: Member) => {
    setMemberBusy(orgId)
    setMemberMsg(null)
    const res = await fetch(`/api/admin/customers/${orgId}/invite?email=${encodeURIComponent(member.user_email)}`, { method: 'DELETE' })
    setMemberBusy(null)
    setMemberMsg({ orgId, ok: res.ok, text: res.ok ? 'Invitation revoked ✓' : 'Failed to revoke' })
    if (res.ok) refresh()
  }

  const setMemberStatus = async (orgId: string, member: Member, status: 'active' | 'disabled') => {
    setMemberBusy(orgId)
    setMemberMsg(null)
    const res = await fetch(`/api/admin/customers/${orgId}/invite`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: member.user_email, status }),
    })
    setMemberBusy(null)
    setMemberMsg({ orgId, ok: res.ok, text: res.ok ? (status === 'disabled' ? 'Access disabled ✓' : 'Access re-enabled ✓') : 'Failed to update' })
    if (res.ok) refresh()
  }

  const changeRole = async (orgId: string, member: Member, role: Member['role']) => {
    setMemberBusy(orgId)
    const res = await fetch(`/api/admin/customers/${orgId}/invite`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: member.user_email, role }),
    })
    setMemberBusy(null)
    if (res.ok) refresh()
  }

  if (loading) return <div className="p-8 text-stone text-sm">Loading…</div>

  return (
    <div className="p-4 md:p-8">
      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display font-light text-ink text-2xl mb-1">Organizations</h1>
          <p className="text-stone text-sm">{rows.length} organisation{rows.length !== 1 ? 's' : ''}</p>
        </div>
        <button
          onClick={() => setShowNewOrg(v => !v)}
          className="text-sm bg-forest text-white px-4 py-2 rounded-xl hover:bg-sage transition-colors"
        >
          {showNewOrg ? 'Cancel' : '+ Create organization'}
        </button>
      </div>

      {/* Self-service signup flag */}
      <div className="bg-white border border-forest/10 rounded-2xl p-5 mb-6 flex items-center justify-between gap-4">
        <div>
          <div className="text-sm font-medium text-ink">Public self-service signup</div>
          <p className="text-xs text-stone mt-0.5">
            When off, the public signup page and marketing site &quot;Get started&quot; CTAs are hidden. New access only comes from admin-provisioned invitations below.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            role="switch"
            aria-checked={selfServiceEnabled}
            onClick={toggleSelfService}
            disabled={savingFlag}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors duration-200 focus:outline-none disabled:opacity-50 ${selfServiceEnabled ? 'bg-forest' : 'bg-stone/20'}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ${selfServiceEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
          <span className={`text-xs font-medium ${selfServiceEnabled ? 'text-forest' : 'text-stone/50'}`}>{selfServiceEnabled ? 'On' : 'Off'}</span>
        </div>
      </div>

      {showNewOrg && (
        <div className="bg-white border border-forest/10 rounded-2xl p-6 mb-6">
          <div className="text-sm font-medium text-ink mb-4">Create organization</div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
            <input
              value={newOrg.name}
              onChange={e => setNewOrg(v => ({ ...v, name: e.target.value }))}
              placeholder="Organization name"
              className="text-sm border border-forest/20 rounded-xl px-3 py-2 bg-white"
            />
            <input
              value={newOrg.initialAdminEmail}
              onChange={e => setNewOrg(v => ({ ...v, initialAdminEmail: e.target.value }))}
              placeholder="Initial admin email"
              type="email"
              className="text-sm border border-forest/20 rounded-xl px-3 py-2 bg-white"
            />
            <select
              value={newOrg.role}
              onChange={e => setNewOrg(v => ({ ...v, role: e.target.value as typeof v.role }))}
              className="text-sm border border-forest/20 rounded-xl px-3 py-2 bg-white"
            >
              <option value="owner">Owner</option>
              <option value="admin">Admin</option>
              <option value="member">Member</option>
            </select>
            <input
              value={newOrg.allowedDomain}
              onChange={e => setNewOrg(v => ({ ...v, allowedDomain: e.target.value }))}
              placeholder="Allowed email domain (optional)"
              className="text-sm border border-forest/20 rounded-xl px-3 py-2 bg-white"
            />
          </div>
          <p className="text-xs text-stone -mt-2 mb-4">
            If set, anyone signing in with an email on this domain (e.g. acme.com) automatically joins as a member — no per-user invite needed. Can be changed later.
          </p>
          <div className="flex items-center gap-3">
            <button
              onClick={createOrg}
              disabled={creatingOrg || !newOrg.name.trim() || !newOrg.initialAdminEmail.trim()}
              className="text-sm bg-forest text-white px-4 py-2 rounded-xl hover:bg-sage transition-colors disabled:opacity-50"
            >
              {creatingOrg ? 'Creating…' : 'Create & send invitation'}
            </button>
            {newOrgMsg && (
              <span className={`text-xs ${newOrgMsg.ok ? 'text-forest' : 'text-red-600'}`}>{newOrgMsg.text}</span>
            )}
          </div>
        </div>
      )}

      <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-forest/8">
                {['Organisation', 'Status', 'Plan', 'Syncs used', 'Trial limit override', 'Members', 'Stripe', 'Actions'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-[10px] font-semibold text-stone uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <Fragment key={row.id}>
                  <tr className="border-b border-forest/6 last:border-0 hover:bg-cream/40 transition-colors">
                    <td className="px-4 py-3">
                      <div className="text-sm font-medium text-ink">{row.name}</div>
                      <div className="text-xs text-stone/60">{row.slug}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs font-semibold" style={{ color: ORG_STATUS_COLORS[row.status] }}>
                        {ORG_STATUS_LABELS[row.status]}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {editing === row.id ? (
                        <select
                          value={editVals.plan_id}
                          onChange={e => setEditVals(v => ({ ...v, plan_id: e.target.value }))}
                          className="text-xs border border-forest/20 rounded-lg px-2 py-1 bg-white"
                        >
                          {['trial', 'core', 'pro', 'enterprise'].map(p => (
                            <option key={p} value={p}>{PLAN_LABELS[p]}</option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-xs font-semibold" style={{ color: PLAN_COLORS[row.subscription.plan_id] ?? '#6B6660' }}>
                          {PLAN_LABELS[row.subscription.plan_id] ?? row.subscription.plan_id}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-stone font-mono">{row.subscription.syncs_used}</td>
                    <td className="px-4 py-3">
                      {editing === row.id ? (
                        <input
                          type="number"
                          value={editVals.trial_sync_limit_override}
                          onChange={e => setEditVals(v => ({ ...v, trial_sync_limit_override: e.target.value }))}
                          placeholder="Global default"
                          className="w-28 text-xs border border-forest/20 rounded-lg px-2 py-1 bg-white"
                        />
                      ) : (
                        <span className="text-sm text-stone">
                          {row.subscription.trial_sync_limit_override != null ? row.subscription.trial_sync_limit_override : <span className="text-stone/40">—</span>}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-stone">{row.member_count}</td>
                    <td className="px-4 py-3">
                      {row.subscription.stripe_customer_id ? (
                        <a
                          href={`https://dashboard.stripe.com/customers/${row.subscription.stripe_customer_id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-forest hover:underline"
                        >
                          View ↗
                        </a>
                      ) : <span className="text-xs text-stone/40">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      {editing === row.id ? (
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => saveEdit(row.id)}
                            disabled={saving}
                            className="text-xs bg-forest text-white px-3 py-1.5 rounded-lg hover:bg-sage transition-colors disabled:opacity-50"
                          >
                            {saving ? '…' : 'Save'}
                          </button>
                          <button onClick={() => setEditing(null)} className="text-xs text-stone hover:text-ink">Cancel</button>
                          {msg?.id === row.id && (
                            <span className={`text-xs ${msg.ok ? 'text-forest' : 'text-red-600'}`}>{msg.text}</span>
                          )}
                        </div>
                      ) : (
                        <div className="flex items-center gap-3">
                          <button onClick={() => openEdit(row)} className="text-xs text-forest hover:underline">Edit plan</button>
                          <button
                            onClick={() => { setExpanded(expanded === row.id ? null : row.id); setMemberMsg(null) }}
                            className="text-xs text-forest hover:underline"
                          >
                            {expanded === row.id ? 'Hide members' : 'Members ▾'}
                          </button>
                          {msg?.id === row.id && (
                            <span className={`text-xs ${msg.ok ? 'text-forest' : 'text-red-600'}`}>{msg.text}</span>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                  {expanded === row.id && (
                    <tr className="border-b border-forest/6 bg-cream/30">
                      <td colSpan={8} className="px-4 py-4">
                        <div className="text-xs font-semibold text-stone uppercase tracking-wider mb-2">Domain auto-join</div>
                        <div className="flex items-center gap-2 flex-wrap mb-5">
                          <input
                            value={domainFor(row)}
                            onChange={e => setDomainEdits(prev => ({ ...prev, [row.id]: e.target.value }))}
                            placeholder="e.g. acme.com — none set"
                            className="text-xs border border-forest/20 rounded-lg px-2 py-1.5 bg-white w-56"
                          />
                          <button
                            onClick={() => saveDomain(row.id, domainFor(row))}
                            disabled={domainBusy === row.id || domainFor(row) === (row.allowed_domain ?? '')}
                            className="text-xs bg-forest text-white px-3 py-1.5 rounded-lg hover:bg-sage transition-colors disabled:opacity-50"
                          >
                            {domainBusy === row.id ? '…' : 'Save'}
                          </button>
                          {row.allowed_domain && (
                            <button
                              onClick={() => { setDomainEdits(prev => ({ ...prev, [row.id]: '' })); saveDomain(row.id, '') }}
                              disabled={domainBusy === row.id}
                              className="text-xs text-red-600 hover:underline disabled:opacity-50"
                            >
                              Remove
                            </button>
                          )}
                          {domainMsg?.orgId === row.id && (
                            <span className={`text-xs ${domainMsg.ok ? 'text-forest' : 'text-red-600'}`}>{domainMsg.text}</span>
                          )}
                        </div>

                        <div className="text-xs font-semibold text-stone uppercase tracking-wider mb-2">Members & invitations</div>
                        <div className="space-y-1.5 mb-4">
                          {row.members.length === 0 && <div className="text-xs text-stone/60">No members yet.</div>}
                          {row.members.map(m => (
                            <div key={m.user_email} className="flex items-center justify-between gap-3 bg-white border border-forest/10 rounded-lg px-3 py-2">
                              <div className="flex items-center gap-3 min-w-0">
                                <span className="text-sm text-ink truncate">{m.user_email}</span>
                                <span className="text-xs font-semibold flex-shrink-0" style={{ color: MEMBER_STATUS_COLORS[m.status] }}>
                                  {m.status === 'invited' ? 'Invited' : m.status === 'disabled' ? 'Disabled' : 'Active'}
                                </span>
                                <select
                                  value={m.role}
                                  onChange={e => changeRole(row.id, m, e.target.value as Member['role'])}
                                  disabled={memberBusy === row.id}
                                  className="text-xs border border-forest/20 rounded-lg px-1.5 py-0.5 bg-white flex-shrink-0"
                                >
                                  <option value="owner">Owner</option>
                                  <option value="admin">Admin</option>
                                  <option value="member">Member</option>
                                </select>
                              </div>
                              <div className="flex items-center gap-3 flex-shrink-0">
                                {m.status === 'invited' && (
                                  <>
                                    <button onClick={() => resendInvite(row.id, m)} disabled={memberBusy === row.id} className="text-xs text-forest hover:underline disabled:opacity-50">Resend</button>
                                    <button onClick={() => revokeInvite(row.id, m)} disabled={memberBusy === row.id} className="text-xs text-red-600 hover:underline disabled:opacity-50">Revoke</button>
                                  </>
                                )}
                                {m.status === 'active' && (
                                  <button onClick={() => setMemberStatus(row.id, m, 'disabled')} disabled={memberBusy === row.id} className="text-xs text-red-600 hover:underline disabled:opacity-50">Disable</button>
                                )}
                                {m.status === 'disabled' && (
                                  <button onClick={() => setMemberStatus(row.id, m, 'active')} disabled={memberBusy === row.id} className="text-xs text-forest hover:underline disabled:opacity-50">Re-enable</button>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>

                        <div className="flex items-center gap-2 flex-wrap">
                          <input
                            value={inviteFormFor(row.id).email}
                            onChange={e => setInviteForms(prev => ({ ...prev, [row.id]: { ...inviteFormFor(row.id), email: e.target.value } }))}
                            placeholder="new-user@company.com"
                            type="email"
                            className="text-xs border border-forest/20 rounded-lg px-2 py-1.5 bg-white w-56"
                          />
                          <select
                            value={inviteFormFor(row.id).role}
                            onChange={e => setInviteForms(prev => ({ ...prev, [row.id]: { ...inviteFormFor(row.id), role: e.target.value as 'admin' | 'member' } }))}
                            className="text-xs border border-forest/20 rounded-lg px-2 py-1.5 bg-white"
                          >
                            <option value="member">Member</option>
                            <option value="admin">Admin</option>
                          </select>
                          <button
                            onClick={() => sendInvite(row.id)}
                            disabled={memberBusy === row.id || !inviteFormFor(row.id).email.trim()}
                            className="text-xs bg-forest text-white px-3 py-1.5 rounded-lg hover:bg-sage transition-colors disabled:opacity-50"
                          >
                            {memberBusy === row.id ? '…' : 'Invite user'}
                          </button>
                          {memberMsg?.orgId === row.id && (
                            <span className={`text-xs ${memberMsg.ok ? 'text-forest' : 'text-red-600'}`}>{memberMsg.text}</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
