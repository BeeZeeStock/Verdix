'use client'

import { useState, useEffect, use, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import Link from 'next/link'

type PartnerFinding = {
  id: string
  finding_type: string
  description: string
  agreed_amount: number
  billed_amount: number
  discrepancy: number
  evidence: string
  status: string
}

type PartnerInvoice = {
  id: string
  invoice_reference: string
  partner_name: string
  invoice_date: string | null
  invoice_amount: number
  currency: string
  status: string
  dispute_amount: number
}

type Job = {
  id: string
  name: string
  execute_status: string
  currency: string
  error_message?: string | null
  partner_invoices?: PartnerInvoice[]
  partner_findings?: PartnerFinding[]
}

const FINDING_META: Record<string, { label: string; color: string; bg: string }> = {
  WRONG_RATE:       { label: 'Wrong rate',       color: '#7F1D1D', bg: '#FEE2E2' },
  WAIVED_FEE:       { label: 'Waived fee',        color: '#78350F', bg: '#FEF3C7' },
  DUPLICATE_CHARGE: { label: 'Duplicate charge',  color: '#4C1D95', bg: '#EDE9FE' },
  EXPIRED_RATE:     { label: 'Expired rate',      color: '#1E3A8A', bg: '#DBEAFE' },
  INCORRECT_CALC:   { label: 'Arithmetic error',  color: '#7F1D1D', bg: '#FEE2E2' },
}

function fmt(n: number, cur = 'EUR') {
  return new Intl.NumberFormat('en-IE', { style: 'currency', currency: cur, minimumFractionDigits: 2 }).format(n)
}

function buildDisputeLetter(
  job: Job,
  invoice: PartnerInvoice,
  findings: PartnerFinding[],
  disputed: Set<string>,
  senderName: string
): string {
  const items = findings.filter(f => disputed.has(f.id))
  const total = items.reduce((s, f) => s + f.discrepancy, 0)
  const today = new Date().toLocaleDateString('en-IE', { day: 'numeric', month: 'long', year: 'numeric' })

  const lines = [
    today, '',
    `Re: Formal Dispute — Invoice ${invoice.invoice_reference}`, '',
    `Dear ${invoice.partner_name} Finance Team,`, '',
    `We are writing to formally dispute invoice ${invoice.invoice_reference}${invoice.invoice_date ? ` dated ${invoice.invoice_date}` : ''}.`,
    `Our review has identified ${items.length} discrepanc${items.length === 1 ? 'y' : 'ies'} totalling ${fmt(total, invoice.currency)} between the invoice and our signed agreement.`,
    '', 'DISPUTED LINE ITEMS', '─'.repeat(60),
    ...items.flatMap((f, i) => [
      '', `${i + 1}. ${FINDING_META[f.finding_type]?.label ?? f.finding_type}`,
      `   Description : ${f.description}`,
      `   Agreed      : ${fmt(f.agreed_amount, invoice.currency)}`,
      `   Billed      : ${fmt(f.billed_amount, invoice.currency)}`,
      `   Discrepancy : ${fmt(f.discrepancy, invoice.currency)}`,
      ...(f.evidence ? [`   Contract ref: ${f.evidence}`] : []),
    ]),
    '', '─'.repeat(60),
    `Total disputed amount: ${fmt(total, invoice.currency)}`, '',
    `We request a corrected invoice reflecting the agreed terms. Please respond within 14 days.`,
    '', 'Regards,',
    senderName,
  ]
  return lines.join('\n')
}

export default function PartnerResultsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [job, setJob] = useState<Job | null>(null)
  const [disputed, setDisputed] = useState<Set<string>>(new Set())
  const [accepted, setAccepted] = useState<Set<string>>(new Set())
  const [showLetter, setShowLetter] = useState(false)
  const [copied, setCopied] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [reanalyzing, setReanalyzing] = useState(false)
  const { data: session } = useSession()
  const senderName = session?.user?.name ?? session?.user?.email ?? 'Finance Team'

  const fetchJob = useCallback(async () => {
    const res = await fetch(`/api/jobs/${id}`)
    const data: Job = await res.json()
    setJob(data)
    return data
  }, [id])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>

    async function init() {
      const data = await fetchJob()

      if (data.execute_status === 'PENDING') {
        await fetch(`/api/jobs/${id}/partner-recon`, { method: 'POST' })
      }

      const needsPoll = (s: string) => s === 'PENDING' || s === 'PROCESSING' || s === 'EXTRACTING'

      if (needsPoll(data.execute_status)) {
        const poll = async () => {
          if (cancelled) return
          const refreshed = await fetchJob()
          if (needsPoll(refreshed.execute_status)) {
            timer = setTimeout(poll, 3000)
          } else if (refreshed.execute_status === 'COMPLETED' && !refreshed.partner_findings?.length && !refreshed.partner_invoices?.length) {
            // Race: status flipped but findings not yet visible — retry once
            timer = setTimeout(async () => { if (!cancelled) await fetchJob() }, 2000)
          }
        }
        timer = setTimeout(poll, 3000)
      } else if (data.execute_status === 'COMPLETED' && !data.partner_invoices?.length) {
        // Arrived at a COMPLETED job but invoice join is empty — refresh once
        timer = setTimeout(async () => { if (!cancelled) await fetchJob() }, 1500)
      }
    }

    init()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [id, fetchJob])

  const invoice = job?.partner_invoices?.[0]
  const findings = job?.partner_findings ?? []
  const cur = invoice?.currency ?? job?.currency ?? 'EUR'
  const totalDiscrepancy = findings.reduce((s, f) => s + f.discrepancy, 0)
  const disputeTotal = findings.filter(f => disputed.has(f.id)).reduce((s, f) => s + f.discrepancy, 0)

  const isProcessing = !job
    || job.execute_status === 'PENDING'
    || job.execute_status === 'PROCESSING'
    || job.execute_status === 'EXTRACTING'

  const toggleDisputed = (fid: string) =>
    setDisputed(s => { const n = new Set(s); if (n.has(fid)) { n.delete(fid) } else { n.add(fid) }; return n })

  const toggleAccepted = (fid: string) =>
    setAccepted(s => { const n = new Set(s); if (n.has(fid)) { n.delete(fid) } else { n.add(fid) }; return n })

  // ── Processing / Loading ────────────────────────────────────────────────────
  if (isProcessing) {
    return (
      <div className="p-8">
        <Link href="/partner" className="text-sm text-stone hover:text-forest flex items-center gap-1 mb-6">
          <i className="ti ti-arrow-left" style={{ fontSize: 13 }} /> Partner checks
        </Link>
        <div className="bg-white border border-forest/10 rounded-2xl p-16 text-center max-w-lg mx-auto">
          <div className="w-12 h-12 border-2 border-forest border-t-transparent rounded-full animate-spin mx-auto mb-6" />
          <h2 className="font-display font-light text-ink text-xl mb-2">{job?.name ?? 'Loading…'}</h2>
          <p className="text-stone text-sm">
            {!job ? 'Loading…'
              : job.execute_status === 'EXTRACTING' ? 'Extracting agreement terms from PDF…'
              : 'Comparing invoice against agreement…'}
          </p>
          <p className="text-xs text-stone/50 mt-2">Usually 30–60 seconds</p>
        </div>
      </div>
    )
  }

  // ── Failed ──────────────────────────────────────────────────────────────────
  if (job.execute_status === 'FAILED') {
    const retry = async () => {
      setRetrying(true)
      await fetch(`/api/jobs/${id}/partner-recon`, { method: 'POST' })
      const poll = async () => {
        const r = await fetchJob()
        if (r.execute_status === 'PROCESSING' || r.execute_status === 'EXTRACTING') {
          setTimeout(poll, 3000)
        } else {
          setRetrying(false)
        }
      }
      setTimeout(poll, 3000)
    }

    return (
      <div className="p-8">
        <Link href="/partner" className="text-sm text-stone hover:text-forest flex items-center gap-1 mb-6">
          <i className="ti ti-arrow-left" style={{ fontSize: 13 }} /> Partner checks
        </Link>
        <div className="bg-white border border-forest/10 rounded-2xl p-12 text-center max-w-lg mx-auto">
          {retrying ? (
            <><div className="w-10 h-10 border-2 border-forest border-t-transparent rounded-full animate-spin mx-auto mb-4" /><p className="text-stone text-sm">Retrying…</p></>
          ) : (
            <>
              <i className="ti ti-circle-x block mb-4" style={{ fontSize: 36, color: '#DC2626' }} />
              <h2 className="font-medium text-ink mb-2">Reconciliation failed</h2>
              {job.error_message && (
                <pre className="text-xs text-stone/70 bg-cream rounded-lg px-4 py-2 mx-auto max-w-sm mt-2 mb-4 text-left whitespace-pre-wrap">{job.error_message}</pre>
              )}
              <p className="text-stone text-sm mb-4">Check your agreement PDF and invoice, then retry.</p>
              <button onClick={retry} className="bg-forest text-white text-sm font-medium px-5 py-2.5 rounded-xl hover:bg-sage transition-colors">
                Retry reconciliation →
              </button>
            </>
          )}
        </div>
      </div>
    )
  }

  // ── Results ─────────────────────────────────────────────────────────────────
  const verified = findings.length === 0

  const reanalyze = async () => {
    setReanalyzing(true)
    await fetch(`/api/jobs/${id}/partner-recon`, { method: 'POST' })
    const poll = async () => {
      const r = await fetchJob()
      if (r.execute_status === 'PROCESSING' || r.execute_status === 'EXTRACTING') {
        setTimeout(poll, 3000)
      } else {
        setReanalyzing(false)
      }
    }
    setTimeout(poll, 3000)
  }

  if (reanalyzing) {
    return (
      <div className="p-8">
        <Link href="/partner" className="text-sm text-stone hover:text-forest flex items-center gap-1 mb-6">
          <i className="ti ti-arrow-left" style={{ fontSize: 13 }} /> Partner checks
        </Link>
        <div className="bg-white border border-forest/10 rounded-2xl p-16 text-center max-w-lg mx-auto">
          <div className="w-12 h-12 border-2 border-forest border-t-transparent rounded-full animate-spin mx-auto mb-6" />
          <h2 className="font-display font-light text-ink text-xl mb-2">Re-analyzing…</h2>
          <p className="text-stone text-sm">Comparing invoice against agreement</p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 md:p-8 space-y-6">
      {/* Breadcrumb + title */}
      <div>
        <Link href="/partner" className="text-sm text-stone hover:text-forest flex items-center gap-1 mb-2">
          <i className="ti ti-arrow-left" style={{ fontSize: 13 }} /> Partner checks
        </Link>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="font-display font-light text-ink text-2xl">{job.name}</h1>
            {invoice && (
              <p className="text-stone text-sm mt-0.5">
                {invoice.partner_name} · {invoice.invoice_reference}
                {invoice.invoice_date ? ` · ${new Date(invoice.invoice_date).toLocaleDateString('en-IE', { month: 'long', year: 'numeric' })}` : ''}
              </p>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1">
            {verified ? (
              <span className="flex items-center gap-1.5 text-sm font-medium" style={{ color: '#4A7C59' }}>
                <i className="ti ti-circle-check" style={{ fontSize: 16 }} /> Invoice verified
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-sm font-medium" style={{ color: '#A32D2D' }}>
                <i className="ti ti-alert-circle" style={{ fontSize: 16 }} /> {findings.length} discrepanc{findings.length === 1 ? 'y' : 'ies'} found
              </span>
            )}
            <button
              onClick={reanalyze}
              className="flex items-center gap-1 text-xs text-stone border border-forest/15 px-2.5 py-1.5 rounded-lg hover:bg-cream hover:text-forest transition-colors"
            >
              <i className="ti ti-refresh" style={{ fontSize: 11 }} /> Re-analyze
            </button>
          </div>
        </div>
      </div>

      {/* Overview cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white border border-forest/10 rounded-2xl p-5">
          <div className="text-[10px] font-semibold text-stone uppercase tracking-widest mb-3">Invoice</div>
          <div className="font-mono text-2xl font-medium text-ink mb-1">{invoice ? fmt(invoice.invoice_amount, cur) : '—'}</div>
          <div className="text-xs text-stone">{invoice?.invoice_reference ?? '—'}</div>
          {invoice?.invoice_date && <div className="text-xs text-stone/60 mt-0.5">{invoice.invoice_date}</div>}
        </div>
        <div className="bg-white border border-forest/10 rounded-2xl p-5">
          <div className="text-[10px] font-semibold text-stone uppercase tracking-widest mb-3">Discrepancy</div>
          <div className="font-mono text-2xl font-semibold mb-1" style={{ color: verified ? '#4A7C59' : '#A32D2D' }}>
            {verified ? fmt(0, cur) : fmt(totalDiscrepancy, cur)}
          </div>
          <div className="text-xs text-stone">{verified ? 'No overbilling detected' : `Across ${findings.length} line item${findings.length !== 1 ? 's' : ''}`}</div>
        </div>
        <div className="bg-white border border-forest/10 rounded-2xl p-5">
          <div className="text-[10px] font-semibold text-stone uppercase tracking-widest mb-3">Partner</div>
          <div className="text-sm font-medium text-ink mb-1">{invoice?.partner_name ?? '—'}</div>
          <div className="text-xs" style={{ color: verified ? '#4A7C59' : '#A32D2D' }}>
            {verified ? 'No action required' : 'Action required'}
          </div>
        </div>
      </div>

      {/* Main content */}
      {verified ? (
        <div className="bg-white border border-forest/10 rounded-2xl p-12 text-center">
          <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-4" style={{ background: '#EAF3DE' }}>
            <i className="ti ti-circle-check" style={{ fontSize: 28, color: '#4A7C59' }} />
          </div>
          <h2 className="font-display font-light text-ink text-xl mb-2">Invoice matches agreement</h2>
          <p className="text-stone text-sm max-w-sm mx-auto">
            All line items are consistent with the signed partner agreement. No disputes required.
          </p>
          <button className="mt-6 bg-forest text-white text-sm font-medium px-5 py-2.5 rounded-xl hover:bg-sage transition-colors">
            Approve invoice →
          </button>
        </div>
      ) : (
        <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden">
          {/* Table header */}
          <div className="px-6 py-4 border-b border-forest/8 flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-ink">Discrepancies found</div>
              <div className="text-xs text-stone mt-0.5">Select findings to include in a dispute letter</div>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setDisputed(new Set(findings.map(f => f.id)))}
                className="text-xs text-forest hover:underline"
              >
                Select all
              </button>
              <span className="text-xs text-stone/40">|</span>
              <button
                onClick={() => setDisputed(new Set())}
                className="text-xs text-stone hover:underline"
              >
                Clear
              </button>
            </div>
          </div>

          {/* Findings table */}
          <div className="overflow-x-auto"><table className="w-full">
            <thead>
              <tr className="border-b border-forest/8">
                {['', 'Type', 'Description', 'Agreed', 'Billed', 'Discrepancy', 'Action'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-[10px] font-semibold text-stone uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {findings.map(f => {
                const meta = FINDING_META[f.finding_type] ?? { label: f.finding_type, color: '#6B6660', bg: '#F5F3EE' }
                const isDisputed = disputed.has(f.id)
                const isAccepted = accepted.has(f.id)
                return (
                  <tr
                    key={f.id}
                    className="border-b border-forest/6 last:border-0 transition-colors"
                    style={{ background: isDisputed ? 'rgba(163,45,45,0.03)' : isAccepted ? 'rgba(74,124,89,0.03)' : undefined }}
                  >
                    <td className="px-4 py-4 w-10">
                      <input
                        type="checkbox"
                        checked={isDisputed}
                        style={{ accentColor: '#1A3D2B' }}
                        onChange={() => toggleDisputed(f.id)}
                      />
                    </td>
                    <td className="px-4 py-4 whitespace-nowrap">
                      <span className="text-xs font-semibold" style={{ color: meta.color }}>
                        {meta.label}
                      </span>
                    </td>
                    <td className="px-4 py-4 max-w-xs">
                      <div className="text-sm text-ink leading-snug">{f.description}</div>
                      {f.evidence && (
                        <div className="text-xs text-stone/50 mt-1">{f.evidence}</div>
                      )}
                    </td>
                    <td className="px-4 py-4 font-mono text-sm text-forest whitespace-nowrap">
                      {fmt(f.agreed_amount, cur)}
                    </td>
                    <td className="px-4 py-4 font-mono text-sm text-stone whitespace-nowrap" style={{ textDecoration: 'line-through' }}>
                      {fmt(f.billed_amount, cur)}
                    </td>
                    <td className="px-4 py-4 font-mono text-sm font-semibold whitespace-nowrap" style={{ color: '#A32D2D' }}>
                      –{fmt(f.discrepancy, cur)}
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex gap-2">
                        <button
                          onClick={() => { toggleAccepted(f.id); setDisputed(s => { const n = new Set(s); n.delete(f.id); return n }) }}
                          className="text-xs px-2.5 py-1 rounded-lg transition-colors"
                          style={{ background: isAccepted ? '#EAF3DE' : '#F5F3EE', color: isAccepted ? '#27500A' : '#6B6660' }}
                        >
                          {isAccepted ? '✓ Accepted' : 'Accept'}
                        </button>
                        <button
                          onClick={() => { toggleDisputed(f.id); setAccepted(s => { const n = new Set(s); n.delete(f.id); return n }) }}
                          className="text-xs px-2.5 py-1 rounded-lg transition-colors"
                          style={{ background: isDisputed ? '#FCEBEB' : '#F5F3EE', color: isDisputed ? '#791F1F' : '#6B6660' }}
                        >
                          {isDisputed ? '⚑ Disputed' : 'Dispute'}
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table></div>

          {/* Dispute action bar */}
          <div
            className="px-6 py-4 border-t border-forest/8 flex items-center justify-between transition-colors"
            style={{ background: disputed.size > 0 ? '#1A3D2B' : '#FAFAF8' }}
          >
            {disputed.size > 0 ? (
              <>
                <div className="text-sm" style={{ color: '#D4EAD9' }}>
                  <span className="font-mono font-medium text-white">{fmt(disputeTotal, cur)}</span>
                  <span className="ml-2 text-sm">{disputed.size} finding{disputed.size !== 1 ? 's' : ''} selected</span>
                </div>
                <button
                  onClick={() => setShowLetter(true)}
                  className="flex items-center gap-1.5 bg-white text-forest text-sm font-medium px-5 py-2 rounded-lg hover:bg-mint transition-colors"
                >
                  <i className="ti ti-file-text" style={{ fontSize: 14 }} /> Generate dispute letter
                </button>
              </>
            ) : (
              <p className="text-xs text-stone">Check findings above to generate a dispute letter</p>
            )}
          </div>
        </div>
      )}

      {/* Summary: what was analyzed */}
      <div className="bg-white border border-forest/10 rounded-2xl p-5">
        <div className="text-[10px] font-semibold text-stone uppercase tracking-widest mb-3">Analysis summary</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 text-sm">
          <div className="space-y-1.5">
            <div className="text-xs font-medium text-stone uppercase tracking-widest mb-2">Agreement</div>
            <div className="flex justify-between">
              <span className="text-stone">Partner</span>
              <span className="text-ink font-medium">{invoice?.partner_name ?? '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-stone">Agreement loaded</span>
              <span className="text-ink">Yes</span>
            </div>
            <div className="flex justify-between">
              <span className="text-stone">Clauses checked</span>
              <span className="text-ink">Fee schedule, waivers, rates</span>
            </div>
          </div>
          <div className="space-y-1.5">
            <div className="text-xs font-medium text-stone uppercase tracking-widest mb-2">Invoice</div>
            <div className="flex justify-between">
              <span className="text-stone">Reference</span>
              <span className="text-ink font-medium">{invoice?.invoice_reference ?? '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-stone">Total invoiced</span>
              <span className="text-ink font-medium">{invoice ? fmt(invoice.invoice_amount, cur) : '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-stone">Discrepancies</span>
              <span className="font-semibold" style={{ color: verified ? '#4A7C59' : '#A32D2D' }}>
                {verified ? 'None — invoice correct' : `${findings.length} found · ${fmt(totalDiscrepancy, cur)} overbilled`}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Dispute letter modal */}
      {showLetter && invoice && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.45)' }}
          onClick={() => setShowLetter(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="px-6 py-5 border-b border-forest/10 flex items-center justify-between">
              <div>
                <div className="font-medium text-ink">Dispute letter</div>
                <div className="text-xs text-stone mt-0.5">
                  {invoice.invoice_reference} · {fmt(disputeTotal, cur)} disputed
                </div>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(buildDisputeLetter(job, invoice, findings, disputed, senderName))
                    setCopied(true)
                    setTimeout(() => setCopied(false), 2000)
                  }}
                  className="flex items-center gap-1.5 text-sm text-forest hover:underline"
                >
                  <i className="ti ti-copy" style={{ fontSize: 14 }} />
                  {copied ? 'Copied!' : 'Copy'}
                </button>
                <button onClick={() => setShowLetter(false)} className="text-stone hover:text-ink">
                  <i className="ti ti-x" style={{ fontSize: 16 }} />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              <pre className="text-sm text-ink whitespace-pre-wrap leading-relaxed" style={{ fontFamily: 'ui-monospace, monospace' }}>
                {buildDisputeLetter(job, invoice, findings, disputed, senderName)}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
