import Link from 'next/link'
import { redirect } from 'next/navigation'
import { supabaseServer } from '@/lib/supabase'
import { getActiveOrg } from '@/lib/org'

// ── Data fetching ──────────────────────────────────────────────────────────

type FeedJob = {
  id: string
  name: string
  module: string
  execute_status: string | null
  status: string | null
  total_leakage: number | null
  currency: string | null
  created_at: string
  hasOpenFindings: boolean
}

async function getDashboardData(orgId: string) {
  // Stage 1: aggregate queries (for KPIs) + recent feed
  const [
    { data: billingJobs },
    { data: configureJobs },
    { data: partnerCompletedJobs },
    { data: recentJobs },
    { data: allOrgJobs },
  ] = await Promise.all([
    supabaseServer.from('jobs').select('id, total_leakage').eq('module', 'BILLING_VERIFICATION').eq('org_id', orgId),
    supabaseServer.from('jobs').select('id, execute_status').eq('module', 'AUTO_CONFIGURE').eq('org_id', orgId),
    supabaseServer.from('jobs').select('id, total_leakage').eq('module', 'PARTNER_RECON').eq('execute_status', 'COMPLETED').eq('org_id', orgId),
    supabaseServer.from('jobs').select('id, name, module, execute_status, status, total_leakage, currency, created_at').eq('org_id', orgId).order('created_at', { ascending: false }).limit(20),
    supabaseServer.from('jobs').select('id').eq('org_id', orgId),
  ])

  const jobIds = (allOrgJobs ?? []).map(j => j.id)

  // Stage 2: open findings across all org jobs
  const [{ data: openFindings }, { data: openPartnerFindings }] = jobIds.length > 0
    ? await Promise.all([
        supabaseServer.from('leakage_findings').select('job_id').eq('status', 'open').in('job_id', jobIds),
        supabaseServer.from('partner_findings').select('job_id').eq('status', 'open').in('job_id', jobIds),
      ])
    : [{ data: [] }, { data: [] }]

  // KPI metrics
  const contractsTotal = configureJobs?.length ?? 0
  const needsReview = (configureJobs ?? []).filter(j =>
    j.execute_status === 'PENDING_HUMAN_REVIEW' || j.execute_status === 'READY_TO_APPROVE'
  ).length
  const billingLeakage    = (billingJobs ?? []).reduce((s, j) => s + (Number(j.total_leakage) || 0), 0)
  const partnerLeakage    = (partnerCompletedJobs ?? []).reduce((s, j) => s + (Number(j.total_leakage) || 0), 0)
  const totalLeakage      = billingLeakage + partnerLeakage
  const openFindingsCount = (openFindings?.length ?? 0) + (openPartnerFindings?.length ?? 0)

  // Activity feed — annotate jobs with open-findings flag
  const jobsWithBillingFindings  = new Set((openFindings ?? []).map(f => f.job_id))
  const jobsWithPartnerFindings  = new Set((openPartnerFindings ?? []).map(f => f.job_id))

  const feedJobs: FeedJob[] = (recentJobs ?? []).map(j => ({
    ...j,
    hasOpenFindings: jobsWithBillingFindings.has(j.id) || jobsWithPartnerFindings.has(j.id),
  }))

  const isActionRequired = (j: FeedJob) =>
    j.execute_status === 'PENDING_HUMAN_REVIEW' ||
    j.execute_status === 'READY_TO_APPROVE' ||
    j.hasOpenFindings

  const actionItems   = feedJobs.filter(isActionRequired)
  const recentActivity = feedJobs.filter(j => !isActionRequired(j)).slice(0, 8)

  return {
    contractsTotal, needsReview, totalLeakage, openFindingsCount,
    actionItems, recentActivity,
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fmt(n: number, currency = 'EUR') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n)
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

const MODULE_LABEL: Record<string, string> = {
  BILLING_VERIFICATION: 'Billing audit',
  AUTO_CONFIGURE:       'Contract setup',
  PARTNER_RECON:        'Partner check',
}

const MODULE_HREF: Record<string, string> = {
  BILLING_VERIFICATION: '/verify',
  AUTO_CONFIGURE:       '/configure',
  PARTNER_RECON:        '/partner',
}

const MODULE_BADGE: Record<string, { bg: string; color: string }> = {
  BILLING_VERIFICATION: { bg: '#F0EFED', color: '#1A1A1A' },
  AUTO_CONFIGURE:       { bg: '#F0EFED', color: '#1A1A1A' },
  PARTNER_RECON:        { bg: '#F0EFED', color: '#1A1A1A' },
}

function feedDot(job: { execute_status: string | null; status: string | null; hasOpenFindings: boolean }): string {
  if (job.hasOpenFindings || job.execute_status === 'PENDING_HUMAN_REVIEW') return '#D97706'
  if (job.execute_status === 'READY_TO_APPROVE') return '#D97706'
  const s = job.execute_status ?? job.status ?? ''
  if (s === 'COMPLETED') return '#4A7C59'
  if (s === 'FAILED')    return '#DC2626'
  if (s === 'PROCESSING' || s === 'EXTRACTING') return '#D97706'
  return '#9CA3AF'
}

function feedAction(job: { execute_status: string | null; status: string | null; hasOpenFindings: boolean }): string | null {
  if (job.execute_status === 'PENDING_HUMAN_REVIEW') return 'Needs review'
  if (job.execute_status === 'READY_TO_APPROVE')     return 'Ready to approve'
  if (job.hasOpenFindings)                           return 'Billing discrepancies'
  return null
}

// ── Page ───────────────────────────────────────────────────────────────────

export default async function DashboardPage() {
  const org = await getActiveOrg()
  if (!org) redirect('/login')
  const {
    contractsTotal, needsReview, totalLeakage, openFindingsCount,
    actionItems, recentActivity,
  } = await getDashboardData(org.orgId)

  const kpis = [
    {
      label: 'Customer contracts processed',
      value: contractsTotal.toString(),
      sub: 'across all modules',
      icon: 'ti-file-description',
      color: '#1A3D2B',
      href: '/configure',
      mono: false,
    },
    {
      label: 'Leakage & disputes found',
      value: totalLeakage > 0 ? fmt(totalLeakage) : '€0',
      sub: totalLeakage > 0 ? 'customer & partner billing combined' : 'nothing flagged yet',
      icon: 'ti-alert-triangle',
      color: totalLeakage > 0 ? '#DC2626' : '#9CA3AF',
      href: '/verify',
      mono: true,
    },
    {
      label: 'Billing discrepancies',
      value: openFindingsCount.toString(),
      sub: openFindingsCount > 0 ? 'flagged across audits & partner checks' : 'no issues found',
      icon: 'ti-exclamation-circle',
      color: openFindingsCount > 0 ? '#D97706' : '#9CA3AF',
      href: '/verify',
      mono: false,
    },
    {
      label: 'Contracts awaiting approval',
      value: needsReview.toString(),
      sub: needsReview > 0 ? 'pending your sign-off before billing' : 'nothing pending',
      icon: 'ti-user-check',
      color: needsReview > 0 ? '#D97706' : '#9CA3AF',
      href: '/configure',
      mono: false,
    },
  ]

  return (
    <div className="p-4 md:p-8">
      <div className="mb-6 md:mb-8">
        <h1 className="font-display font-light text-ink text-2xl mb-1">Dashboard</h1>
        <p className="text-stone text-sm">Your revenue intelligence overview</p>
      </div>

      {/* Unified KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {kpis.map(m => (
          <Link key={m.label} href={m.href} className="bg-white border border-forest/10 rounded-2xl p-5 hover:border-forest/25 transition-colors flex flex-col">
            <div className="flex items-start justify-between mb-3" style={{ minHeight: '2.75rem' }}>
              <span className="text-[10px] text-stone uppercase tracking-widest font-semibold leading-tight pr-2">{m.label}</span>
              <i className={`ti ${m.icon} flex-shrink-0 mt-0.5`} style={{ fontSize: 16, color: m.color }} />
            </div>
            <div className={`text-2xl font-semibold mb-1 ${m.mono ? 'font-mono' : ''}`} style={{ color: m.color }}>
              {m.value}
            </div>
            <div className="text-[11px] text-stone/60">{m.sub}</div>
          </Link>
        ))}
      </div>

      {/* Unified activity feed */}
      <div className="bg-white border border-forest/10 rounded-2xl overflow-hidden">

        {/* Feed header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-forest/10">
          <div className="flex items-center gap-2">
            <i className="ti ti-list-check text-forest" style={{ fontSize: 15 }} />
            <h2 className="font-medium text-ink text-sm">Activity feed</h2>
          </div>
          <Link href="/configure/new" className="text-xs text-forest font-medium hover:underline">+ New job</Link>
        </div>

        {/* Empty state — getting started */}
        {actionItems.length === 0 && recentActivity.length === 0 && (
          <div className="px-6 py-8">
            <p className="text-sm font-medium text-ink mb-1">Welcome to Verdix</p>
            <p className="text-sm text-stone mb-6">Pick your start.</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">

              <div className="rounded-2xl border border-forest/10 p-5 flex flex-col">
                <div className="w-9 h-9 rounded-xl bg-blue-50 flex items-center justify-center mb-4 flex-shrink-0">
                  <i className="ti ti-bolt" style={{ fontSize: 18, color: '#2563EB' }} />
                </div>
                <h3 className="text-sm font-semibold text-ink mb-1.5">Set up a contract</h3>
                <p className="text-xs text-stone leading-relaxed mb-5 flex-1">
                  Upload a customer contract as a PDF. Verdix reads the billing terms — fees, overages,
                  escalators — and prepares them for your billing system.
                </p>
                <Link
                  href="/configure/new"
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-white bg-forest px-3 py-2 rounded-lg hover:bg-sage transition-colors self-start"
                >
                  Upload contract <i className="ti ti-arrow-right" style={{ fontSize: 11 }} />
                </Link>
              </div>

              <div className="rounded-2xl border border-forest/10 p-5 flex flex-col">
                <div className="w-9 h-9 rounded-xl bg-amber-50 flex items-center justify-center mb-4 flex-shrink-0">
                  <i className="ti ti-file-check" style={{ fontSize: 18, color: '#D97706' }} />
                </div>
                <h3 className="text-sm font-semibold text-ink mb-1.5">Audit a customer invoice</h3>
                <p className="text-xs text-stone leading-relaxed mb-5 flex-1">
                  Compare what you&apos;ve invoiced against what the contract actually says. Verdix flags
                  billing discrepancies and quantifies the gap.
                </p>
                <Link
                  href="/verify/new"
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-white bg-forest px-3 py-2 rounded-lg hover:bg-sage transition-colors self-start"
                >
                  Start audit <i className="ti ti-arrow-right" style={{ fontSize: 11 }} />
                </Link>
              </div>

              <div className="rounded-2xl border border-forest/10 p-5 flex flex-col">
                <div className="w-9 h-9 rounded-xl bg-purple-50 flex items-center justify-center mb-4 flex-shrink-0">
                  <i className="ti ti-receipt" style={{ fontSize: 18, color: '#7C3AED' }} />
                </div>
                <h3 className="text-sm font-semibold text-ink mb-1.5">Check a partner invoice</h3>
                <p className="text-xs text-stone leading-relaxed mb-5 flex-1">
                  Verify that partner or supplier invoices match your signed agreements.
                  Find overcharges before you pay.
                </p>
                <Link
                  href="/partner/new"
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-white bg-forest px-3 py-2 rounded-lg hover:bg-sage transition-colors self-start"
                >
                  Run check <i className="ti ti-arrow-right" style={{ fontSize: 11 }} />
                </Link>
              </div>

            </div>
          </div>
        )}

        {/* Needs attention */}
        {actionItems.length > 0 && (
          <div>
            <div className="px-6 pt-4 pb-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: '#B45309' }}>
                Needs attention · {actionItems.length}
              </span>
            </div>
            <div className="px-3 pb-2">
              {actionItems.map(job => {
                const badge  = MODULE_BADGE[job.module] ?? { bg: 'rgba(0,0,0,0.05)', color: '#555' }
                const action = feedAction(job)
                const href   = `${MODULE_HREF[job.module] ?? ''}/${job.id}`
                return (
                  <Link
                    key={job.id}
                    href={href}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-amber-50/60 transition-colors group"
                  >
                    <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: feedDot(job) }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm text-ink font-medium truncate max-w-[200px]">{job.name}</span>
                        <span
                          className="text-[10px] font-medium px-1.5 py-0.5 rounded-md flex-shrink-0"
                          style={{ background: badge.bg, color: badge.color }}
                        >
                          {MODULE_LABEL[job.module] ?? job.module}
                        </span>
                      </div>
                      {action && (
                        <div className="text-[11px] mt-0.5 font-medium" style={{ color: '#B45309' }}>{action}</div>
                      )}
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      {(job.total_leakage ?? 0) > 0 && (
                        <span className="font-mono text-xs font-semibold" style={{ color: '#DC2626' }}>
                          {fmt(Number(job.total_leakage), job.currency ?? 'EUR')}
                        </span>
                      )}
                      <span className="text-[10px] text-stone/60">{timeAgo(job.created_at)}</span>
                      <i className="ti ti-chevron-right text-stone/30 group-hover:text-stone/60 transition-colors" style={{ fontSize: 11 }} />
                    </div>
                  </Link>
                )
              })}
            </div>
          </div>
        )}

        {/* Divider */}
        {actionItems.length > 0 && recentActivity.length > 0 && (
          <div className="mx-6 border-t border-forest/5" />
        )}

        {/* Recent activity */}
        {recentActivity.length > 0 && (
          <div>
            <div className="px-6 pt-4 pb-1.5">
              <span className="text-[10px] font-semibold text-stone/60 uppercase tracking-widest">Recent activity</span>
            </div>
            <div className="px-3 pb-3">
              {recentActivity.map(job => {
                const badge = MODULE_BADGE[job.module] ?? { bg: 'rgba(0,0,0,0.05)', color: '#555' }
                const href  = `${MODULE_HREF[job.module] ?? ''}/${job.id}`
                return (
                  <Link
                    key={job.id}
                    href={href}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-cream transition-colors group"
                  >
                    <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: feedDot(job) }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm text-ink truncate max-w-[200px]">{job.name}</span>
                        <span
                          className="text-[10px] font-medium px-1.5 py-0.5 rounded-md flex-shrink-0"
                          style={{ background: badge.bg, color: badge.color }}
                        >
                          {MODULE_LABEL[job.module] ?? job.module}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      {(job.total_leakage ?? 0) > 0 && (
                        <span className="font-mono text-xs font-semibold" style={{ color: '#DC2626' }}>
                          {fmt(Number(job.total_leakage), job.currency ?? 'EUR')}
                        </span>
                      )}
                      <span className="text-[10px] text-stone/60">{timeAgo(job.created_at)}</span>
                      <i className="ti ti-chevron-right text-stone/30 group-hover:text-stone/60 transition-colors" style={{ fontSize: 11 }} />
                    </div>
                  </Link>
                )
              })}
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
