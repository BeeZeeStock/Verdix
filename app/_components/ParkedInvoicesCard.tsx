'use client'

import { useState } from 'react'
import type { BillabilityEventType } from '@/lib/types'
import { EVIDENCE_ACTION_LABELS, EVIDENCE_RECORDED_LABELS, EVIDENCE_WAITING_LABELS } from '@/lib/billability-event-labels'

type BillabilityCondition =
  | { kind: 'immediate' }
  | { kind: 'fixed_date'; date: string }
  | { kind: 'event'; event_type: BillabilityEventType }

type ParkedInvoice = {
  id:                   string
  feeId:                string | null
  feeLabel:             string | null
  currency:             string
  baseAmount:           number
  metricName:           string | null
  ratePerUnit:          number | null
  description:          string | null
  billabilityCondition: BillabilityCondition | null
  evidence:             { occurredAt: string; recordedAt: string } | null
  plannedInvoiceStatus: string
}

type GeneratedEntry = {
  invoiceId: string
  amount:    number
  hostedUrl: string | null
  label:     string
}

function fmt(amount: number, currency: string) {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(amount)
}

// ── Manual / quantity-rate parked fee — unchanged from the pre-existing
// workflow. Only ever rendered for a fee with no event billability
// condition (genuinely manual professional-services-style fees that never
// entered the Step-12 event lifecycle at all).
function ManualQuantityFeeRow({
  fee,
  jobId,
  onGenerated,
}: {
  fee:         ParkedInvoice
  jobId:       string
  onGenerated: (entry: GeneratedEntry) => void
}) {
  const [quantity,    setQuantity]    = useState('')
  const [rateOverride, setRateOverride] = useState(fee.ratePerUnit != null ? String(fee.ratePerUnit) : '')
  const [generating,  setGenerating]  = useState(false)
  const [error,       setError]       = useState<string | null>(null)
  const [expanded,    setExpanded]    = useState(false)

  const qty      = parseFloat(quantity)  || 0
  const rate     = parseFloat(rateOverride) || 0
  const computed = Math.round(qty * rate * 100) / 100
  const metricLabel = fee.metricName ?? 'units'

  const handleGenerate = async () => {
    if (!qty || !rate) return
    setGenerating(true)
    setError(null)
    try {
      const res = await fetch(`/api/jobs/${jobId}/parked-invoices`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fee_label:    fee.feeLabel,
          quantity:     qty,
          rate_per_unit: rate,
          metric_name:  metricLabel,
          currency:     fee.currency,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Failed to generate invoice')
        return
      }
      setQuantity('')
      onGenerated({
        invoiceId: data.invoiceId,
        amount:    data.amount,
        hostedUrl: data.hostedUrl,
        label:     `${qty} ${metricLabel} @ ${fmt(rate, fee.currency)}`,
      })
    } catch {
      setError('Network error — please try again')
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="border border-forest/10 rounded-xl overflow-hidden">
      {/* Header row */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-cream/40 transition-colors"
      >
        <div>
          <p className="text-sm font-medium text-ink">{fee.feeLabel ?? 'Service fee'}</p>
          {fee.description && (
            <p className="text-xs text-stone mt-0.5 line-clamp-1">{fee.description}</p>
          )}
        </div>
        <div className="flex items-center gap-3 flex-shrink-0 ml-4">
          {fee.ratePerUnit != null && (
            <span className="text-xs text-stone font-mono">
              {fmt(fee.ratePerUnit, fee.currency)}/{metricLabel}
            </span>
          )}
          <i className={`ti ${expanded ? 'ti-chevron-up' : 'ti-chevron-down'} text-stone`} style={{ fontSize: 13 }} />
        </div>
      </button>

      {expanded && (
        <div className="border-t border-forest/8 px-5 pb-5 pt-4 bg-cream/20">
          {fee.description && (
            <p className="text-xs text-stone mb-4">{fee.description}</p>
          )}

          <div className="grid grid-cols-2 gap-3 mb-4">
            {/* Quantity */}
            <div>
              <label className="text-[10px] font-semibold uppercase tracking-wider text-stone block mb-1.5">
                {metricLabel.charAt(0).toUpperCase() + metricLabel.slice(1)} delivered
              </label>
              <input
                type="number"
                min="0"
                step="0.5"
                value={quantity}
                onChange={e => setQuantity(e.target.value)}
                placeholder={`Enter ${metricLabel}…`}
                className="w-full text-sm border border-forest/20 rounded-lg px-3 py-2 bg-white text-ink placeholder:text-stone/50 focus:outline-none focus:border-forest/40"
              />
            </div>

            {/* Rate per unit */}
            <div>
              <label className="text-[10px] font-semibold uppercase tracking-wider text-stone block mb-1.5">
                Rate per {metricLabel} ({fee.currency})
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={rateOverride}
                onChange={e => setRateOverride(e.target.value)}
                placeholder="Rate…"
                className="w-full text-sm border border-forest/20 rounded-lg px-3 py-2 bg-white text-ink placeholder:text-stone/50 focus:outline-none focus:border-forest/40"
              />
            </div>
          </div>

          {/* Computed amount */}
          {qty > 0 && rate > 0 && (
            <div className="bg-white border border-forest/10 rounded-lg px-4 py-3 mb-4 flex items-center justify-between">
              <div>
                <p className="text-[10px] uppercase tracking-wider font-semibold text-stone mb-0.5">Invoice amount</p>
                <p className="text-lg font-semibold text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {fmt(computed, fee.currency)}
                </p>
              </div>
              <p className="text-xs text-stone font-mono">
                {qty} {metricLabel} × {fmt(rate, fee.currency)}
              </p>
            </div>
          )}

          {error && <p className="text-xs text-red-600 mb-3">{error}</p>}

          <button
            onClick={handleGenerate}
            disabled={generating || !qty || !rate}
            className="inline-flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-xl transition-colors disabled:opacity-40"
            style={{ background: '#1A3D2B', color: '#fff' }}
          >
            {generating
              ? <><i className="ti ti-loader-2 animate-spin" style={{ fontSize: 13 }} /> Generating…</>
              : <><i className="ti ti-send" style={{ fontSize: 13 }} /> Confirm delivery &amp; send invoice</>
            }
          </button>
        </div>
      )}
    </div>
  )
}

function fmtEvidenceDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

// ── Event-gated fixed one-time fee — the amount is already known (from
// Verdix's own contractual intelligence); there is nothing to compute here.
// This surface only ever records whether the contractual event happened —
// it never sends an invoice, never calls Stripe/Remembill/the scheduler,
// and never recomputes the amount. Reuses the exact same
// OperationalEventEvidence attestation path the Review drawer's one-time-fee
// card already uses (app/api/jobs/[id]/operational-events/attest) — no
// second recording mechanism.
function EventGatedFeeRow({
  fee,
  jobId,
  onRecorded,
}: {
  fee:        ParkedInvoice
  jobId:      string
  onRecorded: () => void
}) {
  const [expanded, setExpanded]     = useState(false)
  const [occurredAt, setOccurredAt] = useState('') // deliberately blank — never prefilled with today
  const [recording, setRecording]   = useState(false)
  const [error, setError]           = useState<string | null>(null)

  if (fee.billabilityCondition?.kind !== 'event') return null
  const eventType = fee.billabilityCondition.event_type

  const handleRecord = async () => {
    if (!occurredAt || !fee.feeId) return
    setRecording(true)
    setError(null)
    try {
      const res = await fetch(`/api/jobs/${jobId}/operational-events/attest`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ subjectId: fee.feeId, occurredAt }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        setError(data?.error ?? 'Verdix could not record this.')
        return
      }
      setOccurredAt('')
      onRecorded()
    } catch {
      setError('Network error — please try again')
    } finally {
      setRecording(false)
    }
  }

  return (
    <div className="border border-forest/10 rounded-xl overflow-hidden">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-cream/40 transition-colors"
      >
        <div>
          <p className="text-sm font-medium text-ink">{fee.feeLabel ?? 'One-time fee'}</p>
          {fee.description && (
            <p className="text-xs text-stone mt-0.5 line-clamp-1">{fee.description}</p>
          )}
        </div>
        <div className="flex items-center gap-3 flex-shrink-0 ml-4">
          <span className="text-xs text-stone font-mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {fmt(fee.baseAmount, fee.currency)}
          </span>
          <i className={`ti ${expanded ? 'ti-chevron-up' : 'ti-chevron-down'} text-stone`} style={{ fontSize: 13 }} />
        </div>
      </button>

      {expanded && (
        <div className="border-t border-forest/8 px-5 pb-5 pt-4 bg-cream/20">
          {fee.description && (
            <p className="text-xs text-stone mb-4">{fee.description}</p>
          )}

          <div className="bg-white border border-forest/10 rounded-lg px-4 py-3 mb-3">
            <p className="text-[10px] uppercase tracking-wider font-semibold text-stone mb-0.5">Amount</p>
            <p className="text-lg font-semibold text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {fmt(fee.baseAmount, fee.currency)}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 mb-4">
            <div>
              <p className="text-[10px] uppercase tracking-wider font-semibold text-stone mb-0.5">Billing condition</p>
              <p className="text-sm text-ink">{EVIDENCE_RECORDED_LABELS[eventType].replace(' recorded', '')}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider font-semibold text-stone mb-0.5">Status</p>
              <p className="text-sm text-ink">
                {fee.evidence ? EVIDENCE_RECORDED_LABELS[eventType] : EVIDENCE_WAITING_LABELS[eventType]}
              </p>
            </div>
          </div>

          {fee.evidence ? (
            <div className="bg-white border border-forest/10 rounded-lg px-4 py-3">
              <p className="text-sm font-medium text-ink">{EVIDENCE_RECORDED_LABELS[eventType]}</p>
              <p className="text-xs text-stone mt-0.5">{fmtEvidenceDate(fee.evidence.occurredAt)}</p>
              <p className="text-xs text-stone mt-2">Waiting for billing execution</p>
            </div>
          ) : (
            <>
              <p className="text-xs text-stone mb-3">
                This fee becomes billable once {EVIDENCE_WAITING_LABELS[eventType].replace('Waiting for ', '').toLowerCase()} is recorded.
              </p>
              {error && <p className="text-xs text-red-600 mb-3">{error}</p>}
              <div className="flex items-center gap-2 flex-wrap">
                <input
                  type="date"
                  value={occurredAt}
                  max={new Date().toISOString().slice(0, 10)}
                  onChange={e => setOccurredAt(e.target.value)}
                  className="text-sm border border-forest/20 rounded-lg px-3 py-2 bg-white text-ink focus:outline-none focus:border-forest/40"
                />
                <button
                  onClick={handleRecord}
                  disabled={recording || !occurredAt || !fee.feeId}
                  className="inline-flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-xl transition-colors disabled:opacity-40"
                  style={{ background: '#1A3D2B', color: '#fff' }}
                >
                  {recording
                    ? <><i className="ti ti-loader-2 animate-spin" style={{ fontSize: 13 }} /> Recording…</>
                    : EVIDENCE_ACTION_LABELS[eventType]
                  }
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// Positively identifies the pre-existing genuine manual quantity/rate
// workflow — never a "not event" catch-all. Requires BOTH:
//   - no Step-12 billability concept resolved (billabilityCondition is
//     null) — an immediate/fixed_date/malformed-or-unrecognized condition
//     is a DEFINED, non-null value and is deliberately excluded here even
//     though it isn't 'event' either;
//   - an actual metric to bill by (metricName present) — the one signal
//     that structurally distinguishes a genuine per-unit professional-
//     services fee from an "unexpected fixed fee" that merely lacks an
//     event condition (a real, but different, gap this card must not
//     silently paper over with a quantity/rate form that makes no sense
//     for a fixed amount).
function isKnownManualQuantityFee(fee: ParkedInvoice): boolean {
  return fee.billabilityCondition == null && fee.metricName != null
}

// ── Unsupported/unrecognized parked configuration — fail-closed. Neither
// an event-gated fixed fee nor the known manual quantity/rate shape (e.g.
// immediate/fixed_date/malformed billability_condition, or a fixed fee
// with no metric and no event condition). No quantity/rate inputs, no
// send/confirm action, no evidence-recording action, no provider call of
// any kind — purely informational, so an unrecognized shape is visible
// rather than silently mishandled.
function UnsupportedParkedFeeRow({ fee }: { fee: ParkedInvoice }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="border border-forest/10 rounded-xl overflow-hidden">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-cream/40 transition-colors"
      >
        <div>
          <p className="text-sm font-medium text-ink">{fee.feeLabel ?? 'Parked fee'}</p>
          {fee.description && (
            <p className="text-xs text-stone mt-0.5 line-clamp-1">{fee.description}</p>
          )}
        </div>
        <div className="flex items-center gap-3 flex-shrink-0 ml-4">
          <span className="text-xs text-stone font-mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {fmt(fee.baseAmount, fee.currency)}
          </span>
          <i className={`ti ${expanded ? 'ti-chevron-up' : 'ti-chevron-down'} text-stone`} style={{ fontSize: 13 }} />
        </div>
      </button>

      {expanded && (
        <div className="border-t border-forest/8 px-5 pb-5 pt-4 bg-cream/20">
          <p className="text-xs text-stone">
            Verdix doesn&apos;t recognize this fee&apos;s billing configuration well enough to offer an action here.
            No invoice can be generated from this card — review the contract terms directly.
          </p>
        </div>
      )}
    </div>
  )
}

export function ParkedInvoicesCard({
  jobId,
  parkedInvoices,
  onEvidenceRecorded,
}: {
  jobId:               string
  parkedInvoices:      ParkedInvoice[]
  // Recording evidence never sends an invoice itself — the caller is
  // expected to re-fetch billing-summary (or equivalent) so the card can
  // move from "waiting" to "evidence recorded" without a full page reload.
  onEvidenceRecorded?: () => void
}) {
  const [generated, setGenerated] = useState<GeneratedEntry[]>([])

  if (parkedInvoices.length === 0) return null

  // Structural branch — never inferred from fee_label/description text, and
  // never a "not event" catch-all. Three positively-identified buckets:
  //   event-gated fixed fee        -> EventGatedFeeRow
  //   known manual quantity/rate   -> ManualQuantityFeeRow (isKnownManualQuantityFee)
  //   anything else (immediate,
  //   fixed_date, malformed/
  //   unrecognized condition, or
  //   an unexpected fixed fee with
  //   no metric and no condition)  -> UnsupportedParkedFeeRow (fail-closed)
  const eventGatedFees  = parkedInvoices.filter(f => f.billabilityCondition?.kind === 'event')
  const manualFees      = parkedInvoices.filter(isKnownManualQuantityFee)
  const unsupportedFees = parkedInvoices.filter(f =>
    f.billabilityCondition?.kind !== 'event' && !isKnownManualQuantityFee(f),
  )

  return (
    <div className="bg-white border border-amber-200 rounded-2xl overflow-hidden">
      {/* Card header */}
      <div className="px-6 py-4 border-b border-amber-100 flex items-center gap-3"
        style={{ background: 'linear-gradient(135deg, #fffbf2 0%, #fff8e8 100%)' }}
      >
        <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
          style={{ background: '#FEF3C7' }}
        >
          <i className="ti ti-clock-pause" style={{ fontSize: 16, color: '#D97706' }} />
        </div>
        <div>
          <p className="text-sm font-semibold text-amber-900">Parked Invoices</p>
          <p className="text-xs text-amber-700 mt-0.5">
            {parkedInvoices.length} parked {parkedInvoices.length === 1 ? 'fee requires' : 'fees require'} action
          </p>
        </div>
      </div>

      {/* Fee rows */}
      <div className="px-5 py-4 space-y-3">
        {eventGatedFees.map(fee => (
          <EventGatedFeeRow
            key={fee.id}
            fee={fee}
            jobId={jobId}
            onRecorded={() => onEvidenceRecorded?.()}
          />
        ))}
        {manualFees.map(fee => (
          <ManualQuantityFeeRow
            key={fee.id}
            fee={fee}
            jobId={jobId}
            onGenerated={entry => setGenerated(prev => [entry, ...prev])}
          />
        ))}
        {unsupportedFees.map(fee => (
          <UnsupportedParkedFeeRow key={fee.id} fee={fee} />
        ))}
      </div>

      {/* Generated invoice history — manual/quantity-rate fees only */}
      {generated.length > 0 && (
        <div className="border-t border-forest/8 px-5 py-4">
          <p className="text-[10px] uppercase tracking-wider font-semibold text-stone mb-3">
            Invoices sent this session
          </p>
          <div className="space-y-2">
            {generated.map((g, i) => (
              <div key={i} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <i className="ti ti-check text-forest" style={{ fontSize: 13 }} />
                  <span className="text-ink font-mono text-xs">{g.invoiceId}</span>
                  <span className="text-stone text-xs">{g.label}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs font-semibold text-ink">
                    {fmt(g.amount, 'EUR')}
                  </span>
                  {g.hostedUrl && (
                    <a
                      href={g.hostedUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-forest hover:underline"
                    >
                      View →
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Footer copy only applies to the manual/quantity-rate workflow —
          an event-gated fee never "creates a separate invoice per
          confirmed delivery"; suppressed entirely once no manual fee is
          present. */}
      {manualFees.length > 0 && (
        <div className="px-5 pb-4">
          <p className="text-[10px] text-stone">
            Each confirmed delivery creates a separate Stripe invoice. The fee template stays parked so you can generate invoices for future deliveries.
          </p>
        </div>
      )}
    </div>
  )
}
