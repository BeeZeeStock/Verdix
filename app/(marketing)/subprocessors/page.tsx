import Link from 'next/link'
import { VerdixLogo } from '@/components/VerdixLogo'

export const metadata = {
  title: 'Verdix Subprocessors | Lynora AB',
  description: 'Current service providers used by Lynora AB to process personal data in connection with Verdix.',
}

const SUBPROCESSORS: Array<{
  provider: string
  purpose: string
  dataProcessed: string
  residency: string
  entity: string
}> = [
  {
    provider: 'Supabase',
    purpose: 'Database, private file storage and authentication',
    dataProcessed: 'Customer account data, agreements, structured contract and billing data, and related application data',
    residency: 'The primary Verdix project is hosted in Ireland, EU. International-transfer safeguards apply where required.',
    entity: 'SUPABASE PTE. LTD., Singapore',
  },
  {
    provider: 'Amazon Web Services / Amazon Bedrock',
    purpose: 'AI model processing and supporting cloud services',
    dataProcessed: 'Masked contract content and other AI-processing inputs and outputs required to provide Verdix',
    residency: 'Verdix routes Amazon Bedrock processing through its EU configuration.',
    entity: 'Amazon Web Services EMEA SARL, Luxembourg',
  },
  {
    provider: 'Vercel',
    purpose: 'Application hosting and server compute',
    dataProcessed: 'Data processed through Verdix application and server functions',
    residency: 'Verdix application compute is configured in Dublin, Ireland. International-transfer safeguards apply where required.',
    entity: 'Vercel Inc., USA',
  },
  {
    provider: 'Resend',
    purpose: 'Transactional email and service notifications',
    dataProcessed: 'Email addresses and email or message content and metadata transmitted through the service',
    residency: 'Processing may involve the United States and Resend subprocessors. International-transfer safeguards apply where required.',
    entity: 'Plus Five Five, Inc., USA',
  },
]

const p = 'text-sm leading-relaxed text-stone'
const h2 = 'font-medium text-ink text-base mb-2'

export default function SubprocessorsPage() {
  return (
    <div className="min-h-screen bg-cream">
      <nav className="fixed top-0 left-0 right-0 z-50 bg-cream/95 backdrop-blur border-b border-forest/8">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5 text-ink font-medium">
            <VerdixLogo size={24} />
            Verdix
          </Link>
        </div>
      </nav>

      <div className="max-w-4xl mx-auto px-6 pt-28 pb-20">
        <h1 className="font-display font-light text-ink text-4xl mb-3">Verdix Subprocessors</h1>
        <p className="text-stone text-sm mb-8">Last updated: 18 August 2026</p>

        <p className={`${p} mb-10`}>Lynora AB uses a limited number of service providers to process Personal Data on behalf of Verdix customers in order to operate and provide the Verdix service.</p>

        <section className="mb-10">
          <h2 className={h2}>Core subprocessors</h2>

          {/* Desktop / tablet: table */}
          <div className="hidden md:block overflow-x-auto rounded-xl border border-forest/10">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-white text-left">
                  <th className="p-3 font-medium text-ink border-b border-forest/10">Provider</th>
                  <th className="p-3 font-medium text-ink border-b border-forest/10">Purpose</th>
                  <th className="p-3 font-medium text-ink border-b border-forest/10">Data processed</th>
                  <th className="p-3 font-medium text-ink border-b border-forest/10">Data residency / processing</th>
                  <th className="p-3 font-medium text-ink border-b border-forest/10">Legal entity</th>
                </tr>
              </thead>
              <tbody>
                {SUBPROCESSORS.map((row, i) => (
                  <tr key={row.provider} className={i % 2 === 0 ? 'bg-cream/40' : 'bg-white'}>
                    <td className="p-3 align-top font-medium text-ink whitespace-nowrap">{row.provider}</td>
                    <td className="p-3 align-top text-stone">{row.purpose}</td>
                    <td className="p-3 align-top text-stone">{row.dataProcessed}</td>
                    <td className="p-3 align-top text-stone">{row.residency}</td>
                    <td className="p-3 align-top text-stone whitespace-nowrap">{row.entity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile: stacked cards */}
          <div className="md:hidden space-y-4">
            {SUBPROCESSORS.map(row => (
              <div key={row.provider} className="rounded-xl border border-forest/15 bg-white p-4 space-y-2">
                <p className="font-medium text-ink text-sm">{row.provider}</p>
                <dl className="space-y-1.5 text-xs text-stone">
                  <div><dt className="font-medium text-ink/70">Purpose</dt><dd>{row.purpose}</dd></div>
                  <div><dt className="font-medium text-ink/70">Data processed</dt><dd>{row.dataProcessed}</dd></div>
                  <div><dt className="font-medium text-ink/70">Data residency / processing</dt><dd>{row.residency}</dd></div>
                  <div><dt className="font-medium text-ink/70">Legal entity</dt><dd>{row.entity}</dd></div>
                </dl>
              </div>
            ))}
          </div>
        </section>

        <section className="mb-10">
          <h2 className={h2}>Customer-selected integrations</h2>
          <div className="space-y-2">
            <p className={p}>At a customer’s instruction, Verdix may transmit approved billing information to downstream systems selected or enabled by that customer.</p>
            <p className={p}>These customer-selected integrations are not automatically part of Verdix’s core infrastructure and may have separate contractual and data-protection roles.</p>
            <p className={p}>Examples may include billing, invoicing and payment systems enabled by the customer.</p>
          </div>
        </section>

        <section className="mb-10">
          <h2 className={h2}>Changes to subprocessors</h2>
          <div className="space-y-2">
            <p className={p}>Lynora AB maintains this list as core subprocessors are added, replaced or removed.</p>
            <p className={p}>Customers covered by a Verdix DPA will receive at least 30 days’ notice before a material new subprocessor begins processing Customer Personal Data, except where an urgent change is required for security, availability or legal compliance.</p>
            <p className={p}>Customers may raise legitimate data-protection concerns during that notice period.</p>
          </div>
        </section>

        <section>
          <h2 className={h2}>Questions</h2>
          <div className="space-y-2">
            <p className={p}>For questions about Verdix subprocessors or data processing:</p>
            <a href="mailto:bilal@lynoraai.com" className="text-sm text-forest font-medium hover:underline">bilal@lynoraai.com</a>
          </div>
        </section>
      </div>
    </div>
  )
}
