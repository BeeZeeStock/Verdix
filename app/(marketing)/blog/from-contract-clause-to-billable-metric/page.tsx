import Link from 'next/link'
import { VerdixLogo } from '@/components/VerdixLogo'

export const metadata = {
  title: 'From contract clause to billable metric | Verdix',
  description:
    'Learn how to turn commercial contract language into a reliable billable metric connected to operational data, pricing rules and invoice workflows.',
}

// ── Shared SVG icon ────────────────────────────────────────────────────────────

function Ico({ d, size = 14, stroke = 'currentColor', sw = 1.75 }: { d: string; size?: number; stroke?: string; sw?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={stroke} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  )
}

// ── Diagram 1: Clause anatomy ──────────────────────────────────────────────────

const CLAUSE_COMPONENTS = [
  { dot: '#1A3D2B', label: 'Billable activity',   value: 'Successfully completed transaction',      hi: '#1A3D2B',  hiText: '#EAF3DE' },
  { dot: '#27AE60', label: 'Unit price',           value: '€0.04 per additional transaction',        hi: '#27AE60',  hiText: '#fff'    },
  { dot: '#B8E0CC', label: 'Included allowance',  value: 'First 100,000 transactions',              hi: '#B8E0CC',  hiText: '#1A3D2B' },
  { dot: '#4A7C59', label: 'Billing period',       value: 'Calendar month',                          hi: '#4A7C59',  hiText: '#EAF3DE' },
  { dot: '#D9A35A', label: 'Exclusions',           value: 'Refunds and internal test activity',      hi: '#D9A35A',  hiText: '#fff'    },
  { dot: '#9CA3AF', label: 'Billing timing',       value: 'Invoiced in arrears',                     hi: '#9CA3AF',  hiText: '#fff'    },
]

