import Link from 'next/link'
import { VerdixLogo } from '@/components/VerdixLogo'

export const metadata = {
  title: 'What do you need to launch usage-based pricing? | Verdix',
  description:
    'Usage-based pricing requires more than tracking product activity. Learn how to define billable usage, connect contract terms, calculate charges and integrate with your existing billing stack.',
}

// ── Shared icon primitive ──────────────────────────────────────────────────────

function Ico({ d, size = 16, stroke = 'currentColor' }: { d: string | string[]; size?: number; stroke?: string }) {
  const paths = Array.isArray(d) ? d : [d]
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke}
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      {paths.map((p, i) => <path key={i} d={p} />)}
    </svg>
  )
}

// ── Icon paths ─────────────────────────────────────────────────────────────────

const ICONS = {
  doc:       'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8L14 2z M14 2v6h6 M16 13H8 M16 17H8',
  gauge:     'M12 2a10 10 0 100 20A10 10 0 0012 2z M12 12l-3.5-3.5 M12 7v1 M7 12H6 M17 12h1 M9.2 9.2l-.7-.7 M15.5 8.5l.7-.7',
  refresh:   'M1 4v6h6 M23 20v-6h-6 M20.49 9A9 9 0 005.64 5.64L1 10 M23 14l-4.64 4.36A9 9 0 013.51 15',
  lightning: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
  link:      'M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71 M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71',
  tag:       'M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z M7 7h.01',
  calendar:  'M8 2v4 M16 2v4 M3 10h18 M5 4h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z',
  check:     'M22 11.08V12a10 10 0 11-5.93-9.14 M22 4L12 14.01l-3-3',
  receipt:   'M19 21l-3.5-2-3.5 2-3.5-2L5 21V3h14v18z M9 9h6 M9 13h4',
  card:      'M3 10h18 M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z',
  book:      'M12 6.253v13 M12 6.253C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253 M12 6.253C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253',
  upload:    'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4 M17 8l-5-5-5 5 M12 3v12',
  download:  'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4 M7 10l5 5 5-5 M12 15V3',
  table:     'M3 3h18v4H3z M3 7h18v4H3z M3 11h18v4H3z M3 15h18v4H3z',
}

// ── Architecture Diagram ───────────────────────────────────────────────────────

function IconBox({ id, color, bg, size = 32 }: { id: keyof typeof ICONS; color: string; bg: string; size?: number }) {
  return (
    <div style={{ width: size, height: size, borderRadius: 9, background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      <Ico d={ICONS[id]} stroke={color} size={size === 32 ? 15 : 13} />
    </div>
  )
}

function InputRow({ id, label, desc }: { id: keyof typeof ICONS; label: string; desc: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '0.5px solid rgba(26,61,43,0.07)' }} className="arch-last-no-border">
      <IconBox id={id} color="#4A7C59" bg="rgba(26,61,43,0.07)" />
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 500, color: '#2C2520', lineHeight: 1.3 }}>{label}</div>
        <div style={{ fontSize: 11, color: '#9A9490', marginTop: 1 }}>{desc}</div>
      </div>
    </div>
  )
}

function OutputRow({ id, label, desc }: { id: keyof typeof ICONS; label: string; desc: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '0.5px solid rgba(74,124,89,0.12)' }} className="arch-last-no-border">
      <IconBox id={id} color="#C4E0B2" bg="rgba(255,255,255,0.12)" />
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 500, color: '#EAF3DE', lineHeight: 1.3 }}>{label}</div>
        <div style={{ fontSize: 11, color: '#7AAF87', marginTop: 1 }}>{desc}</div>
      </div>
    </div>
  )
}

function ProcessStep({ n, label }: { n: number; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 0', borderBottom: '0.5px solid rgba(255,255,255,0.08)' }} className="arch-last-no-border">
      <div style={{ width: 22, height: 22, borderRadius: 6, background: 'rgba(255,255,255,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#C4E0B2' }}>{n}</span>
      </div>
      <span style={{ fontSize: 12.5, color: '#EAF3DE', lineHeight: 1.3 }}>{label}</span>
    </div>
  )
}

function ArrowCol() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px' }}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="rgba(26,61,43,0.2)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 12h14M12 5l7 7-7 7" />
      </svg>
    </div>
  )
}

