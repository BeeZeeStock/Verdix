import Link from 'next/link'
import { VerdixLogo } from '@/components/VerdixLogo'
import { isSelfServiceSignupEnabled } from '@/lib/feature-flags'

export const metadata = {
  title: 'Metronome vs Verdix: real-time monetisation or agreement-led automation? | Verdix',
  description:
    'Compare Metronome and Verdix across usage metering, enterprise contracts, pricing, invoicing, implementation and partner reconciliation.',
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
  { area: 'Starting point',            metro: 'Usage events, products, rate cards and configured contracts', verdix: 'Signed customer or partner agreement',           verdixStrong: false },
  { area: 'Contract setup',            metro: 'Commercial terms configured in the platform',                 verdix: 'Terms interpreted from the executed agreement',   verdixStrong: true  },
  { area: 'Usage collection',          metro: 'Product sends raw events to Metronome',                      verdix: 'Pulls required data from existing endpoints',     verdixStrong: false },
  { area: 'Real-time metering',        metro: 'Core capability',                                            verdix: 'Not the primary focus',                           verdixStrong: false },
  { area: 'Pricing and rating',        metro: 'Full monetisation engine',                                   verdix: 'Agreement-specific calculation',                  verdixStrong: false },
  { area: 'Customer dashboards',       metro: 'Real-time usage and spend visibility',                       verdix: 'Workflow and calculation traceability',            verdixStrong: false },
  { area: 'Invoice generation',        metro: 'Native and integrated invoicing options',                    verdix: 'Approved instructions sent to the chosen system',  verdixStrong: false },
  { area: 'Entitlements and alerts',   metro: 'Supports usage and spend alerts',                            verdix: 'Not a product-access engine',                     verdixStrong: false },
  { area: 'Partner reconciliation',    metro: 'Not publicly positioned as a core product',                  verdix: 'Core workflow',                                   verdixStrong: true  },
  { area: 'Architecture',              metro: 'Monetisation and billing infrastructure',                    verdix: 'Agreement-operations layer',                      verdixStrong: true  },
]

