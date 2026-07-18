'use client'

import { useState, useEffect } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

type LineItem = {
  type: 'base' | 'overage' | string
  description: string
  amount: number
  currency: string
  unit_type?: string
  total_quantity?: number
  included_quantity?: number
  excess_quantity?: number
}

type ValidationFinding = {
  leakage_type: string
  priority: 'CRITICAL' | 'HIGH' | 'MEDIUM'
  description: string
  evidence?: string
}

type ComputedInvoice = {
  id: string
  external_invoice_id: string
  external_subscription_id: string | null
  connector: string
  period_start: string
  period_end: string
  line_items: LineItem[]
  total_amount: number
  currency: string
  status: string
  paid_at: string | null
  validation_result: ValidationFinding[] | null
  external_invoice_pdf_url: string | null
  created_at: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number, cur = 'EUR') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: cur, maximumFractionDigits: 2,
  }).format(n)
}

function fmtDate(s: string | null) {
  if (!s) return '—'
  return new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function fmtPeriod(start: string, end: string) {
  const s = new Date(start)
  const e = new Date(end)
  const opts: Intl.DateTimeFormatOptions = { month: 'short', year: 'numeric' }
  if (s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear()) {
    return s.toLocaleDateString('en-GB', opts)
  }
  return `${s.toLocaleDateString('en-GB', opts)} – ${e.toLocaleDateString('en-GB', opts)}`
}

const STATUS_META: Record<string, { label: string; color: string; bg: string; icon: string }> = {
  DRAFT:        { label: 'Draft',         color: '#6B7280', bg: '#F3F4F6', icon: 'ti-file-pencil' },
  VALIDATED:    { label: 'Validated',     color: '#059669', bg: '#ECFDF5', icon: 'ti-circle-check' },
  NEEDS_REVIEW: { label: 'Needs review',  color: '#D97706', bg: '#FFFBEB', icon: 'ti-alert-triangle' },
  SENT:         { label: 'Sent',          color: '#2563EB', bg: '#EFF6FF', icon: 'ti-send' },
  PAID:         { label: 'Paid',          color: '#0B5C36', bg: '#ECFDF5', icon: 'ti-circle-check-filled' },
  VOID:         { label: 'Void',          color: '#9CA3AF', bg: '#F9FAFB', icon: 'ti-ban' },
}

const PRIORITY_COLOR: Record<string, string> = {
  CRITICAL: '#DC2626',
  HIGH:     '#D97706',
  MEDIUM:   '#6B7280',
}

const CONNECTOR_LABEL: Record<string, string> = {
  stripe:    'Stripe',
  chargebee: 'Chargebee',
  zuora:     'Zuora',
}

function connectorDashboardUrl(connector: string, externalInvoiceId: string): string | null {
  if (connector === 'stripe') {
    const isTest = externalInvoiceId.startsWith('in_')
    return `https://dashboard.stripe.com/test/invoices/${externalInvoiceId}`
  }
  return null
}

// ── Invoice Card ──────────────────────────────────────────────────────────────

function InvoiceCard({ inv }: { inv: ComputedInvoice }) {
  const [open, setOpen] = useState(false)

  const status  = STATUS_META[inv.status] ?? STATUS_META['DRAFT']
  const baseLines = inv.line_items.filter(l => l.type === 'base')
  const ovgLines  = inv.line_items.filter(l => l.type === 'overage')
  const baseTotal = baseLines.reduce((s, l) => s + l.amount, 0)
  const ovgTotal  = ovgLines.reduce((s, l) => s + l.amount, 0)
  const findings  = inv.validation_result ?? []
  const dashUrl   = connectorDashboardUrl(inv.connector, inv.external_invoice_id)

  return (
    <div
      className="rounded-2xl border overflow-hidden"
      style={{ borderColor: inv.status === 'NEEDS_REVIEW' ? '#FCD34D' : 'rgba(26,61,43,0.12)' }}
    >
      {/* ── Card header ── */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full text-left px-6 py-4 flex items-center gap-4 hover:bg-parchment/40 transition-colors"
      >
        {/* Period */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-ink truncate">
            {fmtPeriod(inv.period_start, inv.period_end)}
          </p>
          <p className="text-xs text-stone mt-0.5">
            {CONNECTOR_LABEL[inv.connector] ?? inv.connector} · {inv.external_invoice_id}
          </p>
        </div>

        {/* Total */}
        <div className="text-right flex-shrink-0">
          <p className="text-sm font-semibold text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {fmt(inv.total_amount, inv.currency)}
          </p>
          {ovgTotal > 0 && (
            <p className="text-xs mt-0.5" style={{ color: '#0B5C36', fontVariantNumeric: 'tabular-nums' }}>
              incl. {fmt(ovgTotal, inv.currency)} overage
            </p>
          )}
        </div>

        {/* Status chip */}
        <div
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium flex-shrink-0"
          style={{ color: status.color, background: status.bg }}
        >
          <i className={`ti ${status.icon}`} style={{ fontSize: 11 }} />
          {status.label}
        </div>

        {/* Paid date */}
        {inv.paid_at && (
          <div className="text-xs text-stone flex-shrink-0">
            Paid {fmtDate(inv.paid_at)}
          </div>
        )}

        {/* Expand chevron */}
        <i
          className={`ti ti-chevron-down text-stone transition-transform flex-shrink-0`}
          style={{ fontSize: 14, transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
        />
      </button>

      {/* ── Expanded detail ── */}
      {open && (
        <div className="border-t px-6 py-5 space-y-5" style={{ borderColor: 'rgba(26,61,43,0.08)' }}>

          {/* Validation findings (if any) */}
          {findings.length > 0 && (
            <div className="rounded-xl p-4 space-y-2" style={{ background: '#FFFBEB', border: '1px solid #FCD34D' }}>
              <p className="text-xs font-bold uppercase tracking-widest" style={{ color: '#D97706' }}>
                <i className="ti ti-alert-triangle mr-1" />
                Billing check flagged {findings.length} issue{findings.length > 1 ? 's' : ''}
              </p>
              {findings.map((f, i) => (
                <div key={i} className="flex gap-3">
                  <span
                    className="text-[10px] font-bold px-1.5 py-0.5 rounded flex-shrink-0 mt-0.5"
                    style={{ color: PRIORITY_COLOR[f.priority], background: `${PRIORITY_COLOR[f.priority]}18` }}
                  >
                    {f.priority}
                  </span>
                  <div>
                    <p className="text-xs text-ink">{f.description}</p>
                    {f.evidence && <p className="text-xs text-stone mt-0.5">{f.evidence}</p>}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {/* Section 1: From connector — subscription base + raw meter reads */}
            <div className="space-y-2">
              <p className="text-[10px] font-bold uppercase tracking-widest text-stone">
                From {CONNECTOR_LABEL[inv.connector] ?? inv.connector}
              </p>
              <div className="rounded-xl p-3 space-y-1.5" style={{ background: '#F9FAFB' }}>
                {baseTotal > 0 && (
                  <div className="flex justify-between text-xs">
                    <span className="text-stone">Subscription base</span>
                    <span className="text-ink font-medium" style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {fmt(baseTotal, inv.currency)}
                    </span>
                  </div>
                )}
                {ovgLines.map((l, i) => (
                  <div key={`meter-${i}`} className="text-xs border-t pt-1.5" style={{ borderColor: 'rgba(26,61,43,0.08)' }}>
                    <div className="flex justify-between">
                      <span className="text-stone">{l.unit_type ?? 'Metered usage'}</span>
                    </div>
                    {l.total_quantity != null && (
                      <div className="mt-1 space-y-0.5 pl-1">
                        <div className="flex justify-between">
                          <span className="text-stone/70">Total usage</span>
                          <span className="font-medium text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {l.total_quantity.toLocaleString()} units
                          </span>
                        </div>
                        {l.included_quantity != null && (
                          <div className="flex justify-between">
                            <span className="text-stone/70">Included</span>
                            <span className="text-stone" style={{ fontVariantNumeric: 'tabular-nums' }}>
                              {l.included_quantity.toLocaleString()} units
                            </span>
                          </div>
                        )}
                        {l.excess_quantity != null && l.excess_quantity > 0 && (
                          <div className="flex justify-between">
                            <span className="text-stone/70">Excess (billed)</span>
                            <span className="font-medium" style={{ color: '#0B5C36', fontVariantNumeric: 'tabular-nums' }}>
                              {l.excess_quantity.toLocaleString()} units
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
                <div className="border-t pt-1.5 flex justify-between text-xs font-semibold" style={{ borderColor: 'rgba(26,61,43,0.1)' }}>
                  <span>Draft total (base only)</span>
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(baseTotal, inv.currency)}</span>
                </div>
              </div>
            </div>

            {/* Section 2: Verdix adjustments */}
            <div className="space-y-2">
              <p className="text-[10px] font-bold uppercase tracking-widest text-stone">
                Verdix adjustments
              </p>
              <div className="rounded-xl p-3 space-y-1.5" style={{ background: '#F0FDF4' }}>
                {baseLines.map((l, i) => (
                  <div key={i} className="text-xs">
                    <p className="text-ink">{l.description}</p>
                    <p className="text-stone text-right font-medium mt-0.5" style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {fmt(l.amount, l.currency)}
                    </p>
                  </div>
                ))}
                {ovgLines.map((l, i) => (
                  <div key={`ovg-${i}`} className="text-xs border-t pt-1.5" style={{ borderColor: 'rgba(11,92,54,0.15)' }}>
                    <p className="text-ink">{l.description}</p>
                    <p className="font-medium mt-0.5 text-right" style={{ color: '#0B5C36', fontVariantNumeric: 'tabular-nums' }}>
                      +{fmt(l.amount, l.currency)}
                    </p>
                  </div>
                ))}
                {inv.line_items.length === 0 && (
                  <p className="text-xs text-stone italic">No adjustments</p>
                )}
              </div>
            </div>

            {/* Section 3: Final invoice */}
            <div className="space-y-2">
              <p className="text-[10px] font-bold uppercase tracking-widest text-stone">
                Final invoice
              </p>
              <div className="rounded-xl p-3 space-y-1.5" style={{ background: '#F9FAFB' }}>
                {baseTotal > 0 && (
                  <div className="flex justify-between text-xs">
                    <span className="text-stone">Base</span>
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(baseTotal, inv.currency)}</span>
                  </div>
                )}
                {ovgTotal > 0 && (
                  <div className="flex justify-between text-xs">
                    <span className="text-stone">Overage</span>
                    <span style={{ color: '#0B5C36', fontVariantNumeric: 'tabular-nums' }}>+{fmt(ovgTotal, inv.currency)}</span>
                  </div>
                )}
                <div className="border-t pt-1.5 flex justify-between text-sm font-semibold" style={{ borderColor: 'rgba(26,61,43,0.1)' }}>
                  <span>Total</span>
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(inv.total_amount, inv.currency)}</span>
                </div>
                {inv.paid_at && (
                  <div className="flex justify-between text-xs mt-1" style={{ color: '#0B5C36' }}>
                    <span>Paid</span>
                    <span>{fmtDate(inv.paid_at)}</span>
                  </div>
                )}
              </div>

              {/* Links */}
              <div className="flex flex-wrap gap-2">
                {dashUrl && (
                  <a
                    href={dashUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-forest hover:underline"
                  >
                    <i className="ti ti-external-link" style={{ fontSize: 11 }} />
                    View in {CONNECTOR_LABEL[inv.connector] ?? inv.connector}
                  </a>
                )}
                {inv.external_invoice_pdf_url && (
                  <a
                    href={inv.external_invoice_pdf_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-forest hover:underline"
                  >
                    <i className="ti ti-file-type-pdf" style={{ fontSize: 11 }} />
                    Download PDF
                  </a>
                )}
              </div>
            </div>
          </div>

          {/* Metadata footer */}
          <div className="flex items-center justify-between pt-2 border-t text-xs text-stone" style={{ borderColor: 'rgba(26,61,43,0.08)' }}>
            <span>Created {fmtDate(inv.created_at)}</span>
            <span className="font-mono opacity-60">{inv.id}</span>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function InvoicesTab({ jobId, billingPlatform, onNavigate }: {
  jobId: string
  billingPlatform?: string
  onNavigate?: (tab: 'terms' | 'model' | 'invoices') => void
}) {
  const [invoices, setInvoices] = useState<ComputedInvoice[]>([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)

  useEffect(() => {
    if (!jobId) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    fetch(`/api/jobs/${jobId}/invoices`)
      .then(r => r.json())
      .then((data: ComputedInvoice[]) => {
        if (Array.isArray(data)) setInvoices(data)
        else setError('Unexpected response from server')
      })
      .catch(() => setError('Failed to load invoices'))
      .finally(() => setLoading(false))
  }, [jobId])

  // Summary counts
  const paid        = invoices.filter(i => i.status === 'PAID').length
  const needsReview = invoices.filter(i => i.status === 'NEEDS_REVIEW').length
  const totalBilled = invoices.reduce((s, i) => s + i.total_amount, 0)
  const currency    = invoices[0]?.currency ?? 'EUR'

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48 text-stone text-sm">
        <i className="ti ti-loader-2 animate-spin mr-2" style={{ fontSize: 16 }} />
        Loading invoices…
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-48 text-danger text-sm">
        <i className="ti ti-alert-circle mr-2" style={{ fontSize: 16 }} />
        {error}
      </div>
    )
  }

  if (invoices.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-48 gap-2">
        <i className="ti ti-file-invoice text-stone/30" style={{ fontSize: 40 }} />
        <p className="text-sm text-stone">No consumption invoices yet</p>
        <p className="text-xs text-stone/60 text-center max-w-xs">These appear automatically after each billing cycle runs — Verdix computes overages and finalises the invoice in Stripe.</p>
      </div>
    )
  }

  return (
    <div className="px-8 py-8 space-y-6">

      {/* ── Description ── */}
      {(() => {
        const platformName = CONNECTOR_LABEL[billingPlatform ?? ''] ?? CONNECTOR_LABEL[invoices[0]?.connector ?? ''] ?? 'the billing platform'
        return (
          <div className="bg-forest/[0.04] border border-forest/10 rounded-xl px-4 py-3">
            <p className="text-[11px] text-stone leading-relaxed">
              <span className="font-semibold text-ink">Consumption-adjusted invoices only.</span>{' '}
              Each entry is a billing period invoice that Verdix computed and finalised in {platformName} — reflecting the contracted base fee plus any usage overages for that period. All invoices including these are shown in the{' '}
              {onNavigate ? (
                <button onClick={() => onNavigate('terms')}
                  className="font-medium text-forest underline underline-offset-2 hover:text-forest/70 transition-colors">
                  Contract · Commercials tab under Billing setup
                </button>
              ) : (
                <span className="font-medium text-ink">Contract · Commercials tab under Billing setup</span>
              )}.
              {' '}The full billing schedule including future invoices is on the{' '}
              {onNavigate ? (
                <button onClick={() => onNavigate('model')}
                  className="font-medium text-forest underline underline-offset-2 hover:text-forest/70 transition-colors">
                  Revenue model tab
                </button>
              ) : (
                <span className="font-medium text-ink">Revenue model tab</span>
              )}.
            </p>
          </div>
        )
      })()}

      {/* ── Summary KPIs ── */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-2xl p-4" style={{ background: '#F0FDF4' }}>
          <p className="text-[10px] font-bold uppercase tracking-widest text-stone mb-1">Total billed</p>
          <p className="text-2xl font-semibold" style={{ color: '#1A3D2B', fontVariantNumeric: 'tabular-nums' }}>
            {fmt(totalBilled, currency)}
          </p>
          <p className="text-xs text-stone mt-1">{invoices.length} invoice{invoices.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="rounded-2xl p-4" style={{ background: paid > 0 ? '#F0FDF4' : '#F9FAFB' }}>
          <p className="text-[10px] font-bold uppercase tracking-widest text-stone mb-1">Paid</p>
          <p className="text-2xl font-semibold" style={{ color: '#0B5C36', fontVariantNumeric: 'tabular-nums' }}>
            {paid}
          </p>
          <p className="text-xs text-stone mt-1">of {invoices.length} invoices</p>
        </div>
        <div className="rounded-2xl p-4" style={{ background: needsReview > 0 ? '#FFFBEB' : '#F9FAFB' }}>
          <p className="text-[10px] font-bold uppercase tracking-widest text-stone mb-1">Needs review</p>
          <p className="text-2xl font-semibold" style={{ color: needsReview > 0 ? '#D97706' : '#9CA3AF', fontVariantNumeric: 'tabular-nums' }}>
            {needsReview}
          </p>
          <p className="text-xs text-stone mt-1">flagged by billing check</p>
        </div>
      </div>

      {/* ── Timeline header ── */}
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-bold uppercase tracking-widest text-stone">Invoice history</p>
        <p className="text-xs text-stone">Most recent first</p>
      </div>

      {/* ── Invoice cards ── */}
      <div className="space-y-3">
        {invoices.map(inv => (
          <InvoiceCard key={inv.id} inv={inv} />
        ))}
      </div>
    </div>
  )
}
