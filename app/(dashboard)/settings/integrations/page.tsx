'use client'

import { useEffect, useState, useCallback } from 'react'

// ── Logo SVGs ──────────────────────────────────────────────────────────────────
// Each logo renders at whatever size its container dictates via className.

function LogoStripe() {
  return (
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
      <rect width="24" height="24" rx="5" fill="#635BFF" />
      {/* Stripe S mark – simpleicons path */}
      <path fill="white" d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z" />
    </svg>
  )
}

function LogoChargebee() {
  return (
    <svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
      <rect width="40" height="40" rx="9" fill="#FF7A27" />
      {/* CB lightning bolt */}
      <path fill="white" d="M24 7l-9 13h6.5L18 33l11-15h-6.5L24 7z" />
    </svg>
  )
}

function LogoHubSpot() {
  return (
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
      <rect width="24" height="24" rx="5" fill="#FF7A59" />
      {/* HubSpot sprocket icon – simpleicons path */}
      <path fill="white" d="M18.164 7.93V5.637a1.55 1.55 0 0 0 .895-1.402V4.18a1.55 1.55 0 0 0-1.549-1.549h-.055a1.55 1.55 0 0 0-1.549 1.549v.056a1.55 1.55 0 0 0 .895 1.401V7.93a4.38 4.38 0 0 0-2.081.913L8.31 4.96a1.72 1.72 0 0 0 .05-.38 1.726 1.726 0 1 0-1.726 1.726c.22 0 .427-.045.618-.122l6.355 3.79a4.408 4.408 0 0 0-.57 2.17 4.38 4.38 0 0 0 .57 2.159l-1.784 1.261a1.448 1.448 0 0 0-.966-.366 1.457 1.457 0 1 0 1.457 1.457 1.44 1.44 0 0 0-.08-.468l1.761-1.245a4.393 4.393 0 0 0 3.21 1.384 4.406 4.406 0 0 0 4.406-4.405 4.4 4.4 0 0 0-3.447-4.3zm-.71 7.013a1.79 1.79 0 1 1 0-3.58 1.79 1.79 0 0 1 0 3.58z" />
    </svg>
  )
}

function LogoSalesforce() {
  return (
    <svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
      <rect width="40" height="40" rx="9" fill="#00A1E0" />
      {/* Salesforce cloud built from overlapping circles */}
      <circle cx="16" cy="25" r="6.5" fill="white" />
      <circle cx="20" cy="21" r="7" fill="white" />
      <circle cx="26" cy="23" r="5.5" fill="white" />
      <circle cx="29.5" cy="26" r="4" fill="white" />
      <rect x="9.5" y="25" width="24" height="7" fill="white" />
    </svg>
  )
}

function LogoZuora() {
  return (
    <svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
      <rect width="40" height="40" rx="9" fill="#0095CE" />
      {/* Zuora Z mark */}
      <path fill="white" d="M10 11h20l-13 18h13v-4H15l13-18H10v4z" />
    </svg>
  )
}

function LogoMaxio() {
  return (
    <svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
      <rect width="40" height="40" rx="9" fill="#1A365D" />
      {/* Maxio M mark */}
      <path fill="white" d="M8 29V11l12 12 12-12v18h-4V19l-8 8-8-8v10H8z" />
    </svg>
  )
}

function LogoRecurly() {
  return (
    <svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
      <rect width="40" height="40" rx="9" fill="#AF2882" />
      {/* Recurly R mark */}
      <path fill="white" d="M10 11h12c3.5 0 6 2.5 6 6s-2 5.5-5 6l6 6h-5l-5.5-5.5H14V29h-4V11zm4 4v5h7.5c1.4 0 2.5-1.1 2.5-2.5S22.9 15 21.5 15H14z" />
    </svg>
  )
}

function LogoQuickBooks() {
  return (
    <svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
      <rect width="40" height="40" rx="9" fill="#2CA01C" />
      {/* QuickBooks circle with Q mark */}
      <circle cx="20" cy="20" r="11" fill="white" />
      <circle cx="20" cy="20" r="7.5" fill="#2CA01C" />
      <circle cx="20" cy="20" r="3.5" fill="white" />
      {/* Tail of Q */}
      <rect x="23" y="22" width="5" height="2.5" rx="1.25" fill="white" transform="rotate(45 25.5 23.25)" />
    </svg>
  )
}

