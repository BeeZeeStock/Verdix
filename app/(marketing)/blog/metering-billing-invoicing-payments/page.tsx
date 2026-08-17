import Link from 'next/link'
import { VerdixLogo } from '@/components/VerdixLogo'
import { isSelfServiceSignupEnabled } from '@/lib/feature-flags'

export const metadata = {
  title: 'Metering, billing, invoicing and payments: what does each system actually do? | Verdix',
  description:
    'Learn the difference between metering, rating, billing, invoicing and payments — and where agreement operations fit in modern B2B SaaS.',
}

// ── Billing stack diagram ──────────────────────────────────────────────────────

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  )
}

const LAYER_ICONS: Record<string, React.ReactNode> = {
  agreement: (
    <Icon>
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8L14 2z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="12" y2="17" />
    </Icon>
  ),
  ops: (
    <Icon>
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </Icon>
  ),
  metering: (
    <Icon>
      <path d="M12 2a10 10 0 1 0 10 10" />
      <path d="M12 12L8.5 8.5" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      <path d="M12 2v2M22 12h-2M19.07 4.93l-1.41 1.41" />
    </Icon>
  ),
  rating: (
    <Icon>
      <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z" />
      <line x1="7" y1="7" x2="7.01" y2="7" />
    </Icon>
  ),
  billing: (
    <Icon>
      <path d="M19 21l-3.5-2-3.5 2-3.5-2L5 21V3h14v18z" />
      <line x1="9" y1="9" x2="15" y2="9" />
      <line x1="9" y1="13" x2="15" y2="13" />
    </Icon>
  ),
  invoicing: (
    <Icon>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <line x1="2" y1="10" x2="22" y2="10" />
      <line x1="7" y1="15" x2="10" y2="15" />
    </Icon>
  ),
  payments: (
    <Icon>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <line x1="2" y1="10" x2="22" y2="10" />
    </Icon>
  ),
  accounting: (
    <Icon>
      <path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z" />
      <path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z" />
    </Icon>
  ),
  partner: (
    <Icon>
      <path d="M7 16V4m0 0L3 8m4-4l4 4" />
      <path d="M17 8v12m0 0l4-4m-4 4l-4-4" />
    </Icon>
  ),
}

const STACK_LAYERS = [
  { id: 'agreement', label: 'Commercial agreement',   desc: 'What the customer agreed to pay',                              verdix: false },
  { id: 'ops',       label: 'Agreement operations',   desc: 'How the contract becomes a working billing process',           verdix: true  },
  { id: 'metering',  label: 'Metering',               desc: 'How much the customer used',                                   verdix: false },
  { id: 'rating',    label: 'Rating',                 desc: 'What that usage is worth',                                     verdix: true  },
  { id: 'billing',   label: 'Billing',                desc: 'What should be charged and when',                             verdix: true  },
  { id: 'invoicing', label: 'Invoicing',              desc: 'How the charge is presented',                                  verdix: false },
  { id: 'payments',  label: 'Payments',               desc: 'How the money is collected',                                   verdix: false },
  { id: 'accounting',label: 'Accounting',             desc: 'How the result is recorded',                                   verdix: false },
  { id: 'partner',   label: 'Partner reconciliation', desc: 'Whether incoming partner charges are correct',                 verdix: true  },
]

