import { redirect } from 'next/navigation'
import { supabaseServer } from '@/lib/supabase'
import { getActiveOrg } from '@/lib/org'

// ── Data fetching ──────────────────────────────────────────────────────────

async function getContractData(orgId: string) {
  const { data: jobs } = await supabaseServer
    .from('jobs')
    .select(`
      id, name, execute_status, currency,
      contract_terms (
        customer_name, contract_start_date, contract_end_date,
        contract_term_months, base_monthly_fee, base_annual_fee,
        billing_frequency, currency, contract_id, extraction_confidence,
        one_time_fees, year_pricing
      )
    `)
    .eq('module', 'AUTO_CONFIGURE')
    .eq('org_id', orgId)
    .in('execute_status', ['READY_TO_APPROVE', 'PENDING_HUMAN_REVIEW', 'APPROVED', 'COMPLETED'])
    .order('created_at', { ascending: false })

  const jobIds = (jobs ?? []).map(j => j.id)

  const { data: invoices } = jobIds.length > 0
    ? await supabaseServer
        .from('computed_invoices')
        .select('job_id, line_items, period_start, period_end, total_amount, currency')
        .in('job_id', jobIds)
        .order('period_start', { ascending: true })
    : { data: [] }

  type InvoiceRow = {
    job_id: string
    line_items: { type: string; amount: number; description: string; currency: string }[]
    period_start: string | null
    period_end: string | null
    currency: string
    total_amount: number
  }

  const overageByJob: Record<string, number> = {}
  const overageByJobMonth: Record<string, Record<string, number>> = {}
  // Full overage invoice records keyed by job_id (for detail cards)
  const ovgInvoicesByJob: Record<string, InvoiceRow[]> = {}

  for (const inv of (invoices ?? []) as InvoiceRow[]) {
    const ovg = (inv.line_items ?? [])
      .filter(l => l.type === 'overage')
      .reduce((s, l) => s + Number(l.amount), 0)
    if (ovg <= 0) continue
    overageByJob[inv.job_id] = (overageByJob[inv.job_id] ?? 0) + ovg
    if (!ovgInvoicesByJob[inv.job_id]) ovgInvoicesByJob[inv.job_id] = []
    ovgInvoicesByJob[inv.job_id].push(inv)
    if (inv.period_start) {
      const mk = monthKey(new Date(inv.period_start))
      if (!overageByJobMonth[inv.job_id]) overageByJobMonth[inv.job_id] = {}
      overageByJobMonth[inv.job_id][mk] = (overageByJobMonth[inv.job_id][mk] ?? 0) + ovg
    }
  }

  return { jobs: jobs ?? [], overageByJob, overageByJobMonth, ovgInvoicesByJob }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function currencySym(cur: string) {
  return cur === 'EUR' ? '€' : cur === 'GBP' ? '£' : cur === 'SEK' ? 'kr' : '$'
}

function fmtAxis(n: number, cur: string) {
  const s = currencySym(cur)
  if (n === 0) return `${s}0`
  if (n >= 1_000_000) return `${s}${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${s}${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`
  return `${s}${n.toFixed(0)}`
}

function fmtFull(n: number, cur = 'EUR') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(n)
}

function niceMax(v: number): number {
  if (v <= 0) return 1000
  const mag = Math.pow(10, Math.floor(Math.log10(v)))
  return Math.ceil(v / mag) * mag
}

function parseLocalDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1)
}

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1)
}

function monthKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function monthLabel(k: string) {
  const [y, m] = k.split('-')
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(m) - 1]
  return parseInt(m) === 1 ? `${mo} '${y.slice(2)}` : mo
}

const CUSTOMER_COLORS = ['#0F2D1A','#1F7A4A','#27AE60','#73C99B','#B8E0CC','#4A7C59','#2D6A4F','#87B09A','#D9A35A','#B9802F']
const ACTIVE_COLOR  = '#1A3D2B'
const EXPIRED_COLOR = '#87B09A'

// ── Per-currency charts ────────────────────────────────────────────────────

type ContractRow = {
  jobId: string; jobName: string
  customer: string; contractId: string | null
  start: Date | null; end: Date | null; termMonths: number
  mrr: number; arr: number; tcv: number; currency: string
  confidence: string; isDuplicate: boolean
  actualOverage: number  // total overage billed to date from computed_invoices
}

type InvoiceDetail = {
  job_id: string
  line_items: { type: string; amount: number; description: string; currency: string }[]
  period_start: string | null
  period_end: string | null
  currency: string
  total_amount: number
}

