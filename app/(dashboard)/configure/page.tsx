import Link from 'next/link'
import { redirect } from 'next/navigation'
import { supabaseServer } from '@/lib/supabase'
import { getActiveOrg } from '@/lib/org'
import { getContractSummaries } from '@/lib/contract-tcv'
import { DeleteJobButton } from '@/components/dashboard/DeleteJobButton'

async function getJobs(orgId: string) {
  const { data } = await supabaseServer
    .from('jobs')
    .select('id, name, execute_status, currency, created_at, contract_terms_id, billing_platform')
    .eq('module', 'AUTO_CONFIGURE')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
  return data ?? []
}

function fmtTcv(n: number, cur: string) {
  if (n <= 0) return '—'
  return new Intl.NumberFormat('en-US', {
    style:                 'currency',
    currency:              cur,
    maximumFractionDigits: 0,
  }).format(n)
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

const PLATFORM_STYLE: Record<string, { label: string; bg: string; color: string }> = {
  stripe:    { label: 'Stripe',    bg: '#EEF2FF', color: '#4338CA' },
  remembill: { label: 'Remembill', bg: '#ECFDF5', color: '#065F46' },
  chargebee: { label: 'Chargebee', bg: '#FFF7ED', color: '#C2410C' },
}

const STATUS_STYLE: Record<string, { color: string; label: string }> = {
  COMPLETED:            { color: '#4A7C59', label: 'Configured' },
  READY_TO_APPROVE:     { color: '#4A7C59', label: 'Ready to approve' },
  PENDING_HUMAN_REVIEW: { color: '#D97706', label: 'Needs review' },
  PENDING_PII_REVIEW:   { color: '#7C3AED', label: 'PII review' },
  DETECTING_PII:        { color: '#2563EB', label: 'Detecting PII…' },
  EXTRACTING:           { color: '#2563EB', label: 'Extracting…' },
  FAILED:               { color: '#DC2626', label: 'Failed' },
  PENDING:              { color: '#9CA3AF', label: 'Pending' },
}

export default async function ConfigureListPage() {
  const org = await getActiveOrg()
  if (!org) redirect('/login')
  const jobs = await getJobs(org.orgId)
  const contractSummaries = await getContractSummaries(jobs.map(j => j.id))

  // Per-currency totals — a direct sum of the same per-row values shown in
  // the table below, so this can be cross-checked against the Agreements
  // dashboard's aggregate KPIs at a glance.
  const totalsByCurrency: Record<string, { tcv: number; committedContractValue: number; count: number }> = {}
  for (const job of jobs) {
    const summary = contractSummaries[job.id]
    if (!summary) continue
    const cur = summary.currency
    totalsByCurrency[cur] ??= { tcv: 0, committedContractValue: 0, count: 0 }
    totalsByCurrency[cur].tcv += summary.tcv
    totalsByCurrency[cur].committedContractValue += summary.committedContractValue
    totalsByCurrency[cur].count += 1
  }
  const currencies = Object.keys(totalsByCurrency).sort((a, b) => totalsByCurrency[b].count - totalsByCurrency[a].count)

  return (
    <div className="p-4 md:p-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-8">
        <div>
          <h1 className="font-display font-light text-ink text-2xl mb-1">New contracts</h1>
          <p className="text-stone text-sm">Auto-configure billing from signed contracts</p>
        </div>
        <Link href="/configure/new" className="flex items-center gap-2 text-forest text-sm font-medium hover:opacity-70 transition-opacity self-start sm:self-auto">
          <i className="ti ti-file-invoice" style={{ fontSize: 16 }} /> Upload contract
        </Link>
      </div>

      {currencies.length > 0 && (
        <div className={`grid gap-4 mb-6 ${currencies.length > 1 ? 'sm:grid-cols-2' : 'sm:grid-cols-1'}`}>
          {currencies.map(cur => {
            const t = totalsByCurrency[cur]
            return (
              <div key={cur} className="bg-white border border-forest/10 rounded-2xl p-4 flex items-center gap-6">
                <span className="text-xs font-semibold text-stone uppercase tracking-widest">{cur} <span className="text-stone/50 normal-case">({t.count})</span></span>
                <div className="flex-1 grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-[10px] font-semibold text-stone uppercase tracking-widest mb-0.5">Fixed fees</p>
                    <p className="text-base font-semibold font-mono text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtTcv(t.tcv, cur)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold text-stone uppercase tracking-widest mb-0.5">Committed contract value</p>
                    <p className="text-base font-semibold font-mono" style={{ color: '#0B5C36', fontVariantNumeric: 'tabular-nums' }}>{fmtTcv(t.committedContractValue, cur)}</p>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden">
        <div className="px-6 py-4 border-b border-forest/8 flex items-center justify-between">
          <span className="text-sm font-medium text-ink">All contracts</span>
          <span className="text-xs text-stone">{jobs.length} job{jobs.length !== 1 ? 's' : ''}</span>
        </div>
        <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-forest/8">
              {['Contract name', 'Customer', 'Fixed fees', 'Committed contract value', 'Status', 'Billing', 'Date', '', ''].map(h => (
                <th key={h} className="px-4 py-3 text-left text-[10px] font-semibold text-stone uppercase tracking-wider">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {jobs.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-6 py-12 text-center">
                  <div className="max-w-sm mx-auto">
                    <div className="w-12 h-12 rounded-2xl bg-blue-50 flex items-center justify-center mx-auto mb-4">
                      <i className="ti ti-bolt" style={{ fontSize: 22, color: '#2563EB' }} />
                    </div>
                    <p className="text-sm font-semibold text-ink mb-1.5">No contracts yet</p>
                    <p className="text-sm text-stone leading-relaxed mb-5">
                      Upload a customer contract as a PDF. Verdix extracts the billing terms automatically
                      — fees, overages, escalators, and payment schedule — ready for your billing system.
                    </p>
                    <Link
                      href="/configure/new"
                      className="inline-flex items-center gap-2 bg-forest text-white text-sm font-medium px-5 py-2.5 rounded-xl hover:bg-sage transition-colors"
                    >
                      <i className="ti ti-upload" style={{ fontSize: 14 }} /> Upload your first contract
                    </Link>
                  </div>
                </td>
              </tr>
            ) : jobs.map(job => {
              const s       = STATUS_STYLE[job.execute_status] ?? STATUS_STYLE.PENDING
              const summary = contractSummaries[job.id]
              return (
                <tr key={job.id} className="border-b border-forest/6 last:border-0 hover:bg-cream/40 transition-colors">
                  <td className="px-4 py-3">
                    <Link href={`/configure/${job.id}`} className="text-sm font-medium text-ink hover:text-forest transition-colors">
                      {job.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-sm text-stone">
                    {summary?.customer_name ?? '—'}
                  </td>
                  <td className="px-4 py-3 font-mono text-sm font-semibold text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {summary ? fmtTcv(summary.tcv, summary.currency) : '—'}
                  </td>
                  <td className="px-4 py-3 font-mono text-sm font-semibold text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {summary ? fmtTcv(summary.committedContractValue, summary.currency) : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs font-medium" style={{ color: s.color }}>{s.label}</span>
                  </td>
                  <td className="px-4 py-3">
                    {(() => {
                      const p = PLATFORM_STYLE[(job.billing_platform as string | null) ?? '']
                      return p
                        ? <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full" style={{ background: p.bg, color: p.color }}>{p.label}</span>
                        : <span className="text-xs text-stone/40">—</span>
                    })()}
                  </td>
                  <td className="px-4 py-3 text-xs text-stone">{timeAgo(job.created_at)}</td>
                  <td className="px-4 py-3">
                    <Link
                      href={job.execute_status === 'PENDING_PII_REVIEW' ? `/configure/${job.id}/pii-review` : `/configure/${job.id}`}
                      className="text-xs text-forest hover:underline"
                    >
                      {job.execute_status === 'PENDING_PII_REVIEW' ? 'Review PII →' : 'View →'}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <DeleteJobButton jobId={job.id} label="contract" isConfigured={job.execute_status === 'COMPLETED'} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  )
}
