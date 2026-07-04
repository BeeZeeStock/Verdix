import Link from 'next/link'
import { redirect } from 'next/navigation'
import { supabaseServer } from '@/lib/supabase'
import { getActiveOrg } from '@/lib/org'

// ── Data fetching ──────────────────────────────────────────────────────────

async function getPartnerTrendsData(orgId: string) {
  const { data: jobs } = await supabaseServer
    .from('jobs')
    .select('id, total_leakage, findings_count, currency, execute_status, created_at')
    .eq('module', 'PARTNER_RECON')
    .eq('execute_status', 'COMPLETED')
    .eq('org_id', orgId)
    .order('created_at', { ascending: true })

  const jobIds = (jobs ?? []).map(j => j.id)

  const [{ data: findings }, { data: invoices }] = jobIds.length > 0
    ? await Promise.all([
        supabaseServer.from('partner_findings').select('finding_type, discrepancy, status, job_id').in('job_id', jobIds),
        supabaseServer.from('partner_invoices').select('partner_name, invoice_amount, dispute_amount, currency, status, job_id').in('job_id', jobIds),
      ])
    : [{ data: [] }, { data: [] }]

  return {
    jobs: jobs ?? [],
    findings: findings ?? [],
    invoices: invoices ?? [],
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtFull(n: number, cur = 'EUR') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(n)
}

function fmtAxis(n: number) {
  if (n === 0) return '€0'
  if (n >= 1000) return `€${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`
  return `€${n.toFixed(0)}`
}

function fmtMonthShort(ym: string) {
  const [, mo] = ym.split('-')
  return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(mo) - 1]
}


function niceMax(v: number): number {
  if (v <= 0) return 1000
  const mag = Math.pow(10, Math.floor(Math.log10(v)))
  return Math.ceil(v / mag) * mag
}

const FINDING_TYPES = ['WRONG_RATE', 'WAIVED_FEE', 'DUPLICATE_CHARGE', 'EXPIRED_RATE', 'INCORRECT_CALC'] as const

const TYPE_LABELS: Record<string, string> = {
  WRONG_RATE:      'Wrong rate applied',
  WAIVED_FEE:      'Fee should be waived',
  DUPLICATE_CHARGE: 'Duplicate charge',
  EXPIRED_RATE:    'Expired rate used',
  INCORRECT_CALC:  'Calculation error',
}

const TYPE_COLOR: Record<string, string> = {
  WRONG_RATE:      '#0F2D1A',   // near-black green
  WAIVED_FEE:      '#1F7A4A',   // dark emerald
  DUPLICATE_CHARGE: '#27AE60',  // vivid emerald
  INCORRECT_CALC:  '#73C99B',   // soft green
  EXPIRED_RATE:    '#B8E0CC',   // pale mint
}

const PARTNER_COLORS = ['#0F2D1A', '#1F7A4A', '#27AE60', '#73C99B', '#B8E0CC', '#4A7C59', '#2D6A4F', '#87B09A']

// ── Page ───────────────────────────────────────────────────────────────────