function BillingStackDiagram() {
  return (
    <div style={{ margin: '36px -4px', borderRadius: 14, overflow: 'hidden', border: '0.5px solid rgba(26,61,43,0.13)', background: '#fff' }}>
      {/* Header */}
      <div style={{ padding: '11px 20px', borderBottom: '0.5px solid rgba(26,61,43,0.1)', background: '#F5F3EE', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#4A7C59' }}>
          The modern billing stack
        </span>
        <span style={{ fontSize: 11, color: '#9A9490' }}>Layer → function</span>
      </div>

      {/* Layers */}
      {STACK_LAYERS.map((layer, i) => {
        const isLast = i === STACK_LAYERS.length - 1
        return (
          <div key={layer.id} style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            padding: '11px 20px',
            borderBottom: isLast ? 'none' : '0.5px solid rgba(26,61,43,0.06)',
            background: layer.verdix ? '#EAF3DE' : 'transparent',
          }}>
            {/* Connector line + icon */}
            <div style={{ display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 0, flexShrink: 0 }}>
              <div style={{
                width: 32,
                height: 32,
                borderRadius: 9,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                background: layer.verdix ? '#1A3D2B' : 'rgba(26,61,43,0.07)',
                color: layer.verdix ? '#C4E0B2' : '#4A7C59',
              }}>
                {LAYER_ICONS[layer.id]}
              </div>
            </div>

            {/* Label + description */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: layer.verdix ? 600 : 500, color: layer.verdix ? '#1A3D2B' : '#2C2520', lineHeight: 1.3 }}>
                {layer.label}
              </div>
              <div style={{ fontSize: 12, color: layer.verdix ? '#4A7C59' : '#8A8480', marginTop: 2, lineHeight: 1.4 }}>
                {layer.desc}
              </div>
            </div>

            {/* Verdix badge */}
            {layer.verdix && (
              <span style={{
                fontSize: 10,
                fontWeight: 700,
                textTransform: 'uppercase' as const,
                letterSpacing: '.07em',
                color: '#1A3D2B',
                background: '#C4E0B2',
                padding: '3px 8px',
                borderRadius: 6,
                flexShrink: 0,
              }}>
                Verdix
              </span>
            )}

            {/* Connector dot for non-last items */}
            {!isLast && !layer.verdix && (
              <div style={{ position: 'absolute' as const, left: 35, bottom: -4, width: 1, height: 8, background: 'rgba(26,61,43,0.12)' }} />
            )}
          </div>
        )
      })}
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
            <span className="text-xs text-stone">July 2026</span>
          </div>
          <h1 className="font-display font-light text-ink leading-tight mb-5" style={{ fontSize: 'clamp(1.8rem,3.5vw,2.6rem)' }}>
            Metering, billing, invoicing and payments: what does each system actually do?
          </h1>
          <p className="text-stone leading-relaxed" style={{ fontSize: 16 }}>
            The terminology around modern billing can be confusing. Here is what each layer in the billing stack actually does — and where agreement operations fits in.
          </p>
        </div>

        <hr style={{ border: 'none', borderTop: '0.5px solid rgba(26,61,43,0.10)', marginBottom: 40 }} />

        {/* Article */}
        <article className="prose-verdix">

          <p>Vendors may describe themselves as billing platforms, metering engines, monetisation systems or payment providers, even though they solve different parts of the workflow.</p>

          <p>For a simple monthly subscription, those differences may not matter. For a bespoke enterprise agreement, they do.</p>

          <p>Consider a contract that says:</p>

          <blockquote>
            The customer pays €20,000 annually, plus €0.04 per successfully completed transaction above 100,000 transactions per month, excluding refunds and test activity.
          </blockquote>

          <p>To bill this correctly, the company must determine:</p>

          <ul>
            <li>what the contract requires;</li>
            <li>which transactions qualify;</li>
            <li>how much qualifying usage occurred;</li>
            <li>which price and threshold apply;</li>
            <li>when the charge should be invoiced;</li>
            <li>how the money will be collected and recorded.</li>
          </ul>

          <p>Each part is handled by a different layer.</p>

          <h2>The modern billing stack</h2>

          <p>These nine layers each solve a distinct part of the problem. They often rely on different vendors, and a gap or error in one layer carries through to the next.</p>

          <BillingStackDiagram />

          <h2>Commercial agreements</h2>

          <p>The signed contract is often the commercial source of truth.</p>

          <p>It may contain:</p>

          <ul>
            <li>fixed and usage-based fees;</li>
            <li>minimum commitments;</li>
            <li>tiers and discounts;</li>
            <li>prepaid credits;</li>
            <li>implementation charges;</li>
            <li>annual increases;</li>
            <li>amendments and renewals.</li>
          </ul>

          <p>Contracts are written for people. Billing systems need structured instructions such as price, quantity, date, cadence and customer. Someone must translate the agreement into those instructions.</p>

          <h2>Agreement operations</h2>

          <p>Agreement operations connect the signed contract to the systems that execute it.</p>

          <p>This layer identifies:</p>

          <ul>
            <li>the billing obligations;</li>
            <li>the operational data required;</li>
            <li>where that data lives;</li>
            <li>how thresholds and exclusions apply;</li>
            <li>when each charge should run;</li>
            <li>what should be sent to the billing platform.</li>
          </ul>

          <p>Extracting "€0.04 per transaction" is only the beginning. The workflow must also define what qualifies as a transaction, how refunds are treated, which customer owns the activity and when the threshold resets.</p>

          <p>This translation is often performed manually by Finance, RevOps and Engineering.</p>

          <h2>Metering</h2>

          <p>Metering determines how much activity occurred.</p>

          <p>Examples include:</p>

          <ul>
            <li>API requests;</li>
            <li>transactions;</li>
            <li>AI tokens;</li>
            <li>active users;</li>
            <li>processed documents;</li>
            <li>compute hours;</li>
            <li>completed workflows.</li>
          </ul>

          <p>Many metering platforms use an event-push model, where the customer's application continuously sends usage events to the platform.</p>

          <p>Another option is an endpoint-pull model, where the billing workflow retrieves the required data from an existing customer API when the billing calculation runs. Event streaming is useful for real-time balances, high-volume workloads and immediate entitlement enforcement. Endpoint retrieval may be simpler for periodic billing when the required data already exists in a reliable operational system.</p>

          <div style={{ background: '#F0F4EE', border: '0.5px solid #C0DD97', borderRadius: 10, padding: '14px 18px', margin: '20px 0', fontFamily: 'monospace', fontSize: 13, color: '#27500A', lineHeight: 1.8 }}>
            Verdix uses customer-defined endpoints to retrieve the relevant usage automatically.
          </div>

          <h2>Rating</h2>

          <p>Rating converts measured usage into money.</p>

          <p>For example:</p>

          <ul>
            <li>first 100,000 transactions included;</li>
            <li>next 50,000 at €0.04;</li>
            <li>remaining usage at €0.03;</li>
            <li>10% discount until a specified date;</li>
            <li>monthly minimum commitment of €5,000.</li>
          </ul>

          <p>Rating may involve tiers, credits, commitments, dimensions and customer-specific prices. A rating engine can perform these calculations, but the correct contract terms must first be represented in the system.</p>

          <h2>Billing and invoicing</h2>

          <p>Billing determines what the customer owes, which period the charge covers, whether it is billed in advance or arrears, and when the charge should be created.</p>

          <p>Invoicing turns that charge into a formal document containing the customer, dates, line items, taxes, currency and amount due.</p>

          <p>An invoicing platform can accurately issue the amount it receives. It may not know whether the usage, discount or contractual rate behind that amount was correct.</p>

          <h2>Payments and accounting</h2>

          <p>Payment providers collect the amount through cards, direct debit, bank transfers or other payment methods. They normally do not determine what the customer contractually owes — they execute the payment instruction they receive.</p>

          <p>Accounting platforms then record invoices, payments, taxes and revenue in the company's financial records. These systems remain essential, but they often depend on an upstream process to calculate the correct bespoke charge.</p>

          <h2>Partner reconciliation</h2>

          <p>The same problem exists on the cost side. Businesses receive invoices from:</p>

          <ul>
            <li>payment processors;</li>
            <li>cloud and AI providers;</li>
            <li>carriers;</li>
            <li>logistics companies;</li>
            <li>resellers;</li>
            <li>infrastructure and service partners.</li>
          </ul>

          <p>Accounts-payable software may capture and route the invoice. Partner reconciliation determines whether the rates, quantities, tiers, rebates and credits actually match the agreement and operational activity.</p>

          <h2>Where Verdix fits</h2>

          <p>Verdix is not intended to replace the entire billing and finance stack.</p>

          <p>For customer billing, Verdix:</p>

          <ul>
            <li>interprets the signed agreement;</li>
            <li>structures the billing obligations;</li>
            <li>retrieves usage from customer-defined endpoints;</li>
            <li>creates the billing schedule;</li>
            <li>routes it for approval;</li>
            <li>sends approved instructions to the chosen billing platform.</li>
          </ul>

          <p>For partner reconciliation, Verdix compares the partner agreement, operational data and incoming invoice to calculate the expected amount and identify discrepancies.</p>

          <p>Customers can continue using their preferred billing, payment, ERP and accounting systems. Verdix determines what should be billed or paid. Existing financial systems execute and record the result.</p>

          <h2>Which approach do you need?</h2>

          <p>A standard billing platform may be sufficient when every customer uses similar pricing and invoices follow a predictable schedule.</p>

          <p>A dedicated metering engine may be necessary when usage must be tracked in real time across very large event volumes.</p>

          <p>An agreement-operations layer is particularly useful when:</p>

          <ul>
            <li>the signed contract is the source of truth;</li>
            <li>commercial terms differ by customer;</li>
            <li>usage already exists behind an API;</li>
            <li>billing is periodic;</li>
            <li>the existing finance stack works;</li>
            <li>partner invoices also require validation.</li>
          </ul>

          <h2>The takeaway</h2>

          <p>Metering, billing, invoicing and payments are connected, but they solve different problems.</p>

          <p>Before replacing your finance infrastructure, identify where the manual work actually happens. The missing capability may not be another billing or payment platform. It may be the layer that translates bespoke agreements and operational data into instructions your existing systems can execute.</p>

        </article>

        {/* CTA */}
        <div className="mt-14 rounded-2xl p-8 text-center" style={{ background: '#EAF3DE', border: '0.5px solid #C0DD97' }}>
          <p className="font-medium mb-5" style={{ color: '#1A3D2B', fontSize: 16, lineHeight: 1.6 }}>
            Turn signed agreements and live operational data into approved billing and reconciliation workflows — while keeping the finance stack you already use.
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
        .prose-verdix p {
          margin-bottom: 1.25rem;
        }
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
          padding-left: 0;
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
      `}</style>

    </div>
  )
}
