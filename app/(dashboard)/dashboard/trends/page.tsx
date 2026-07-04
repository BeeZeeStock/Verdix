import { redirect } from 'next/navigation'
import { supabaseServer } from '@/lib/supabase'
import { getActiveOrg } from '@/lib/org'

// ── Data fetching ──────────────────────────────────────────────────────────

async function getTrendsData(orgId: string) {
  const { data: orgJobs } = await supabaseServer
    .from('jobs')
    .select('id')
    .eq('org_id', orgId)

  const jobIds = (orgJobs ?? []).map(j => j.id)

  if (jobIds.length === 0) return { findings: [] }

  const { data: findings } = await supabaseServer
    .from('leakage_findings')
    .select('leakage_type, leakage_amount, billing_month, priority, customer_name, status')
    .in('job_id', jobIds)

  return { findings: findings ?? [] }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtAxis(n: number) {
  if (n === 0) return '€0'
  if (n >= 1000) return `€${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`
  return `€${n.toFixed(0)}`
}

function fmtFull(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n)
}

function fmtMonthShort(m: string) {
  const [, mo] = m.split('-')
  return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(mo) - 1]
}

function niceMax(v: number): number {
  if (v <= 0) return 1000
  const mag = Math.pow(10, Math.floor(Math.log10(v)))
  return Math.ceil(v / mag) * mag
}

const FINDING_TYPES = ['DISCOUNT_OVERHANG', 'ESCALATOR_MISS', 'OVERAGE_UNBILLED'] as const

const TYPE_LABELS: Record<string, string> = {
  ESCALATOR_MISS:    'Escalator miss',
  DISCOUNT_OVERHANG: 'Discount overhang',
  OVERAGE_UNBILLED:  'Overages not set up',
}

const TYPE_COLOR: Record<string, string> = {
  DISCOUNT_OVERHANG: '#27AE60',
  ESCALATOR_MISS:    '#0F2D1A',
  OVERAGE_UNBILLED:  '#B8E0CC',
}

const CUSTOMER_COLORS = ['#0F2D1A', '#1F7A4A', '#27AE60', '#73C99B', '#B8E0CC', '#4A7C59', '#2D6A4F', '#87B09A']

// ── Page ───────────────────────────────────────────────────────────────────

