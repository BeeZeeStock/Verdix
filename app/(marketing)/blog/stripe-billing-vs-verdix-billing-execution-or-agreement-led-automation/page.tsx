import Link from 'next/link'
import { VerdixLogo } from '@/components/VerdixLogo'

export const metadata = {
  title: 'Stripe Billing vs Verdix: billing execution or agreement-led automation? | Verdix',
  description:
    'Compare Stripe Billing and Verdix across subscriptions, usage metering, bespoke contracts, invoice execution, pricing and partner reconciliation.',
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
  { area: 'Starting point',             stripe: 'Products, prices, meters, quotes and subscriptions in Stripe', verdix: 'Executed customer or partner agreement',           verdixStrong: false },
  { area: 'Contract handling',          stripe: 'Arranged through configured Stripe objects',                   verdix: 'Terms interpreted from the signed agreement',     verdixStrong: true  },
  { area: 'Usage collection',           stripe: 'Events sent to Stripe, CSV upload or bulk import',             verdix: 'Pulled from existing customer-defined endpoints', verdixStrong: false },
  { area: 'Real-time metering',         stripe: 'Supported; advanced via Metronome',                           verdix: 'Not the primary focus',                           verdixStrong: false },
  { area: 'Pricing and rating',         stripe: 'Native billing engine',                                       verdix: 'Agreement-specific terms applied to retrieved data',verdixStrong: false },
  { area: 'Invoice generation',         stripe: 'Native',                                                      verdix: 'Approved instructions sent to Stripe or other system',verdixStrong: false },
  { area: 'Payment collection',         stripe: 'Native Stripe capability',                                    verdix: 'Remains with the chosen payment provider',         verdixStrong: false },
  { area: 'Collections and retries',    stripe: 'Native',                                                      verdix: 'Remain in the existing stack',                     verdixStrong: false },
  { area: 'Partner-invoice validation', stripe: 'Not publicly positioned as a core workflow',                  verdix: 'Core workflow',                                   verdixStrong: true  },
  { area: 'Architecture',               stripe: 'Billing and payment execution platform',                      verdix: 'Agreement-operations layer',                      verdixStrong: true  },
]

