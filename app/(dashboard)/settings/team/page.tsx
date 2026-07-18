'use client'

import { useEffect, useState } from 'react'

interface Member {
  id: string
  user_email: string
  role: 'owner' | 'admin' | 'member'
  status: 'active' | 'invited'
  created_at: string
}

interface OrgData {
  orgId: string
  orgName: string
  orgSlug: string
  role: 'owner' | 'admin' | 'member'
  members: Member[]
}

const ROLE_RANK: Record<string, number> = { member: 0, admin: 1, owner: 2 }

function RoleBadge({ role, status }: { role: string; status: string }) {
  const color =
    role === 'owner' ? '#1A3D2B' :
    role === 'admin' ? '#2563EB' :
    '#6B6660'
  return (
    <span style={{ color, fontSize: 12, fontWeight: 500 }}>
      {role}{status === 'invited' ? ' (invited)' : ''}
    </span>
  )
}

export default function TeamSettingsPage() {
  const [org, setOrg] = useState<OrgData | null>(null)
  const [loading, setLoading] = useState(true)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'member' | 'admin'>('member')
  const [inviting, setInviting] = useState(false)
  const [inviteMsg, setInviteMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    const res = await fetch('/api/org')
    if (!res.ok) { setError('Failed to load org data'); setLoading(false); return }
    setOrg(await res.json())
    setLoading(false)
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [])

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault()
    setInviting(true)
    setInviteMsg(null)
    const res = await fetch('/api/org/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
    })
    const data = await res.json()
    if (res.ok) {
      setInviteMsg({ ok: true, text: `Invite sent to ${inviteEmail}` })
      setInviteEmail('')
      load()
    } else {
      setInviteMsg({ ok: false, text: data.error ?? 'Failed to send invite' })
    }
    setInviting(false)
  }

  async function handleRemove(email: string) {
    if (!confirm(`Remove ${email} from the organization?`)) return
    await fetch(`/api/org/members/${encodeURIComponent(email)}`, { method: 'DELETE' })
    load()
  }

  async function handleRoleChange(email: string, role: string) {
    await fetch(`/api/org/members/${encodeURIComponent(email)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    })
    load()
  }

  const canManage = org && ROLE_RANK[org.role] >= ROLE_RANK['admin']

  if (loading) return <div className="p-4 md:p-8 text-stone text-sm">Loading…</div>
  if (error) return <div className="p-4 md:p-8 text-red-600 text-sm">{error}</div>
  if (!org) return null

  return (
    <div className="p-4 md:p-8 max-w-2xl">
      <div className="mb-8">
        <h1 className="font-display font-light text-ink text-2xl mb-1">Team</h1>
        <p className="text-stone text-sm">Manage members of <strong>{org.orgName}</strong></p>
      </div>

      {/* Members table */}
      <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden mb-8">
        <div className="px-6 py-4 border-b border-forest/8 flex items-center justify-between">
          <span className="text-sm font-medium text-ink">Members</span>
          <span className="text-xs text-stone">{org.members.length}</span>
        </div>
        <table className="w-full">
          <thead>
            <tr className="border-b border-forest/8">
              {['Email', 'Role', ''].map(h => (
                <th key={h} className="px-4 py-3 text-left text-[10px] font-semibold text-stone uppercase tracking-wider">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {org.members.map(m => (
              <tr key={m.id} className="border-b border-forest/6 last:border-0">
                <td className="px-4 py-3 text-sm text-ink">{m.user_email}</td>
                <td className="px-4 py-3">
                  {canManage && m.role !== 'owner' ? (
                    <select
                      value={m.role}
                      onChange={e => handleRoleChange(m.user_email, e.target.value)}
                      className="text-xs border border-forest/20 rounded-md px-2 py-1 bg-white text-ink"
                    >
                      <option value="member">member</option>
                      <option value="admin">admin</option>
                    </select>
                  ) : (
                    <RoleBadge role={m.role} status={m.status} />
                  )}
                  {m.status === 'invited' && <span className="ml-2 text-xs text-stone">(invited)</span>}
                </td>
                <td className="px-4 py-3 text-right">
                  {canManage && m.role !== 'owner' && (
                    <button
                      onClick={() => handleRemove(m.user_email)}
                      className="text-xs text-red-500 hover:text-red-700 transition-colors"
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Invite form */}
      {canManage && (
        <div className="bg-white border border-forest/10 rounded-2xl p-6">
          <h2 className="text-sm font-medium text-ink mb-4">Invite a team member</h2>
          <form onSubmit={handleInvite} className="flex flex-col gap-3">
            <div className="flex gap-3">
              <input
                type="email"
                placeholder="colleague@company.com"
                value={inviteEmail}
                onChange={e => setInviteEmail(e.target.value)}
                required
                className="flex-1 text-sm border border-forest/20 rounded-xl px-4 py-2.5 bg-white text-ink placeholder:text-stone/60 focus:outline-none focus:ring-2 focus:ring-forest/20"
              />
              <select
                value={inviteRole}
                onChange={e => setInviteRole(e.target.value as 'member' | 'admin')}
                className="text-sm border border-forest/20 rounded-xl px-3 py-2.5 bg-white text-ink"
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
              <button
                type="submit"
                disabled={inviting}
                className="bg-forest text-white text-sm font-medium px-5 py-2.5 rounded-xl hover:bg-sage transition-colors disabled:opacity-50"
              >
                {inviting ? 'Sending…' : 'Invite'}
              </button>
            </div>
            {inviteMsg && (
              <p className={`text-xs ${inviteMsg.ok ? 'text-forest' : 'text-red-600'}`}>
                {inviteMsg.text}
              </p>
            )}
            <p className="text-xs text-stone">
              <strong>Member</strong> can view and run jobs. <strong>Admin</strong> can invite others and delete jobs.
            </p>
          </form>
        </div>
      )}
    </div>
  )
}
