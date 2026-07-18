'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'

interface OrgData {
  orgId: string
  orgName: string
  role: 'owner' | 'admin' | 'member'
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden mb-6">
      <div className="px-6 py-4 border-b border-forest/8">
        <span className="text-sm font-medium text-ink">{title}</span>
      </div>
      <div className="p-6">{children}</div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 mb-4 last:mb-0">
      <label className="text-xs font-medium text-stone uppercase tracking-wider">{label}</label>
      {children}
    </div>
  )
}

const inputCls = "w-full text-sm border border-forest/20 rounded-xl px-4 py-2.5 bg-white text-ink placeholder:text-stone/50 focus:outline-none focus:ring-2 focus:ring-forest/20"
const btnCls   = "bg-forest text-white text-sm font-medium px-5 py-2.5 rounded-xl hover:bg-sage transition-colors disabled:opacity-50"

export default function SettingsPage() {
  const { data: session, update: updateSession } = useSession()
  const [org, setOrg] = useState<OrgData | null>(null)

  // Profile state
  const [fullName, setFullName] = useState('')
  const [savingProfile, setSavingProfile] = useState(false)
  const [profileMsg, setProfileMsg] = useState<{ ok: boolean; text: string } | null>(null)

  // Password state
  const [currentPw, setCurrentPw] = useState('')
  const [newPw, setNewPw]         = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [savingPw, setSavingPw]   = useState(false)
  const [pwMsg, setPwMsg]         = useState<{ ok: boolean; text: string } | null>(null)

  // Org state
  const [orgName, setOrgName]       = useState('')
  const [savingOrg, setSavingOrg]   = useState(false)
  const [orgMsg, setOrgMsg]         = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    if (session?.user) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFullName(session.user.name ?? '')
    }
    fetch('/api/org').then(r => r.json()).then(data => {
      if (data.orgId) {
        setOrg(data)
        setOrgName(data.orgName)
      }
    })
  }, [session])

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault()
    setSavingProfile(true)
    setProfileMsg(null)
    const res = await fetch('/api/user', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullName }),
    })
    const data = await res.json()
    if (res.ok) {
      await updateSession({ user: { name: fullName } })
      setProfileMsg({ ok: true, text: 'Name updated.' })
    } else {
      setProfileMsg({ ok: false, text: data.error ?? 'Failed to update.' })
    }
    setSavingProfile(false)
  }

  async function savePassword(e: React.FormEvent) {
    e.preventDefault()
    if (newPw !== confirmPw) { setPwMsg({ ok: false, text: 'Passwords do not match.' }); return }
    setSavingPw(true)
    setPwMsg(null)
    const res = await fetch('/api/user', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: currentPw, newPassword: newPw }),
    })
    const data = await res.json()
    if (res.ok) {
      setCurrentPw(''); setNewPw(''); setConfirmPw('')
      setPwMsg({ ok: true, text: 'Password updated.' })
    } else {
      setPwMsg({ ok: false, text: data.error ?? 'Failed to update.' })
    }
    setSavingPw(false)
  }

  async function saveOrg(e: React.FormEvent) {
    e.preventDefault()
    setSavingOrg(true)
    setOrgMsg(null)
    const res = await fetch('/api/org', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: orgName }),
    })
    const data = await res.json()
    setSavingOrg(false)
    if (res.ok) setOrgMsg({ ok: true, text: 'Organization name updated.' })
    else setOrgMsg({ ok: false, text: data.error ?? 'Failed to update.' })
  }

  const canEditOrg = org && (org.role === 'owner' || org.role === 'admin')
  const isOAuthUser = session?.user?.provider === 'google'

  return (
    <div className="p-4 md:p-8 max-w-xl">
      <div className="mb-8">
        <h1 className="font-display font-light text-ink text-2xl mb-1">Settings</h1>
        <p className="text-stone text-sm">Manage your account and organization</p>
      </div>

      {/* Profile */}
      <Section title="Profile">
        <form onSubmit={saveProfile}>
          <Field label="Full name">
            <input
              value={fullName}
              onChange={e => setFullName(e.target.value)}
              className={inputCls}
              placeholder="Your name"
            />
          </Field>
          <Field label="Email">
            <input
              value={session?.user?.email ?? ''}
              disabled
              className={inputCls + ' opacity-50 cursor-not-allowed'}
            />
            <p className="text-xs text-stone">Email cannot be changed.</p>
          </Field>
          <div className="flex items-center gap-3 mt-5">
            <button type="submit" disabled={savingProfile} className={btnCls}>
              {savingProfile ? 'Saving…' : 'Save name'}
            </button>
            {profileMsg && (
              <span className={`text-xs ${profileMsg.ok ? 'text-forest' : 'text-red-600'}`}>{profileMsg.text}</span>
            )}
          </div>
        </form>
      </Section>

      {/* Password — hidden for Google/OAuth users who have no Supabase password */}
      {!isOAuthUser && <Section title="Change password">
          <form onSubmit={savePassword}>
            <Field label="Current password">
              <input type="password" value={currentPw} onChange={e => setCurrentPw(e.target.value)} className={inputCls} placeholder="••••••••" required />
            </Field>
            <Field label="New password">
              <input type="password" value={newPw} onChange={e => setNewPw(e.target.value)} className={inputCls} placeholder="Min 8 characters" required />
            </Field>
            <Field label="Confirm new password">
              <input type="password" value={confirmPw} onChange={e => setConfirmPw(e.target.value)} className={inputCls} placeholder="••••••••" required />
            </Field>
            <div className="flex items-center gap-3 mt-5">
              <button type="submit" disabled={savingPw} className={btnCls}>
                {savingPw ? 'Updating…' : 'Update password'}
              </button>
              {pwMsg && (
                <span className={`text-xs ${pwMsg.ok ? 'text-forest' : 'text-red-600'}`}>{pwMsg.text}</span>
              )}
            </div>
          </form>
      </Section>}

      {/* Organization */}
      {org && (
        <Section title="Organization">
          <form onSubmit={saveOrg}>
            <Field label="Organization name">
              <input
                value={orgName}
                onChange={e => setOrgName(e.target.value)}
                disabled={!canEditOrg}
                className={inputCls + (!canEditOrg ? ' opacity-50 cursor-not-allowed' : '')}
                placeholder="Your company name"
              />
              {!canEditOrg && (
                <p className="text-xs text-stone">Only admins and owners can change the organization name.</p>
              )}
            </Field>
            <Field label="Your role">
              <div className="text-sm text-ink capitalize">{org.role}</div>
            </Field>
            {canEditOrg && (
              <div className="flex items-center gap-3 mt-5">
                <button type="submit" disabled={savingOrg} className={btnCls}>
                  {savingOrg ? 'Saving…' : 'Save organization'}
                </button>
                {orgMsg && (
                  <span className={`text-xs ${orgMsg.ok ? 'text-forest' : 'text-red-600'}`}>{orgMsg.text}</span>
                )}
              </div>
            )}
          </form>
        </Section>
      )}
    </div>
  )
}