function ClauseAnatomy() {
  return (
    <div style={{ margin: '32px -4px', borderRadius: 14, overflow: 'hidden', border: '0.5px solid rgba(26,61,43,0.13)' }}>
      {/* Header */}
      <div style={{ padding: '11px 20px', background: '#F5F3EE', borderBottom: '0.5px solid rgba(26,61,43,0.1)' }}>
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#4A7C59' }}>
          Clause anatomy
        </span>
      </div>

      {/* Contract text with colour highlights */}
      <div style={{ padding: '16px 20px 14px', background: '#FAFAF8', borderBottom: '0.5px solid rgba(26,61,43,0.08)', fontSize: 13.5, color: '#4A4540', lineHeight: 1.75, fontStyle: 'italic' }}>
        {`The customer will pay `}
        <mark style={{ background: '#27AE60', color: '#fff', fontStyle: 'normal', borderRadius: 3, padding: '0 3px' }}>€0.04</mark>
        {` for each `}
        <mark style={{ background: '#1A3D2B', color: '#EAF3DE', fontStyle: 'normal', borderRadius: 3, padding: '0 3px' }}>successfully completed transaction</mark>
        {` above `}
        <mark style={{ background: '#B8E0CC', color: '#1A3D2B', fontStyle: 'normal', borderRadius: 3, padding: '0 3px' }}>100,000 transactions</mark>
        {` per `}
        <mark style={{ background: '#4A7C59', color: '#EAF3DE', fontStyle: 'normal', borderRadius: 3, padding: '0 3px' }}>calendar month</mark>
        {`, excluding `}
        <mark style={{ background: '#D9A35A', color: '#fff', fontStyle: 'normal', borderRadius: 3, padding: '0 3px' }}>refunds and internal test activity</mark>
        {`.`}
      </div>

      {/* Component grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', background: '#fff' }}>
        {CLAUSE_COMPONENTS.map((c, i) => (
          <div key={i} style={{
            padding: '13px 16px',
            borderRight: i % 3 < 2 ? '0.5px solid rgba(26,61,43,0.07)' : 'none',
            borderBottom: i < 3 ? '0.5px solid rgba(26,61,43,0.07)' : 'none',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: c.dot, flexShrink: 0 }} />
              <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.08em', color: '#9A9490' }}>{c.label}</span>
            </div>
            <div style={{ fontSize: 12.5, fontWeight: 500, color: '#2C2520', lineHeight: 1.4 }}>{c.value}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Diagram 2: Language → data mapping ────────────────────────────────────────

const MAPPING_ROWS = [
  { contract: 'Successfully completed',  rule: 'status = completed'                    },
  { contract: 'Excluding refunds',       rule: 'refunded = false'                      },
  { contract: 'Excluding test activity', rule: 'environment = production'              },
  { contract: 'Customer activity',       rule: 'account_id = contracted_customer'      },
  { contract: 'Calendar month',          rule: 'completion_ts within billing_period'   },
]

function MappingDiagram() {
  return (
    <div style={{ margin: '28px -4px', borderRadius: 14, overflow: 'hidden', border: '0.5px solid rgba(26,61,43,0.13)' }}>
      {/* Column headers */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 36px 1fr' }}>
        <div style={{ padding: '10px 18px', background: '#F5F3EE', borderBottom: '0.5px solid rgba(26,61,43,0.1)' }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#4A7C59' }}>Contract language</span>
        </div>
        <div style={{ background: '#F5F3EE', borderBottom: '0.5px solid rgba(26,61,43,0.1)' }} />
        <div style={{ padding: '10px 18px', background: '#1A3D2B', borderBottom: '0.5px solid rgba(255,255,255,0.08)' }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#4A7C59' }}>Operational data rule</span>
        </div>

        {/* Rows */}
        {MAPPING_ROWS.map((r, i) => {
          const isLast = i === MAPPING_ROWS.length - 1
          const rowBorder = isLast ? 'none' : '0.5px solid rgba(26,61,43,0.07)'
          return (
            <div key={i} style={{ display: 'contents' }}>
              <div style={{ padding: '10px 18px', background: '#fff', borderBottom: rowBorder, display: 'flex', alignItems: 'center' }}>
                <span style={{ fontSize: 13, color: '#3A3530', fontStyle: 'italic' }}>&ldquo;{r.contract}&rdquo;</span>
              </div>
              <div style={{ background: '#F5F3EE', borderBottom: rowBorder, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Ico d="M5 12h14M12 5l7 7-7 7" stroke="rgba(26,61,43,0.3)" />
              </div>
              <div style={{ padding: '10px 18px', background: '#1C4432', borderBottom: isLast ? 'none' : '0.5px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center' }}>
                <code style={{ fontSize: 12, color: '#52C48A', fontFamily: 'monospace', lineHeight: 1.4 }}>{r.rule}</code>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Diagram 3: Usage calculation ───────────────────────────────────────────────

function UsageCalculation() {
  const total     = 175000
  const included  = 100000
  const overage   = total - included
  const pctInc    = (included / total) * 100
  const pctOvr    = (overage  / total) * 100

  return (
    <div style={{ margin: '28px -4px', borderRadius: 14, overflow: 'hidden', border: '0.5px solid rgba(26,61,43,0.13)', background: '#fff' }}>
      <div style={{ padding: '11px 20px', background: '#F5F3EE', borderBottom: '0.5px solid rgba(26,61,43,0.1)' }}>
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#4A7C59' }}>
          Usage calculation — 175,000 transactions
        </span>
      </div>

      <div style={{ padding: '22px 22px 20px' }}>
        {/* Stacked bar */}
        <div style={{ display: 'flex', borderRadius: 8, overflow: 'hidden', height: 46, marginBottom: 10 }}>
          <div style={{ width: `${pctInc}%`, background: '#B8E0CC', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: '#1A3D2B', whiteSpace: 'nowrap' as const }}>100,000 included</span>
          </div>
          <div style={{ width: `${pctOvr}%`, background: '#27AE60', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: '#fff', whiteSpace: 'nowrap' as const }}>75,000 overage</span>
          </div>
        </div>

        {/* Tick labels */}
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#9A9490', marginBottom: 20 }}>
          <span>0</span>
          <span style={{ marginLeft: `${pctInc}%`, transform: 'translateX(-50%)', position: 'relative' as const }}>100,000</span>
          <span>175,000</span>
        </div>

        {/* Summary cards */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <div style={{ background: '#B8E0CC', borderRadius: 10, padding: '13px 14px' }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.08em', color: '#1F7A4A', marginBottom: 5 }}>Included</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#1A3D2B', lineHeight: 1 }}>100,000</div>
            <div style={{ fontSize: 11, color: '#4A7C59', marginTop: 4 }}>No charge</div>
          </div>
          <div style={{ background: '#27AE60', borderRadius: 10, padding: '13px 14px' }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.08em', color: '#C4E0B2', marginBottom: 5 }}>Overage</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#fff', lineHeight: 1 }}>75,000</div>
            <div style={{ fontSize: 11, color: '#C4E0B2', marginTop: 4 }}>× €0.04 per unit</div>
          </div>
          <div style={{ background: '#0B5C36', borderRadius: 10, padding: '13px 14px' }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.08em', color: '#52C48A', marginBottom: 5 }}>Billed amount</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#EAF3DE', lineHeight: 1 }}>€3,000</div>
            <div style={{ fontSize: 11, color: '#7AAF87', marginTop: 4 }}>This billing period</div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Diagram 4: Traceability chain ──────────────────────────────────────────────

const TRACE_STEPS = [
  { label: 'Contract clause',       bg: '#1A3D2B', text: '#EAF3DE', sub: '#4A7C59' },
  { label: 'Data source',           bg: '#1F7A4A', text: '#EAF3DE', sub: '#7AAF87' },
  { label: 'Qualifying activity',   bg: '#27AE60', text: '#fff',    sub: '#C4E0B2' },
  { label: 'Pricing rule',          bg: '#3DAA7F', text: '#fff',    sub: '#C4E0B2' },
  { label: 'Billing schedule',      bg: '#52C48A', text: '#1A3D2B', sub: '#1F7A4A' },
  { label: 'Invoice instruction',   bg: '#B8E0CC', text: '#1A3D2B', sub: '#4A7C59' },
]

function TraceabilityChain() {
  return (
    <div style={{ margin: '28px -4px' }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#4A7C59', marginBottom: 12 }}>
        Evidence chain
      </div>
      <div className="trace-chain" style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 6 }}>
        {TRACE_STEPS.map((s, i) => (
          <div key={i} style={{ position: 'relative' as const }}>
            <div style={{ borderRadius: 10, height: 62, display: 'flex', alignItems: 'center', justifyContent: 'center', background: s.bg, textAlign: 'center' as const, padding: '0 10px' }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: s.text, lineHeight: 1.35 }}>{s.label}</div>
            </div>
            {i < TRACE_STEPS.length - 1 && (
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

// ── Workflow steps diagram (section 5) ────────────────────────────────────────

const WORKFLOW_STEPS = [
  { label: 'Retrieve',  bg: '#1A3D2B', text: '#EAF3DE' },
  { label: 'Validate',  bg: '#1F7A4A', text: '#EAF3DE' },
  { label: 'Calculate', bg: '#27AE60', text: '#fff'    },
  { label: 'Review',    bg: '#D97706', text: '#fff'    },
  { label: 'Approve',   bg: '#B9802F', text: '#fff'    },
  { label: 'Send',      bg: '#3DAA7F', text: '#fff'    },
]

function WorkflowDiagram() {
  return (
    <div style={{ margin: '20px 0' }}>
      <div className="trace-chain" style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 6 }}>
        {WORKFLOW_STEPS.map((s, i) => (
          <div key={i} style={{ position: 'relative' as const }}>
            <div style={{ borderRadius: 8, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', background: s.bg, textAlign: 'center' as const, padding: '0 8px' }}>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: s.text }}>{s.label}</div>
            </div>
            {i < WORKFLOW_STEPS.length - 1 && (
              <div style={{ position: 'absolute' as const, right: -11, top: '50%', transform: 'translateY(-50%)', zIndex: 1 }}>
                <Ico d="M5 12h14M12 5l7 7-7 7" stroke="rgba(26,61,43,0.22)" size={12} sw={2} />
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
            From contract clause to billable metric
          </h1>
          <p className="text-stone leading-relaxed" style={{ fontSize: 16 }}>
            A price in a contract is not yet a billing rule. Turning commercial language into something that can be billed requires connecting the clause to operational data, pricing logic and invoice workflows.
          </p>
        </div>

        <hr style={{ border: 'none', borderTop: '0.5px solid rgba(26,61,43,0.10)', marginBottom: 40 }} />

        <article className="prose-verdix">

          <p>A contract may say:</p>

          <blockquote>
            The customer will pay €0.04 for each successfully completed transaction above 100,000 transactions per calendar month, excluding refunds and internal test activity.
          </blockquote>

          <p>The commercial intent appears clear. But a billing system cannot calculate the charge until several operational questions are answered:</p>

          <ul>
            <li>What qualifies as a &ldquo;successfully completed transaction&rdquo;?</li>
            <li>Where is that activity recorded?</li>
            <li>How are refunds and test transactions identified?</li>
            <li>Which customer owns each transaction?</li>
            <li>When does the monthly period begin and end?</li>
            <li>What happens when records arrive late or are corrected?</li>
          </ul>

          <p>Turning contract language into something that can be billed requires more than extracting the rate. It requires connecting the commercial definition to reliable operational data.</p>

          <h2>1. Identify the commercial obligation</h2>

          <p>Start by separating the clause into its core components. Every term that affects the billing calculation should be identified and recorded explicitly.</p>

          <ClauseAnatomy />

          <p>Other agreements may also include minimum commitments, volume tiers, prepaid credits, temporary discounts, annual price increases, caps, regional rates or customer-specific amendments. These terms must be considered together. A correct transaction count can still produce the wrong invoice if the wrong threshold or discount is applied.</p>

          <h2>2. Translate commercial language into an operational definition</h2>

          <p>The next step is to determine how the contract terminology appears in the product or transaction system. This mapping should be agreed by Finance, Product and the relevant data owner.</p>

          <MappingDiagram />

          <p>Terms such as &ldquo;active user,&rdquo; &ldquo;successful outcome&rdquo; or &ldquo;processed transaction&rdquo; can mean different things across teams. The operational definition therefore needs to be precise enough to support both an invoice and a later customer query.</p>

          <h2>3. Identify the source data</h2>

          <p>The required usage may already exist in a product API, transaction database, data warehouse, analytics platform or third-party operational system. The goal is to establish one trusted source for each billable metric.</p>

          <p>The source should provide:</p>

          <ul>
            <li>a consistent customer identifier;</li>
            <li>relevant timestamps;</li>
            <li>activity status;</li>
            <li>quantities or values;</li>
            <li>exclusions and adjustments;</li>
            <li>stable historical records.</li>
          </ul>

          <p>Where billing is periodic, the platform may retrieve this information from a customer-defined endpoint when the billing workflow runs. This can avoid creating and maintaining a separate raw-event pipeline when the necessary data already exists behind a reliable API.</p>

          <h2>4. Define the calculation</h2>

          <p>Assume the customer records 175,000 qualifying transactions during the month. The agreement includes the first 100,000 and charges €0.04 for each additional transaction.</p>

          <UsageCalculation />

          <p>The final amount may still need to account for minimum commitments, credits, discounts, taxes, currency conversion, fixed platform fees or contract amendments. The billable metric provides the quantity. The agreement determines how that quantity becomes money.</p>

          <h2>5. Decide how exceptions should be handled</h2>

          <p>Operational data are rarely perfect. A dependable billing workflow should define what happens when:</p>

          <ul>
            <li>usage is missing;</li>
            <li>duplicate records appear;</li>
            <li>the endpoint is unavailable;</li>
            <li>transactions are corrected after month-end;</li>
            <li>the customer identifier does not match;</li>
            <li>the data schema changes;</li>
            <li>the contract wording is ambiguous.</li>
          </ul>

          <p>These cases should be flagged for review rather than silently producing an invoice. A safe workflow is:</p>

          <WorkflowDiagram />

          <h2>6. Preserve traceability</h2>

          <p>Finance should be able to explain every charge through a clear evidence chain. This makes it easier to approve invoices, answer customer questions, review amendments and audit the calculation later. Without this, the billing logic may live only in a spreadsheet, query or an employee&apos;s knowledge.</p>

          <TraceabilityChain />

          <h2>Where Verdix fits</h2>

          <p>Verdix connects the signed agreement directly to the operational data required for billing.</p>

          <p>It:</p>

          <ul>
            <li>extracts the commercial obligation;</li>
            <li>structures the pricing, thresholds and exclusions;</li>
            <li>connects the obligation to a customer-defined endpoint;</li>
            <li>retrieves the required usage automatically;</li>
            <li>applies the agreement-specific billing logic;</li>
            <li>generates the billing schedule for approval;</li>
            <li>sends the approved instructions to the customer&apos;s chosen billing platform.</li>
          </ul>

          <p>The same approach can be applied to partner agreements by comparing agreed commercial terms, operational activity and the invoice received.</p>

          <h2>The takeaway</h2>

          <p>A billable metric is not simply a product event or database field. It is a controlled definition that connects what the agreement says, what happened operationally, how the activity should be measured and how the resulting quantity should be priced.</p>

          <p>Contract extraction identifies the commercial terms. The real operational value comes from turning those terms into a repeatable, traceable billing workflow.</p>

        </article>

        {/* CTA */}
        <div className="mt-14 rounded-2xl p-8 text-center" style={{ background: '#EAF3DE', border: '0.5px solid #C0DD97' }}>
          <p className="font-medium mb-5" style={{ color: '#1A3D2B', fontSize: 16, lineHeight: 1.6 }}>
            Turn bespoke contract clauses and live operational data into approved billing schedules — without replacing your existing finance stack.
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
        /* Trace / workflow chains */
        .trace-chain {
          position: relative;
        }
        @media (max-width: 560px) {
          .trace-chain {
            grid-template-columns: repeat(3, 1fr) !important;
          }
        }
      `}</style>

    </div>
  )
}
