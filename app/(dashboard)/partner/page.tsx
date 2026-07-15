import Link from 'next/link'
import { redirect } from 'next/navigation'
import { supabaseServer } from '@/lib/supabase'
import { getActiveOrg } from '@/lib/org'
import { DeleteJobButton } from '@/components/dashboard/DeleteJobButton'

async function getJobs(orgId: string) {
  const { data } = await supabaseServer
    .from('jobs')
    .select('id, name, execute_status, total_leakage, findings_count, currency, created_at, partner_invoices ( partner_name )')
    .eq('module', 'PARTNER_RECON')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
  return data ?? []
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function fmt(n: number, cur = 'EUR') {
  return new Intl.NumberFormat('en-IE', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(n)
}

const STATUS_STYLE: Record<string, { color: string; label: string }> = {
  COMPLETED:  { color: '#4A7C59', label: 'Completed' },
  PROCESSING: { color: '#D97706', label: 'Processing' },
  EXTRACTING: { color: '#2563EB', label: 'Extracting…' },
  FAILED:     { color: '#DC2626', label: 'Failed' },
  PENDING:    { color: '#9CA3AF', label: 'Pending' },
}

export default async function PartnerListPage() {
  const org = await getActiveOrg()
  if (!org) redirect('/login')
  const jobs = await getJobs(org.orgId)

  return (
    <div className="p-4 md:p-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-8">
        <div>
          <h1 className="font-display font-light text-ink text-2xl mb-1">Partner checks</h1>
          <p className="text-stone text-sm">Validate partner invoices against signed agreements</p>
        </div>
        <Link href="/partner/new" className="flex items-center gap-2 bg-forest text-white text-sm font-medium px-5 py-2.5 rounded-xl hover:bg-sage transition-colors shadow-sm self-start sm:self-auto">
          <i className="ti ti-plus" style={{ fontSize: 14 }} /> New reconciliation
        </Link>
      </div>

      <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden">
        <div className="px-6 py-4 border-b border-forest/8 flex items-center justify-between">
          <span className="text-sm font-medium text-ink">All partner checks</span>
          <span className="text-xs text-stone">{jobs.length} job{jobs.length !== 1 ? 's' : ''}</span>
        </div>

        <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-forest/8">
              {['Partner', 'Discrepancy', 'Findings', 'Status', 'Date', '', ''].map(h => (
                <th key={h} className="px-4 py-3 text-left text-[10px] font-semibold text-stone uppercase tracking-wider">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {jobs.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-6 py-12 text-center">
                  <div className="max-w-sm mx-auto">
                    <div className="w-12 h-12 rounded-2xl bg-purple-50 flex items-center justify-center mx-auto mb-4">
                      <i className="ti ti-receipt" style={{ fontSize: 22, color: '#7C3AED' }} />
                    </div>
                    <p className="text-sm font-semibold text-ink mb-1.5">No partner checks yet</p>
                    <p className="text-sm text-stone leading-relaxed mb-5">
                      Upload a partner or supplier invoice alongside your signed agreement. Verdix
                      identifies overcharges and discrepancies before you approve payment.
                    </p>
                    <Link
                      href="/partner/new"
                      className="inline-flex items-center gap-2 bg-forest text-white text-sm font-medium px-5 py-2.5 rounded-xl hover:bg-sage transition-colors"
                    >
                      <i className="ti ti-receipt" style={{ fontSize: 14 }} /> Run your first check
                    </Link>
                  </div>
                </td>
              </tr>
            ) : jobs.map(job => {
              const s = STATUS_STYLE[job.execute_status] ?? STATUS_STYLE.PENDING
              return (
                <tr key={job.id} className="border-b border-forest/6 last:border-0 hover:bg-cream/40 transition-colors">
                  <td className="px-4 py-3">
                    <Link href={`/partner/${job.id}`} className="text-sm font-medium text-ink hover:text-forest transition-colors">
                      {(job.partner_invoices as Array<{ partner_name: string }>)?.[0]?.partner_name ?? job.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 font-mono text-sm font-semibold" style={{ color: (job.total_leakage ?? 0) > 0 ? '#DC2626' : '#9CA3AF' }}>
                    {(job.total_leakage ?? 0) > 0 ? fmt(job.total_leakage, job.currency ?? 'EUR') : '—'}
                  </td>
                  <td className="px-4 py-3 text-sm text-stone">{job.findings_count ?? 0}</td>
                  <td className="px-4 py-3">
                    <span className="text-xs font-medium" style={{ color: s.color }}>{s.label}</span>
                  </td>
                  <td className="px-4 py-3 text-xs text-stone">{timeAgo(job.created_at)}</td>
                  <td className="px-4 py-3">
                    <Link href={`/partner/${job.id}`} className="text-xs text-forest hover:underline">
                      View →
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <DeleteJobButton jobId={job.id} label="partner check" />
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
