import Link from 'next/link'

export const metadata = { title: 'Privacy Policy — Verdix' }

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-cream">
      <nav className="fixed top-0 left-0 right-0 z-50 bg-cream/95 backdrop-blur border-b border-forest/8">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5 text-ink font-medium">
            <svg width="24" height="24" viewBox="0 0 28 28" fill="none">
              <rect width="28" height="28" rx="6" fill="#1A3D2B" />
              <polygon points="8,6 11.5,6 14,20 16.5,6 20,6 17,6 14,17 11,6" fill="#FFFFFF" />
              <circle cx="14" cy="23" r="2" fill="#D4EAD9" />
            </svg>
            Verdix
          </Link>
        </div>
      </nav>

      <div className="max-w-3xl mx-auto px-6 pt-28 pb-20">
        <h1 className="font-display font-light text-ink text-4xl mb-3">Privacy Policy</h1>
        <p className="text-stone text-sm mb-10">Last updated: 1 June 2026</p>

        <div className="prose prose-sm max-w-none space-y-8 text-ink/80">
          {[
            {
              title: '1. Who we are',
              body: 'Verdix AS ("Verdix", "we", "us") is the data controller for personal data processed through our Revenue Intelligence platform. Verdix AS is incorporated in Norway, and our primary data infrastructure is hosted in Frankfurt, Germany (EU).',
            },
            {
              title: '2. What data we collect',
              body: 'We collect: (a) Account data — name, email address, company name, role. (b) Contract documents you upload for analysis — these may contain personal data of your counterparties. (c) Billing records and invoices you upload. (d) Usage data and interaction logs for product improvement. We do not collect payment card data; payments are handled by our payment processor.',
            },
            {
              title: '3. Legal basis for processing',
              body: 'We process your data on the basis of contract performance (to deliver the service you signed up for), legitimate interest (fraud prevention, product analytics), and consent (marketing communications, where you opt in). Contract documents and billing records are processed on the basis of your explicit instruction as our customer.',
            },
            {
              title: '4. How we use your data',
              body: 'Contract and billing data is sent to our AI processing pipeline (Claude, operated by Anthropic) solely for the purpose of extracting commercial terms and detecting billing discrepancies. Raw document text is not retained by Anthropic beyond the API call. We do not train AI models on your data.',
            },
            {
              title: '5. Data retention',
              body: 'Account data is retained for the duration of your subscription plus 30 days after termination. Uploaded documents are retained for 90 days after job completion, after which they are deleted from storage. Extracted structured data (contract terms, findings) is retained for the duration of your subscription.',
            },
            {
              title: '6. Transfers outside the EEA',
              body: 'AI processing is carried out via the Anthropic API (servers in the United States). This transfer is governed by EU Standard Contractual Clauses (SCCs) as required under Article 46 GDPR.',
            },
            {
              title: '7. Your rights',
              body: 'Under GDPR you have the right to: access your data, correct inaccuracies, request erasure, restrict processing, data portability, and to object to processing. To exercise any of these rights, email privacy@verdix.io. You also have the right to lodge a complaint with your local supervisory authority.',
            },
            {
              title: '8. Security',
              body: 'All data is encrypted at rest (AES-256) and in transit (TLS 1.3). We perform annual penetration testing and maintain SOC 2 Type II certification. Access to production data is restricted to named employees on a need-to-know basis.',
            },
            {
              title: '9. Contact',
              body: 'Data Protection contact: privacy@verdix.io. Verdix AS, Pb 1234, 0103 Oslo, Norway.',
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
