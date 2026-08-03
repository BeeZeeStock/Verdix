import Link from 'next/link'
import { VerdixLogo } from '@/components/VerdixLogo'

export const metadata = {
  title: 'Platform fees, billing percentages and event charges: how billing software is priced | Verdix',
  description:
    'Billing platforms may charge by revenue, usage events, contracts, customers or subscription tier. Learn how each model works and how to estimate the true cost.',
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

// ── Diagram 1: Pricing model summary table ─────────────────────────────────────

const PRICING_MODELS = [
  {
    name:     'Percentage of revenue',
    unit:     'Revenue processed through the platform',
    bestFor:  'Early-stage companies scaling from low volumes',
    dot:      '#1A3D2B',
    verdix:   false,
  },
  {
    name:     'Usage events',
    unit:     'Raw events received (API calls, tokens, transactions)',
    bestFor:  'Real-time metering at very high event volumes',
    dot:      '#4A7C59',
    verdix:   false,
  },
  {
    name:     'Platform subscription',
    unit:     'Fixed monthly or annual fee by feature tier',
    bestFor:  'Companies needing a full revenue-operations suite',
    dot:      '#6B7280',
    verdix:   false,
  },
  {
    name:     'Contracts or customers',
    unit:     'Active contracts, accounts or legal entities',
    bestFor:  'Contract-to-cash platforms with per-agreement work',
    dot:      '#3DAA7F',
    verdix:   false,
  },
  {
    name:     'Completed workflows',
    unit:     'Billing cycles or reconciliations completed',
    bestFor:  'Periodic agreement-led billing and partner reconciliation',
    dot:      '#27AE60',
    verdix:   true,
  },
]

function PricingModelTable() {
  return (
    <div style={{ margin: '32px -4px', borderRadius: 14, overflow: 'hidden', border: '0.5px solid rgba(26,61,43,0.13)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.3fr 1.3fr' }}>

        {/* Column headers */}
        <div style={{ padding: '10px 16px', background: '#F5F3EE', borderBottom: '0.5px solid rgba(26,61,43,0.1)', borderRight: '0.5px solid rgba(26,61,43,0.08)' }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#4A7C59' }}>Pricing model</span>
        </div>
        <div style={{ padding: '10px 16px', background: '#F5F3EE', borderBottom: '0.5px solid rgba(26,61,43,0.1)', borderRight: '0.5px solid rgba(26,61,43,0.08)' }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#4A7C59' }}>Primary cost unit</span>
        </div>
        <div style={{ padding: '10px 16px', background: '#F5F3EE', borderBottom: '0.5px solid rgba(26,61,43,0.1)' }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#4A7C59' }}>Best for</span>
        </div>

        {/* Data rows */}
        {PRICING_MODELS.map((m, i) => {
          const isLast    = i === PRICING_MODELS.length - 1
          const even      = i % 2 === 0
          const rowBorder = isLast ? 'none' : '0.5px solid rgba(26,61,43,0.07)'
          const cellBg    = m.verdix ? '#EAF3DE' : even ? '#FAFAF8' : '#fff'
          return (
            <div key={i} style={{ display: 'contents' }}>
              <div style={{ padding: '11px 16px', background: cellBg, borderBottom: rowBorder, borderRight: '0.5px solid rgba(26,61,43,0.07)', display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 7, height: 7, borderRadius: '50%', background: m.dot, flexShrink: 0 }} />
                <span style={{ fontSize: 12, fontWeight: m.verdix ? 600 : 400, color: m.verdix ? '#1A3D2B' : '#3A3530', lineHeight: 1.3 }}>{m.name}</span>
                {m.verdix && (
                  <span style={{ fontSize: 8.5, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.04em', background: '#27AE60', color: '#fff', padding: '1px 5px', borderRadius: 3, flexShrink: 0 }}>Verdix</span>
                )}
              </div>
              <div style={{ padding: '11px 16px', background: cellBg, borderBottom: rowBorder, borderRight: '0.5px solid rgba(26,61,43,0.07)', display: 'flex', alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: m.verdix ? '#1A3D2B' : '#3A3530', lineHeight: 1.4 }}>{m.unit}</span>
              </div>
              <div style={{ padding: '11px 16px', background: cellBg, borderBottom: rowBorder, display: 'flex', alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: m.verdix ? '#1A3D2B' : '#6B6660', lineHeight: 1.4 }}>{m.bestFor}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Diagram 2: Volume cost bar chart ───────────────────────────────────────────

const VOLUME_SCENARIOS = [
  { label: '€1M billing volume',   cost: '€7,000 / year',   pct: 10,  bg: '#B8E0CC', textCol: '#1A3D2B' },
  { label: '€5M billing volume',   cost: '€35,000 / year',  pct: 50,  bg: '#27AE60', textCol: '#fff'    },
  { label: '€10M billing volume',  cost: '€70,000 / year',  pct: 100, bg: '#1A3D2B', textCol: '#EAF3DE' },
]

function VolumeCostVisual() {
  return (
    <div style={{ margin: '28px -4px', borderRadius: 14, overflow: 'hidden', border: '0.5px solid rgba(26,61,43,0.13)', background: '#fff' }}>
      <div style={{ padding: '11px 20px', background: '#F5F3EE', borderBottom: '0.5px solid rgba(26,61,43,0.1)' }}>
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#4A7C59' }}>
          Cost at 0.7% of billing volume
        </span>
      </div>
      <div style={{ padding: '20px 22px 18px' }}>
        {VOLUME_SCENARIOS.map((s, i) => (
          <div key={i} style={{ marginBottom: i < VOLUME_SCENARIOS.length - 1 ? 13 : 0 }}>
            <div style={{ marginBottom: 5 }}>
              <span style={{ fontSize: 11.5, color: '#6B6660' }}>{s.label}</span>
            </div>
            <div style={{ height: 34, background: '#F5F3EE', borderRadius: 7, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${s.pct}%`, background: s.bg, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 12 }}>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: s.textCol, whiteSpace: 'nowrap' as const }}>{s.cost}</span>
              </div>
            </div>
          </div>
        ))}
        <div style={{ marginTop: 14, fontSize: 11, color: '#9A9490' }}>
          Illustrative example based on Stripe Billing pay-as-you-go rate. Actual rates may vary.
        </div>
      </div>
    </div>
  )
}

// ── Diagram 3: Platform scope comparison ───────────────────────────────────────

const SCOPE_ROWS = [
  { cap: 'Real-time usage metering',   full: 'Included',       meter: 'Core capability',  verdix: 'Via API pull'  },
  { cap: 'Contract interpretation',    full: 'Some platforms', meter: 'Not included',     verdix: 'Included'      },
  { cap: 'Invoice generation',         full: 'Included',       meter: 'Not included',     verdix: 'Via partner'   },
  { cap: 'Partner reconciliation',     full: 'Some platforms', meter: 'Not included',     verdix: 'Included'      },
  { cap: 'Payment processing',         full: 'Included',       meter: 'Not included',     verdix: 'Via partner'   },
  { cap: 'Revenue recognition',        full: 'Some platforms', meter: 'Not included',     verdix: 'Not included'  },
  { cap: 'ERP integration',            full: 'Some platforms', meter: 'Not included',     verdix: 'Included'      },
]

function ScopeComparison() {
  const fullColor  = (v: string) => v === 'Included' ? '#A8CCB5' : v === 'Some platforms' ? '#7AAF87' : '#5A7A68'
  const meterColor = (v: string) => v === 'Core capability' ? '#4A7C59' : '#9CA3AF'
  const meterWeight= (v: string): number => v === 'Core capability' ? 600 : 400
  const verdixColor= (v: string) => v === 'Included' ? '#1A3D2B' : v === 'Via API pull' || v === 'Via partner' ? '#4A7C59' : '#9CA3AF'
  const verdixWeight=(v: string): number => v === 'Included' ? 600 : 400

  return (
    <div style={{ margin: '28px -4px', borderRadius: 14, overflow: 'hidden', border: '0.5px solid rgba(26,61,43,0.13)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr 1fr' }}>

        {/* Column headers */}
        <div style={{ padding: '10px 14px', background: '#F5F3EE', borderBottom: '0.5px solid rgba(26,61,43,0.1)', borderRight: '0.5px solid rgba(26,61,43,0.08)' }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#9A9490' }}>Capability</span>
        </div>
        <div style={{ padding: '10px 14px', background: '#1A3D2B', borderBottom: '0.5px solid rgba(255,255,255,0.08)', borderRight: '0.5px solid rgba(255,255,255,0.06)' }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#4A7C59' }}>Full billing platform</span>
        </div>
        <div style={{ padding: '10px 14px', background: '#F5F3EE', borderBottom: '0.5px solid rgba(26,61,43,0.1)', borderRight: '0.5px solid rgba(26,61,43,0.08)' }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#9A9490' }}>Metering engine</span>
        </div>
        <div style={{ padding: '10px 14px', background: '#27AE60', borderBottom: '0.5px solid rgba(255,255,255,0.15)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#EAF3DE' }}>Agreement-ops</span>
            <span style={{ fontSize: 8.5, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.05em', background: '#C4E0B2', color: '#1A3D2B', padding: '2px 5px', borderRadius: 4 }}>Verdix</span>
          </div>
        </div>

        {/* Data rows */}
        {SCOPE_ROWS.map((r, i) => {
          const isLast          = i === SCOPE_ROWS.length - 1
          const even            = i % 2 === 0
          const rowBorderLight  = isLast ? 'none' : '0.5px solid rgba(26,61,43,0.07)'
          const rowBorderGreen  = isLast ? 'none' : '0.5px solid rgba(39,174,96,0.12)'
          return (
            <div key={i} style={{ display: 'contents' }}>
              <div style={{ padding: '9px 14px', background: even ? '#FAFAF8' : '#fff', borderBottom: rowBorderLight, borderRight: '0.5px solid rgba(26,61,43,0.07)', display: 'flex', alignItems: 'center' }}>
                <span style={{ fontSize: 11.5, fontWeight: 500, color: '#6B6660' }}>{r.cap}</span>
              </div>
              <div style={{ padding: '9px 14px', background: even ? '#1E4535' : '#1A3D2B', borderBottom: isLast ? 'none' : '0.5px solid rgba(255,255,255,0.06)', borderRight: '0.5px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center' }}>
                <span style={{ fontSize: 11.5, color: fullColor(r.full), lineHeight: 1.4 }}>{r.full}</span>
              </div>
              <div style={{ padding: '9px 14px', background: even ? '#FAFAF8' : '#fff', borderBottom: rowBorderLight, borderRight: '0.5px solid rgba(26,61,43,0.07)', display: 'flex', alignItems: 'center' }}>
                <span style={{ fontSize: 11.5, color: meterColor(r.meter), fontWeight: meterWeight(r.meter), lineHeight: 1.4 }}>{r.meter}</span>
              </div>
              <div style={{ padding: '9px 14px', background: even ? '#E8F5EC' : '#F0FAF3', borderBottom: rowBorderGreen, display: 'flex', alignItems: 'center' }}>
                <span style={{ fontSize: 11.5, color: verdixColor(r.verdix), fontWeight: verdixWeight(r.verdix), lineHeight: 1.4 }}>{r.verdix}</span>
              </div>
            </div>
          )
        })}
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
            Platform fees, billing percentages and event charges: how billing software is priced
          </h1>
          <p className="text-stone leading-relaxed" style={{ fontSize: 16 }}>
            Billing platforms may charge by revenue, usage events, contracts, customers or subscription tier. Understanding the pricing unit determines how software cost changes as your business grows.
          </p>
        </div>

        <hr style={{ border: 'none', borderTop: '0.5px solid rgba(26,61,43,0.10)', marginBottom: 40 }} />

        <article className="prose-verdix">

          <h2>Billing software does not have one standard pricing model</h2>

          <p>Two billing platforms may appear to solve a similar problem but charge in completely different ways.</p>

          <p>The price may depend on:</p>

          <ul>
            <li>revenue processed;</li>
            <li>usage events received;</li>
            <li>active customers or contracts;</li>
            <li>invoices generated;</li>
            <li>platform features;</li>
            <li>implementation and support;</li>
            <li>completed billing workflows.</li>
          </ul>

          <PricingModelTable />

          <h2>1. Percentage of billing volume</h2>

          <p>Some platforms charge a percentage of the revenue processed through their billing system.</p>

          <p>For example, <a href="https://stripe.com/en-se/billing/pricing" target="_blank" rel="noopener noreferrer" style={{ color: '#27AE60' }}>Stripe Billing&apos;s pay-as-you-go plan</a> currently charges 0.7% of billing volume, including recurring billing transactions processed both on and off Stripe. Stripe also offers annual subscription tiers for companies that want more predictable costs.</p>

          <VolumeCostVisual />

          <p>Under a percentage model, cost follows billing volume directly.</p>

          <p>Advantages:</p>

          <ul>
            <li>low upfront commitment;</li>
            <li>easy to begin;</li>
            <li>cost follows billing volume;</li>
            <li>suitable for uncertain or early-stage demand.</li>
          </ul>

          <p>The software cost rises with revenue even when:</p>

          <ul>
            <li>the number of contracts stays similar;</li>
            <li>the billing workflow does not become more complex;</li>
            <li>the platform performs the same calculation each month.</li>
          </ul>

          <p>Percentage pricing can therefore become expensive for companies with high contract values but relatively few billing workflows.</p>

          <h2>2. Usage-event pricing</h2>

          <p>Metering platforms may charge according to the number of raw events they process.</p>

          <p>An event could represent:</p>

          <ul>
            <li>an API call;</li>
            <li>an AI-token record;</li>
            <li>a transaction;</li>
            <li>a compute action;</li>
            <li>a message;</li>
            <li>a completed workflow.</li>
          </ul>

          <p>This model aligns price with the technical load placed on the metering infrastructure. <a href="https://metronome.com/pricing" target="_blank" rel="noopener noreferrer" style={{ color: '#27AE60' }}>Metronome&apos;s current Starter plan</a> includes $100,000 in billing volume and 10 million usage events. Above those allowances, its published rates are 0.8% of additional billing volume and $0.04 per 1,000 additional events.</p>

          <p>Advantages:</p>

          <ul>
            <li>appropriate for high-volume real-time metering;</li>
            <li>cost reflects event-processing demand;</li>
            <li>supports granular product analytics and usage visibility.</li>
          </ul>

          <p>Event counts can grow much faster than revenue. A product may generate thousands of technical events to calculate one customer invoice. Before choosing event-based pricing, companies should estimate:</p>

          <ul>
            <li>events generated per customer;</li>
            <li>events generated per product action;</li>
            <li>expected growth in activity;</li>
            <li>duplicate and retry events;</li>
            <li>retention and reprocessing requirements.</li>
          </ul>

          <h2>3. Platform subscription</h2>

          <p>Some providers charge a fixed monthly or annual platform fee, usually linked to feature tiers or company size.</p>

          <p><a href="https://www.tabs.com/pricing" target="_blank" rel="noopener noreferrer" style={{ color: '#27AE60' }}>Tabs</a> currently lists its Launch plan at $2,000 per month for companies with up to $5 million in annual revenue and up to 100 active contracts. Higher tiers use custom pricing, and implementation is priced separately according to the selected plan.</p>

          <p>Advantages:</p>

          <ul>
            <li>more predictable than revenue-percentage pricing;</li>
            <li>easier to budget;</li>
            <li>may include several finance functions in one package;</li>
            <li>cost does not change with every invoice.</li>
          </ul>

          <p>Limitations include a high starting price for smaller companies, bundled features not all organisations need, additional implementation costs, and the possibility of paying for unused capacity.</p>

          <p>A platform subscription makes more sense when the business needs a broad revenue-operations system rather than one specific workflow.</p>

          <h2>4. Contract- or customer-based pricing</h2>

          <p>Another model charges according to:</p>

          <ul>
            <li>active contracts;</li>
            <li>active subscriptions;</li>
            <li>billed customers;</li>
            <li>legal entities;</li>
            <li>connected accounts.</li>
          </ul>

          <p>This can align well with contract-to-cash platforms because each customer agreement creates operational work. However, companies should clarify how the provider defines an &ldquo;active&rdquo; contract. Questions include:</p>

          <ul>
            <li>Is a contract counted every month?</li>
            <li>Are amendments counted separately?</li>
            <li>Are expired agreements included?</li>
            <li>Does one master agreement with several order forms count once or several times?</li>
            <li>Are partner agreements charged in the same way as customer agreements?</li>
          </ul>

          <h2>5. Workflow-based pricing</h2>

          <p>Workflow pricing charges when the platform completes a defined business process.</p>

          <p>For example:</p>

          <ul>
            <li>one customer billing cycle generated from an agreement and usage data;</li>
            <li>one partner invoice reconciled against its agreement;</li>
            <li>one approved billing schedule sent to an invoicing system.</li>
          </ul>

          <p>This differs from charging for every raw event or taking a percentage of the resulting invoice.</p>

          <p>Advantages:</p>

          <ul>
            <li>cost is connected to a completed operational outcome;</li>
            <li>high-value contracts do not automatically cost more;</li>
            <li>raw product-event growth does not necessarily increase the fee;</li>
            <li>suitable for periodic agreement-led workflows.</li>
          </ul>

          <p>The provider must clearly define what counts as one workflow, including agreement interpretation, usage retrieval, calculation, review and approval, downstream integration, and reprocessing after corrections.</p>

          <h2>Do not compare price without comparing scope</h2>

          <p>A lower price does not always mean a lower total cost. Different platforms may include different capabilities.</p>

          <ScopeComparison />

          <p>A full billing platform may cost more because it replaces several existing systems. An agreement-operations platform may cost less because it works with systems the company already has.</p>

          <p>The comparison should therefore begin with: which part of the workflow are we paying this platform to own?</p>

          <h2>Remember the implementation cost</h2>

          <p>The licence fee is only one part of the total cost. Implementation may require:</p>

          <ul>
            <li>product instrumentation;</li>
            <li>event-pipeline development;</li>
            <li>historic data migration;</li>
            <li>customer and contract migration;</li>
            <li>CRM and ERP integrations;</li>
            <li>testing parallel invoices;</li>
            <li>Finance training;</li>
            <li>ongoing engineering support.</li>
          </ul>

          <p>A platform with a low published price may still be costly if it requires a major billing migration. A higher-cost platform may be justified when it removes several internal systems and substantial manual work.</p>

          <h2>Questions to ask every vendor</h2>

          <p>Before selecting a pricing model, ask:</p>

          <ul>
            <li>What is the primary chargeable unit?</li>
            <li>Does price increase with revenue, events, contracts or customers?</li>
            <li>What is included in the base fee?</li>
            <li>Are implementation and integrations charged separately?</li>
            <li>Is there a minimum annual commitment?</li>
            <li>Are test, duplicate or failed events billable?</li>
            <li>What happens when usage grows tenfold?</li>
            <li>Can the company retain its existing billing and payment systems?</li>
            <li>How are amendments, recalculations and historical corrections priced?</li>
            <li>Are customer billing and partner reconciliation included?</li>
          </ul>

          <h2>Where Verdix fits</h2>

          <p>Verdix is designed around completed agreement workflows rather than taking a percentage of customer revenue or charging for every raw product event.</p>

          <p>A workflow can represent:</p>

          <ul>
            <li>a customer billing cycle generated from the agreement and relevant operational data; or</li>
            <li>a partner invoice reconciled against its agreement and supporting activity.</li>
          </ul>

          <p>Verdix retrieves only the information required from customer-defined endpoints and sends approved billing instructions to the company&apos;s chosen billing or invoicing platform. The existing finance stack remains in place.</p>

          <h2>The takeaway</h2>

          <p>Billing-software pricing reflects the architecture and scope of the product.</p>

          <ul>
            <li>Revenue-percentage pricing is easy to start but scales with billing volume.</li>
            <li>Event pricing suits real-time metering but can grow with technical activity.</li>
            <li>Platform subscriptions provide predictability but may have a high entry point.</li>
            <li>Contract pricing follows the number of commercial relationships.</li>
            <li>Workflow pricing connects cost to completed billing or reconciliation work.</li>
          </ul>

          <p>The right model is the one that reflects the capability your company actually needs—not simply the amount of revenue it earns or the number of events its product generates.</p>

        </article>

        {/* CTA */}
        <div className="mt-14 rounded-2xl p-8 text-center" style={{ background: '#EAF3DE', border: '0.5px solid #C0DD97' }}>
          <p className="font-medium mb-5" style={{ color: '#1A3D2B', fontSize: 16, lineHeight: 1.6 }}>
            Pay for completed agreement workflows — not a percentage of revenue or every raw usage event.
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
