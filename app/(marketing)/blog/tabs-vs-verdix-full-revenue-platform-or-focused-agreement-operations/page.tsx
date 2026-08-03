import Link from 'next/link'
import { VerdixLogo } from '@/components/VerdixLogo'

export const metadata = {
  title: 'Tabs vs Verdix: full revenue platform or focused agreement operations? | Verdix',
  description:
    'Compare Tabs and Verdix across contract interpretation, usage billing, invoicing, collections, revenue recognition, existing-system integration and partner reconciliation.',
}

// ── Icon primitive ─────────────────────────────────────────────────────────────

function Ico({ d, size = 16, stroke = 'currentColor', sw = 1.75 }: { d: string; size?: number; stroke?: string; sw?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={stroke} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  )
}

// ── Diagram 1: Feature comparison table ───────────────────────────────────────

const COMPARISON_ROWS = [
  { area: 'Starting point',             tabs: 'Signed customer contract',                   verdix: 'Signed customer or partner agreement',        verdixStrong: false },
  { area: 'Contract interpretation',    tabs: 'Yes, via Contract Agent',                    verdix: 'Yes',                                         verdixStrong: false },
  { area: 'Billing schedules',          tabs: 'Generated within Tabs',                      verdix: 'Generated and sent to chosen system',         verdixStrong: false },
  { area: 'Usage model',                tabs: 'Real-time ingestion and CSV upload',         verdix: 'Retrieval from operational endpoints',        verdixStrong: false },
  { area: 'Invoice generation',         tabs: 'Native',                                     verdix: 'Via existing billing platform',               verdixStrong: false },
  { area: 'Collections',                tabs: 'Native collections and dunning',             verdix: 'Remains in existing finance stack',           verdixStrong: false },
  { area: 'Revenue recognition',        tabs: 'Native ASC 606 workflows',                   verdix: 'Not primary focus',                           verdixStrong: false },
  { area: 'Accounting integrations',    tabs: 'Native ERP and accounting integrations',     verdix: 'Sends approved outputs to existing systems',  verdixStrong: false },
  { area: 'Partner reconciliation',     tabs: 'Not a positioned core capability',           verdix: 'Core workflow',                               verdixStrong: true  },
  { area: 'Platform approach',          tabs: 'Unified revenue platform',                   verdix: 'Focused agreement-operations layer',          verdixStrong: true  },
]