function ArchitectureDiagram() {
  return (
    <div style={{ margin: '36px -4px' }}>
      {/* Header */}
      <div style={{ borderRadius: '14px 14px 0 0', padding: '11px 20px', background: '#F5F3EE', border: '0.5px solid rgba(26,61,43,0.13)', borderBottom: 'none' }}>
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#4A7C59' }}>
          Usage-based billing architecture
        </span>
      </div>

      {/* 3-column grid */}
      <div className="arch-grid" style={{ border: '0.5px solid rgba(26,61,43,0.13)', borderRadius: '0 0 14px 14px', overflow: 'hidden' }}>

        {/* LEFT — inputs */}
        <div style={{ padding: '20px 18px', background: '#fff' }}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#9A9490', marginBottom: 14 }}>Inputs</div>
          <InputRow id="doc"     label="Signed contract"    desc="Terms, rates, thresholds" />
          <InputRow id="gauge"   label="Operational data"   desc="API, database, warehouse" />
          <InputRow id="refresh" label="Amendments"         desc="Rate changes, renewals" />
        </div>

        {/* ARROW */}
        <ArrowCol />

        {/* CENTER — Verdix */}
        <div style={{ padding: '20px 18px', background: '#1A3D2B' }}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#4A7C59', marginBottom: 2 }}>Agreement operations</div>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#EAF3DE', marginBottom: 14 }}>Verdix</div>
          <ProcessStep n={1} label="Extract obligations" />
          <ProcessStep n={2} label="Map to usage source" />
          <ProcessStep n={3} label="Apply pricing logic" />
          <ProcessStep n={4} label="Build billing schedule" />
          <ProcessStep n={5} label="Review &amp; approve" />
        </div>

        {/* ARROW */}
        <ArrowCol />

        {/* RIGHT — outputs */}
        <div style={{ padding: '20px 18px', background: '#1A3D2B' }}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#4A7C59', marginBottom: 14 }}>Outputs</div>
          <OutputRow id="receipt" label="Billing platform"  desc="Stripe, Chargebee, custom" />
          <OutputRow id="card"    label="Payments"          desc="Direct debit, cards, transfers" />
          <OutputRow id="book"    label="ERP &amp; accounting" desc="Records, reconciliation" />
        </div>

      </div>
    </div>
  )
}

// ── Data-source comparison diagram ────────────────────────────────────────────