export default async function TrendsPage() {
  const org = await getActiveOrg()
  if (!org) redirect('/login')
  const { findings } = await getTrendsData(org.orgId)

  const quantified = findings.filter(f => f.leakage_amount > 0)

  // Monthly breakdown: month → { type → amount }
  const monthTypeMap: Record<string, Record<string, number>> = {}
  for (const f of quantified) {
    if (!f.billing_month) continue
    if (!monthTypeMap[f.billing_month]) monthTypeMap[f.billing_month] = {}
    monthTypeMap[f.billing_month][f.leakage_type] =
      (monthTypeMap[f.billing_month][f.leakage_type] ?? 0) + Number(f.leakage_amount)
  }
  const months = Object.keys(monthTypeMap).sort()
  const monthTotals = months.map(m => Object.values(monthTypeMap[m]).reduce((s, v) => s + v, 0))
  const rawMax = Math.max(...monthTotals, 1)
  const yMax = niceMax(rawMax)

  // By finding type (totals)
  const typeMap: Record<string, number> = {}
  for (const f of quantified) typeMap[f.leakage_type] = (typeMap[f.leakage_type] ?? 0) + Number(f.leakage_amount)
  const typeRows = Object.entries(typeMap).sort(([, a], [, b]) => b - a)
  const totalQuantified = typeRows.reduce((s, [, v]) => s + v, 0)

  // By customer
  const customerMap: Record<string, { total: number; open: number }> = {}
  for (const f of findings) {
    if (!customerMap[f.customer_name]) customerMap[f.customer_name] = { total: 0, open: 0 }
    customerMap[f.customer_name].total += Number(f.leakage_amount)
    if (f.status === 'open') customerMap[f.customer_name].open += Number(f.leakage_amount)
  }
  const customerRows = Object.entries(customerMap).sort(([, a], [, b]) => b.total - a.total).slice(0, 8)
  const customerMax = Math.max(...customerRows.map(([, c]) => c.total), 1)

  // Priority totals
  const priorityMap: Record<string, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0 }
  for (const f of quantified) priorityMap[f.priority] = (priorityMap[f.priority] ?? 0) + Number(f.leakage_amount)
  const structuralCount = findings.filter(f => f.leakage_type === 'OVERAGE_UNBILLED').length

  // Donut segments — leakage by customer (no mutable accumulator — RSC safe)
  const donutGrandTotal = customerRows.reduce((s, [, c]) => s + c.total, 0)
  const donutCx = 100, donutCy = 100, donutR = 80, donutInnerR = 52
  const donutSweeps = customerRows.map(([, { total }]) => {
    const raw = donutGrandTotal > 0 ? (total / donutGrandTotal) * 2 * Math.PI : 0
    return Math.min(raw, 2 * Math.PI * 0.9999) // SVG arcs are degenerate at exactly 360°
  })
  const donutStarts = donutSweeps.reduce<number[]>((acc, _, i) => {
    acc.push(i === 0 ? -Math.PI / 2 : acc[i - 1] + donutSweeps[i - 1])
    return acc
  }, [])
  const customerSegments = customerRows.map(([name, { total }], idx) => {
    const a0 = donutStarts[idx]
    const a1 = a0 + donutSweeps[idx]
    const large = donutSweeps[idx] > Math.PI ? 1 : 0
    const x1 = donutCx + donutR * Math.cos(a0),   y1 = donutCy + donutR * Math.sin(a0)
    const x2 = donutCx + donutR * Math.cos(a1),   y2 = donutCy + donutR * Math.sin(a1)
    const ix1 = donutCx + donutInnerR * Math.cos(a1), iy1 = donutCy + donutInnerR * Math.sin(a1)
    const ix2 = donutCx + donutInnerR * Math.cos(a0), iy2 = donutCy + donutInnerR * Math.sin(a0)
    const path = `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${donutR} ${donutR} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} L ${ix1.toFixed(2)} ${iy1.toFixed(2)} A ${donutInnerR} ${donutInnerR} 0 ${large} 0 ${ix2.toFixed(2)} ${iy2.toFixed(2)} Z`
    return { name, total, path, color: CUSTOMER_COLORS[idx % CUSTOMER_COLORS.length], pct: donutGrandTotal > 0 ? (total / donutGrandTotal) * 100 : 0 }
  })

  // ── SVG layout constants ───────────────────────────────────────────────
  const SVG_W    = 900
  const Y_LEFT   = 54
  const X_RIGHT  = 8
  const CHART_W  = SVG_W - Y_LEFT - X_RIGHT
  const CHART_H  = 170
  const X_LBL_H  = 24
  const SVG_H    = CHART_H + X_LBL_H
  const Y_TICKS  = [0, 0.25, 0.5, 0.75, 1]
  const BAR_GAP  = months.length > 18 ? 2 : 4
  const barW     = months.length > 0
    ? Math.max(6, (CHART_W - BAR_GAP * (months.length - 1)) / months.length)
    : 24

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="font-display font-light text-ink text-2xl mb-1">Leakage trends</h1>
        <p className="text-stone text-sm">Revenue leakage over time across all audits</p>
      </div>

      {findings.length === 0 ? (
        <div className="bg-white border border-forest/10 rounded-2xl p-16 text-center">
          <i className="ti ti-chart-line text-stone/25 block mb-4" style={{ fontSize: 40 }} />
          <p className="font-medium text-ink mb-1">No leakage data yet</p>
          <p className="text-sm text-stone">Run a billing check to start seeing trends here.</p>
        </div>
      ) : (
        <div className="space-y-6">

          {/* KPI row */}
          <div className="grid grid-cols-4 gap-4">
            {[
              { label: 'Total quantified',  value: fmtFull(totalQuantified),                                              color: '#1A3D2B' },
              { label: 'Critical',           value: fmtFull(priorityMap.CRITICAL),                                        color: '#1A3D2B' },
              { label: 'High',               value: fmtFull(priorityMap.HIGH),                                            color: '#4A7C59' },
              { label: 'Structural flags',   value: `${structuralCount} item${structuralCount !== 1 ? 's' : ''}`,         color: '#87B09A' },
            ].map(k => (
              <div key={k.label} className="bg-white border border-forest/10 rounded-2xl p-4">
                <p className="text-[10px] font-semibold text-stone uppercase tracking-widest mb-2">{k.label}</p>
                <p className="text-xl font-semibold font-mono" style={{ color: k.color }}>{k.value}</p>
              </div>
            ))}
          </div>

          {/* Charts row: stacked bar + customer donut */}
          <div className="grid grid-cols-2 gap-6">

            {/* Stacked bar chart */}
            <div className="bg-white border border-forest/10 rounded-2xl p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-[10px] font-semibold text-stone uppercase tracking-widest">Monthly leakage by type (EUR)</h2>
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
                        <text x={Y_LEFT - 6} y={y + 3.5} textAnchor="end" fontSize={10} fill="#9CA3AF">
                          {fmtAxis(val)}
                        </text>
                      </g>
                    )
                  })}

                  {months.map((month, i) => {
                    const x = Y_LEFT + i * (barW + BAR_GAP)
                    const breakdown = monthTypeMap[month]
                    const stack = FINDING_TYPES.filter(t => (breakdown[t] ?? 0) > 0)
                    let yOffset = CHART_H
                    return (
                      <g key={month}>
                        {stack.map(type => {
                          const val = breakdown[type] ?? 0
                          const h = Math.max(1, (val / yMax) * CHART_H)
                          yOffset -= h
                          const isTop = type === stack[0]
                          return (
                            <rect key={type} x={x} y={yOffset} width={barW} height={h}
                              rx={isTop ? 2 : 0} ry={isTop ? 2 : 0}
                              fill={TYPE_COLOR[type]} opacity={0.9} />
                          )
                        })}
                        <text x={x + barW / 2} y={CHART_H + 16} textAnchor="middle" fontSize={9} fill="#9CA3AF">
                          {fmtMonthShort(month)}
                        </text>
                      </g>
                    )
                  })}

                  <line x1={Y_LEFT} y1={0} x2={Y_LEFT} y2={CHART_H} stroke="rgba(26,61,43,0.12)" strokeWidth={1} />
                  <line x1={Y_LEFT} y1={CHART_H} x2={SVG_W - X_RIGHT} y2={CHART_H} stroke="rgba(26,61,43,0.12)" strokeWidth={1} />
                </svg>
              )}
            </div>

            {/* Donut chart — leakage by customer */}
            <div className="bg-white border border-forest/10 rounded-2xl p-6 flex flex-col">
              <h2 className="text-[10px] font-semibold text-stone uppercase tracking-widest mb-5">Leakage by customer</h2>
              {customerSegments.length === 0 ? (
                <div className="flex-1 flex items-center justify-center">
                  <p className="text-sm text-stone">No customer data yet.</p>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-6">
                  <div style={{ width: 180, height: 180, flexShrink: 0 }}>
                    <svg viewBox="0 0 200 200" width="180" height="180">
                      {customerSegments.map(seg => (
                        <path key={seg.name} d={seg.path} fill={seg.color} />
                      ))}
                      <text x={donutCx} y={donutCy - 6} textAnchor="middle" fontSize={11} fill="#6B6660">Total</text>
                      <text x={donutCx} y={donutCy + 10} textAnchor="middle" fontSize={14} fontWeight={600} fill="#1A3D2B">
                        {fmtFull(donutGrandTotal)}
                      </text>
                    </svg>
                  </div>
                  <div className="w-full space-y-2.5">
                    {customerSegments.map(seg => (
                      <div key={seg.name} className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: seg.color }} />
                          <span className="text-xs text-ink truncate">{seg.name}</span>
                        </div>
                        <div className="flex items-center gap-3 flex-shrink-0">
                          <span className="font-mono text-xs font-semibold" style={{ color: seg.color }}>{fmtFull(seg.total)}</span>
                          <span className="text-[10px] text-stone w-8 text-right">{seg.pct.toFixed(0)}%</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

          </div>

          {/* By type + By customer */}
          <div className="grid grid-cols-2 gap-6">

            <div className="bg-white border border-forest/10 rounded-2xl p-6">
              <h2 className="text-[10px] font-semibold text-stone uppercase tracking-widest mb-5">By finding type</h2>
              <div className="space-y-5">
                {typeRows.map(([type, value]) => {
                  const pct = totalQuantified > 0 ? (value / totalQuantified) * 100 : 0
                  const color = TYPE_COLOR[type] ?? '#6B7280'
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
                      <p className="text-[10px] text-stone mt-1">{pct.toFixed(0)}% of total quantified leakage</p>
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="bg-white border border-forest/10 rounded-2xl p-6">
              <h2 className="text-[10px] font-semibold text-stone uppercase tracking-widest mb-5">Top customers by leakage</h2>
              <div className="space-y-0">
                {customerRows.length === 0 && <p className="text-sm text-stone">No data yet.</p>}
                {customerRows.map(([name, { total, open }], idx) => {
                  const color = CUSTOMER_COLORS[idx % CUSTOMER_COLORS.length]
                  const barPct = customerMax > 0 ? (total / customerMax) * 100 : 0
                  return (
                    <div key={name} className="py-3 border-b border-forest/6 last:border-0">
                      <div className="flex items-center justify-between mb-1.5">
                        <p className="text-sm font-medium text-ink truncate max-w-[55%]">{name}</p>
                        <span className="font-mono text-sm font-semibold ml-2 flex-shrink-0" style={{ color }}>
                          {fmtFull(total)}
                        </span>
                      </div>
                      <div className="h-1.5 bg-stone/10 rounded-full overflow-hidden mb-1">
                        <div className="h-full rounded-full" style={{ width: `${barPct}%`, background: color }} />
                      </div>
                      <p className="text-[10px] text-stone">
                        {open > 0 ? `${fmtFull(open)} open` : 'All resolved'}
                      </p>
                    </div>
                  )
                })}
              </div>
            </div>

          </div>
        </div>
      )}
    </div>
  )
}
