import Link from 'next/link'
import { VerdixLogo } from '@/components/VerdixLogo'
import { isSelfServiceSignupEnabled } from '@/lib/feature-flags'

export const metadata = {
  title: 'Why contract-to-cash is still a manual workflow in modern SaaS | Verdix',
  description:
    'Modern SaaS companies use CRM, CLM, billing and payment software, yet bespoke contract-to-cash workflows remain manual. Here is why.',
}

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
            <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#4A7C59' }}>Finance operations · Revenue</span>
            <span className="text-stone/40">·</span>
            <span className="text-xs text-stone">July 2026</span>
          </div>
          <h1 className="font-display font-light text-ink leading-tight mb-5" style={{ fontSize: 'clamp(1.8rem,3.5vw,2.6rem)' }}>
            Why contract-to-cash is still a manual workflow in modern SaaS
          </h1>
          <p className="text-stone leading-relaxed" style={{ fontSize: 16 }}>
            Modern SaaS companies use CRM, CLM, billing and payment software, yet bespoke contract-to-cash workflows remain manual. Here is why.
          </p>
        </div>

        <hr style={{ border: 'none', borderTop: '0.5px solid rgba(26,61,43,0.10)', marginBottom: 40 }} />

        <article className="prose-verdix">

          <p>Modern SaaS companies are surrounded by automation.</p>

          <p>Sales teams manage opportunities in CRM platforms. Contracts are signed electronically and stored in contract-management systems. Usage is recorded in product databases. Billing software generates invoices. Payment providers collect money. Accounting platforms record the result.</p>

          <p>Yet many bespoke enterprise agreements still require a spreadsheet and several internal messages before the customer can be billed.</p>

          <p>The apparent contradiction has a simple explanation:</p>

          <blockquote>
            The systems automate individual stages, but the commercial meaning of the agreement still has to be translated between them.
          </blockquote>

          <h2>Every system sees a different version of the customer relationship</h2>

          <p>A typical SaaS finance stack may include five or more systems.</p>

          <div className="system-card">
            <div className="system-label">CRM: what was sold</div>
            <p>The CRM contains the account, opportunity value, products and expected close date. It is optimised for pipeline and sales execution. It may not contain the exact definitions, exclusions and conditions written into the final contract.</p>
          </div>

          <div className="system-card">
            <div className="system-label">Contract management: what was agreed</div>
            <p>The contract repository contains the signed document and perhaps key metadata. It is the strongest legal record, but it does not necessarily create the operational schedule required to bill the customer.</p>
          </div>

          <div className="system-card">
            <div className="system-label">Product systems: what happened</div>
            <p>The product database records transactions, users, API calls, documents or outcomes. It knows what customers did, but it does not inherently know which activity is billable under each customer's negotiated agreement.</p>
          </div>

          <div className="system-card">
            <div className="system-label">Billing platform: what should be charged</div>
            <p>The billing system applies configured prices, quantities and schedules. It can be highly automated once the correct logic has been entered. But it generally relies on someone or another system to provide that logic.</p>
          </div>

          <div className="system-card">
            <div className="system-label">Payment provider: what should be collected</div>
            <p>The payment system processes the invoice or payment instruction it receives. It does not normally determine whether the underlying amount reflects the customer's agreement and qualifying usage.</p>
          </div>

          <div className="system-card">
            <div className="system-label">ERP: what should be recorded</div>
            <p>The ERP records the financial outcome and supports reporting, reconciliation and accounting. By that point, the commercial interpretation has already happened elsewhere.</p>
          </div>

          <h2>The missing layer is operational translation</h2>

          <p>Consider this clause:</p>

          <blockquote>
            The customer pays €20,000 annually plus €0.03 for each eligible API call above five million calls per contract year.
          </blockquote>

          <p>The contract-management platform can store the clause. The product can record API calls. The billing platform can apply a quantity and rate. The payment provider can collect the invoice.</p>

          <p>But someone still needs to determine:</p>

          <ul>
            <li>what constitutes an eligible API call;</li>
            <li>where the data are retrieved;</li>
            <li>how the contract-year period is calculated;</li>
            <li>whether free or test usage is excluded;</li>
            <li>how prior usage is accumulated;</li>
            <li>when the threshold is crossed;</li>
            <li>what should be sent to the billing platform.</li>
          </ul>

          <p>This is the work that often remains manual.</p>

          <h2>Why companies have not solved it through integration alone</h2>

          <p>Traditional integrations move fields between systems. They work well when the commercial model is standard and the data structure is predictable. For example:</p>

          <blockquote>Plan A costs €500 per month and renews every 30 days.</blockquote>

          <p>Bespoke agreements are different. Their meaning may depend on:</p>

          <ul>
            <li>natural-language definitions;</li>
            <li>conditions spread across multiple clauses;</li>
            <li>customer-specific amendments;</li>
            <li>operational terminology;</li>
            <li>cumulative usage;</li>
            <li>milestones;</li>
            <li>exceptions;</li>
            <li>future changes.</li>
          </ul>

          <p>Moving a contract PDF from one platform to another does not create a billing workflow. Moving an invoice total into an ERP does not explain how the amount was calculated.</p>

          <p>The workflow requires interpretation, data mapping and ongoing execution.</p>

          <h2>Manual processes become the integration layer</h2>

          <p>When the systems do not share one operational model, people fill the gap.</p>

          <p>Finance reads the agreement. RevOps enters the schedule. Engineering provides the usage. Billing creates the invoice. Legal clarifies ambiguous terms.</p>

          {/* McKinsey callout */}
          <div style={{ background: '#fff', border: '0.5px solid rgba(26,61,43,0.12)', borderRadius: 12, padding: '20px 22px', margin: '28px 0' }}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.08em', color: '#4A7C59', marginBottom: 10 }}>Industry context</div>
            <p style={{ fontSize: 14, color: '#3A3530', lineHeight: 1.7, margin: 0 }}>
              McKinsey reports that organisations continue to experience recurring manual effort and limited transparency when customised offers do not enter downstream systems automatically. It also notes that attempts to harmonise every system through one large transformation are often expensive and difficult to complete.
            </p>
            <a
              href="https://www.mckinsey.com/capabilities/operations/our-insights/operations-blog/lead-to-cash-the-elephant-in-the-room"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 mt-3 text-xs font-medium hover:underline"
              style={{ color: '#1A3D2B' }}
            >
              Read the McKinsey report
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" /></svg>
            </a>
          </div>

          <p>This explains why the spreadsheet persists. It is flexible enough to represent the exceptions that standard systems were not configured to handle.</p>

          <p>But that flexibility comes with limitations:</p>

          <ul>
            <li>calculations are difficult to reuse;</li>
            <li>knowledge is concentrated in individuals;</li>
            <li>amendments require manual updates;</li>
            <li>approvals are hard to trace;</li>
            <li>recurring work grows with contract volume;</li>
            <li>data lineage is unclear.</li>
          </ul>

          <h2>A billing platform is not always the missing answer</h2>

          <p>A company may respond by replacing its billing infrastructure. That can make sense when it needs:</p>

          <ul>
            <li>high-volume event metering;</li>
            <li>real-time credit balances;</li>
            <li>complex rating at infrastructure scale;</li>
            <li>native invoice lifecycle management;</li>
            <li>collections and revenue recognition.</li>
          </ul>

          <p>But many companies already have billing and payment systems that work adequately once they receive the correct commercial instructions.</p>

          <p>Their primary problem is not that Stripe, the ERP or the payment rail cannot send an invoice. It is that the bespoke agreement and operational data have not been converted into the approved schedule those systems need.</p>

          <p>For those companies, replacing the whole finance stack may be unnecessary.</p>

          <h2>Contract-led orchestration</h2>

          <p>A different approach is to create an agreement-operations layer above the existing systems.</p>

          <p>The layer should understand:</p>

          <ul>
            <li>what the customer agreed to pay;</li>
            <li>which activity determines the charge;</li>
            <li>where the activity data live;</li>
            <li>how the calculation should be performed;</li>
            <li>when the result should be sent downstream;</li>
            <li>which clause supports each line.</li>
          </ul>

          <p>Verdix follows this model. The customer defines the endpoints containing the relevant usage. Verdix interprets the signed agreement, retrieves the required operational data and builds the billing schedule. After review, the approved instructions are sent to the customer's preferred billing platform.</p>

          <p>The same agreement logic can be used in reverse to reconcile partner invoices against contractual rates and operational activity.</p>

          <h2>Automation without replacement</h2>

          <p>The most useful contract-to-cash automation may not be the system that tries to own every financial function. It may be the layer that connects the systems a company already trusts:</p>

          <div style={{ background: '#F0F4EE', border: '0.5px solid #C0DD97', borderRadius: 10, padding: '14px 18px', margin: '20px 0', fontFamily: 'monospace', fontSize: 13, color: '#27500A', lineHeight: 1.8 }}>
            Contract → live usage → approved billing schedule → existing billing and payment infrastructure
          </div>

          <p>This reduces migration risk and allows businesses to select the payment provider, billing system and accounting platform that fit their requirements.</p>

          <p>It is particularly relevant for Nordic and European companies that also need control over data location, contract retention and AI processing.</p>

          <h2>Closing thought</h2>

          <p>Contract-to-cash remains manual not because companies lack software.</p>

          <p>It remains manual because their software understands different fragments of the commercial relationship, while people still carry the meaning from one system to the next.</p>

        </article>

        {/* CTA */}
        <div className="mt-14 rounded-2xl p-8 text-center" style={{ background: '#EAF3DE', border: '0.5px solid #C0DD97' }}>
          <p className="font-medium mb-5" style={{ color: '#1A3D2B', fontSize: 16, lineHeight: 1.6 }}>
            Connect your agreements and usage to the finance stack you already use.
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
        .system-card {
          background: #fff;
          border: 0.5px solid rgba(26,61,43,0.10);
          border-radius: 10px;
          padding: 16px 18px;
          margin: 12px 0;
        }
        .system-card p {
          margin-bottom: 0;
          font-size: 14px;
          color: #4A4540;
        }
        .system-label {
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: .07em;
          color: #1A3D2B;
          margin-bottom: 6px;
        }
      `}</style>

    </div>
  )
}
