import Link from 'next/link'
import { VerdixLogo } from '@/components/VerdixLogo'

const plans = [
  {
    id: 'trial',
    name: 'Standard',
    badge: 'Free',
    price: '€0',
    period: '',
    description: 'Try Verdix with no commitment.',
    syncs: 'First 3 agreement syncs',
    overage: null,
    highlight: false,
    cta: 'Get started free',
    ctaHref: '/signup',
    features: [
      'Contract PDF upload',
      'Basic billing configuration check',
      'Standard leakage dashboard',
      'Manual billing audit',
    ],
  },
  {
    id: 'core',
    name: 'Core',
    badge: null,
    price: '€95',
    period: '/month',
    description: 'For growing teams rolling out usage metrics.',
    syncs: 'First 10 synced agreements',
    overage: '€5.00 per excess sync',
    highlight: false,
    cta: 'Start with Core',
    ctaHref: '/signup?plan=core',
    features: [
      'Automated contract configuration sync',
      'Native Stripe billing integration',
      'Invoice audit checks against pricebooks',
      'Advanced PII masking add-on (€45/mo)',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    badge: 'Most popular',
    price: '€445',
    period: '/month',
    description: 'For scaling mid-market companies with hybrid billing models.',
    syncs: 'First 100 synced agreements',
    overage: '€2.50 per excess sync',
    highlight: true,
    cta: 'Start with Pro',
    ctaHref: '/signup?plan=pro',
    features: [
      'Automated contract configuration sync',
      'Native Stripe billing integration',
      'Invoice audit checks against pricebooks',
      'Advanced PII masking add-on (€45/mo)',
    ],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    badge: null,
    price: 'Custom',
    period: '',
    description: 'For multi-entity corporations and highly regulated sectors.',
    syncs: 'Custom offer tailored to your organisation\'s specific needs',
    overage: null,
    highlight: false,
    cta: 'Contact sales',
    ctaHref: 'mailto:bilal@lynoraai.com?subject=Verdix Enterprise',
    features: [
      'All Pro capabilities',
      'Advanced PII data masking included',
      'Dedicated onboarding & SLA',
    ],
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
        <div className="text-center mb-16">
          <h1 className="font-display font-light text-ink text-4xl md:text-5xl mb-4">
            Simple, usage-based pricing
          </h1>
          <p className="text-stone text-lg max-w-xl mx-auto leading-relaxed">
            Pay for what you use. One agreement sync covers a contract upload, a billing audit, or a partner reconciliation.
          </p>
        </div>

        {/* Plan grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 mb-16">
          {plans.map(plan => (
            <div
              key={plan.id}
              className="bg-white rounded-2xl border flex flex-col overflow-hidden transition-shadow hover:shadow-md"
              style={{ borderColor: plan.highlight ? '#1A3D2B' : 'rgba(26,61,43,0.1)' }}
            >
              {plan.badge ? (
                <div
                  className="text-center text-xs font-semibold py-1.5 tracking-wide"
                  style={{ background: plan.highlight ? '#1A3D2B' : '#EAF3DE', color: plan.highlight ? '#fff' : '#27500A' }}
                >
                  {plan.badge}
                </div>
              ) : <div className="h-[30px]" />}

              <div className="p-6 flex flex-col flex-1">
                <div className="mb-5">
                  <div className="text-xs font-semibold text-stone uppercase tracking-widest mb-2">{plan.name}</div>
                  <div className="flex items-baseline gap-1 mb-2">
                    <span className="text-3xl font-semibold text-ink">{plan.price}</span>
                    {plan.period && <span className="text-stone text-sm">{plan.period}</span>}
                  </div>
                  <p className="text-xs text-stone leading-relaxed">{plan.description}</p>
                </div>

                <div className="bg-cream rounded-xl p-3 mb-5">
                  <div className="text-[11px] font-semibold text-ink mb-0.5">{plan.syncs}</div>
                  {plan.overage && (
                    <div className="text-[11px] text-stone">{plan.overage}</div>
                  )}
                </div>

                <ul className="space-y-2 flex-1 mb-6">
                  {plan.features.map(f => (
                    <li key={f} className="flex items-start gap-2 text-xs text-stone leading-relaxed">
                      <i className="ti ti-check flex-shrink-0 mt-0.5" style={{ fontSize: 13, color: '#1A3D2B' }} />
                      {f}
                    </li>
                  ))}
                </ul>

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

        {/* PII add-on callout */}
        <div className="bg-white border border-forest/10 rounded-2xl p-6 md:p-8 mb-16 flex flex-col md:flex-row md:items-center gap-6">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: '#EAF3DE' }}>
            <i className="ti ti-shield-lock" style={{ fontSize: 20, color: '#27500A' }} />
          </div>
          <div className="flex-1">
            <div className="text-sm font-semibold text-ink mb-1">Advanced PII Data Masking — +€45/month add-on</div>
            <p className="text-sm text-stone leading-relaxed">
              Available on Core and Pro plans. Names, emails, and identifiers are detected and masked locally before being sent to AI for analysis — meeting strict corporate compliance requirements. Natively included in Enterprise at no extra cost.
            </p>
          </div>
        </div>

        {/* FAQ */}
        <div className="max-w-2xl mx-auto">
          <h2 className="font-display font-light text-ink text-2xl mb-8 text-center">Common questions</h2>
          <div className="space-y-5">
            {[
              {
                q: 'What counts as an agreement sync?',
                a: 'One sync is consumed when you upload and configure a customer contract, run a billing audit, or complete a partner reconciliation. All three actions count equally.',
              },
              {
                q: 'What happens when I reach my sync limit?',
                a: 'You\'ll see a warning banner and we\'ll notify you. You can keep running syncs — any overages are billed at the per-sync rate at the end of your monthly billing cycle. You\'re never cut off.',
              },
              {
                q: 'Can I change my plan mid-month?',
                a: 'Yes. Upgrades take effect immediately via Stripe Checkout. Your sync counter carries over to the new plan.',
              },
              {
                q: 'What billing platforms are supported?',
                a: 'Stripe is supported today. Other platforms (Chargebee, Maxio, and others) are available on request and are on our roadmap.',
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
        <p className="text-xs text-stone/60">Verdix is a product by Lynora AB · Org. nr 559516-1190 · Vallentuna, Sweden</p>
        <div className="flex items-center justify-center gap-4 mt-3 text-xs text-stone">
          <Link href="/privacy" className="hover:text-forest transition-colors">Privacy Policy</Link>
          <Link href="/terms" className="hover:text-forest transition-colors">Terms of Service</Link>
          <a href="mailto:bilal@lynoraai.com" className="hover:text-forest transition-colors">Contact</a>
        </div>
      </footer>
    </div>
  )
}
