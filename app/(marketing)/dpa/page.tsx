import Link from 'next/link'
import { VerdixLogo } from '@/components/VerdixLogo'

export const metadata = {
  title: 'Verdix Data Processing Agreement | Lynora AB',
  description: 'Data Processing Agreement for Verdix, covering processing roles, security, subprocessors, data transfers and customer data rights.',
}

const TOC: Array<{ href: string; label: string }> = [
  { href: '#s1', label: '1. Scope and processing instructions' },
  { href: '#s2', label: '2. Customer responsibilities' },
  { href: '#s3', label: '3. Confidentiality' },
  { href: '#s4', label: '4. Security' },
  { href: '#s5', label: '5. Subprocessors' },
  { href: '#s6', label: '6. International data transfers' },
  { href: '#s7', label: '7. Data-subject requests' },
  { href: '#s8', label: '8. Personal Data Breaches' },
  { href: '#s9', label: '9. Data protection impact assessments' },
  { href: '#s10', label: '10. Data return and deletion' },
  { href: '#s11', label: '11. Compliance information and audits' },
  { href: '#s12', label: '12. Government and public-authority requests' },
  { href: '#s13', label: '13. Duration' },
  { href: '#s14', label: '14. Conflict' },
  { href: '#annex1', label: 'Annex 1 — Details of Processing' },
  { href: '#annex2', label: 'Annex 2 — Technical and Organisational Measures' },
  { href: '#annex3', label: 'Annex 3 — Subprocessors' },
]

const p = 'text-sm leading-relaxed text-stone'
const ul = 'list-disc pl-5 space-y-1 text-sm leading-relaxed text-stone'
const h2 = 'font-medium text-ink text-base mb-2'
const h3 = 'font-medium text-ink text-sm mt-4 mb-1'
const cta = 'inline-block text-forest font-medium text-sm hover:underline'

