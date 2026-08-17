import type { Metadata } from 'next'
import Link from 'next/link'
import Image from 'next/image'
import { VerdixLogo } from '@/components/VerdixLogo'
import { ProductShowcase } from './ProductShowcase'
import styles from './landing.module.css'

export const metadata: Metadata = {
  title: 'Verdix — Does what you billed match what you signed?',
  description: 'Verdix reads your signed agreements, pulls the usage they require, and turns both into approved billing instructions for the systems you already run.',
}

const CALENDLY_URL = 'https://calendly.com/bilal-zahoor/30min'

function Nav() {
  return (
    <nav className={styles.nav}>
      <div className={styles.navIn}>
        <Link className={styles.brand} href="#top"><VerdixLogo size={28} />Verdix</Link>
        <div className={styles.navLinks}>
          <a href="#who">Who it&apos;s for</a>
          <a href="#product">Product</a>
          <a href="#partner">Partner verification</a>
          <a href="#security">Security</a>
          <a href="#pricing">Pricing</a>
          <a href="/demos/contract-to-billing.html" target="_blank" rel="noopener noreferrer">Demo</a>
          <Link href="/blog">Blog</Link>
          <Link href="/login">Sign in</Link>
          <a className={`${styles.btn} ${styles.btnP} ${styles.btnSm}`} href={CALENDLY_URL} target="_blank" rel="noopener noreferrer">Book a working session</a>
        </div>
      </div>
    </nav>
  )
}

function Hero() {
  return (
    <section className={`${styles.hero} ${styles.section}`} id="top" style={{ paddingBottom: 0 }}>
      <div className={`${styles.wrap} ${styles.heroGrid}`}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
          <span className={styles.kicker}>Agreement-to-billing for complex B2B contracts</span>
          <h1 className={styles.h1}>Your contracts already say what to bill. <em style={{ fontStyle: 'normal', fontWeight: 600, color: 'var(--color-sage)' }}>Your billing system doesn&apos;t know it.</em></h1>
          <p className={styles.lede}>Verdix reads the signed agreement, pulls the usage it requires, and turns both into approved billing instructions for the systems you already run. Every calculation keeps the contract clause and usage source behind it.</p>
          <div className={styles.heroCta}>
            <a className={`${styles.btn} ${styles.btnP}`} href={CALENDLY_URL} target="_blank" rel="noopener noreferrer">Book a 30-minute working session →</a>
            <a className={`${styles.btn} ${styles.btnS}`} href="#product">See the product</a>
          </div>
          <div className={styles.trust}>
            <span><i className={styles.dot} />No billing migration</span>
            <span><i className={styles.dot} />No new usage pipeline</span>
            <span><i className={styles.dot} />EU-hosted · Personal identifiers masked before AI</span>
            <span><i className={styles.dot} />Clause-linked calculations</span>
          </div>
        </div>
        <div className={styles.proof}>
          <div className={styles.proofTop}>
            <div>
              <span className={`${styles.pill} ${styles.pillLive}`}>Live design-partner pilot</span>
              <span className={styles.illus} style={{ marginLeft: 8 }}>Illustrative commercial figures</span>
              <h3 className={styles.h3} style={{ marginTop: 14, fontFamily: 'var(--font-sans)', fontSize: '.98rem', fontWeight: 600, color: 'var(--color-ink)', display: 'flex', alignItems: 'center', gap: 10 }}>
                <Image src="/images/logo-remembill.png" alt="Remembill" width={22} height={22} style={{ height: 22, width: 'auto', borderRadius: 4, flexShrink: 0 }} />
                Remembill is piloting Verdix on one of its own enterprise customer agreements
              </h3>
            </div>
          </div>
          <div>
            <div className={styles.xs} style={{ textTransform: 'uppercase', letterSpacing: '.1em', fontWeight: 500, marginBottom: 6 }}>Fixed fees configured</div>
            <div className={styles.proofNum}>SEK 94,800</div>
            <div className={styles.xs} style={{ marginTop: 6 }}>+ usage-based and rule-based SMS charges</div>
          </div>
          <div className={styles.proofRows}>
            <div className={styles.proofRow}><span>Agreement</span><b><span className={styles.pii}>Nordic insurance customer</span> · 12 months</b></div>
            <div className={styles.proofRow}><span>Pricing model</span><b>Fixed + usage · 3 SMS tiers · quarterly minimum</b></div>
            <div className={styles.proofRow}><span>Fixed fees configured in</span><b>Remembill — via API</b></div>
            <div className={styles.proofRow}><span>Source traceability</span><b className={styles.ok}>Clause-linked ✓</b></div>
            <div className={styles.proofRow}><span>Manual contract re-entry</span><b>None</b></div>
          </div>
          <p className={styles.xs} style={{ lineHeight: 1.5 }}>The signed agreement enters Verdix, usage is pulled from the Remembill platform, and the billing owner reviews and approves the resulting billing logic. Live Remembill design-partner pilot using a real enterprise agreement. Customer identifiers are redacted and commercial figures shown are illustrative.</p>
        </div>
        <blockquote className={styles.quote}>
          <p>&quot;The commercial terms live in the agreements, while the usage needed to bill customers lives in the platform. Verdix brings the two together into billing logic that we can review and trace back to the contract, without having to rebuild it manually each billing cycle.&quot;</p>
          <footer>
            <Image src="/images/gustav-frandfors.png" alt="" width={44} height={44} />
            <div><b>Gustav Frändfors</b><span>Founder &amp; CEO, Remembill · Verdix design partner</span></div>
          </footer>
        </blockquote>
      </div>
    </section>
  )
}

