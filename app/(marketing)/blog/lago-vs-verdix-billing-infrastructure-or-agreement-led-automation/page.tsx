import Link from 'next/link'
import { VerdixLogo } from '@/components/VerdixLogo'

export const metadata = {
  title: 'Lago vs Verdix: billing infrastructure or agreement-led automation? | Verdix',
  description:
    'Compare Lago and Verdix across usage metering, bespoke contracts, invoicing, deployment, implementation and partner reconciliation.',
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
  { area: 'Starting point',                  lago: 'Events, metrics and configured plans',                   verdix: 'Signed customer or partner agreement',          verdixStrong: false },
  { area: 'Usage collection',                lago: 'Product sends events to Lago',                           verdix: 'Retrieves required data from existing endpoints', verdixStrong: false },
  { area: 'Real-time metering',              lago: 'Core capability',                                        verdix: 'Not the primary focus',                          verdixStrong: false },
  { area: 'Pricing and rating',              lago: 'Full billing engine',                                    verdix: 'Applies terms extracted from the agreement',      verdixStrong: false },
  { area: 'Invoice generation',              lago: 'Native',                                                 verdix: 'Uses the chosen downstream system',              verdixStrong: false },
  { area: 'Contract interpretation',         lago: 'Plans and custom terms configured in Lago',              verdix: 'AI-assisted interpretation of signed agreements', verdixStrong: true  },
  { area: 'Existing billing stack',          lago: 'Can replace or become the billing engine',               verdix: 'Designed to preserve the existing stack',         verdixStrong: true  },
  { area: 'Partner-invoice reconciliation',  lago: 'Not positioned as a core workflow',                      verdix: 'Core capability',                                verdixStrong: true  },
  { area: 'Deployment',                      lago: 'Cloud, self-hosted and enterprise options',              verdix: 'EU-first agreement-processing architecture',      verdixStrong: false },
  { area: 'Commercial model',                lago: 'Open-source core plus paid plans with usage dimensions', verdix: 'Completed agreement workflows',                   verdixStrong: false },
]

