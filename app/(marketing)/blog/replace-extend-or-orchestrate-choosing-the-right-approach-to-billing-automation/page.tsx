import Link from 'next/link'
import { VerdixLogo } from '@/components/VerdixLogo'

export const metadata = {
  title: 'Replace, extend or orchestrate: choosing the right approach to billing automation | Verdix',
  description:
    'Should you replace your billing platform, add a metering layer or automate the workflow around your existing stack? Here is how to decide.',
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

// ── Diagram 1: Three-approach overview cards ───────────────────────────────────

const APPROACHES = [
  {
    id:          'replace',
    label:       'Replace the billing platform',
    tag:         'Full migration',
    icon:        'M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z',
    headerBg:    '#1A3D2B',
    headerText:  '#EAF3DE',
    tagBg:       'rgba(255,255,255,0.12)',
    tagText:     '#C4E0B2',
    verdix:      false,
    traits: [
      { k: 'Scope',          v: 'All billing infrastructure'          },
      { k: 'Effort',         v: 'High — months of migration'          },
      { k: 'Finance impact', v: 'Significant retraining required'     },
      { k: 'Best for',       v: 'Existing platform limits the model'  },
      { k: 'Risk',           v: 'High — affects whole stack'          },
    ],
  },
  {
    id:          'extend',
    label:       'Extend the existing stack',
    tag:         'Add capability',
    icon:        'M12 5v14 M5 12h14',
    headerBg:    '#4A7C59',
    headerText:  '#EAF3DE',
    tagBg:       'rgba(255,255,255,0.15)',
    tagText:     '#EAF3DE',
    verdix:      false,
    traits: [
      { k: 'Scope',          v: 'One specific missing capability'     },
      { k: 'Effort',         v: 'Moderate — new integration'          },
      { k: 'Finance impact', v: 'Limited to the new tool'             },
      { k: 'Best for',       v: 'Isolated gap in current platform'    },
      { k: 'Risk',           v: 'Low — core stack unchanged'          },
    ],
  },
  {
    id:          'agreement-ops',
    label:       'Agreement-operations layer',
    tag:         'Verdix approach',
    icon:        'M9 12h6 M9 16h6 M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6',
    headerBg:    '#27AE60',
    headerText:  '#fff',
    tagBg:       '#C4E0B2',
    tagText:     '#1A3D2B',
    verdix:      true,
    traits: [
      { k: 'Scope',          v: 'Workflow from contract to billing'   },
      { k: 'Effort',         v: 'Low — works with existing stack'     },
      { k: 'Finance impact', v: 'Removes manual billing prep'         },
      { k: 'Best for',       v: 'Bespoke contracts done manually'     },
      { k: 'Risk',           v: 'Low — no platform replacement'       },
    ],
  },
]

function ApproachCards() {
  return (
    <div style={{ margin: '32px -4px', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }} className="approach-grid">
      {APPROACHES.map(a => (
        <div key={a.id} style={{
          borderRadius: 13,
          overflow: 'hidden',
          border: a.verdix ? '1.5px solid #27AE60' : '0.5px solid rgba(26,61,43,0.12)',
        }}>
          {/* Header */}
          <div style={{ padding: '14px 15px 12px', background: a.headerBg }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
              <div style={{ width: 30, height: 30, borderRadius: 8, background: 'rgba(255,255,255,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Ico d={a.icon} stroke={a.headerText} size={14} />
              </div>
              <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.07em', background: a.tagBg, color: a.tagText, padding: '3px 7px', borderRadius: 5, flexShrink: 0, marginTop: 2 }}>
                {a.tag}
              </span>
            </div>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: a.headerText }}>{a.label}</div>
          </div>

          {/* Traits */}
          <div style={{ background: '#fff' }}>
            {a.traits.map((t, i) => (
              <div key={i} style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                padding: '8px 14px',
                gap: 8,
                borderBottom: i < a.traits.length - 1 ? '0.5px solid rgba(26,61,43,0.07)' : 'none',
                background: i === a.traits.length - 1 ? (a.verdix ? '#F0FAF3' : '#FAFAF8') : 'transparent',
              }}>
                <span style={{ fontSize: 11, color: '#9A9490', flexShrink: 0 }}>{t.k}</span>
                <span style={{ fontSize: 11, fontWeight: i === a.traits.length - 1 ? 600 : 500, color: i === a.traits.length - 1 ? (a.verdix ? '#1A3D2B' : '#2C2520') : '#3A3530', textAlign: 'right' as const }}>{t.v}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Diagram 2: Decision framework table ────────────────────────────────────────

const FRAMEWORK_ROWS = [
  { problem: 'Current system cannot support the pricing model',              solution: 'Replace the billing platform',       verdix: false },
  { problem: 'Real-time product usage is not being measured',                solution: 'Add a metering engine',              verdix: false },
  { problem: 'Product access must follow plans and limits',                  solution: 'Add an entitlement platform',        verdix: false },
  { problem: 'Contracts are manually translated into billing schedules',     solution: 'Add an agreement-operations layer',  verdix: true  },
  { problem: 'Partner invoices are approved without contractual validation', solution: 'Add partner reconciliation',         verdix: false },
  { problem: 'Several problems exist across the whole stack',                solution: 'Consider broader replacement',       verdix: false },
]

function DecisionTable() {
  return (
    <div style={{ margin: '28px -4px', borderRadius: 14, overflow: 'hidden', border: '0.5px solid rgba(26,61,43,0.13)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>

        {/* Column headers */}
        <div style={{ padding: '10px 18px', background: '#F5F3EE', borderBottom: '0.5px solid rgba(26,61,43,0.1)', borderRight: '0.5px solid rgba(26,61,43,0.08)' }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#4A7C59' }}>Main problem</span>
        </div>
        <div style={{ padding: '10px 18px', background: '#F5F3EE', borderBottom: '0.5px solid rgba(26,61,43,0.1)' }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#4A7C59' }}>Best starting point</span>
        </div>

        {/* Data rows */}
        {FRAMEWORK_ROWS.map((r, i) => {
          const isLast  = i === FRAMEWORK_ROWS.length - 1
          const even    = i % 2 === 0
          const rowBorder = isLast ? 'none' : '0.5px solid rgba(26,61,43,0.07)'
          const cellBg    = r.verdix ? '#EAF3DE' : even ? '#FAFAF8' : '#fff'
          return (
            <div key={i} style={{ display: 'contents' }}>
              <div style={{ padding: '10px 18px', background: cellBg, borderBottom: rowBorder, borderRight: '0.5px solid rgba(26,61,43,0.07)', display: 'flex', alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: r.verdix ? '#1A3D2B' : '#3A3530', lineHeight: 1.4 }}>{r.problem}</span>
              </div>
              <div style={{ padding: '10px 18px', background: cellBg, borderBottom: rowBorder, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontSize: 12, fontWeight: r.verdix ? 600 : 400, color: r.verdix ? '#1A3D2B' : '#3A3530', lineHeight: 1.4 }}>{r.solution}</span>
                {r.verdix && (
                  <span style={{ fontSize: 8.5, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.04em', background: '#27AE60', color: '#fff', padding: '2px 6px', borderRadius: 4, flexShrink: 0 }}>Verdix</span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Diagram 3: Verdix workflow chain ───────────────────────────────────────────

const CHAIN_STEPS = [
  { label: 'Signed agreement',  bg: '#1A3D2B', text: '#EAF3DE' },
  { label: 'Terms extracted',   bg: '#1F7A4A', text: '#EAF3DE' },
  { label: 'Usage retrieved',   bg: '#27AE60', text: '#fff'    },
  { label: 'Billing schedule',  bg: '#3DAA7F', text: '#fff'    },
  { label: 'Finance approval',  bg: '#52C48A', text: '#1A3D2B' },
  { label: 'Billing system',    bg: '#B8E0CC', text: '#1A3D2B' },
]

function WorkflowChain() {
  return (
    <div style={{ margin: '20px 0' }}>
      <div className="trace-chain" style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 6 }}>
        {CHAIN_STEPS.map((s, i) => (
          <div key={i} style={{ position: 'relative' as const }}>
            <div style={{ borderRadius: 10, height: 62, display: 'flex', alignItems: 'center', justifyContent: 'center', background: s.bg, textAlign: 'center' as const, padding: '0 10px' }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: s.text, lineHeight: 1.35 }}>{s.label}</div>
            </div>
            {i < CHAIN_STEPS.length - 1 && (
              <div style={{
                position: 'absolute' as const, right: -12, top: '50%', transform: 'translateY(-50%)',
                zIndex: 1, display: 'flex', alignItems: 'center',
              }}>
                <Ico d="M5 12h14M12 5l7 7-7 7" stroke="rgba(26,61,43,0.25)" size={12} sw={2} />
              </div>
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
            Replace, extend or orchestrate: choosing the right approach to billing automation
          </h1>
          <p className="text-stone leading-relaxed" style={{ fontSize: 16 }}>
            Should you replace your billing platform, add a metering layer or automate the workflow around your existing stack? Here is how to decide.
          </p>
        </div>

        <hr style={{ border: 'none', borderTop: '0.5px solid rgba(26,61,43,0.10)', marginBottom: 40 }} />

        <article className="prose-verdix">

          <h2>Billing problems do not always require a billing replacement</h2>

          <p>When billing becomes manual, companies often assume the answer is a new billing platform.</p>

          <p>Sometimes that is correct. But many businesses already have systems that can:</p>

          <ul>
            <li>generate invoices;</li>
            <li>collect payments;</li>
            <li>manage subscriptions;</li>
            <li>record transactions;</li>
            <li>post financial data into the ERP.</li>
          </ul>

          <p>The real gap may be earlier in the workflow: translating bespoke agreements and operational usage into the correct billing instructions.</p>

          <p>There are three main approaches:</p>

          <ul>
            <li>Replace the billing platform</li>
            <li>Extend the existing stack</li>
            <li>Add an agreement-operations layer</li>
          </ul>

          <ApproachCards />

          <h2>1. Replace the billing platform</h2>

          <p>A full replacement moves billing logic, subscriptions, usage calculations, invoicing and sometimes collections into a new platform.</p>

          <p>Replacement may make sense when:</p>

          <ul>
            <li>the current system cannot support usage-based pricing;</li>
            <li>real-time metering is required;</li>
            <li>pricing models are becoming significantly more complex;</li>
            <li>several disconnected billing tools need to be consolidated;</li>
            <li>the company needs native credit balances, entitlements or re-rating;</li>
            <li>the existing platform creates frequent operational failures.</li>
          </ul>

          <p>A migration may require:</p>

          <ul>
            <li>moving customer and subscription data;</li>
            <li>rebuilding pricing plans;</li>
            <li>instrumenting usage events;</li>
            <li>integrating CRM, payments and ERP systems;</li>
            <li>testing historic and future billing;</li>
            <li>retraining Finance and Operations teams;</li>
            <li>managing the transition between platforms.</li>
          </ul>

          <p>Replacement can solve a broad infrastructure problem, but it is usually the most expensive and disruptive option.</p>

          <h2>2. Extend the existing stack</h2>

          <p>A company may keep its billing platform but add a specialised capability around it.</p>

          <p>Examples include:</p>

          <ul>
            <li>a metering engine for high-volume usage;</li>
            <li>an entitlement platform for feature access;</li>
            <li>a revenue-recognition tool;</li>
            <li>a collections platform;</li>
            <li>an AP automation system;</li>
            <li>a reporting or reconciliation layer.</li>
          </ul>

          <p>Extension may make sense when the existing billing platform works well, one specific capability is missing, the new tool can integrate cleanly, and the company wants to avoid a full migration.</p>

          <p>For example, a SaaS company may keep Stripe for invoicing and payments while adding a metering platform to calculate product usage. This approach is often more practical than replacing the whole stack.</p>

          <h2>3. Add an agreement-operations layer</h2>

          <p>An agreement-operations layer focuses on the workflow between the signed contract, operational data and the finance systems already in place.</p>

          <p>It helps determine:</p>

          <ul>
            <li>what the customer agreed to pay;</li>
            <li>which data are required;</li>
            <li>how usage should be calculated;</li>
            <li>when discounts or thresholds apply;</li>
            <li>what billing schedule should be created;</li>
            <li>what instructions should be sent downstream.</li>
          </ul>

          <p>This approach is useful when the company&apos;s invoicing and payment systems work, but Finance still manually interprets contracts and prepares billing inputs.</p>

          <p>Agreement orchestration may make sense when:</p>

          <ul>
            <li>enterprise agreements differ by customer;</li>
            <li>signed contracts are the commercial source of truth;</li>
            <li>billing is periodic;</li>
            <li>operational data already exists behind an API;</li>
            <li>Finance relies on spreadsheets or Engineering support;</li>
            <li>the company wants to retain its ERP or payment provider;</li>
            <li>partner invoices also require contractual validation.</li>
          </ul>

          <h2>A simple decision framework</h2>

          <DecisionTable />

          <h2>Example</h2>

          <p>Suppose a B2B SaaS company already uses Stripe and an ERP. Its Finance team still has to:</p>

          <ul>
            <li>read every enterprise contract;</li>
            <li>identify customer-specific rates;</li>
            <li>request monthly usage from Engineering;</li>
            <li>calculate thresholds and discounts;</li>
            <li>enter the approved amounts into Stripe.</li>
          </ul>

          <p>Stripe may not be the problem. It can create the invoice and collect the payment. The missing capability is the connection between signed agreement, operational usage and approved billing instruction. Replacing Stripe would not automatically remove that work unless the new platform also interpreted the agreement and connected it to the relevant data.</p>

          <h2>When a full metering platform is the better choice</h2>

          <p>An agreement-operations layer is not a substitute for all billing infrastructure.</p>

          <p>A dedicated metering and billing platform is usually better when:</p>

          <ul>
            <li>the product generates very large event volumes;</li>
            <li>usage balances must update continuously;</li>
            <li>customers need real-time spend visibility;</li>
            <li>entitlements depend on current usage;</li>
            <li>late events must be reprocessed;</li>
            <li>metering is part of the product experience.</li>
          </ul>

          <p>The right solution may also combine both approaches. A metering engine can calculate usage, while an agreement-operations layer applies customer-specific contractual terms and routes the approved result to invoicing.</p>

          <h2>Where Verdix fits</h2>

          <p>Verdix is designed for companies that want to automate bespoke agreement workflows without replacing their existing finance infrastructure.</p>

          <p>For customer billing, Verdix:</p>

          <ul>
            <li>interprets the signed agreement;</li>
            <li>identifies the relevant pricing and billing terms;</li>
            <li>retrieves usage from customer-defined endpoints;</li>
            <li>applies the agreement-specific logic;</li>
            <li>creates the billing schedule for approval;</li>
            <li>sends approved instructions to the chosen billing system.</li>
          </ul>

          <WorkflowChain />

          <p>For partner reconciliation, Verdix compares the agreement, operational data and partner invoice to identify differences before payment or dispute.</p>

          <h2>The takeaway</h2>

          <p>The question is not simply which billing platform to buy. The better question is: where does the manual work begin, and which part of the stack is actually missing?</p>

          <p>Replace the platform when the infrastructure itself is limiting the business. Extend it when one specialised capability is missing. Add an agreement-operations layer when the existing systems work but bespoke contracts still depend on manual interpretation and coordination.</p>

        </article>

        {/* CTA */}
        <div className="mt-14 rounded-2xl p-8 text-center" style={{ background: '#EAF3DE', border: '0.5px solid #C0DD97' }}>
          <p className="font-medium mb-5" style={{ color: '#1A3D2B', fontSize: 16, lineHeight: 1.6 }}>
            Automate the gap between signed agreements, operational data and your existing finance stack.
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
