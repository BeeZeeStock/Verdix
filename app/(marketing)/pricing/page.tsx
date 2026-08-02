import Link from 'next/link'
import { VerdixLogo } from '@/components/VerdixLogo'

const plans = [
  {
    id: 'free',
    name: 'Free',
    badge: null,
    price: '€0',
    period: '',
    description: '3 agreements processed: customer billing or partner reconciliation',
    overage: null,
    highlight: false,
    cta: 'Try 3 runs free',
    ctaHref: '/signup',
    features: [
      'Contract terms extracted automatically',
      'Usage pulled from your connected endpoint',
      'Approved billing schedules sent to your preferred billing platform',
      'PII masking included',
    ],
    bestFor: 'Founders and Finance or RevOps teams that want to test Verdix using a small number of bespoke customer or partner agreements.',
  },
  {
    id: 'payg',
    name: 'Pay as you go',
    badge: 'Best for getting started',
    badgeHighlight: false,
    price: '€10',
    period: 'per agreement processed',
    description: 'No monthly subscription',
    overage: null,
    highlight: false,
    cta: 'Start pay as you go',
    ctaHref: '/signup?plan=payg',
    features: [
      'Customer billing or partner invoice reconciliation',
      'Automated usage retrieval from your connected endpoint',
      'Approved billing schedules sent to your preferred billing platform',
      'Agreement-linked calculation trace',
      'PII masking included',
    ],
    bestFor: 'Early-stage and smaller B2B SaaS, AI, fintech and platform companies with irregular processing volumes or fewer than approximately 40 agreement workflows per month.',
  },
  {
    id: 'scale',
    name: 'Scale',
    badge: 'Best value',
    badgeHighlight: true,
    price: '€399',
    period: '/month',
    description: '100 agreements processed included: customer billing or partner reconciliation',
    overage: '€3 per additional agreement processed',
    highlight: true,
    cta: 'Start with Scale',
    ctaHref: '/signup?plan=scale',
    features: [
      'Automated usage retrieval from multiple connected endpoints',
      'Approved billing schedules sent to your preferred billing platforms',
      'Multiple customer and partner agreements',
      'Team access and priority support',
      'PII masking included',
    ],
    bestFor: 'Growing B2B SaaS, fintech, marketplace and digital-platform companies with recurring bespoke billing, multiple partner agreements and collaborative Finance, RevOps or Partner Operations teams.',
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    badge: null,
    price: 'Custom',
    period: '',
    description: 'For higher-volume or regulated organisations requiring advanced security, integrations and support.',
    overage: null,
    highlight: false,
    cta: 'Talk to us',
    ctaHref: 'mailto:bilal@lynoraai.com?subject=Verdix Enterprise',
    features: [
      'Custom agreement-processing volumes',
      'Volume-based pricing',
      'Dedicated EU environment',
      'SSO and role-based access',
      'Advanced audit logs and retention controls',
      'Custom billing, ERP and payment integrations',
      'SLA and dedicated support',
    ],
    bestFor: 'Larger Nordic and European companies, regulated businesses and multi-entity organisations with complex customer and partner agreements, advanced security requirements and custom finance infrastructure.',
  },
]

