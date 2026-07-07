import Link from 'next/link'
import { redirect } from 'next/navigation'
import { supabaseServer } from '@/lib/supabase'
import { getActiveOrg } from '@/lib/org'

// ── Data fetching ──────────────────────────────────────────────────────────

async function getDashboardData(orgId: string) {
  // Stage 1: all job queries — scoped to org
  const [
    { data: billingJobs },
    { data: configureJobs },
    { data: recentBilling },
    { data: recentConfigure },
    { data: partnerJobs },
    { data: recentPartner },
    { data: allOrgJobs },
  ] = await Promise.all([
    supabaseServer.from('jobs').select('id, total_leakage, currency, execute_status').eq('module', 'BILLING_VERIFICATION').eq('org_id', orgId),
    supabaseServer.from('jobs').select('id, execute_status').eq('module', 'AUTO_CONFIGURE').eq('org_id', orgId),
    supabaseServer.from('jobs').select('id, name, status, total_leakage, currency, findings_count, created_at').eq('module', 'BILLING_VERIFICATION').eq('org_id', orgId).order('created_at', { ascending: false }).limit(5),
    supabaseServer.from('jobs').select('id, name, execute_status, created_at').eq('module', 'AUTO_CONFIGURE').eq('org_id', orgId).order('created_at', { ascending: false }).limit(5),
    supabaseServer.from('jobs').select('id, total_leakage, findings_count, currency').eq('module', 'PARTNER_RECON').eq('execute_status', 'COMPLETED').eq('org_id', orgId),
    supabaseServer.from('jobs').select('id, name, total_leakage, findings_count, currency, execute_status, created_at, partner_invoices ( partner_name )').eq('module', 'PARTNER_RECON').eq('org_id', orgId).order('created_at', { ascending: false }).limit(5),
    supabaseServer.from('jobs').select('id').eq('org_id', orgId),
  ])

  // Collect all job IDs belonging to this org
  const jobIds = (allOrgJobs ?? []).map(j => j.id)

  // Stage 2: child table queries scoped to user's job IDs
  const [
    { data: openFindings },
    { data: corrections },
    { data: termConfidences },
    { data: openPartnerFindings },
  ] = jobIds.length > 0
    ? await Promise.all([
        supabaseServer.from('leakage_findings').select('id').eq('status', 'open').in('job_id', jobIds),
        supabaseServer.from('extraction_corrections').select('apply_to_future, created_at').in('job_id', jobIds).order('created_at', { ascending: false }),
        supabaseServer.from('contract_terms').select('extraction_confidence, created_at').in('job_id', jobIds).order('created_at', { ascending: false }).limit(30),
        supabaseServer.from('partner_findings').select('id').eq('status', 'open').in('job_id', jobIds),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }]

  const auditsRun = billingJobs?.length ?? 0
  const totalLeakage = (billingJobs ?? []).reduce((s, j) => s + (Number(j.total_leakage) || 0), 0)
  const openFindingsCount = openFindings?.length ?? 0

  const contractsTotal       = configureJobs?.length ?? 0
  const contractsConfigured  = (configureJobs ?? []).filter(j => j.execute_status === 'COMPLETED').length
  const contractsNeedsReview = (configureJobs ?? []).filter(j =>
    j.execute_status === 'PENDING_HUMAN_REVIEW' || j.execute_status === 'READY_TO_APPROVE'
  ).length
  const contractsFailed      = (configureJobs ?? []).filter(j => j.execute_status === 'FAILED').length
  const correctionCount = corrections?.length ?? 0
  const rulesLearned = (corrections ?? []).filter(c => c.apply_to_future).length
  const lastExtraction = termConfidences?.[0]?.created_at ?? null

  const partnerChecksRun = partnerJobs?.length ?? 0
  const totalPartnerDisputes = (partnerJobs ?? []).reduce((s, j) => s + (Number(j.total_leakage) || 0), 0)
  const openPartnerFindingsCount = openPartnerFindings?.length ?? 0

  // Avg confidence: map text values to numbers
  const confMap: Record<string, number> = { high: 0.97, medium: 0.82, low: 0.62 }
  const confScores = (termConfidences ?? []).map(t => confMap[t.extraction_confidence] ?? 0.82)
  const avgConfidence = confScores.length > 0
    ? Math.round(confScores.reduce((s, v) => s + v, 0) / confScores.length * 100)
    : null

  return {
    auditsRun, totalLeakage, openFindingsCount,
    contractsTotal, contractsConfigured, contractsNeedsReview, contractsFailed,
    correctionCount, rulesLearned, avgConfidence, lastExtraction,
    partnerChecksRun, totalPartnerDisputes, openPartnerFindingsCount,
    recentBilling: recentBilling ?? [],
    recentConfigure: recentConfigure ?? [],
    recentPartner: (recentPartner ?? []) as Array<{
      id: string; name: string; total_leakage: number | null; findings_count: number | null
      currency: string; execute_status: string; created_at: string
      partner_invoices: Array<{ partner_name: string }>
    }>,
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

const STATUS_DOT: Record<string, string> = {
  COMPLETED: '#4A7C59',
  PROCESSING: '#D97706',
  FAILED: '#DC2626',
  PENDING: '#9CA3AF',
}

const EXECUTE_DOT: Record<string, string> = {
  COMPLETED: '#4A7C59',
  READY_TO_APPROVE: '#4A7C59',
  PENDING_HUMAN_REVIEW: '#D97706',
  EXTRACTING: '#D97706',
  FAILED: '#DC2626',
  PENDING: '#9CA3AF',
}

const EXECUTE_LABEL: Record<string, string> = {
  COMPLETED: 'Configured',
  READY_TO_APPROVE: 'Ready to approve',
  PENDING_HUMAN_REVIEW: 'Needs review',
  EXTRACTING: 'Extracting…',
  FAILED: 'Failed',
  PENDING: 'Pending',
}

// ── Page ───────────────────────────────────────────────────────────────────

export default async function DashboardPage() {
  const org = await getActiveOrg()
  if (!org) redirect('/login')
  const {
    auditsRun, totalLeakage, openFindingsCount,
    contractsTotal, contractsConfigured, contractsNeedsReview, contractsFailed,
    correctionCount, rulesLearned, avgConfidence, lastExtraction,
    partnerChecksRun, totalPartnerDisputes, openPartnerFindingsCount,
    recentBilling, recentConfigure, recentPartner,
  } = await getDashboardData(org.orgId)

  // Row 1 — Billing audit
  const auditMetrics = [
    { label: 'Audit runs',           value: auditsRun.toString(),                          icon: 'ti-file-check',       color: '#1A3D2B',                                          href: '/verify' },
    { label: 'Billing leakage found', value: totalLeakage > 0 ? fmt(totalLeakage) : '€0', icon: 'ti-alert-triangle',   color: totalLeakage > 0 ? '#DC2626' : '#9CA3AF', mono: true, href: '/verify' },
    { label: 'Open findings',         value: openFindingsCount.toString(),                  icon: 'ti-exclamation-circle', color: openFindingsCount > 0 ? '#D97706' : '#9CA3AF',   href: '/verify' },
  ]

  // Row 2 — New contracts
  const contractMetrics = [
    { label: 'Contracts processed',         value: contractsTotal.toString(),        icon: 'ti-file-description', color: '#1A3D2B',                                              href: '/configure' },
    { label: 'Configured in billing',       value: contractsConfigured.toString(),   icon: 'ti-bolt',             color: contractsConfigured > 0 ? '#1F7A4A' : '#9CA3AF',       href: '/configure' },
    { label: 'Needs human review',          value: contractsNeedsReview.toString(),  icon: 'ti-user-check',       color: contractsNeedsReview > 0 ? '#D97706' : '#9CA3AF',      href: '/configure' },
    { label: 'Errors / failed',             value: contractsFailed.toString(),       icon: 'ti-alert-circle',     color: contractsFailed > 0 ? '#DC2626' : '#9CA3AF',           href: '/configure' },
  ]

  // Row 3 — Partner reconciliation
  const partnerMetrics = [
    { label: 'Partner agreements processed',    value: partnerChecksRun.toString(),                               icon: 'ti-receipt',          color: '#1A3D2B',                                               href: '/partner' },
    { label: 'Partner disputes found', value: totalPartnerDisputes > 0 ? fmt(totalPartnerDisputes) : '€0', icon: 'ti-coins',         color: totalPartnerDisputes > 0 ? '#DC2626' : '#9CA3AF', mono: true, href: '/partner' },
    { label: 'Open partner findings', value: openPartnerFindingsCount.toString(),                       icon: 'ti-alert-circle',     color: openPartnerFindingsCount > 0 ? '#D97706' : '#9CA3AF',  href: '/partner' },
  ]

  return (
    <div className="p-4 md:p-8">
      <div className="mb-6 md:mb-8">
        <h1 className="font-display font-light text-ink text-2xl mb-1">Dashboard</h1>
        <p className="text-stone text-sm">Your revenue intelligence overview</p>
      </div>

      {/* Row 1 — Billing audits */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-3">
        {auditMetrics.map(m => (
          <Link key={m.label} href={m.href} className="bg-parchment border border-forest/10 rounded-2xl p-5 hover:border-forest/25 transition-colors">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[10px] text-stone uppercase tracking-widest font-semibold">{m.label}</span>
              <i className={`ti ${m.icon}`} style={{ fontSize: 16, color: m.color }} />
            </div>
            <div className={`text-2xl font-semibold ${'mono' in m && m.mono ? 'font-mono' : ''}`} style={{ color: m.color }}>{m.value}</div>
          </Link>
        ))}
      </div>

      {/* Row 2 — New contracts (4 cols) */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-3">
        {contractMetrics.map(m => (
          <Link key={m.label} href={m.href} className="bg-white border border-forest/10 rounded-2xl p-5 hover:border-forest/25 transition-colors">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[10px] text-stone uppercase tracking-widest font-semibold">{m.label}</span>
              <i className={`ti ${m.icon}`} style={{ fontSize: 16, color: m.color }} />
            </div>
            <div className={`text-2xl font-semibold ${'mono' in m && m.mono ? 'font-mono' : ''}`} style={{ color: m.color }}>{m.value}</div>
          </Link>
        ))}
      </div>

      {/* Row 3 — Partner reconciliation */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        {partnerMetrics.map(m => (
          <Link key={m.label} href={m.href} className="bg-white border border-forest/10 rounded-2xl p-5 hover:border-forest/25 transition-colors">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[10px] text-stone uppercase tracking-widest font-semibold">{m.label}</span>
              <i className={`ti ${m.icon}`} style={{ fontSize: 16, color: m.color }} />
            </div>
            <div className={`text-2xl font-semibold ${'mono' in m && m.mono ? 'font-mono' : ''}`} style={{ color: m.color }}>{m.value}</div>
          </Link>
        ))}
      </div>

      {/* Learning analytics */}
      <div className="bg-white border border-forest/10 rounded-2xl p-5 mb-8">
        <div className="flex items-center gap-2 mb-5">
          <i className="ti ti-brain text-forest" style={{ fontSize: 16 }} />
          <span className="font-medium text-ink text-sm">Extraction accuracy</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-6">
          <div>
            <div className="text-[10px] text-stone uppercase tracking-widest mb-2">Corrections made</div>
            <div className="text-2xl font-medium text-ink">{correctionCount}</div>
          </div>
          <div>
            <div className="text-[10px] text-stone uppercase tracking-widest mb-2">Rules learned</div>
            <div className="text-2xl font-medium text-ink">{rulesLearned}</div>
            <div className="text-xs text-stone/60 mt-0.5">
              {rulesLearned} customer · {correctionCount - rulesLearned} one-off
            </div>
          </div>
          <div>
            <div className="text-[10px] text-stone uppercase tracking-widest mb-2">Avg confidence (30d)</div>
            <div className="text-2xl font-medium text-ink">
              {avgConfidence != null ? `${avgConfidence}%` : '—'}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-stone uppercase tracking-widest mb-2">Last extraction</div>
            <div className="text-2xl font-medium text-ink">
              {lastExtraction ? timeAgo(lastExtraction) : '—'}
            </div>
            {!lastExtraction && <div className="text-xs text-stone/60 mt-0.5">No extractions yet</div>}
          </div>
        </div>
      </div>

      {/* Three-column panels */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">

        {/* Recent billing checks */}
        <div className="bg-white border border-forest/10 rounded-2xl p-6">
          <div className="flex items-center justify-between mb-5">
            <h2 className="font-medium text-ink text-sm">Recent billing checks</h2>
            <Link href="/verify/new" className="text-xs text-forest font-medium hover:underline">+ New</Link>
          </div>
          {recentBilling.length === 0 ? (
            <div className="text-center py-10">
              <i className="ti ti-file-check text-stone/25 block mb-3" style={{ fontSize: 32 }} />
              <p className="text-sm text-stone mb-4">No audits yet. Upload your first contracts.</p>
              <Link href="/verify/new" className="inline-flex items-center gap-2 bg-forest text-white text-sm font-medium px-4 py-2 rounded-xl hover:bg-sage transition-colors">
                Start audit →
              </Link>
            </div>
          ) : (
            <div className="space-y-1">
              {recentBilling.map(job => (
                <Link
                  key={job.id}
                  href={`/verify/${job.id}`}
                  className="flex items-center justify-between px-3 py-2.5 rounded-xl hover:bg-cream transition-colors group"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: STATUS_DOT[job.status] ?? '#9CA3AF' }} />
                    <span className="text-sm text-ink truncate">{job.name}</span>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0 ml-2">
                    {job.total_leakage > 0 && (
                      <span className="font-mono text-xs text-danger font-medium">{fmt(Number(job.total_leakage))}</span>
                    )}
                    <span className="text-[10px] text-stone">{timeAgo(job.created_at)}</span>
                    <i className="ti ti-chevron-right text-stone/40 group-hover:text-stone transition-colors" style={{ fontSize: 11 }} />
                  </div>
                </Link>
              ))}
              {recentBilling.length === 5 && (
                <Link href="/verify" className="block text-center text-xs text-forest pt-2 hover:underline">
                  View all →
                </Link>
              )}
            </div>
          )}
        </div>

        {/* Recent auto-configure jobs */}
        <div className="bg-white border border-forest/10 rounded-2xl p-6">
          <div className="flex items-center justify-between mb-5">
            <h2 className="font-medium text-ink text-sm">Recent auto-configure jobs</h2>
            <Link href="/configure/new" className="text-xs text-forest font-medium hover:underline">+ New</Link>
          </div>
          {recentConfigure.length === 0 ? (
            <div className="text-center py-10">
              <i className="ti ti-bolt text-stone/25 block mb-3" style={{ fontSize: 32 }} />
              <p className="text-sm text-stone mb-4">No contracts executed yet.</p>
              <Link href="/configure/new" className="inline-flex items-center gap-2 bg-forest text-white text-sm font-medium px-4 py-2 rounded-xl hover:bg-sage transition-colors">
                Upload a contract →
              </Link>
            </div>
          ) : (
            <div className="space-y-1">
              {recentConfigure.map(job => (
                <Link
                  key={job.id}
                  href={`/configure/${job.id}`}
                  className="flex items-center justify-between px-3 py-2.5 rounded-xl hover:bg-cream transition-colors group"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: EXECUTE_DOT[job.execute_status] ?? '#9CA3AF' }} />
                    <span className="text-sm text-ink truncate">{job.name}</span>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0 ml-2">
                    <span className="text-[10px] text-stone whitespace-nowrap">{EXECUTE_LABEL[job.execute_status] ?? job.execute_status}</span>
                    <span className="text-[10px] text-stone/60">{timeAgo(job.created_at)}</span>
                    <i className="ti ti-chevron-right text-stone/40 group-hover:text-stone transition-colors" style={{ fontSize: 11 }} />
                  </div>
                </Link>
              ))}
              {recentConfigure.length === 5 && (
                <Link href="/configure" className="block text-center text-xs text-forest pt-2 hover:underline">
                  View all →
                </Link>
              )}
            </div>
          )}
        </div>

        {/* Recent partner checks */}
        <div className="bg-white border border-forest/10 rounded-2xl p-6">
          <div className="flex items-center justify-between mb-5">
            <h2 className="font-medium text-ink text-sm">Recent partner checks</h2>
            <Link href="/partner/new" className="text-xs text-forest font-medium hover:underline">+ New</Link>
          </div>
          {recentPartner.length === 0 ? (
            <div className="text-center py-10">
              <i className="ti ti-receipt text-stone/25 block mb-3" style={{ fontSize: 32 }} />
              <p className="text-sm text-stone mb-4">No partner reconciliations yet.</p>
              <Link href="/partner/new" className="inline-flex items-center gap-2 bg-forest text-white text-sm font-medium px-4 py-2 rounded-xl hover:bg-sage transition-colors">
                Start check →
              </Link>
            </div>
          ) : (
            <div className="space-y-1">
              {recentPartner.map(job => {
                const partnerName = job.partner_invoices?.[0]?.partner_name ?? job.name
                const hasFindings = (job.findings_count ?? 0) > 0
                const dot = job.execute_status === 'COMPLETED'
                  ? (hasFindings ? '#D97706' : '#4A7C59')
                  : (job.execute_status === 'FAILED' ? '#DC2626' : '#9CA3AF')
                return (
                  <Link
                    key={job.id}
                    href={`/partner/${job.id}`}
                    className="flex items-center justify-between px-3 py-2.5 rounded-xl hover:bg-cream transition-colors group"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: dot }} />
                      <span className="text-sm text-ink truncate">{partnerName}</span>
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0 ml-2">
                      {hasFindings && (
                        <span className="font-mono text-xs text-danger font-medium">
                          {fmt(Number(job.total_leakage), job.currency ?? 'EUR')}
                        </span>
                      )}
                      <span className="text-[10px] text-stone/60">{timeAgo(job.created_at)}</span>
                      <i className="ti ti-chevron-right text-stone/40 group-hover:text-stone transition-colors" style={{ fontSize: 11 }} />
                    </div>
                  </Link>
                )
              })}
              {recentPartner.length === 5 && (
                <Link href="/partner" className="block text-center text-xs text-forest pt-2 hover:underline">
                  View all →
                </Link>
              )}
            </div>
          )}
        </div>

      </div>
    </div>
  )
}
