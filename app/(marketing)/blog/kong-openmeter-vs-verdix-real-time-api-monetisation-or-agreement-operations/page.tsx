import Link from 'next/link'
import { VerdixLogo } from '@/components/VerdixLogo'
import { isSelfServiceSignupEnabled } from '@/lib/feature-flags'

export const metadata = {
  title: 'Kong OpenMeter vs Verdix: real-time API monetisation or agreement operations? | Verdix',
  description:
    'Compare Kong OpenMeter and Verdix across real-time metering, entitlements, bespoke contracts, usage integration, invoicing and partner reconciliation.',
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
  { area: 'Starting point',            kong: 'Product usage, events and configured plans',                verdix: 'Signed customer or partner agreement',          verdixStrong: false },
  { area: 'Usage collection',          kong: 'Events sent into the metering platform',                   verdix: 'Required data pulled from existing endpoints',   verdixStrong: false },
  { area: 'Real-time metering',        kong: 'Core capability',                                          verdix: 'Not the primary focus',                          verdixStrong: false },
  { area: 'Product catalogue',         kong: 'Plans, features, rate cards and add-ons',                  verdix: 'Commercial obligations extracted from agreements',verdixStrong: false },
  { area: 'Entitlements',              kong: 'Metered, static and Boolean access controls',              verdix: 'Not a product-access engine',                    verdixStrong: false },
  { area: 'Custom pricing',            kong: 'Configured quotes and customer-specific pricing',          verdix: 'Extracted from bespoke signed agreements',        verdixStrong: true  },
  { area: 'Invoice generation',        kong: 'Supported within the billing product',                     verdix: 'Approved instructions sent to the chosen system', verdixStrong: false },
  { area: 'Partner reconciliation',    kong: 'Not publicly positioned as a core workflow',               verdix: 'Core capability',                                verdixStrong: true  },
  { area: 'Existing billing stack',    kong: 'Can become the metering and billing engine',               verdix: 'Designed to preserve the existing stack',         verdixStrong: true  },
  { area: 'Primary user',              kong: 'Product, platform and engineering teams',                  verdix: 'Finance, RevOps, Billing and Partner Operations', verdixStrong: false },
]