export default function PricingPage() {
  return (
    <div className="min-h-screen bg-cream">
      {/* Nav */}
      <header className="border-b border-forest/10 bg-cream/80 backdrop-blur-sm sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5">
            <VerdixLogo size={24} />
            <span className="font-sans font-semibold text-[15px]" style={{ color: '#1A3D2B' }}>Verdix</span>
          </Link>
          <div className="flex items-center gap-4">
            <Link href="/login" className="text-sm text-stone hover:text-forest transition-colors">Sign in</Link>
            <Link href="/signup" className="bg-forest text-white text-sm font-medium px-4 py-2 rounded-xl hover:bg-sage transition-colors">
              Get started
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-16 md:py-24">
        {/* Header */}
        <div className="text-center mb-12">
          <h1 className="font-display font-light text-ink text-4xl md:text-5xl mb-4">
            Pay only when Verdix completes an agreement workflow
          </h1>
          <p className="text-stone text-lg max-w-2xl mx-auto leading-relaxed mb-3">
            No percentage of revenue, no charge per raw usage event, and no requirement to replace your billing or payment infrastructure.
          </p>
          <p className="text-stone max-w-2xl mx-auto leading-relaxed">
            Built for B2B SaaS, AI, fintech, marketplace and digital-platform companies managing bespoke customer or partner agreements—especially Finance, RevOps, Billing Operations and Partner Operations teams that want automation while keeping their existing systems.
          </p>
        </div>

        {/* Plan grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 mb-8">
          {plans.map(plan => (
            <div
              key={plan.id}
              className="bg-white rounded-2xl border flex flex-col overflow-hidden transition-shadow hover:shadow-md"
              style={{ borderColor: plan.highlight ? '#1A3D2B' : 'rgba(26,61,43,0.1)' }}
            >
              {(plan as { badge?: string | null }).badge ? (
                <div
                  className="text-center text-xs font-semibold py-1.5 tracking-wide"
                  style={{
                    background: (plan as { badgeHighlight?: boolean }).badgeHighlight ? '#1A3D2B' : '#EAF3DE',
                    color: (plan as { badgeHighlight?: boolean }).badgeHighlight ? '#fff' : '#27500A',
                  }}
                >
                  {(plan as { badge?: string | null }).badge}
                </div>
              ) : <div className="h-[30px]" />}

              <div className="p-6 flex flex-col flex-1">
                <div className="mb-5">
                  <div className="text-xs font-semibold text-stone uppercase tracking-widest mb-2">{plan.name}</div>
                  <div className="flex items-baseline gap-1.5 flex-wrap mb-1">
                    <span className="text-3xl font-semibold text-ink">{plan.price}</span>
                    {plan.period && <span className="text-stone text-xs leading-tight">{plan.period}</span>}
                  </div>
                  <p className="text-xs text-stone leading-relaxed">{plan.description}</p>
                  {plan.overage && (
                    <p className="text-xs text-stone leading-relaxed mt-1">{plan.overage}</p>
                  )}
                </div>

                <ul className="space-y-2 flex-1 mb-5">
                  {plan.features.map(f => (
                    <li key={f} className="flex items-start gap-2 text-xs text-stone leading-relaxed">
                      <i className="ti ti-check flex-shrink-0 mt-0.5" style={{ fontSize: 13, color: '#1A3D2B' }} />
                      {f}
                    </li>
                  ))}
                </ul>

                <div className="mb-5 pt-3" style={{ borderTop: '0.5px solid rgba(26,61,43,0.08)' }}>
                  <div className="text-[10px] font-semibold uppercase tracking-widest text-stone mb-1.5">Best suited for</div>
                  <p className="text-[11px] text-stone leading-relaxed">{plan.bestFor}</p>
                </div>

                <Link
                  href={plan.ctaHref}
                  className="block text-center text-sm font-medium py-2.5 rounded-xl transition-colors"
                  style={
                    plan.highlight
                      ? { background: '#1A3D2B', color: '#fff' }
                      : { background: 'transparent', color: '#1A3D2B', border: '1px solid rgba(26,61,43,0.25)' }
                  }
                >
                  {plan.cta}
                </Link>
              </div>
            </div>
          ))}
        </div>

        {/* What counts as one agreement processed */}
        <div className="bg-white border border-forest/10 rounded-2xl p-6 md:p-8 mb-8">
          <div className="text-xs font-semibold uppercase tracking-widest text-stone mb-3">What counts as one agreement processed?</div>
          <p className="text-sm text-stone leading-relaxed mb-3">One agreement processed is either:</p>
          <ul className="space-y-2 mb-4">
            {[
              'one customer billing cycle generated from an agreement and its associated usage data; or',
              'one partner invoice reconciled against the relevant agreement and operational data.',
            ].map(item => (
              <li key={item} className="flex items-start gap-2 text-sm text-stone leading-relaxed">
                <i className="ti ti-check flex-shrink-0 mt-0.5" style={{ fontSize: 13, color: '#1A3D2B' }} />
                {item}
              </li>
            ))}
          </ul>
          <p className="text-sm text-stone leading-relaxed">Start free or use Pay as you go, then move to Scale as your processing volume grows.</p>
        </div>

        {/* PII masking callout */}
        <div className="bg-white border border-forest/10 rounded-2xl p-6 md:p-8 mb-16 flex flex-col md:flex-row md:items-center gap-6">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: '#EAF3DE' }}>
            <i className="ti ti-shield-lock" style={{ fontSize: 20, color: '#27500A' }} />
          </div>
          <div className="flex-1">
            <div className="text-sm font-semibold text-ink mb-1">Advanced PII Data Masking</div>
            <p className="text-sm text-stone leading-relaxed">
              Available on all plans. Names, emails, and identifiers are detected and masked locally before being sent to AI for analysis — meeting strict corporate compliance requirements.
            </p>
          </div>
        </div>

        {/* FAQ */}
        <div className="max-w-2xl mx-auto">
          <h2 className="font-display font-light text-ink text-2xl mb-8 text-center">Common questions</h2>
          <div className="space-y-5">
            {[
              {
                q: 'What counts as one agreement processed?',
                a: 'One agreement processed is either a customer billing cycle generated from an agreement and its associated usage data, or a partner invoice reconciled against the relevant agreement and operational data.',
              },
              {
                q: 'What happens when I reach my included volume on Scale?',
                a: 'Additional agreements processed beyond the 100 included are billed at €3 each at the end of your monthly billing cycle. You are never cut off mid-workflow.',
              },
              {
                q: 'Can I switch between Free, Pay as you go, and Scale?',
                a: 'Yes. You can move to Scale at any time. If your volume is irregular, Pay as you go lets you process agreements without a monthly commitment.',
              },
              {
                q: 'What billing platforms are supported?',
                a: 'Stripe is supported today. Other platforms (Chargebee, Maxio, and others) are available on request and on our roadmap. Enterprise plans include custom integrations.',
              },
              {
                q: 'Is my contract data private?',
                a: 'Yes. All data is stored in EU-hosted infrastructure (Supabase Frankfurt). PII is masked before any AI processing. Your contract data is never used to train AI models.',
              },
            ].map(({ q, a }) => (
              <div key={q} className="border-b border-forest/8 pb-5">
                <div className="text-sm font-medium text-ink mb-2">{q}</div>
                <div className="text-sm text-stone leading-relaxed">{a}</div>
              </div>
            ))}
          </div>
        </div>
      </main>

      <footer className="border-t border-forest/10 py-8 text-center">
        <p className="text-xs text-stone/60">Verdix is a product by Lynora AB · Org. nr 559516-1190 · Sweden</p>
        <div className="flex items-center justify-center gap-4 mt-3 text-xs text-stone">
          <Link href="/privacy" className="hover:text-forest transition-colors">Privacy Policy</Link>
          <Link href="/terms" className="hover:text-forest transition-colors">Terms of Service</Link>
          <a href="mailto:bilal@lynoraai.com" className="hover:text-forest transition-colors">Contact</a>
        </div>
      </footer>
    </div>
  )
}
