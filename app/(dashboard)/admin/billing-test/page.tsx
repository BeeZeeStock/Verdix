'use client'

import { useEffect, useState } from 'react'
import { BillingTestSimulator } from '@/app/_components/BillingTestSimulator'

type OrgRow = { org_id: string; org_name: string }
type JobRow = { id: string; org_id: string; org_name: string; created_at: string }

export default function BillingTestPage() {
  const [orgs, setOrgs]               = useState<OrgRow[]>([])
  const [jobs, setJobs]               = useState<JobRow[]>([])
  const [loading, setLoading]         = useState(true)
  const [selectedOrg, setSelectedOrg] = useState<OrgRow | null>(null)

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
            Register the customer&apos;s meter(s) and pull endpoint in <a href="/admin/meters" className="text-forest underline hover:no-underline">Billing Meters</a> — every new meter starts in <span className="text-amber-600 font-medium">Test</span> mode, so real billing skips it.
          </li>
          <li className="flex gap-2.5">
            <span className="text-forest font-semibold flex-shrink-0">2.</span>
            Pick the organisation below, then a meter and a usage number to preview the overage it would produce on their confirmed contracts.
          </li>
          <li className="flex gap-2.5">
            <span className="text-forest font-semibold flex-shrink-0">3.</span>
            Once the numbers check out, switch the meter to <span className="text-forest font-medium">Live</span> in Billing Meters — the real billing cron will then pull from that endpoint instead of skipping it.
          </li>
        </ol>
      </div>

      {/* Org selector */}
      <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden">
        <div className="px-6 py-4 border-b border-forest/8">
          <div className="text-sm font-medium text-ink flex items-center gap-2">
            <i className="ti ti-users-group" style={{ fontSize: 15 }} />
            Select organisation
          </div>
        </div>
        <div className="divide-y divide-forest/5">
          {orgs.length === 0 && (
            <div className="px-6 py-4 text-sm text-stone">No organisations found.</div>
          )}
          {orgs.map(org => {
            const isActive = selectedOrg?.org_id === org.org_id
            const jobCount = orgJobCount(org.org_id)
            return (
              <button
                key={org.org_id}
                onClick={() => setSelectedOrg(isActive ? null : org)}
                className="w-full text-left px-6 py-3.5 flex items-center gap-4 transition-colors hover:bg-forest/3"
                style={{ background: isActive ? '#EAF3DE' : undefined }}
              >
                <div className="flex-1 min-w-0 flex items-center gap-2">
                  <span className="text-sm font-medium text-ink truncate">{org.org_name}</span>
                  <span className="text-[11px] text-stone/60">{jobCount} job{jobCount !== 1 ? 's' : ''}</span>
                </div>
                <i className={`ti ${isActive ? 'ti-check' : 'ti-chevron-right'} text-forest/40`}
                  style={{ fontSize: 14, flexShrink: 0 }} />
              </button>
            )
          })}
        </div>
      </div>

      {/* Contract usage simulation */}
      {selectedOrg && (
        <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden">
          <div className="px-6 py-4 border-b border-forest/8">
            <div className="text-sm font-medium text-ink flex items-center gap-2 mb-0.5">
              <i className="ti ti-flask text-forest" style={{ fontSize: 15 }} />
              Push usage to {selectedOrg.org_name}&apos;s agreement setup
            </div>
            <p className="text-xs text-stone">
              Simulate a usage reading for one of this org&apos;s meters and preview the overage it would produce on
              each confirmed contract — using the exact same math the real billing cron runs. Preview only; never
              creates invoices or touches Stripe/Remembill.
            </p>
          </div>
          <div className="p-6">
            <BillingTestSimulator orgId={selectedOrg.org_id} />
          </div>
        </div>
      )}
    </div>
  )
}