function LogoXero() {
  return (
    <svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
      <rect width="40" height="40" rx="20" fill="#13B5EA" />
      {/* Xero X mark using two diagonal bars */}
      <rect x="10.5" y="18.5" width="19" height="3" rx="1.5" fill="white" transform="rotate(45 20 20)" />
      <rect x="10.5" y="18.5" width="19" height="3" rx="1.5" fill="white" transform="rotate(-45 20 20)" />
    </svg>
  )
}

function LogoPipedrive() {
  return (
    <svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
      <rect width="40" height="40" rx="9" fill="#1B3F5E" />
      {/* Pipedrive P + pipeline dot mark */}
      <path fill="white" d="M10 10h10c5 0 9 4 9 9s-4 9-9 9h-6v6h-4V10zm4 4v10h6c2.8 0 5-2.2 5-5s-2.2-5-5-5H14z" />
      <circle cx="30" cy="29" r="3" fill="#26A65B" />
    </svg>
  )
}

function LogoAttio() {
  return (
    <svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
      <rect width="40" height="40" rx="9" fill="#191919" />
      {/* Attio geometric A */}
      <path fill="white" d="M20 8L8 32h6l2-4h8l2 4h6L20 8zm0 8l3 8h-6l3-8z" />
    </svg>
  )
}

const LOGOS: Record<string, () => React.ReactElement> = {
  stripe:      LogoStripe,
  chargebee:   LogoChargebee,
  hubspot:     LogoHubSpot,
  salesforce:  LogoSalesforce,
  zuora:       LogoZuora,
  maxio:       LogoMaxio,
  recurly:     LogoRecurly,
  quickbooks:  LogoQuickBooks,
  xero:        LogoXero,
  pipedrive:   LogoPipedrive,
  attio:       LogoAttio,
}

// ── Platform definitions ───────────────────────────────────────────────────────

type ConnectorStatus = 'live' | 'coming_soon'

interface PlatformField {
  key:         string
  label:       string
  placeholder: string
  secret?:     boolean
  optional?:   boolean
  hint?:       string
}

interface Platform {
  id:          string
  name:        string
  type:        'billing' | 'crm'
  description: string
  status:      ConnectorStatus
  fields?:     PlatformField[]
  docsUrl?:    string
  phase?:      string
}

const BILLING_PLATFORMS: Platform[] = [
  {
    id:          'stripe',
    name:        'Stripe',
    type:        'billing',
    description: 'Push approved subscriptions directly to Stripe. Handles recurring billing, metered usage, and invoicing.',
    status:      'live',
    fields: [
      { key: 'secret_key', label: 'Secret key', placeholder: 'sk_live_… (or sk_test_… for sandbox)', secret: true },
    ],
  },
  {
    id:          'chargebee',
    name:        'Chargebee',
    type:        'billing',
    description: 'Subscription lifecycle management with strong dunning and MRR analytics.',
    status:      'live',
    fields: [
      { key: 'site',    label: 'Site name',  placeholder: 'yoursite  (becomes yoursite.chargebee.com)' },
      { key: 'api_key', label: 'API key',    placeholder: 'test_…', secret: true },
    ],
  },
  {
    id:          'zuora',
    name:        'Zuora',
    type:        'billing',
    description: 'Enterprise subscription management with ASC 606 revenue recognition and CPQ.',
    status:      'coming_soon',
    phase:       'Phase 3',
  },
  {
    id:          'maxio',
    name:        'Maxio',
    type:        'billing',
    description: 'Mid-market SaaS billing (formerly SaaSOptics + Chargify) with subscription analytics.',
    status:      'coming_soon',
    phase:       'Phase 3',
  },
  {
    id:          'recurly',
    name:        'Recurly',
    type:        'billing',
    description: 'Subscription management with a focus on flexibility and retention.',
    status:      'coming_soon',
    phase:       'Phase 3',
  },
  {
    id:          'quickbooks',
    name:        'QuickBooks',
    type:        'billing',
    description: 'Invoice export to QuickBooks Online for accounting and reconciliation.',
    status:      'coming_soon',
    phase:       'Phase 3',
  },
  {
    id:          'xero',
    name:        'Xero',
    type:        'billing',
    description: 'Invoice export to Xero — popular for UK and European finance teams.',
    status:      'coming_soon',
    phase:       'Phase 3',
  },
]

