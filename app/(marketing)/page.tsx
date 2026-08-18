import type { Metadata } from 'next'
import Link from 'next/link'
import Image from 'next/image'
import { VerdixLogo } from '@/components/VerdixLogo'
import { ProductShowcase } from './ProductShowcase'
import { MobileNav } from './MobileNav'
import styles from './landing.module.css'

export const metadata: Metadata = {
  title: 'Verdix — Does what you billed match what you signed?',
  description: 'Verdix reads your signed agreements, pulls the usage they require, and turns both into approved billing instructions for the systems you already run.',
}

const CALENDLY_URL = 'https://calendly.com/bilal-zahoor/30min'
const DEMO_URL = '/demos/contract-to-billing.html'

function Nav() {
  // The persistent desktop top nav is kept deliberately short (conversion
  // pass: Product/Security/Pricing/Sign in/CTA only) — Who it's for, Partner
  // verification, Demo and Blog stay reachable via the footer and the mobile
  // panel, just not competing for space in the bar itself. The mobile
  // slide-down panel keeps the fuller set since a visitor who opens it has
  // already asked to see everything, and it was previously the only way for
  // small screens to reach Sign in/Pricing/the primary CTA at all.
  const desktopLinks = (
    <>
      <a href="#product">Product</a>
      <a href="#security">Security</a>
      <a href="#pricing">Pricing</a>
      <Link href="/login">Sign in</Link>
      <a className={`${styles.btn} ${styles.btnP} ${styles.btnSm}`} href={DEMO_URL} target="_blank" rel="noopener noreferrer">Watch demo</a>
    </>
  )
  const mobileLinks = (
    <>
      <a href="#who">Who it&apos;s for</a>
      <a href="#product">Product</a>
      <a href="#partner">Partner verification</a>
      <a href="#security">Security</a>
      <a href="#pricing">Pricing</a>
      <a href={DEMO_URL} target="_blank" rel="noopener noreferrer">Watch demo</a>
      <Link href="/blog">Blog</Link>
      <Link href="/login">Sign in</Link>
      <a className={`${styles.btn} ${styles.btnP} ${styles.btnSm}`} href={CALENDLY_URL} target="_blank" rel="noopener noreferrer">Book a demo</a>
    </>
  )
  return (
    <nav className={styles.nav}>
      <div className={styles.navIn}>
        <Link className={styles.brand} href="#top"><VerdixLogo size={28} />Verdix</Link>
        <div className={styles.navLinks}>{desktopLinks}</div>
        <MobileNav><div className={styles.navMobileLinks}>{mobileLinks}</div></MobileNav>
      </div>
    </nav>
  )
}

const PILOT_DISCLOSURE = 'Live Remembill design-partner pilot using a real enterprise agreement. Customer identifiers are redacted and commercial figures shown are illustrative.'