function TheGap() {
  return (
    <section className={`${styles.alt} ${styles.section}`}>
      <div className={styles.wrap}>
        <div className={styles.secHead}>
          <span className={styles.kicker}>The gap</span>
          <h2 className={styles.h2}>Bespoke contracts move faster than billing systems</h2>
          <p className={styles.lede}>Tiers, minimum commitments, credits, ramp discounts and amendments get negotiated in the agreement. Someone still has to translate them into executable billing logic — every cycle, by hand.</p>
        </div>
        <div className={styles.cards3}>
          <div className={styles.card}><span className={styles.num}>01</span><h3 className={styles.h3}>Terms live in the agreement</h3><p>Rates, tiers, commitments and exceptions sit in contracts and amendments — not in the billing configuration.</p></div>
          <div className={styles.card}><span className={styles.num}>02</span><h3 className={styles.h3}>The invoice depends on data elsewhere</h3><p>Transactions, sessions, seats, shipments or API calls live in operational systems, outside the billing workflow.</p></div>
          <div className={styles.card}><span className={styles.num}>03</span><h3 className={styles.h3}>People connect the two manually</h3><p>Teams re-read agreements, pull usage and rebuild the logic each cycle. Errors surface after invoicing, if at all.</p></div>
        </div>
        <div className={styles.note}>
          <span><b>Symptoms:</b> billing rework · revenue leakage · delayed invoices · slower close · billing disputes without clear evidence</span>
        </div>
      </div>
    </section>
  )
}

const ICP_CARDS = [
  { title: 'Enterprise SaaS & AI', body: 'Bespoke pricing schedules, minimum commitments, usage tiers, ramp discounts, overages, credits, annual escalators and amendments.', buyer: 'RevOps · Billing Operations · Finance · Deal Desk' },
  { title: 'Payments & fintech', body: 'Merchant-specific transaction rates, volume tiers, minimum fees, platform charges, revenue shares and negotiated pricing exceptions.', buyer: 'Billing Operations · RevOps · Finance' },
  { title: 'EV charging & energy', body: 'Customer-specific tariffs, subscription and usage charges, site-specific pricing, energy pass-through rules and contract amendments.', buyer: 'Billing Operations · Revenue Operations · Finance' },
  { title: 'Telecom & connectivity', body: 'Customer-specific messaging, voice, data and IoT rates, volume tiers, minimum commitments, reseller pricing and negotiated contract amendments.', buyer: 'Revenue Assurance · Billing Operations · Finance' },
]

