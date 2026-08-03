import Link from 'next/link'
import { VerdixLogo } from '@/components/VerdixLogo'

export const metadata = {
  title: 'Push, pull or upload: how should usage reach your billing workflow? | Verdix',
  description:
    'Compare event streaming, API-based usage retrieval and file uploads for usage billing — and learn which approach fits your product, contracts and finance stack.',
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
    id:          'push',
    label:       'Event push',
    tag:         'Real-time',
    icon:        'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4 M17 8l-5-5-5 5 M12 3v12',
    headerBg:    '#1A3D2B',
    headerText:  '#EAF3DE',
    tagBg:       'rgba(255,255,255,0.12)',
    tagText:     '#C4E0B2',
    verdix:      false,
    traits: [
      { k: 'Data movement',      v: 'Continuous stream'           },
      { k: 'Engineering effort', v: 'Usually high'                },
      { k: 'Real-time support',  v: 'Strong'                      },
      { k: 'Manual work',        v: 'Low after implementation'    },
      { k: 'Best fit',           v: 'High-volume metering'        },
    ],
  },
  {
    id:          'pull',
    label:       'Endpoint pull',
    tag:         'Verdix approach',
    icon:        'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4 M7 10l5 5 5-5 M12 15V3',
    headerBg:    '#27AE60',
    headerText:  '#fff',
    tagBg:       '#C4E0B2',
    tagText:     '#1A3D2B',
    verdix:      true,
    traits: [
      { k: 'Data movement',      v: 'Retrieved when required'     },
      { k: 'Engineering effort', v: 'Moderate'                    },
      { k: 'Real-time support',  v: 'Limited by polling'          },
      { k: 'Manual work',        v: 'Low after configuration'     },
      { k: 'Best fit',           v: 'Bespoke periodic billing'    },
    ],
  },
  {
    id:          'file',
    label:       'File upload',
    tag:         'Manual',
    icon:        'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8L14 2z M14 2v6h6 M16 13H8 M16 17H8',
    headerBg:    '#6B7280',
    headerText:  '#fff',
    tagBg:       'rgba(255,255,255,0.15)',
    tagText:     '#E5E7EB',
    verdix:      false,
    traits: [
      { k: 'Data movement',      v: 'Manually uploaded'           },
      { k: 'Engineering effort', v: 'Low initially'               },
      { k: 'Real-time support',  v: 'Weak'                        },
      { k: 'Manual work',        v: 'Recurring each period'       },
      { k: 'Best fit',           v: 'Pilots and transitions'      },
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

// ── Diagram 2: Comparison table ────────────────────────────────────────────────

const COMPARISON_ROWS = [
  { label: 'Data movement',      push: 'Continuous',                    pull: 'Retrieved when required',    file: 'Manually uploaded'          },
  { label: 'Engineering effort', push: 'Usually high',                  pull: 'Moderate',                   file: 'Low initially'               },
  { label: 'Real-time support',  push: 'Strong',                        pull: 'Limited by polling',          file: 'Weak'                        },
  { label: 'Periodic billing',   push: 'Strong (may be excessive)',     pull: 'Strong',                     file: 'Suitable at low volume'      },
  { label: 'Raw-event storage',  push: 'Usually external platform',     pull: 'May remain in source system', file: 'Exported periodically'      },
  { label: 'Manual work',        push: 'Low after implementation',      pull: 'Low after configuration',    file: 'Recurring'                   },
  { label: 'Best fit',           push: 'High-volume metering',          pull: 'Bespoke periodic billing',   file: 'Pilots and transitions'      },
]

function ComparisonTable() {
  return (
    <div style={{ margin: '28px -4px', borderRadius: 14, overflow: 'hidden', border: '0.5px solid rgba(26,61,43,0.13)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr 1fr 1fr' }}>

        {/* Column headers */}
        <div style={{ padding: '10px 14px', background: '#F5F3EE', borderBottom: '0.5px solid rgba(26,61,43,0.1)', borderRight: '0.5px solid rgba(26,61,43,0.08)' }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#9A9490' }}>Consideration</span>
        </div>
        <div style={{ padding: '10px 14px', background: '#1A3D2B', borderBottom: '0.5px solid rgba(255,255,255,0.08)', borderRight: '0.5px solid rgba(255,255,255,0.06)' }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#4A7C59' }}>Event push</span>
        </div>
        <div style={{ padding: '10px 14px', background: '#27AE60', borderBottom: '0.5px solid rgba(255,255,255,0.15)', borderRight: '0.5px solid rgba(255,255,255,0.15)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#EAF3DE' }}>Endpoint pull</span>
            <span style={{ fontSize: 8.5, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.05em', background: '#C4E0B2', color: '#1A3D2B', padding: '2px 5px', borderRadius: 4 }}>Verdix</span>
          </div>
        </div>
        <div style={{ padding: '10px 14px', background: '#F5F3EE', borderBottom: '0.5px solid rgba(26,61,43,0.1)' }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#9A9490' }}>File upload</span>
        </div>

        {/* Data rows */}
        {COMPARISON_ROWS.map((r, i) => {
          const isLast   = i === COMPARISON_ROWS.length - 1
          const even     = i % 2 === 0
          const rowBorderLight = isLast ? 'none' : '0.5px solid rgba(26,61,43,0.07)'
          const rowBorderGreen = isLast ? 'none' : '0.5px solid rgba(39,174,96,0.12)'
          return (
            <div key={i} style={{ display: 'contents' }}>
              <div style={{ padding: '9px 14px', background: even ? '#FAFAF8' : '#fff', borderBottom: rowBorderLight, borderRight: '0.5px solid rgba(26,61,43,0.07)', display: 'flex', alignItems: 'center' }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: '#6B6660' }}>{r.label}</span>
              </div>
              <div style={{ padding: '9px 14px', background: even ? '#1E4535' : '#1A3D2B', borderBottom: isLast ? 'none' : '0.5px solid rgba(255,255,255,0.06)', borderRight: '0.5px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center' }}>
                <span style={{ fontSize: 11.5, color: '#A8CCB5', lineHeight: 1.4 }}>{r.push}</span>
              </div>
              <div style={{ padding: '9px 14px', background: even ? '#E8F5EC' : '#F0FAF3', borderBottom: rowBorderGreen, borderRight: '0.5px solid rgba(26,61,43,0.07)', display: 'flex', alignItems: 'center' }}>
                <span style={{ fontSize: 11.5, color: '#1A3D2B', fontWeight: isLast ? 600 : 400, lineHeight: 1.4 }}>{r.pull}</span>
              </div>
              <div style={{ padding: '9px 14px', background: even ? '#FAFAF8' : '#fff', borderBottom: rowBorderLight, display: 'flex', alignItems: 'center' }}>
                <span style={{ fontSize: 11.5, color: '#6B6660', lineHeight: 1.4 }}>{r.file}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Diagram 3: Decision guide ──────────────────────────────────────────────────

const DECISION_COLS = [
  {
    condition: 'Real-time metering, high-volume events, live credit controls',
    result:    'Event push',
    resultBg:  '#1A3D2B',
    resultText:'#EAF3DE',
    subText:   '#7AAF87',
    condBg:    '#F0F4EE',
    condText:  '#3A3530',
    arrowCol:  'rgba(26,61,43,0.3)',
    verdix:    false,
  },
  {
    condition: 'Periodic billing, existing operational API, bespoke per-customer terms',
    result:    'Endpoint pull',
    resultBg:  '#27AE60',
    resultText:'#fff',
    subText:   '#C4E0B2',
    condBg:    '#EAF3DE',
    condText:  '#1A3D2B',
    arrowCol:  '#27AE60',
    verdix:    true,
  },
  {
    condition: 'No API yet, testing a new model, transitioning from manual process',
    result:    'File upload',
    resultBg:  '#9CA3AF',
    resultText:'#fff',
    subText:   '#E5E7EB',
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
            {/* Condition */}
            <div style={{ padding: '13px 14px', background: col.condBg, borderRadius: '10px 10px 0 0', border: col.verdix ? '1.5px solid #C0DD97' : '0.5px solid rgba(26,61,43,0.1)', borderBottom: 'none', minHeight: 72, display: 'flex', alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: col.condText, lineHeight: 1.5 }}>{col.condition}</span>
            </div>
            {/* Arrow */}
            <div style={{ display: 'flex', justifyContent: 'center', padding: '4px 0', background: 'transparent' }}>
              <Ico d="M12 5v14M5 12l7 7 7-7" stroke={col.arrowCol} size={18} sw={2} />
            </div>
            {/* Result */}
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
            Push, pull or upload: how should usage reach your billing workflow?
          </h1>
          <p className="text-stone leading-relaxed" style={{ fontSize: 16 }}>
            Usage-based billing depends on reliable operational data — but there is more than one way to move that data into a billing workflow. Each approach fits a different operating model.
          </p>
        </div>

        <hr style={{ border: 'none', borderTop: '0.5px solid rgba(26,61,43,0.10)', marginBottom: 40 }} />

        <article className="prose-verdix">

          <p>A contract may define charges based on API calls, transactions, active users, AI tokens, documents processed, completed workflows or delivered outcomes. Before the amount can be calculated, that usage must reach the billing workflow.</p>

          <p>There are three common approaches:</p>

          <ul>
            <li>continuously push usage events to a metering platform;</li>
            <li>pull the required data from an existing endpoint;</li>
            <li>upload usage through a file.</li>
          </ul>

          <ApproachCards />

          <h2>1. Push usage events</h2>

          <p>With an event-push model, the product continuously sends individual usage records to a metering or billing platform. A typical event may contain a customer identifier, event type, timestamp, quantity, product or service, and additional dimensions such as region or model. The platform stores and aggregates the events before applying pricing.</p>

          <p>Event streaming is a strong choice when:</p>

          <ul>
            <li>usage must be tracked in real time;</li>
            <li>the product generates very large event volumes;</li>
            <li>customers need live usage dashboards;</li>
            <li>credits or limits must update immediately;</li>
            <li>pricing depends on detailed event-level dimensions;</li>
            <li>historic usage may need to be re-rated.</li>
          </ul>

          <p>The main challenge is that the customer must build and maintain the pipeline that sends usage to the platform. That may require product instrumentation, event schemas, retry and failure handling, deduplication, customer attribution, monitoring and ongoing engineering ownership. For businesses that need real-time metering, this investment may be justified. For monthly enterprise billing, it may be more infrastructure than necessary.</p>

          <h2>2. Pull usage from an endpoint</h2>

          <p>With an endpoint-pull model, the customer identifies an existing API containing the relevant operational data. The billing workflow retrieves that data automatically when the charge needs to be calculated.</p>

          <p>For example, an endpoint might provide completed transactions for a billing period, active seat counts, API consumption by customer, successfully processed documents, achieved milestones, or refunds and reversals.</p>

          <p>Endpoint retrieval works particularly well when:</p>

          <ul>
            <li>billing is daily, monthly or otherwise periodic;</li>
            <li>the required data already exists through a reliable API;</li>
            <li>the company does not need real-time credit enforcement;</li>
            <li>product teams want to avoid creating a separate event pipeline;</li>
            <li>each agreement may require a different operational definition.</li>
          </ul>

          <p>The endpoint must still be configured correctly. The workflow needs to manage authentication, pagination, customer identifiers, field mappings, retries, duplicate prevention, schema changes and missing or corrected data.</p>

          <div style={{ background: '#F0F4EE', border: '0.5px solid #C0DD97', borderRadius: 10, padding: '14px 18px', margin: '20px 0', fontFamily: 'monospace', fontSize: 13, color: '#27500A', lineHeight: 1.8 }}>
            Verdix follows this approach. Customers define the relevant endpoints, and Verdix retrieves the usage required by each agreement when the billing workflow runs.
          </div>

          <h2>3. Upload usage through a file</h2>

          <p>A file-based process usually involves Finance or Operations exporting usage into a CSV or spreadsheet and uploading it to the billing platform.</p>

          <p>File uploads can be useful when testing a new billing workflow, processing a small number of customers, no reliable API exists, billing is infrequent or the company is transitioning from a manual process.</p>

          <p>The process remains dependent on people. Each period may require someone to produce the export, check the date range, format the columns, remove irrelevant activity, upload the file, resolve errors and retain evidence of the source. This can work at low volume but becomes difficult to scale.</p>

          <h2>Side-by-side comparison</h2>

          <ComparisonTable />

          <h2>The billing model should determine the architecture</h2>

          <p>No single approach is always better. The right choice depends on how frequently billing runs, how much data is generated and whether real-time controls are required.</p>

          <DecisionGuide />

          <h2>Contract terms still matter</h2>

          <p>Whichever data model is used, usage alone does not determine the invoice. The workflow must still apply:</p>

          <ul>
            <li>included allowances;</li>
            <li>volume tiers;</li>
            <li>minimum commitments;</li>
            <li>discounts;</li>
            <li>credits;</li>
            <li>caps;</li>
            <li>pricing phases;</li>
            <li>amendments.</li>
          </ul>

          <p>It must also connect the operational definition with the signed agreement. For example, &ldquo;successfully completed transactions&rdquo; must map to a specific status, timestamp, customer identifier and set of exclusions in the source data. A technically accurate usage feed can still produce the wrong charge if the commercial logic is configured incorrectly.</p>

          <h2>Where Verdix fits</h2>

          <p>Verdix is designed for companies that already have operational data available through APIs but still rely on Finance, RevOps or Engineering to connect that data with bespoke agreements.</p>

          <p>Verdix:</p>

          <ul>
            <li>interprets the signed agreement;</li>
            <li>identifies the required usage;</li>
            <li>retrieves it from customer-defined endpoints;</li>
            <li>applies the agreement-specific pricing rules;</li>
            <li>creates the billing schedule;</li>
            <li>routes it for approval;</li>
            <li>sends the approved instructions to the preferred billing platform.</li>
          </ul>

          <p>The same model is used to reconcile partner invoices against agreements and operational activity.</p>

          <h2>The takeaway</h2>

          <p>The right usage architecture depends on how frequently billing runs, how much data is generated and whether real-time controls are required.</p>

          <p>Many companies need a full event-metering platform. Others already have the data they need and simply require a reliable way to retrieve it, connect it with the agreement and produce the correct billing instructions.</p>

        </article>

        {/* CTA */}
        <div className="mt-14 rounded-2xl p-8 text-center" style={{ background: '#EAF3DE', border: '0.5px solid #C0DD97' }}>
          <p className="font-medium mb-5" style={{ color: '#1A3D2B', fontSize: 16, lineHeight: 1.6 }}>
            Use your existing operational endpoints to automate bespoke billing — without building a separate raw-event pipeline.
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
        @media (max-width: 560px) {
          .approach-grid {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>

    </div>
  )
}
