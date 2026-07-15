import Link from 'next/link'
import { VerdixLogo } from '@/components/VerdixLogo'

export const metadata = { title: 'Privacy Policy — Verdix' }

export default function PrivacyPage() {
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

      <div className="max-w-3xl mx-auto px-6 pt-28 pb-20">
        <h1 className="font-display font-light text-ink text-4xl mb-3">Privacy Policy</h1>
        <p className="text-stone text-sm mb-10">Last updated: 15 July 2026</p>

        <div className="prose prose-sm max-w-none space-y-8 text-ink/80">
          {[
            {
              title: '1. Who we are',
              body: 'Verdix is a product of Lynora AB ("Lynora", "we", "us"), the data controller for personal data processed through the Verdix Revenue Intelligence platform. Lynora AB is incorporated in Sweden (Org. nr 559516-1190), with registered offices in Vallentuna, Sweden. Our primary data infrastructure is hosted within the European Union.',
            },
            {
              title: '2. What data we collect',
              body: 'We collect: (a) Account data — name, work email address, company name. (b) Contract documents you upload for analysis — these may contain personal data of your counterparties. (c) Billing records and invoices you upload. (d) Usage data and interaction logs for product improvement. (e) A timestamped record of your consent to this Privacy Policy and our Terms of Service at signup. We do not collect payment card data; payments are handled by our payment processor (Stripe).',
            },
            {
              title: '3. Legal basis for processing',
              body: 'We process your data on the basis of: contract performance (to deliver the service you signed up for), legitimate interest (fraud prevention, product analytics), and consent (you explicitly agreed to this policy at account creation). Contract documents and billing records are processed solely on your instruction as our customer.',
            },
            {
              title: '4. How we use your data — AI processing',
              body: 'Contract text is processed through Amazon Bedrock, a managed AI infrastructure service provided by Amazon Web Services (AWS). Before any text is sent for AI analysis, personally identifiable information (names, email addresses, and other identifiers) is detected and masked locally on our servers — tokens replace the real values, and the real values never leave our infrastructure. Extracted commercial terms (prices, dates, discounts) are stored in your organisation\'s account only. Your data is never used to train AI models.',
            },
            {
              title: '5. Data retention',
              body: 'Account data is retained for the duration of your subscription plus 30 days after termination. Uploaded contract documents are retained for 90 days after job completion, then permanently deleted from storage. Extracted structured data (contract terms, findings) is retained for the duration of your subscription. Consent records are retained for 7 years for legal compliance purposes.',
            },
            {
              title: '6. Transfers outside the EEA',
              body: <>AI processing is performed via <a href="https://aws.amazon.com/bedrock/" target="_blank" rel="noopener noreferrer" className="text-forest underline">Amazon Bedrock</a> using EU-hosted AWS regions, meaning your contract data is processed within the European Economic Area and does not leave it for AI analysis. All other platform data is also stored within EU infrastructure.</>,
            },
            {
              title: '7. Your rights',
              body: 'Under GDPR you have the right to: access your personal data, correct inaccuracies, request erasure ("right to be forgotten"), restrict processing, data portability, and to object to processing. To exercise any of these rights, contact us at bilal@lynoraai.com. You also have the right to lodge a complaint with the Swedish Authority for Privacy Protection (IMY) or your local supervisory authority.',
            },
            {
              title: '8. Security',
              body: 'All data is encrypted at rest (AES-256) and in transit (TLS 1.3). Database access is restricted to authenticated application sessions. Access to production systems is restricted to named individuals on a need-to-know basis. PII masking is applied before any data leaves our servers for AI processing.',
            },
            {
              title: '9. Contact',
              body: 'For privacy enquiries: bilal@lynoraai.com. Postal: Lynora AB, Vallentuna, Sweden. Verdix is a trading name of Lynora AB (Org. nr 559516-1190).',
            },
          ].map(section => (
            <section key={section.title}>
              <h2 className="font-medium text-ink text-base mb-2">{section.title}</h2>
              <p className="text-sm leading-relaxed text-stone">{section.body}</p>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
