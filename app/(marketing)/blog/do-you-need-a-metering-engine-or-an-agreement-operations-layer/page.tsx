import Link from 'next/link'
import { VerdixLogo } from '@/components/VerdixLogo'

export const metadata = {
  title: 'Do you need a metering engine—or an agreement-operations layer? | Verdix',
  description: 'Most billing complexity in B2B SaaS comes from contract interpretation, not data volume. Learn when you need a metering engine, when you need an agreement-operations layer, and when you need both.',
}

// ─── Diagram 1: Two-layer comparison ────────────────────────────────────────

function LayerComparison() {
  const dot = (color: string) => (
    <div style={{ width: 5, height: 5, borderRadius: '50%', background: color, flexShrink: 0 }} />
  )

  return (
    <div style={{ margin: '32px 0', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>

      {/* Metering engine */}
      <div style={{ borderRadius: 13, overflow: 'hidden', border: '1px solid rgba(26,61,43,0.12)' }}>
        <div style={{ padding: '16px 20px', background: '#1A3D2B' }}>
          <div style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#4A7C59', marginBottom: 6 }}>
            Metering engine
          </div>
          <div style={{ fontSize: 14, color: '#EAF3DE', fontStyle: 'italic', lineHeight: 1.35 }}>
            "How much usage occurred?"
          </div>
        </div>
        <div style={{ background: '#fff' }}>
          <div style={{ padding: '14px 20px', borderBottom: '0.5px solid rgba(26,61,43,0.07)' }}>
            <div style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.08em', color: '#9A9490', marginBottom: 9 }}>
              Captures events like
            </div>
            {['API requests', 'AI tokens consumed', 'Compute or storage time', 'Transactions processed', 'Active seats or connections'].map((item, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
                {dot('#1A3D2B')}
                <span style={{ fontSize: 12, color: '#3A3530', lineHeight: 1.3 }}>{item}</span>
              </div>
            ))}
          </div>
          <div style={{ padding: '14px 20px' }}>
            <div style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.08em', color: '#9A9490', marginBottom: 9 }}>
              Designed for
            </div>
            {['Real-time limits and entitlements', 'High-volume, continuous event streams', 'Live customer usage dashboards', 'Per-unit product metering'].map((item, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
                {dot('#1A3D2B')}
                <span style={{ fontSize: 12, color: '#3A3530', lineHeight: 1.3 }}>{item}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Agreement-operations layer */}
      <div style={{ borderRadius: 13, overflow: 'hidden', border: '1.5px solid #27AE60' }}>
        <div style={{ padding: '16px 20px', background: '#27AE60' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#EAF3DE' }}>
              Agreement-operations layer
            </span>
            <span style={{
              fontSize: 8.5, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.04em',
              background: '#C4E0B2', color: '#1A3D2B', padding: '2px 7px', borderRadius: 4, flexShrink: 0,
            }}>
              Verdix
            </span>
          </div>
          <div style={{ fontSize: 14, color: '#fff', fontStyle: 'italic', lineHeight: 1.35 }}>
            "What should be billed based on the agreement?"
          </div>
        </div>
        <div style={{ background: '#fff' }}>
          <div style={{ padding: '14px 20px', borderBottom: '0.5px solid rgba(26,61,43,0.07)' }}>
            <div style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.08em', color: '#9A9490', marginBottom: 9 }}>
              Interprets
            </div>
            {['Signed contract terms and rates', 'Minimum commitments and thresholds', 'Tiered or escalating pricing rules', 'Discounts, credits, and free allowances', 'Partner and reseller agreements'].map((item, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
                {dot('#27AE60')}
                <span style={{ fontSize: 12, color: '#3A3530', lineHeight: 1.3 }}>{item}</span>
              </div>
            ))}
          </div>
          <div style={{ padding: '14px 20px' }}>
            <div style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.08em', color: '#9A9490', marginBottom: 9 }}>
              Designed for
            </div>
            {['Bespoke customer agreements', 'Monthly or quarterly billing runs', 'Usage data already behind an API', 'Replacing Finance\'s manual spreadsheets'].map((item, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
                {dot('#27AE60')}
                <span style={{ fontSize: 12, color: '#3A3530', lineHeight: 1.3 }}>{item}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Diagram 2: Decision guide ───────────────────────────────────────────────

type DecisionCol = {
  title: string
  color: string
  textLight: string
  badge?: boolean
  points: string[]
}

const DECISION_COLS: DecisionCol[] = [
  {
    title: 'Choose a metering engine',
    color: '#1A3D2B',
    textLight: '#EAF3DE',
    points: [
      'Product must record usage continuously in real time',
      'Customers need live balances or rate-limit enforcement',
      'Event volumes are extremely high (millions / day)',
      'Usage analytics are a core part of the product',
      'You are building event-driven pricing from scratch',
    ],
  },
  {
    title: 'Choose agreement operations',
    color: '#27AE60',
    textLight: '#fff',
    badge: true,
    points: [
      'Billing complexity begins with a signed contract',
      'Usage data already lives in an operational system',
      'Finance is interpreting agreements manually each month',
      'Customers have different negotiated terms',
      'Billing runs on a periodic cycle, not in real time',
      'Existing invoicing and payment infrastructure works fine',
    ],
  },
  {
    title: 'Use both together',
    color: '#3DAA7F',
    textLight: '#fff',
    points: [
      'Enterprise customers have bespoke negotiated terms',
      'Product usage is high-volume and must be metered live',
      'Real-time usage feeds into a periodic billing run',
      'Different customer segments need different approaches',
    ],
  },
]

function DecisionGuide() {
  return (
    <div style={{ margin: '32px 0', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
      {DECISION_COLS.map((col) => (
        <div key={col.title} style={{ borderRadius: 13, overflow: 'hidden', border: `1.5px solid ${col.color}` }}>
          <div style={{ padding: '14px 16px', background: col.color }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: col.textLight, lineHeight: 1.3 }}>
                {col.title}
              </span>
              {col.badge && (
                <span style={{
                  fontSize: 8.5, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.04em',
                  background: '#C4E0B2', color: '#1A3D2B', padding: '2px 6px', borderRadius: 4, flexShrink: 0, marginTop: 1,
                }}>
                  Verdix
                </span>
              )}
            </div>
          </div>
          <div style={{ padding: '14px 16px', background: '#fff' }}>
            {col.points.map((pt, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 7, marginBottom: 7 }}>
                <div style={{ width: 5, height: 5, borderRadius: '50%', background: col.color, flexShrink: 0, marginTop: 4 }} />
                <span style={{ fontSize: 11.5, color: '#3A3530', lineHeight: 1.45 }}>{pt}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Diagram 3: Combined workflow ────────────────────────────────────────────

type WorkflowStep = {
  label: string
  sub: string
  bg: string
  text: string
  subColor: string
}

const WORKFLOW_STEPS: WorkflowStep[] = [
  {
    label: 'Signed agreement',
    sub: 'Commercial source of truth — rates, thresholds, term dates',
    bg: '#1A3D2B',
    text: '#EAF3DE',
    subColor: 'rgba(234,243,222,0.55)',
  },
  {
    label: 'Agreement interpretation',
    sub: 'Billing obligations extracted — what data is needed and from where',
    bg: '#1F7A4A',
    text: '#EAF3DE',
    subColor: 'rgba(234,243,222,0.55)',
  },
  {
    label: 'Metered or retrieved usage',
    sub: 'High-volume events from metering engine, or pulled from existing APIs',
    bg: '#27AE60',
    text: '#fff',
    subColor: 'rgba(255,255,255,0.65)',
  },
  {
    label: 'Approved billing schedule',
    sub: 'Charges reviewed by Finance and confirmed before sending',
    bg: '#3DAA7F',
    text: '#fff',
    subColor: 'rgba(255,255,255,0.65)',
  },
  {
    label: 'Existing billing and payment system',
    sub: 'Invoice pushed to Stripe, ERP or whichever platform you already use',
    bg: '#B8E0CC',
    text: '#1A3D2B',
    subColor: '#4A7C59',
  },
]

function CombinedWorkflow() {
  return (
    <div style={{ margin: '32px 0' }}>
      {WORKFLOW_STEPS.map((step, i) => (
        <div key={i}>
          <div style={{
            borderRadius: 10,
            padding: '13px 20px',
            background: step.bg,
            display: 'flex',
            alignItems: 'center',
            gap: 16,
          }}>
            <div style={{
              width: 28, height: 28, borderRadius: '50%',
              background: 'rgba(255,255,255,0.12)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
            }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: step.text }}>{i + 1}</span>
            </div>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: step.text, marginBottom: 2 }}>{step.label}</div>
              <div style={{ fontSize: 11.5, color: step.subColor, lineHeight: 1.35 }}>{step.sub}</div>
            </div>
          </div>
          {i < WORKFLOW_STEPS.length - 1 && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '4px 0' }}>
              <svg width="16" height="20" viewBox="0 0 16 20" fill="none">
                <path d="M8 0 L8 14 M2 10 L8 16 L14 10" stroke="#27AE60" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function MeteringVsAgreementOps() {
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
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
          All posts
        </Link>

        {/* Header */}
        <div className="mb-10">
          <div className="flex items-center gap-3 mb-5">
            <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#4A7C59' }}>Finance operations · Product</span>
            <span className="text-stone/30">·</span>
            <span className="text-xs text-stone">August 2026</span>
            <span className="text-stone/30">·</span>
            <span className="text-xs text-stone">9 min read</span>
          </div>
          <h1 className="font-display font-light text-ink text-3xl md:text-4xl leading-tight mb-5">
            Do you need a metering engine—or an agreement-operations layer?
          </h1>
          <p className="text-stone text-lg leading-relaxed">
            Metering engines capture what happened. Agreement-operations layers determine what should be billed. Most B2B billing complexity comes from the second problem, not the first.
          </p>
        </div>

        {/* Article */}
        <article className="prose-verdix">

          <p>
            The billing tooling landscape has expanded quickly. Metering engines, billing platforms, revenue recognition systems, CLM tools, and now a new category called agreement-operations or billing intelligence. It can be hard to know which problem each one solves—and whether you have that problem.
          </p>

          <p>
            This post draws a clear line between two categories that are often conflated: metering engines, which solve a data-capture problem, and agreement-operations layers, which solve a contract-interpretation problem. They are not alternatives to each other. They answer different questions. But most B2B companies only need one of them, and building the wrong one—or buying the wrong one—tends to leave the harder problem unsolved.
          </p>

          <h2>What a metering engine does</h2>

          <p>
            A metering engine is infrastructure for recording product usage at scale. You emit events—API calls, AI token counts, compute seconds, active sessions—and the engine captures, deduplicates, aggregates, and stores them reliably. The defining characteristics are volume and real-time availability. A metering engine is designed to handle millions of events per day, make current usage visible within seconds, and enforce limits before a customer exceeds them.
          </p>

          <p>
            Examples of where metering engines genuinely solve a problem: you want to show a customer their live token usage in a dashboard; you need to cut off API access when a prepaid balance runs out; you are billing per call at sub-cent granularity across a large customer base. The problem is fundamentally one of data infrastructure—collecting raw signal at high frequency without losing events.
          </p>

          <h2>What an agreement-operations layer does</h2>

          <p>
            An agreement-operations layer starts from a different place: the signed contract. Its job is to read the commercial terms in that contract—rates, tiers, minimum commitments, included allowances, escalation triggers, partner charges—and translate them into a billing run. It does not necessarily need to capture new events. Often, the data it needs already exists in operational systems: a CRM, an internal platform, a data warehouse, a partner API. The hard part is not collecting the data. The hard part is interpreting what the contract requires, knowing which data to retrieve, and applying the right calculation to produce an accurate invoice.
          </p>

          <p>
            This is the problem Finance teams face every month with enterprise accounts. They have the contract. They have access to the data. They just spend days manually cross-referencing them. An agreement-operations layer automates that process.
          </p>

          <LayerComparison />

          <h2>Why they are not the same problem</h2>

          <p>
            A metering engine solves the question: <em>what happened?</em> An agreement-operations layer solves the question: <em>what should be billed based on the agreement?</em>
          </p>

          <p>
            These questions are related but they are not the same. You can have perfect usage data and still face enormous billing complexity if your contracts are bespoke. You can have simple contracts and still need robust metering if your product emits billions of events. Many companies struggle to see this clearly because they conflate the billing process—which ends with an invoice—with the data problem that one part of that process requires.
          </p>

          <p>
            The way to diagnose which problem you actually have is to trace where your billing friction originates. Does it come from not having reliable usage data? That is a metering problem. Does it come from someone in Finance spending hours mapping contract language to calculations each month? That is an agreement-operations problem.
          </p>

          <h2>A practical example</h2>

          <p>
            Consider a B2B SaaS company selling a data platform to enterprise customers. Each contract specifies different data volume tiers, different overage rates, a platform fee, a minimum annual commitment, and sometimes a reseller discount applied on top. Every month, Finance pulls a usage report from an internal dashboard, opens the signed contract in Google Drive, and builds a spreadsheet to calculate what each customer owes. This takes three to four days across the billing cycle.
          </p>

          <p>
            Does this company have a metering problem? Not really. Usage is already tracked and accessible. Does it have an agreement-operations problem? Absolutely. The friction is in interpreting bespoke contracts and applying them to available data—not in collecting the data itself. Adding a metering engine would not change anything. The bottleneck is the manual interpretation step. That is what an agreement-operations layer is built to replace.
          </p>

          <h2>Which one do you need?</h2>

          <DecisionGuide />

          <h2>Use both when you need both</h2>

          <p>
            There is a class of company that genuinely needs both. Enterprise SaaS businesses with high-volume product usage and bespoke negotiated contracts are the clearest example. Their product generates millions of events per day and those events must be reliably captured—that is the metering engine's job. But the resulting usage then feeds into a billing process governed by individual customer agreements, each with different commercial terms. That is the agreement-operations layer's job.
          </p>

          <p>
            In this combined model, the metering engine handles real-time capture and aggregation. The agreement-operations layer reads the contract, knows what to fetch from the metering engine, applies the agreed rates and rules, and produces the billing schedule for Finance to approve. The two systems are complementary, not overlapping.
          </p>

          <CombinedWorkflow />

          <h2>The mistake to avoid</h2>

          <p>
            The most common mistake is building a metering engine to solve an agreement-operations problem. Teams do this because event capture feels more tractable—it is a data engineering task with clear primitives. Contract interpretation feels messy and human, so it gets deferred. The result is a robust metering infrastructure that has not reduced the billing burden, because the metering was never the bottleneck.
          </p>

          <p>
            The inverse mistake also happens: some companies invest in an agreement-operations layer before they have an agreement worth interpreting. If your pricing model is simple and consistent across all customers, a spreadsheet is probably fine. The agreement-operations problem only becomes real when contracts diverge.
          </p>

          <h2>Where Verdix fits</h2>

          <p>
            Verdix is an agreement-operations layer. We start from signed contracts, extract the billing obligations they contain, connect to the operational data sources those obligations reference, and produce the invoice ready for Finance approval. We are designed for B2B companies where billing friction begins with bespoke agreements—and where the data to satisfy those agreements already exists somewhere in your stack.
          </p>

          <p>
            If you are also running a high-volume metering platform, Verdix can pull from it as one of those data sources. If you are not—if your usage data lives in a database, a data warehouse, or a partner API—you do not need a metering engine to use Verdix. The data you already have is enough.
          </p>

          <p>
            The goal is to stop Finance spending days each month manually interpreting contracts. That problem is independent of how you collected your usage data.
          </p>

        </article>

        {/* CTA */}
        <div className="mt-16 rounded-2xl p-8 text-center" style={{ background: '#1A3D2B' }}>
          <p className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: '#4A7C59' }}>Verdix</p>
          <h3 className="font-display font-light text-2xl mb-3" style={{ color: '#EAF3DE' }}>
            Ready to automate your billing runs?
          </h3>
          <p className="text-sm leading-relaxed mb-6" style={{ color: 'rgba(234,243,222,0.7)', maxWidth: 380, margin: '0 auto 24px' }}>
            See how Verdix connects your contracts to your operational data and eliminates the manual billing spreadsheet.
          </p>
          <Link
            href="/signup"
            className="inline-block font-medium px-6 py-3 rounded-xl text-sm transition-colors"
            style={{ background: '#EAF3DE', color: '#1A3D2B' }}
          >
            Get started with Verdix
          </Link>
        </div>

      </main>

      {/* Footer */}
      <footer className="border-t border-forest/10 py-8 text-center mt-16" style={{ background: '#fff' }}>
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

    </div>
  )
}