function DataSourceDiagram() {
  const methods = [
    {
      id:      'push',
      icon:    'upload' as keyof typeof ICONS,
      label:   'Event push',
      tag:     'Real-time',
      desc:    'App continuously sends raw usage events to a metering platform.',
      detail:  'Best for high-volume products, real-time balances and entitlement enforcement.',
      verdix:  false,
    },
    {
      id:      'pull',
      icon:    'download' as keyof typeof ICONS,
      label:   'Endpoint pull',
      tag:     'Verdix approach',
      desc:    'Billing workflow retrieves usage from an existing customer-defined API.',
      detail:  'Works well for periodic billing when the source system already has reliable records.',
      verdix:  true,
    },
    {
      id:      'file',
      icon:    'table' as keyof typeof ICONS,
      label:   'File upload',
      tag:     'Manual',
      desc:    'Finance uploads usage through a CSV or spreadsheet each billing period.',
      detail:  'Useful for early testing, but creates recurring manual work and reconciliation risk.',
      verdix:  false,
    },
  ]

  return (
    <div style={{ margin: '24px -4px', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }} className="source-grid">
      {methods.map(m => (
        <div key={m.id} style={{
          borderRadius: 12,
          padding: '16px',
          background: m.verdix ? '#EAF3DE' : '#F8F6F1',
          border: `0.5px solid ${m.verdix ? '#C0DD97' : 'rgba(26,61,43,0.1)'}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{
              width: 32, height: 32, borderRadius: 9,
              background: m.verdix ? '#1A3D2B' : 'rgba(26,61,43,0.08)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Ico d={ICONS[m.icon]} stroke={m.verdix ? '#C4E0B2' : '#4A7C59'} size={15} />
            </div>
            <span style={{
              fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.06em',
              color: m.verdix ? '#1A3D2B' : '#9A9490',
              background: m.verdix ? '#C4E0B2' : 'rgba(26,61,43,0.08)',
              padding: '3px 7px', borderRadius: 5,
            }}>{m.tag}</span>
          </div>
          <div style={{ fontSize: 13, fontWeight: 600, color: m.verdix ? '#1A3D2B' : '#2C2520', marginBottom: 4 }}>{m.label}</div>
          <div style={{ fontSize: 12, color: m.verdix ? '#3A6B48' : '#7A7470', lineHeight: 1.5, marginBottom: 8 }}>{m.desc}</div>
          <div style={{ fontSize: 11, color: m.verdix ? '#4A7C59' : '#9A9490', lineHeight: 1.5 }}>{m.detail}</div>
        </div>
      ))}
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
            <span className="text-xs text-stone">July 2026</span>
          </div>
          <h1 className="font-display font-light text-ink leading-tight mb-5" style={{ fontSize: 'clamp(1.8rem,3.5vw,2.6rem)' }}>
            What do you need to launch usage-based pricing?
          </h1>
          <p className="text-stone leading-relaxed" style={{ fontSize: 16 }}>
            Usage-based pricing requires more than tracking product activity. Here is what a complete workflow actually requires — from defining billable usage to integrating with your existing billing stack.
          </p>
        </div>

        <hr style={{ border: 'none', borderTop: '0.5px solid rgba(26,61,43,0.10)', marginBottom: 40 }} />

        {/* Article */}
        <article className="prose-verdix">

          <p>Launching usage-based pricing can align customer cost with the value they receive. But it requires more than deciding to charge per API call, transaction, user or document.</p>

          <p>A working usage-based billing process must connect three things:</p>

          <ul>
            <li>the commercial agreement — what the customer agreed to pay;</li>
            <li>operational data — what the customer actually used;</li>
            <li>billing infrastructure — where the approved charge is invoiced and collected.</li>
          </ul>

          <p>For a standard self-service plan, this may be relatively simple. For negotiated enterprise contracts, each customer may have different rates, thresholds, commitments and exclusions. Here are the main components required.</p>

          <ArchitectureDiagram />

          <h2>1. Choose the right value metric</h2>

          <p>The billable metric should reflect the value delivered to the customer.</p>

          <p>Common examples include:</p>

          <ul>
            <li>API calls;</li>
            <li>AI tokens;</li>
            <li>completed transactions;</li>
            <li>active users;</li>
            <li>documents processed;</li>
            <li>compute hours;</li>
            <li>completed workflows;</li>
            <li>successful outcomes.</li>
          </ul>

          <p>A metric should be understandable to the customer, measurable in the product and reliable enough to support an invoice. A technically available metric is not always a commercially useful one. Charging for every system event may be easy to measure but difficult for the customer to understand or predict.</p>

          <h2>2. Define exactly what counts as billable</h2>

          <p>A contract may state:</p>

          <blockquote>
            €0.04 per successfully completed transaction above 100,000 transactions per month.
          </blockquote>

          <p>That still leaves several operational questions:</p>

          <ul>
            <li>What status means &ldquo;successfully completed&rdquo;?</li>
            <li>Are refunds and reversals excluded?</li>
            <li>Do internal test transactions count?</li>
            <li>Which timestamp determines the billing month?</li>
            <li>How is usage attributed to the correct customer?</li>
            <li>What happens when records are corrected later?</li>
          </ul>

          <p>These definitions must be documented before the first invoice is generated. The output should be a clear connection between the contract clause and the operational data used to calculate the charge.</p>

          <h2>3. Identify the source of usage data</h2>

          <p>The required activity may already exist in the product database, a data warehouse, an internal API, a transaction platform, an analytics system or a third-party operational platform. There are three common ways to move this data into a billing workflow.</p>

          <DataSourceDiagram />

          <h2>4. Connect usage with the commercial terms</h2>

          <p>Measured usage alone does not determine what the customer owes. The billing logic may also include:</p>

          <ul>
            <li>included usage;</li>
            <li>volume or graduated tiers;</li>
            <li>minimum commitments;</li>
            <li>prepaid credits;</li>
            <li>caps;</li>
            <li>temporary discounts;</li>
            <li>customer-specific rates;</li>
            <li>annual increases;</li>
            <li>regional pricing;</li>
            <li>contract amendments.</li>
          </ul>

          <p>For example, a customer may use 175,000 units, but the first 100,000 may be included and the remaining units may fall into two different pricing tiers. This is the rating step: converting measured activity into a financial amount using the applicable agreement.</p>

          <h2>5. Build the billing schedule</h2>

          <p>The billing schedule determines:</p>

          <ul>
            <li>which charges are recurring or one-time;</li>
            <li>whether usage is billed in advance or arrears;</li>
            <li>the start and end of each billing period;</li>
            <li>when an invoice should be created;</li>
            <li>when discounts or pricing phases change;</li>
            <li>how amendments affect future billing.</li>
          </ul>

          <p>For bespoke agreements, the schedule should be derived from the final signed contract — not only from a CRM summary or an earlier quote. The schedule should also remain linked to the supporting clauses so Finance can review how each amount was calculated.</p>

          <h2>6. Choose where billing and payment will happen</h2>

          <p>Launching usage-based pricing does not always require replacing the existing finance stack. A business may already use Stripe, an ERP, an invoicing platform, a local accounting system, a payment provider or an internal billing solution.</p>

          <p>The key question is whether the current platform can receive the approved quantity, rate and schedule.</p>

          <p>Some companies need a full metering and billing engine. Others mainly need a reliable way to translate contracts and operational usage into instructions for systems they already use.</p>

          <div style={{ background: '#F0F4EE', border: '0.5px solid #C0DD97', borderRadius: 10, padding: '14px 18px', margin: '20px 0', fontFamily: 'monospace', fontSize: 13, color: '#27500A', lineHeight: 1.8 }}>
            Verdix generates the approved billing schedule and sends it to the customer&apos;s preferred billing infrastructure.
          </div>

          <h2>7. Add review and approval controls</h2>

          <p>Automated billing should not mean removing financial oversight. Before a new agreement goes live, Finance or RevOps should be able to review:</p>

          <ul>
            <li>extracted contract terms;</li>
            <li>billable metric definitions;</li>
            <li>data-source mappings;</li>
            <li>discounts and thresholds;</li>
            <li>the calculated billing schedule;</li>
            <li>the destination billing system.</li>
          </ul>

          <p>Non-standard terms and uncertain interpretations should be flagged rather than silently applied. A good workflow follows:</p>

          <div style={{ background: '#F0F4EE', border: '0.5px solid #C0DD97', borderRadius: 10, padding: '14px 18px', margin: '20px 0', fontFamily: 'monospace', fontSize: 13, color: '#27500A', lineHeight: 1.8 }}>
            Extract → map → calculate → review → approve → send
          </div>

          <h2>8. Prepare for changes</h2>

          <p>Usage-based agreements rarely remain static. Companies must handle:</p>

          <ul>
            <li>contract amendments;</li>
            <li>additional products;</li>
            <li>rate changes;</li>
            <li>discount expiries;</li>
            <li>annual escalators;</li>
            <li>renewals;</li>
            <li>corrected usage;</li>
            <li>late-arriving operational data.</li>
          </ul>

          <p>The billing workflow should preserve the effective date of each change and make clear which contract version applies to each billing period. Without this, the company may have to reconstruct its calculations through old spreadsheets, emails and invoices.</p>

          <h2>9. Make every charge traceable</h2>

          <p>Customers may ask why an invoice changed or how a usage charge was calculated. Finance should be able to show a clear line from contract clause to invoice instruction:</p>

          <div style={{ background: '#F0F4EE', border: '0.5px solid #C0DD97', borderRadius: 10, padding: '14px 18px', margin: '20px 0', fontFamily: 'monospace', fontSize: 13, color: '#27500A', lineHeight: 1.8 }}>
            Contract clause → source data → qualifying usage → pricing rule → invoice instruction
          </div>

          <p>This traceability reduces review time and makes billing questions easier to resolve.</p>

          <h2>Where Verdix fits</h2>

          <p>Verdix is designed for B2B companies with bespoke customer agreements that want to automate usage-linked billing without replacing their existing billing or payment infrastructure.</p>

          <p>Verdix:</p>

          <ul>
            <li>interprets the signed agreement;</li>
            <li>identifies its billing obligations;</li>
            <li>pulls usage from customer-defined endpoints;</li>
            <li>applies the relevant pricing logic;</li>
            <li>creates the billing schedule;</li>
            <li>routes it for approval;</li>
            <li>sends the approved instructions to the preferred billing platform.</li>
          </ul>

          <p>The same agreement-to-data approach is used to validate incoming partner invoices before payment or dispute.</p>

          <h2>The takeaway</h2>

          <p>Usage-based pricing requires more than a meter.</p>

          <p>A complete workflow must connect the commercial agreement, product activity, pricing rules, billing schedule and downstream finance systems.</p>

          <p>Before adopting new infrastructure, determine where the real gap lies. You may need a real-time metering engine — or you may need an agreement-operations layer that turns existing usage data into approved billing instructions.</p>

        </article>

        {/* CTA */}
        <div className="mt-14 rounded-2xl p-8 text-center" style={{ background: '#EAF3DE', border: '0.5px solid #C0DD97' }}>
          <p className="font-medium mb-5" style={{ color: '#1A3D2B', fontSize: 16, lineHeight: 1.6 }}>
            Turn bespoke pricing and live usage into approved billing workflows — without replacing your existing finance stack.
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
        /* Architecture diagram */
        .arch-grid {
          display: grid;
          grid-template-columns: 1fr 28px 1fr 28px 1fr;
        }
        .arch-last-no-border:last-child {
          border-bottom: none !important;
        }
        /* Data source grid */
        .source-grid {
          grid-template-columns: 1fr 1fr 1fr;
        }
        @media (max-width: 600px) {
          .arch-grid {
            grid-template-columns: 1fr;
          }
          .arch-grid > *:nth-child(2),
          .arch-grid > *:nth-child(4) {
            display: none;
          }
          .source-grid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>

    </div>
  )
}
