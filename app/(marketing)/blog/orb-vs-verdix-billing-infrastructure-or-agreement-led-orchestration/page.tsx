import Link from 'next/link'
import { VerdixLogo } from '@/components/VerdixLogo'

export const metadata = {
  title: 'Orb vs Verdix: billing infrastructure or agreement-led orchestration? | Verdix',
  description:
    'Compare Orb and Verdix across contract interpretation, usage data, metering, invoicing, existing-system integration, pricing and partner reconciliation.',
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
  { area: 'Starting point',                 orb: 'Events, pricing config or signed contract',      verdix: 'Signed customer or partner agreement',       verdixStrong: false },
  { area: 'Contract interpretation',        orb: 'Yes, via Contract-to-Cash',                      verdix: 'Yes',                                        verdixStrong: false },
  { area: 'Usage collection',               orb: 'Raw event ingestion; CSV in C2C workflow',       verdix: 'Pulls from customer-defined endpoints',       verdixStrong: false },
  { area: 'Real-time metering',             orb: 'Core capability — 250k+ events / sec',           verdix: 'Not primary focus',                           verdixStrong: false },
  { area: 'Pricing and rating',             orb: 'Full billing engine',                            verdix: 'Applies agreement logic to retrieved data',   verdixStrong: false },
  { area: 'Invoice generation',             orb: 'Native Orb invoicing or integrations',           verdix: 'Sends instructions to chosen system',         verdixStrong: false },
  { area: 'Collections and dunning',        orb: 'Available in Orb',                               verdix: 'Remain in existing finance stack',            verdixStrong: false },
  { area: 'Revenue reporting',              orb: 'Supported',                                      verdix: 'Not primary focus',                           verdixStrong: false },
  { area: 'Partner reconciliation',         orb: 'Not a positioned core product',                  verdix: 'Core workflow',                               verdixStrong: true  },
  { area: 'Pricing basis',                  orb: 'Billings volume and events; platform fee',       verdix: 'Completed agreement workflows',               verdixStrong: true  },
  { area: 'Architecture',                   orb: 'Billing system of record',                       verdix: 'Agreement-operations and orchestration layer',verdixStrong: true  },
]

