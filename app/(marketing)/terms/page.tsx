import Link from 'next/link'

export const metadata = { title: 'Terms of Service — Verdix' }

export default function TermsPage() {
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
        <h1 className="font-display font-light text-ink text-4xl mb-3">Terms of Service</h1>
        <p className="text-stone text-sm mb-10">Last updated: 15 July 2026</p>

        <div className="prose prose-sm max-w-none space-y-8 text-ink/80">
          {[
            {
              title: '1. About these terms',
              body: 'These Terms of Service ("Terms") govern your access to and use of the Verdix platform, a product of Lynora AB (Org. nr 559516-1190), with registered offices in Vallentuna, Sweden ("Lynora", "we", "us"). By creating an account you agree to these Terms. If you are accepting on behalf of a company or organisation, you represent that you have authority to bind that entity.',
            },
            {
              title: '2. The service',
              body: 'Verdix is a B2B Revenue Intelligence platform that reads signed contracts, extracts commercial terms using AI, and verifies billing configuration against those terms. The platform also supports automated billing setup for new deals. We provide the platform on an "as is" basis and may update features, pricing, or availability with reasonable notice.',
            },
            {
              title: '3. Account responsibilities',
              body: 'You are responsible for maintaining the confidentiality of your login credentials and for all activity that occurs under your account. You must not share your credentials with unauthorised third parties. You agree to notify us immediately at support@verdix.io if you suspect any unauthorised use of your account.',
            },
            {
              title: '4. Acceptable use',
              body: 'You may use Verdix only for lawful business purposes. You must not: (a) upload contracts or data you do not have the right to process; (b) attempt to reverse-engineer, scrape, or disrupt the platform; (c) use the service to process data on behalf of third parties without appropriate data processing agreements in place; or (d) use the service in any way that violates applicable laws or regulations.',
            },
            {
              title: '5. Data processing',
              body: 'By uploading contracts and billing data, you instruct Lynora AB to process that data on your behalf for the purpose of delivering the service. Our processing of personal data within your documents is governed by our Privacy Policy and, where applicable, the Data Processing Agreement available on request. You remain the data controller for any personal data contained in documents you upload.',
            },
            {
              title: '6. Subscriptions and payment',
              body: 'Access to paid features requires an active subscription. Subscription fees are billed in advance on a monthly or annual basis via Stripe. All fees are exclusive of VAT or other applicable taxes, which will be added where required by law. Subscriptions renew automatically unless cancelled before the renewal date. We reserve the right to adjust pricing with 30 days\' notice.',
            },
            {
              title: '7. Intellectual property',
              body: 'Lynora AB retains all intellectual property rights in the Verdix platform, including software, designs, and documentation. You retain all ownership rights in the contracts, data, and documents you upload. We do not claim any ownership over your content. You grant us a limited licence to process your content solely for the purpose of delivering the service.',
            },
            {
              title: '8. Limitation of liability',
              body: 'To the maximum extent permitted by law, Lynora AB\'s total liability for any claim arising from your use of Verdix is limited to the fees you paid in the three months preceding the claim. We are not liable for indirect, incidental, or consequential damages, including loss of revenue or data. The platform assists in billing verification but does not replace your own review processes — you remain responsible for your billing configuration.',
            },
            {
              title: '9. Termination',
              body: 'You may cancel your account at any time from your account settings. We may suspend or terminate your account if you materially breach these Terms and fail to remedy the breach within 14 days of notice. On termination, your data will be retained for 30 days before deletion, during which you may request an export.',
            },
            {
              title: '10. Governing law and disputes',
              body: 'These Terms are governed by the laws of Sweden. Any dispute that cannot be resolved amicably shall be referred to the courts of Stockholm, Sweden, as the court of first instance.',
            },
            {
              title: '11. Changes to these terms',
              body: 'We may update these Terms from time to time. We will notify you of material changes by email or via an in-app notice at least 14 days before the changes take effect. Continued use of the platform after the effective date constitutes acceptance of the updated Terms.',
            },
            {
              title: '12. Contact',
              body: 'For questions about these Terms: support@verdix.io. Lynora AB, Vallentuna, Sweden (Org. nr 559516-1190). Verdix is a trading name of Lynora AB.',
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