function Hero() {
  return (
    <section className={`${styles.hero} ${styles.section}`} id="top" style={{ paddingBottom: 0 }}>
      <div className={styles.wrap}>
        <div className={styles.heroGrid}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
            <span className={styles.kicker}>Agreement-to-billing for complex B2B contracts</span>
            <h1 className={styles.h1}>Your contracts already say what to bill. <em style={{ fontStyle: 'normal', fontWeight: 600, color: 'var(--color-sage)' }}>Your billing system doesn&apos;t know it.</em></h1>
            <p className={styles.icpLine}>For SaaS, fintech, telecom and energy companies billing negotiated, usage-linked B2B contracts.</p>
            <p className={styles.lede}>Verdix reads the signed agreement, pulls the usage it requires, and turns both into approved, clause-linked billing instructions. Keep your existing billing stack, with live integrations to Remembill and Stripe.</p>
            <div className={styles.heroCta}>
              <a className={`${styles.btn} ${styles.btnP}`} href={DEMO_URL} target="_blank" rel="noopener noreferrer">Watch the 2-minute walkthrough →</a>
              <a className={`${styles.btn} ${styles.btnS}`} href={CALENDLY_URL} target="_blank" rel="noopener noreferrer">Book a demo</a>
            </div>
            <div className={styles.trust}>
              <span><i className={styles.dot} />No billing migration</span>
              <span className={styles.trustHideMobile}><i className={styles.dot} />No new usage pipeline</span>
              <span><i className={styles.dot} />Clause-linked calculations</span>
            </div>
          </div>
          <div className={styles.proof}>
            <div className={styles.proofTop}>
              <div>
                <span className={`${styles.pill} ${styles.pillLive}`}>Live design-partner pilot</span>
                <h3 className={styles.h3} style={{ marginTop: 14 }}>From signed agreement to paid invoice</h3>
              </div>
            </div>
            <p className={styles.xs} style={{ fontSize: '.86rem', lineHeight: 1.55 }}>Verdix turns the commercial terms and usage in the agreement into approved billing. Remembill takes the invoice from delivery to payment, including recovery when a payment fails.</p>

            {/* Desktop: horizontal workflow. Below 720px this is swapped for
                the compact numbered blocks below — the full arrow chain reads
                fine at full width but consumes most of a phone screen. */}
            <div className={styles.flow}>
              <div className={styles.flowNode}>Signed agreement</div>
              <div className={styles.flowArrow} aria-hidden="true">→</div>
              <div className={styles.flowCol}>
                <div className={styles.flowColLabel}>
                  <VerdixLogo size={16} />
                  Verdix
                </div>
                <ul>
                  <li>Fixed + variable billing logic configured</li>
                  <li>Required usage pulled</li>
                  <li>Clause-linked review &amp; approval</li>
                </ul>
              </div>
              <div className={styles.flowArrow} aria-hidden="true">→</div>
              <div className={styles.flowNode}>API</div>
              <div className={styles.flowArrow} aria-hidden="true">→</div>
              <div className={styles.flowCol}>
                <div className={styles.flowColLabel}>
                  <Image src="/images/logo-remembill.png" alt="" width={16} height={16} style={{ height: 16, width: 'auto', borderRadius: 3, flexShrink: 0 }} />
                  Remembill
                </div>
                <ul>
                  <li>Invoice delivered</li>
                  <li>Simple payment without login</li>
                  <li>Failed-payment recovery</li>
                </ul>
              </div>
              <div className={styles.flowArrow} aria-hidden="true">→</div>
              <div className={`${styles.flowNode} ${styles.flowNodePaid}`}>Payment</div>
            </div>

            <div className={styles.flowMobile}>
              <div className={styles.flowMobileStep}>
                <span className={styles.flowMobileNum}>1</span>
                <div><div className={styles.flowMobileLabel}>Verdix</div><p>Commercial terms + usage → approved billing</p></div>
              </div>
              <div className={styles.flowMobileStep}>
                <span className={styles.flowMobileNum}>2</span>
                <div><div className={styles.flowMobileLabel}>API</div><p>Approved invoice data sent automatically</p></div>
              </div>
              <div className={styles.flowMobileStep}>
                <span className={styles.flowMobileNum}>3</span>
                <div><div className={styles.flowMobileLabel}>Remembill</div><p>Invoice delivery → payment → failed-payment recovery</p></div>
              </div>
              <div className={styles.flowMobileOutcome}>No manual contract re-entry. Less friction from agreement to payment.</div>
              <div className={styles.flowMobileProof}>
                <div className={styles.proofStat}><span>Commercial model</span><b>Fixed + variable usage · 3 SMS tiers · quarterly minimum</b></div>
                <div className={styles.proofStat}><span>Traceability</span><b className={styles.ok}>Clause-linked ✓</b></div>
              </div>
              <p className={styles.proofCaption}>{PILOT_DISCLOSURE}</p>
            </div>
          </div>
          {/* Gustav quote — pulled for now, will reintroduce later */}
          {/* <blockquote className={styles.quote}>
            <p>&quot;The commercial terms live in the agreements, while the usage needed to bill customers lives in the platform. Verdix brings the two together into billing logic that we can review and trace back to the contract, without having to rebuild it manually each billing cycle.&quot;</p>
            <footer>
              <Image src="/images/gustav-frandfors.png" alt="" width={44} height={44} />
              <div><b>Gustav Frändfors</b><span>Founder &amp; CEO, Remembill · Verdix design partner</span></div>
            </footer>
          </blockquote> */}
        </div>

        <div className={styles.proofStats}>
          <div className={styles.proofStat}><span>Commercial model</span><b>Fixed + variable usage · 3 SMS tiers · quarterly minimum</b></div>
          <div className={styles.proofStat}><span>Verdix → Remembill</span><b>Approved invoice data submitted to Remembill via API</b></div>
          <div className={styles.proofStat}><span>End-to-end outcome</span><b>No manual contract re-entry · less friction from invoice to payment</b></div>
          <div className={styles.proofStat}><span>Source traceability</span><b className={styles.ok}>Clause-linked ✓</b></div>
        </div>
        <p className={styles.proofCaption}>{PILOT_DISCLOSURE}</p>
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
          <p className={styles.lede}>Commercial terms get negotiated in the agreement. Someone still has to translate them into billing logic, every cycle, by hand.</p>
        </div>
        <div className={styles.cards3}>
          <div className={styles.card}><span className={styles.num}>01</span><h3 className={styles.h3}>Terms live in the agreement</h3><p>Rates, tiers, commitments and exceptions never make it cleanly into billing configuration.</p></div>
          <div className={styles.card}><span className={styles.num}>02</span><h3 className={styles.h3}>Usage lives somewhere else</h3><p>Transactions, sessions, seats and consumption sit in operational systems, outside the billing workflow.</p></div>
          <div className={styles.card}><span className={styles.num}>03</span><h3 className={styles.h3}>People connect them manually</h3><p>Teams interpret the contract, retrieve usage and rebuild the calculation every cycle.</p></div>
        </div>
        <div className={styles.note}>
          <span><b>Symptoms:</b> billing rework · revenue leakage · delayed invoices · slower close · billing disputes without clear evidence</span>
        </div>
      </div>
    </section>
  )
}

