# Subprocessor Classification — DRAFT, INTERNAL ONLY

**Status: NOT APPROVED. NOT FOR PUBLICATION.** This file is not linked from any public page and is not part of the `app/` route tree — it exists purely as a working document for Bilal's review. Do not treat any classification below as final; several rows explicitly need a decision, not just a fact-check.

Prepared 2026-08-18, following the 2026-08-19 security audit and the removal of the premature public `/subprocessors` page. Legal-entity and processing-location claims below come from each vendor's own current public DPA/Terms pages (fetched live), cited per row — not invented, not assumed from the codebase alone. Where a vendor's public terms don't answer something, that's stated as "not stated in public terms," not guessed.

---

## Supabase

| | |
|---|---|
| **Exact legal contracting entity** | Supabase Pte. Ltd (Singapore) |
| **Service used by Verdix** | Postgres database, Auth, Storage (uploaded contract PDFs) |
| **Customer/personal data processed** | Full application dataset: org/user records, contract terms, extracted commercial data, PII entities (masking tokens + original values), uploaded contract/invoice documents |
| **Purpose** | Primary application database and file storage |
| **Confirmed processing/storage location** | `eu-west-1` (Ireland) — confirmed directly in the Supabase dashboard by Bilal, 2026-08-18 |
| **Mandatory or customer-selected** | Mandatory — core infrastructure, not customer-configurable |
| **Proposed classification** | **Verdix subprocessor** |
| **Evidence/source** | Supabase DPA (supabase.com/legal/dpa, fetched 2026-08-18) for entity name; Supabase dashboard (Project Settings → General) for region, confirmed by Bilal |
| **Needs your confirmation** | The DPA states Supabase "may Process Covered Data anywhere that Supabase or its Sub-processors maintain facilities" unless a region is explicitly pinned — confirm the project's region-pinning is actually contractually binding (not just where data happens to sit today), and check Supabase's own subprocessor list for who *their* subprocessors are, since those would be sub-subprocessors of Verdix. |

---

## AWS / Amazon Bedrock

| | |
|---|---|
| **Exact legal contracting entity** | Amazon Web Services EMEA SARL (Luxembourg) — the standard AWS contracting entity for EU-based customers |
| **Service used by Verdix** | Amazon Bedrock (AI/model inference for contract extraction) |
| **Customer/personal data processed** | Contract text (PII-masked before this call, per the app's own logic — not something AWS's terms control) sent for extraction |
| **Purpose** | AI-based extraction of commercial terms from contract text |
| **Confirmed processing/storage location** | `eu-west-1` (Ireland) — `AWS_REGION` env var, and confirmed live via AWS CloudWatch invocation metrics during production testing, 2026-08-18 |
| **Mandatory or customer-selected** | Mandatory — core to the product's extraction pipeline |
| **Proposed classification** | **Verdix subprocessor** |
| **Evidence/source** | AWS Service Terms (aws.amazon.com/service-terms, fetched 2026-08-18) for contracting entity; CloudWatch metrics for actual region use |
| **Needs your confirmation** | AWS's public terms do **not** explicitly state Bedrock customer data is or isn't used for model training — this is the exact gap the audit already flagged. Do not claim a specific AWS/Bedrock training policy publicly until you've confirmed it directly with AWS (e.g. via your account's actual Bedrock terms/console, not just the general Service Terms page). |

---

## Vercel