function WhoBand() {
  return (
    <section className={`${styles.band} ${styles.section}`} id="who">
      <div className={styles.wrap}>
        <div className={styles.secHead}>
          <span className={styles.kicker}>Who this is for</span>
          <h2 className={styles.h2}>Built for companies whose agreements are negotiated, not configured</h2>
          <p className={styles.lede}>Verdix is built for B2B companies where customer-specific rates, tiers, commitments, credits and amendments live in signed agreements — while the usage needed to bill them lives somewhere else.</p>
          <p className={styles.lede}>You already have a billing, ERP or payment system worth keeping. The problem is the manual work in between: RevOps and billing teams still have to interpret what was agreed, retrieve the required usage and translate both into the right billing logic.</p>
          <p className={styles.lede} style={{ fontSize: '.95rem' }}>Best fit: negotiated B2B contracts · recurring or usage-linked pricing · operational data accessible from existing systems · manual contract-to-billing workflows.</p>
        </div>
        <div className={styles.secHead} style={{ marginBottom: 32 }}>
          <span className={styles.kicker}>Where Verdix fits best</span>
          <h2 className={styles.h2} style={{ fontSize: '1.55rem' }}>Different industries. The same contract-to-billing problem.</h2>
        </div>
        <div className={styles.icp}>
          {ICP_CARDS.map(c => (
            <div key={c.title} className={styles.icpCard}>
              <h3 className={styles.h3}>{c.title}</h3>
              <p>{c.body}</p>
              <div className={styles.icpBuyer}>{c.buyer}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

const STEPS = [
  { n: '01 — Reads', title: 'The signed agreement', body: 'Rates, tiers, commitments, escalators, discounts and amendments are extracted and structured from the signed agreement.' },
  { n: '02 — Pulls', title: 'Only the required usage', body: 'Transactions, sessions, seats, orders or consumption are retrieved from the systems you already use. No new usage pipeline.' },
  { n: '03 — Calculates', title: 'The billing instruction', body: 'Agreed rates, tiers and billing rules are applied to the actual usage, with every figure linked back to its source.' },
  { n: '04 — Reviews', title: 'Your billing owner approves', body: 'Verdix flags exceptions and ambiguous terms for review. Nothing is sent downstream until your team approves it.' },
]

function HowItWorks() {
  return (
    <section className={styles.section}>
      <div className={styles.wrap}>
        <div className={styles.secHead}>
          <span className={styles.kicker}>How it works</span>
          <h2 className={styles.h2}>From signed agreement to approved billing instruction — in four steps</h2>
        </div>
        <div className={styles.steps}>
          {STEPS.map(s => (
            <div key={s.n} className={styles.step}>
              <span className={styles.stepN}>{s.n}</span>
              <h3 className={styles.h3}>{s.title}</h3>
              <p>{s.body}</p>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 28, border: '1px solid var(--color-line)', borderRadius: 14, background: '#fff', padding: '22px 28px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '18px 32px' }}>
          <div style={{ flex: '1 1 340px' }}>
            <span className={styles.stepN}>Works with your existing billing stack</span>
            <h3 className={styles.h3} style={{ margin: '6px 0 4px' }}>Approved billing instructions flow into the systems you already use</h3>
            <p style={{ margin: 0 }}>No billing migration. Keep the systems you already run.</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <span style={{ fontSize: '.8rem', opacity: .55 }}>Live integrations</span>
            <Image src="/images/logo-remembill.png" alt="Remembill" width={26} height={26} style={{ height: 26, width: 'auto', borderRadius: 4 }} />
            <Image src="/images/logo-stripe.png" alt="Stripe" width={46} height={22} style={{ height: 22, width: 'auto' }} />
          </div>
        </div>
      </div>
    </section>
  )
}

function ProductSection() {
  return (
    <section className={`${styles.alt} ${styles.section}`} id="product">
      <div className={styles.wrap}>
        <div className={styles.secHead}>
          <span className={styles.kicker}>The product</span>
          <h2 className={styles.h2}>From signed agreement to configured billing — in the actual platform</h2>
          <p className={styles.lede}>This is a live Remembill design-partner pilot shown with illustrative commercial figures: a 12-month base subscription, a one-time integration fee, tiered SMS pricing, a quarterly commercial rule and an escalation clause — including terms Verdix surfaces for human interpretation before they affect billing.</p>
        </div>
        <ProductShowcase />
      </div>
    </section>
  )
}

function PartnerSection() {
  return (
    <section className={styles.section} id="partner">
      <div className={styles.wrap}>
        <div className={styles.secHead}>
          <span className={styles.kicker}>The other side of the ledger</span>
          <h2 className={styles.h2}>The same agreement logic can also verify what your partners charge you</h2>
          <p className={styles.lede}>Verdix applies the same contract intelligence to partner, supplier and reseller agreements — comparing incoming invoices against the rates, tiers, discounts, minimums and other terms you actually agreed. Instead of rebuilding the calculation by hand, your team gets a clause-backed view of what was expected, what was charged and where the two differ.</p>
        </div>
        <div className={styles.cards2}>
          <div className={styles.card}><h3 className={styles.h3}>What it catches</h3><p>Wrong rates and tiers, duplicate charges, expired discounts, unsupported fees, waived minimums still being charged, missed rebates and incorrect indexation.</p></div>
          <div className={styles.card}><h3 className={styles.h3}>What you get</h3><p>A clause-backed expected-versus-actual comparison, a quantified exception list, and an audit trail showing why each charge is correct — or why it should be challenged.</p></div>
        </div>
      </div>
    </section>
  )
}

function ClauseDrilldown() {
  return (
    <section className={`${styles.alt} ${styles.section}`}>
      <div className={styles.wrap}>
        <div className={styles.secHead}>
          <span className={styles.kicker}>Built for Finance &amp; RevOps to trust</span>
          <h2 className={styles.h2}>Click any rate. Land on the clause that set it.</h2>
          <p className={styles.lede}>Every calculation keeps its evidence — the contract term, source usage and applied logic. So your team can see exactly why something was billed, and trace it back to the signed agreement.</p>
        </div>
        <div className={styles.clauseGrid}>
          <div className={styles.rateSide}>
            <span className={styles.paneL}>Charging parameters · SMS reminder</span>
            <div className={styles.rateC}><div className={styles.tierL}>SMS reminders 1–500 — included in base fee</div><div className={styles.tierV}>SEK 0.00</div><div className={styles.tierS}>From unit 1 to 500</div></div>
            <div className={`${styles.rateC} ${styles.on}`}><div className={styles.tierL}>SMS reminders 501–2,000 — overage</div><div className={styles.tierV}>SEK 1.10 <span>/ SMS reminder</span></div><div className={styles.tierS}>From unit 501 to 2,000</div></div>
            <div className={styles.rateC}><div className={styles.tierL}>SMS reminders 2,001+ — overage</div><div className={styles.tierV}>SEK 0.85 <span>/ SMS reminder</span></div><div className={styles.tierS}>From unit 2,001+</div></div>
            <div className={styles.rateC}>
              <div className={styles.tierL}>Guaranteed quarterly minimum</div>
              <div className={styles.tierV}>SEK 5,000.00 <span>/ quarter</span></div>
              <div className={styles.tierS}>Applies regardless of SMS volume · §4.2 · clause-linked</div>
              <div className={styles.tierS} style={{ marginTop: 8, padding: '9px 11px', borderRadius: 8, background: '#F2F8F3', color: 'var(--color-forest)' }}><b>Approved interpretation</b> — minimum charge floor: the first 500 SMS reminders are included, tiered usage is calculated, and SEK 5,000 is enforced as the quarterly minimum. Confirmed by reviewer.</div>
            </div>
            <div className={styles.rateHint}>↳ Extracted from §4.2 — click to open the source</div>
          </div>
          <div className={styles.doc}>
            <div className={styles.docH}><b>Signed contract</b><i>· jumping to §4.2 SMS-påminnelser — volymbaserad prissättning</i><span>×</span></div>
            <div className={styles.docB}>
              <span className={styles.vtag}>V</span>
              <h4>4.2 SMS-påminnelser — volymbaserad prissättning</h4>
              <p><span className={styles.hl}><b>SMS-påminnelser mäts och faktureras kvartalsvis, i efterskott — till skillnad från grundavgiften, som faktureras månadsvis i förskott enligt punkt 4.1.</b> Volymen nollställs vid varje kalenderkvartals början (kvartal: jan–mar, apr–jun, jul–sep, okt–dec).</span></p>
              <table className={styles.docT}>
                <thead><tr><th>Volym per kvartal</th><th className={styles.r}>Pris per SMS-påminnelse</th></tr></thead>
                <tbody>
                  <tr><td>0 – 500</td><td className={styles.r}>Ingår i grundavgift</td></tr>
                  <tr><td>501 – 2 000</td><td className={styles.r}>1,10 SEK</td></tr>
                  <tr><td>Över 2 000</td><td className={styles.r}>0,85 SEK</td></tr>
                </tbody>
              </table>
              <p style={{ marginBottom: 0 }}><span className={styles.hl}><b>Garanterad minimiavgift:</b> Kunden betalar lägst 5 000 SEK per kalenderkvartal för SMS-påminnelser, oavsett faktisk volym under kvartalet.</span></p>
            </div>
          </div>
        </div>
        <div className={styles.miss}>
          <div className={styles.missC}><b>Different billing rhythms in one agreement</b><p>The base fee bills monthly in advance. SMS usage bills quarterly in arrears, with volume resetting each calendar quarter. Verdix preserves these component-level billing rules rather than flattening them into a single contract-wide cadence.</p></div>
          <div className={styles.missC}><b>A minimum hidden in prose</b><p>Verdix surfaced the SEK 5,000 quarterly minimum because its interaction with the included allowance required interpretation. The billing owner confirmed the treatment, and Verdix retained both the source clause and the approved rule.</p></div>
        </div>
      </div>
    </section>
  )
}

const SECURITY_CARDS = [
  { title: 'EU-based architecture', body: 'Customer data is processed within European infrastructure.' },
  { title: 'Masked before AI processing', body: 'Personal identifiers such as names, email addresses, phone numbers and other direct identifiers are masked before contract text reaches the model layer.' },
  { title: 'No training on your contracts', body: 'Your agreements and customer data are not used to train AI models.' },
  { title: 'Traceable by design', body: 'Extracted terms, source clauses and billing calculations remain linked throughout the workflow.' },
]

function Security() {
  return (
    <section className={styles.section} id="security">
      <div className={styles.wrap}>
        <div className={styles.secHead}>
          <span className={styles.kicker}>Built for sensitive commercial agreements</span>
          <h2 className={styles.h2}>Designed around European data requirements</h2>
          <p className={styles.lede}>Your contracts contain commercially sensitive pricing, customer and operational information. Verdix is designed to minimise what reaches the model layer and keep the processing path controlled and traceable.</p>
        </div>
        <div className={styles.secGrid}>
          {SECURITY_CARDS.map(c => (
            <div key={c.title} className={styles.secC}><h3 className={styles.h3}>{c.title}</h3><p>{c.body}</p></div>
          ))}
        </div>
      </div>
    </section>
  )
}

const PLANS = [
  {
    name: 'Design partner', hi: true,
    price: 'Start with one real agreement',
    warmup: 'Test Verdix on a historical contract and the usage behind it before committing to a production integration.',
    features: ['Complimentary first audit', 'Read-only validation', 'Early product access', 'Direct roadmap input', 'Preferred commercial terms'],
    cta: 'Book a 30-minute working session →', href: CALENDLY_URL, primary: true,
  },
  {
    name: 'Growing teams', hi: false,
    price: 'Workflow-based pricing',
    warmup: 'For RevOps, Billing and Finance teams running recurring agreement-to-billing workflows.',
    features: ['Customer agreement-to-billing', 'Automated usage retrieval', 'Clause-linked calculations', 'Live integrations with Remembill and Stripe', 'Team review and approval'],
    cta: 'Talk to us about pricing →', href: CALENDLY_URL, primary: false,
  },
  {
    name: 'Enterprise', hi: false,
    price: 'Custom',
    warmup: 'For higher volumes, multiple entities or additional deployment, security and support requirements.',
    features: ['Custom workflow volumes', 'Multiple integrations and data sources', 'Enterprise access controls', 'Configurable retention and audit requirements', 'Support and commercial SLA options'],
    cta: 'Talk to us →', href: 'mailto:bilal@lynoraai.com?subject=Verdix%20Enterprise', primary: false,
  },
]

function Pricing() {
  return (
    <section className={`${styles.alt} ${styles.section}`} id="pricing">
      <div className={styles.wrap}>
        <div className={styles.secHead}>
          <span className={styles.kicker}>Pricing</span>
          <h2 className={styles.h2}>Pricing aligned to completed agreement workflows</h2>
          <p className={styles.lede}>No percentage of revenue. No charge for every raw usage event. No requirement to replace your billing or payment infrastructure.</p>
        </div>
        <div className={styles.priceFrame}>
          <div className={styles.card}>
            <span className={styles.kicker}>How it scales</span>
            <div className={styles.big} style={{ fontSize: '1.35rem', lineHeight: 1.3 }}>Pricing scales with the number and complexity of agreement workflows you run</div>
            <p>Not with the revenue flowing through them.</p>
          </div>
        </div>
        <div className={styles.plans}>
          {PLANS.map(p => (
            <div key={p.name} className={p.hi ? `${styles.plan} ${styles.hi}` : styles.plan}>
              <span className={styles.planN}>{p.name}</span>
              <div className={styles.planP} style={{ fontSize: p.price === 'Custom' ? undefined : '1.35rem', lineHeight: p.price === 'Custom' ? undefined : 1.3 }}>{p.price}</div>
              <p className={styles.planW}>{p.warmup}</p>
              <ul>{p.features.map(f => <li key={f}>{f}</li>)}</ul>
              <a
                className={`${styles.btn} ${p.primary ? styles.btnP : styles.btnS}`}
                href={p.href}
                {...(p.href.startsWith('http') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
              >
                {p.cta}
              </a>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function CTA() {
  return (
    <section className={`${styles.cta} ${styles.section}`} id="cta">
      <div className={styles.wrap}>
        <span className={styles.kicker} style={{ color: '#9CC0A6' }}>Design partner programme</span>
        <h2 className={styles.h2} style={{ marginTop: 16 }}>Bring us one difficult agreement. We&apos;ll show you what it should have billed.</h2>
        <p className={styles.lede}>Start with one historical agreement and the usage behind it. Verdix reconstructs the billing logic and shows the evidence behind every result.</p>
        <p className={styles.lede} style={{ marginTop: 10 }}>
          30-minute fit check → complimentary first audit → read-only pilot<br />
          <span style={{ opacity: .8 }}>Early access · Direct roadmap input · Preferred commercial terms</span>
        </p>
        <div className={styles.ctaB}>
          <a className={`${styles.btn} ${styles.btnP}`} href={CALENDLY_URL} target="_blank" rel="noopener noreferrer">Book a 30-minute working session →</a>
        </div>
      </div>
    </section>
  )
}

function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={styles.wrap}>
        <div className={styles.foot}>
          <div style={{ maxWidth: 340, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Link className={styles.brand} style={{ color: '#fff' }} href="#top">
              <VerdixLogo size={28} />
              Verdix
            </Link>
            <p>Agreement-to-billing for complex B2B contracts.<br />A product by Lynora AB, Sweden.</p>
          </div>
          <div className={styles.footL}>
            <a href="#who">Who it&apos;s for</a>
            <a href="#product">Product</a>
            <a href="#partner">Partner verification</a>
            <a href="#security">Security</a>
            <a href="#pricing">Pricing</a>
            <a href="/demos/contract-to-billing.html" target="_blank" rel="noopener noreferrer">Demo</a>
            <Link href="/blog">Blog</Link>
            <Link href="/login">Sign in</Link>
            <Link href="/privacy">Privacy Policy</Link>
            <Link href="/terms">Terms of Service</Link>
            <a href="mailto:bilal@lynoraai.com">Contact</a>
          </div>
        </div>
        <div className={styles.footB}>© 2026 Verdix. All rights reserved. · Lynora AB · Org. nr 559516-1190 · Sweden</div>
      </div>
    </footer>
  )
}

export default function MarketingPage() {
  return (
    <div className={styles.page}>
      <Nav />
      <Hero />
      <TheGap />
      <WhoBand />
      <HowItWorks />
      <ProductSection />
      <ClauseDrilldown />
      <PartnerSection />
      <Security />
      <Pricing />
      <CTA />
      <Footer />
    </div>
  )
}
