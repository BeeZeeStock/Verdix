import Link from 'next/link'
import { VerdixLogo } from '@/components/VerdixLogo'
import { isSelfServiceSignupEnabled } from '@/lib/feature-flags'

export const metadata = {
  title: 'GDPR compliance, EU data residency and digital sovereignty are not the same thing | Verdix',
  description:
    'Understand the difference between GDPR compliance, EU data residency, pseudonymisation and digital sovereignty when choosing AI and billing infrastructure.',
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

// ── Diagram 1: Four-concept comparison cards (2×2) ────────────────────────────

const CONCEPTS = [
  {
    id:          'gdpr',
    label:       'GDPR compliance',
    tag:         'Lawfulness',
    icon:        'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
    headerBg:    '#1A3D2B',
    headerText:  '#EAF3DE',
    tagBg:       'rgba(255,255,255,0.12)',
    tagText:     '#C4E0B2',
    traits: [
      { k: 'Answers',     v: '"Is data processed lawfully?"'            },
      { k: 'Covers',      v: 'Collection, use, security, retention'      },
      { k: 'Does not cover', v: 'Where data is physically stored'        },
      { k: 'Check',       v: 'Data Processing Agreement'                 },
      { k: 'Responsible', v: 'Controller and processor together'         },
    ],
  },
  {
    id:          'residency',
    label:       'EU data residency',
    tag:         'Location',
    icon:        'M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z M12 7a3 3 0 110 6 3 3 0 010-6z',
    headerBg:    '#1F7A4A',
    headerText:  '#EAF3DE',
    tagBg:       'rgba(255,255,255,0.12)',
    tagText:     '#C4E0B2',
    traits: [
      { k: 'Answers',     v: '"Where is the data stored?"'               },
      { k: 'Covers',      v: 'Database, backups, logs, AI processing'    },
      { k: 'Does not cover', v: 'Legal processing obligations'           },
      { k: 'Check',       v: 'Subprocessor and region documentation'     },
      { k: 'Responsible', v: 'Vendor infrastructure configuration'       },
    ],
  },
  {
    id:          'pseudonymisation',
    label:       'Pseudonymisation',
    tag:         'Masking',
    icon:        'M22 3H2l8 9.46V19l4 2v-8.54L22 3z',
    headerBg:    '#4A7C59',
    headerText:  '#EAF3DE',
    tagBg:       'rgba(255,255,255,0.15)',
    tagText:     '#EAF3DE',
    traits: [
      { k: 'Answers',     v: '"Have direct identifiers been masked?"'    },
      { k: 'Covers',      v: 'Names, emails, signatures, phone numbers'  },
      { k: 'Does not cover', v: 'Full anonymisation under GDPR'          },
      { k: 'Check',       v: 'Processing architecture documentation'     },
      { k: 'Responsible', v: 'Vendor technical pipeline'                 },
    ],
  },
  {
    id:          'sovereignty',
    label:       'Digital sovereignty',
    tag:         'Control',
    icon:        'M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.78 7.78 5.5 5.5 0 017.78-7.78m1.06-1.06L21 2',
    headerBg:    '#3DAA7F',
    headerText:  '#fff',
    tagBg:       'rgba(255,255,255,0.2)',
    tagText:     '#1A3D2B',
    traits: [
      { k: 'Answers',     v: '"Who ultimately controls the system?"'     },
      { k: 'Covers',      v: 'Infrastructure, keys, jurisdiction, access'},
      { k: 'Does not cover', v: 'Compliance or residency alone'          },
      { k: 'Check',       v: 'Ownership, subprocessors, exit terms'      },
      { k: 'Responsible', v: 'Organisation procurement assessment'       },
    ],
  },
]

function ConceptCards() {
  return (
    <div style={{ margin: '32px -4px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }} className="approach-grid">
      {CONCEPTS.map(c => (
        <div key={c.id} style={{ borderRadius: 13, overflow: 'hidden', border: '0.5px solid rgba(26,61,43,0.12)' }}>
          {/* Header */}
          <div style={{ padding: '14px 15px 12px', background: c.headerBg }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
              <div style={{ width: 30, height: 30, borderRadius: 8, background: 'rgba(255,255,255,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Ico d={c.icon} stroke={c.headerText} size={14} />
              </div>
              <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.07em', background: c.tagBg, color: c.tagText, padding: '3px 7px', borderRadius: 5, flexShrink: 0, marginTop: 2 }}>
                {c.tag}
              </span>
            </div>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: c.headerText }}>{c.label}</div>
          </div>

          {/* Traits */}
          <div style={{ background: '#fff' }}>
            {c.traits.map((t, i) => (
              <div key={i} style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                padding: '8px 14px',
                gap: 8,
                borderBottom: i < c.traits.length - 1 ? '0.5px solid rgba(26,61,43,0.07)' : 'none',
                background: i === c.traits.length - 1 ? '#FAFAF8' : 'transparent',
              }}>
                <span style={{ fontSize: 11, color: '#9A9490', flexShrink: 0 }}>{t.k}</span>
                <span style={{ fontSize: 11, fontWeight: i === c.traits.length - 1 ? 500 : 400, color: '#3A3530', textAlign: 'right' as const }}>{t.v}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Diagram 2: Pseudonymisation before / after ─────────────────────────────────

const MASKING_ROWS = [
  { original: 'Anna Svensson',                   masked: 'cust-contact-01'  },
  { original: 'anna.svensson@company.se',        masked: 'ref_0281@masked'  },
  { original: '+46 70 123 4567',                 masked: '[REDACTED]'       },
  { original: 'Signature: [image present]',      masked: '[REMOVED]'        },
  { original: 'SE556789-0123 (org. number)',      masked: '[MASKED]'         },
]

function MaskingDiagram() {
  return (
    <div style={{ margin: '28px -4px', borderRadius: 14, overflow: 'hidden', border: '0.5px solid rgba(26,61,43,0.13)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 36px 1fr' }}>

        {/* Column headers */}
        <div style={{ padding: '10px 18px', background: '#F5F3EE', borderBottom: '0.5px solid rgba(26,61,43,0.1)' }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#9A9490' }}>Original contract data</span>
        </div>
        <div style={{ background: '#F5F3EE', borderBottom: '0.5px solid rgba(26,61,43,0.1)' }} />
        <div style={{ padding: '10px 18px', background: '#1A3D2B', borderBottom: '0.5px solid rgba(255,255,255,0.08)' }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#4A7C59' }}>After local masking</span>
        </div>

        {/* Rows */}
        {MASKING_ROWS.map((r, i) => {
          const isLast    = i === MASKING_ROWS.length - 1
          const rowBorder = isLast ? 'none' : '0.5px solid rgba(26,61,43,0.07)'
          return (
            <div key={i} style={{ display: 'contents' }}>
              <div style={{ padding: '10px 18px', background: '#fff', borderBottom: rowBorder, display: 'flex', alignItems: 'center' }}>
                <span style={{ fontSize: 13, color: '#3A3530', fontStyle: 'italic' }}>&ldquo;{r.original}&rdquo;</span>
              </div>
              <div style={{ background: '#F5F3EE', borderBottom: rowBorder, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Ico d="M5 12h14M12 5l7 7-7 7" stroke="rgba(26,61,43,0.3)" />
              </div>
              <div style={{ padding: '10px 18px', background: '#1C4432', borderBottom: isLast ? 'none' : '0.5px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center' }}>
                <code style={{ fontSize: 12, color: '#52C48A', fontFamily: 'monospace', lineHeight: 1.4 }}>{r.masked}</code>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Diagram 3: Buyer evaluation table ─────────────────────────────────────────

const EVAL_ROWS = [
  { area: 'Data collection',         question: 'Is the platform processing only the information it needs?' },
  { area: 'Residency',               question: 'Where are contracts, metadata, logs and backups stored?' },
  { area: 'AI processing',           question: 'Which model provider receives the content, and in which region?' },
  { area: 'International transfers', question: 'Which legal mechanism and safeguards apply?' },
  { area: 'Control',                 question: 'Who can access the data, keys and underlying infrastructure?' },
]

function EvaluationTable() {
  return (
    <div style={{ margin: '28px -4px', borderRadius: 14, overflow: 'hidden', border: '0.5px solid rgba(26,61,43,0.13)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr' }}>

        {/* Column headers */}
        <div style={{ padding: '10px 18px', background: '#F5F3EE', borderBottom: '0.5px solid rgba(26,61,43,0.1)', borderRight: '0.5px solid rgba(26,61,43,0.08)' }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#4A7C59' }}>Area</span>
        </div>
        <div style={{ padding: '10px 18px', background: '#F5F3EE', borderBottom: '0.5px solid rgba(26,61,43,0.1)' }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.1em', color: '#4A7C59' }}>Key question</span>
        </div>

        {/* Data rows */}
        {EVAL_ROWS.map((r, i) => {
          const isLast    = i === EVAL_ROWS.length - 1
          const even      = i % 2 === 0
          const rowBorder = isLast ? 'none' : '0.5px solid rgba(26,61,43,0.07)'
          const cellBg    = even ? '#FAFAF8' : '#fff'
          return (
            <div key={i} style={{ display: 'contents' }}>
              <div style={{ padding: '11px 18px', background: cellBg, borderBottom: rowBorder, borderRight: '0.5px solid rgba(26,61,43,0.07)', display: 'flex', alignItems: 'center' }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: '#1A3D2B' }}>{r.area}</span>
              </div>
              <div style={{ padding: '11px 18px', background: cellBg, borderBottom: rowBorder, display: 'flex', alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: '#3A3530', lineHeight: 1.4 }}>{r.question}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────────

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
            <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#4A7C59' }}>Privacy · Finance operations</span>
            <span className="text-stone/40">·</span>
            <span className="text-xs text-stone">August 2026</span>
          </div>
          <h1 className="font-display font-light text-ink leading-tight mb-5" style={{ fontSize: 'clamp(1.8rem,3.5vw,2.6rem)' }}>
            GDPR compliance, EU data residency and digital sovereignty are not the same thing
          </h1>
          <p className="text-stone leading-relaxed" style={{ fontSize: 16 }}>
            Location is only one part of data protection. Understanding the difference between these four concepts is essential when choosing AI and billing infrastructure.
          </p>
        </div>

        <hr style={{ border: 'none', borderTop: '0.5px solid rgba(26,61,43,0.10)', marginBottom: 40 }} />

        <article className="prose-verdix">

          <h2>Location is only one part of data protection</h2>

          <p>Contracts can contain names, email addresses, signatures, commercial terms, bank details and other confidential information.</p>

          <p>When AI is used to interpret those contracts, buyers often ask:</p>

          <ul>
            <li>Is the platform GDPR compliant?</li>
            <li>Is the data stored in Europe?</li>
            <li>Is the provider European?</li>
            <li>Can a foreign authority access the data?</li>
            <li>Is the information used to train AI models?</li>
          </ul>

          <p>These questions are related, but they are not interchangeable. A platform may store data in the EU without providing complete digital sovereignty. A US provider may process European data lawfully. A European provider may still rely on non-European infrastructure or subprocessors.</p>

          <ConceptCards />

          <h2>GDPR compliance</h2>

          <p>GDPR compliance concerns how personal data is collected, used, secured, retained and shared.</p>

          <p>Important principles include:</p>

          <ul>
            <li>lawfulness and transparency;</li>
            <li>purpose limitation;</li>
            <li>data minimisation;</li>
            <li>accuracy;</li>
            <li>limited retention;</li>
            <li>integrity and confidentiality;</li>
            <li>accountability.</li>
          </ul>

          <p>The <a href="https://www.edpb.europa.eu/topics/key-gdpr-concepts/basic-principles_en" target="_blank" rel="noopener noreferrer">European Data Protection Board</a> describes data minimisation as limiting personal data to what is adequate, relevant and necessary for the stated purpose.</p>

          <p>For contract-processing software, relevant questions include:</p>

          <ul>
            <li>What personal information is required?</li>
            <li>What is the lawful basis for processing it?</li>
            <li>How long is it retained?</li>
            <li>Which subprocessors receive it?</li>
            <li>Is it used for model training?</li>
            <li>Can it be deleted or exported?</li>
            <li>What security controls protect it?</li>
          </ul>

          <p>GDPR compliance is therefore a continuing operational responsibility—not simply a hosting-region setting.</p>

          <h2>EU data residency</h2>

          <p>Data residency describes where data is physically stored or processed.</p>

          <p>A company may require its primary database, file storage, backups, logs, AI processing and analytics data to remain within the EU or EEA.</p>

          <p>For example, <a href="https://supabase.com/docs/guides/platform/regions" target="_blank" rel="noopener noreferrer">Supabase</a> currently offers several European deployment locations, including Frankfurt, Stockholm, Paris and Ireland. Each project is deployed to a selected primary region, and choosing the appropriate region remains the customer&apos;s responsibility.</p>

          <p>However, selecting an EU database region does not automatically mean every part of an application remains in Europe. A company must also examine:</p>

          <ul>
            <li>AI model providers;</li>
            <li>monitoring and analytics tools;</li>
            <li>support systems;</li>
            <li>email services;</li>
            <li>edge functions;</li>
            <li>backups;</li>
            <li>disaster-recovery locations;</li>
            <li>subprocessors.</li>
          </ul>

          <p>A credible residency claim should describe the complete data flow, not only the location of the main database.</p>

          <h2>International data transfers</h2>

          <p>Using a non-European provider is not automatically prohibited under GDPR.</p>

          <p>European personal data may be transferred outside the EEA through recognised legal mechanisms, including adequacy decisions, <a href="https://commission.europa.eu/law/law-topic/data-protection/international-dimension-data-protection/standard-contractual-clauses-scc_sw" target="_blank" rel="noopener noreferrer">Standard Contractual Clauses</a> and other appropriate safeguards. The European Commission&apos;s modernised Standard Contractual Clauses are specifically designed to support transfers from the EU or EEA to recipients in third countries.</p>

          <p>This means statements such as &ldquo;US cloud providers are illegal in Europe&rdquo; are inaccurate. The more useful questions are:</p>

          <ul>
            <li>Is personal data transferred internationally?</li>
            <li>Which transfer mechanism is used?</li>
            <li>What supplementary technical and organisational protections apply?</li>
            <li>Can the processing be limited to European infrastructure?</li>
            <li>Does the customer&apos;s industry impose stricter requirements?</li>
          </ul>

          <p>Banks, insurers, healthcare organisations and public-sector buyers may apply more restrictive procurement and risk policies than the legal minimum.</p>

          <h2>Pseudonymisation and anonymisation</h2>

          <p>Removing direct identifiers before AI processing can reduce risk, but the terminology matters.</p>

          <p><strong>Pseudonymisation</strong> replaces or removes direct identifiers while retaining the possibility of reconnecting the information to an individual using additional data. Pseudonymised information generally remains personal data and therefore remains subject to GDPR.</p>

          <MaskingDiagram />

          <p><strong>Anonymisation</strong> removes the ability to identify an individual irreversibly. Truly anonymised data are no longer treated as personal data under GDPR. Achieving reliable anonymisation can be difficult, particularly when information can be recombined with other datasets.</p>

          <p>A vendor should therefore describe its approach as local masking or pseudonymisation of direct identifiers, unless the complete processing chain can demonstrate irreversible anonymisation.</p>

          <h2>Digital sovereignty</h2>

          <p>Digital sovereignty is broader than privacy compliance or data residency. It considers who ultimately controls:</p>

          <ul>
            <li>the infrastructure;</li>
            <li>encryption keys;</li>
            <li>software and intellectual property;</li>
            <li>administrative access;</li>
            <li>operational support;</li>
            <li>legal jurisdiction;</li>
            <li>portability and exit;</li>
            <li>dependency on third-country providers.</li>
          </ul>

          <p>The European Commission describes technological sovereignty as Europe&apos;s ability to develop and control important technologies, data and infrastructure while reducing strategic reliance on non-EU providers.</p>

          <p>A product hosted in an EU data centre is therefore not necessarily fully sovereign if it remains controlled by a non-European company or depends heavily on non-European services. Equally, being incorporated in Europe does not make a platform sovereign if its entire infrastructure and AI-processing chain are controlled elsewhere.</p>

          <h2>How to evaluate an AI contract platform</h2>

          <p>Buyers should review at least five areas.</p>

          <EvaluationTable />

          <p>They should also ask whether:</p>

          <ul>
            <li>customer data is used to train shared models;</li>
            <li>retention periods can be configured;</li>
            <li>direct identifiers can be removed before AI analysis;</li>
            <li>subprocessor changes are communicated;</li>
            <li>data can be deleted after processing;</li>
            <li>audit logs are available;</li>
            <li>different customers can receive dedicated environments.</li>
          </ul>

          <h2>Where Verdix fits</h2>

          <p>A defensible position for AI-powered agreement software is based on specific, verifiable architectural controls rather than broad claims of complete sovereignty.</p>

          <p>The architecture should aim to:</p>

          <ul>
            <li>store customer data in selected EU regions;</li>
            <li>remove or replace direct identifiers before AI processing;</li>
            <li>minimise the contract content transferred to external services;</li>
            <li>document every subprocessor and processing location;</li>
            <li>prevent customer data from being used to train shared AI models;</li>
            <li>apply encryption, retention and access controls;</li>
            <li>offer stronger isolation for regulated enterprise customers.</li>
          </ul>

          <p>Claims that all sensitive information remains entirely local should only be made when the complete processing chain—including AI inference, logs and backups—supports that statement.</p>

          <h2>The takeaway</h2>

          <p>These four concepts address different questions:</p>

          <ul>
            <li><strong>GDPR compliance:</strong> Is personal data processed lawfully and responsibly?</li>
            <li><strong>EU data residency:</strong> Where is the data stored and processed?</li>
            <li><strong>Pseudonymisation:</strong> Have direct identifiers been separated or masked?</li>
            <li><strong>Digital sovereignty:</strong> Who ultimately controls the technology, infrastructure and access?</li>
          </ul>

          <p>A buyer should evaluate all four. For AI-powered billing and agreement operations, the strongest approach combines data minimisation, European processing options, local masking of direct identifiers and clear control over where contract information travels.</p>

        </article>

        {/* CTA */}
        <div className="mt-14 rounded-2xl p-8 text-center" style={{ background: '#EAF3DE', border: '0.5px solid #C0DD97' }}>
          <p className="font-medium mb-5" style={{ color: '#1A3D2B', fontSize: 16, lineHeight: 1.6 }}>
            Operationalise customer and partner agreements with EU-first infrastructure and privacy controls designed into the workflow.
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
        .prose-verdix strong {
          font-weight: 600;
          color: #1C1917;
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
        .prose-verdix a {
          color: #27AE60;
          text-decoration: none;
        }
        .prose-verdix a:hover {
          text-decoration: underline;
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
          .trace-chain {
            grid-template-columns: repeat(3, 1fr) !important;
          }
        }
      `}</style>

    </div>
  )
}
