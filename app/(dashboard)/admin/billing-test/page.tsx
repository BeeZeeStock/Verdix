'use client'

import { useEffect, useState } from 'react'
import { BillingTestSimulator } from '@/app/_components/BillingTestSimulator'

type OrgRow = { org_id: string; org_name: string; plan_id?: string }
type JobRow = { id: string; org_id: string; org_name: string; created_at: string }

export default function BillingTestPage() {
  const [orgs, setOrgs]               = useState<OrgRow[]>([])
  const [jobs, setJobs]               = useState<JobRow[]>([])
  const [loading, setLoading]         = useState(true)
  const [selectedOrgId, setSelectedOrgId] = useState<string>('')

  useEffect(() => {
    fetch('/api/admin/usage-test')
      .then(r => r.json())
      .then((res: { orgs: OrgRow[]; jobs: JobRow[] }) => {
        setOrgs(res.orgs ?? [])
        setJobs(res.jobs ?? [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  const orgJobCount = (orgId: string) => jobs.filter(j => j.org_id === orgId).length

  // Orgs with real agreements first — otherwise the alphabetically-sorted
  // list buries them under a pile of empty test/auto-created orgs.
  const sortedOrgs = [...orgs].sort((a, b) => {
    const diff = orgJobCount(b.org_id) - orgJobCount(a.org_id)
    return diff !== 0 ? diff : a.org_name.localeCompare(b.org_name)
  })
  const selectedOrg = orgs.find(o => o.org_id === selectedOrgId) ?? null

  if (loading) return <div className="p-8 text-stone text-sm">Loading…</div>

  return (
    <div className="p-4 md:p-8 max-w-3xl space-y-6">
      <div>
        <h1 className="font-display font-light text-ink text-2xl mb-1">Billing test</h1>
        <p className="text-stone text-sm leading-relaxed">
          Push simulated usage into a customer&apos;s agreement setup and preview the overage it would produce on
          their confirmed contracts — before switching a meter to live.
        </p>
      </div>

      {/* How it works */}
      <div className="bg-white border border-forest/10 rounded-2xl px-6 py-5">
        <p className="text-[10px] font-bold text-stone uppercase tracking-[0.14em] mb-3">How this works</p>
        <ol className="space-y-2.5 text-sm text-ink">
          <li className="flex gap-2.5">
            <span className="text-forest font-semibold flex-shrink-0">1.</span>
            <span>
              Register the customer&apos;s meter(s) and pull endpoint in <a href="/admin/meters" className="text-forest underline hover:no-underline">Billing Meters</a> — every new meter starts in <span className="text-amber-600 font-medium">Test</span> mode, so real billing skips it.
            </span>
          </li>
          <li className="flex gap-2.5">
            <span className="text-forest font-semibold flex-shrink-0">2.</span>
            <span>
              Pick the organisation below (enterprise or self-serve), then a meter — if they have several bespoke agreements you can narrow the preview to one, or leave it on all of them.
            </span>
          </li>
          <li className="flex gap-2.5">
            <span className="text-forest font-semibold flex-shrink-0">3.</span>
            <span>
              Enter a usage number to preview the overage. To actually push a real invoice for one agreement, open it from the results (or find it under Configure) and use its <span className="font-medium">Manual invoice</span> card.
            </span>
          </li>
          <li className="flex gap-2.5">
            <span className="text-forest font-semibold flex-shrink-0">4.</span>
            <span>
              Once the numbers check out, switch the meter to <span className="text-forest font-medium">Live</span> in Billing Meters — the real billing cron will then pull from that endpoint instead of skipping it.
            </span>
          </li>
        </ol>
      </div>

      {/* Organisation + simulator — one flowing panel, org picked inline like the self-service page */}
      <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden">
        <div className="px-6 py-4 border-b border-forest/8">
          <div className="text-sm font-medium text-ink flex items-center gap-2 mb-0.5">
            <i className="ti ti-flask text-forest" style={{ fontSize: 15 }} />
            Simulate usage
          </div>
          <p className="text-xs text-stone">
            Every organisation — enterprise (bespoke agreements) and self-serve (standard plans) — is available below.
          </p>
        </div>
        <div className="p-6 space-y-5">
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-wider text-stone block mb-1.5">Organisation</label>
            <select
              value={selectedOrgId}
              onChange={e => setSelectedOrgId(e.target.value)}
              className="w-full text-sm border border-forest/20 rounded-lg px-3 py-2 bg-white text-ink focus:outline-none focus:border-forest/40"
            >
              <option value="">Select an organisation…</option>
              {sortedOrgs.map(org => {
                const jobCount = orgJobCount(org.org_id)
                return (
                  <option key={org.org_id} value={org.org_id}>
                    {org.org_name} — {jobCount} job{jobCount !== 1 ? 's' : ''}{org.plan_id ? ` · ${org.plan_id}` : ''}
                  </option>
                )
              })}
            </select>
            {orgs.length === 0 && <p className="text-xs text-stone mt-1.5">No organisations found.</p>}
          </div>

          {selectedOrg && (
            <div className="border-t border-forest/8 pt-5">
              <BillingTestSimulator orgId={selectedOrg.org_id} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