function ComparisonTable() {
  return (
    <div style={{ margin: '28px -4px', borderRadius: 14, overflow: 'hidden', border: '0.5px solid rgba(26,61,43,0.13)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr 1fr' }}>

        {/* Column headers */}
        <div style={{ padding: '10px 14px', background: '#F5F3EE', borderBottom: '0.5px solid rgba(26,61,43,0.1)', borderRight: '0.5px solid rgba(26,61,43,0.08)' }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#9A9490' }}>Area</span>
        </div>
        <div style={{ padding: '10px 14px', background: '#5752D8', borderBottom: '0.5px solid rgba(255,255,255,0.06)', borderRight: '0.5px solid rgba(255,255,255,0.05)' }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#D8D6FF' }}>Stripe Billing</span>
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
              <div style={{ padding: '9px 14px', background: even ? '#6460DC' : '#5752D8', borderBottom: rowBorderDark, borderRight: '0.5px solid rgba(255,255,255,0.04)', display: 'flex', alignItems: 'center' }}>
                <span style={{ fontSize: 11.5, color: '#D8D6FF', lineHeight: 1.4 }}>{r.stripe}</span>
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

const STRIPE_CHAIN = [
  { label: 'Usage events',       bg: '#4B47CC', text: '#C8C6FF' },
  { label: 'Meter aggregation',  bg: '#5752D8', text: '#D8D6FF' },
  { label: 'Configured price',   bg: '#6560E0', text: '#E8E6FF' },
  { label: 'Invoice',            bg: '#7E7AE8', text: '#fff'    },
  { label: 'Payment collected',  bg: '#B8B5F5', text: '#1A1860' },
]

const VERDIX_CHAIN = [
  { label: 'Signed agreement',     bg: '#1A3D2B', text: '#EAF3DE' },
  { label: 'Usage endpoint',       bg: '#27AE60', text: '#fff'    },
  { label: 'Contractual calc.',    bg: '#3DAA7F', text: '#fff'    },
  { label: 'Approved instruction', bg: '#52C48A', text: '#fff'    },
  { label: 'Stripe invoice',       bg: '#B8E0CC', text: '#1A3D2B' },
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
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#4A7C59' }}>How usage becomes an invoice</span>
      </div>
      <div style={{ padding: '18px 20px 4px' }}>
        {renderChain(STRIPE_CHAIN,  'Stripe Billing — configured execution')}
        {renderChain(VERDIX_CHAIN,  'Verdix → Stripe — agreement-first', true)}
      </div>
    </div>
  )
}

// ── Diagram 3: Decision guide (3-row aligned grid) ────────────────────────────

const DECISION_COLS = [
  {
    condition: 'Standard plans, usage events into Stripe, invoicing and payment collection within one ecosystem',
    result:    'Stripe alone',
    resultBg:  '#5752D8',
    resultText:'#E8E6FF',
    condBg:    '#F0F0FD',
    condText:  '#3A3530',
    arrowCol:  'rgba(87,82,216,0.4)',
    verdix:    false,
  },
  {
    condition: 'Bespoke signed agreements; Finance must interpret contracts and pull operational data before Stripe can invoice',
    result:    'Add Verdix',
    resultBg:  '#27AE60',
    resultText:'#fff',
    condBg:    '#EAF3DE',
    condText:  '#1A3D2B',
    arrowCol:  '#27AE60',
    verdix:    true,
  },
  {
    condition: 'Verdix determines what to charge and reconciles partner invoices; Stripe executes the invoice and collects payment',
    result:    'Both together',
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
            Stripe Billing vs Verdix: billing execution or agreement-led automation?
          </h1>
          <p className="text-stone leading-relaxed" style={{ fontSize: 16 }}>
            Stripe Billing executes invoices and collects payments. Verdix handles the work that often comes first: interpreting a signed agreement, connecting its terms to operational data and determining what should be billed or paid.
          </p>
        </div>

        <hr style={{ border: 'none', borderTop: '0.5px solid rgba(26,61,43,0.10)', marginBottom: 40 }} />

        <article className="prose-verdix">

          <h2>Stripe and Verdix operate at different points in the workflow</h2>

          <p>Stripe Billing is a broad subscription and usage-billing platform. It can manage pricing, subscriptions, usage meters, invoices, payment collection and revenue recovery.</p>

          <p>Verdix focuses on the work that often happens before those systems are used: interpreting a signed agreement, connecting its terms to operational data and determining what should be billed or paid.</p>

          <p>For many companies, the choice is not necessarily Stripe or Verdix. Verdix can prepare an approved billing instruction that Stripe then invoices and collects.</p>

          <h2>What Stripe Billing does</h2>

          <p><a href="https://stripe.com/billing" target="_blank" rel="noopener noreferrer">Stripe Billing</a> supports:</p>

          <ul>
            <li>recurring subscriptions;</li>
            <li>flat-rate, seat-based and tiered pricing;</li>
            <li>usage-based charges;</li>
            <li>subscription schedules;</li>
            <li>quotes;</li>
            <li>discounts and trials;</li>
            <li>invoicing;</li>
            <li>payment collection;</li>
            <li>customer portals;</li>
            <li>payment retries and revenue recovery.</li>
          </ul>

          <p>Stripe can turn an accepted quote into an invoice, subscription or subscription schedule. Subscription schedules can model future phases, upgrades, downgrades and other changes over the life of a commercial arrangement.</p>

          <p>For usage-based billing, businesses create meters and send usage events to Stripe. The meter aggregates those events over the billing period, and Stripe applies the associated price when producing the invoice.</p>

          <h2>Stripe&apos;s expanding usage-billing capabilities</h2>

          <p>Stripe completed its acquisition of Metronome in January 2026, significantly expanding its ability to support complex usage-based models. Stripe now distinguishes between its standard Meters API and more advanced usage-based billing through Metronome.</p>

          <p>This makes Stripe increasingly capable for AI, SaaS and digital-platform companies that want billing and payments within one ecosystem.</p>

          <h2>What Verdix does</h2>

          <p>Verdix starts with the final signed customer or partner agreement.</p>

          <p>For customer billing, Verdix:</p>

          <ul>
            <li>interprets the agreement;</li>
            <li>identifies rates, thresholds, commitments and billing dates;</li>
            <li>maps the relevant terms to customer-defined operational endpoints;</li>
            <li>retrieves the required usage;</li>
            <li>calculates the billing schedule;</li>
            <li>routes the result for approval;</li>
            <li>sends the approved instruction to Stripe or another chosen system.</li>
          </ul>

          <p>For partner reconciliation, Verdix compares the partner agreement, operational activity and the incoming invoice. It determines the expected amount, highlights differences and prepares supporting evidence for approval or dispute.</p>

          <h2>Key differences</h2>

          <ComparisonTable />

          <h2>The main contract difference</h2>

          <p>Stripe supports complex sales-led billing, but its documented process generally begins with commercial terms being represented through products, prices, quotes, subscriptions and schedules. A team can configure a quote in Stripe and convert it into a subscription after acceptance. It can also model future pricing phases through a subscription schedule.</p>

          <p>What Stripe&apos;s official documentation does not currently position as a core workflow is: upload an independently executed customer contract, interpret its clauses and automatically map those clauses to existing operational data.</p>

          <p>That is the starting point for Verdix. The distinction is straightforward: Stripe executes configured billing logic. Verdix helps derive that logic from the signed agreement and supporting data.</p>

          <h2>The usage-data difference</h2>

          <ArchitectureComparison />

          <p>Stripe&apos;s native usage-billing model expects businesses to record usage against configured meters — determining which events to send, which customer they belong to, which meter receives them and which price applies. This is a strong option where Stripe is already the billing source of truth and the product can report usage into its meter infrastructure.</p>

          <p>Verdix retrieves the required information from an existing operational endpoint when the agreement workflow runs. This suits companies where usage already exists in a reliable internal system, invoices are prepared monthly or periodically, and the company does not want to establish another raw-event pipeline.</p>

          <h2>When Stripe Billing may be sufficient</h2>

          <p>Stripe may be enough when:</p>

          <ul>
            <li>customers use relatively standard plans;</li>
            <li>contract terms can be configured directly as products and prices;</li>
            <li>Stripe is already the subscription source of truth;</li>
            <li>the product can send usage events into Stripe;</li>
            <li>Stripe should generate invoices and collect payments;</li>
            <li>supplier or partner reconciliation is not required.</li>
          </ul>

          <p>For many self-service and moderately complex subscription businesses, adding another agreement layer may be unnecessary.</p>

          <h2>When Verdix may add value</h2>

          <p>Verdix becomes more relevant when:</p>

          <ul>
            <li>the signed agreement differs materially from standard product plans;</li>
            <li>terms are spread across order forms and amendments;</li>
            <li>Finance manually converts contracts into Stripe configurations;</li>
            <li>usage must be requested from Product or Engineering;</li>
            <li>the company already has trustworthy operational APIs;</li>
            <li>historic contracts need to be operationalised;</li>
            <li>incoming partner invoices also need validation;</li>
            <li>Finance wants a clear link from contract clause to invoice instruction.</li>
          </ul>

          <p>The strongest Verdix use case is: &ldquo;Stripe can issue and collect our invoices. The difficult part is determining exactly what we should send to Stripe.&rdquo;</p>

          <h2>Pricing difference</h2>

          <p><a href="https://stripe.com/billing/pricing" target="_blank" rel="noopener noreferrer">Stripe Billing</a> currently offers pay-as-you-go pricing at 0.7% of billing volume, annual subscription tiers with monthly allowances, and custom pricing for larger volumes. Basic usage billing through the Meters API includes up to 100 million events per month; advanced usage billing through Metronome has separate commercial terms. Payment-processing fees are separate from Billing fees.</p>

          <div style={{ margin: '20px 0', borderRadius: 12, overflow: 'hidden', border: '0.5px solid rgba(26,61,43,0.12)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
              <div style={{ padding: '9px 16px', background: '#F5F3EE', borderBottom: '0.5px solid rgba(26,61,43,0.09)', borderRight: '0.5px solid rgba(26,61,43,0.09)' }}>
                <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#9A9490' }}>Annual billing volume</span>
              </div>
              <div style={{ padding: '9px 16px', background: '#F5F3EE', borderBottom: '0.5px solid rgba(26,61,43,0.09)' }}>
                <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#9A9490' }}>Illustrative Stripe fee at 0.7%</span>
              </div>
              {[['€1 million','€7,000'],['€5 million','€35,000'],['€10 million','€70,000']].map(([vol, fee], i) => (
                <div key={i} style={{ display: 'contents' }}>
                  <div style={{ padding: '9px 16px', background: i % 2 === 0 ? '#FAFAF8' : '#fff', borderBottom: i < 2 ? '0.5px solid rgba(26,61,43,0.06)' : 'none', borderRight: '0.5px solid rgba(26,61,43,0.06)', fontVariantNumeric: 'tabular-nums' as const }}>
                    <span style={{ fontSize: 13, color: '#3A3530' }}>{vol}</span>
                  </div>
                  <div style={{ padding: '9px 16px', background: i % 2 === 0 ? '#FAFAF8' : '#fff', borderBottom: i < 2 ? '0.5px solid rgba(26,61,43,0.06)' : 'none', fontVariantNumeric: 'tabular-nums' as const }}>
                    <span style={{ fontSize: 13, color: '#3A3530', fontWeight: 600 }}>{fee}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <p style={{ fontSize: 12, color: '#9A9490', marginTop: -8 }}>Actual costs depend on selected plan, billing volume, geography and negotiated terms.</p>

          <p>Verdix is intended to charge according to completed agreement workflows — one customer billing cycle produced from an agreement and operational data, or one partner invoice reconciled against its agreement — rather than by invoice value or raw-event volume.</p>

          <h2>Are Stripe and Verdix competitors or complements?</h2>

          <p>They are primarily complementary, with some overlap.</p>

          <p>They <strong>overlap</strong> when a company can represent its complete commercial arrangement directly through Stripe&apos;s quotes, prices, meters and subscription schedules. In that case, Stripe may already solve enough of the workflow.</p>

          <p>They <strong>complement each other</strong> when the signed agreement and operational data must first be interpreted before Stripe can execute the charge. The combined workflow becomes:</p>

          <ul>
            <li>Verdix interprets the signed agreement and retrieves the required usage;</li>
            <li>Finance approves the billing schedule;</li>
            <li>Stripe receives the approved instruction, issues the invoice and collects payment;</li>
            <li>ERP is updated;</li>
            <li>Verdix separately validates incoming supplier or partner invoices before they enter accounts payable.</li>
          </ul>

          <DecisionGuide />

          <h2>The takeaway</h2>

          <p>Choose Stripe Billing when you need a proven system for subscriptions, usage billing, invoicing and payment collection.</p>

          <p>Add Verdix when the difficult part happens before Stripe: interpreting bespoke agreements, retrieving the correct operational data and determining the approved billing instruction.</p>

          <p>Verdix determines what should be billed. Stripe issues the invoice and collects the payment.</p>

        </article>

        {/* CTA */}
        <div className="mt-14 rounded-2xl p-8 text-center" style={{ background: '#EAF3DE', border: '0.5px solid #C0DD97' }}>
          <p className="font-medium mb-5" style={{ color: '#1A3D2B', fontSize: 16, lineHeight: 1.6 }}>
            Turn signed agreements and operational data into approved Stripe billing instructions — without replacing the payment infrastructure you already use.
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