function ComparisonTable() {
  return (
    <div style={{ margin: '28px -4px', borderRadius: 14, overflow: 'hidden', border: '0.5px solid rgba(26,61,43,0.13)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr 1fr' }}>

        {/* Column headers */}
        <div style={{ padding: '10px 14px', background: '#F5F3EE', borderBottom: '0.5px solid rgba(26,61,43,0.1)', borderRight: '0.5px solid rgba(26,61,43,0.08)' }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#9A9490' }}>Area</span>
        </div>
        <div style={{ padding: '10px 14px', background: '#1E3352', borderBottom: '0.5px solid rgba(255,255,255,0.06)', borderRight: '0.5px solid rgba(255,255,255,0.05)' }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#6A90B8' }}>Orb</span>
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
          const rowBorderDark  = isLast ? 'none' : '0.5px solid rgba(255,255,255,0.04)'
          const rowBorderGreen = isLast ? 'none' : '0.5px solid rgba(39,174,96,0.12)'
          return (
            <div key={i} style={{ display: 'contents' }}>
              <div style={{ padding: '9px 14px', background: even ? '#FAFAF8' : '#fff', borderBottom: rowBorderLight, borderRight: '0.5px solid rgba(26,61,43,0.07)', display: 'flex', alignItems: 'center' }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: '#6B6660' }}>{r.area}</span>
              </div>
              <div style={{ padding: '9px 14px', background: even ? '#223A5A' : '#1E3352', borderBottom: rowBorderDark, borderRight: '0.5px solid rgba(255,255,255,0.04)', display: 'flex', alignItems: 'center' }}>
                <span style={{ fontSize: 11.5, color: '#8AAEC8', lineHeight: 1.4 }}>{r.orb}</span>
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

// ── Diagram 2: Usage data flow comparison ─────────────────────────────────────

const ORB_CHAIN = [
  { label: 'App sends events',  bg: '#1E3352', text: '#A8C4E0' },
  { label: 'Event ingestion',   bg: '#2B4A73', text: '#A8C4E0' },
  { label: 'Billable metrics',  bg: '#3B6A9E', text: '#D0E4F5' },
  { label: 'Pricing applied',   bg: '#5A8ABE', text: '#fff'    },
  { label: 'Orb invoice',       bg: '#7AAAD0', text: '#fff'    },
]

const VERDIX_CHAIN = [
  { label: 'Signed agreement',  bg: '#1A3D2B', text: '#EAF3DE' },
  { label: 'Endpoint retrieval',bg: '#27AE60', text: '#fff'    },
  { label: 'Approved charge',   bg: '#3DAA7F', text: '#fff'    },
  { label: 'Finance system',    bg: '#B8E0CC', text: '#1A3D2B' },
]

function UsageFlowComparison() {
  const renderChain = (steps: { label: string; bg: string; text: string }[], label: string, badge?: boolean) => (
    <div style={{ marginBottom: 18 }}>
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
                <Ico d="M5 12h14M12 5l7 7-7 7" stroke="rgba(26,61,43,0.18)" size={12} sw={2} />
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
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#4A7C59' }}>How usage reaches billing</span>
      </div>
      <div style={{ padding: '18px 20px 4px' }}>
        {renderChain(ORB_CHAIN, 'Orb — event-driven')}
        {renderChain(VERDIX_CHAIN, 'Verdix — endpoint retrieval', true)}
      </div>
    </div>
  )
}

// ── Diagram 3: Decision guide ──────────────────────────────────────────────────

const DECISION_COLS = [
  {
    condition: 'High-volume event metering, real-time usage, complex rating and native invoicing at scale',
    result:    'Choose Orb',
    resultBg:  '#1E3352',
    resultText:'#A8C4E0',
    condBg:    '#F0F3F6',
    condText:  '#3A3530',
    arrowCol:  'rgba(30,51,82,0.35)',
    verdix:    false,
  },
  {
    condition: 'Billing systems work; gap is translating bespoke agreements and retrieving operational data',
    result:    'Choose Verdix',
    resultBg:  '#27AE60',
    resultText:'#fff',
    condBg:    '#EAF3DE',
    condText:  '#1A3D2B',
    arrowCol:  '#27AE60',
    verdix:    true,
  },
  {
    condition: 'Orb meters usage; Verdix applies customer contract terms and handles partner reconciliation',
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
            Orb vs Verdix: billing infrastructure or agreement-led orchestration?
          </h1>
          <p className="text-stone leading-relaxed" style={{ fontSize: 16 }}>
            Both platforms help companies operationalise complex commercial agreements. The main distinction is architectural: Orb provides billing infrastructure; Verdix provides an orchestration layer around the systems you already use.
          </p>
        </div>

        <hr style={{ border: 'none', borderTop: '0.5px solid rgba(26,61,43,0.10)', marginBottom: 40 }} />

        <article className="prose-verdix">

          <h2>Orb and Verdix address different levels of billing complexity</h2>

          <p>Both Orb and Verdix help companies operationalise complex commercial agreements. The main distinction is architectural:</p>

          <ul>
            <li>Orb provides a full usage-based billing engine, including event metering, pricing, subscriptions, invoicing and finance workflows.</li>
            <li>Verdix provides an agreement-operations layer that turns signed customer and partner agreements into approved billing or reconciliation instructions while preserving the existing finance stack.</li>
          </ul>

          <p>The right choice depends on whether a company needs new billing infrastructure or better orchestration around systems it already uses.</p>

          <h2>What Orb does</h2>

          <p><a href="https://www.withorb.com" target="_blank" rel="noopener noreferrer">Orb</a> is built for companies with usage-based, subscription and hybrid pricing. Its core billing engine ingests raw product events, turns them into billable metrics, applies pricing and generates invoices. Orb supports fixed fees, per-seat charges, usage pricing, credits, discounts, thresholds and customer-specific commercial models. Its platform also provides real-time alerts, native invoicing, dunning, revenue reporting and integrations with Stripe, NetSuite and QuickBooks.</p>

          <p>Orb&apos;s event model is particularly important. Companies send raw usage records into Orb, where query-based metrics calculate quantities across the event history. This allows businesses to create or change metrics without rebuilding the underlying usage pipeline.</p>

          <p>Orb now also offers a contract-led workflow. Finance can upload a signed contract PDF, allow Orb to extract billing terms and create invoice schedules. For variable charges, its published Contract-to-Cash workflow currently supports adding usage through CSV uploads.</p>

          <p>This means Orb addresses both high-scale usage billing and finance-led processing of signed enterprise agreements.</p>

          <h2>What Verdix does</h2>

          <p>Verdix also begins with the signed agreement, but it follows an orchestration model.</p>

          <p>For customer billing, Verdix:</p>

          <ul>
            <li>interprets the signed agreement;</li>
            <li>identifies pricing, thresholds, schedules and exclusions;</li>
            <li>connects the terms to customer-defined operational endpoints;</li>
            <li>retrieves the relevant usage;</li>
            <li>creates the billing schedule;</li>
            <li>routes the result for approval;</li>
            <li>sends approved instructions to the customer&apos;s chosen billing or invoicing system.</li>
          </ul>

          <p>For partner reconciliation, Verdix compares the partner agreement, operational activity and incoming invoice. It then calculates the expected amount, identifies differences and prepares supporting evidence for approval or dispute.</p>

          <p>Verdix is not intended to become the company&apos;s real-time usage ledger, payment processor or complete revenue-management platform.</p>

          <h2>Key differences</h2>

          <ComparisonTable />

          <h2>The main usage-data difference</h2>

          <p>The clearest distinction is how usage reaches the billing workflow.</p>

          <p>Orb&apos;s core model requires the application to send raw events. Orb calculates billable metrics from that event history and applies prices. This provides strong flexibility, auditability and real-time capabilities — but it also requires the product to send and maintain an event stream.</p>

          <p>Verdix reads the signed agreement, identifies which data is needed and retrieves it from an existing operational endpoint. This is designed for periodic billing where the operational system already contains the trusted data required to calculate the charge.</p>

          <UsageFlowComparison />

          <p>The trade-off is important: Verdix&apos;s endpoint model is lighter to implement, but Orb is more appropriate when the company needs a dedicated, real-time usage source of truth.</p>

          <h2>When Orb may be the better choice</h2>

          <p>Orb is likely to be stronger when a company needs:</p>

          <ul>
            <li>continuous ingestion of high-volume product events;</li>
            <li>real-time usage and cost visibility;</li>
            <li>prepaid-credit management;</li>
            <li>usage alerts and threshold billing;</li>
            <li>complex re-rating of historical events;</li>
            <li>native invoice generation and dunning;</li>
            <li>one platform for usage, subscriptions, pricing and invoicing.</li>
          </ul>

          <p>Orb publicly describes ingestion volumes of more than 250,000 events per second. For an AI, API or cloud-infrastructure business where metering is part of the product experience, this depth may be essential.</p>

          <h2>When Verdix may be the better choice</h2>

          <p>Verdix may be more suitable when the company says: &ldquo;Our billing and payment systems already work. The manual problem is translating each signed agreement and retrieving the correct operational data.&rdquo;</p>

          <p>Typical conditions include:</p>

          <ul>
            <li>billing is monthly or periodic rather than real time;</li>
            <li>usage already exists behind reliable internal APIs;</li>
            <li>the company wants to avoid building another raw-event pipeline;</li>
            <li>commercial terms differ substantially across customers;</li>
            <li>Finance wants to keep Stripe, Fortnox, Visma or its ERP;</li>
            <li>partner invoices must also be checked against negotiated terms;</li>
            <li>the company prefers to pay per completed workflow rather than by revenue and raw-event volume.</li>
          </ul>

          <h2>Pricing approach</h2>

          <p><a href="https://www.withorb.com/pricing" target="_blank" rel="noopener noreferrer">Orb&apos;s public pricing</a> does not publish fixed monetary rates. It states that pricing is based primarily on the value of billings processed through Orb and the number of raw events ingested. Advanced and Enterprise plans also include a platform fee.</p>

          <p>Verdix is intended to price around completed agreement workflows rather than total billing volume or raw-event generation. One workflow could be a customer billing cycle produced from an agreement and operational data, or a partner invoice reconciled against its agreement. This may be more predictable for companies with high contract values but relatively few monthly billing workflows.</p>

          <h2>Can Orb and Verdix work together?</h2>

          <p>Yes, particularly for a company that needs both deep metering and broader agreement operations.</p>

          <p>A possible architecture:</p>

          <ul>
            <li>Verdix interprets customer-specific obligations from the signed agreement;</li>
            <li>Orb supplies real-time metered usage or performs complex rating;</li>
            <li>an approved charge is produced;</li>
            <li>Orb, Stripe or an ERP issues the invoice;</li>
            <li>Verdix separately handles incoming partner-agreement reconciliation.</li>
          </ul>

          <p>However, Orb Contract-to-Cash overlaps directly with Verdix on PDF interpretation and customer invoice-schedule generation. In those workflows, the two products would more often compete than complement.</p>

          <DecisionGuide />

          <h2>The takeaway</h2>

          <p>Choose Orb when the company needs a powerful usage-billing infrastructure capable of processing raw events, calculating complex metrics and managing invoices at scale.</p>

          <p>Choose Verdix when the company already has suitable operational and finance systems but needs to automate the agreement-led work between them—including customer billing and partner reconciliation.</p>

          <p>The central question is: do you need a new usage-billing system of record, or a focused layer that turns bespoke agreements and existing operational data into approved financial instructions?</p>

        </article>

        {/* CTA */}
        <div className="mt-14 rounded-2xl p-8 text-center" style={{ background: '#EAF3DE', border: '0.5px solid #C0DD97' }}>
          <p className="font-medium mb-5" style={{ color: '#1A3D2B', fontSize: 16, lineHeight: 1.6 }}>
            Operationalise bespoke customer and partner agreements while keeping the billing and finance infrastructure you already use.
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
