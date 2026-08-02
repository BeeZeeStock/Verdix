import Link from 'next/link'
import { VerdixLogo } from '@/components/VerdixLogo'

export const metadata = {
  title: 'Why bespoke enterprise contracts are still difficult to bill | Verdix',
  description:
    'Bespoke SaaS contracts enable flexible enterprise deals, but they create complex billing work across Finance, RevOps and Product. Here is why.',
}

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
            <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#4A7C59' }}>Product · Finance operations</span>
            <span className="text-stone/40">·</span>
            <span className="text-xs text-stone">July 2026</span>
          </div>
          <h1 className="font-display font-light text-ink leading-tight mb-5" style={{ fontSize: 'clamp(1.8rem,3.5vw,2.6rem)' }}>
            Why bespoke enterprise contracts are still difficult to bill
          </h1>
          <p className="text-stone leading-relaxed" style={{ fontSize: 16 }}>
            Bespoke SaaS contracts enable flexible enterprise deals, but they create complex billing work across Finance, RevOps and Product. Here is why.
          </p>
        </div>

        <hr style={{ border: 'none', borderTop: '0.5px solid rgba(26,61,43,0.10)', marginBottom: 40 }} />

        {/* Article body */}
        <article className="prose-verdix">

          <p>Modern B2B companies increasingly compete through commercial flexibility.</p>

          <p>One customer may pay a fixed annual platform fee. Another may pay according to API calls, transactions or active users. A third may negotiate a minimum commitment, discounted ramp period, regional rates and a separate implementation fee.</p>

          <p>That flexibility helps Sales close enterprise deals. But after the contract is signed, someone still has to convert the negotiated language into a billing process that works every month.</p>

          <p>This is where a commercially successful deal can become an operational burden.</p>

          <h2>A contract is written for people—not billing systems</h2>

          <p>A signed agreement is usually designed to establish legal rights and obligations. It may describe pricing across several clauses, schedules, order forms and amendments.</p>

          <p>A billing system requires something different. It needs structured instructions such as:</p>

          <ul>
            <li>what should be charged;</li>
            <li>when billing should begin;</li>
            <li>whether charges are in advance or arrears;</li>
            <li>which usage qualifies;</li>
            <li>how usage should be aggregated;</li>
            <li>when discounts expire;</li>
            <li>how thresholds and commitments apply;</li>
            <li>which system provides the required data.</li>
          </ul>

          <p>The contract may state:</p>

          <blockquote>
            The customer will pay €0.05 for each successfully completed transaction above 100,000 transactions per calendar month.
          </blockquote>

          <p>Before that clause can become an invoice, the company must determine what "successfully completed" means inside its product data, which records belong to the customer, how refunds are treated and what happens when transactions arrive after the billing period has closed.</p>

          <p>Extracting the price is only the first step. The harder task is turning the commercial language into an operational billing definition.</p>

          <h2>Bespoke terms create recurring work</h2>

          <p>The difficulty is not limited to setting up the agreement once.</p>

          <p>Every billing period may require Finance or RevOps to:</p>

          <ul>
            <li>retrieve the correct usage;</li>
            <li>check whether thresholds have been met;</li>
            <li>apply the relevant price or discount;</li>
            <li>confirm that commitments, caps or credits have been handled correctly;</li>
            <li>prepare the billing schedule or invoice instructions;</li>
            <li>send the approved amount to the billing or invoicing platform.</li>
          </ul>

          <p>Amendments make the process harder. A renewal might introduce a new rate. An additional product may begin halfway through the month. A temporary discount may expire. A minimum commitment may increase in year two.</p>

          <p>When these changes are managed through documents, spreadsheets and internal messages, the company becomes dependent on people remembering what changed and when it should take effect.</p>

          <h2>The required data usually lives somewhere else</h2>

          <p>The agreement defines what should be billed, but the information needed to calculate it normally resides in the company's SaaS platform, product database, data warehouse or operational API.</p>

          <p>This creates a second translation challenge:</p>

          <div style={{ background: '#F0F4EE', border: '0.5px solid #C0DD97', borderRadius: 10, padding: '14px 18px', margin: '20px 0', fontFamily: 'monospace', fontSize: 13, color: '#27500A', lineHeight: 1.8 }}>
            Contract language → billable metric → source-system data
          </div>

          <p>For example, a contract may refer to:</p>

          <ul>
            <li>active users;</li>
            <li>successful transactions;</li>
            <li>processed documents;</li>
            <li>completed deliveries;</li>
            <li>API requests;</li>
            <li>generated reports;</li>
            <li>achieved outcomes.</li>
          </ul>

          <p>The source system may use entirely different field names and status codes. Product and engineering teams are therefore often asked to explain the data, create exports or build a usage pipeline before Finance can issue the invoice.</p>

          {/* McKinsey callout */}
          <div style={{ background: '#fff', border: '0.5px solid rgba(26,61,43,0.12)', borderRadius: 12, padding: '20px 22px', margin: '28px 0' }}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.08em', color: '#4A7C59', marginBottom: 10 }}>Industry context</div>
            <p style={{ fontSize: 14, color: '#3A3530', lineHeight: 1.7, margin: 0 }}>
              McKinsey notes that quote-to-cash complexity requires coordination among Sales, Pricing, Finance, Legal, Operations and Customer Success. In one subscription-business case, moving a quote to an invoice involved roughly 200 emails because orders and invoices could not be processed through a consistent workflow.
            </p>
            <a
              href="https://www.mckinsey.com/industries/technology-media-and-telecommunications/our-insights/how-quote-to-cash-excellence-can-fuel-growth-for-b2b-subscription-businesses"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 mt-3 text-xs font-medium hover:underline"
              style={{ color: '#1A3D2B' }}
            >
              Read the McKinsey report
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" /></svg>
            </a>
          </div>

          <h2>More systems do not necessarily remove the manual work</h2>

          <p>Most growing companies already have systems for different parts of the process:</p>

          <ul>
            <li>CRM for the opportunity and customer;</li>
            <li>contract management for the signed agreement;</li>
            <li>product systems for usage;</li>
            <li>billing software for calculating or generating charges;</li>
            <li>payment providers for collecting money;</li>
            <li>ERP software for accounting.</li>
          </ul>

          <p>Each system may perform its own function effectively. The missing step is often the operational translation between them.</p>

          <p>The CRM may contain a high-level deal summary but not every contractual condition. The contract repository stores the signed document but does not calculate the bill. The billing platform can execute configured pricing, but somebody must first tell it what the agreement means. The payment provider collects the amount it receives but does not determine whether that amount was contractually correct.</p>

          <p>The workflow remains manual because people are still connecting the systems.</p>

          <h2>A better contract-to-billing model</h2>

          <p>A more scalable process begins with the signed agreement as the commercial source of truth.</p>

          <p>The workflow should:</p>

          <ul>
            <li>extract the pricing and billing obligations;</li>
            <li>identify the usage or operational data required;</li>
            <li>map each obligation to the appropriate data source;</li>
            <li>retrieve the data automatically;</li>
            <li>calculate the billing schedule;</li>
            <li>present the result for approval;</li>
            <li>send the approved instructions to the company's chosen billing platform.</li>
          </ul>

          <p>This does not necessarily require replacing Stripe, an ERP or an existing invoicing system. It requires an operating layer that translates the agreement into instructions those systems can execute.</p>

          <h2>How Verdix approaches the problem</h2>

          <p>Verdix interprets bespoke customer agreements, identifies their billing obligations and retrieves the required usage from customer-defined endpoints.</p>

          <p>It then generates the billing schedule for review and sends the approved instructions to the customer's preferred billing infrastructure.</p>

          <p>The objective is not to become another payment rail or general-purpose billing engine. It is to remove the recurring manual work between the signed agreement, live operational data and the systems that generate and collect the invoice.</p>

          <p>Because the same challenge also exists on the cost side, Verdix applies the agreement-to-data model to partner invoices: determining what should be paid and highlighting discrepancies before approval.</p>

          <h2>Closing thought</h2>

          <p>Flexible pricing should help a company sell—not create a new manual process every time an enterprise customer signs.</p>

          <p>The next generation of contract-to-cash operations will not simply store contracts or generate invoices. It will connect the commercial agreement directly to the data and workflows required to execute it.</p>

        </article>

        {/* CTA */}
        <div className="mt-14 rounded-2xl p-8 text-center" style={{ background: '#EAF3DE', border: '0.5px solid #C0DD97' }}>
          <p className="font-medium mb-5" style={{ color: '#1A3D2B', fontSize: 16, lineHeight: 1.6 }}>
            See how Verdix turns a signed agreement into an approved billing schedule.
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
          padding-left: 0;
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
      `}</style>

    </div>
  )
}