| | |
|---|---|
| **Exact legal contracting entity** | Vercel Inc. (Delaware, USA) |
| **Service used by Verdix** | Application hosting/compute (Next.js functions) |
| **Customer/personal data processed** | All request/response data passing through the app while a function executes — effectively everything, transiently, since every API route runs here |
| **Purpose** | Application hosting and compute |
| **Confirmed processing/storage location** | Function *execution* pinned to `dub1` (Dublin, `eu-west-1`) as of 2026-08-18, confirmed via Vercel's build manifest and live `x-vercel-id` response headers on production |
| **Mandatory or customer-selected** | Mandatory — core infrastructure |
| **Proposed classification** | **Verdix subprocessor** |
| **Evidence/source** | Vercel DPA (vercel.com/legal/dpa, fetched 2026-08-18) for entity name and general processing-location language; this session's own deployment verification for the specific region pin |
| **Needs your confirmation** | Important nuance: Vercel Inc. is a **US legal entity**, and their own DPA states "Vercel's primary processing facilities are in the United States," with data potentially transferred/processed "anywhere Vercel or its Subprocessors maintain data processing operations." Pinning *function execution* to `dub1` (verified) does not necessarily mean every part of the platform (build system, control plane, CDN edge caching, logging/observability) stays in the EU — those may still touch US infrastructure. If "EU-only compute" needs to be a strict, defensible claim, this needs a direct conversation with Vercel about what specifically is/isn't confined to the EU region, not just the function-execution region setting. |

---

## Resend

