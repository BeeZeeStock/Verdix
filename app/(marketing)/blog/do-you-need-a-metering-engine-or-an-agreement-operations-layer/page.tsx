import Link from 'next/link'
import { VerdixLogo } from '@/components/VerdixLogo'

export const metadata = {
  title: 'Do you need a metering engine—or an agreement-operations layer? | Verdix',
  description:
    'Most billing complexity in B2B SaaS comes from contract interpretation, not data volume. Learn when you need a metering engine, when you need an agreement-operations layer, and when you need both.',
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

// ── Diagram 1: Two-layer comparison cards ──────────────────────────────────────

const LAYERS = [
  {
    id:         'metering',
    label:      'Metering engine',
    tag:        'Infrastructure',
    icon:       'M18 20V10 M12 20V4 M6 20v-6',
    headerBg:   '#1A3D2B',
    headerText: '#EAF3DE',
    tagBg:      'rgba(255,255,255,0.12)',
    tagText:    '#C4E0B2',
    verdix:     false,
    traits: [
      { k: 'Triggered by',   v: 'Product events (API, tokens, compute)'   },
      { k: 'Data volume',    v: 'Millions of events per day'               },
      { k: 'Real-time',      v: 'Required'                                 },
      { k: 'Finance burden', v: 'Low after engineering setup'              },
      { k: 'Best fit',       v: 'Live limits and high-vol metering'        },
    ],
  },
  {
    id:         'agreement-ops',
    label:      'Agreement-operations layer',
    tag:        'Verdix approach',
    icon:       'M9 12h6 M9 16h6 M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6',
    headerBg:   '#27AE60',
    headerText: '#fff',
    tagBg:      '#C4E0B2',
    tagText:    '#1A3D2B',
    verdix:     true,
    traits: [
      { k: 'Triggered by',   v: 'Signed customer agreement'                },
      { k: 'Data volume',    v: 'Periodic retrieval each billing cycle'    },
      { k: 'Real-time',      v: 'Not required'                             },
      { k: 'Finance burden', v: 'Currently manual — removes it'           },
      { k: 'Best fit',       v: 'Bespoke B2B periodic billing'            },
    ],
  },
]

function LayerCards() {
  return (
    <div style={{ margin: '32px -4px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }} className="approach-grid">
      {LAYERS.map(l => (
        <div key={l.id} style={{
          borderRadius: 13,
          overflow: 'hidden',
          border: l.verdix ? '1.5px solid #27AE60' : '0.5px solid rgba(26,61,43,0.12)',
        }}>
          {/* Header */}
          <div style={{ padding: '14px 15px 12px', background: l.headerBg }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
              <div style={{ width: 30, height: 30, borderRadius: 8, background: 'rgba(255,255,255,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Ico d={l.icon} stroke={l.headerText} size={14} />
              </div>
              <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.07em', background: l.tagBg, color: l.tagText, padding: '3px 7px', borderRadius: 5, flexShrink: 0, marginTop: 2 }}>
                {l.tag}
              </span>
            </div>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: l.headerText }}>{l.label}</div>
          </div>

          {/* Traits */}
          <div style={{ background: '#fff' }}>
            {l.traits.map((t, i) => (
              <div key={i} style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                padding: '8px 14px',
                gap: 8,
                borderBottom: i < l.traits.length - 1 ? '0.5px solid rgba(26,61,43,0.07)' : 'none',
                background: i === l.traits.length - 1 ? (l.verdix ? '#F0FAF3' : '#FAFAF8') : 'transparent',
              }}>
                <span style={{ fontSize: 11, color: '#9A9490', flexShrink: 0 }}>{t.k}</span>
                <span style={{ fontSize: 11, fontWeight: i === l.traits.length - 1 ? 600 : 500, color: i === l.traits.length - 1 ? (l.verdix ? '#1A3D2B' : '#2C2520') : '#3A3530', textAlign: 'right' as const }}>{t.v}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Diagram 2: Decision guide ──────────────────────────────────────────────────

const DECISION_COLS = [
  {
    condition: 'Product generates high-volume usage events that must be tracked live',
    result:    'Metering engine',
    resultBg:  '#1A3D2B',
    resultText:'#EAF3DE',
    condBg:    '#F0F4EE',
    condText:  '#3A3530',
    arrowCol:  'rgba(26,61,43,0.3)',
    verdix:    false,
  },
  {
    condition: 'Billing starts with bespoke contracts; data already available through an API',
    result:    'Agreement operations',
    resultBg:  '#27AE60',
    resultText:'#fff',
    condBg:    '#EAF3DE',
    condText:  '#1A3D2B',
    arrowCol:  '#27AE60',
    verdix:    true,
  },
  {
    condition: 'Enterprise contracts with negotiated terms AND high-volume product metering',
    result:    'Both layers',
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
            {/* Condition */}
            <div style={{ padding: '13px 14px', background: col.condBg, borderRadius: '10px 10px 0 0', border: col.verdix ? '1.5px solid #C0DD97' : '0.5px solid rgba(26,61,43,0.1)', borderBottom: 'none', minHeight: 72, display: 'flex', alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: col.condText, lineHeight: 1.5 }}>{col.condition}</span>
            </div>
            {/* Arrow */}
            <div style={{ display: 'flex', justifyContent: 'center', padding: '4px 0' }}>
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

// ── Diagram 3: Combined workflow chain ─────────────────────────────────────────

const CHAIN_STEPS = [
  { label: 'Signed agreement',        bg: '#1A3D2B', text: '#EAF3DE' },
  { label: 'Obligations extracted',   bg: '#1F7A4A', text: '#EAF3DE' },
  { label: 'Usage retrieved',         bg: '#27AE60', text: '#fff'    },
  { label: 'Charges calculated',      bg: '#3DAA7F', text: '#fff'    },
  { label: 'Invoice approved',        bg: '#B8E0CC', text: '#1A3D2B' },
]

function CombinedWorkflow() {
  return (
    <div style={{ margin: '28px -4px' }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#4A7C59', marginBottom: 12 }}>
        Combined workflow
      </div>
      <div className="trace-chain" style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6 }}>
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
            Do you need a metering engine—or an agreement-operations layer?
          </h1>
          <p className="text-stone leading-relaxed" style={{ fontSize: 16 }}>
            Metering engines capture what happened. Agreement-operations layers determine what should be billed. Most B2B billing complexity comes from the second problem, not the first.
          </p>
        </div>

        <hr style={{ border: 'none', borderTop: '0.5px solid rgba(26,61,43,0.10)', marginBottom: 40 }} />

        <article className="prose-verdix">

          <p>The billing tooling landscape has expanded quickly. Metering engines, billing platforms, revenue recognition systems, CLM tools, and now a new category called agreement-operations or billing intelligence. It can be hard to know which problem each one solves—and whether you have that problem.</p>

          <p>This post draws a clear line between two categories that are often conflated: metering engines, which solve a data-capture problem, and agreement-operations layers, which solve a contract-interpretation problem. They are not alternatives to each other. They answer different questions. But most B2B companies only need one of them, and building the wrong one tends to leave the harder problem unsolved.</p>

          <h2>What a metering engine does</h2>

          <p>A metering engine is infrastructure for recording product usage at scale. You emit events—API calls, AI token counts, compute seconds, active sessions—and the engine captures, deduplicates, aggregates, and stores them reliably. The defining characteristics are volume and real-time availability. A metering engine is designed to handle millions of events per day, make current usage visible within seconds, and enforce limits before a customer exceeds them.</p>

          <p>Examples of where metering engines genuinely solve a problem: you want to show a customer their live token usage in a dashboard; you need to cut off API access when a prepaid balance runs out; you are billing per call at sub-cent granularity across a large customer base. The problem is fundamentally one of data infrastructure—collecting raw signal at high frequency without losing events.</p>

          <h2>What an agreement-operations layer does</h2>

          <p>An agreement-operations layer starts from a different place: the signed contract. Its job is to read the commercial terms in that contract—rates, tiers, minimum commitments, included allowances, escalation triggers, partner charges—and translate them into a billing run. It does not necessarily need to capture new events. Often, the data it needs already exists in operational systems: a CRM, an internal platform, a data warehouse, a partner API. The hard part is not collecting the data. The hard part is interpreting what the contract requires, knowing which data to retrieve, and applying the right calculation to produce an accurate invoice.</p>

          <p>This is the problem Finance teams face every month with enterprise accounts. They have the contract. They have access to the data. They just spend days manually cross-referencing them. An agreement-operations layer automates that process.</p>

          <LayerCards />

          <h2>Why they are not the same problem</h2>

          <p>A metering engine solves the question: <em>what happened?</em> An agreement-operations layer solves the question: <em>what should be billed based on the agreement?</em></p>

          <p>These questions are related but they are not the same. You can have perfect usage data and still face enormous billing complexity if your contracts are bespoke. You can have simple contracts and still need robust metering if your product emits billions of events. Many companies struggle to see this clearly because they conflate the billing process with the data problem that one part of that process requires.</p>

          <p>The way to diagnose which problem you actually have is to trace where your billing friction originates. Does it come from not having reliable usage data? That is a metering problem. Does it come from someone in Finance spending hours mapping contract language to calculations each month? That is an agreement-operations problem.</p>

          <h2>A practical example</h2>

          <p>Consider a B2B SaaS company selling a data platform to enterprise customers. Each contract specifies different data volume tiers, different overage rates, a platform fee, a minimum annual commitment, and sometimes a reseller discount applied on top. Every month, Finance pulls a usage report from an internal dashboard, opens the signed contract in Google Drive, and builds a spreadsheet to calculate what each customer owes. This takes three to four days across the billing cycle.</p>

          <p>Does this company have a metering problem? Not really—usage is already tracked and accessible. Does it have an agreement-operations problem? Absolutely. The friction is in interpreting bespoke contracts and applying them to available data, not in collecting the data itself. Adding a metering engine would not change anything. The bottleneck is the manual interpretation step.</p>

          <h2>Which one do you need?</h2>

          <DecisionGuide />

          <h2>Use both when you need both</h2>

          <p>There is a class of company that genuinely needs both. Enterprise SaaS businesses with high-volume product usage and bespoke negotiated contracts are the clearest example. Their product generates millions of events per day and those events must be reliably captured—that is the metering engine&apos;s job. But the resulting usage then feeds into a billing process governed by individual customer agreements, each with different commercial terms. That is the agreement-operations layer&apos;s job.</p>

          <p>In this combined model, the metering engine handles real-time capture and aggregation. The agreement-operations layer reads the contract, knows what to fetch, applies the agreed rates and rules, and produces the billing schedule for Finance to approve. The two systems are complementary, not overlapping.</p>

          <CombinedWorkflow />

          <h2>The mistake to avoid</h2>

          <p>The most common mistake is building a metering engine to solve an agreement-operations problem. Teams do this because event capture feels more tractable—it is a data engineering task with clear primitives. Contract interpretation feels messy and human, so it gets deferred. The result is a robust metering infrastructure that has not reduced the billing burden, because the metering was never the bottleneck.</p>

          <p>The inverse mistake also happens. Some companies invest in an agreement-operations layer before they have an agreement worth interpreting. If your pricing is simple and consistent across all customers, a spreadsheet is probably fine. The agreement-operations problem only becomes real when contracts diverge.</p>

          <h2>Where Verdix fits</h2>

          <p>Verdix is an agreement-operations layer. We start from signed contracts, extract the billing obligations they contain, connect to the operational data sources those obligations reference, and produce the invoice ready for Finance approval. We are designed for B2B companies where billing friction begins with bespoke agreements—and where the data to satisfy those agreements already exists somewhere in your stack.</p>

          <p>If you are also running a high-volume metering platform, Verdix can pull from it as one of those data sources. If you are not—if your usage data lives in a database, a data warehouse, or a partner API—you do not need a metering engine to use Verdix. The data you already have is enough.</p>

        </article>

        {/* CTA */}
        <div className="mt-14 rounded-2xl p-8 text-center" style={{ background: '#EAF3DE', border: '0.5px solid #C0DD97' }}>
          <p className="font-medium mb-5" style={{ color: '#1A3D2B', fontSize: 16, lineHeight: 1.6 }}>
            Stop Finance spending days each month interpreting contracts manually — connect your agreements directly to your operational data.
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