function ComparisonTable() {
  return (
    <div style={{ margin: '28px -4px', borderRadius: 14, overflow: 'hidden', border: '0.5px solid rgba(26,61,43,0.13)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr 1fr' }}>

        {/* Column headers */}
        <div style={{ padding: '10px 14px', background: '#F5F3EE', borderBottom: '0.5px solid rgba(26,61,43,0.1)', borderRight: '0.5px solid rgba(26,61,43,0.08)' }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#9A9490' }}>Area</span>
        </div>
        <div style={{ padding: '10px 14px', background: '#1B44B0', borderBottom: '0.5px solid rgba(255,255,255,0.06)', borderRight: '0.5px solid rgba(255,255,255,0.05)' }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#A8C0FF' }}>Metronome</span>
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
              <div style={{ padding: '9px 14px', background: even ? '#2A5CC8' : '#1B44B0', borderBottom: rowBorderDark, borderRight: '0.5px solid rgba(255,255,255,0.04)', display: 'flex', alignItems: 'center' }}>
                <span style={{ fontSize: 11.5, color: '#C0D4FF', lineHeight: 1.4 }}>{r.metro}</span>
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

const METRO_CHAIN = [
  { label: 'Usage events',      bg: '#102C80', text: '#A8C0FF' },
  { label: 'Billable metrics',  bg: '#1B44B0', text: '#C0D4FF' },
  { label: 'Rate card',         bg: '#2A5CC8', text: '#D8E8FF' },
  { label: 'Customer contract', bg: '#4A7CE0', text: '#fff'    },
  { label: 'Invoice',           bg: '#8AB0F0', text: '#0A1E5A' },
]

const VERDIX_CHAIN = [
  { label: 'Signed agreement',     bg: '#1A3D2B', text: '#EAF3DE' },
  { label: 'Usage endpoint',       bg: '#27AE60', text: '#fff'    },
  { label: 'Contractual calc.',    bg: '#3DAA7F', text: '#fff'    },
  { label: 'Approved instruction', bg: '#52C48A', text: '#fff'    },
  { label: 'Finance system',       bg: '#B8E0CC', text: '#1A3D2B' },
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
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#4A7C59' }}>How usage becomes a charge</span>
      </div>
      <div style={{ padding: '18px 20px 4px' }}>
        {renderChain(METRO_CHAIN,  'Metronome — event-driven')}
        {renderChain(VERDIX_CHAIN, 'Verdix — endpoint retrieval', true)}
      </div>
    </div>
  )
}

// ── Diagram 3: Decision guide (3-row grid — aligned) ──────────────────────────

const DECISION_COLS = [
  {
    condition: 'Real-time metering, customer spend dashboards, flexible pricing, usage alerts or high-volume event monetisation',
    result:    'Choose Metronome',
    resultBg:  '#1B44B0',
    resultText:'#C0D4FF',
    condBg:    '#EEF2FB',
    condText:  '#3A3530',
    arrowCol:  'rgba(27,68,176,0.4)',
    verdix:    false,
  },
  {
    condition: 'Billing systems work; challenge is interpreting bespoke agreements and automating billing and partner reconciliation',
    result:    'Choose Verdix',
    resultBg:  '#27AE60',
    resultText:'#fff',
    condBg:    '#EAF3DE',
    condText:  '#1A3D2B',
    arrowCol:  '#27AE60',
    verdix:    true,
  },
  {
    condition: 'Metronome handles usage and rating; Verdix links executed agreements and reconciles partner invoices',
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
        {/* Row 1: condition boxes — all share the same height */}
        {DECISION_COLS.map((col, i) => (
          <div key={`cond-${i}`} style={{ padding: '13px 14px', background: col.condBg, borderRadius: '10px 10px 0 0', border: col.verdix ? '1.5px solid #C0DD97' : '0.5px solid rgba(26,61,43,0.1)', borderBottom: 'none', display: 'flex', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: col.condText, lineHeight: 1.5 }}>{col.condition}</span>
          </div>
        ))}
        {/* Row 2: arrows */}
        {DECISION_COLS.map((col, i) => (
          <div key={`arrow-${i}`} style={{ display: 'flex', justifyContent: 'center', padding: '4px 0' }}>
            <Ico d="M12 5v14M5 12l7 7 7-7" stroke={col.arrowCol} size={18} sw={2} />
          </div>
        ))}
        {/* Row 3: result boxes */}
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
            Metronome vs Verdix: real-time monetisation or agreement-led automation?
          </h1>
          <p className="text-stone leading-relaxed" style={{ fontSize: 16 }}>
            Both platforms can support companies with usage-based pricing and negotiated enterprise agreements. The difference is where each begins: Metronome starts with product usage and rate cards; Verdix starts with the signed agreement.
          </p>
        </div>

        <hr style={{ border: 'none', borderTop: '0.5px solid rgba(26,61,43,0.10)', marginBottom: 40 }} />

        <article className="prose-verdix">

          <h2>Two different approaches to complex billing</h2>

          <p>Metronome and Verdix can both support companies with usage-based pricing and negotiated enterprise agreements. The difference is where each platform begins:</p>

          <ul>
            <li>Metronome starts with product usage, rate cards and configured customer contracts.</li>
            <li>Verdix starts with the signed customer or partner agreement.</li>
          </ul>

          <p>Metronome is a real-time monetisation and billing platform. Verdix is an agreement-operations layer that works with the company&apos;s existing billing and finance systems.</p>

          <h2>What Metronome does</h2>

          <p><a href="https://metronome.com" target="_blank" rel="noopener noreferrer">Metronome</a> receives product-usage events, calculates billable quantities, applies customer-specific pricing and produces invoices.</p>

          <p>Its platform supports:</p>

          <ul>
            <li>real-time usage metering;</li>
            <li>usage-, seat-, subscription- and hybrid pricing;</li>
            <li>enterprise commitments and prepaid credits;</li>
            <li>customer-specific discounts and rates;</li>
            <li>scheduled contract changes;</li>
            <li>real-time usage and spend dashboards;</li>
            <li>invoicing through Stripe, cloud marketplaces and ERP integrations.</li>
          </ul>

          <p>It can support product-led self-service customers and negotiated enterprise agreements within the same pricing infrastructure.</p>

          <h2>What Verdix does</h2>

          <p>Verdix begins with the executed agreement rather than a preconfigured rate card.</p>

          <p>For customer billing, Verdix:</p>

          <ul>
            <li>interprets the signed agreement;</li>
            <li>identifies rates, commitments, thresholds and schedules;</li>
            <li>connects the terms to customer-defined operational endpoints;</li>
            <li>retrieves the required usage;</li>
            <li>calculates the billing schedule;</li>
            <li>routes it for approval;</li>
            <li>sends approved instructions to the existing billing or invoicing system.</li>
          </ul>

          <p>For partner reconciliation, Verdix compares the partner agreement, operational data and the incoming invoice. It calculates the expected charge, identifies discrepancies and prepares supporting evidence for approval or dispute.</p>

          <h2>Key differences</h2>

          <ComparisonTable />

          <h2>The main contract difference</h2>

          <p>Metronome handles sophisticated enterprise contracts. Its rate cards act as the pricing source of truth, while contract-level overrides represent negotiated rates, tiers, commitments and discounts. Changes can be scheduled immediately, prospectively or retroactively.</p>

          <p>However, Metronome&apos;s public implementation approach centres on creating contract terms inside the platform via its application or API. It does not currently position automatic interpretation of signed contract PDFs as a core product capability.</p>

          <p>That creates an important distinction: Metronome is highly capable once the commercial model has been configured. Verdix focuses on translating the executed agreement into that operational model.</p>

          <h2>The usage-data difference</h2>

          <ArchitectureComparison />

          <p>Metronome&apos;s model requires the product to continuously send raw usage events. Billable metrics aggregate those events while rate cards and contract overrides determine the charge. This is powerful when a company needs continuously updated spend, usage alerts, prepaid-credit balances or detailed customer billing dashboards.</p>

          <p>Verdix retrieves only the data required for a particular agreement from an existing operational endpoint. This fits periodic billing where the required data already exists behind an API and the company does not need a new real-time usage ledger.</p>

          <h2>When Metronome may be the better choice</h2>

          <p>Metronome is likely to be stronger when:</p>

          <ul>
            <li>usage must be measured continuously;</li>
            <li>customers require real-time spend visibility;</li>
            <li>pricing depends on large volumes of granular product events;</li>
            <li>the company uses commitments, credits and complex dimensional pricing;</li>
            <li>Product teams need to launch and change pricing rapidly;</li>
            <li>billing is part of the customer&apos;s in-product experience;</li>
            <li>the business wants a central monetisation source of truth.</li>
          </ul>

          <p>It is particularly relevant to AI, cloud, API and infrastructure businesses where consumption billing is central to the product model.</p>

          <h2>When Verdix may be the better choice</h2>

          <p>Verdix may be more suitable when:</p>

          <ul>
            <li>commercial complexity begins with the signed agreement;</li>
            <li>each customer has different negotiated terms;</li>
            <li>operational usage already exists in internal systems;</li>
            <li>billing is periodic rather than real time;</li>
            <li>Finance still translates contracts through spreadsheets;</li>
            <li>the company wants to keep Stripe, Fortnox, Visma or its ERP;</li>
            <li>partner invoices must also be checked against agreements;</li>
            <li>the business does not want to pay according to total revenue or raw-event volume.</li>
          </ul>

          <p>The strongest Verdix customer is saying: &ldquo;We already know what happened in our product. The difficult part is turning each signed agreement into the correct billing or payment instruction.&rdquo;</p>

          <h2>Pricing difference</h2>

          <p><a href="https://metronome.com/pricing" target="_blank" rel="noopener noreferrer">Metronome&apos;s current Starter offer</a> includes $100,000 in billing volume, 10 million usage events, 0.8% on additional billing volume and $0.04 per 1,000 additional events. Custom plans are available for larger companies.</p>

          <p>Verdix is intended to charge according to completed agreement workflows — one customer billing cycle produced from an agreement and operational data, or one partner invoice reconciled against its agreement. This avoids linking the fee directly to total customer revenue or every technical event produced by the application.</p>

          <h2>Can Metronome and Verdix work together?</h2>

          <p>Yes. A combined architecture could be:</p>

          <ul>
            <li>Verdix interprets the obligations from the signed agreement;</li>
            <li>Metronome supplies metered usage and performs complex rating;</li>
            <li>an approved invoice is produced;</li>
            <li>Stripe or ERP processes the payment;</li>
            <li>Verdix separately reconciles incoming partner invoices against agreed terms.</li>
          </ul>

          <p>They compete more directly when a company is deciding whether to configure negotiated enterprise contracts entirely inside Metronome or use Verdix to operationalise them through its existing finance stack.</p>

          <DecisionGuide />

          <h2>The takeaway</h2>

          <p>Choose Metronome when real-time metering, flexible pricing and customer-facing usage visibility are central to your product.</p>

          <p>Choose Verdix when the main challenge is translating signed customer and partner agreements into approved financial workflows without replacing existing systems.</p>

          <p>Metronome turns usage into real-time charges. Verdix turns executed agreements and operational evidence into instructions for what should be billed or paid.</p>

        </article>

        {/* CTA */}
        <div className="mt-14 rounded-2xl p-8 text-center" style={{ background: '#EAF3DE', border: '0.5px solid #C0DD97' }}>
          <p className="font-medium mb-5" style={{ color: '#1A3D2B', fontSize: 16, lineHeight: 1.6 }}>
            Operationalise bespoke customer and partner agreements while keeping the billing and finance systems you already use.
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