| | |
|---|---|
| **Exact legal contracting entity** | Plus Five Five, Inc. (dba Resend), USA |
| **Service used by Verdix** | Transactional email (org invites, demo-lead notification to Bilal, design-partner-application notification) |
| **Customer/personal data processed** | Recipient email addresses; email body content, which can include names, company names, and (for demo-lead/design-partner notifications) a submitted email address |
| **Purpose** | Transactional/notification email delivery |
| **Confirmed processing/storage location** | Not pinned — Resend's own DPA states primary processing is in the **United States**, with EU transfers covered by Standard Contractual Clauses (Module Two, governed by Irish law) |
| **Mandatory or customer-selected** | Mandatory — core to invite/notification flows |
| **Proposed classification** | **Likely Verdix subprocessor** — but flag this is the one mandatory subprocessor whose primary processing/footprint is confirmed to include the **United States** |
| **Evidence/source** | Resend DPA (resend.com/legal/dpa, fetched 2026-08-18) |
| **Needs your confirmation** | This is worth being explicit about: email content (which can include a real person's name/email as the *content* of a notification, not just as a delivery address) genuinely leaves the EU via SCCs. If "all customer data stays in the EU" is ever stated publicly without qualification, this is the concrete exception to account for. |

---

## Stripe

| | |
|---|---|
| **Exact legal contracting entity** | Stripe Payments Europe, Limited (Ireland) — the entity for accounts outside the Americas; Stripe, LLC (USA) is the Americas entity |
| **Service used by Verdix** | Payment processing for Verdix's own SaaS billing to its customers |
| **Customer/personal data processed** | Billing contact details, payment method data (Stripe-hosted, not touched by Verdix's own servers), subscription/invoice records |
| **Purpose** | Payments |
| **Confirmed processing/storage location** | Not pinned; Stripe's DPA describes global processing with SCC/EU-US Data Privacy Framework transfer mechanisms, not exclusive EU storage |
| **Mandatory or customer-selected** | Mandatory for any paying customer (not optional infrastructure, but distinct in kind from Supabase/AWS/Vercel) |
| **Proposed classification** | **Dual role — classification depends on actual Verdix data flow.** Stripe's own DPA describes it acting as **processor** for payment data handled on Verdix's behalf, but as an **independent controller** for its own fraud-detection and compliance processing. Not making a public classification yet; do not block release on this. |
| **Evidence/source** | Stripe DPA (stripe.com/legal/dpa, fetched 2026-08-18) |
| **Needs your confirmation** | Whether your subprocessor disclosure (once published) should list Stripe with this dual-role caveat explicitly, or in a separate "payment processor" category outside the main subprocessor table — this is a legal-drafting choice, not something I should decide. |

---

## Google (OAuth sign-in)

| | |
|---|---|
| **Exact legal contracting entity** | Google Ireland Limited (for EU users) |
| **Service used by Verdix** | "Sign in with Google" (NextAuth Google OAuth provider) — Verdix does **not** use Google Cloud Platform for any infrastructure |
| **Customer/personal data processed** | Name, email, profile picture retrieved from the user's Google account at sign-in |
| **Purpose** | Authentication |
| **Confirmed processing/storage location** | Not applicable in the same sense as infrastructure vendors — see classification note |
| **Mandatory or customer-selected** | Customer-selected — users can alternatively sign in via email/password (credentials provider) |
| **Proposed classification** | **Not a Verdix subprocessor — independent controller / authentication provider.** For OAuth sign-in specifically (as opposed to Google Cloud services, which Verdix doesn't use), Google acts as an independent controller of the end user's Google Account data, governed by Google's own Privacy Policy and Terms — not by a data-processing relationship with Verdix. |
| **Evidence/source** | Google Cloud DPA (cloud.google.com/terms/data-processing-terms, fetched 2026-08-18) — the DPA itself confirms it covers Google Cloud services, not OAuth; the independent-controller framing for OAuth is standard, documented Google Identity Platform behavior |
| **Needs your confirmation** | None technically — this one came out fairly clean. Worth a line in the Privacy Policy distinguishing "Google (sign-in)" from any Google Cloud usage, if it isn't already clear, so a reader doesn't assume Google is a Verdix subprocessor in the same sense as Supabase/AWS. |

---

## Remembill

| | |
|---|---|
| **Exact legal contracting entity** | **Unknown — no public DPA/legal-entity page found.** Not invented; genuinely couldn't verify this from public sources. |
| **Service used by Verdix** | Downstream billing integration — Verdix pushes approved billing/invoice data to Remembill when a customer connects that integration |
| **Customer/personal data processed** | Approved billing configuration, invoice line items, customer billing details — only for orgs that configure the Remembill connector |
| **Purpose** | Customer's own invoice delivery and payment collection (not something Verdix needs for its own service to function) |
| **Confirmed processing/storage location** | Unknown — not verified |
| **Mandatory or customer-selected** | **Customer-selected.** Per your explicit instruction: Remembill is a downstream integration a customer opts into (`org_integrations` connector), not infrastructure Verdix itself depends on to deliver the core service — this is a materially different relationship from Supabase/AWS/Vercel. |
| **Proposed classification** | **Pending classification — do not auto-list as a Verdix subprocessor.** The likely-correct framing is that *the customer* is the controller choosing to send their own billing data to their own Remembill account, with Verdix acting more like a conduit/integration than a processor engaged by Verdix on the customer's behalf — but this is a genuine legal judgment call, not something I can resolve from code. |
| **Evidence/source** | Internal only — `lib/billing-writer.ts`, `org_integrations` table, this session's own audit of the Remembill webhook/API integration. No external public legal source found. |
| **Needs your confirmation** | Everything here needs your input: the legal entity, whether Remembill has its own DPA customers can rely on, and — most importantly — the classification itself (subprocessor vs. customer-directed integration) is a legal question worth a real answer, not a default. |

---

## Summary of what needs your decision (not just fact-checking)

1. **Stripe** — dual role / classification depends on actual Verdix data flow. Not classified publicly yet; not blocking release.
2. **Remembill** — legal entity unknown from public sources; classification (subprocessor vs. customer-directed integration) is a real decision, not a lookup.
3. **Resend** — likely Verdix subprocessor; the one mandatory vendor whose footprint includes the **US**. Security page must not say "EU-only" / "all data stays in the EU" while this is true.
4. **Vercel** — function execution confirmed pinned to `dub1`/EU, but Vercel's own legal entity and "primary processing facilities" are US-based per their DPA. Worth clarifying with Vercel directly what is/isn't covered by the region pin before making a strict "EU-only compute" claim.
5. **AWS/Bedrock training policy** — still unverified from public terms; do not make a specific claim about it without confirming directly with AWS for this account.

None of this table is published anywhere public. Let me know how you want to proceed on each open item above.