function ComparisonTable() {
  return (
    <div style={{ margin: '28px -4px', borderRadius: 14, overflow: 'hidden', border: '0.5px solid rgba(26,61,43,0.13)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr 1fr' }}>

        {/* Column headers */}
        <div style={{ padding: '10px 14px', background: '#F5F3EE', borderBottom: '0.5px solid rgba(26,61,43,0.1)', borderRight: '0.5px solid rgba(26,61,43,0.08)' }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#9A9490' }}>Area</span>
        </div>
        <div style={{ padding: '10px 14px', background: '#3B2A6E', borderBottom: '0.5px solid rgba(255,255,255,0.06)', borderRight: '0.5px solid rgba(255,255,255,0.05)' }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#A899D8' }}>Lago</span>
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
              <div style={{ padding: '9px 14px', background: even ? '#47337E' : '#3B2A6E', borderBottom: rowBorderDark, borderRight: '0.5px solid rgba(255,255,255,0.04)', display: 'flex', alignItems: 'center' }}>
                <span style={{ fontSize: 11.5, color: '#B8ACDF', lineHeight: 1.4 }}>{r.lago}</span>
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

// ── Diagram 2: Architectural flow comparison ───────────────────────────────────

const LAGO_CHAIN = [
  { label: 'Product events',   bg: '#3B2A6E', text: '#C4BAF0' },
  { label: 'Billable metrics', bg: '#4E3B8A', text: '#C4BAF0' },
  { label: 'Pricing plan',     bg: '#6352A8', text: '#E4E0F8' },
  { label: 'Invoice',          bg: '#8878C4', text: '#fff'    },
]

const VERDIX_CHAIN = [
  { label: 'Signed agreement',    bg: '#1A3D2B', text: '#EAF3DE' },
  { label: 'Usage endpoint',      bg: '#27AE60', text: '#fff'    },
  { label: 'Contractual calc.',   bg: '#3DAA7F', text: '#fff'    },
  { label: 'Approved instruction',bg: '#52C48A', text: '#fff'    },
  { label: 'Billing system',      bg: '#B8E0CC', text: '#1A3D2B' },
]

function ArchitectureComparison() {
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
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#4A7C59' }}>Architectural approach</span>
      </div>
      <div style={{ padding: '18px 20px 4px' }}>
        {renderChain(LAGO_CHAIN,   'Lago — event-driven')}
        {renderChain(VERDIX_CHAIN, 'Verdix — endpoint retrieval', true)}
      </div>
    </div>
  )
}

// ── Diagram 3: Decision guide ──────────────────────────────────────────────────

const DECISION_COLS = [
  {
    condition: 'Continuous event metering, real-time usage, flexible aggregation or open-source infrastructure control',
    result:    'Choose Lago',
    resultBg:  '#3B2A6E',
    resultText:'#C4BAF0',
    condBg:    '#F3F1F9',
    condText:  '#3A3530',
    arrowCol:  'rgba(59,42,110,0.35)',
    verdix:    false,
  },
  {
    condition: 'Billing systems work; gap is interpreting bespoke agreements and automating the workflow around existing data',
    result:    'Choose Verdix',
    resultBg:  '#27AE60',
    resultText:'#fff',
    condBg:    '#EAF3DE',
    condText:  '#1A3D2B',
    arrowCol:  '#27AE60',
    verdix:    true,
  },
  {
    condition: 'Lago handles metering depth; Verdix applies bespoke agreement terms and reconciles partner invoices',
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
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }} className="approach-grid">
        {DECISION_COLS.map((col, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column' as const, gap: 0 }}>
            <div style={{ padding: '13px 14px', background: col.condBg, borderRadius: '10px 10px 0 0', border: col.verdix ? '1.5px solid #C0DD97' : '0.5px solid rgba(26,61,43,0.1)', borderBottom: 'none', minHeight: 80, display: 'flex', alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: col.condText, lineHeight: 1.5 }}>{col.condition}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', padding: '4px 0' }}>
              <Ico d="M12 5v14M5 12l7 7 7-7" stroke={col.arrowCol} size={18} sw={2} />
            </div>
            <div style={{ padding: '12px 14px', background: col.resultBg, borderRadius: '0 0 10px 10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: col.resultText }}>{col.result}</span>
              {col.verdix && (
                <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.07em', background: '#C4E0B2', color: '#1A3D2B', padding: '2px 6px', borderRadius: 4 }}>Verdix</span>
              )}
            </div>
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
            Lago vs Verdix: billing infrastructure or agreement-led automation?
          </h1>
          <p className="text-stone leading-relaxed" style={{ fontSize: 16 }}>
            Both platforms help companies manage complex commercial models. The main distinction is architectural: Lago is a metering and billing engine; Verdix is an agreement-operations layer designed to work with the billing, payment and accounting systems a company already uses.
          </p>
        </div>

        <hr style={{ border: 'none', borderTop: '0.5px solid rgba(26,61,43,0.10)', marginBottom: 40 }} />

        <article className="prose-verdix">

          <h2>Lago and Verdix solve different parts of billing</h2>

          <p>Both Lago and Verdix help companies manage complex and usage-based commercial models, but they start from different places:</p>

          <ul>
            <li>Lago starts with product events, billable metrics and pricing plans.</li>
            <li>Verdix starts with the signed customer or partner agreement.</li>
          </ul>

          <h2>What Lago does</h2>

          <p><a href="https://getlago.com" target="_blank" rel="noopener noreferrer">Lago</a> is an open-source, event-based billing platform for subscription, usage-based and hybrid pricing.</p>

          <p>Companies send product events to Lago. Lago aggregates those events into billable metrics, applies the relevant plan and pricing rules, and generates invoices. It can also connect invoices to payment providers or pass invoice data to other financial systems.</p>

          <p>Lago supports:</p>

          <ul>
            <li>fixed and usage-based charges;</li>
            <li>pricing tiers and dimensions;</li>
            <li>minimum commitments;</li>
            <li>prepaid credits;</li>
            <li>subscriptions;</li>
            <li>customer-specific enterprise plans;</li>
            <li>invoicing;</li>
            <li>payment-provider integrations.</li>
          </ul>

          <p>Its plans determine pricing, billing cadence, commitments and invoice rules, while billable metrics determine how incoming events are measured.</p>

          <h2>What Verdix does</h2>

          <p>Verdix begins with the signed agreement rather than a predefined product plan.</p>

          <p>For customer billing, Verdix:</p>

          <ul>
            <li>interprets the contract;</li>
            <li>identifies rates, thresholds, discounts and billing dates;</li>
            <li>connects those terms to customer-defined operational endpoints;</li>
            <li>retrieves the required usage;</li>
            <li>creates the billing schedule;</li>
            <li>routes it for approval;</li>
            <li>sends approved instructions to the chosen billing or invoicing system.</li>
          </ul>

          <p>Verdix also applies the same agreement-to-data model to incoming partner invoices, identifying differences between the agreed terms, operational activity and amount charged.</p>

          <h2>Key differences</h2>

          <ComparisonTable />

          <h2>The main architectural difference</h2>

          <p>Lago&apos;s event model requires the product to send raw usage events. Lago aggregates those events into billable metrics, applies the relevant plan and charge model, and produces an invoice. This architecture is well-suited when metering is a central part of the product experience.</p>

          <p>Verdix reads the signed agreement, identifies which usage data is needed and retrieves it from an existing operational endpoint. This fits periodic billing cycles where reliable usage data already exists inside the company&apos;s systems.</p>

          <ArchitectureComparison />

          <p>The practical difference is in where the work sits. Lago requires the product team to instrument event pipelines. Verdix requires Finance to define the endpoint from which usage is fetched. Neither is simpler in absolute terms; the right choice depends on whether metering is a product responsibility or a finance workflow.</p>

          <h2>When Lago may be the better choice</h2>

          <p>Lago may be stronger when a company needs:</p>

          <ul>
            <li>continuous product-event ingestion;</li>
            <li>real-time or near-real-time usage measurement;</li>
            <li>a central usage ledger;</li>
            <li>flexible aggregation across multiple dimensions;</li>
            <li>prepaid-credit management;</li>
            <li>subscription and hybrid billing;</li>
            <li>native invoice generation;</li>
            <li>control through open-source or self-hosted deployment.</li>
          </ul>

          <p>Lago can be deployed through Lago Cloud, on the customer&apos;s own infrastructure or through enterprise VPC-style arrangements. This makes it particularly attractive to engineering-led companies that want control over their billing infrastructure.</p>

          <h2>When Verdix may be the better choice</h2>

          <p>Verdix may be more suitable when:</p>

          <ul>
            <li>the signed agreement is the commercial source of truth;</li>
            <li>terms vary significantly between customers;</li>
            <li>Finance manually interprets contracts today;</li>
            <li>usage already exists behind reliable internal APIs;</li>
            <li>billing occurs monthly or periodically;</li>
            <li>the company wants to retain Stripe, Fortnox, Visma or its ERP;</li>
            <li>implementing a dedicated event ledger would be unnecessary;</li>
            <li>partner invoices must also be reconciled against agreed terms.</li>
          </ul>

          <p>The strongest Verdix buyer is not saying: &ldquo;We cannot measure product usage.&rdquo; They are saying: &ldquo;We already have the data, but Finance still has to translate every agreement and prepare the billing instructions manually.&rdquo;</p>

          <h2>Is Lago a competitor or a complement?</h2>

          <p>It can be both.</p>

          <p>They <strong>compete</strong> when a company is deciding whether to use Lago as the main system for usage measurement, rating and invoicing — or use Verdix to automate billing through its existing stack. The overlap grows when commercial teams can configure custom enterprise plans directly in Lago.</p>

          <p>They <strong>complement</strong> each other when a business needs Lago&apos;s metering depth but also manages a large portfolio of bespoke signed agreements. A combined workflow could be:</p>

          <ul>
            <li>Verdix interprets the customer-specific terms from the signed agreement;</li>
            <li>Lago supplies metered usage and performs complex rating;</li>
            <li>an approved invoice is generated;</li>
            <li>payment provider and ERP are updated;</li>
            <li>Verdix separately reconciles incoming partner invoices.</li>
          </ul>

          <h2>Implementation and pricing considerations</h2>

          <p>Lago offers a free open-source core and paid cloud or self-hosted premium plans. Its paid packages may include usage-based dimensions such as events ingested, invoices generated or active customers. Exact commercial terms are available from Lago directly.</p>

          <p>The licence cost is only one consideration. A Lago implementation may also require:</p>

          <ul>
            <li>event instrumentation;</li>
            <li>customer and subscription mapping;</li>
            <li>billable-metric design;</li>
            <li>plan configuration;</li>
            <li>invoice and payment integrations;</li>
            <li>ongoing monitoring of the usage pipeline.</li>
          </ul>

          <p>Verdix reduces this work where suitable operational endpoints already exist, although those endpoints, authentication rules and data mappings still need to be configured.</p>

          <DecisionGuide />

          <h2>The takeaway</h2>

          <p>Choose Lago when you need an open-source, event-based metering and billing engine that can become a central part of your product infrastructure.</p>

          <p>Choose Verdix when the main problem is turning bespoke signed agreements and existing operational data into approved customer-billing and partner-reconciliation workflows.</p>

          <p>Use both when you need Lago&apos;s real-time metering depth and Verdix&apos;s agreement interpretation and two-sided financial operations.</p>

          <p>Lago measures and bills product consumption. Verdix operationalises what bespoke customer and partner agreements require.</p>

        </article>

        {/* CTA */}
        <div className="mt-14 rounded-2xl p-8 text-center" style={{ background: '#EAF3DE', border: '0.5px solid #C0DD97' }}>
          <p className="font-medium mb-5" style={{ color: '#1A3D2B', fontSize: 16, lineHeight: 1.6 }}>
            Automate agreement-led billing and partner reconciliation while keeping the financial systems that already work.
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
        .prose-verdix strong {
          font-weight: 600;
          color: #1C1917;
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