function CurrencySection({ cur, contracts, today, overageByJobMonth, ovgInvoicesByJob }: {
  cur: string
  contracts: ContractRow[]
  today: Date
  overageByJobMonth: Record<string, Record<string, number>>
  ovgInvoicesByJob: Record<string, InvoiceDetail[]>
}) {
  const active   = contracts.filter(c => c.start && c.end && c.start <= today && c.end >= today)
  const upcoming = contracts.filter(c => c.start && c.start > today)
  const expired  = contracts.filter(c => c.end && c.end < today)

  const activeARR    = active.reduce((s, c) => s + c.arr, 0)
  const expiredARR   = expired.reduce((s, c) => s + c.arr, 0)
  const activeMRR    = active.reduce((s, c) => s + c.mrr, 0)
  const expiredMRR   = expired.reduce((s, c) => s + c.mrr, 0)
  const totalOverage = contracts.reduce((s, c) => s + c.actualOverage, 0)

  // MRR by month — active vs expired series
  const allStarts = contracts.filter(c => c.start).map(c => c.start!)
  const allEnds   = contracts.filter(c => c.end).map(c => c.end!)
  const rangeStart = allStarts.length ? new Date(Math.min(...allStarts.map(d => d.getTime()))) : today
  const rangeEnd   = allEnds.length   ? new Date(Math.max(...allEnds.map(d => d.getTime())))   : today
  const chartStart = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), 1)
  const chartEnd   = new Date(Math.min(rangeEnd.getTime(), addMonths(today, 6).getTime()))

  const chartMonths: string[] = []
  let cur2 = new Date(chartStart)
  while (cur2 <= chartEnd) { chartMonths.push(monthKey(cur2)); cur2 = addMonths(cur2, 1) }

  const dataByMonth: Record<string, { aARR: number; eARR: number; aMRR: number; eMRR: number; aOvg: number; eOvg: number }> = {}
  for (const mk of chartMonths) {
    dataByMonth[mk] = { aARR: 0, eARR: 0, aMRR: 0, eMRR: 0, aOvg: 0, eOvg: 0 }
    const [y, m] = mk.split('-').map(Number)
    const md = new Date(y, m - 1, 1)
    for (const c of contracts) {
      if (!c.start || !c.end || c.mrr === 0) continue
      if (c.start <= md && c.end >= md) {
        const ovgThisMonth = overageByJobMonth[c.jobId]?.[mk] ?? 0
        if (c.end >= today) {
          dataByMonth[mk].aMRR += c.mrr
          dataByMonth[mk].aARR += c.arr
          dataByMonth[mk].aOvg += ovgThisMonth
        } else {
          dataByMonth[mk].eMRR += c.mrr
          dataByMonth[mk].eARR += c.arr
          dataByMonth[mk].eOvg += ovgThisMonth
        }
      }
    }
  }


  // SVG layout constants (shared; bar width is computed per-chart)
  const SVG_W = 900, CHART_H = 120, X_LBL_H = 22, SVG_H = CHART_H + X_LBL_H
  const Y_LEFT = 58, X_RIGHT = 8, CHART_W = SVG_W - Y_LEFT - X_RIGHT
  const Y_TICKS = [0, 0.25, 0.5, 0.75, 1]

  const todayMk = monthKey(today)

  return (
    <div className="space-y-6">
      {/* Currency header */}
      <div className="flex items-center gap-3">
        <span className="text-lg font-semibold text-ink">{cur}</span>
        <div className="flex-1 h-px bg-forest/10" />
        <span className="text-xs text-stone">{contracts.length} contract{contracts.length !== 1 ? 's' : ''}</span>
      </div>

      {/* KPI row for this currency */}
      <div className="grid grid-cols-5 gap-4">
        {[
          { label: 'Active ARR',     value: fmtFull(activeARR, cur),    sub: `${active.length} active contracts`,   color: ACTIVE_COLOR },
          { label: 'Expired ARR',    value: fmtFull(expiredARR, cur),   sub: `${expired.length} expired contracts`, color: EXPIRED_COLOR },
          { label: 'Active MRR',     value: fmtFull(activeMRR, cur),    sub: 'Monthly recurring',                   color: ACTIVE_COLOR },
          { label: 'Expired MRR',    value: fmtFull(expiredMRR, cur),   sub: 'Last known MRR',                      color: EXPIRED_COLOR },
          { label: 'Overage (actual)', value: fmtFull(totalOverage, cur), sub: 'Billed variable usage to date',     color: '#0B5C36' },
        ].map(k => (
          <div key={k.label} className="bg-white border border-forest/10 rounded-2xl p-4">
            <p className="text-[10px] font-semibold text-stone uppercase tracking-widest mb-2">{k.label}</p>
            <p className="text-xl font-semibold font-mono" style={{ color: k.color }}>{k.value}</p>
            <p className="text-[10px] text-stone mt-1">{k.sub}</p>
          </div>
        ))}
      </div>

      {/* Four metric charts — 2×2 grid */}
      <div className="grid grid-cols-2 gap-6">
        {[
          { title: 'Active ARR',  key: 'aARR' as const, color: ACTIVE_COLOR,  months: chartMonths, isARR: true  },
          { title: 'Expired ARR', key: 'eARR' as const, color: EXPIRED_COLOR, months: chartMonths, isARR: true  },
          { title: 'Active MRR',  key: 'aMRR' as const, color: ACTIVE_COLOR,  months: chartMonths, isARR: false },
          { title: 'Expired MRR', key: 'eMRR' as const, color: EXPIRED_COLOR, months: chartMonths, isARR: false },
        ].map(({ title, key, color, months, isARR }) => {
          const GAP = 4

          if (isARR) {
            // Group months into calendar years — ARR x-axis is years, not months
            const MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
            const yearGroups: { year: string; startIdx: number; endIdx: number; range: string }[] = []
            let gi = 0
            while (gi < months.length) {
              const yr = months[gi].split('-')[0]
              const si = gi
              while (gi < months.length && months[gi].startsWith(yr)) gi++
              const ei = gi - 1
              const fm = parseInt(months[si].split('-')[1]) - 1
              const lm = parseInt(months[ei].split('-')[1]) - 1
              yearGroups.push({ year: yr, startIdx: si, endIdx: ei,
                range: fm === 0 && lm === 11 ? '' : `(${MO[fm]}–${MO[lm]})` })
            }
            const ny = yearGroups.length
            // Bar width based on year count — fills the chart just like MRR fills with months
            const bwY = ny > 0 ? Math.max(20, (CHART_W - GAP * (ny - 1)) / ny) : 60
            const maxVal = niceMax(Math.max(...yearGroups.map(g =>
              Math.max(...months.slice(g.startIdx, g.endIdx + 1).map(mk => dataByMonth[mk]?.[key] ?? 0))
            ), 1))
            return (
              <div key={key} className="bg-white border border-forest/10 rounded-2xl p-6">
                <div className="flex items-center gap-2 mb-4">
                  <div className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background: color }} />
                  <h3 className="text-[10px] font-semibold text-stone uppercase tracking-widest">{title} ({cur})</h3>
                </div>
                {months.length === 0 ? (
                  <p className="text-sm text-stone py-6 text-center">No date data available</p>
                ) : (
                  <svg viewBox={`0 0 ${SVG_W} ${CHART_H + 34}`} className="w-full" style={{ overflow: 'visible' }}>
                    {Y_TICKS.map(pct => {
                      const y = CHART_H * (1 - pct)
                      return (
                        <g key={pct}>
                          <line x1={Y_LEFT} y1={y} x2={SVG_W - X_RIGHT} y2={y}
                            stroke="rgba(26,61,43,0.07)" strokeWidth={1}
                            strokeDasharray={pct === 0 ? 'none' : '3 3'} />
                          <text x={Y_LEFT - 6} y={y + 3.5} textAnchor="end" fontSize={10} fill="#9CA3AF">
                            {fmtAxis(maxVal * pct, cur)}
                          </text>
                        </g>
                      )
                    })}
                    {yearGroups.map((g, yi) => {
                      const x = Y_LEFT + yi * (bwY + GAP)
                      const cx = x + bwY / 2
                      const val = Math.max(...months.slice(g.startIdx, g.endIdx + 1).map(mk => dataByMonth[mk]?.[key] ?? 0))
                      const h = val > 0 ? Math.max(1, (val / maxVal) * CHART_H) : 0
                      return (
                        <g key={g.year}>
                          {h > 0 && (
                            <rect x={x} y={CHART_H - h} width={bwY} height={h} fill={color} opacity={0.9} />
                          )}
                          <text x={cx} y={CHART_H + 14} textAnchor="middle" fontSize={10} fill="#4A7C59" fontWeight={700}>
                            {g.year}
                          </text>
                          {g.range && (
                            <text x={cx} y={CHART_H + 27} textAnchor="middle" fontSize={8} fill="#9CA3AF">
                              {g.range}
                            </text>
                          )}
                        </g>
                      )
                    })}
                    <line x1={Y_LEFT} y1={0} x2={Y_LEFT} y2={CHART_H} stroke="rgba(26,61,43,0.12)" strokeWidth={1} />
                    <line x1={Y_LEFT} y1={CHART_H} x2={SVG_W - X_RIGHT} y2={CHART_H} stroke="rgba(26,61,43,0.12)" strokeWidth={1} />
                  </svg>
                )}
              </div>
            )
          }

          // MRR: monthly bars with overage stacked on top
          const ovgKey = key === 'aMRR' ? 'aOvg' : 'eOvg'
          const nc = months.length
          const bgap = nc > 18 ? 2 : 4
          const bw = nc > 0 ? Math.max(6, (CHART_W - bgap * (nc - 1)) / nc) : 24
          const vals = months.map(mk => (dataByMonth[mk]?.[key] ?? 0) + (dataByMonth[mk]?.[ovgKey] ?? 0))
          const maxVal = niceMax(Math.max(...vals, 1))
          const hasOverage = months.some(mk => (dataByMonth[mk]?.[ovgKey] ?? 0) > 0)
          return (
            <div key={key} className="bg-white border border-forest/10 rounded-2xl p-6">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background: color }} />
                <h3 className="text-[10px] font-semibold text-stone uppercase tracking-widest">{title} ({cur})</h3>
                {hasOverage && (
                  <div className="flex items-center gap-1.5 ml-3">
                    <div className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background: '#0B5C36' }} />
                    <span className="text-[9px] text-stone">Overage billed</span>
                  </div>
                )}
              </div>
              {months.length === 0 ? (
                <p className="text-sm text-stone py-6 text-center">No date data available</p>
              ) : (
                <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} className="w-full" style={{ overflow: 'visible' }}>
                  {Y_TICKS.map(pct => {
                    const y = CHART_H * (1 - pct)
                    return (
                      <g key={pct}>
                        <line x1={Y_LEFT} y1={y} x2={SVG_W - X_RIGHT} y2={y}
                          stroke="rgba(26,61,43,0.07)" strokeWidth={1}
                          strokeDasharray={pct === 0 ? 'none' : '3 3'} />
                        <text x={Y_LEFT - 6} y={y + 3.5} textAnchor="end" fontSize={10} fill="#9CA3AF">
                          {fmtAxis(maxVal * pct, cur)}
                        </text>
                      </g>
                    )
                  })}
                  {months.map((mk, i) => {
                    const x = Y_LEFT + i * (bw + bgap)
                    const base = dataByMonth[mk]?.[key] ?? 0
                    const ovg  = dataByMonth[mk]?.[ovgKey] ?? 0
                    const h    = base > 0 ? Math.max(1, (base / maxVal) * CHART_H) : 0
                    const hOvg = ovg  > 0 ? Math.max(1, (ovg  / maxVal) * CHART_H) : 0
                    const isCurrent = mk === todayMk
                    return (
                      <g key={mk}>
                        <title>{`${monthLabel(mk)}\nMRR: ${fmtFull(base, cur)}${ovg > 0 ? `\nOverage: ${fmtFull(ovg, cur)}` : ''}`}</title>
                        {isCurrent && (
                          <rect x={x - 1} y={0} width={bw + 2} height={CHART_H} fill={color} opacity={0.04} rx={2} />
                        )}
                        {h > 0 && (
                          <rect x={x} y={CHART_H - h} width={bw} height={h} fill={color} opacity={0.9} />
                        )}
                        {hOvg > 0 && (
                          <rect x={x} y={CHART_H - h - hOvg} width={bw} height={hOvg} fill="#0B5C36" opacity={0.9} />
                        )}
                        {(i === 0 || mk.endsWith('-01') || isCurrent || i === nc - 1) && (
                          <text x={x + bw / 2} y={CHART_H + 16} textAnchor="middle" fontSize={9}
                            fill={isCurrent ? color : '#9CA3AF'}
                            fontWeight={isCurrent || mk.endsWith('-01') ? 700 : 400}>
                            {monthLabel(mk)}
                          </text>
                        )}
                      </g>
                    )
                  })}
                  <line x1={Y_LEFT} y1={0} x2={Y_LEFT} y2={CHART_H} stroke="rgba(26,61,43,0.12)" strokeWidth={1} />
                  <line x1={Y_LEFT} y1={CHART_H} x2={SVG_W - X_RIGHT} y2={CHART_H} stroke="rgba(26,61,43,0.12)" strokeWidth={1} />
                </svg>
              )}
            </div>
          )
        })}
      </div>

      {/* Overage detail cards — one per contract with actual billed overage */}
      {contracts.some(c => ovgInvoicesByJob[c.jobId]?.length > 0) && (
        <div className="bg-white border border-forest/10 rounded-2xl p-6">
          <h3 className="text-[10px] font-semibold text-stone uppercase tracking-widest mb-5">
            Overage billed — {cur}
          </h3>
          <div className="space-y-4">
            {contracts.filter(c => ovgInvoicesByJob[c.jobId]?.length > 0).map(c => {
              const invoices = ovgInvoicesByJob[c.jobId]
              return (
                <div key={c.jobId} className="border border-forest/10 rounded-xl overflow-hidden">
                  {/* Contract header */}
                  <div className="flex items-center justify-between px-4 py-3 bg-forest/3">
                    <div>
                      <p className="text-sm font-semibold text-ink">{c.customer}</p>
                      {c.contractId && <p className="text-[10px] text-stone font-mono mt-0.5">{c.contractId}</p>}
                    </div>
                    <div className="text-right">
                      <p className="text-[10px] text-stone uppercase tracking-widest mb-0.5">Total overage billed</p>
                      <p className="text-base font-semibold" style={{ color: '#0B5C36', fontVariantNumeric: 'tabular-nums' }}>
                        +{fmtFull(c.actualOverage, c.currency)}
                      </p>
                    </div>
                  </div>
                  {/* Invoice rows */}
                  <div className="divide-y divide-forest/6">
                    {invoices.map((inv, ii) => {
                      const ovgLines = (inv.line_items ?? []).filter(l => l.type === 'overage')
                      const invOvgTotal = ovgLines.reduce((s, l) => s + l.amount, 0)
                      const pStart = inv.period_start ? new Date(inv.period_start) : null
                      const pEnd   = inv.period_end   ? new Date(inv.period_end)   : null
                      const sameMonth = pStart && pEnd &&
                        pStart.getMonth() === pEnd.getMonth() &&
                        pStart.getFullYear() === pEnd.getFullYear()
                      const periodLabel = pStart
                        ? sameMonth
                          ? pStart.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
                          : `${pStart.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })} – ${pEnd?.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })}`
                        : '—'
                      return (
                        <div key={ii} className="px-4 py-3">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-[10px] font-semibold text-stone uppercase tracking-widest">{periodLabel}</span>
                            <span className="text-xs font-semibold" style={{ color: '#0B5C36', fontVariantNumeric: 'tabular-nums' }}>
                              +{fmtFull(invOvgTotal, inv.currency || c.currency)}
                            </span>
                          </div>
                          <div className="space-y-1">
                            {ovgLines.map((l, li) => (
                              <div key={li} className="flex items-start justify-between gap-4">
                                <p className="text-[11px] text-stone leading-snug flex-1">{l.description}</p>
                                <p className="text-[11px] text-ink font-medium flex-shrink-0" style={{ fontVariantNumeric: 'tabular-nums' }}>
                                  {fmtFull(l.amount, l.currency || c.currency)}
                                </p>
                              </div>
                            ))}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Status breakdown */}
      <div className="bg-white border border-forest/10 rounded-2xl p-6">
        <h3 className="text-[10px] font-semibold text-stone uppercase tracking-widest mb-5">Contract status — {cur}</h3>
        <div className="grid grid-cols-3 gap-8">
          {[
            { label: 'Active',    count: active.length,   arr: activeARR, color: '#27AE60' },
            { label: 'Upcoming',  count: upcoming.length, arr: upcoming.reduce((s,c) => s+c.arr,0), color: '#73C99B' },
            { label: 'Expired',   count: expired.length,  arr: expiredARR, color: '#D1D5DB' },
          ].map(row => {
            const pct = contracts.length > 0 ? (row.count / contracts.length) * 100 : 0
            return (
              <div key={row.label}>
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full" style={{ background: row.color }} />
                    <span className="text-sm text-ink">{row.label} <span className="text-stone">({row.count})</span></span>
                  </div>
                  <span className="font-mono text-sm font-semibold" style={{ color: row.color }}>{fmtFull(row.arr, cur)}</span>
                </div>
                <div className="h-1.5 bg-stone/10 rounded-full overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${pct}%`, background: row.color }} />
                </div>
                <p className="text-[10px] text-stone mt-1">{pct.toFixed(0)}% of {cur} contracts</p>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────

export default async function ContractTrendsPage() {
  const org = await getActiveOrg()
  if (!org) redirect('/login')
  const { jobs, overageByJob, overageByJobMonth, ovgInvoicesByJob } = await getContractData(org.orgId)

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  // Flatten to contract rows
  const contracts: ContractRow[] = []
  for (const job of jobs) {
    const t = Array.isArray(job.contract_terms) ? job.contract_terms[0] : job.contract_terms
    if (!t) continue
    const start  = t.contract_start_date ? parseLocalDate(t.contract_start_date) : null
    const end    = t.contract_end_date   ? parseLocalDate(t.contract_end_date)   : null
    const months = t.contract_term_months ?? (start && end
      ? (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) + 1
      : 12)
    const oneTime = ((t.one_time_fees ?? []) as { amount: number }[]).reduce((s, f) => s + Number(f.amount ?? 0), 0)
    // Resolve annual fee: year_pricing.year1 → base_annual_fee → base_monthly_fee × 12
    const yp = t.year_pricing as Record<string, number> | null | undefined
    const annualFee = yp?.year1 ?? (Number(t.base_annual_fee ?? 0) || Number(t.base_monthly_fee ?? 0) * 12)
    const mrr = annualFee / 12
    // TCV: sum all year_pricing years if available, else mrr × term
    const tcv = yp
      ? Object.values(yp).reduce((s: number, v: number) => s + Number(v), 0) + oneTime
      : mrr * months + oneTime
    // Normalise currency to uppercase; fall back to job currency
    const cur = (t.currency ?? job.currency ?? 'EUR').toUpperCase()
    contracts.push({
      jobId: job.id, jobName: job.name,
      customer: t.customer_name ?? job.name ?? 'Unknown',
      contractId: t.contract_id,
      start, end, termMonths: months,
      mrr, arr: annualFee, tcv,
      currency: cur,
      confidence: t.extraction_confidence ?? 'medium',
      isDuplicate: false, // filled below
      actualOverage: overageByJob[job.id] ?? 0,
    })
  }

  // ── Duplicate detection (cross-currency: same customer + overlapping dates) ──
  const duplicateJobIds = new Set<string>()
  const byCustomer: Record<string, ContractRow[]> = {}
  for (const c of contracts) {
    const key = c.customer.toLowerCase().trim()
    if (!byCustomer[key]) byCustomer[key] = []
    byCustomer[key].push(c)
  }
  for (const group of Object.values(byCustomer)) {
    if (group.length < 2) continue
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j]
        if (!a.start || !a.end || !b.start || !b.end) continue
        if (a.start <= b.end && b.start <= a.end) {
          duplicateJobIds.add(a.jobId); duplicateJobIds.add(b.jobId)
        }
      }
    }
  }
  for (const c of contracts) c.isDuplicate = duplicateJobIds.has(c.jobId)

  // ── Group by currency ───────────────────────────────────────────────────
  const byCurrency: Record<string, ContractRow[]> = {}
  for (const c of contracts) {
    if (!byCurrency[c.currency]) byCurrency[c.currency] = []
    byCurrency[c.currency].push(c)
  }
  // Sort currencies: most contracts first
  const currencies = Object.keys(byCurrency).sort((a, b) => byCurrency[b].length - byCurrency[a].length)

  // ── Active ARR donut — across all currencies ────────────────────────────
  const activeAll = contracts.filter(c => c.start && c.end && c.start <= today && c.end >= today)
  const donutArrByCustomer = activeAll.reduce<Record<string, { arr: number; cur: string }>>((acc, c) => {
    if (!acc[c.customer]) acc[c.customer] = { arr: 0, cur: c.currency }
    acc[c.customer].arr += c.arr
    return acc
  }, {})
  const donutRows = Object.entries(donutArrByCustomer).sort(([, a], [, b]) => b.arr - a.arr).slice(0, 8)
  const donutTotal = donutRows.reduce((s, [, v]) => s + v.arr, 0)
  const dCx = 90, dCy = 90, dR = 72, dIR = 46
  const dSweeps = donutRows.map(([, v]) =>
    Math.min(donutTotal > 0 ? (v.arr / donutTotal) * 2 * Math.PI : 0, 2 * Math.PI * 0.9999))
  const dStarts = dSweeps.reduce<number[]>((acc, _, i) => {
    acc.push(i === 0 ? -Math.PI / 2 : acc[i - 1] + dSweeps[i - 1]); return acc
  }, [])
  const donutSegs = donutRows.map(([name, { arr, cur: dCur }], idx) => {
    const a0 = dStarts[idx], a1 = a0 + dSweeps[idx]
    const lg = dSweeps[idx] > Math.PI ? 1 : 0
    const x1 = dCx + dR * Math.cos(a0),    y1 = dCy + dR * Math.sin(a0)
    const x2 = dCx + dR * Math.cos(a1),    y2 = dCy + dR * Math.sin(a1)
    const ix1 = dCx + dIR * Math.cos(a1),  iy1 = dCy + dIR * Math.sin(a1)
    const ix2 = dCx + dIR * Math.cos(a0),  iy2 = dCy + dIR * Math.sin(a0)
    const path = `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${dR} ${dR} 0 ${lg} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} L ${ix1.toFixed(2)} ${iy1.toFixed(2)} A ${dIR} ${dIR} 0 ${lg} 0 ${ix2.toFixed(2)} ${iy2.toFixed(2)} Z`
    return { name, arr, cur: dCur, path, color: CUSTOMER_COLORS[idx % CUSTOMER_COLORS.length], pct: donutTotal > 0 ? (arr / donutTotal) * 100 : 0 }
  })

  // ── Upcoming renewals across all currencies (next 180 days) ─────────────
  const renewalWindow = new Date(today.getTime() + 180 * 24 * 60 * 60 * 1000)
  const upcoming180 = contracts
    .filter(c => c.start && c.end && c.start <= today && c.end >= today && c.end <= renewalWindow)
    .sort((a, b) => (a.end?.getTime() ?? 0) - (b.end?.getTime() ?? 0))

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="font-display font-light text-ink text-2xl mb-1">Contract ARR</h1>
        <p className="text-stone text-sm">
          Recurring revenue across all configured contracts
          {currencies.length > 1 && (
            <span className="ml-2 text-[10px] bg-forest/8 text-forest px-2 py-0.5 rounded-full font-semibold uppercase tracking-wide">
              {currencies.join(' · ')}
            </span>
          )}
        </p>
      </div>

      {contracts.length === 0 ? (
        <div className="bg-white border border-forest/10 rounded-2xl p-16 text-center">
          <i className="ti ti-file-certificate text-stone/25 block mb-4" style={{ fontSize: 40 }} />
          <p className="font-medium text-ink mb-1">No contracts configured yet</p>
          <p className="text-sm text-stone">Upload and extract a contract to see ARR trends here.</p>
        </div>
      ) : (
        <div className="space-y-10">

          {/* Duplicate warning banner */}
          {duplicateJobIds.size > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-2xl px-6 py-4 flex items-start gap-3">
              <i className="ti ti-alert-triangle text-amber-600 flex-shrink-0 mt-0.5" style={{ fontSize: 18 }} />
              <div>
                <p className="text-sm font-semibold text-amber-900">
                  {duplicateJobIds.size} contract{duplicateJobIds.size !== 1 ? 's' : ''} flagged as possible duplicates
                </p>
                <p className="text-xs text-amber-700 mt-0.5">
                  Same customer with overlapping contract dates — may be double-counting ARR. Review the contract list below.
                </p>
              </div>
            </div>
          )}

          {/* Per-currency sections */}
          {currencies.map(cur => (
            <CurrencySection
              key={cur}
              cur={cur}
              contracts={byCurrency[cur]}
              today={today}
              overageByJobMonth={overageByJobMonth}
              ovgInvoicesByJob={ovgInvoicesByJob}
            />
          ))}

          {/* Renewals + full contract list — global, shown once */}
          <div className="space-y-6">
            {/* Upcoming renewals */}
            <div className="bg-white border border-forest/10 rounded-2xl p-6">
              <h2 className="text-[10px] font-semibold text-stone uppercase tracking-widest mb-5">
                Renewals in next 6 months
                {upcoming180.length > 0 && (
                  <span className="ml-2 text-[9px] bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded-full font-semibold">
                    {upcoming180.length}
                  </span>
                )}
              </h2>
              {upcoming180.length === 0 ? (
                <p className="text-sm text-stone">No contracts expiring in the next 6 months.</p>
              ) : (
                <div className="grid grid-cols-2 gap-x-8">
                  {upcoming180.map(c => {
                    const daysLeft = c.end ? Math.ceil((c.end.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)) : 0
                    const urgColor = daysLeft <= 30 ? '#B9802F' : daysLeft <= 60 ? '#27AE60' : '#9CA3AF'
                    return (
                      <div key={c.jobId} className="py-3 border-b border-forest/6 last:border-0 flex items-center justify-between gap-4">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-ink truncate">{c.customer}</p>
                          <p className="text-[10px] text-stone">
                            Ends {c.end?.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                            {' · '}{c.currency}
                          </p>
                        </div>
                        <div className="text-right flex-shrink-0">
                          <p className="font-mono text-sm font-semibold" style={{ color: urgColor }}>{fmtFull(c.arr, c.currency)}</p>
                          <p className="text-[10px] font-semibold" style={{ color: urgColor }}>{daysLeft}d left</p>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* All contracts table + active ARR donut — two separate cards */}
            <div className="grid grid-cols-[2fr_1fr] gap-6 items-start">

              {/* All contracts table */}
              <div className="bg-white border border-forest/10 rounded-2xl p-6">
                <h2 className="text-[10px] font-semibold text-stone uppercase tracking-widest mb-5">All contracts</h2>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-forest/8">
                        {['Customer','Contract ID','Term','Cur','MRR','ARR','Overage','Status','Confidence',''].map(h => (
                          <th key={h} className="text-[10px] font-semibold text-stone uppercase tracking-widest py-2 pr-5 text-left last:pr-0 last:text-right whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {contracts.map(c => {
                        const status = !c.start || !c.end ? 'No dates'
                          : c.start > today ? 'Upcoming'
                          : c.end < today   ? 'Expired'
                          : 'Active'
                        const statusColor = status === 'Active' ? '#27AE60' : status === 'Upcoming' ? '#73C99B' : status === 'Expired' ? '#9CA3AF' : '#D1D5DB'
                        return (
                          <tr key={c.jobId} className={`border-b border-forest/6 last:border-0 ${c.isDuplicate ? 'bg-amber-50/60' : ''}`}>
                            <td className="py-3 pr-5">
                              <div className="flex items-center gap-2">
                                {c.isDuplicate && (
                                  <i className="ti ti-alert-triangle text-amber-500 flex-shrink-0" style={{ fontSize: 13 }}
                                    title="Possible duplicate: overlapping contract dates for this customer" />
                                )}
                                <span className="font-medium text-ink whitespace-nowrap">{c.customer}</span>
                              </div>
                            </td>
                            <td className="py-3 pr-5 text-stone font-mono text-xs whitespace-nowrap">{c.contractId ?? '—'}</td>
                            <td className="py-3 pr-5 text-stone text-xs whitespace-nowrap">
                              {c.start && c.end
                                ? `${c.start.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })} – ${c.end.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })}`
                                : '—'}
                            </td>
                            <td className="py-3 pr-5">
                              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-forest/6 text-forest">{c.currency}</span>
                            </td>
                            <td className="py-3 pr-5 font-mono text-xs text-ink whitespace-nowrap">{c.mrr > 0 ? fmtFull(c.mrr, c.currency) : '—'}</td>
                            <td className="py-3 pr-5 font-mono text-xs font-semibold whitespace-nowrap" style={{ color: '#1A3D2B' }}>{c.arr > 0 ? fmtFull(c.arr, c.currency) : '—'}</td>
                            <td className="py-3 pr-5 font-mono text-xs whitespace-nowrap" style={{ color: c.actualOverage > 0 ? '#0B5C36' : '#9CA3AF' }}>
                              {c.actualOverage > 0 ? `+${fmtFull(c.actualOverage, c.currency)}` : '—'}
                            </td>
                            <td className="py-3 pr-5">
                              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap"
                                style={{ color: statusColor, background: `${statusColor}18` }}>
                                {status}
                              </span>
                            </td>
                            <td className="py-3 pr-5">
                              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                                c.confidence === 'high'   ? 'bg-forest/8 text-forest'
                                : c.confidence === 'medium' ? 'bg-amber-50 text-amber-700'
                                : 'bg-red-50 text-red-700'
                              }`}>
                                {c.confidence}
                              </span>
                            </td>
                            <td className="py-3 text-right">
                              <a href={`/configure/${c.jobId}`}
                                className="text-[10px] text-stone hover:text-forest transition-colors font-medium whitespace-nowrap">
                                View →
                              </a>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Active ARR donut — own card */}
              <div className="bg-white border border-forest/10 rounded-2xl p-6 flex flex-col items-center">
                <p className="text-[10px] font-semibold text-stone uppercase tracking-widest mb-6 self-start">Active ARR by customer</p>
                {donutSegs.length === 0 ? (
                  <p className="text-sm text-stone mt-4">No active contracts</p>
                ) : (
                  <>
                    <svg viewBox="0 0 180 180" width={160} height={160} style={{ display: 'block' }}>
                      {donutSegs.map(seg => <path key={seg.name} d={seg.path} fill={seg.color} />)}
                      <text x={dCx} y={dCy - 6} textAnchor="middle" fontSize={9} fill="#6B6660">Active ARR</text>
                      <text x={dCx} y={dCy + 11} textAnchor="middle" fontSize={13} fontWeight={700} fill="#1A3D2B">
                        {fmtAxis(donutTotal, donutSegs[0]?.cur ?? 'EUR')}
                      </text>
                    </svg>
                    <div className="mt-5 w-full space-y-3">
                      {donutSegs.map(seg => (
                        <div key={seg.name} className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2 min-w-0">
                            <div className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: seg.color }} />
                            <span className="text-xs text-ink truncate">{seg.name}</span>
                          </div>
                          <div className="flex items-center gap-3 flex-shrink-0">
                            <span className="font-mono text-xs font-semibold" style={{ color: seg.color }}>{fmtFull(seg.arr, seg.cur)}</span>
                            <span className="text-[10px] text-stone w-7 text-right">{seg.pct.toFixed(0)}%</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>

            </div>
          </div>

        </div>
      )}
    </div>
  )
}
