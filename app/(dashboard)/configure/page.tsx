import Link from 'next/link'
import { redirect } from 'next/navigation'
import { supabaseServer } from '@/lib/supabase'
import { getActiveOrg } from '@/lib/org'
import { DeleteJobButton } from '@/components/dashboard/DeleteJobButton'

async function getJobs(orgId: string) {
  const { data } = await supabaseServer
    .from('jobs')
    .select('id, name, execute_status, currency, created_at, contract_terms_id')
    .eq('module', 'AUTO_CONFIGURE')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
  return data ?? []
}

// Fetch customer names for jobs that have contract_terms
async function getCustomerNames(jobIds: string[]): Promise<Record<string, string>> {
  if (jobIds.length === 0) return {}
  const { data } = await supabaseServer
    .from('contract_terms')
    .select('job_id, customer_name')
    .in('job_id', jobIds)
  const map: Record<string, string> = {}
  for (const row of data ?? []) {
    if (row.customer_name) map[row.job_id] = row.customer_name
  }
  return map
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
  COMPLETED:            { color: '#4A7C59', label: 'Configured' },
  READY_TO_APPROVE:     { color: '#4A7C59', label: 'Ready to approve' },
  PENDING_HUMAN_REVIEW: { color: '#D97706', label: 'Needs review' },
  EXTRACTING:           { color: '#2563EB', label: 'Extracting…' },
  FAILED:               { color: '#DC2626', label: 'Failed' },
  PENDING:              { color: '#9CA3AF', label: 'Pending' },
}

export default async function ConfigureListPage() {
  const org = await getActiveOrg()
  if (!org) redirect('/login')
  const jobs = await getJobs(org.orgId)
  const customerNames = await getCustomerNames(jobs.map(j => j.id))

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="font-display font-light text-ink text-2xl mb-1">New contracts</h1>
          <p className="text-stone text-sm">Auto-configure billing from signed contracts</p>
        </div>
        <Link href="/configure/new" className="flex items-center gap-2 bg-forest text-white text-sm font-medium px-5 py-2.5 rounded-xl hover:bg-sage transition-colors shadow-sm">
          <i className="ti ti-plus" style={{ fontSize: 14 }} /> Upload contract
        </Link>
      </div>

      <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden">
        <div className="px-6 py-4 border-b border-forest/8 flex items-center justify-between">
          <span className="text-sm font-medium text-ink">All contracts</span>
          <span className="text-xs text-stone">{jobs.length} job{jobs.length !== 1 ? 's' : ''}</span>
        </div>
        <table className="w-full">
          <thead>
            <tr className="border-b border-forest/8">
              {['Contract name', 'Customer', 'Status', 'Date', '', ''].map(h => (
                <th key={h} className="px-4 py-3 text-left text-[10px] font-semibold text-stone uppercase tracking-wider">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {jobs.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-6 py-16 text-center">
                  <i className="ti ti-bolt text-stone/25 block mb-3" style={{ fontSize: 36 }} />
                  <p className="text-sm text-stone mb-4">No contracts executed yet.</p>
                  <Link href="/configure/new" className="inline-flex items-center gap-2 bg-forest text-white text-sm font-medium px-4 py-2 rounded-xl hover:bg-sage transition-colors">
                    Upload a contract →
                  </Link>
                </td>
              </tr>
            ) : jobs.map(job => {
              const s = STATUS_STYLE[job.execute_status] ?? STATUS_STYLE.PENDING
              return (
                <tr key={job.id} className="border-b border-forest/6 last:border-0 hover:bg-cream/40 transition-colors">
                  <td className="px-4 py-3">
                    <Link href={`/configure/${job.id}`} className="text-sm font-medium text-ink hover:text-forest transition-colors">
                      {job.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-sm text-stone">
                    {customerNames[job.id] ?? '—'}
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs font-medium" style={{ color: s.color }}>{s.label}</span>
                  </td>
                  <td className="px-4 py-3 text-xs text-stone">{timeAgo(job.created_at)}</td>
                  <td className="px-4 py-3">
                    <Link href={`/configure/${job.id}`} className="text-xs text-forest hover:underline">
                      View →
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <DeleteJobButton jobId={job.id} label="contract" />
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