export default async function PartnerTrendsPage() {
  const org = await getActiveOrg()
  if (!org) redirect('/login')
  const { jobs, findings, invoices } = await getPartnerTrendsData(org.orgId)

  const hasData = jobs.length > 0

  // Build job_id → YYYY-MM map so findings can be bucketed by month
  const jobMonthMap: Record<string, string> = {}
  for (const job of jobs) jobMonthMap[job.id] = job.created_at.slice(0, 7)

  // Monthly stacked breakdown: month → { finding_type → amount }
  const monthTypeMap: Record<string, Record<string, number>> = {}
  for (const f of findings) {
    const ym = jobMonthMap[f.job_id]
    if (!ym) continue
    if (!monthTypeMap[ym]) monthTypeMap[ym] = {}
    monthTypeMap[ym][f.finding_type] = (monthTypeMap[ym][f.finding_type] ?? 0) + Number(f.discrepancy ?? 0)
  }
  const months = Object.keys(monthTypeMap).sort()
  const monthTotals = months.map(m => Object.values(monthTypeMap[m]).reduce((s, v) => s + v, 0))
  const rawMax = Math.max(...monthTotals, 1)
  const yMax = niceMax(rawMax)

  // KPIs
  const totalDisputes = jobs.reduce((s, j) => s + Number(j.total_leakage ?? 0), 0)
  const partnersChecked = jobs.length
  const withFindings = jobs.filter(j => (j.findings_count ?? 0) > 0).length
  const avgDisputePerCheck = withFindings > 0 ? totalDisputes / withFindings : 0

  // By finding type
  const typeMap: Record<string, number> = {}
  for (const f of findings) {
    typeMap[f.finding_type] = (typeMap[f.finding_type] ?? 0) + Number(f.discrepancy ?? 0)
  }
  const typeRows = Object.entries(typeMap).sort(([, a], [, b]) => b - a)
  const totalFindingsAmount = typeRows.reduce((s, [, v]) => s + v, 0)

  // Open vs resolved by type
  const openByType: Record<string, number> = {}
  for (const f of findings) {
    if (f.status === 'open') openByType[f.finding_type] = (openByType[f.finding_type] ?? 0) + 1
  }

  // By partner
  const partnerMap: Record<string, { total: number; invoiceTotal: number; jobCount: number; currency: string }> = {}
  for (const inv of invoices) {
    if (!inv.partner_name) continue
    if (!partnerMap[inv.partner_name]) partnerMap[inv.partner_name] = { total: 0, invoiceTotal: 0, jobCount: 0, currency: inv.currency ?? 'EUR' }
    partnerMap[inv.partner_name].total += Number(inv.dispute_amount ?? 0)
    partnerMap[inv.partner_name].invoiceTotal += Number(inv.invoice_amount ?? 0)
    partnerMap[inv.partner_name].jobCount += 1
  }
  const partnerRows = Object.entries(partnerMap).sort(([, a], [, b]) => b.total - a.total).slice(0, 8)
  const partnerMax = Math.max(...partnerRows.map(([, p]) => p.total), 1)

  // Donut segments — disputed amount by partner (RSC-safe: no mutable accumulator)
  const donutGrandTotal = partnerRows.reduce((s, [, p]) => s + p.total, 0)
  const donutCx = 100, donutCy = 100, donutR = 80, donutInnerR = 52
  const donutSweeps = partnerRows.map(([, { total }]) => {
    const raw = donutGrandTotal > 0 ? (total / donutGrandTotal) * 2 * Math.PI : 0
    return Math.min(raw, 2 * Math.PI * 0.9999) // SVG arcs are degenerate at exactly 360°
  })
  const donutStarts = donutSweeps.reduce<number[]>((acc, _, i) => {
    acc.push(i === 0 ? -Math.PI / 2 : acc[i - 1] + donutSweeps[i - 1])
    return acc
  }, [])
  const partnerSegments = partnerRows.map(([name, { total, currency }], idx) => {
    const a0 = donutStarts[idx]
    const a1 = a0 + donutSweeps[idx]
    const large = donutSweeps[idx] > Math.PI ? 1 : 0
    const x1 = donutCx + donutR * Math.cos(a0),    y1 = donutCy + donutR * Math.sin(a0)
    const x2 = donutCx + donutR * Math.cos(a1),    y2 = donutCy + donutR * Math.sin(a1)
    const ix1 = donutCx + donutInnerR * Math.cos(a1), iy1 = donutCy + donutInnerR * Math.sin(a1)
    const ix2 = donutCx + donutInnerR * Math.cos(a0), iy2 = donutCy + donutInnerR * Math.sin(a0)
    const path = `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${donutR} ${donutR} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} L ${ix1.toFixed(2)} ${iy1.toFixed(2)} A ${donutInnerR} ${donutInnerR} 0 ${large} 0 ${ix2.toFixed(2)} ${iy2.toFixed(2)} Z`
    return { name, total, currency, path, color: PARTNER_COLORS[idx % PARTNER_COLORS.length], pct: donutGrandTotal > 0 ? (total / donutGrandTotal) * 100 : 0 }
  })

  // SVG chart constants
  const SVG_W   = 900
  const Y_LEFT  = 54
  const X_RIGHT = 8
  const CHART_W = SVG_W - Y_LEFT - X_RIGHT
  const CHART_H = 170
  const X_LBL_H = 24
  const SVG_H   = CHART_H + X_LBL_H
  const Y_TICKS = [0, 0.25, 0.5, 0.75, 1]
  const BAR_GAP = months.length > 18 ? 2 : 6
  const barW    = months.length > 0
    ? Math.max(8, (CHART_W - BAR_GAP * (months.length - 1)) / months.length)
    : 32

  return (
    <div className="p-8">
      <div className="mb-8 flex items-start justify-between">
        <div>
          <h1 className="font-display font-light text-ink text-2xl mb-1">Partner trends</h1>
          <p className="text-stone text-sm">Dispute patterns and billing discrepancies across all partner checks</p>
        </div>
        <Link
          href="/partner/new"
          className="flex items-center gap-2 bg-forest text-white text-sm font-medium px-5 py-2.5 rounded-xl hover:bg-sage transition-colors shadow-sm"
        >
          <i className="ti ti-plus" style={{ fontSize: 14 }} /> New check
        </Link>
      </div>

      {!hasData ? (
        <div className="bg-white border border-forest/10 rounded-2xl p-16 text-center">
          <i className="ti ti-chart-bar text-stone/25 block mb-4" style={{ fontSize: 40 }} />
          <p className="font-medium text-ink mb-1">No partner data yet</p>
          <p className="text-sm text-stone mb-6">Complete a partner reconciliation to start seeing trends here.</p>
          <Link href="/partner/new" className="inline-flex items-center gap-2 bg-forest text-white text-sm font-medium px-5 py-2.5 rounded-xl hover:bg-sage transition-colors">
            Start first check →
          </Link>
        </div>
      ) : (
        <div className="space-y-6">

          {/* KPI row */}
          <div className="grid grid-cols-4 gap-4">
            {[
              { label: 'Total disputes found',   value: fmtFull(totalDisputes),                    color: totalDisputes > 0 ? '#1A3D2B' : '#87B09A' },
              { label: 'Partners checked',        value: partnersChecked.toString(),                color: '#1A3D2B' },
              { label: 'Checks with findings',    value: `${withFindings} / ${partnersChecked}`,   color: withFindings > 0 ? '#4A7C59' : '#87B09A' },
              { label: 'Avg dispute per check',   value: avgDisputePerCheck > 0 ? fmtFull(avgDisputePerCheck) : '—', color: '#2D6A4F' },
            ].map(k => (
              <div key={k.label} className="bg-white border border-forest/10 rounded-2xl p-4">
                <p className="text-[10px] font-semibold text-stone uppercase tracking-widest mb-2">{k.label}</p>
                <p className="text-xl font-semibold font-mono" style={{ color: k.color }}>{k.value}</p>
              </div>
            ))}
          </div>

          {/* Charts row: stacked bars + partner donut */}
          <div className="grid grid-cols-2 gap-6">

            {/* Stacked bar chart — monthly disputes by finding type */}
            <div className="bg-white border border-forest/10 rounded-2xl p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-[10px] font-semibold text-stone uppercase tracking-widest">Monthly disputes by type (EUR)</h2>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 justify-end">
                  {FINDING_TYPES.filter(t => typeMap[t] != null).map(t => (
                    <div key={t} className="flex items-center gap-1.5">
                      <div className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background: TYPE_COLOR[t] }} />
                      <span className="text-[10px] text-stone">{TYPE_LABELS[t]}</span>
                    </div>
                  ))}
                </div>
              </div>

              {months.length === 0 ? (
                <p className="text-sm text-stone py-6 text-center">No monthly data yet</p>
              ) : (
                <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} className="w-full" style={{ overflow: 'visible' }}>
                  {Y_TICKS.map(pct => {
                    const y = CHART_H * (1 - pct)
                    const val = yMax * pct
                    return (
                      <g key={pct}>
                        <line x1={Y_LEFT} y1={y} x2={SVG_W - X_RIGHT} y2={y}
                          stroke="rgba(26,61,43,0.07)" strokeWidth={1}
                          strokeDasharray={pct === 0 ? 'none' : '3 3'} />
                        <text x={Y_LEFT - 6} y={y + 3.5}
                          textAnchor="end" fontSize={10} fill="#9CA3AF">
                          {fmtAxis(val)}
                        </text>
                      </g>
                    )
                  })}

                  {months.map((ym, i) => {
                    const x = Y_LEFT + i * (barW + BAR_GAP)
                    const breakdown = monthTypeMap[ym]
                    const stack = FINDING_TYPES.filter(t => (breakdown[t] ?? 0) > 0)
                    let yOffset = CHART_H
                    return (
                      <g key={ym}>
                        {stack.map(type => {
                          const val = breakdown[type] ?? 0
                          const h = Math.max(1, (val / yMax) * CHART_H)
                          yOffset -= h
                          const isTop = type === stack[0]
                          return (
                            <rect key={type}
                              x={x} y={yOffset} width={barW} height={h}
                              rx={isTop ? 2 : 0} ry={isTop ? 2 : 0}
                              fill={TYPE_COLOR[type]} opacity={0.9}
                            />
                          )
                        })}
                        <text x={x + barW / 2} y={CHART_H + 16}
                          textAnchor="middle" fontSize={9} fill="#9CA3AF">
                          {fmtMonthShort(ym)}
                        </text>
                      </g>
                    )
                  })}

                  <line x1={Y_LEFT} y1={0} x2={Y_LEFT} y2={CHART_H} stroke="rgba(26,61,43,0.12)" strokeWidth={1} />
                  <line x1={Y_LEFT} y1={CHART_H} x2={SVG_W - X_RIGHT} y2={CHART_H} stroke="rgba(26,61,43,0.12)" strokeWidth={1} />
                </svg>
              )}
            </div>

            {/* Donut chart — disputed amount by partner */}
            <div className="bg-white border border-forest/10 rounded-2xl p-6 flex flex-col">
              <h2 className="text-[10px] font-semibold text-stone uppercase tracking-widest mb-5">Disputed amount by partner</h2>
              {partnerSegments.length === 0 ? (
                <div className="flex-1 flex items-center justify-center">
                  <p className="text-sm text-stone">No partner data yet.</p>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-6">
                  <div style={{ width: 180, height: 180, flexShrink: 0 }}>
                    <svg viewBox="0 0 200 200" width="180" height="180">
                      {partnerSegments.map(seg => (
                        <path key={seg.name} d={seg.path} fill={seg.color} />
                      ))}
                      <text x={donutCx} y={donutCy - 6} textAnchor="middle" fontSize={11} fill="#6B6660">Total</text>
                      <text x={donutCx} y={donutCy + 10} textAnchor="middle" fontSize={14} fontWeight={600} fill="#1A3D2B">
                        {fmtFull(donutGrandTotal)}
                      </text>
                    </svg>
                  </div>
                  <div className="w-full space-y-2.5">
                    {partnerSegments.map(seg => (
                      <div key={seg.name} className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: seg.color }} />
                          <span className="text-xs text-ink truncate">{seg.name}</span>
                        </div>
                        <div className="flex items-center gap-3 flex-shrink-0">
                          <span className="font-mono text-xs font-semibold" style={{ color: seg.color }}>{fmtFull(seg.total, seg.currency)}</span>
                          <span className="text-[10px] text-stone w-8 text-right">{seg.pct.toFixed(0)}%</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

          </div>

          {/* By type + By partner */}
          <div className="grid grid-cols-2 gap-6">

            {/* By finding type */}
            <div className="bg-white border border-forest/10 rounded-2xl p-6">
              <h2 className="text-[10px] font-semibold text-stone uppercase tracking-widest mb-5">By finding type</h2>
              {typeRows.length === 0 ? (
                <p className="text-sm text-stone">No findings yet.</p>
              ) : (
                <div className="space-y-5">
                  {typeRows.map(([type, value]) => {
                    const pct = totalFindingsAmount > 0 ? (value / totalFindingsAmount) * 100 : 0
                    const color = TYPE_COLOR[type] ?? '#6B7280'
                    const open = openByType[type] ?? 0
                    return (
                      <div key={type}>
                        <div className="flex items-center justify-between mb-1.5">
                          <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background: color }} />
                            <span className="text-sm text-ink">{TYPE_LABELS[type] ?? type}</span>
                          </div>
                          <span className="font-mono text-sm font-semibold" style={{ color }}>{fmtFull(value)}</span>
                        </div>
                        <div className="h-1.5 bg-stone/10 rounded-full overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
                        </div>
                        <p className="text-[10px] text-stone mt-1">
                          {pct.toFixed(0)}% of total · {open > 0 ? `${open} open` : 'all resolved'}
                        </p>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* By partner */}
            <div className="bg-white border border-forest/10 rounded-2xl p-6">
              <h2 className="text-[10px] font-semibold text-stone uppercase tracking-widest mb-5">Top partners by dispute value</h2>
              {partnerRows.length === 0 ? (
                <p className="text-sm text-stone">No partner data yet.</p>
              ) : (
                <div className="space-y-0">
                  {partnerRows.map(([name, { total, invoiceTotal, currency }], idx) => {
                    const disputePct = invoiceTotal > 0 ? (total / invoiceTotal) * 100 : 0
                    const barPct = partnerMax > 0 ? (total / partnerMax) * 100 : 0
                    const color = PARTNER_COLORS[idx % PARTNER_COLORS.length]
                    return (
                      <div key={name} className="py-3 border-b border-forest/6 last:border-0">
                        <div className="flex items-center justify-between mb-1.5">
                          <p className="text-sm font-medium text-ink truncate max-w-[55%]">{name}</p>
                          <span className="font-mono text-sm font-semibold ml-2 flex-shrink-0" style={{ color }}>
                            {total > 0 ? fmtFull(total, currency) : '—'}
                          </span>
                        </div>
                        <div className="h-1.5 bg-stone/10 rounded-full overflow-hidden mb-1">
                          <div className="h-full rounded-full" style={{ width: `${barPct}%`, background: color }} />
                        </div>
                        <p className="text-[10px] text-stone">
                          {total > 0
                            ? `${disputePct.toFixed(1)}% of ${fmtFull(invoiceTotal, currency)} invoiced`
                            : 'No discrepancies'}
                        </p>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

          </div>

          {/* Finding status breakdown */}
          <div className="bg-white border border-forest/10 rounded-2xl p-6">
            <h2 className="text-[10px] font-semibold text-stone uppercase tracking-widest mb-5">Finding resolution status</h2>
            <div className="grid grid-cols-3 gap-8">
              {(['open', 'disputed', 'accepted'] as const).map(status => {
                const count = findings.filter(f => f.status === status).length
                const amount = findings.filter(f => f.status === status).reduce((s, f) => s + Number(f.discrepancy ?? 0), 0)
                const colors: Record<string, string> = { open: '#1F7A4A', disputed: '#0F2D1A', accepted: '#73C99B' }
                const labels: Record<string, string> = { open: 'Open', disputed: 'Disputed', accepted: 'Accepted' }
                return (
                  <div key={status}>
                    <div className="flex items-center gap-2 mb-2">
                      <div className="w-2 h-2 rounded-full" style={{ background: colors[status] }} />
                      <span className="text-[10px] font-semibold text-stone uppercase tracking-widest">{labels[status]}</span>
                    </div>
                    <p className="text-2xl font-semibold text-ink mb-0.5">{count}</p>
                    <p className="font-mono text-sm" style={{ color: colors[status] }}>{amount > 0 ? fmtFull(amount) : '—'}</p>
                    <p className="text-[10px] text-stone mt-0.5">
                      {findings.length > 0 ? `${((count / findings.length) * 100).toFixed(0)}% of all findings` : '—'}
                    </p>
                  </div>
                )
              })}
            </div>
          </div>

        </div>
      )}
    </div>
  )
}