const ICP_CARDS = [
  { title: 'Enterprise SaaS & AI', body: 'Bespoke pricing schedules, minimum commitments, usage tiers, ramp discounts, overages, credits, annual escalators and amendments.', tags: 'Usage tiers · minimums · ramp discounts · credits', buyer: 'RevOps · Billing Operations · Finance · Deal Desk' },
  { title: 'Payments & fintech', body: 'Merchant-specific transaction rates, volume tiers, minimum fees, platform charges, revenue shares and negotiated pricing exceptions.', tags: 'Transaction rates · volume tiers · minimum fees · revenue shares', buyer: 'Billing Operations · RevOps · Finance' },
  { title: 'EV charging & energy', body: 'Customer-specific tariffs, subscription and usage charges, site-specific pricing, energy pass-through rules and contract amendments.', tags: 'Tariffs · usage charges · site-specific pricing · pass-through rules', buyer: 'Billing Operations · Revenue Operations · Finance' },
  { title: 'Telecom & connectivity', body: 'Customer-specific messaging, voice, data and IoT rates, volume tiers, minimum commitments, reseller pricing and negotiated contract amendments.', tags: 'Messaging & data rates · volume tiers · minimums · reseller pricing', buyer: 'Revenue Assurance · Billing Operations · Finance' },
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
              <p className={styles.icpBodyFull}>{c.body}</p>
              <p className={styles.icpBodyShort}>{c.tags}</p>
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
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Image src="/images/logo-remembill.png" alt="" width={26} height={26} style={{ height: 26, width: 'auto', borderRadius: 4 }} />
              <span style={{ fontSize: '.88rem', fontWeight: 500, color: 'var(--color-ink)' }}>Remembill</span>
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Image src="/images/logo-stripe.png" alt="" width={46} height={22} style={{ height: 22, width: 'auto' }} />
              <span style={{ fontSize: '.88rem', fontWeight: 500, color: 'var(--color-ink)' }}>Stripe</span>
            </span>
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
    <section className={styles.section} id="partner" style={{ paddingTop: 0, paddingBottom: 56 }}>
      <div className={styles.wrap}>
        <div className={styles.partnerCompact}>
          <span className={styles.kicker}>The other side of the ledger</span>
          <p className={styles.lede} style={{ marginTop: 8 }}>Verdix can also use the same agreement logic to verify incoming supplier, reseller and partner invoices.</p>
          <p className={styles.sm} style={{ marginTop: 10 }}><b style={{ color: 'var(--color-ink)', fontWeight: 500 }}>Catches:</b> wrong rates · expired discounts · unsupported fees · missed rebates · incorrect indexation</p>
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
              <div className={styles.annotation}>
                <b>English interpretation:</b> SMS usage is measured quarterly in arrears. The first 500 reminders are included in the base fee, usage above that is tiered, and the customer is subject to a SEK 5,000 minimum charge per calendar quarter.
              </div>
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

const SECURITY_CARDS: Array<{
  title: string
  body: string[]
  contactPrompt?: string
  ctas?: Array<{ label: string; href: string }>
}> = [
  {
    title: 'EU data handling',
    body: [
      'Application processing and primary customer data storage run in European infrastructure.',
      "AI model processing is routed through Amazon Bedrock's EU infrastructure.",
    ],
    ctas: [{ label: 'Privacy & retention →', href: '/privacy' }],
  },
  {
    title: 'Data minimisation & AI',
    body: [
      'Direct personal identifiers are masked before contract text reaches the AI processing layer.',
      'Customer data is isolated by organisation throughout the Verdix application.',
    ],
  },
  {
    // Deliberately no "proof" badges (DPA/subprocessors/retention) here yet —
    // those aren't finished and shouldn't be claimed until they are. Just the
    // two controls actually verified, plus a genuine contact path for
    // anything not yet published. See the 2026-08-19 security audit.
    title: 'Governance & traceability',
    body: [
      'Contract terms, reviewer decisions and billing calculations remain linked to their source evidence.',
      'Customer data access is isolated by organisation.',
    ],
    contactPrompt: 'Security & data protection questions?',
    ctas: [{ label: 'Contact us →', href: 'mailto:bilal@lynoraai.com?subject=Security%20%26%20Data%20Protection%20Enquiry' }],
  },
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
            <div key={c.title} className={styles.secC}>
              <h3 className={styles.h3}>{c.title}</h3>
              {c.body.map(p => <p key={p}>{p}</p>)}
              {c.contactPrompt && <p className={styles.secPrompt}>{c.contactPrompt}</p>}
              {c.ctas && (
                <div className={styles.secCtaRow}>
                  {c.ctas.map(cta => (
                    <a key={cta.label} href={cta.href} className={styles.secCta}>
                      {cta.label}
                    </a>
                  ))}
                </div>
              )}
            </div>
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
    cta: 'Bring us an agreement →', href: CALENDLY_URL, primary: true,
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
          <a className={`${styles.btn} ${styles.btnP}`} href={CALENDLY_URL} target="_blank" rel="noopener noreferrer">Bring us an agreement →</a>
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
