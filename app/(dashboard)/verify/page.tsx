import Link from 'next/link'
import { redirect } from 'next/navigation'
import { supabaseServer } from '@/lib/supabase'
import { getActiveOrg } from '@/lib/org'
import { DeleteJobButton } from '@/components/dashboard/DeleteJobButton'

async function getJobs(orgId: string) {
  const { data } = await supabaseServer
    .from('jobs')
    .select('id, name, status, execute_status, total_leakage, findings_count, currency, created_at')
    .eq('module', 'BILLING_VERIFICATION')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
  return data ?? []
}

function fmt(n: number, cur = 'EUR') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(n)
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

const STATUS_STYLE: Record<string, { color: string; label: string }> = {
  COMPLETED:  { color: '#4A7C59', label: 'Completed' },
  PROCESSING: { color: '#D97706', label: 'Processing' },
  FAILED:     { color: '#DC2626', label: 'Failed' },
  PENDING:    { color: '#9CA3AF', label: 'Pending' },
}

export default async function VerifyListPage() {
  const org = await getActiveOrg()
  if (!org) redirect('/login')
  const jobs = await getJobs(org.orgId)

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="font-display font-light text-ink text-2xl mb-1">Billing checks</h1>
          <p className="text-stone text-sm">Verify your billing matches your signed contracts</p>
        </div>
        <Link href="/verify/new" className="flex items-center gap-2 bg-forest text-white text-sm font-medium px-5 py-2.5 rounded-xl hover:bg-sage transition-colors shadow-sm">
          <i className="ti ti-plus" style={{ fontSize: 14 }} /> New verification
        </Link>
      </div>

      <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden">
        <div className="px-6 py-4 border-b border-forest/8 flex items-center justify-between">
          <span className="text-sm font-medium text-ink">All audits</span>
          <span className="text-xs text-stone">{jobs.length} job{jobs.length !== 1 ? 's' : ''}</span>
        </div>
        <table className="w-full">
          <thead>
            <tr className="border-b border-forest/8">
              {['Name', 'Leakage found', 'Findings', 'Status', 'Date', '', ''].map(h => (
                <th key={h} className="px-4 py-3 text-left text-[10px] font-semibold text-stone uppercase tracking-wider">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {jobs.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-6 py-12 text-center">
                  <div className="max-w-sm mx-auto">
                    <div className="w-12 h-12 rounded-2xl bg-amber-50 flex items-center justify-center mx-auto mb-4">
                      <i className="ti ti-file-check" style={{ fontSize: 22, color: '#D97706' }} />
                    </div>
                    <p className="text-sm font-semibold text-ink mb-1.5">No billing checks yet</p>
                    <p className="text-sm text-stone leading-relaxed mb-5">
                      Upload a customer invoice and the matching contract. Verdix compares them line by
                      line and flags any billing discrepancies so you can recover the difference.
                    </p>
                    <Link
                      href="/verify/new"
                      className="inline-flex items-center gap-2 bg-forest text-white text-sm font-medium px-5 py-2.5 rounded-xl hover:bg-sage transition-colors"
                    >
                      <i className="ti ti-search" style={{ fontSize: 14 }} /> Start your first audit
                    </Link>
                  </div>
                </td>
              </tr>
            ) : jobs.map(job => {
              const s = STATUS_STYLE[job.execute_status] ?? STATUS_STYLE[job.status] ?? STATUS_STYLE.PENDING
              return (
                <tr key={job.id} className="border-b border-forest/6 last:border-0 hover:bg-cream/40 transition-colors">
                  <td className="px-4 py-3">
                    <Link href={`/verify/${job.id}`} className="text-sm font-medium text-ink hover:text-forest transition-colors">
                      {job.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 font-mono text-sm font-semibold" style={{ color: (job.total_leakage ?? 0) > 0 ? '#DC2626' : '#9CA3AF' }}>
                    {(job.total_leakage ?? 0) > 0 ? fmt(job.total_leakage, job.currency ?? 'EUR') : '—'}
                  </td>
                  <td className="px-4 py-3 text-sm text-stone">
                    {job.findings_count ?? 0}
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs font-medium" style={{ color: s.color }}>{s.label}</span>
                  </td>
                  <td className="px-4 py-3 text-xs text-stone">{timeAgo(job.created_at)}</td>
                  <td className="px-4 py-3">
                    <Link href={`/verify/${job.id}`} className="text-xs text-forest hover:underline">
                      View →
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <DeleteJobButton jobId={job.id} label="audit" />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