function ComparisonTable() {
  return (
    <div style={{ margin: '28px -4px', borderRadius: 14, overflow: 'hidden', border: '0.5px solid rgba(26,61,43,0.13)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr 1fr' }}>

        {/* Column headers */}
        <div style={{ padding: '10px 14px', background: '#F5F3EE', borderBottom: '0.5px solid rgba(26,61,43,0.1)', borderRight: '0.5px solid rgba(26,61,43,0.08)' }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#9A9490' }}>Area</span>
        </div>
        <div style={{ padding: '10px 14px', background: '#3A3530', borderBottom: '0.5px solid rgba(255,255,255,0.06)', borderRight: '0.5px solid rgba(255,255,255,0.05)' }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#9A9490' }}>Tabs</span>
        </div>
        <div style={{ padding: '10px 14px', background: '#27AE60', borderBottom: '0.5px solid rgba(255,255,255,0.15)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#EAF3DE' }}>Verdix</span>
            <span style={{ fontSize: 8.5, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.05em', background: '#C4E0B2', color: '#1A3D2B', padding: '2px 5px', borderRadius: 4 }}>Verdix</span>
          </div>
        </div>

        {/* Data rows */}
        {COMPARISON_ROWS.map((r, i) => {
          const isLast         = i === COMPARISON_ROWS.length - 1
          const even           = i % 2 === 0
          const rowBorderLight = isLast ? 'none' : '0.5px solid rgba(26,61,43,0.07)'
          const rowBorderDark  = isLast ? 'none' : '0.5px solid rgba(255,255,255,0.05)'
          const rowBorderGreen = isLast ? 'none' : '0.5px solid rgba(39,174,96,0.12)'
          return (
            <div key={i} style={{ display: 'contents' }}>
              <div style={{ padding: '9px 14px', background: even ? '#FAFAF8' : '#fff', borderBottom: rowBorderLight, borderRight: '0.5px solid rgba(26,61,43,0.07)', display: 'flex', alignItems: 'center' }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: '#6B6660' }}>{r.area}</span>
              </div>
              <div style={{ padding: '9px 14px', background: even ? '#3E3B38' : '#3A3530', borderBottom: rowBorderDark, borderRight: '0.5px solid rgba(255,255,255,0.04)', display: 'flex', alignItems: 'center' }}>
                <span style={{ fontSize: 11.5, color: '#A8A4A0', lineHeight: 1.4 }}>{r.tabs}</span>
              </div>
              <div style={{ padding: '9px 14px', background: even ? '#E8F5EC' : '#F0FAF3', borderBottom: rowBorderGreen, display: 'flex', alignItems: 'center' }}>
                <span style={{ fontSize: 11.5, color: '#1A3D2B', fontWeight: r.verdixStrong ? 600 : 400, lineHeight: 1.4 }}>{r.verdix}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Diagram 2: Architectural pipelines ────────────────────────────────────────

const TABS_CHAIN = [
  { label: 'Contract',            bg: '#3A3530', text: '#D1CEC9' },
  { label: 'Usage',               bg: '#4A4540', text: '#D1CEC9' },
  { label: 'Invoice',             bg: '#5A5550', text: '#D1CEC9' },
  { label: 'Collection',          bg: '#6B6660', text: '#E5E2DD' },
  { label: 'Revenue recognition', bg: '#7A7570', text: '#EDEAE6' },
]

const VERDIX_CHAIN = [
  { label: 'Signed agreement',    bg: '#1A3D2B', text: '#EAF3DE' },
  { label: 'Operational data',    bg: '#1F7A4A', text: '#EAF3DE' },
  { label: 'Approved instruction',bg: '#27AE60', text: '#fff'    },
  { label: 'Finance system',      bg: '#B8E0CC', text: '#1A3D2B' },
]

function ArchitecturePipelines() {
  const renderChain = (steps: typeof TABS_CHAIN, label: string, badge?: boolean) => (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#9A9490' }}>{label}</span>
        {badge && (
          <span style={{ fontSize: 8.5, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.04em', background: '#27AE60', color: '#fff', padding: '2px 6px', borderRadius: 4 }}>Verdix</span>
        )}
      </div>
      <div className="trace-chain" style={{ display: 'grid', gridTemplateColumns: `repeat(${steps.length}, 1fr)`, gap: 6 }}>
        {steps.map((s, i) => (
          <div key={i} style={{ position: 'relative' as const }}>
            <div style={{ borderRadius: 10, height: 56, display: 'flex', alignItems: 'center', justifyContent: 'center', background: s.bg, textAlign: 'center' as const, padding: '0 8px' }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: s.text, lineHeight: 1.35 }}>{s.label}</div>
            </div>
            {i < steps.length - 1 && (
              <div style={{ position: 'absolute' as const, right: -12, top: '50%', transform: 'translateY(-50%)', zIndex: 1 }}>
                <Ico d="M5 12h14M12 5l7 7-7 7" stroke="rgba(26,61,43,0.2)" size={12} sw={2} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )

  return (
    <div style={{ margin: '28px -4px', borderRadius: 14, overflow: 'hidden', border: '0.5px solid rgba(26,61,43,0.13)', background: '#fff' }}>
      <div style={{ padding: '11px 20px', background: '#F5F3EE', borderBottom: '0.5px solid rgba(26,61,43,0.1)' }}>
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#4A7C59' }}>Architectural approach</span>
      </div>
      <div style={{ padding: '18px 20px 4px' }}>
        {renderChain(TABS_CHAIN, 'Tabs — unified platform')}
        {renderChain(VERDIX_CHAIN, 'Verdix — orchestration layer', true)}
      </div>
    </div>
  )
}

// ── Diagram 3: Decision guide ──────────────────────────────────────────────────

const DECISION_COLS = [
  {
    condition: 'One platform to manage contracts, billing, collections and revenue recognition',
    result:    'Choose Tabs',
    resultBg:  '#3A3530',
    resultText:'#E5E2DD',
    condBg:    '#F5F3EE',
    condText:  '#3A3530',
    arrowCol:  'rgba(26,61,43,0.25)',
    verdix:    false,
  },
  {
    condition: 'Existing finance stack works; the gap is before the invoice is created',
    result:    'Choose Verdix',
    resultBg:  '#27AE60',
    resultText:'#fff',
    condBg:    '#EAF3DE',
    condText:  '#1A3D2B',
    arrowCol:  '#27AE60',
    verdix:    true,
  },
  {
    condition: 'Tabs manages customer billing; Verdix handles partner-invoice reconciliation',
    result:    'Use both',
    resultBg:  '#3DAA7F',
    resultText:'#fff',
    condBg:    '#F8F6F1',
    condText:  '#5A5550',
    arrowCol:  'rgba(26,61,43,0.2)',
    verdix:    false,
  },
]

function DecisionGuide() {
  return (
    <div style={{ margin: '28px -4px' }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#4A7C59', marginBottom: 12 }}>
        Decision guide
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gridTemplateRows: 'auto auto auto', columnGap: 10 }} className="approach-grid">
        {DECISION_COLS.map((col, i) => (
          <div key={`cond-${i}`} style={{ padding: '13px 14px', background: col.condBg, borderRadius: '10px 10px 0 0', border: col.verdix ? '1.5px solid #C0DD97' : '0.5px solid rgba(26,61,43,0.1)', borderBottom: 'none', display: 'flex', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: col.condText, lineHeight: 1.5 }}>{col.condition}</span>
          </div>
        ))}
        {DECISION_COLS.map((col, i) => (
          <div key={`arrow-${i}`} style={{ display: 'flex', justifyContent: 'center', padding: '4px 0' }}>
            <Ico d="M12 5v14M5 12l7 7 7-7" stroke={col.arrowCol} size={18} sw={2} />
          </div>
        ))}
        {DECISION_COLS.map((col, i) => (
          <div key={`result-${i}`} style={{ padding: '12px 14px', background: col.resultBg, borderRadius: '0 0 10px 10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: col.resultText }}>{col.result}</span>
            {col.verdix && (
              <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.07em', background: '#C4E0B2', color: '#1A3D2B', padding: '2px 6px', borderRadius: 4 }}>Verdix</span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function BlogPost() {
  return (
    <div className="min-h-screen" style={{ background: '#FAF8F4' }}>

      {/* Nav */}
      <header className="border-b border-forest/10 sticky top-0 z-20 backdrop-blur-sm" style={{ background: 'rgba(250,248,244,0.95)' }}>
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5">
            <VerdixLogo size={24} />
            <span className="font-sans font-semibold text-[15px]" style={{ color: '#1A3D2B', letterSpacing: '0.02em' }}>Verdix</span>
          </Link>
          <div className="flex items-center gap-5 text-sm">
            <Link href="/blog" className="text-stone hover:text-forest transition-colors">Blog</Link>
            <Link href="/login" className="text-stone hover:text-forest transition-colors">Sign in</Link>
            <Link href="/signup" className="bg-forest text-white font-medium px-4 py-2 rounded-xl hover:bg-sage transition-colors" style={{ fontSize: 13 }}>
              Get started
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-6 py-14 md:py-20">

        {/* Back */}
        <Link href="/blog" className="inline-flex items-center gap-1.5 text-sm text-stone hover:text-forest transition-colors mb-10">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M19 12H5M12 5l-7 7 7 7" /></svg>
          All posts
        </Link>

        {/* Header */}
        <div className="mb-10">
          <div className="flex items-center gap-3 mb-5">
            <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#4A7C59' }}>Finance operations · Product</span>
            <span className="text-stone/40">·</span>
            <span className="text-xs text-stone">August 2026</span>
          </div>
          <h1 className="font-display font-light text-ink leading-tight mb-5" style={{ fontSize: 'clamp(1.8rem,3.5vw,2.6rem)' }}>
            Tabs vs Verdix: full revenue platform or focused agreement operations?
          </h1>
          <p className="text-stone leading-relaxed" style={{ fontSize: 16 }}>
            Both platforms start from the signed agreement. The difference is how much of the revenue stack each one aims to own.
          </p>
        </div>

        <hr style={{ border: 'none', borderTop: '0.5px solid rgba(26,61,43,0.10)', marginBottom: 40 }} />

        <article className="prose-verdix">

          <h2>Tabs and Verdix start from a similar problem</h2>

          <p>Both platforms address a common challenge: after an enterprise agreement is signed, Finance must convert its commercial terms into a working billing process.</p>

          <p><a href="https://www.tabs.com" target="_blank" rel="noopener noreferrer">Tabs</a> positions itself as an integrated billing and revenue platform covering contracts, billing, invoicing, collections, revenue recognition and reporting.</p>

          <p>Verdix focuses on the agreement-operations layer: interpreting bespoke customer and partner agreements, connecting them to operational data and sending approved financial instructions into the company&apos;s existing systems.</p>

          <h2>What Tabs does</h2>

          <p>Tabs begins with the signed customer contract. Its Contract Agent extracts information such as:</p>

          <ul>
            <li>customer details;</li>
            <li>products and pricing;</li>
            <li>billing schedules;</li>
            <li>renewal terms;</li>
            <li>usage commitments;</li>
            <li>revenue obligations.</li>
          </ul>

          <p>Tabs then uses the structured contract record to generate billing schedules and invoices. Its platform also supports collections, cash application, revenue recognition, reporting and accounting integrations.</p>

          <p>For usage-based businesses, Tabs supports real-time usage ingestion, commitment tracking and links between usage events, invoices and recognised revenue, as well as CSV-based usage imports.</p>

          <p>Tabs is therefore broader than a contract-extraction tool. It is intended to manage much of the customer revenue workflow inside one platform.</p>

          <h2>What Verdix does</h2>

          <p>Verdix also begins with the signed agreement, but it follows a narrower orchestration model.</p>

          <p>For customer billing, Verdix:</p>

          <ul>
            <li>interprets the agreement;</li>
            <li>identifies pricing, schedules, thresholds and exclusions;</li>
            <li>connects those terms to customer-defined operational endpoints;</li>
            <li>retrieves the relevant usage;</li>
            <li>creates the billing schedule;</li>
            <li>routes it for approval;</li>
            <li>sends the approved instructions to the chosen billing or invoicing system.</li>
          </ul>

          <p>For partner agreements, Verdix compares the agreement, operational activity and incoming invoice to determine whether the amount should be approved or disputed.</p>

          <p>Verdix is not intended to replace the customer&apos;s payment provider, ERP or general billing infrastructure.</p>

          <h2>Key differences</h2>

          <ComparisonTable />

          <h2>The important architectural difference</h2>

          <p>Tabs aims to bring the customer revenue workflow into one platform. Verdix aims to orchestrate existing systems.</p>

          <ArchitecturePipelines />

          <p>Neither approach is universally better. A unified platform offers greater control over the complete revenue lifecycle. An orchestration layer can require less disruption when the downstream stack is already working.</p>

          <h2>When Tabs may be the better choice</h2>

          <p>Tabs may be better suited when a company wants one platform to manage most of the customer revenue lifecycle. This includes businesses that want to consolidate:</p>

          <ul>
            <li>contract processing;</li>
            <li>usage billing;</li>
            <li>invoice creation;</li>
            <li>collections;</li>
            <li>cash application;</li>
            <li>revenue recognition;</li>
            <li>revenue reporting;</li>
            <li>ERP synchronisation.</li>
          </ul>

          <p><a href="https://www.tabs.com/pricing" target="_blank" rel="noopener noreferrer">Tabs currently lists its Launch plan at $2,000 per month</a>, covering companies with up to $5 million in annual revenue and 100 active contracts. Implementation is priced separately. That broader scope may justify the investment for companies looking to replace several manual or disconnected revenue processes.</p>

          <h2>When Verdix may be the better choice</h2>

          <p>Verdix may be a stronger fit when the company says: &ldquo;Our invoicing, payments and accounting systems already work. The manual problem occurs before the invoice is created.&rdquo;</p>

          <p>Typical requirements include:</p>

          <ul>
            <li>bespoke contracts that differ by customer;</li>
            <li>periodic rather than real-time billing;</li>
            <li>usage already available through operational APIs;</li>
            <li>no desire to build a separate raw-event pipeline;</li>
            <li>a preference to keep Stripe, Fortnox, Visma or an ERP;</li>
            <li>workflow-based rather than revenue-percentage pricing;</li>
            <li>customer billing and partner reconciliation within the same agreement model.</li>
          </ul>

          <h2>Can Tabs and Verdix work together?</h2>

          <p>There is significant overlap on customer contract interpretation and billing-schedule creation, so they would often compete for that workflow.</p>

          <p>They could coexist in a more limited scenario where Tabs manages customer billing, collections and revenue recognition, and Verdix manages incoming partner-agreement reconciliation.</p>

          <p>Verdix may also integrate more naturally with execution platforms that do not already provide contract interpretation, such as an ERP, a local invoicing tool or a payment processor.</p>

          <DecisionGuide />

          <h2>The takeaway</h2>

          <p>Choose Tabs when the objective is to adopt a broad, integrated platform for customer billing and revenue operations.</p>

          <p>Choose Verdix when the objective is to automate bespoke customer and partner agreements while retaining the billing, payment and accounting systems already in place.</p>

          <p>The central decision is: do you want a platform to run the wider revenue lifecycle, or a focused layer that operationalises agreements across your existing stack?</p>

        </article>

        {/* CTA */}
        <div className="mt-14 rounded-2xl p-8 text-center" style={{ background: '#EAF3DE', border: '0.5px solid #C0DD97' }}>
          <p className="font-medium mb-5" style={{ color: '#1A3D2B', fontSize: 16, lineHeight: 1.6 }}>
            Turn bespoke customer and partner agreements into approved financial workflows—without replacing your finance infrastructure.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              href="/signup"
              className="inline-block text-white font-medium px-7 py-3 rounded-xl text-sm transition-colors"
              style={{ background: '#27AE60' }}
            >
              Automate your first agreement →
            </Link>
            <a
              href="/demos/contract-to-billing.html"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block font-medium px-7 py-3 rounded-xl text-sm transition-colors"
              style={{ background: '#fff', color: '#1A3D2B', border: '0.5px solid rgba(26,61,43,0.2)' }}
            >
              View interactive demo
            </a>
          </div>
        </div>

      </main>

      {/* Footer */}
      <footer className="border-t border-forest/10 py-8 text-center mt-8" style={{ background: '#fff' }}>
        <div className="flex items-center justify-center gap-2.5 mb-3">
          <VerdixLogo size={20} />
          <span className="font-sans font-semibold text-sm" style={{ color: '#1A3D2B' }}>Verdix</span>
        </div>
        <div className="flex items-center justify-center gap-6 text-xs text-stone mb-3">
          <Link href="/privacy" className="hover:text-forest transition-colors">Privacy Policy</Link>
          <Link href="/terms" className="hover:text-forest transition-colors">Terms</Link>
          <a href="mailto:bilal@lynoraai.com" className="hover:text-forest transition-colors">Contact</a>
        </div>
        <p className="text-xs text-stone/50">Verdix is a product by Lynora AB · Org. nr 559516-1190 · Sweden</p>
      </footer>

      <style>{`
        .prose-verdix {
          font-size: 15px;
          line-height: 1.8;
          color: #3A3530;
        }
        .prose-verdix p { margin-bottom: 1.25rem; }
        .prose-verdix h2 {
          font-family: var(--font-display, Georgia, serif);
          font-weight: 300;
          font-size: 1.3rem;
          color: #1C1917;
          margin-top: 2.5rem;
          margin-bottom: 1rem;
          line-height: 1.4;
        }
        .prose-verdix ul {
          margin: 1rem 0 1.25rem 0;
          padding-left: 0;
          list-style: none;
        }
        .prose-verdix ul li {
          display: flex;
          align-items: flex-start;
          gap: 10px;
          margin-bottom: 0.45rem;
        }
        .prose-verdix ul li::before {
          content: '';
          display: block;
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: #4A7C59;
          flex-shrink: 0;
          margin-top: 8px;
        }
        .prose-verdix a {
          color: #27AE60;
          text-decoration: none;
        }
        .prose-verdix a:hover {
          text-decoration: underline;
        }
        .prose-verdix blockquote {
          margin: 1.5rem 0;
          padding: 14px 20px;
          background: #F5F3EE;
          border-left: 3px solid #1A3D2B;
          border-radius: 0 8px 8px 0;
          font-style: italic;
          color: #4A4540;
          font-size: 14px;
          line-height: 1.7;
        }
        .trace-chain {
          position: relative;
        }
        @media (max-width: 560px) {
          .approach-grid {
            grid-template-columns: 1fr !important;
          }
          .trace-chain {
            grid-template-columns: repeat(3, 1fr) !important;
          }
        }
      `}</style>

    </div>
  )
}