export default function DPAPage() {
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
        <h1 className="font-display font-light text-ink text-4xl mb-3">Data Processing Agreement</h1>
        <p className="text-stone text-sm mb-8">Last updated: 18 August 2026</p>

        <div className={`${p} space-y-3 mb-8`}>
          <p>This Data Processing Agreement (“DPA”) is made available by Lynora AB, org. nr. 559516-1190, Sweden (“Lynora”, “Verdix”, “we” or “us”) in connection with the Verdix service.</p>
          <p>This DPA applies when it is incorporated into an agreement between Lynora AB and a customer or otherwise executed by the parties.</p>
          <p>Where the customer acts as controller of Personal Data processed through Verdix, Lynora acts as processor. Where the customer acts as processor on behalf of another controller, Lynora acts as the customer’s subprocessor.</p>
        </div>

        <nav className="rounded-xl border border-forest/15 bg-white p-4 mb-10 text-xs" aria-label="Table of contents">
          <p className="font-semibold text-ink mb-2">Contents</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">
            {TOC.map(item => (
              <a key={item.href} href={item.href} className="text-forest hover:underline">{item.label}</a>
            ))}
          </div>
        </nav>

        <div className="prose prose-sm max-w-none space-y-8 text-ink/80">
          <section id="s1">
            <h2 className={h2}>1. Scope and processing instructions</h2>
            <div className="space-y-2">
              <p className={p}>Lynora processes Customer Personal Data only to provide, secure, support and operate Verdix in accordance with the customer agreement, this DPA and the customer’s documented instructions, unless processing is required by applicable law.</p>
              <p className={p}>The customer instructs Lynora to process Customer Personal Data as necessary to:</p>
              <ul className={ul}>
                <li>receive and store customer-provided agreements and related information;</li>
                <li>extract and structure commercial terms;</li>
                <li>identify and mask direct personal identifiers before AI model processing;</li>
                <li>configure and apply commercial and billing rules;</li>
                <li>retrieve or receive relevant operational and usage data;</li>
                <li>calculate charges and billing instructions;</li>
                <li>support human review and approval;</li>
                <li>preserve clause-level source traceability;</li>
                <li>transmit approved billing instructions to integrations enabled by the customer;</li>
                <li>provide security, support, auditability and service administration.</li>
              </ul>
            </div>
          </section>

          <section id="s2">
            <h2 className={h2}>2. Customer responsibilities</h2>
            <div className="space-y-2">
              <p className={p}>The customer is responsible for ensuring that:</p>
              <ul className={ul}>
                <li>Personal Data submitted to Verdix is processed lawfully;</li>
                <li>the customer has the necessary lawful basis, notices, permissions and instructions for the processing;</li>
                <li>the Personal Data submitted is appropriate for the customer’s use of Verdix.</li>
              </ul>
              <p className={p}>Verdix does not require special-category Personal Data for normal use of the service. Customers should not intentionally submit special-category Personal Data unless separately agreed and supported by an appropriate lawful basis and safeguards.</p>
            </div>
          </section>

          <section id="s3">
            <h2 className={h2}>3. Confidentiality</h2>
            <p className={p}>Lynora will ensure that persons authorised to process Customer Personal Data are subject to appropriate confidentiality obligations and access the data only where required for their responsibilities.</p>
          </section>

          <section id="s4">
            <h2 className={h2}>4. Security</h2>
            <div className="space-y-2">
              <p className={p}>Lynora maintains appropriate technical and organisational measures designed to protect Customer Personal Data, taking into account the nature of the processing and the risks involved.</p>
              <p className={p}>These measures include controls relating to:</p>
              <ul className={ul}>
                <li>data minimisation;</li>
                <li>access control and organisation-level data isolation;</li>
                <li>private handling of uploaded agreements;</li>
                <li>encryption in transit and at rest across core application infrastructure;</li>
                <li>masking of direct personal identifiers before AI model processing;</li>
                <li>application and API security;</li>
                <li>logging and traceability;</li>
                <li>deletion and data lifecycle management.</li>
              </ul>
              <p className={p}>A more detailed description of Verdix’s current Technical and Organisational Measures is available to customers and prospective customers on request.</p>
              <p className={p}>Lynora may update its technical and organisational measures provided that the overall level of protection is not materially reduced.</p>
            </div>
          </section>

          <section id="s5">
            <h2 className={h2}>5. Subprocessors</h2>
            <div className="space-y-2">
              <p className={p}>The customer gives Lynora general written authorisation to appoint subprocessors required to provide Verdix.</p>
              <p className={p}>Lynora will:</p>
              <ul className={ul}>
                <li>maintain a current public list of its core subprocessors;</li>
                <li>impose appropriate data-protection obligations on subprocessors;</li>
                <li>remain responsible for its obligations under this DPA notwithstanding its use of subprocessors;</li>
                <li>provide customers covered by this DPA at least 30 days’ notice before a material new subprocessor begins processing Customer Personal Data, except where an urgent change is required for security, availability or legal compliance.</li>
              </ul>
              <p className={p}>Customers may raise legitimate data-protection concerns during the notice period. Lynora and the customer will work in good faith to address such concerns.</p>
              <p className={p}>Customer-selected downstream integrations that the customer enables or instructs Verdix to send data to may have separate data-protection roles and are not automatically treated as Lynora’s core subprocessors.</p>
              <p className={p}>Current subprocessors:</p>
              <Link href="/subprocessors" className={cta}>View the Verdix subprocessor list →</Link>
            </div>
          </section>

          <section id="s6">
            <h2 className={h2}>6. International data transfers</h2>
            <div className="space-y-2">
              <p className={p}>Where Personal Data is transferred from the European Economic Area to a country not covered by an applicable adequacy decision, Lynora will use an appropriate transfer mechanism where required by applicable data-protection law.</p>
              <p className={p}>Where applicable, the relevant modules of the European Commission Standard Contractual Clauses may apply according to the roles of the parties, including controller-to-processor or processor-to-processor transfers.</p>
            </div>
          </section>

          <section id="s7">
            <h2 className={h2}>7. Data-subject requests</h2>
            <div className="space-y-2">
              <p className={p}>Taking into account the nature of the processing, Lynora will provide reasonable assistance to the customer in responding to requests from data subjects exercising their rights under applicable data-protection law.</p>
              <p className={p}>If Lynora receives a request relating to Customer Personal Data for which the customer is responsible, Lynora may direct the requester to the customer unless Lynora is legally required to respond directly.</p>
            </div>
          </section>

          <section id="s8">
            <h2 className={h2}>8. Personal Data Breaches</h2>
            <div className="space-y-2">
              <p className={p}>Lynora will notify the customer without undue delay after becoming aware of a Personal Data Breach affecting Customer Personal Data where notification is required under applicable data-protection law.</p>
              <p className={p}>Lynora will provide reasonably available information needed for the customer to assess the incident and meet applicable legal obligations and will take appropriate steps to contain and remediate the incident.</p>
            </div>
          </section>

          <section id="s9">
            <h2 className={h2}>9. Data protection impact assessments</h2>
            <p className={p}>Taking into account the nature of the processing and the information available to Lynora, Lynora will provide reasonable assistance with data protection impact assessments and consultations with supervisory authorities where required in connection with the customer’s use of Verdix.</p>
          </section>

          <section id="s10">
            <h2 className={h2}>10. Data return and deletion</h2>
            <div className="space-y-2">
              <p className={p}>Verdix retains Customer Data while the customer’s account and relevant agreements remain active.</p>
              <p className={p}>Customers may delete agreements and associated data through the service or request deletion.</p>
              <p className={p}>Before termination, customers may request or use available functionality to obtain a copy of Customer Data where technically supported.</p>
              <p className={p}>Following termination of the Verdix service, Customer Data will be deleted within 30 days, except where particular records must be retained for legal, accounting, security or compliance purposes.</p>
              <p className={p}>Any records retained for such purposes remain protected and are used only for the applicable retention purpose.</p>
              <p className={p}>Consent records may be retained for 7 years where required for legal compliance.</p>
            </div>
          </section>

          <section id="s11">
            <h2 className={h2}>11. Compliance information and audits</h2>
            <div className="space-y-2">
              <p className={p}>Lynora will make available information reasonably necessary to demonstrate compliance with its applicable processor obligations, subject to appropriate confidentiality, security and proportionality requirements.</p>
              <p className={p}>Customers should first use documentation and information made available by Lynora.</p>
              <p className={p}>Where this is insufficient and an audit is reasonably required under applicable data-protection law, the parties will agree reasonable scope, timing, confidentiality and security arrangements. Any audit must avoid unnecessary disruption to Verdix and exposure of information relating to other customers.</p>
            </div>
          </section>

          <section id="s12">
            <h2 className={h2}>12. Government and public-authority requests</h2>
            <p className={p}>Unless legally prohibited, Lynora will notify the customer of a legally binding request from a public authority requiring disclosure of Customer Personal Data where the request relates specifically to the customer’s data and such notification is permitted by law.</p>
          </section>

          <section id="s13">
            <h2 className={h2}>13. Duration</h2>
            <p className={p}>This DPA remains in effect for as long as Lynora processes Customer Personal Data on behalf of the customer.</p>
          </section>

          <section id="s14">
            <h2 className={h2}>14. Conflict</h2>
            <div className="space-y-2">
              <p className={p}>If this DPA conflicts with the customer agreement in relation to the processing of Personal Data, this DPA will prevail to the extent of that conflict.</p>
              <p className={p}>Mandatory provisions of applicable data-protection law and any applicable Standard Contractual Clauses will prevail where required.</p>
            </div>
          </section>

          <section id="annex1">
            <h2 className={h2}>Annex 1 — Details of Processing</h2>

            <h3 className={h3}>Subject matter</h3>
            <p className={p}>Processing of customer-provided agreements, operational and usage information, and related billing data in order to provide the Verdix agreement-to-billing service.</p>

            <h3 className={h3}>Nature and purpose of processing</h3>
            <p className={p}>Processing may include:</p>
            <ul className={ul}>
              <li>receipt and storage of agreements and supporting information;</li>
              <li>extraction and structuring of commercial terms;</li>
              <li>masking of direct personal identifiers;</li>
              <li>AI-assisted interpretation of commercial terms;</li>
              <li>configuration of billing and commercial logic;</li>
              <li>retrieval, receipt and mapping of relevant usage data;</li>
              <li>calculation of charges;</li>
              <li>human review and approval;</li>
              <li>clause and source traceability;</li>
              <li>generation and transmission of approved billing instructions;</li>
              <li>security, support and service administration.</li>
            </ul>

            <h3 className={h3}>Duration</h3>
            <p className={p}>For the duration of the Verdix customer relationship and relevant active agreements, followed by the deletion lifecycle described in this DPA.</p>

            <h3 className={h3}>Categories of data subjects</h3>
            <p className={p}>Depending on the information supplied by the customer, data subjects may include:</p>
            <ul className={ul}>
              <li>customer users and employees;</li>
              <li>finance, billing, RevOps, legal and commercial contacts;</li>
              <li>customer counterparties and their personnel;</li>
              <li>individuals named in agreements;</li>
              <li>individuals represented in relevant operational or billing data.</li>
            </ul>

            <h3 className={h3}>Categories of Personal Data</h3>
            <p className={p}>Depending on customer content, Personal Data may include:</p>
            <ul className={ul}>
              <li>names;</li>
              <li>business email addresses;</li>
              <li>telephone numbers;</li>
              <li>job title, role and organisation;</li>
              <li>account and organisation identifiers;</li>
              <li>billing and contact information;</li>
              <li>Personal Data contained in uploaded agreements;</li>
              <li>operational or usage identifiers reasonably required for billing.</li>
            </ul>

            <h3 className={h3}>Special-category Personal Data</h3>
            <div className="space-y-2">
              <p className={p}>Verdix does not require special-category Personal Data for normal operation.</p>
              <p className={p}>Customers should not intentionally submit such data unless separately agreed and supported by an appropriate lawful basis and safeguards.</p>
            </div>
          </section>

          <section id="annex2">
            <h2 className={h2}>Annex 2 — Technical and Organisational Measures</h2>
            <div className="space-y-2">
              <p className={p}>Lynora AB maintains technical and organisational measures designed to protect Customer Personal Data.</p>
              <p className={p}>A detailed description of Verdix’s current Technical and Organisational Measures is available to customers and prospective customers on request.</p>
              <a href="mailto:bilal@lynoraai.com?subject=Verdix%20Security%20Documentation%20Request" className={cta}>Request security documentation →</a>
            </div>
          </section>

          <section id="annex3">
            <h2 className={h2}>Annex 3 — Subprocessors</h2>
            <div className="space-y-2">
              <p className={p}>Lynora AB maintains a current public list of the core subprocessors used to provide Verdix.</p>
              <Link href="/subprocessors" className={cta}>View subprocessors →</Link>
            </div>
          </section>
        </div>

        <div className="mt-12 rounded-xl border border-forest/15 bg-white p-6">
          <p className="font-medium text-ink text-base mb-2">Need an executed DPA?</p>
          <p className={`${p} mb-3`}>For procurement, legal or security review:</p>
          <div className="flex flex-col gap-1.5">
            <a href="mailto:bilal@lynoraai.com?subject=Verdix%20Signed%20DPA%20Request" className={cta}>Request signed DPA →</a>
            <a href="mailto:bilal@lynoraai.com" className="text-sm text-stone hover:text-forest">bilal@lynoraai.com</a>
          </div>
        </div>
      </div>
    </div>
  )
}