const CRM_PLATFORMS: Platform[] = [
  {
    id:          'hubspot',
    name:        'HubSpot',
    type:        'crm',
    description: 'Closed Won → auto-create a Verdix job. Writes subscription ID back to the deal after approval.',
    status:      'coming_soon',
    phase:       'Phase 2',
  },
  {
    id:          'salesforce',
    name:        'Salesforce',
    type:        'crm',
    description: 'Opportunity → Contract trigger. Syncs contract metadata and subscription status bidirectionally.',
    status:      'coming_soon',
    phase:       'Phase 2',
  },
  {
    id:          'pipedrive',
    name:        'Pipedrive',
    type:        'crm',
    description: 'Deal won webhook → auto-create a Verdix job with deal metadata pre-filled.',
    status:      'coming_soon',
    phase:       'Phase 3',
  },
  {
    id:          'attio',
    name:        'Attio',
    type:        'crm',
    description: 'Modern B2B CRM. Record-level sync with contract status and subscription details.',
    status:      'coming_soon',
    phase:       'Phase 3',
  },
]

// ── Card component ─────────────────────────────────────────────────────────────

function PlatformCard({
  platform,
  connected,
  activeOfType,
  isAdmin,
  orgId,
  configKeys,
  onConnect,
  onDisconnect,
  onRefresh,
}: {
  platform:     Platform
  connected:    boolean
  activeOfType: string | null
  isAdmin:      boolean
  orgId:        string | null
  configKeys:   string[]
  onConnect:    (id: string, config: Record<string, string>) => Promise<void>
  onDisconnect: (id: string) => Promise<void>
  onRefresh:    () => Promise<void>
}) {
  const [open,         setOpen]         = useState(false)
  const [form,         setForm]         = useState<Record<string, string>>({})
  const [saving,       setSaving]       = useState(false)
  const [removing,     setRemoving]     = useState(false)
  const [msg,          setMsg]          = useState<{ ok: boolean; text: string } | null>(null)
  const [copied,        setCopied]        = useState(false)
  const [webhookSecret, setWebhookSecret] = useState('')
  const [savingSecret,  setSavingSecret]  = useState(false)
  const [secretMsg,     setSecretMsg]     = useState<{ ok: boolean; text: string } | null>(null)
  const [showSecretForm, setShowSecretForm] = useState(false)

  const Logo = LOGOS[platform.id]
  const isLive = platform.status === 'live'
  const willReplace = activeOfType !== null && activeOfType !== platform.id && !connected

  const webhookUrl = platform.id === 'stripe' && orgId
    ? `${typeof window !== 'undefined' ? window.location.origin : ''}/api/stripe/webhook?orgId=${orgId}`
    : null
  const hasWebhookSecret = configKeys.includes('webhook_secret')

  function copyWebhookUrl() {
    if (!webhookUrl) return
    navigator.clipboard.writeText(webhookUrl).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setMsg(null)
    try {
      await onConnect(platform.id, form)
      setMsg({ ok: true, text: 'Connected successfully.' })
      setForm({})
      setOpen(false)
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Unknown error'
      setMsg({ ok: false, text: detail })
    } finally {
      setSaving(false)
    }
  }

  async function handleDisconnect() {
    setRemoving(true)
    try {
      await onDisconnect(platform.id)
    } finally {
      setRemoving(false)
    }
  }

  return (
    <div
      className="bg-white rounded-2xl border overflow-hidden transition-colors"
      style={{ borderColor: connected ? 'rgba(74,124,89,0.3)' : 'rgba(26,61,43,0.1)' }}
    >
      {/* Card header */}
      <div className="flex items-center gap-4 px-5 py-4">
        {/* Logo tile */}
        <div className="w-10 h-10 rounded-xl overflow-hidden flex-shrink-0 shadow-sm">
          {Logo ? <Logo /> : (
            <div className="w-full h-full flex items-center justify-center bg-forest/10 text-forest text-xs font-bold">
              {platform.name[0]}
            </div>
          )}
        </div>

        {/* Name + description */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-ink">{platform.name}</p>
            {connected && (
              <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full"
                style={{ background: '#ECFDF5', color: '#065F46', border: '1px solid rgba(74,124,89,0.3)' }}>
                <span className="w-1.5 h-1.5 rounded-full bg-current inline-block" />
                Connected
              </span>
            )}
            {!isLive && (
              <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full"
                style={{ background: '#F3F4F6', color: '#6B7280', border: '1px solid #E5E7EB' }}>
                {platform.phase ?? 'Coming soon'}
              </span>
            )}
          </div>
          <p className="text-xs text-stone mt-0.5 leading-snug line-clamp-1">{platform.description}</p>
        </div>

        {/* Action button */}
        {isAdmin && isLive && !connected && (
          <button
            onClick={() => { setOpen(o => !o); setMsg(null) }}
            className="flex-shrink-0 text-xs font-semibold px-4 py-2 rounded-xl border transition-colors"
            style={{ borderColor: willReplace ? 'rgba(217,119,6,0.35)' : 'rgba(26,61,43,0.2)', color: willReplace ? '#B45309' : '#1A3D2B' }}
          >
            {open ? 'Cancel' : willReplace ? 'Switch' : 'Connect'}
          </button>
        )}
        {isAdmin && connected && (
          <button
            onClick={handleDisconnect}
            disabled={removing}
            className="flex-shrink-0 text-xs font-medium px-4 py-2 rounded-xl border transition-colors disabled:opacity-50"
            style={{ borderColor: 'rgba(220,38,38,0.2)', color: '#DC2626' }}
          >
            {removing ? 'Removing…' : 'Disconnect'}
          </button>
        )}
        {!isLive && (
          <span className="flex-shrink-0 text-xs text-stone">Notify me</span>
        )}
      </div>

      {/* Webhook setup panel — shown when Stripe is connected */}
      {connected && webhookUrl && (
        <div className="border-t px-5 pb-5 pt-4 space-y-4" style={{ borderColor: 'rgba(26,61,43,0.08)', background: '#FAFAF8' }}>
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-bold uppercase tracking-wider text-stone">Webhook setup</p>
            {hasWebhookSecret
              ? <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full" style={{ background: '#ECFDF5', color: '#065F46', border: '1px solid rgba(74,124,89,0.3)' }}>✓ Active</span>
              : <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full" style={{ background: 'rgba(251,191,36,0.1)', color: '#92400E', border: '1px solid rgba(217,119,6,0.3)' }}>Step 2 of 2 pending</span>
            }
          </div>

          {!hasWebhookSecret && (
            <ol className="space-y-3 text-xs text-stone">
              <li className="flex gap-2.5">
                <span className="flex-shrink-0 w-4 h-4 rounded-full bg-forest/10 text-forest text-[10px] font-bold flex items-center justify-center mt-0.5">1</span>
                <span>Copy this URL and register it in your Stripe dashboard under <strong className="text-ink">Developers → Webhooks → Add destination</strong>. Select events <code className="font-mono bg-forest/8 px-1 rounded">invoice.created</code> and <code className="font-mono bg-forest/8 px-1 rounded">invoice.payment_succeeded</code>.</span>
              </li>
              <li className="flex gap-2.5">
                <span className="flex-shrink-0 w-4 h-4 rounded-full bg-forest/10 text-forest text-[10px] font-bold flex items-center justify-center mt-0.5">2</span>
                <span>Stripe shows a <strong className="text-ink">signing secret</strong> (<code className="font-mono bg-forest/8 px-1 rounded">whsec_…</code>) after the webhook is created. Paste it below.</span>
              </li>
            </ol>
          )}

          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-[11px] bg-white border border-forest/15 rounded-lg px-3 py-2 text-ink break-all">
              {webhookUrl}
            </code>
            <button
              onClick={copyWebhookUrl}
              className="flex-shrink-0 text-xs font-medium px-3 py-2 rounded-lg border transition-colors"
              style={{ borderColor: 'rgba(26,61,43,0.2)', color: '#1A3D2B' }}
            >
              {copied ? '✓ Copied' : 'Copy'}
            </button>
          </div>

          {isAdmin && (
            <div className="space-y-2">
              {/* When already active, hide the form behind a small link */}
              {hasWebhookSecret && !showSecretForm ? (
                <button
                  onClick={() => setShowSecretForm(true)}
                  className="text-xs text-stone hover:text-forest transition-colors underline underline-offset-2"
                >
                  Update signing secret
                </button>
              ) : (
                <>
                  <label className="block text-[10px] font-semibold uppercase tracking-wider text-stone">
                    {hasWebhookSecret ? 'Update signing secret' : 'Signing secret'}
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="password"
                      placeholder="whsec_…"
                      value={webhookSecret}
                      onChange={e => setWebhookSecret(e.target.value)}
                      className="flex-1 text-sm border border-forest/20 rounded-xl px-4 py-2.5 bg-white text-ink placeholder:text-stone/40 focus:outline-none focus:ring-2 focus:ring-forest/20 font-mono"
                    />
                    <button
                      onClick={async () => {
                        if (!webhookSecret.trim()) return
                        setSavingSecret(true)
                        setSecretMsg(null)
                        try {
                          const res = await fetch(`/api/org/integrations/${platform.id}`, {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ config: { webhook_secret: webhookSecret.trim() } }),
                          })
                          if (!res.ok) throw new Error((await res.json()).error ?? 'Save failed')
                          setWebhookSecret('')
                          setSecretMsg({ ok: true, text: 'Saved.' })
                          setShowSecretForm(false)
                          await onRefresh()
                        } catch (err) {
                          setSecretMsg({ ok: false, text: err instanceof Error ? err.message : 'Save failed' })
                        } finally {
                          setSavingSecret(false)
                        }
                      }}
                      disabled={savingSecret || !webhookSecret.trim()}
                      className="flex-shrink-0 bg-forest text-white text-sm font-medium px-4 py-2.5 rounded-xl hover:bg-sage transition-colors disabled:opacity-40"
                    >
                      {savingSecret ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                  {secretMsg && (
                    <p className={`text-xs ${secretMsg.ok ? 'text-forest' : 'text-red-600'}`}>{secretMsg.text}</p>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Credential form */}
      {open && !connected && isLive && platform.fields && (
        <div className="border-t px-5 pb-5 pt-4" style={{ borderColor: 'rgba(26,61,43,0.08)', background: '#FAFAF8' }}>
          {willReplace && (
            <div className="mb-3 flex items-start gap-2 rounded-xl px-3 py-2.5 text-xs"
              style={{ background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(217,119,6,0.2)', color: '#92400E' }}>
              <i className="ti ti-alert-triangle flex-shrink-0 mt-0.5" style={{ fontSize: 13 }} />
              <span>
                Connecting {platform.name} will automatically disconnect{' '}
                <strong>{BILLING_PLATFORMS.concat(CRM_PLATFORMS).find(p => p.id === activeOfType)?.name ?? activeOfType}</strong>.
                Only one {platform.type === 'billing' ? 'billing platform' : 'CRM'} can be active at a time.
              </span>
            </div>
          )}
          <form onSubmit={handleSave} className="flex flex-col gap-3">
            {platform.fields.map(field => (
              <div key={field.key}>
                <label className="block text-[10px] font-semibold uppercase tracking-wider text-stone mb-1">
                  {field.label}{field.optional && <span className="ml-1 normal-case font-normal text-stone/60">(optional)</span>}
                </label>
                <input
                  type={field.secret ? 'password' : 'text'}
                  placeholder={field.placeholder}
                  value={form[field.key] ?? ''}
                  onChange={e => setForm(f => ({ ...f, [field.key]: e.target.value }))}
                  required={!field.optional}
                  className="w-full text-sm border border-forest/20 rounded-xl px-4 py-2.5 bg-white text-ink placeholder:text-stone/40 focus:outline-none focus:ring-2 focus:ring-forest/20 font-mono"
                />
                {field.hint && (
                  <p className="text-[11px] text-stone mt-1 leading-snug">{field.hint}</p>
                )}
              </div>
            ))}
            <div className="flex items-center gap-3 pt-1">
              <button
                type="submit"
                disabled={saving}
                className="bg-forest text-white text-sm font-medium px-5 py-2.5 rounded-xl hover:bg-sage transition-colors disabled:opacity-50"
              >
                {saving ? 'Saving…' : willReplace ? `Switch to ${platform.name}` : 'Save credentials'}
              </button>
              {msg && (
                <p className={`text-xs ${msg.ok ? 'text-forest' : 'text-red-600'}`}>{msg.text}</p>
              )}
            </div>
          </form>
          <p className="text-[11px] text-stone mt-3 leading-snug">
            Credentials are stored encrypted and never exposed in the UI after saving.
            Only admins can view or change integration settings.
          </p>
        </div>
      )}
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

interface Integration {
  connector_name: string
  is_active:      boolean
  config_keys:    string[]
}

export default function IntegrationsPage() {
  const [integrations, setIntegrations] = useState<Integration[]>([])
  const [org,          setOrg]          = useState<{ role: string; orgId: string } | null>(null)
  const [loading,      setLoading]      = useState(true)

  const load = useCallback(async () => {
    const [intRes, orgRes] = await Promise.all([
      fetch('/api/org/integrations'),
      fetch('/api/org'),
    ])
    const intData = await intRes.json()
    const orgData = await orgRes.json()
    setIntegrations(intData.integrations ?? [])
    setOrg(orgData)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const isConnected = (id: string) =>
    integrations.some(i => i.connector_name === id && i.is_active)

  const activeBilling = integrations.find(i =>
    i.is_active && BILLING_PLATFORMS.some(p => p.id === i.connector_name)
  )?.connector_name ?? null

  const activeCrm = integrations.find(i =>
    i.is_active && CRM_PLATFORMS.some(p => p.id === i.connector_name)
  )?.connector_name ?? null

  const isAdmin = org?.role === 'owner' || org?.role === 'admin'
  const orgId   = org?.orgId ?? null

  const handleConnect = async (connectorName: string, config: Record<string, string>) => {
    const res = await fetch('/api/org/integrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connector_name: connectorName, config }),
    })
    if (!res.ok) {
      const d = await res.json()
      throw new Error(d.error ?? 'Save failed')
    }
    await load()
  }

  const handleDisconnect = async (connectorName: string) => {
    await fetch(`/api/org/integrations/${connectorName}`, { method: 'DELETE' })
    await load()
  }

  const connectedBilling = activeBilling !== null
  const connectedCrm     = activeCrm !== null

  if (loading) {
    return (
      <div className="p-8 flex items-center gap-2 text-stone text-sm">
        <i className="ti ti-loader-2 animate-spin" style={{ fontSize: 16 }} />
        Loading…
      </div>
    )
  }

  return (
    <div className="p-4 md:p-8 max-w-2xl">

      {/* Header */}
      <div className="mb-8">
        <h1 className="font-display font-light text-ink text-2xl mb-1">Integrations</h1>
        <p className="text-stone text-sm">
          Connect Verdix to your billing platform and CRM. Once connected, approved contracts are
          pushed directly — no manual data entry.
        </p>
      </div>

      {/* Section — Billing */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-stone">
              Billing platforms
            </p>
            <p className="text-xs text-stone/70 mt-0.5">
              Verdix pushes approved subscriptions to these systems.
            </p>
          </div>
          {connectedBilling && (
            <span className="text-xs text-forest font-medium">1 connected</span>
          )}
        </div>
        <div className="flex flex-col gap-2">
          {BILLING_PLATFORMS.map(p => (
            <PlatformCard
              key={p.id}
              platform={p}
              connected={isConnected(p.id)}
              activeOfType={activeBilling}
              isAdmin={isAdmin}
              orgId={orgId}
              configKeys={integrations.find(i => i.connector_name === p.id)?.config_keys ?? []}
              onConnect={handleConnect}
              onDisconnect={handleDisconnect}
              onRefresh={load}
            />
          ))}
        </div>
      </div>

      {/* Section — CRM */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-stone">
              CRM systems
            </p>
            <p className="text-xs text-stone/70 mt-0.5">
              Verdix pulls deals and writes subscription IDs back when billing is configured.
            </p>
          </div>
          {connectedCrm && (
            <span className="text-xs text-forest font-medium">1 connected</span>
          )}
        </div>
        <div className="flex flex-col gap-2">
          {CRM_PLATFORMS.map(p => (
            <PlatformCard
              key={p.id}
              platform={p}
              connected={isConnected(p.id)}
              activeOfType={activeCrm}
              isAdmin={isAdmin}
              orgId={orgId}
              configKeys={integrations.find(i => i.connector_name === p.id)?.config_keys ?? []}
              onConnect={handleConnect}
              onDisconnect={handleDisconnect}
              onRefresh={load}
            />
          ))}
        </div>
      </div>

      {/* Footer note for non-admins */}
      {!isAdmin && (
        <p className="text-xs text-stone mt-4">
          Only owners and admins can connect or disconnect integrations.
        </p>
      )}

    </div>
  )
}
