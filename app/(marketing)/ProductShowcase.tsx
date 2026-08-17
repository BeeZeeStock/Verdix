'use client'

import { useEffect, useRef, useState } from 'react'
import { VerdixLogo } from '@/components/VerdixLogo'
import styles from './landing.module.css'

const TABS = [
  { id: 'p1', label: '1 · Extract' },
  { id: 'p3', label: '2 · Configure billing' },
  { id: 'p2', label: '3 · Commercial logic' },
  { id: 'p4', label: '4 · Review & approve' },
  { id: 'p5', label: 'Graphical view' },
] as const

type TabId = typeof TABS[number]['id']

function DashboardIcon() { return <svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg> }
function TrendIcon() { return <svg viewBox="0 0 24 24"><path d="M3 17l6-6 4 4 8-8" /></svg> }
function DocIcon() { return <svg viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h5" /></svg> }
function BarsIcon() { return <svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V5M16 20v-7M22 20H2" /></svg> }
function CheckDocIcon() { return <svg viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8.5 13.5l2.5 2.5 4.5-5" /></svg> }
function PlusIcon() { return <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg> }
function BoltIcon() { return <svg viewBox="0 0 24 24"><path d="M13 2L4 14h6l-1 8 9-12h-6z" /></svg> }
function PartnerDocIcon() { return <svg viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6M9 12h6M9 16h3" /></svg> }
function CompassIcon() { return <svg viewBox="0 0 24 24"><path d="M5 19l4-9 9-4-4 9z" /><circle cx="12" cy="12" r="1.6" /></svg> }
function GearIcon() { return <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /></svg> }
function CheckCircleIcon() { return <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M8.5 12.5l2.5 2.5 4.5-5" /></svg> }
function WarnTriIcon() { return <svg viewBox="0 0 24 24"><path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17v.5" /></svg> }

function AppTopBar() {
  return (
    <div className={styles.appbar}>
      <span className={styles.back}>← Back</span>
      <div className={styles.appbarT}><span className={styles.pii}>Avtal-CoAccept-Remembill-Fenix-Forsakring-SMS</span> <i className={styles.pii}>· Fenix Försäkring AB</i></div>
      <div className={styles.vtabs}><span className={`${styles.vtab} ${styles.on}`}>Contract ·<br />Commercials</span><span className={styles.vtab}>Graphical<br />view</span></div>
      <span className={styles.cfg}><CheckCircleIcon />Fixed fees configured in<br />Remembill</span>
    </div>
  )
}

function Sidebar() {
  const groups: Array<{ label: string; items: Array<{ icon: React.ReactNode; label: string; on?: boolean }> }> = [
    { label: 'Insights', items: [
      { icon: <DashboardIcon />, label: 'Dashboard' },
      { icon: <TrendIcon />, label: 'Leakage trends' },
      { icon: <DocIcon />, label: 'Agreements' },
      { icon: <BarsIcon />, label: 'Partner trends' },
    ] },
    { label: 'Verification', items: [
      { icon: <CheckDocIcon />, label: 'Billing checks' },
      { icon: <PlusIcon />, label: 'New verification' },
    ] },
    { label: 'Auto-configure', items: [
      { icon: <BoltIcon />, label: 'New contracts', on: true },
      { icon: <PlusIcon />, label: 'Upload contract' },
    ] },
    { label: 'Partner recon', items: [
      { icon: <PartnerDocIcon />, label: 'Partner checks' },
      { icon: <PlusIcon />, label: 'New reconciliation' },
    ] },
    { label: 'Account', items: [
      { icon: <CompassIcon />, label: 'Setup guide' },
      { icon: <GearIcon />, label: 'Settings' },
    ] },
  ]
  return (
    <aside className={styles.side}>
      <div className={styles.sideBrand}><VerdixLogo size={24} />Verdix</div>
      {groups.map(g => (
        <div key={g.label}>
          <div className={styles.sideGrp}>{g.label}</div>
          {g.items.map(item => (
            <div key={item.label} className={item.on ? `${styles.sideI} ${styles.on}` : styles.sideI}>{item.icon}{item.label}</div>
          ))}
        </div>
      ))}
      <div className={styles.sideUser}>
        <span className={styles.av}>B</span>
        <div><b className={styles.pii}>Bilal Zahoor</b><i className={styles.pii}>bilal@lynoraai.com</i></div>
      </div>
    </aside>
  )
}

function PanelExtract({ onReviewClick }: { onReviewClick: () => void }) {
  const fields: Array<{ label: string; value: string; sub?: string; mono?: boolean; pii?: boolean; muted?: boolean; accent?: boolean }> = [
    { label: 'Contract ID / number', value: 'cus_123', mono: true, pii: true },
    { label: 'CRM ID', value: '—', muted: true },
    { label: 'Customer name', value: 'Fenix Försäkring AB', pii: true },
    { label: 'Customer billing address', value: 'Riddargatan 8, 114 57 Stockholm', pii: true },
    { label: 'Customer invoice email', value: 'bilal@lynoraai.com', pii: true },
    { label: 'Customer org / reg number', value: '1234-567', mono: true, pii: true },
    { label: 'Currency', value: 'SEK' },
    { label: 'Contract term', value: '12 months', sub: '11 Aug 2026 – 10 Aug 2027' },
    { label: 'Billing schedule', value: 'Base: monthly in advance', sub: 'SMS usage: quarterly in arrears' },
    { label: 'Payment terms', value: '30 days net from invoice date' },
    { label: 'Auto-renewal', value: 'Yes', sub: '90 days notice required' },
    { label: 'Fixed fees', value: 'SEK 94,800.00', sub: 'Base subscription + one-time integration fee', accent: true },
  ]
  return (
    <>
      <div className={styles.pane}>
        <div className={styles.brief}>
          <div className={styles.paneL} style={{ color: 'var(--color-sage)' }}>Contract brief</div>
          <p>12-month contract with <span className={styles.pii}>Fenix Försäkring AB</span>, running 11 Aug 2026 to 10 Aug 2027 — SEK 6,900.00/month base subscription plus a SEK 12,000.00 one-time integration fee.</p>
          <p>Base fee billed monthly in advance · SMS usage billed quarterly in arrears · 30 days net from invoice date · auto-renews (90-day notice required).</p>
          <p>AI extraction complete · human review required for 4 commercial decisions.</p>
        </div>
        <div className={styles.flagbar}>
          <WarnTriIcon />
          <div><b>4 contract terms need confirmation</b><i>Review these items against the source agreement before approving.</i></div>
          <button onClick={onReviewClick} style={{ marginLeft: 'auto', font: 'inherit', fontSize: 12, fontWeight: 500, color: 'var(--color-warn)', background: 'none', border: 0, cursor: 'pointer', whiteSpace: 'nowrap' }}>Review items →</button>
        </div>
      </div>
      <div className={styles.pane}>
        <div className={`${styles.paneH} ${styles.br}`}><span className={styles.paneL}>Contract overview</span></div>
        <div className={styles.grid3}>
          {fields.map(f => (
            <div key={f.label}>
              <div className={styles.fL}>{f.label}</div>
              <div className={styles.fV} style={f.mono ? { fontFamily: 'var(--font-mono)' } : f.muted ? { color: 'var(--color-stone-light)' } : f.accent ? { color: 'var(--color-forest)' } : undefined}>
                <span className={f.pii ? styles.pii : undefined}>{f.value}</span>
              </div>
              {f.sub && <div className={styles.fS}>{f.sub}</div>}
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

function PanelCommercialLogic() {
  return (
    <>
      <div className={styles.pane}>
        <div className={`${styles.paneH} ${styles.br}`}><span className={styles.paneL}>Commercial terms</span><span className={`${styles.badge} ${styles.bBlue} ${styles.spacer}`}>Hybrid — Fixed + Consumption</span></div>
        <div className={styles.paneH} style={{ paddingBottom: 0 }}><span className={styles.paneL}>Confirmed rules</span></div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, padding: '12px 18px 4px' }}>
          <div style={{ border: '1px solid #CFE3D5', borderRadius: 12, background: '#F2F8F3', padding: '15px 16px' }}>
            <div className={styles.fL}>Minimum charge floor</div>
            <div className={styles.fV} style={{ fontSize: 19, color: 'var(--color-ink)', margin: '2px 0 8px' }}>SEK 5,000.00 / calendar quarter</div>
            <div className={styles.tierS}>Applies to: <b style={{ fontWeight: 600, color: 'var(--color-ink)' }}>SMS reminder</b></div>
            <div className={styles.tierS}>Allowance treatment: <b style={{ fontWeight: 600, color: 'var(--color-ink)' }}>First 500 SMS reminder included before minimum evaluation.</b></div>
            <div className={styles.tierS}>Partial-quarter treatment: <b style={{ fontWeight: 600, color: 'var(--color-ink)' }}>Prorated</b></div>
            <div className={styles.tierS} style={{ marginTop: 8 }}>Status: <b style={{ color: 'var(--color-sage)' }}>Confirmed</b> by reviewer · 16 Aug 2026</div>
            <div className={styles.rateHint} style={{ marginTop: 8 }}>View source ↗ · Edit interpretation</div>
          </div>
          <div style={{ border: '1px solid #CFE3D5', borderRadius: 12, background: '#F2F8F3', padding: '15px 16px' }}>
            <div className={styles.fL}>Price escalation</div>
            <div className={styles.tierS} style={{ marginTop: 4 }}>Source term: <b style={{ fontWeight: 600, color: 'var(--color-ink)' }}>CPI cap-linked escalation detected</b></div>
            <div className={styles.fV} style={{ fontSize: 19, color: 'var(--color-ink)', margin: '6px 0 8px' }}>Operational treatment: Not applied</div>
            <div className={styles.tierS}>Reviewer decision: exclude the escalation clause.</div>
            <div className={styles.tierS} style={{ marginTop: 8 }}>Status: <b style={{ color: 'var(--color-sage)' }}>Confirmed</b> by reviewer · 16 Aug 2026</div>
            <div className={styles.rateHint} style={{ marginTop: 8 }}>View source ↗ · Edit interpretation</div>
          </div>
        </div>
        <div className={`${styles.paneH} ${styles.br}`} style={{ paddingBottom: 0, borderTop: '1px solid var(--color-line-soft)', marginTop: 14, paddingTop: 16, borderBottom: 'none' }}><span className={styles.paneL}>Charging parameters</span><span className={`${styles.clause} ${styles.spacer}`}>§4.2</span></div>
        <div className={styles.paneH} style={{ paddingTop: 8, paddingBottom: 0 }}><span className={styles.paneL} style={{ color: 'var(--color-stone)' }}>SMS reminder</span><span className={`${styles.tierS} ${styles.spacer}`}>Calculation: <b style={{ fontWeight: 600, color: 'var(--color-ink)' }}>Graduated / staircase</b></span></div>
        <div className={styles.tiers}>
          <div><div className={styles.tierL}>SMS reminders 1–500 — included in base fee</div><div className={styles.tierV}>SEK 0.00 <span>/ SMS reminder</span></div><div className={styles.tierS}>From unit 1 to 500</div></div>
          <div><div className={styles.tierL}>SMS reminders 501–2,000 — overage</div><div className={styles.tierV}>SEK 1.10 <span>/ SMS reminder</span></div><div className={styles.tierS}>From unit 501 to 2,000</div></div>
          <div><div className={styles.tierL}>SMS reminders 2,001+ — overage</div><div className={styles.tierV}>SEK 0.85 <span>/ SMS reminder</span></div><div className={styles.tierS}>From unit 2,001+</div></div>
        </div>
      </div>
      <div className={styles.pane}>
        <div className={`${styles.paneH} ${styles.br}`}><span className={styles.paneL}>Price escalations</span><span className={`${styles.clause} ${styles.spacer}`}>§6.</span></div>
        <div style={{ padding: 18, display: 'flex', gap: 44, flexWrap: 'wrap' }}>
          <div style={{ background: 'var(--color-panel)', borderRadius: 12, padding: '14px 16px', opacity: .75 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}><span className={styles.fL}>CPI_cap</span><span className={styles.badge} style={{ background: '#EFEDE7', color: 'var(--color-stone)' }}>Source extraction · inactive</span></div>
            <div className={styles.fV} style={{ display: 'flex', alignItems: 'center', gap: 9, color: 'var(--color-stone)', marginTop: 10 }}><span style={{ display: 'inline-block', width: 22, height: 3, background: 'var(--color-sage)', borderRadius: 2 }} />per year</div>
            <div className={styles.fS}>Effective 11 Aug 2027</div>
          </div>
        </div>
      </div>
      <div className={styles.pane}>
        <div className={`${styles.paneH} ${styles.br}`}><span className={styles.paneL}>Pricing</span></div>
        <div style={{ padding: 18 }}><div className={styles.fL}>Monthly fee</div><div className={styles.fV} style={{ fontSize: 26, color: 'var(--color-forest)', marginTop: 4 }}>SEK 6,900.00 <span style={{ fontSize: 13, fontWeight: 450, color: 'var(--color-stone)' }}>/ month</span></div></div>
      </div>
    </>
  )
}

function PanelConfigureBilling() {
  const options = [
    { title: 'Minimum charge floor', desc: 'Apply the included allowance first, then charge the greater of the calculated usage charge or the minimum.', selected: true },
    { title: 'Minimum applies before allowance', desc: 'The minimum covers all usage, including units that would otherwise be included free.' },
    { title: 'Additive fee', desc: 'Charge the minimum in addition to the calculated usage charge, regardless of amount.' },
    { title: 'Other / describe treatment', desc: 'Tell Verdix how this should work in your own words.' },
  ]
  return (
    <div className={styles.pane}>
      <div className={`${styles.paneH} ${styles.br}`}><span className={styles.paneL}>Review contract terms</span><p className={styles.paneSub}>0 of 4 confirmed</p></div>
      <div style={{ padding: '16px 18px', display: 'grid', gridTemplateColumns: '1fr 1.2fr', gap: 18, alignItems: 'start' }}>
        <div>
          <div style={{ border: '1px solid #EBDFC4', borderRadius: 12, background: '#FEF6E7', padding: '14px 15px' }}>
            <div className={styles.fL} style={{ color: 'var(--color-warn)' }}>Confirm this term</div>
            <div style={{ fontSize: 13.5, color: 'var(--color-warn)', marginTop: 5, lineHeight: 1.5 }}>Confirm how the SEK 5,000.00 minimum for SMS reminders interacts with the included allowance — a usage floor (bill the greater of usage or the minimum).</div>
          </div>
          <div className={styles.tierS} style={{ marginTop: 11 }}><b style={{ fontWeight: 600 }}>Why review:</b> the contract states a SEK 5,000 minimum per calendar quarter for SMS reminders but does not clarify whether the minimum applies before or after the 500 included units are consumed.</div>
        </div>
        <div>
          <div className={styles.fL} style={{ marginBottom: 9 }}>How should this rule be applied?</div>
          <div style={{ display: 'grid', gap: 9 }}>
            {options.map(o => (
              <div key={o.title} style={{ border: o.selected ? '1px solid #CFE3D5' : '1px solid var(--color-line)', borderRadius: 10, padding: '12px 14px', display: 'flex', gap: 11, alignItems: 'flex-start', background: o.selected ? '#F2F8F3' : '#fff' }}>
                <span style={{ flex: 'none', width: 15, height: 15, borderRadius: '50%', border: o.selected ? '4.5px solid var(--color-sage)' : '1.5px solid var(--color-line)', marginTop: 2 }} />
                <div><b style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-ink)' }}>{o.title}</b><div className={styles.tierS} style={{ marginTop: 2 }}>{o.desc}</div></div>
              </div>
            ))}
          </div>
          <p className={styles.tierS} style={{ marginTop: 10 }}>Confirm each term against its source clause, or edit it before approving.</p>
        </div>
      </div>
    </div>
  )
}

type TimelineRow =
  | { kind: 'entry'; title: string; sub: string; amount?: string; status: string; now?: boolean; warn?: boolean }
  | { kind: 'table'; floor: string; billable: string }

function PanelReviewApprove() {
  const rows: TimelineRow[] = [
    { kind: 'entry', title: 'Aug 2026', sub: 'Issued 11 Aug 2026', amount: 'SEK 6,900.00', status: 'sent' },
    { kind: 'entry', title: 'Start-up and system integration fee', sub: 'Issued 11 Aug 2026', amount: 'SEK 12,000.00', status: 'sent' },
    { kind: 'entry', title: 'TODAY', sub: '16 Aug 2026', now: true, status: '' },
    { kind: 'entry', title: 'Sept 2026', sub: 'Will be issued 11 Sept 2026', amount: 'SEK 6,900.00', status: 'Draft' },
    { kind: 'entry', title: 'Q3 2026 · SMS reminder usage', sub: 'Awaiting usage 30 Sept 2026', status: 'Scheduled', warn: true },
    { kind: 'table', floor: 'SEK 2,771.74', billable: 'SEK 2,771.74' },
    { kind: 'entry', title: 'Oct 2026', sub: 'Will be issued 11 Oct 2026', amount: 'SEK 6,900.00', status: 'Draft' },
    { kind: 'entry', title: 'Nov 2026', sub: 'Will be issued 11 Nov 2026', amount: 'SEK 6,900.00', status: 'Draft' },
    { kind: 'entry', title: 'Dec 2026', sub: 'Will be issued 11 Dec 2026', amount: 'SEK 6,900.00', status: 'Draft' },
    { kind: 'entry', title: 'Q4 2026 · SMS reminder usage', sub: 'Awaiting usage 31 Dec 2026', status: 'Scheduled', warn: true },
    { kind: 'table', floor: 'SEK 5,000.00', billable: 'SEK 5,000.00' },
    { kind: 'entry', title: 'Jan 2027', sub: 'Will be issued 11 Jan 2027', amount: 'SEK 6,900.00', status: 'Draft' },
    { kind: 'entry', title: 'Feb 2027', sub: 'Will be issued 11 Feb 2027', amount: 'SEK 6,900.00', status: 'Draft' },
  ]
  return (
    <div className={styles.pane}>
      <div className={`${styles.paneH} ${styles.br}`}>
        <span className={styles.paneL}>Billing setup</span>
        <p className={styles.paneSub}>Invoice schedule managed via Remembill</p>
        <span className={`${styles.cfg} ${styles.spacer}`}><CheckCircleIcon />Active</span>
        <button className={styles.gbtn}>↻ Refresh payments</button>
        <button className={`${styles.gbtn} ${styles.plain}`}>↻ Refresh</button>
      </div>
      <div className={styles.paneH} style={{ paddingBottom: 4 }}><span className={styles.paneL}>Billing timeline</span></div>
      <div className={styles.tl}>
        {rows.map((r, i) => r.kind === 'table' ? (
          <div key={i} style={{ margin: '2px 0 12px 22px', border: '1px solid var(--color-line)', borderRadius: 11, overflow: 'hidden' }}>
            <table className={styles.g} style={{ margin: 0 }}>
              <thead><tr><th>Description</th><th className={styles.r}>Qty</th><th className={styles.r}>Unit price</th><th className={styles.r}>Total</th></tr></thead>
              <tbody>
                <tr><td>Minimum floor</td><td className={styles.r}>—</td><td className={styles.r}>—</td><td className={styles.r}>{r.floor}</td></tr>
                <tr><td>Usage charge — quarterly in arrears</td><td className={styles.r}>—</td><td className={styles.r}>—</td><td className={styles.r} style={{ fontStyle: 'italic', color: 'var(--color-stone)' }}>Pending usage</td></tr>
                <tr><td className={styles.b}>Billable amount</td><td className={styles.r}>—</td><td className={styles.r}>—</td><td className={styles.r} style={{ fontStyle: 'italic', color: 'var(--color-warn)', fontWeight: 600 }}>Pending usage — at least {r.billable}</td></tr>
                <tr><td colSpan={4} style={{ color: 'var(--color-stone)' }}>Partial-quarter treatment: Prorated by days</td></tr>
              </tbody>
            </table>
          </div>
        ) : (
          <div key={i} className={styles.tlR}>
            <span className={r.now ? `${styles.tlD} ${styles.now}` : styles.tlD} />
            <div className={styles.tlT}><b style={r.now ? { fontSize: 10, letterSpacing: '.11em', color: 'var(--color-forest)' } : undefined}>{r.title}</b><i>{r.sub}</i></div>
            {r.amount && <div className={styles.tlA}><b>{r.amount}</b><span className={`${styles.tlS} ${r.status === 'sent' ? styles.sent : ''}`}>{r.status}</span></div>}
            {!r.amount && r.status && <div className={styles.tlA}><b style={r.warn ? { color: 'var(--color-warn)' } : undefined}>Pending usage</b><span className={styles.tlS}>{r.status}</span></div>}
          </div>
        ))}
      </div>
    </div>
  )
}

function BarChart({ title, sub, yAxis, bars, xLabels, note }: {
  title: string; sub: string; yAxis: string[]
  bars: Array<{ value: string; heightPx: number; marginBottomPx?: number; className: string; style?: React.CSSProperties }>
  xLabels: Array<{ label: string; sub?: string }>
  note?: string
}) {
  return (
    <div className={styles.pane}>
      <div className={styles.chart}>
        <div className={styles.chartTop}><span className={styles.paneL}>{title}</span><p className={styles.paneSub}>{sub}</p></div>
        <div className={styles.plot}>
          <div className={styles.yax}>{yAxis.map(y => <span key={y}>{y}</span>)}</div>
          <div>
            <div className={styles.bars}>
              {bars.map((b, i) => (
                <div key={i} className={styles.bcol}>
                  <span className={styles.bval} style={b.marginBottomPx ? { marginBottom: 0 } : undefined}>{b.value}</span>
                  <div className={`${styles.bar} ${b.className}`} style={{ height: b.heightPx, marginBottom: b.marginBottomPx, ...b.style }} />
                </div>
              ))}
            </div>
            <div className={styles.xax}>
              {xLabels.map(x => (
                <div key={x.label} className={styles.xl}><b>{x.label}</b>{x.sub && <i>{x.sub}</i>}</div>
              ))}
            </div>
          </div>
        </div>
        {note && <p className={styles.xs} style={{ padding: '12px 4px 0' }}>{note}</p>}
      </div>
    </div>
  )
}

function PanelGraphicalView() {
  const stats: Array<{ group: string; cards: Array<{ label: string; value: string; color?: string; sub: string }> }> = [
    { group: 'Contracted fixed revenue', cards: [
      { label: 'Base recurring fees', value: 'SEK 82,800.00', color: 'var(--color-forest)', sub: 'SEK 6,900.00/month · contracted recurring' },
      { label: 'One-time fees', value: 'SEK 12,000.00', color: 'var(--color-stone)', sub: 'Start-up and system integration fee' },
      { label: 'Fixed fees', value: 'SEK 94,800.00', color: 'var(--color-forest)', sub: 'Base recurring + one-time' },
    ] },
  ]
  const commitment = [
    { label: 'SMS reminder minimum commitment', value: 'SEK 20,000.00', color: '#C08A3E', sub: 'SEK 5,000.00 / quarterly · minimum floor — actual revenue may be higher' },
    { label: 'Minimum committed contract value', value: 'SEK 114,800.00', color: 'var(--color-forest)', sub: 'Fixed fees + confirmed SMS reminder minimum' },
  ]
  const upside = [
    { label: 'SMS reminder above minimum', value: 'SEK 0.00', color: '#22A85A', sub: '0 / quarter · based on scenario' },
    { label: 'Projected contract value', value: 'SEK 114,800.00', color: 'var(--color-forest)', sub: 'Fixed fees + minimum commitment + usage upside' },
  ]
  return (
    <>
      <BarChart
        title="Minimum recurring contract value"
        sub="Actual SMS reminder revenue can exceed the minimum based on usage."
        yAxis={['SEK 103k', 'SEK 51k', 'SEK 0']}
        bars={[
          { value: 'SEK 83k', heightPx: 121, className: '', style: { height: 121, background: '#7CC79B', borderRadius: 5 } },
          { value: 'SEK 20k', heightPx: 29, marginBottomPx: 105, className: styles.amber },
          { value: 'SEK 103k', heightPx: 150, className: styles.dark },
        ]}
        xLabels={[{ label: 'Base recurring' }, { label: 'SMS reminder minimum commitment' }, { label: 'Minimum recurring value' }]}
        note="* Assumes the confirmed partial-period treatment (prorated by days) across all 5 quarter windows this contract touches."
      />
      {stats.map(g => (
        <div key={g.group}>
          <div className={styles.paneH} style={{ padding: '2px 4px' }}><span className={styles.paneL}>{g.group}</span></div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 14 }}>
            {g.cards.map(c => (
              <div key={c.label} className={styles.pane} style={{ padding: '16px 18px' }}>
                <div className={styles.fL}>{c.label}</div>
                <div className={styles.fV} style={{ fontSize: 24, margin: '4px 0 5px', color: c.color }}>{c.value}</div>
                <div className={styles.xs}>{c.sub}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
      <div className={styles.paneH} style={{ padding: '2px 4px' }}><span className={styles.paneL}>Recurring commercial commitment</span></div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        {commitment.map(c => (
          <div key={c.label} className={styles.pane} style={{ padding: '16px 18px' }}>
            <div className={styles.fL}>{c.label}</div>
            <div className={styles.fV} style={{ fontSize: 24, margin: '4px 0 5px', color: c.color }}>{c.value}</div>
            <div className={styles.xs}>{c.sub}</div>
          </div>
        ))}
      </div>
      <div className={styles.paneH} style={{ padding: '2px 4px' }}><span className={styles.paneL}>Usage upside</span></div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        {upside.map(c => (
          <div key={c.label} className={styles.pane} style={{ padding: '16px 18px' }}>
            <div className={styles.fL}>{c.label}</div>
            <div className={styles.fV} style={{ fontSize: 24, margin: '4px 0 5px', color: c.color }}>{c.value}</div>
            <div className={styles.xs}>{c.sub}</div>
          </div>
        ))}
      </div>
      <BarChart
        title="Contract value &amp; billing progress"
        sub=""
        yAxis={['SEK 115k', 'SEK 57k', 'SEK 0']}
        bars={[
          { value: 'SEK 19k', heightPx: 25, className: styles.bright },
          { value: 'SEK 76k', heightPx: 99, marginBottomPx: 25, className: styles.ghost },
          { value: 'SEK 20k', heightPx: 26, marginBottomPx: 108, className: '', style: { height: 26, marginBottom: 108, background: '#FBEFDC', border: '1px dashed #E0BE86', borderRadius: 5 } },
          { value: 'SEK 115k', heightPx: 150, className: styles.dark },
        ]}
        xLabels={[
          { label: 'Billed to date', sub: '1 mo elapsed' },
          { label: 'Remaining fixed fees', sub: 'contracted' },
          { label: 'Unbilled minimum commitment' },
          { label: 'Committed contract value' },
        ]}
        note="* Committed contract value includes the confirmed SMS reminder minimum commitment over the initial term, based on the confirmed partial-period treatment. Actual contract value can be higher based on usage."
      />
    </>
  )
}

export function ProductShowcase() {
  const [active, setActive] = useState<TabId>('p1')
  const [paused, setPaused] = useState(false)
  const [visible, setVisible] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      entries => entries.forEach(e => setVisible(e.isIntersecting)),
      { threshold: 0.25 },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (paused || !visible) return
    const interval = setInterval(() => {
      setActive(prev => {
        const i = TABS.findIndex(t => t.id === prev)
        return TABS[(i + 1) % TABS.length].id
      })
    }, 4000)
    return () => clearInterval(interval)
  }, [paused, visible])

  const selectTab = (id: TabId) => { setPaused(true); setActive(id) }

  return (
    <div ref={containerRef} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      <div className={styles.tabs} role="tablist">
        {TABS.map(t => (
          <button
            key={t.id}
            className={styles.tab}
            role="tab"
            aria-selected={active === t.id}
            onClick={() => selectTab(t.id)}
            style={active === t.id ? { background: '#fff', color: 'var(--color-forest)', fontWeight: 500, boxShadow: '0 1px 2px rgba(26,61,43,.08)' } : undefined}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className={styles.app}>
        <Sidebar />
        <div className={`${styles.main} ${styles.panel}`}>
          <AppTopBar />
          <div className={styles.body}>
            {active === 'p1' && <PanelExtract onReviewClick={() => selectTab('p3')} />}
            {active === 'p2' && <PanelCommercialLogic />}
            {active === 'p3' && <PanelConfigureBilling />}
            {active === 'p4' && <PanelReviewApprove />}
            {active === 'p5' && <PanelGraphicalView />}
          </div>
        </div>
      </div>
    </div>
  )
}