function ComparisonTable() {
  return (
    <div style={{ margin: '28px -4px', borderRadius: 14, overflow: 'hidden', border: '0.5px solid rgba(26,61,43,0.13)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr 1fr' }}>

        {/* Column headers */}
        <div style={{ padding: '10px 14px', background: '#F5F3EE', borderBottom: '0.5px solid rgba(26,61,43,0.1)', borderRight: '0.5px solid rgba(26,61,43,0.08)' }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#9A9490' }}>Area</span>
        </div>
        <div style={{ padding: '10px 14px', background: '#003A6A', borderBottom: '0.5px solid rgba(255,255,255,0.06)', borderRight: '0.5px solid rgba(255,255,255,0.05)' }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#80B8F0' }}>Kong OpenMeter</span>
        </div>
        <div style={{ padding: '10px 14px', background: '#1A3D2B', borderBottom: '0.5px solid rgba(255,255,255,0.1)' }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#B8E0CC' }}>Verdix</span>
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
              <div style={{ padding: '9px 14px', background: even ? '#004E8A' : '#003A6A', borderBottom: rowBorderDark, borderRight: '0.5px solid rgba(255,255,255,0.04)', display: 'flex', alignItems: 'center' }}>
                <span style={{ fontSize: 11.5, color: '#A0C8F0', lineHeight: 1.4 }}>{r.kong}</span>
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

const KONG_CHAIN = [
  { label: 'Product events',           bg: '#002444', text: '#80B4E0' },
  { label: 'Meter',                    bg: '#003A6A', text: '#A0C8F0' },
  { label: 'Rate card & plan',         bg: '#005098', text: '#C0DCF8' },
  { label: 'Entitlement or invoice',   bg: '#2070C0', text: '#fff'    },
]

const VERDIX_CHAIN = [
  { label: 'Signed agreement',         bg: '#1A3D2B', text: '#EAF3DE' },
  { label: 'Usage endpoint',           bg: '#27AE60', text: '#fff'    },
  { label: 'Contractual calc.',        bg: '#3DAA7F', text: '#fff'    },
  { label: 'Approved instruction',     bg: '#52C48A', text: '#fff'    },
  { label: 'Finance system',           bg: '#B8E0CC', text: '#1A3D2B' },
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
        {renderChain(KONG_CHAIN,   'Kong OpenMeter — event-driven')}
        {renderChain(VERDIX_CHAIN, 'Verdix — endpoint retrieval', true)}
      </div>
    </div>
  )
}

// ── Diagram 3: Decision guide ──────────────────────────────────────────────────

const DECISION_COLS = [
  {
    condition: 'Real-time API or AI metering, entitlement enforcement, product packaging or usage balances tied to the product experience',
    result:    'Choose Kong OpenMeter',
    resultBg:  '#003A6A',
    resultText:'#A0C8F0',
    condBg:    '#EDF3FA',
    condText:  '#3A3530',
    arrowCol:  'rgba(0,58,106,0.4)',
    verdix:    false,
  },
  {
    condition: 'Billing systems work; gap is automating bespoke agreement interpretation and periodic billing or partner reconciliation',
    result:    'Choose Verdix',
    resultBg:  '#27AE60',
    resultText:'#fff',
    condBg:    '#EAF3DE',
    condText:  '#1A3D2B',
    arrowCol:  '#27AE60',
    verdix:    true,
  },
  {
    condition: 'OpenMeter measures API and AI consumption; Verdix applies bespoke agreement terms and reconciles partner invoices',
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
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gridTemplateRows: 'auto auto auto', columnGap: 10 }} className="decision-grid">
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

// Re-check the self-service flag periodically rather than baking it in at
// build time — keeps static generation while still letting the admin
// toggle propagate without a redeploy.
export const revalidate = 60

export default async function BlogPost() {
  const selfServiceEnabled = await isSelfServiceSignupEnabled()
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
            {selfServiceEnabled && (
              <Link href="/signup" className="bg-forest text-white font-medium px-4 py-2 rounded-xl hover:bg-sage transition-colors" style={{ fontSize: 13 }}>
                Get started
              </Link>
            )}
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
            Kong OpenMeter vs Verdix: real-time API monetisation or agreement operations?
          </h1>
          <p className="text-stone leading-relaxed" style={{ fontSize: 16 }}>
            Both platforms can support usage-based commercial models, but they start from different operational problems. OpenMeter meters and monetises digital activity. Verdix turns bespoke agreements and existing operational data into approved billing or reconciliation workflows.
          </p>
        </div>

        <hr style={{ border: 'none', borderTop: '0.5px solid rgba(26,61,43,0.10)', marginBottom: 40 }} />

        <article className="prose-verdix">

          <h2>They start from different operational problems</h2>

          <p>Kong OpenMeter and Verdix can both support usage-based commercial models, but their starting points differ:</p>

          <ul>
            <li>Kong OpenMeter starts with API, AI and product usage.</li>
            <li>Verdix starts with the signed customer or partner agreement.</li>
          </ul>

          <p>OpenMeter is designed to meter activity, manage pricing and entitlements, and support usage-based billing. Verdix translates bespoke agreements and existing operational data into approved billing or reconciliation workflows.</p>

          <h2>What is Kong OpenMeter?</h2>

          <p>OpenMeter began as an open-source metering and billing platform. Kong acquired it in September 2025 and integrated its capabilities into Kong Konnect for monetising APIs, AI models and data streams. The open-source project and OpenMeter Cloud have continued alongside the Kong offering.</p>

          <p>Kong&apos;s Metering &amp; Billing product supports:</p>

          <ul>
            <li>real-time usage metering;</li>
            <li>usage-based and tiered pricing;</li>
            <li>subscriptions and commitments;</li>
            <li>prepaid credits;</li>
            <li>custom enterprise deals;</li>
            <li>usage limits and notifications;</li>
            <li>customer entitlements;</li>
            <li>invoicing and payment-gateway integrations.</li>
          </ul>

          <p>Its strongest use cases are products built around APIs, AI tokens, infrastructure consumption and other high-frequency digital activity.</p>

          <h2>What does Verdix do?</h2>

          <p>Verdix starts with the final signed agreement.</p>

          <p>For customer billing, Verdix:</p>

          <ul>
            <li>interprets the contract;</li>
            <li>identifies rates, thresholds, commitments and billing dates;</li>
            <li>connects those terms to customer-defined operational endpoints;</li>
            <li>retrieves the required usage;</li>
            <li>creates the billing schedule;</li>
            <li>routes it for approval;</li>
            <li>sends approved instructions to the chosen billing system.</li>
          </ul>

          <p>For partner reconciliation, Verdix compares the partner agreement, operational activity and incoming invoice to calculate the expected amount and identify discrepancies.</p>

          <p>Verdix is not intended to become the company&apos;s real-time product-usage ledger or entitlement engine.</p>

          <h2>Key differences</h2>

          <ComparisonTable />

          <h2>The architectural difference</h2>

          <p>Kong OpenMeter&apos;s typical workflow starts with the product sending events into the platform. OpenMeter aggregates them and uses configured plans, features and rate cards to calculate usage, control entitlements and produce invoices. Its metered entitlements can track balances and support real-time access checks — making it powerful when usage must influence the product experience immediately.</p>

          <p>Verdix reads the signed agreement, identifies which operational data is needed and retrieves it from an existing customer-defined endpoint. Rather than continuously receiving raw events, it fetches what a particular billing cycle requires from a source that already holds the trusted data.</p>

          <ArchitectureComparison />

          <p>The practical distinction is audience. OpenMeter is designed for engineering and platform teams instrumenting product usage pipelines. Verdix is designed for Finance, RevOps and Billing Operations teams who need to operationalise commercial agreements without replacing existing financial infrastructure.</p>

          <h2>When Kong OpenMeter may be the better choice</h2>

          <p>Kong OpenMeter is likely to be stronger when:</p>

          <ul>
            <li>API or AI traffic must be measured continuously;</li>
            <li>usage limits must be monitored in real time;</li>
            <li>customers need live balances or usage visibility;</li>
            <li>prepaid credits must be managed;</li>
            <li>feature access depends on the customer&apos;s plan;</li>
            <li>metering is closely connected to the API gateway;</li>
            <li>one product catalogue should support self-service and enterprise pricing.</li>
          </ul>

          <p>Kong describes the platform as capable of turning API traffic, events, logs and metrics into billable usage while supporting plans, credits, commitments and invoicing.</p>

          <h2>When Verdix may be the better choice</h2>

          <p>Verdix may be more suitable when:</p>

          <ul>
            <li>the signed agreement is the commercial source of truth;</li>
            <li>customer terms are spread across order forms and amendments;</li>
            <li>billing runs monthly or periodically;</li>
            <li>the required usage already exists behind an API;</li>
            <li>Finance manually translates agreements into billing schedules;</li>
            <li>the existing billing, ERP and payment systems work;</li>
            <li>incoming partner invoices also need contractual validation.</li>
          </ul>

          <p>The strongest Verdix buyer is not primarily asking: &ldquo;How do we meter every API request in real time?&rdquo;</p>

          <p>They are asking: &ldquo;How do we turn each bespoke agreement and our existing operational data into the correct billing or payment instruction?&rdquo;</p>

          <h2>Is Kong OpenMeter a competitor or a complement?</h2>

          <p>It can be both.</p>

          <p>They <strong>compete</strong> when a company is choosing between introducing a new metering, pricing and invoicing platform or keeping its existing infrastructure and adding agreement-led automation. The overlap is growing because Kong OpenMeter now supports custom enterprise deals, subscriptions, commitments and invoicing — not only technical metering.</p>

          <p>They <strong>complement</strong> each other when a business needs OpenMeter&apos;s real-time metering but also has complex signed agreements or partner invoices to manage. A combined workflow could be:</p>

          <ul>
            <li>Verdix structures the customer-specific obligations from the signed agreement;</li>
            <li>OpenMeter supplies metered usage and entitlement data;</li>
            <li>Verdix creates the approved billing schedule;</li>
            <li>the billing platform or ERP issues the invoice;</li>
            <li>Verdix uses the same agreement model to reconcile incoming cloud, AI, API or infrastructure-partner invoices.</li>
          </ul>

          <h2>An important product distinction</h2>

          <p>OpenMeter is designed to answer: how much was consumed, which plan applies and does the customer still have access?</p>

          <p>Verdix is designed to answer: based on the signed agreement and operational evidence, what should this customer be billed or this partner be paid?</p>

          <p>A company with real-time AI or API monetisation may need OpenMeter. A company with periodic bespoke billing may need Verdix. A company with both requirements may use the two together.</p>

          <DecisionGuide />

          <h2>The takeaway</h2>

          <p>Choose Kong OpenMeter when real-time usage metering, product packaging, credits and entitlements are central to the product architecture.</p>

          <p>Choose Verdix when the primary challenge is operationalising signed customer and partner agreements while retaining the existing finance stack.</p>

          <p>OpenMeter measures and controls digital consumption. Verdix turns bespoke commercial agreements into approved financial workflows.</p>

        </article>

        {/* CTA */}
        <div className="mt-14 rounded-2xl p-8 text-center" style={{ background: '#EAF3DE', border: '0.5px solid #C0DD97' }}>
          <p className="font-medium mb-5" style={{ color: '#1A3D2B', fontSize: 16, lineHeight: 1.6 }}>
            Automate agreement-led customer billing and partner reconciliation using the operational and finance systems you already have.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            {selfServiceEnabled && (
              <Link
                href="/signup"
                className="inline-block text-white font-medium px-7 py-3 rounded-xl text-sm transition-colors"
                style={{ background: '#27AE60' }}
              >
                Automate your first agreement →
              </Link>
            )}
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
          .decision-grid {
            grid-template-columns: 1fr !important;
          }
          .decision-grid > :nth-child(1) { order: 0; }
          .decision-grid > :nth-child(2) { order: 3; }
          .decision-grid > :nth-child(3) { order: 6; }
          .decision-grid > :nth-child(4) { order: 1; }
          .decision-grid > :nth-child(5) { order: 4; }
          .decision-grid > :nth-child(6) { order: 7; }
          .decision-grid > :nth-child(7) { order: 2; margin-bottom: 20px; }
          .decision-grid > :nth-child(8) { order: 5; margin-bottom: 20px; }
          .decision-grid > :nth-child(9) { order: 8; }
        }
      `}</style>

    </div>
  )
}
