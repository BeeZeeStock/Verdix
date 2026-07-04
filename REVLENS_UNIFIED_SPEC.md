# ═══════════════════════════════════════════════════════════════
# VERDIX — UNIFIED VIBE CODING SPECIFICATION
# ═══════════════════════════════════════════════════════════════
# Product:  Verdix — Revenue Intelligence for B2B SaaS
# Modules:  Billing Verification · Auto-Configure · Marketing Site
# Version:  3.0 — June 2026
#
# ── FOR THE VIBE CODING TOOL (Cursor / Lovable / Bolt) ─────────
#
#  1. Read this ENTIRE document before generating any code.
#  2. Build in the exact sequence defined in SECTION 0.
#  3. Every file path, schema field, and component name is
#     authoritative. Do not rename or restructure.
#  4. Section 20 is an ADDENDUM — it overrides anything in
#     Sections 1–19 where they conflict.
#  5. index.html (delivered alongside this spec) is the
#     authoritative visual reference for the marketing site.
#     Match it exactly when building app/(marketing)/page.tsx.
#
# ═══════════════════════════════════════════════════════════════

---

## SECTION 0 — BUILD SEQUENCE

Build in this exact order. Do not skip ahead.
Read Section 20 (addendum) before starting — it overrides Sections 1–19.

PHASE 1 — Foundation
  1.  Project scaffold + package.json + tsconfig + tailwind config
  2.  Design tokens + Verdix SVG logo (Section 3 + Section 20.2)
  3.  Database migrations 001–011 — run in Supabase (Section 4 + 20.12.1)
  4.  Environment variables (Section 5)
  5.  Next.js App Router folder structure (Section 6 + 20.10)

PHASE 2 — Marketing site
  6.  Marketing homepage — match index.html exactly (Section 7 + 20.5 + 20.11)
  7.  Auth pages — login + signup with GDPR (Section 8 + 20.8)

PHASE 3 — Dashboard shell
  8.  Shared components — sidebar, layout, upload zone (Section 9 + 20.3)
  9.  Dashboard home with learning analytics widget (Section 10 + 20.12.8)

PHASE 4 — Billing Verification (Module 1)
  10. Billing Verification list + new audit wizard (Section 11)
  11. Audit results page — findings table + calculation breakdown (Section 11)
  12. Billing connector layer — CSV parser + reconciler (Section 14)
  13. POST /api/jobs/[id]/audit route (Section 15)
  14. POST /api/jobs/[id]/fix-finding route (Section 15)

PHASE 5 — Auto-Configure (Module 2)
  15. Auto-Configure list + upload page (Section 12)
  16. HITL review panel — rich Ardoq AS scenario (Section 12 + 20.6)
  17. Correction capture UX in HITL panel (Section 20.12.5)
  18. POST /api/corrections route (Section 20.12.2)
  19. POST /api/jobs/[id]/execute route (Section 15)
  20. POST /api/jobs/[id]/approve route (Section 15)

PHASE 6 — Contract intelligence engine + learning layer
  21. lib/contract-extractor.ts — Claude extraction + few-shots (Section 13)
  22. lib/learning-context.ts — correction retrieval + prompt injection (20.12.3)
  23. Update extractor to call buildLearningContext (20.12.4)
  24. Supabase Edge Functions — DocuSign webhook + parser + approve (Section 16)

PHASE 7 — Partner reconciliation module
  25. DB migrations 012 — add PARTNER_RECON enum + tables (20.13.1)
  26. Partner recon wizard + upload page (20.13.3)
  27. lib/partner-reconciler.ts — agreement vs invoice diff engine (20.13.4)
  28. Partner recon results page with dispute actions (20.13.5)
  29. Sidebar navigation addition for partner recon (20.13.6)

PHASE 8 — Design Partner programme + settings + polish
  30. Design Partner apply API route + DB migration 013 (20.14.1)
  31. Design Partner applications admin view (20.14.2)
  32. Resend email templates — Design Partner confirmation + founder notification (20.14.3)
  33. Learned rules settings page (20.12.6)
  34. "Applied rule" badge in HITL panel (20.12.7)
  35. Privacy policy page — GDPR (Section 17 + 20.8)
  36. Deployment checklist (Section 18)

---

## SECTION 1 — PRODUCT OVERVIEW

Verdix is a two-module revenue intelligence platform for B2B SaaS companies.

**Billing Verification**
Reads existing signed contracts (PDFs) + billing export (Stripe/Chargebee CSV).
Finds where billing diverged from what was agreed.
Surfaces mismatches as leakage findings with dollar values and evidence.
User approves fixes → pushed to Stripe/Chargebee via API.
Entry motion: "We found $X you're owed but never collected."

**Auto-Configure**
Receives new signed contracts (DocuSign webhook or manual upload).
Extracts commercial terms using AI.
Proposes billing configuration for the connected billing platform (Stripe · Chargebee).
Human approves in HITL review screen.
Pushes billing setup to the billing platform automatically.
Expansion motion: "Every new deal — billing configured before the first invoice."

**Shared foundation (used by both modules):**
- Contract Intelligence Engine (PDF → LLM extraction → ContractTerms JSON)
- HITL review UI (split-screen PDF viewer + editable fields)
- Billing platform write-back via API (Stripe · Chargebee supported, Maxio coming soon)
- Supabase (EU Frankfurt) for storage + database
- Audit log for every change pushed to billing systems

---

## SECTION 2 — TECH STACK

Frontend:     Next.js 14 (App Router), Tailwind CSS, shadcn/ui
Auth:         NextAuth.js (Google OAuth + email/password)
State:        Zustand
File upload:  react-dropzone
Fonts:        Fraunces (display) + Inter (body) + JetBrains Mono (amounts)
Icons:        Lucide React

Backend:      Next.js API routes (same repo)
Database:     Supabase PostgreSQL — EU region eu-central-1 (Frankfurt)
Storage:      Supabase Storage — private bucket, EU region
AI:           Anthropic Claude API (claude-sonnet-4-6) for contract extraction
PDF parse:    pdf-parse (server-side only, never import in client components)
Email:        Resend
Edge:         Supabase Edge Functions (Deno runtime) for DocuSign webhook

Data residency: ALL data stays in EU. Supabase project MUST be eu-central-1.
                Contract text is sent to Anthropic API for extraction then
                raw text is not retained. Extracted JSON stored in Supabase EU.

---

## SECTION 3 — DESIGN SYSTEM

### Colour tokens (add to tailwind.config.js)
```js
colors: {
  forest:    '#1A3D2B',   // primary dark green — headlines, primary buttons
  sage:      '#4A7C59',   // mid green — accents, links, hover
  mint:      '#D4EAD9',   // light green — tag backgrounds, highlights
  cream:     '#FAF8F4',   // page background
  parchment: '#F0EBE1',   // card backgrounds, secondary surfaces
  stone:     '#6B6660',   // body text secondary
  ink:       '#1C1917',   // body text primary
  danger:    '#DC2626',   // leakage found, CRITICAL findings
  safe:      '#16A34A',   // no leakage, success states
  warn:      '#D97706',   // review needed, MEDIUM findings
}
```

### Typography (add to globals.css or layout)
```
Display:  Fraunces (Google Fonts) — H1/H2 on marketing pages, weight 300/600
Body:     Inter (Google Fonts) — all UI, weights 400/500
Mono:     JetBrains Mono — contract clause excerpts, dollar amounts, dates
```

### Key Tailwind patterns
```
Page bg:        bg-cream
Card:           bg-white border border-forest/10 rounded-2xl p-6
Card alt:       bg-parchment border border-forest/10 rounded-2xl
Primary button: bg-forest text-white hover:bg-sage rounded-xl px-6 py-3 font-medium
Ghost button:   border border-sage text-sage hover:bg-mint rounded-xl px-6 py-3
CRITICAL badge: bg-red-50 text-red-700 border border-red-200 rounded-full px-3 py-1 text-xs font-semibold
HIGH badge:     bg-amber-50 text-amber-700 border border-amber-200 rounded-full px-3 py-1 text-xs font-semibold
MEDIUM badge:   bg-mint text-forest border border-sage/20 rounded-full px-3 py-1 text-xs font-semibold
Leakage amount: font-mono font-semibold text-danger text-lg
Contracted amt: font-mono font-semibold text-forest
Evidence quote: font-mono text-sm bg-parchment border-l-4 border-sage p-4 rounded-r-lg
```

### Signature design element — the contract diff card
Used in the hero section and in finding rows:
```
Contracted: $4,635/mo  →  Billed: ~~$4,500/mo~~  →  Leakage: $135/mo ⚠
```
Contracted amount in forest green, billed amount in stone with line-through,
leakage in danger red bold, all in JetBrains Mono.

---

## SECTION 4 — DATABASE SCHEMA

Run these SQL migrations in Supabase dashboard → SQL Editor in order.

```sql
-- ── MIGRATION 001: Enums ──────────────────────────────────────────

CREATE TYPE process_status AS ENUM (
  'RECEIVED',
  'PROCESSING_MAP',
  'PENDING_HUMAN_REVIEW',
  'SYNCING_TO_GATEWAY',
  'COMPLETED',
  'FAILED'
);

CREATE TYPE audit_status AS ENUM (
  'pending',
  'extracting',
  'reconciling',
  'complete',
  'error'
);

CREATE TYPE finding_type AS ENUM (
  'ESCALATOR_MISS',
  'DISCOUNT_OVERHANG',
  'OVERAGE_UNBILLED'
);

CREATE TYPE finding_priority AS ENUM (
  'CRITICAL', 'HIGH', 'MEDIUM'
);

CREATE TYPE finding_status AS ENUM (
  'open', 'reviewing', 'fixed', 'dismissed'
);

CREATE TYPE module_type AS ENUM (
  'AUDIT',    -- BILLING_VERIFICATION: existing contracts vs billing history
  'EXECUTE'   -- AUTO_CONFIGURE: new contract → configure billing
);

-- ── MIGRATION 002: User profiles ─────────────────────────────────

CREATE TABLE public.profiles (
  id                UUID REFERENCES auth.users(id) PRIMARY KEY,
  email             TEXT NOT NULL,
  full_name         TEXT,
  company_name      TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  gdpr_accepted_at  TIMESTAMPTZ,
  gdpr_version      TEXT DEFAULT '1.0'
);

-- ── MIGRATION 003: Contract jobs (shared by both modules) ─────────
-- This is the unified job table replacing ContractJob from Module 2

CREATE TABLE public.contract_jobs (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id             UUID REFERENCES public.profiles(id) NOT NULL,
  organization_id     UUID,                          -- for multi-tenant later
  module              module_type NOT NULL            -- 'BILLING_VERIFICATION' or 'AUTO_CONFIGURE'
  name                TEXT NOT NULL,                  -- human-readable job name
  status              TEXT DEFAULT 'pending',
  -- BILLING_VERIFICATION specific
  audit_status        audit_status DEFAULT 'pending',
  total_contracts     INTEGER DEFAULT 0,
  total_invoices      INTEGER DEFAULT 0,
  total_leakage       DECIMAL(12,2) DEFAULT 0,
  findings_count      INTEGER DEFAULT 0,
  -- AUTO_CONFIGURE specific
  execute_status      process_status DEFAULT 'RECEIVED',
  raw_extracted_json  JSONB,
  relevant_page_ids   INT[] DEFAULT '{}',
  -- Shared
  error_message       TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  completed_at        TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ── MIGRATION 004: Uploaded files ────────────────────────────────

CREATE TABLE public.job_files (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id            UUID REFERENCES public.contract_jobs(id) ON DELETE CASCADE,
  file_type         TEXT NOT NULL
    CHECK (file_type IN ('contract','billing','signed_contract')),
  storage_path      TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  file_size_bytes   INTEGER,
  uploaded_at       TIMESTAMPTZ DEFAULT NOW(),
  processed         BOOLEAN DEFAULT FALSE
);

-- ── MIGRATION 005: Contract pages (AUTO_CONFIGURE Map-Reduce) ──────────

CREATE TABLE public.contract_pages (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id            UUID REFERENCES public.contract_jobs(id) ON DELETE CASCADE,
  page_number       INT NOT NULL,
  page_text         TEXT NOT NULL,
  has_financial_data BOOLEAN,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(job_id, page_number)
);

-- ── MIGRATION 006: Extracted contract terms (both modules) ────────

CREATE TABLE public.contract_terms (
  id                      UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id                  UUID REFERENCES public.contract_jobs(id) ON DELETE CASCADE,
  file_id                 UUID REFERENCES public.job_files(id),
  contract_id             TEXT,
  customer_name           TEXT,
  vendor_name             TEXT,
  contract_start_date     DATE,
  contract_end_date       DATE,
  contract_term_months    INT,
  currency                TEXT DEFAULT 'USD',
  base_monthly_fee        DECIMAL(10,2),
  base_annual_fee         DECIMAL(10,2),
  billing_frequency       TEXT,
  payment_terms_days      INT,
  included_units          INTEGER,
  included_unit_type      TEXT,
  year_pricing            JSONB,
  escalators              JSONB DEFAULT '[]',
  discounts               JSONB DEFAULT '[]',
  overage_tiers           JSONB DEFAULT '[]',
  extraction_confidence   TEXT CHECK (extraction_confidence IN ('high','medium','low')),
  extraction_notes        TEXT,
  extracted_at            TIMESTAMPTZ DEFAULT NOW()
);

-- ── MIGRATION 007: Line items (AUTO_CONFIGURE) ─────────────────

CREATE TABLE public.line_items (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id            UUID REFERENCES public.contract_jobs(id) ON DELETE CASCADE,
  product_name      TEXT NOT NULL,
  quantity          INT,
  unit_price        NUMERIC(12,2),
  billing_period    TEXT NOT NULL,
  total_amount      NUMERIC(12,2) NOT NULL,
  currency          VARCHAR(3) NOT NULL DEFAULT 'USD',
  exchange_rate_used NUMERIC(10,6) NOT NULL DEFAULT 1.000000,
  converted_amount  NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  confidence_score  NUMERIC(4,3),
  stripe_price_id   TEXT,
  sf_line_item_id   TEXT
);

-- ── MIGRATION 008: Leakage findings (BILLING_VERIFICATION) ─────────────

CREATE TABLE public.leakage_findings (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id              UUID REFERENCES public.contract_jobs(id) ON DELETE CASCADE,
  finding_id          TEXT NOT NULL,
  leakage_type        finding_type NOT NULL,
  customer_name       TEXT,
  contract_id         TEXT,
  invoice_id          TEXT,
  billing_month       TEXT,
  description         TEXT NOT NULL,
  contracted_amount   DECIMAL(10,2),
  billed_amount       DECIMAL(10,2),
  leakage_amount      DECIMAL(10,2) NOT NULL,
  evidence            TEXT,
  confidence          TEXT CHECK (confidence IN ('HIGH','MEDIUM','LOW')),
  priority            finding_priority,
  status              finding_status DEFAULT 'open',
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ── MIGRATION 009: Row Level Security ────────────────────────────

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leakage_findings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own_profile"      ON public.profiles        FOR ALL USING (auth.uid() = id);
CREATE POLICY "own_jobs"         ON public.contract_jobs    FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "own_files"        ON public.job_files        FOR ALL USING (job_id IN (SELECT id FROM public.contract_jobs WHERE user_id = auth.uid()));
CREATE POLICY "own_pages"        ON public.contract_pages   FOR ALL USING (job_id IN (SELECT id FROM public.contract_jobs WHERE user_id = auth.uid()));
CREATE POLICY "own_terms"        ON public.contract_terms   FOR ALL USING (job_id IN (SELECT id FROM public.contract_jobs WHERE user_id = auth.uid()));
CREATE POLICY "own_line_items"   ON public.line_items       FOR ALL USING (job_id IN (SELECT id FROM public.contract_jobs WHERE user_id = auth.uid()));
CREATE POLICY "own_findings"     ON public.leakage_findings FOR ALL USING (job_id IN (SELECT id FROM public.contract_jobs WHERE user_id = auth.uid()));

-- ── MIGRATION 010: Storage bucket (run in Supabase Dashboard) ────
-- Storage → New Bucket → Name: "contract-documents" → Private: YES
-- Allowed MIME types: application/pdf, text/csv,
--   application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
-- File size limit: 50MB
```

---

## SECTION 5 — ENVIRONMENT VARIABLES

```bash
# .env.local

# Supabase — MUST be EU region (eu-central-1 Frankfurt)
NEXT_PUBLIC_SUPABASE_URL=https://[project].supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=[anon-key]
SUPABASE_SERVICE_ROLE_KEY=[service-role-key]

# NextAuth
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=[openssl rand -base64 32]

# Google OAuth
GOOGLE_CLIENT_ID=[from Google Cloud Console]
GOOGLE_CLIENT_SECRET=[from Google Cloud Console]

# Anthropic (contract extraction)
ANTHROPIC_API_KEY=[sk-ant-...]

# Billing platform write-back
STRIPE_SECRET_KEY=[sk_live_... or sk_test_...]
STRIPE_WEBHOOK_SIGNING_SECRET=[whsec_...]

# DocuSign (AUTO_CONFIGURE webhook)
DOCUSIGN_ACCOUNT_ID=[your-docusign-account-id]
DOCUSIGN_SYSTEM_TOKEN=[your-docusign-token]

# Resend (transactional email)
RESEND_API_KEY=[re_...]
RESEND_FROM_EMAIL=noreply@revlens.io

# Slack (low-confidence alerts — optional)
SLACK_REVOPS_WEBHOOK_URL=[https://hooks.slack.com/...]

# App
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_APP_NAME=Verdix
```

---

## SECTION 6 — FOLDER STRUCTURE

```
revlens/
├── app/
│   ├── (marketing)/
│   │   ├── page.tsx                    # Homepage / landing (Section 7)
│   │   ├── privacy/page.tsx            # GDPR Privacy Policy
│   │   └── terms/page.tsx
│   ├── (auth)/
│   │   ├── login/page.tsx              # Login with Google + email (Section 8)
│   │   └── signup/page.tsx             # Signup + GDPR consent
│   ├── (dashboard)/
│   │   ├── layout.tsx                  # Dashboard shell with sidebar
│   │   ├── dashboard/page.tsx          # Overview — both modules
│   │   ├── verify/                     # BILLING VERIFICATION
│   │   │   ├── page.tsx                # List of audit jobs
│   │   │   ├── new/page.tsx            # New audit wizard
│   │   │   └── [id]/page.tsx           # Audit results + leakage findings
│   │   ├── configure/                  # AUTO-CONFIGURE
│   │   │   ├── page.tsx                # List of execute jobs
│   │   │   ├── new/page.tsx            # Upload new contract for execution
│   │   │   └── [id]/page.tsx           # HITL review + billing platform sync
│   │   └── settings/page.tsx
│   └── api/
│       ├── auth/[...nextauth]/route.ts
│       ├── jobs/
│       │   ├── route.ts                # GET list, POST create
│       │   └── [id]/
│       │       ├── route.ts            # GET single job
│       │       ├── audit/route.ts      # POST trigger Billing Verification pipeline
│       │       └── execute/route.ts    # POST trigger Auto-Configure pipeline
│       ├── upload/route.ts             # POST file upload to Supabase Storage
│       └── stripe/
│           └── webhook/route.ts        # Billing platform webhook receiver
│
├── components/
│   ├── marketing/
│   │   ├── Navbar.tsx
│   │   ├── Hero.tsx
│   │   ├── PainSection.tsx
│   │   ├── HowItWorks.tsx
│   │   ├── FindingsDemo.tsx
│   │   ├── SecurityBadges.tsx
│   │   └── CTASection.tsx
│   ├── dashboard/
│   │   ├── Sidebar.tsx
│   │   ├── ModuleSwitcher.tsx           # Toggle between Audit / Execute
│   │   ├── UploadZone.tsx              # Shared file upload component
│   │   ├── ContractDiffCard.tsx        # The signature diff visual
│   │   ├── FindingRow.tsx              # Single leakage finding (Billing Verification)
│   │   ├── FindingsTable.tsx           # Full findings table (Billing Verification)
│   │   ├── HITLReviewPanel.tsx         # HITL split-screen (Auto-Configure)
│   │   ├── LineItemForm.tsx            # Editable line item (Auto-Configure)
│   │   └── AnalyticsDashboard.tsx      # ROI metrics (both modules)
│   └── ui/                             # shadcn/ui auto-generated
│
├── lib/
│   ├── supabase.ts                     # Supabase client (server + browser)
│   ├── auth.ts                         # NextAuth config
│   ├── contract-extractor.ts           # Claude API extraction (SHARED)
│   ├── billing-parser.ts               # Billing platform CSV parser (Stripe/Chargebee)
│   ├── reconciler.ts                   # Contract vs billing diff engine (Billing Verification)
│   ├── billing-writer.ts               # Billing platform API write-back (SHARED)
│   └── types.ts                        # All TypeScript interfaces
│
├── supabase/
│   ├── migrations/
│   │   └── 20260626000000_revlens.sql  # Full schema from Section 4
│   └── functions/
│       ├── docusign-ingestion/
│       │   └── index.ts               # DocuSign webhook (Auto-Configure)
│       ├── contract-parser-pipeline/
│       │   └── index.ts               # Map-Reduce + Claude extraction
│       └── contract-approve/
│           └── index.ts               # HITL approval + billing platform sync
│
├── middleware.ts                        # Route protection
├── next.config.js
├── tailwind.config.js
└── .env.local
```

---

## SECTION 7 — MARKETING HOMEPAGE

File: `app/(marketing)/page.tsx`
Also produce: `index.html` (standalone version using Tailwind CDN for quick deploy)

### Navigation
Logo: Verdix SVG mark (dark forest green rounded square, white geometric V, mint dot at convergence point) + "Verdix" wordmark in Fraunces 300, wide letter-spacing. No tagline.
Links: How it works · Audit · Execute · Pricing · Sign in
CTA: "Start free audit →" — forest background, white text, rounded-xl
Sticky, cream/white background, subtle shadow on scroll.

### Hero Section
```
Eyebrow (sage, uppercase, small):
  "Revenue Intelligence for B2B SaaS"

Headline (Fraunces 300, clamp 2.5rem→4rem, ink):
  "Your contracts say one thing.
   Your billing says another."

Subheadline (Inter 400, 1.125rem, stone, max-width 580px):
  "Verdix reads your signed contracts, finds where your billing
   system diverged, and fixes it — automatically. Then makes
   sure every new deal is configured correctly from day one."

CTAs:
  Primary: "Find your leakage →"     (forest, lg)
  Secondary: "See how it works"       (ghost, sage border)
```

Hero visual — the animated ContractDiffCard:
```
┌─────────────────────────────────────────────────┐
│  Acme Corp · CLR-2024-0042              AUDIT   │
│                                                 │
│  Contracted          →         Billed           │
│  $4,635/mo              ~~$4,500/mo~~  ⚠       │
│  ─────────────────────────────────────          │
│  3% escalator — Feb 2025 · Clause 3.1          │
│                                                 │
│  Leakage found: $135/mo · $1,620/yr            │
│  [ Fix via API → ]                              │
└─────────────────────────────────────────────────┘
```
Style: white card, forest left-border 3px, Fraunces for amounts,
JetBrains Mono for dollar values and dates.
Animate: billed amount counts DOWN from $4,635 to $4,500 on load,
then the ⚠ badge appears, then the leakage line fades in.

Below hero — 3 stat pills (parchment bg, inline):
- "3–9% of ARR" / "Average leakage in B2B SaaS"
- "$9B+ annually" / "Lost across the SaaS industry"
- "73% of companies" / "Have no automated detection (BCG)"

### Two Module Cards Section
Headline: "One platform. Two modules. One flywheel."
Subheadline: "Start with the audit. Expand to full automation."

Two side-by-side cards:

LEFT — BILLING_VERIFICATION (forest border accent)
```
Icon: search (Lucide)
Badge: "Start here — free"
Title: "Find what's wrong"
Body:  "Upload your existing contracts and billing export.
        We diff every term against every invoice and surface
        the revenue you've already earned but never collected."
Steps (small, numbered):
  1. Upload contracts + billing CSV
  2. AI extracts every commercial term
  3. Diff against billing history
  4. Findings with dollar values + evidence
CTA: "Run your first audit →"
```

RIGHT — AUTO_CONFIGURE (sage border accent)
```
Icon: zap (Lucide)
Badge: "Expand after audit"
Title: "Fix what's next"
Body:  "Connect DocuSign. Every new contract signed triggers
        automatic term extraction and billing configuration
        in Stripe — before the first invoice goes out."
Steps (small, numbered):
  1. DocuSign webhook or manual upload
  2. AI extracts + proposes billing config
  3. Human reviews in 60 seconds
  4. Billing platform configured automatically
CTA: "See how Execute works →"
```

### What We Find Section — Three Leakage Patterns
Headline: "Three patterns. Thousands of euros left on the table."

Three cards using the ContractDiffCard pattern:

Card 1 — ESCALATOR MISS (warn/amber)
```
Customer: Acme Corp · Feb–May 2025
Contracted: $4,635/mo  →  Billed: $4,500/mo
Leakage: $540 recovered
Evidence: "Clause 3.1: 3% escalator effective Feb 1, 2025"
```

Card 2 — DISCOUNT OVERHANG (warn/amber)
```
Customer: Meridian Health · Jul 2024–May 2025
Contracted: $3,200/mo  →  Billed: $2,560/mo
Leakage: $7,040 recovered
Evidence: "Clause 3.1: 20% discount expires June 30, 2024"
```

Card 3 — OVERAGE UNBILLED (danger/red — CRITICAL)
```
Customer: Northgate Capital · 14 months
Contracted: $0.012/call above 500K  →  Billed: $0
Leakage: $73,132 recovered
Evidence: "Clause 3.2: overage tier never configured in Stripe"
```

Total recovery bar: "Total recoverable across 3 contracts: $80,712"
(large, forest, Fraunces)

### How Auto-Configure Works Section
Headline: "From signed contract to configured billing in 60 seconds."

Four steps horizontal flow (vertical on mobile):
1. DocuSign webhook fires when deal closes
2. AI reads every clause — prices, discounts, overages, escalators
3. Human reviews proposed config in split-screen (60 seconds)
4. Billing platform configured — zero manual typing

### Security Section
Headline: "Your contracts are sensitive. We treat them that way."

Four columns:
- EU data residency · "All data stored in Frankfurt, Germany. Never leaves the EEA."
- GDPR compliant · "You own your data. Export or delete at any time."
- No AI training · "Contracts processed for extraction only. Raw text not retained."
- Audit trail · "Every billing change logged with the contract clause that authorised it."

### CTA Section
Headline: "Find out what your billing system owes you."
Sub: "Upload two files. Get your leakage report in minutes. Free for your first audit."
Button: "Start your free audit →" (large, forest)
Below: "No credit card · Data stored in EU · Delete anytime"

### Footer
Logo + "Revenue intelligence for B2B SaaS"
Links: Audit · Execute · Privacy Policy · Terms · Contact
Legal: © 2026 Verdix. Built for Nordic and European B2B SaaS companies.

---

## SECTION 8 — AUTH PAGES

### Login (`app/(auth)/login/page.tsx`)
Centered card, max-width 420px, cream background.
```
Logo + "Welcome back"
Subheadline: "Sign in to your Verdix account"

[ Continue with Google ]   ← white bg, forest border, Google logo SVG

─── or ───

Email: "Work email"
Password: "Password"
[ Sign in →]   ← forest bg, white text

Forgot password? / Don't have an account? Sign up →
Small: "By signing in you agree to our Terms and Privacy Policy"
```

### Signup (`app/(auth)/signup/page.tsx`)
```
Logo + "Start finding leakage"
Sub: "Free for your first audit. No credit card."

[ Continue with Google ]

─── or ───

Full name / Work email / Company name / Password / Confirm password

GDPR consent checkbox (REQUIRED — disable submit until checked):
  ☐ I have read and agree to the Privacy Policy and Terms of Service.
    I understand how Verdix processes my data under GDPR.
    [Privacy Policy] · [Terms of Service] (open new tab)

[ Create account → ]  (disabled until checkbox checked)

Already have an account? Sign in →
```

---

## SECTION 9 — SHARED DASHBOARD COMPONENTS

### Sidebar (`components/dashboard/Sidebar.tsx`)
```
Logo (top)
────────────
[layout-dashboard]  Dashboard
──── BILLING VERIFICATION ────
[search]            Billing checks
[plus]              New verification
──── AUTO-CONFIGURE ────
[zap]               New contracts
[plus]              Upload contract
──── ────────── ────
[settings]          Settings
────────────
User avatar + name + email
[log-out]           Sign out
```

### Dashboard Layout (`app/(dashboard)/layout.tsx`)
Sidebar (220px fixed) + main content area (flex-1).
Main area: cream background, overflow-y-auto.
Top bar: breadcrumb + user avatar.

### UploadZone (`components/dashboard/UploadZone.tsx`)
Shared by both modules. Props: `accept`, `multiple`, `label`, `sublabel`, `onFiles`.
Dotted border, forest color, drag-and-drop, click to browse.
File chips below zone: filename + size + × to remove.

---

## SECTION 10 — DASHBOARD HOME

File: `app/(dashboard)/dashboard/page.tsx`

Top row — 4 metric cards (parchment bg):
1. Audits run (count)
2. Total leakage found ($)
3. Contracts auto-configured (count)
4. Open findings (unresolved)

Below — two column panels:
LEFT: Recent Billing Verification jobs — table with name/status/leakage/date
RIGHT: Recent Auto-Configure jobs — table with contract/status/date

Empty states:
Audit: "No audits yet. Upload your first contracts." + "Start audit →"
Execute: "No contracts executed yet." + "Upload a contract →"

---

## SECTION 11 — BILLING VERIFICATION FLOW

### Audit List (`app/(dashboard)/audit/page.tsx`)
Table: Name · Contracts · Invoices · Leakage Found · Status · Date · Actions
Status pills: pending (grey) / extracting (blue, pulsing) / complete (green) / error (red)
Actions: View · Delete
Floating "+ New Audit" button.

### New Audit Wizard (`app/(dashboard)/audit/new/page.tsx`)
Three-step wizard with progress indicator.

STEP 1 — Name your audit:
```
Input: "Audit name" (e.g. "Q2 2025 Revenue Audit")
Select: "Billing currency" (USD / EUR / GBP / SEK / NOK / DKK)
[ Next → ]
```

STEP 2 — Upload files:
```
Two UploadZone components side by side:

LEFT — Contract PDFs
  Label: "Contract PDFs"
  Sub: "Drop signed order forms here"
  Accept: .pdf, .docx
  Multiple: yes, up to 20

RIGHT — Billing Export
  Label: "Billing Export"
  Sub: "Billing platform CSV export (Stripe or Chargebee)"
  Accept: .csv, .xlsx
  Multiple: no

[ ← Back ]  [ Next → ] (disabled until ≥1 contract + 1 billing file)
```

STEP 3 — Review & start:
```
Summary card: audit name / contracts uploaded / billing file
GDPR note: "Files encrypted and stored in Frankfurt, Germany (EU).
             Contract text sent to AI processor for extraction,
             raw text not retained."
[ ← Back ]  [ Start audit →] (forest, prominent)
```

On "Start audit": create job record → upload files → redirect to `/audit/[id]`.

### Audit Results (`app/(dashboard)/audit/[id]/page.tsx`)

STATE A — Processing:
```
Centered loading spinner + cycling message:
"Reading your contracts..."
"Extracting commercial terms..."
"Comparing against billing data..."
"Calculating leakage..."
Poll /api/jobs/[id] every 3s, redirect when status = 'complete'.
```

STATE B — Complete:

TOP SUMMARY BAR (forest bg, white text):
```
[Job name]  ·  [N] contracts  ·  [N] invoices reviewed  ·  [Date]
Total recoverable: $XX,XXX                [Download report]  [Share]
```

FINDINGS TABS:
```
All ([N])  |  CRITICAL ([N])  |  HIGH ([N])  |  Review needed ([N])
```

FINDINGS TABLE (main content):
Columns: Priority · Type · Customer · Period · Contracted · Billed · Leakage · Status · Actions

Priority badges: CRITICAL (danger), HIGH (warn), MEDIUM (mint/forest)
Type pills: ESCALATOR MISS · DISCOUNT OVERHANG · OVERAGE UNBILLED

Row expansion on click:
```
Description paragraph (Inter 400, stone)
Evidence blockquote (JetBrains Mono, parchment bg, forest left border)
Buttons: [Fix via API →]  [Mark as fixed]  [Dismiss]
```

The "Fix via API" button:
- Opens a confirmation modal showing exact billing platform API change proposed
- User confirms → API call fires → finding status → 'fixed'
- Shows billing platform subscription/invoice ID on success

RIGHT SIDEBAR (collapsible) — Extracted contract terms per contract:
```
Customer: [name]
Contract ID: [id]
Base fee: $[amount]/month
Escalators: [list]
Discounts: [list, with expiry dates highlighted]
Overage tiers: [list]
Confidence: [HIGH/MEDIUM/LOW badge]
```

STATE C — Error:
Error icon + message + [Try again] [Contact support]

---

## SECTION 12 — AUTO-CONFIGURE FLOW

### Execute List (`app/(dashboard)/execute/page.tsx`)
Table: Contract name · Customer · Status · Stripe result · Date · Actions
Status pills mirror ContractJob process_status enum.
Floating "+ New Contract" button.

### New Execute (`app/(dashboard)/execute/new/page.tsx`)
```
Two upload options:

OPTION A (primary) — Manual upload:
  UploadZone for signed contract PDF
  [ Upload and process → ]

OPTION B — DocuSign auto (if connected):
  "DocuSign is connected. Contracts will be processed automatically
   when envelopes are completed."
  [ Manage DocuSign connection ]

GDPR note (same as audit).
```

### Execute Results / HITL Review (`app/(dashboard)/execute/[id]/page.tsx`)

STATE A — Processing: same spinner as audit with messages:
"Downloading signed contract..."
"Identifying financial pages..."
"Extracting commercial terms..."
"Proposing billing configuration..."

STATE B — PENDING HUMAN REVIEW (main view):

SPLIT-SCREEN LAYOUT (full viewport height):

LEFT PANEL (50% width) — PDF Viewer:
```
iframe showing signed PDF (signed URL from Supabase Storage, expires 15 min)
PDF viewer controls (zoom, page navigation)
"Click a field on the right to highlight the source clause in the PDF"
```

RIGHT PANEL (50% width) — Verification Form:

Header:
```
[Job name]                              Status: REVIEW REQUIRED
Customer: [extracted name]
Contract: [extracted ID or filename]
```

Line items (one card per extracted item):
```
┌─────────────────────────────────────────────────────────┐
│  Product Description                                    │
│  [Platform License Tier B                            ]  │
│                                                         │
│  Units        Unit Price (USD)    Billing Interval      │
│  [1        ]  [24,000.00      ]   [Annually        ▼]   │
│                                                         │
│  Total: $24,000/year                                    │
│                                                         │
│  ✅ Confidence: 99% — Auto-approved                     │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  Product Description                                    │
│  [API Overage Charges                                ]  │
│                                                         │
│  Units        Unit Price (USD)    Billing Interval      │
│  [metered  ]  [0.020          ]   [Monthly         ▼]   │
│                                                         │
│  ⚠ Confidence: 68% — Please verify                     │
│  "Overage rate extracted from table on page 4 — confirm │
│   $0.02/call matches your contract."                    │
└─────────────────────────────────────────────────────────┘
```

Confidence colour coding:
- ≥95%: green border, ✅ "Auto-approved"
- 70–94%: amber border, ⚠ "Please verify"
- <70%: red border, ❌ "Requires manual entry"

Dynamic TCV calculator (sticky bottom of right panel):
```
Calculated total: $24,000.00/year + metered overages
[!] Calculated total does not match contract TCV [if mismatch]
```

Sticky footer button:
```
[ Approve & Configure Stripe → ]  (forest, full width, disabled if red fields remain)
```
Loading state: "Pushing configuration to Stripe..."
Success: "✅ Stripe subscription created: sub_xxxx  |  View in Stripe →"

STATE C — COMPLETED:
```
Success banner (forest bg):
"Billing configured successfully in Stripe"
Stripe Subscription ID: sub_xxxx  [View in Stripe →]
Customer: [name]  |  Total value: $[amount]

Configured items:
  ✓ Platform License — $24,000/year
  ✓ API Overages — $0.02/call (metered)
```

---

## SECTION 13 — CONTRACT INTELLIGENCE ENGINE (SHARED)

File: `lib/contract-extractor.ts`

This is the core IP. Used by BOTH modules.
Module 1 uses it to extract terms from historical contracts then reconcile vs billing.
Module 2 uses it to extract terms from new contracts then propose billing config.

### ContractTerms TypeScript interface:
```typescript
export interface OverageTier {
  tier_label: string
  from_unit: number | null
  to_unit: number | null
  rate_per_unit: number
  unit_type: string
}

export interface PriceEscalator {
  escalator_pct: number | null
  escalator_type: 'fixed_pct' | 'CPI' | 'CPI_cap' | 'flat_amount'
  effective_date: string | null   // ISO YYYY-MM-DD
  applies_from_year: number | null
  cap_pct: number | null
  description: string
}

export interface Discount {
  discount_pct: number | null
  discount_amount: number | null
  discount_type: 'introductory' | 'volume' | 'negotiated' | 'other'
  start_date: string | null
  end_date: string | null
  duration_months: number | null
  applies_to: string
  description: string
}

export interface ContractTerms {
  // Metadata
  contract_id: string | null
  customer_name: string | null
  vendor_name: string | null
  order_date: string | null
  // Subscription
  contract_start_date: string | null
  contract_end_date: string | null
  contract_term_months: number | null
  auto_renews: boolean | null
  renewal_notice_days: number | null
  // Pricing
  currency: string
  base_monthly_fee: number | null
  base_annual_fee: number | null
  billing_frequency: 'monthly' | 'quarterly' | 'annual' | null
  payment_terms_days: number | null
  included_units: number | null
  included_unit_type: string | null
  year_pricing: Record<string, number> | null   // {"1": 4500, "2": 4635}
  // Complex terms
  escalators: PriceEscalator[]
  discounts: Discount[]
  overage_tiers: OverageTier[]
  // Quality
  extraction_confidence: 'high' | 'medium' | 'low'
  extraction_notes: string | null
}
```

### Claude System Prompt (use verbatim):
```
You are RevLens Contract Intelligence, a specialist in extracting
structured commercial terms from B2B SaaS order forms, MSAs, and SOWs.

YOUR JOB:
Extract every commercial term that could affect billing.
Return structured JSON only. No prose, no markdown fences.

CRITICAL RULES:
1. NEVER invent or infer values not explicitly stated. If not stated, return null.
2. DATES: Always ISO format YYYY-MM-DD.
3. AMOUNTS: Numeric only, no currency symbols. "$4,500.00" → 4500.00
4. ESCALATORS: Extract effective_date AND applies_from_year. Both if possible.
   "3% annual uplift" → escalator_pct: 3.0, type: "fixed_pct"
   "CPI cap 5%" → type: "CPI_cap", cap_pct: 5.0
5. DISCOUNTS: Extract END DATE with extreme care.
   "20% for 6 months" → duration_months: 6, calculate end_date from start.
   If end date is ambiguous, flag in extraction_notes.
6. OVERAGE TIERS: Every boundary precisely.
   "500,001 to 1,000,000 at $0.012" → from_unit: 500001, to_unit: 1000000, rate: 0.012
   "above 1M at $0.008" → from_unit: 1000001, to_unit: null, rate: 0.008
7. MULTI-YEAR: Populate year_pricing {"1": amount, "2": amount} AND base_monthly_fee.
8. CONFIDENCE: "high" = all key terms stated. "medium" = 1-2 inferred.
   "low" = ambiguous core pricing or amendment only.
9. extraction_notes: Flag ANYTHING a human should verify.
10. IGNORE: boilerplate, liability clauses, signature blocks unless they contain pricing.

Return ONLY valid JSON matching the ContractTerms schema.
```

### Few-shot examples (include in user message):
```
EXAMPLE 1 — Escalator:
Contract: "Year 1: $4,500/mo. Year 2: $4,635/mo. 3% escalator from Feb 1, 2025."
Output: { base_monthly_fee: 4500, year_pricing: {"1": 4500, "2": 4635},
  escalators: [{ escalator_pct: 3.0, type: "fixed_pct",
  effective_date: "2025-02-01", applies_from_year: 2,
  description: "3% escalator from Feb 1, 2025" }],
  extraction_confidence: "high" }

EXAMPLE 2 — Expiring discount:
Contract: "Standard rate $3,200/mo. 20% intro discount, Jan-Jun 2024 only.
           From July 1, 2024 standard rate applies."
Output: { base_monthly_fee: 3200,
  discounts: [{ discount_pct: 20.0, type: "introductory",
  start_date: "2024-01-01", end_date: "2024-06-30", duration_months: 6,
  description: "20% intro discount Jan-Jun 2024 only" }],
  extraction_confidence: "high" }

EXAMPLE 3 — Usage overages:
Contract: "Base $6,000/mo includes 500K API calls.
           Tier 1: $0.012/call for 500,001-1,000,000.
           Tier 2: $0.008/call above 1,000,000."
Output: { base_monthly_fee: 6000, included_units: 500000,
  included_unit_type: "API call",
  overage_tiers: [
    { tier_label: "Tier 1", from_unit: 500001, to_unit: 1000000,
      rate_per_unit: 0.012, unit_type: "API call" },
    { tier_label: "Tier 2", from_unit: 1000001, to_unit: null,
      rate_per_unit: 0.008, unit_type: "API call" }],
  extraction_confidence: "high" }

EXAMPLE 4 — Low confidence:
Contract: "Pricing per Schedule A. Effective Q1 2024."
Output: { base_monthly_fee: null, contract_start_date: null,
  extraction_confidence: "low",
  extraction_notes: "No pricing in document — referenced in Schedule A (not provided)" }
```

### Map-Reduce pipeline for large PDFs (Module 2):
For PDFs > 10 pages, use the two-phase approach:
Phase 1 (Map): Send each page to claude-haiku or gpt-4o-mini with:
  "Does this page contain pricing, fees, discounts, or usage tiers? Reply YES or NO."
  Run in parallel. Collect page numbers where answer = YES.
Phase 2 (Reduce): Send only the YES pages to claude-sonnet-4-6 with full extraction prompt.
This cuts cost ~80% and improves accuracy on long documents.

---

## SECTION 14 — BILLING CONNECTOR LAYER (SHARED)

### Module 1: CSV Parser (`lib/billing-parser.ts`)
Parse Stripe/Chargebee CSV exports into BillingRecord[].

Column detection — try each candidate in order:
```typescript
const COLUMN_MAP = {
  invoiceId:    ['id','invoice_id','Invoice ID','charge_id'],
  customerName: ['customer_name','Customer Name','Customer','Description'],
  customerId:   ['customer_id','Customer ID','cus_id'],
  invoiceDate:  ['date','Date','invoice_date','Invoice Date','created'],
  amountBilled: ['amount','Amount','amount_paid','total','Total','net'],
  currency:     ['currency','Currency'],
  status:       ['status','Status','Payment Status'],
  contractRef:  ['contract_id','Contract ID','metadata_contract_id'],
}
```

Amount parsing rules:
- Remove $, €, £, spaces, commas
- Handle accounting negatives: (1000) → -1000
- If value > 100000 AND no decimal → likely cents, divide by 100

Date parsing: try ISO, MM/DD/YYYY, DD.MM.YYYY, Unix timestamp.

Skip: rows with zero amount, rows with negative amounts (credits/refunds).

### Module 1: Reconciliation Engine (`lib/reconciler.ts`)
Three detectors — all deterministic, no AI:

DETECTOR 1 — ESCALATOR_MISS:
- For each escalator in contract: determine effective date
- For each invoice AFTER effective date: check if billed at escalated fee
- Tolerance: ±$0.50 for rounding
- If billed at pre-escalator rate → LEAKAGE finding

DETECTOR 2 — DISCOUNT_OVERHANG:
- For each time-limited discount: determine expiry date
- For each invoice AFTER expiry: check if discounted rate still applied
- Proration guard: skip invoices < 60% of base fee (likely proration not discount)
- If still discounted after expiry → LEAKAGE finding

DETECTOR 3 — OVERAGE_UNBILLED:
- If contract has overage_tiers + included_units:
  - If usage data provided: calculate exact overage due per month
  - If no usage data: check if ANY overage invoices exist
  - If zero overage invoices ever issued → CRITICAL structural flag
- Tiered calculation: Tier1 units × rate1 + Tier2 units × rate2

Customer matching (fuzzy, try in order):
1. Exact name match (case-insensitive)
2. Contract ID reference in billing notes
3. Multi-word fuzzy: strip legal suffixes (LLC, AB, GmbH), check all significant words appear
4. First-word match (≥5 chars, last resort)

Edge cases to handle:
- Multi-currency: flag for review, never auto-convert
- Annual billing: normalize amountBilled / 12 before comparing
- Multi-line-item invoices: group by invoice_id, sum amounts
- Low-confidence contracts: SKIP entirely, add to unmatchedContracts list

### Module 2: Stripe Write-Back (`lib/stripe-writer.ts`)
```typescript
// Create new subscription from approved line items
async function createStripeSubscription(
  customerId: string,
  lineItems: ApprovedLineItem[],
  jobId: string
): Promise<string>  // returns subscription ID

// Fix existing subscription (Module 1 leakage fixes)
async function fixSubscriptionPrice(
  subscriptionId: string,
  newPriceId: string
): Promise<void>

// Remove expired discount
async function removeDiscount(
  subscriptionId: string
): Promise<void>

// Add one-time overage invoice item
async function addOverageInvoiceItem(
  customerId: string,
  amount: number,
  description: string
): Promise<void>
```

Always: Math.round(amount * 100) for Stripe cents conversion.
Always: include metadata.revlens_job_id and metadata.contract_clause for audit trail.

---

## SECTION 15 — API ROUTES

### POST /api/upload
Auth: session required
Body: multipart/form-data — file, jobId, fileType
Action: upload to Supabase Storage at `{userId}/{jobId}/{fileType}/{filename}`
Returns: { fileId, storagePath }

### POST /api/jobs
Auth: session required
Body: { name, module ('AUDIT' | 'EXECUTE'), currency }
Action: create contract_job record
Returns: { jobId }

### GET /api/jobs/[id]
Auth: session required
Returns: job + files + (findings if AUDIT) + (line_items if EXECUTE) + contract_terms

### POST /api/jobs/[id]/audit
Auth: session required
Action (background — use Vercel waitUntil or Supabase Edge Function):
1. Set status → 'extracting'
2. Download each contract PDF from Supabase Storage
3. Extract text with pdf-parse (server-side only)
4. Send to Claude for ContractTerms extraction (Section 13)
5. Save contract_terms to DB
6. Download billing CSV, parse with billing-parser
7. Run reconciler — all 3 detectors
8. Save leakage_findings to DB
9. Update job: status → 'complete', totals, findings_count
Returns: { status: 'processing' } immediately

### POST /api/jobs/[id]/execute
Auth: session required
Action (background):
1. Handled by Supabase Edge Function contract-parser-pipeline
2. This route triggers the Edge Function
Returns: { status: 'processing' } immediately

### POST /api/jobs/[id]/approve
Auth: session required (Module 2 only)
Body: { modifiedLineItems: LineItem[] }
Action:
1. Validate job status === 'PENDING_HUMAN_REVIEW'
2. Lock: status → 'SYNCING_TO_GATEWAY'
3. Delete old line_items, insert approved ones
4. Resolve currency conversion if needed
5. Create Stripe subscription via stripe-writer
6. Update job: status → 'COMPLETED', store stripe subscription ID
Returns: { success, stripeSubscriptionId }

### POST /api/jobs/[id]/fix-finding
Auth: session required (Module 1 only)
Body: { findingId }
Action:
1. Load finding details
2. Based on leakage_type:
   - ESCALATOR_MISS → update Stripe subscription item price
   - DISCOUNT_OVERHANG → remove discount from subscription
   - OVERAGE_UNBILLED → create invoice item for unbilled amount
3. Update finding: status → 'fixed'
4. Log to audit trail
Returns: { success, stripeResult }

---

## SECTION 16 — SUPABASE EDGE FUNCTIONS

These run in Deno. Deploy with `supabase functions deploy [name]`.

### supabase/functions/docusign-ingestion/index.ts

```typescript
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const payload = await req.json()

    // Only process completed envelopes
    if (payload.event !== 'envelope-completed') {
      return new Response(
        JSON.stringify({ message: 'Event ignored' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const envelopeId = payload.data.envelopeId
    const orgId = payload.data.orgId  // must be in DocuSign custom metadata
    const fileName = `${envelopeId}_signed_contract.pdf`

    // Download signed PDF from DocuSign
    const docuSignResponse = await fetch(
      `https://docusign.net${Deno.env.get('DOCUSIGN_ACCOUNT_ID')}/envelopes/${envelopeId}/documents/combined`,
      { headers: { 'Authorization': `Bearer ${Deno.env.get('DOCUSIGN_SYSTEM_TOKEN')}` } }
    )
    if (!docuSignResponse.ok) throw new Error(`DocuSign fetch failed: ${docuSignResponse.status}`)

    const pdfBlob = await docuSignResponse.blob()
    const storagePath = `contracts/${envelopeId}/${fileName}`

    // Upload to private Supabase Storage (EU bucket)
    const { data: storageData, error: storageError } = await supabase.storage
      .from('contract-documents')
      .upload(storagePath, pdfBlob, { contentType: 'application/pdf', upsert: true })
    if (storageError) throw storageError

    // Create job record — MODULE: EXECUTE
    const { data: jobData, error: jobError } = await supabase
      .from('contract_jobs')
      .insert([{
        organization_id: orgId,
        module: 'EXECUTE',
        name: payload.data.envelopeSummary?.emailSubject || fileName,
        status: 'pending',
        execute_status: 'RECEIVED',
      }])
      .select().single()
    if (jobError) throw jobError

    // Create file record
    await supabase.from('job_files').insert([{
      job_id: jobData.id,
      file_type: 'signed_contract',
      storage_path: storageData.path,
      original_filename: fileName,
    }])

    // Trigger parser pipeline asynchronously (fire and forget)
    fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/contract-parser-pipeline`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ contractJobId: jobData.id })
    }).catch(err => console.error('Pipeline trigger failed:', err))

    return new Response(
      JSON.stringify({ success: true, jobId: jobData.id }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err: any) {
    console.error('DocuSign ingestion error:', err.message)
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
```

### supabase/functions/contract-parser-pipeline/index.ts

```typescript
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk'

Deno.serve(async (req: Request) => {
  const { contractJobId } = await req.json()
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY')! })

  try {
    // Get job + pages
    const { data: job } = await supabase
      .from('contract_jobs')
      .select('*, pages:contract_pages(*), files:job_files(*)')
      .eq('id', contractJobId).single()

    await supabase.from('contract_jobs')
      .update({ execute_status: 'PROCESSING_MAP' })
      .eq('id', contractJobId)

    // If pages not yet created, we need to parse the PDF first
    // (For the full implementation, use pdf-parse in a separate function
    //  or pass page text via the trigger payload)
    const pages = job.pages || []

    // PHASE 1 MAP: Filter pages with financial data (cheap + fast)
    let relevantPageIds: number[] = []

    if (pages.length > 0) {
      const filterPromises = pages.map(async (page: any) => {
        if (page.has_financial_data !== null) {
          return page.has_financial_data ? page.page_number : null
        }
        // Use haiku/mini for cheap classification
        const res = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 5,
          messages: [{
            role: 'user',
            content: `Does this page contain pricing, fees, discounts, or usage tiers? Reply YES or NO only.\n\n${page.page_text}`
          }]
        })
        const answer = res.content[0].type === 'text' ? res.content[0].text.trim() : 'NO'
        const hasFinancial = answer.includes('YES')
        await supabase.from('contract_pages').update({ has_financial_data: hasFinancial }).eq('id', page.id)
        return hasFinancial ? page.page_number : null
      })
      const results = await Promise.all(filterPromises)
      relevantPageIds = results.filter(Boolean)
    }

    // PHASE 2 REDUCE: Deep extraction on relevant pages only
    const targetText = pages
      .filter((p: any) => relevantPageIds.includes(p.page_number))
      .map((p: any) => `[PAGE ${p.page_number}]\n${p.page_text}`)
      .join('\n\n')

    // Use full text if no page structure (short contracts)
    const extractionText = targetText || pages.map((p: any) => p.page_text).join('\n\n')

    const SYSTEM_PROMPT = `You are RevLens Contract Intelligence. Extract structured commercial terms.
Return ONLY valid JSON matching this schema. No markdown, no preamble.
Schema: { contract_id, customer_name, vendor_name, order_date, contract_start_date,
contract_end_date, currency, base_monthly_fee, base_annual_fee, billing_frequency,
payment_terms_days, included_units, included_unit_type, year_pricing,
escalators: [{escalator_pct, escalator_type, effective_date, applies_from_year, description}],
discounts: [{discount_pct, discount_type, start_date, end_date, duration_months, description}],
overage_tiers: [{tier_label, from_unit, to_unit, rate_per_unit, unit_type}],
extraction_confidence, extraction_notes }
Rules: null for missing fields. ISO dates. Numeric amounts only. Never invent values.`

    // Also extract line_items for Module 2 HITL display
    const USER_PROMPT = `Extract commercial terms from this contract.
Also return a "line_items" array for each distinct billable item with:
{ product_name, quantity, unit_price, billing_period, total_amount, currency, confidence_score }

CONTRACT TEXT:
${extractionText}`

    const extractionRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: USER_PROMPT }]
    })

    const rawJson = extractionRes.content[0].type === 'text'
      ? extractionRes.content[0].text.trim()
      : '{}'

    const extracted = JSON.parse(rawJson.replace(/^```json?\s*/i, '').replace(/\s*```$/i, ''))

    // Save extracted terms
    await supabase.from('contract_terms').insert([{
      job_id: contractJobId,
      file_id: job.files?.[0]?.id,
      ...extracted,
      escalators: extracted.escalators || [],
      discounts: extracted.discounts || [],
      overage_tiers: extracted.overage_tiers || [],
    }])

    // Save line items for HITL display
    if (extracted.line_items?.length) {
      await supabase.from('line_items').insert(
        extracted.line_items.map((item: any) => ({
          job_id: contractJobId,
          product_name: item.product_name,
          quantity: item.quantity,
          unit_price: item.unit_price,
          billing_period: item.billing_period || 'monthly',
          total_amount: item.total_amount || 0,
          currency: item.currency || extracted.currency || 'USD',
          confidence_score: item.confidence_score || 0.5,
        }))
      )
    }

    // Check if any low-confidence items need human review
    const hasAnomalies = (extracted.line_items || []).some((i: any) => i.confidence_score < 0.85)
      || extracted.extraction_confidence === 'low'
      || extracted.extraction_confidence === 'medium'

    const nextStatus = hasAnomalies ? 'PENDING_HUMAN_REVIEW' : 'SYNCING_TO_GATEWAY'

    await supabase.from('contract_jobs').update({
      execute_status: nextStatus,
      raw_extracted_json: extracted,
      relevant_page_ids: relevantPageIds,
    }).eq('id', contractJobId)

    // Alert if human review needed
    if (hasAnomalies && Deno.env.get('SLACK_REVOPS_WEBHOOK_URL')) {
      await fetch(Deno.env.get('SLACK_REVOPS_WEBHOOK_URL')!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `⚠️ RevLens: Contract requires human review\nJob: ${contractJobId}\nConfidence: ${extracted.extraction_confidence}\nReview: ${Deno.env.get('NEXT_PUBLIC_APP_URL')}/dashboard/execute/${contractJobId}`
        })
      })
    }

    return new Response(JSON.stringify({ success: true, nextStatus }), { status: 200 })
  } catch (err: any) {
    console.error('Parser pipeline error:', err.message)
    await supabase.from('contract_jobs').update({
      execute_status: 'FAILED',
      error_message: err.message
    }).eq('id', contractJobId)
    return new Response(JSON.stringify({ error: err.message }), { status: 500 })
  }
})
```

### supabase/functions/contract-approve/index.ts

```typescript
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@14'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
})

Deno.serve(async (req: Request) => {
  const { contractJobId, modifiedLineItems } = await req.json()
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  try {
    // Guard: only process jobs in PENDING_HUMAN_REVIEW
    const { data: job } = await supabase
      .from('contract_jobs').select('*').eq('id', contractJobId).single()
    if (!job || job.execute_status === 'COMPLETED' || job.execute_status === 'SYNCING_TO_GATEWAY') {
      return new Response(JSON.stringify({ error: 'Job already processed or syncing' }), { status: 400 })
    }

    // Lock
    await supabase.from('contract_jobs')
      .update({ execute_status: 'SYNCING_TO_GATEWAY' }).eq('id', contractJobId)

    // Replace line items with human-verified versions
    await supabase.from('line_items').delete().eq('job_id', contractJobId)

    const stripeItems = []

    for (const item of modifiedLineItems) {
      // Currency conversion if not USD
      let conversionRate = 1.0
      let finalUsdAmount = item.total_amount

      if (item.currency && item.currency !== 'USD') {
        try {
          const forexRes = await fetch(`https://open.er-api.com/v6/latest/USD`)
          const forexData = await forexRes.json()
          const rateToUsd = forexData.rates[item.currency.toUpperCase()]
          if (rateToUsd) {
            conversionRate = 1 / rateToUsd
            finalUsdAmount = parseFloat((item.total_amount * conversionRate).toFixed(2))
          }
        } catch (e) {
          console.warn('Forex conversion failed, using 1:1', e)
        }
      }

      // Save to DB
      await supabase.from('line_items').insert([{
        job_id: contractJobId,
        product_name: item.product_name,
        quantity: item.quantity || 1,
        unit_price: item.unit_price,
        billing_period: item.billing_period,
        total_amount: item.total_amount,
        currency: item.currency || 'USD',
        exchange_rate_used: conversionRate,
        converted_amount: finalUsdAmount,
      }])

      // Build Stripe price
      stripeItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: item.product_name,
            metadata: { revlens_job_id: contractJobId }
          },
          unit_amount: Math.round(finalUsdAmount * 100),  // always cents
          ...(item.billing_period !== 'one_time' && {
            recurring: {
              interval: item.billing_period === 'annually' ? 'year' : 'month'
            }
          })
        },
        quantity: item.quantity || 1,
      })
    }

    // Create Stripe subscription
    // NOTE: In production, look up the actual Stripe customer ID from your CRM
    // or require it to be passed in from the HITL form
    const subscription = await stripe.subscriptions.create({
      customer: job.stripe_customer_id || 'cus_placeholder',
      items: stripeItems,
      metadata: {
        revlens_job_id: contractJobId,
        revlens_module: 'EXECUTE',
      }
    })

    // Mark complete
    await supabase.from('contract_jobs').update({
      execute_status: 'COMPLETED',
      status: 'complete',
      completed_at: new Date().toISOString(),
    }).eq('id', contractJobId)

    return new Response(
      JSON.stringify({ success: true, stripeSubscriptionId: subscription.id }),
      { status: 200 }
    )
  } catch (err: any) {
    await supabase.from('contract_jobs').update({
      execute_status: 'FAILED',
      error_message: `Sync Error: ${err.message}`
    }).eq('id', contractJobId)
    return new Response(JSON.stringify({ error: err.message }), { status: 500 })
  }
})
```

---

## SECTION 17 — GDPR PRIVACY POLICY

File: `app/(marketing)/privacy/page.tsx`
Use this content verbatim. Layout: max-width 720px centered, cream bg.

---
**Privacy Policy** · Last updated: June 2026 · Version 1.0

**1. Who we are**
RevLens is the data controller. Contact: privacy@revlens.io

**2. What data we collect**
Account data (name, email, company) when you register. Contract documents you upload. Billing export files you upload. Usage analytics (pages, features, session duration). Support correspondence.

**3. How we use your data**

| Purpose | Legal basis |
|---|---|
| Providing the RevLens service | Contract performance (Art. 6(1)(b)) |
| Account management | Contract performance |
| Processing uploaded documents | Contract performance |
| Transactional emails | Contract performance |
| Platform reliability | Legitimate interests (Art. 6(1)(f)) |
| Legal compliance | Legal obligation (Art. 6(1)(c)) |

**4. How AI processing works**
The text content of your uploaded contracts is extracted on our servers, then transmitted to an AI language model service over an encrypted connection to identify and extract commercial terms. The AI service processes the text and returns structured data fields. It does not store your contract text after processing. The extracted structured data (not raw text) is stored in our EU-based database. Your original uploaded files are stored in encrypted storage within the European Economic Area.

**5. Where your data is stored**
All data and files stored in Frankfurt, Germany (EU). AI text processing involves transmission to an external service provider located outside the EEA, under standard contractual clauses pursuant to GDPR Chapter V. Raw text is not retained by this provider.

**6. Retention**
All user data deleted within 30 days of account deletion. Audit logs retained 12 months.

**7. Your rights**
Access · Rectification · Erasure · Restriction · Portability · Object · Withdraw consent.
Email: privacy@revlens.io. Response within 30 days.
Lodge complaints with Integritetsskyddsmyndigheten (imy.se).

**8. Cookies**
Essential session cookies only. No advertising or cross-site tracking cookies.

**9. Security**
TLS 1.3 in transit. AES-256 at rest. Row-level security. Access controls. Audit logging.

---

## SECTION 18 — DEPLOYMENT CHECKLIST

Before going live:
- [ ] Supabase project region: eu-central-1 (Frankfurt)
- [ ] Supabase storage bucket: "contract-documents" — Private
- [ ] RLS enabled on all tables
- [ ] Vercel region: fra1 (Frankfurt) in vercel.json
- [ ] All env vars set in Vercel dashboard
- [ ] Google OAuth redirect URI updated to production domain
- [ ] NEXTAUTH_URL updated to production domain
- [ ] Stripe webhook endpoint registered, signing secret set
- [ ] DocuSign Connect webhook registered pointing to /functions/v1/docusign-ingestion
- [ ] pdf-parse imported only in server-side API routes (never in client components)
- [ ] GDPR consent checkbox cannot be bypassed
- [ ] Test full Module 1 flow with synthetic demo data
- [ ] Test full Module 2 flow with a real signed PDF
- [ ] Test Stripe write-back in test mode before live

---

## SECTION 19 — VIBE CODING PROMPTS

Use these to extend the codebase after the initial build:

1. "In lib/contract-extractor.ts, add page-level extraction for tables that span page breaks — stitch adjacent pages before sending to Claude."

2. "In app/(dashboard)/audit/[id]/page.tsx, add a 'Fix All' button that triggers /api/jobs/[id]/fix-finding for all open CRITICAL findings in sequence with a progress indicator."

3. "In supabase/functions/contract-parser-pipeline/index.ts, add Azure Document Intelligence as a pre-processing step before Claude extraction to convert scanned PDFs to text."

4. "In components/dashboard/HITLReviewPanel.tsx, wire the PDF iframe to highlight the source clause when a user clicks on an extracted line item in the right panel."

5. "In lib/reconciler.ts, add a fourth detector: PRORATION_ERROR — detect when mid-contract amendment invoices don't match expected proration calculations."

6. "Add a Chargebee billing parser variant in lib/billing-parser.ts alongside the Stripe parser, with a format selector in the audit upload UI."

7. "In app/(dashboard)/audit/[id]/page.tsx, add an Excel report download button that generates the same format as our existing Revenue_Leakage_Audit.xlsx."

8. "Add a Resend email notification that fires when a Module 1 audit completes — sends the CFO a summary with total leakage found and a link to the findings."
```

---

## SECTION 20 — CHANGES FROM v2.0 (ADDENDUM)

This section documents everything that changed after the original spec was written.
The vibe coding tool must read and apply all items in this section.

---

### 20.1 Product Renamed: RevLens → Verdix

The product is now called **Verdix**. Every occurrence of "RevLens" in generated
code, UI strings, page titles, meta tags, email templates, error messages, and
comments must read "Verdix". Zero exceptions.

Page title: `<title>Verdix — Revenue Intelligence for B2B SaaS</title>`
App name env var: `NEXT_PUBLIC_APP_NAME=Verdix`
Contact email domain: `@verdix.io`
Copyright: `© 2026 Verdix. All rights reserved.`

---

### 20.2 Logo — Verdix SVG Mark (replaces placeholder diamond icon)

Do NOT use any icon library icon for the logo. Use this exact inline SVG
in every location where the logo appears (nav, sidebar, footer, auth pages,
email templates, favicon):

```html
<!-- NAV / standard size (28px) -->
<svg width="28" height="28" viewBox="0 0 28 28" fill="none"
     xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect width="28" height="28" rx="6" fill="#1A3D2B"/>
  <polygon points="8,6 11.5,6 14,20 16.5,6 20,6 17,6 14,17 11,6"
           fill="#FFFFFF"/>
  <circle cx="14" cy="23" r="2" fill="#D4EAD9"/>
</svg>

<!-- SIDEBAR size (20px) -->
<svg width="20" height="20" viewBox="0 0 28 28" fill="none"
     xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="flex-shrink:0">
  <rect width="28" height="28" rx="6" fill="#1A3D2B"/>
  <polygon points="8,6 11.5,6 14,20 16.5,6 20,6 17,6 14,17 11,6"
           fill="#FFFFFF"/>
  <circle cx="14" cy="23" r="2" fill="#D4EAD9"/>
</svg>

<!-- FOOTER size (24px) -->
<svg width="24" height="24" viewBox="0 0 28 28" fill="none"
     xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect width="28" height="28" rx="6" fill="#1A3D2B"/>
  <polygon points="8,6 11.5,6 14,20 16.5,6 20,6 17,6 14,17 11,6"
           fill="#FFFFFF"/>
  <circle cx="14" cy="23" r="2" fill="#D4EAD9"/>
</svg>

<!-- FAVICON (32px square, use as /public/favicon.svg) -->
<svg width="32" height="32" viewBox="0 0 28 28" fill="none"
     xmlns="http://www.w3.org/2000/svg">
  <rect width="28" height="28" rx="6" fill="#1A3D2B"/>
  <polygon points="8,6 11.5,6 14,20 16.5,6 20,6 17,6 14,17 11,6"
           fill="#FFFFFF"/>
  <circle cx="14" cy="23" r="2" fill="#D4EAD9"/>
</svg>
```

Logo description: Dark forest green rounded square (#1A3D2B), white geometric
V with straight angular arms converging to a precise point, small mint dot
(#D4EAD9) at the convergence point. No text, no tagline in the icon.

Wordmark: "Verdix" in Fraunces 300, letter-spacing 0.1em, color #1A3D2B.
On dark backgrounds: white wordmark, mint dot.

---

### 20.3 Module Naming — User-Facing Labels

The internal code enums remain 'BILLING_VERIFICATION' and 'AUTO_CONFIGURE'.
The user-facing names shown in the UI are:

| Internal enum          | User-facing label       | Nav icon        |
|------------------------|-------------------------|-----------------|
| BILLING_VERIFICATION   | Billing verification    | ti-file-check   |
| AUTO_CONFIGURE         | Auto-configure          | ti-bolt         |

Never show "Module 1", "Module 2", "Audit", or "Execute" to the user.
These are internal terms only.

Sidebar navigation labels (exact strings):
- "Billing checks" (list of verification jobs)
- "New verification" (start a new billing check)
- "New contracts" (list of auto-configure jobs)
- "Upload contract" (start a new auto-configure job)

---

### 20.4 Billing Platform Language — Generic, Not Stripe-Specific

Never say "Stripe" alone in user-facing copy. Always use one of:
- "your billing platform" (body copy, descriptions)
- "billing platform (Stripe · Chargebee)" (feature lists, capability descriptions)
- "Stripe · Chargebee · Maxio coming soon" (supported platforms note)

In code: the lib file is `billing-writer.ts` (not `stripe-writer.ts`).
It exports platform-agnostic functions that internally route to Stripe or
Chargebee based on the user's connected platform setting.

The env var remains `STRIPE_SECRET_KEY` for Stripe integration.
Add `CHARGEBEE_API_KEY` and `CHARGEBEE_SITE` for Chargebee.

User's connected platform is stored in `profiles.billing_platform`
(add this column: `TEXT CHECK (billing_platform IN ('stripe','chargebee','maxio'))`).

---

### 20.5 Hero / Marketing Copy — Updated Framing

The hero headline and subheadline have changed from the original spec.
Use these exact strings:

```
Headline:
"Is your billing configured
 exactly as your contracts say?"

Subheadline:
"Verdix reads your signed contracts and checks your billing setup against
 them — surfacing mismatches before they cost you revenue. Then automates
 the setup for every new deal."

Primary CTA: "Check your billing accuracy →"
Secondary CTA: "See how it works"

Supported platforms note (below CTAs, small text):
"Billing platforms supported: Stripe · Chargebee · Maxio coming soon"
```

The stat pills use these exact attributions:
- 3–9% / "Average ARR leakage in B2B SaaS" / "MGI Research / EY"
- $9B+ / "Lost annually across the industry" / "$299B market × 3% floor"
- 73% / "Companies with no automated detection" / "BCG, 2020"

Section labels (NOT "Module 1/2"):
- "Billing verification" (first feature section)
- "Auto-configure" (second feature section)

---

### 20.6 HITL Review Panel — Rich Enterprise Scenario

The default/demo state of the Auto-Configure HITL review panel must use
this realistic enterprise MSA scenario (Ardoq AS), not the simple 3-field
Northgate Capital scenario from v2.0:

**Demo contract:** Ardoq AS · Enterprise MSA · Exhibit A — Commercial Terms

Five extracted clauses displayed in left PDF panel:
1. §3.1 Platform subscription — $18,500/month, 50 named users, Feb 1 2024
2. §3.2 Annual escalator — 3% fixed, Year 2 = $19,055/month from Feb 2025
3. §3.3 Additional seats — $320/user/month above 50 (amber — billing cadence ref unclear)
4. §3.4 Introductory discount — 15% off base fee, months 1–6 (Feb–Jul 2024 only)
5. §3.5 Professional services — $12,000 one-time, ref SOW-2024-01

Five extracted line items in right config panel with confidence scores:
1. Platform subscription — $18,500/month · 50 users · 97% ✅
2. Price escalator Year 2 — $19,055/month from Feb 2025 · 96% ✅
3. Additional named users — $320/user/month above 50 · 74% ⚠ verify billing cadence
4. Intro discount 15% — –$2,775/month · Feb–Jul 2024 only · 99% ✅
5. Onboarding one-time — $12,000 · ref SOW-2024-01 · 61% ❌ SOW not provided

Calculated Year 1 TCV summary bar: $200,325

Confidence colour rules:
- ≥95%: green background + ✅ icon ("X% confidence")
- 70–94%: amber background + ⚠ icon ("X% — please verify")
- <70%: red background + ❌ icon ("X% — requires manual review / SOW not provided")

Status badge: "3 items need review" (amber pill, top right of panel header)

---

### 20.7 Dashboard Mockup Titlebar Strings

In the product UI mockup components shown on the landing page and in the
dashboard, use these exact titlebar strings:
- Revenue leakage dashboard: `verdix — revenue leakage`
- HITL review panel: `verdix — new contract · Ardoq AS`
- Billing verification: `verdix — billing verification`

Never use "revlens" anywhere, including in mockup/demo strings.

---

### 20.8 GDPR Policy — Product Name Update

In the privacy policy page (app/(marketing)/privacy/page.tsx), replace all
"RevLens" with "Verdix". The contact email is `privacy@verdix.io`.
The policy content itself is unchanged from Section 17 of this spec,
except for the product name substitution.

---

### 20.9 Reference Landing Page

The file `index.html` delivered alongside this spec is the authoritative
visual reference for the marketing site. The vibe coding tool should use it
as the design source of truth for:
- Colour application and spacing
- Both product UI mockups (dashboard + HITL panel)
- The flow diagram (how it works section)
- Typography scale and font pairings
- CTA copy and button styles

When building `app/(marketing)/page.tsx`, match `index.html` exactly.
Do not use the Section 7 copy from this spec where it conflicts with
`index.html` — the HTML file is the more recent and authoritative source.

---

### 20.10 File Naming

Rename these files from the v2.0 spec:
- `lib/stripe-writer.ts` → `lib/billing-writer.ts`
- Route `/dashboard/audit/` → `/dashboard/verify/`
- Route `/dashboard/execute/` → `/dashboard/configure/`

Database enum values:
- `'AUDIT'` → `'BILLING_VERIFICATION'`
- `'EXECUTE'` → `'AUTO_CONFIGURE'`

These are breaking changes from v2.0 — if scaffolding from scratch, use
the new names throughout. Do not create both old and new file names.


---

### 20.11 New Landing Page Section — Billing Calculation Breakdown

Add a new section between "How it works" (flow diagram) and "Security" on the
marketing page. This section shows the mathematical derivation of invoice amounts
and leakage figures from contract clauses. It is critical for CFO credibility —
it proves the product does real arithmetic, not just pattern matching.

**Section heading copy:**
```
Label:    "Calculation transparency"
Headline: "Every number traced back to the contract clause that generated it"
Body:     "Verdix doesn't just flag mismatches — it shows the exact arithmetic.
           Every invoice amount, TCV, and leakage figure is derived step by step
           from the signed contract."
```

**Product UI mockup inside the section:**
A full-width browser-chrome mockup (max-width 900px, centered) with titlebar:
`verdix — billing calculation · Ardoq AS · CLR-2024-0031`

The mockup has three sub-panels:

**Panel A — Header bar:**
- Left: "Ardoq AS — Year 1 billing breakdown" + "Feb 1 2024 – Jan 31 2025 · EUR · Enterprise MSA"
- Right: "Verified ✓" green badge + "TCV: $200,325" in mono

**Panel B — Two columns:**

LEFT column header: "Contract terms extracted"
Five rows, each showing term name, clause reference, and extracted value:
```
Base platform fee     §3.1 · 50 named users    $18,500/mo
Introductory discount §3.4 · 15% · months 1–6  –15%
Price escalator       §3.2 · 3% fixed · Feb 25  +3%
Additional seats      §3.3 · above 50 users      $320/seat
Onboarding (one-time) §3.5 · ref SOW-2024-01     $12,000
```

RIGHT column header: "Derived invoice schedule"
Table with columns: Month · Calculation · Invoice · Status

```
Feb 2024      $18,500 – 15% = $15,725           $15,725    ✓ match
Mar–Jul 2024  $18,500 – 15% = $15,725 × 5       $78,625    ✓ match
Aug 2024      $18,500 (disc. expired) ≠ $15,725  $15,725 ⚠  mismatch  ← red row
Sep–Jan 2025  $18,500 × 5 ≠ $15,725 × 5         $78,625 ⚠  mismatch  ← red row
Feb 2024      SOW-2024-01 one-time               $12,000    ✓ match
```

Mismatch rows: red background (#FCEBEB), red text for billed amount.
Match rows: normal background.
Status badges: green "✓ match" / red "mismatch"

**Panel C — Leakage calculation (full width, bottom):**
Header: "Leakage calculation — discount overhang §3.4"

Three metric cards side by side:
```
Card 1 (neutral):  Correct monthly rate (post Aug)  →  $18,500
                   "Base fee · §3.1 · no discount"

Card 2 (red):      Actually billed (Aug–Jan)        →  $15,725
                   "15% still applied — expired §3.4"

Card 3 (green):    Monthly leakage × 6 months       →  $16,650
                   "($18,500 – $15,725) × 6 = $16,650"
```

Forest green summary bar below cards:
- Left: "Total recoverable from Ardoq AS — discount overhang finding"
- Right: "$16,650" in white mono bold

**Styling notes:**
- All calculation strings in JetBrains Mono
- Mismatch rows use #FCEBEB background, #791F1F text
- Contract amounts in forest green (#1A3D2B)
- Billed mismatches in red (#A32D2D)
- Recovery total in forest green summary bar
- Section background: white (bg-white), same as Auto-Configure section

**The purpose of this section:**
This section pre-empts the "how do you calculate that?" objection from CFOs.
It shows that Verdix traces every invoice figure to a specific clause and
performs exact arithmetic — not an estimate or approximation. The mismatch
highlighting in the invoice schedule visually proves the product's core value
proposition in one glance.


---

### 20.12 Learning Layer — Contract Calibration (Tabs-equivalent capability)

This section specifies the complete learning layer for Verdix. It enables the
system to improve extraction accuracy over time based on human corrections made
in the HITL review panel. No model fine-tuning is required — learning is
implemented via correction logging, rule injection into the Claude prompt, and
a user-facing "learned rules" UI.

This is Verdix's equivalent of Tabs' "Contract Calibration" feature.

---

#### 20.12.1 Database Migration — Add to Supabase

Run this as Migration 011 after the existing migrations in Section 4:

```sql
-- Migration 011: Extraction corrections (the learning layer)
CREATE TABLE public.extraction_corrections (
  id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id               UUID REFERENCES public.profiles(id) NOT NULL,
  job_id                UUID REFERENCES public.contract_jobs(id) ON DELETE SET NULL,
  contract_terms_id     UUID REFERENCES public.contract_terms(id) ON DELETE SET NULL,

  -- What the AI extracted (before correction)
  field_name            TEXT NOT NULL,
  extracted_value       JSONB,
  extracted_confidence  NUMERIC(4,3),

  -- What the human corrected it to
  corrected_value       JSONB NOT NULL,
  correction_reason     TEXT,
    -- optional human note, e.g. "applies to base fee only, not add-ons"

  -- Source clause text for future similarity matching
  source_clause_text    TEXT,

  -- Scope: customer-specific or global (cross-customer)
  customer_name         TEXT,
    -- NULL = applies to all contracts for this user
    -- populated = applies only to this customer's contracts

  contract_format       TEXT
    CHECK (contract_format IN ('MSA','SOW','order_form','amendment','NDA','other')),

  -- Whether user opted in to "remember this"
  apply_to_future       BOOLEAN DEFAULT TRUE,

  created_at            TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for fast retrieval
CREATE INDEX idx_corrections_customer
  ON public.extraction_corrections(user_id, customer_name, field_name);

CREATE INDEX idx_corrections_field
  ON public.extraction_corrections(user_id, field_name, created_at DESC);

CREATE INDEX idx_corrections_future
  ON public.extraction_corrections(user_id, apply_to_future)
  WHERE apply_to_future = TRUE;

-- RLS
ALTER TABLE public.extraction_corrections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own_corrections" ON public.extraction_corrections
  FOR ALL USING (auth.uid() = user_id);
```

---

#### 20.12.2 API Route — POST /api/corrections

File: `app/api/corrections/route.ts`

```typescript
// POST /api/corrections
// Called from HITL panel when user edits an extracted field
// Body: {
//   jobId: string
//   contractTermsId: string
//   fieldName: string
//   extractedValue: any
//   extractedConfidence: number
//   correctedValue: any
//   correctionReason?: string
//   sourceClauseText?: string
//   customerName?: string
//   contractFormat?: string
//   applyToFuture: boolean
// }
```

Action:
1. Validate session
2. Insert into extraction_corrections table
3. If applyToFuture is true, immediately invalidate any cached
   prompt context for this user + customer combination
4. Return { correctionId, message: 'Correction saved' }

---

#### 20.12.3 Learning Context Builder — lib/learning-context.ts

```typescript
import { createSupabaseServerClient } from './supabase'

export async function buildLearningContext(
  userId: string,
  customerName: string | null
): Promise<string> {

  const supabase = createSupabaseServerClient()

  // Fetch customer-specific corrections (highest priority)
  const { data: customerCorrections } = customerName
    ? await supabase
        .from('extraction_corrections')
        .select('field_name, extracted_value, corrected_value, correction_reason')
        .eq('user_id', userId)
        .eq('customer_name', customerName)
        .eq('apply_to_future', true)
        .order('created_at', { ascending: false })
        .limit(10)
    : { data: [] }

  // Fetch user-global corrections (lower priority, cross-customer patterns)
  const { data: globalCorrections } = await supabase
    .from('extraction_corrections')
    .select('field_name, extracted_value, corrected_value, correction_reason')
    .eq('user_id', userId)
    .is('customer_name', null)
    .eq('apply_to_future', true)
    .order('created_at', { ascending: false })
    .limit(5)

  const allCorrections = [
    ...(customerCorrections || []),
    ...(globalCorrections || [])
  ]

  if (allCorrections.length === 0) return ''

  const lines = allCorrections.map(c => {
    const reason = c.correction_reason
      ? ` Reason: "${c.correction_reason}".`
      : ''
    return `- Field "${c.field_name}": ` +
           `AI previously extracted ${JSON.stringify(c.extracted_value)}, ` +
           `correct value is ${JSON.stringify(c.corrected_value)}.${reason}`
  })

  const scope = customerName
    ? `${customerName}`
    : 'all contracts for this company'

  return `
LEARNED CORRECTIONS FOR ${scope}:
The finance team has corrected previous extractions.
Apply this logic when extracting the fields below:
${lines.join('\n')}
When you encounter similar clauses, use the corrected values above,
not what a generic reading of the clause would suggest.
`
}
```

---

#### 20.12.4 Updated Extractor — Inject Learning Context

Update `lib/contract-extractor.ts` to inject the learning context:

```typescript
import { buildLearningContext } from './learning-context'

export async function extractContractTerms(
  contractText: string,
  userId: string,
  customerName?: string | null
) {
  // Build learning context from past corrections
  const learningContext = await buildLearningContext(
    userId,
    customerName || null
  )

  // Inject learning context between system prompt rules
  // and few-shot examples
  const FULL_SYSTEM_PROMPT = `
${BASE_SYSTEM_PROMPT}

${learningContext}

${FEW_SHOT_EXAMPLES}
`

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: FULL_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Extract all commercial terms from this contract:\n\n${contractText}`
    }]
  })

  // ... rest of extraction logic unchanged
}
```

The learning context is injected AFTER the base system prompt rules
(so it overrides generic extraction logic) and BEFORE the few-shot examples
(so examples still provide format guidance).

---

#### 20.12.5 HITL Panel — Correction UX

File: `components/dashboard/HITLReviewPanel.tsx`

When a user edits any field in the right panel, show an inline correction
capture UI below the edited field. This must appear immediately on edit,
not as a separate modal.

**Field edit state (appears when user changes a value):**

```
┌─────────────────────────────────────────────────────────────┐
│  Overage tier 1                              ⚠ 74%          │
│                                                             │
│  [  $0.015 / call · 500K–1M              ]  ← user edited  │
│                                                             │
│  Why was the original wrong? (optional)                     │
│  [  Rate is $0.015 not $0.012 — see Annex B  ]             │
│                                                             │
│  ☑ Remember this correction for future Ardoq AS contracts  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

The checkbox text dynamically shows:
- If customerName is known: "Remember this for future [CustomerName] contracts"
- If no customer: "Remember this for all future contracts"

On form submit (Approve & configure billing →):
- For every field that was edited, POST to /api/corrections
- Fire all correction saves in parallel (Promise.all)
- Then fire the billing configuration
- Show success: "Billing configured · N corrections saved for future extractions"

**Confidence badge update after correction:**
Once a field is corrected and saved, replace the amber/red confidence
badge with a green "✓ Corrected" badge. This gives the user visual
confirmation their input was captured.

---

#### 20.12.6 Learned Rules UI

File: `app/(dashboard)/settings/learned-rules/page.tsx`

A dedicated page under Settings showing all learned corrections for the
user's account, grouped by customer and field.

**Page layout:**

```
Settings → Learned rules

Search: [                    ] Filter by customer ▼

─── Ardoq AS  (3 rules) ───────────────────────────────────

  discount_pct
  AI extracted: 20%
  Corrected to: 15% (applies to base fee only, not add-ons)
  Learned: 14 Jun 2025 · from job: Q2 2025 Audit
  [Edit reason]  [Delete rule]

  escalator_type
  AI extracted: "fixed_pct" (3%)
  Corrected to: "CPI_cap" (cap: 5%)
  Learned: 2 Jan 2025
  [Edit reason]  [Delete rule]

─── Global rules (all contracts) (1 rule) ─────────────────

  billing_frequency
  AI extracted: "monthly"
  Corrected to: "annual"
  Reason: "Our contracts say monthly but bill annually — check §4"
  Learned: 15 Mar 2025
  [Edit reason]  [Delete rule]

─────────────────────────────────────────────────────────────
Showing 4 of 4 learned rules · [Clear all rules]
```

**Actions:**
- Edit reason: inline text edit, PATCH /api/corrections/[id]
- Delete rule: DELETE /api/corrections/[id] with confirmation
- Clear all: DELETE /api/corrections (all for this user) with confirmation modal

Add a sidebar link: `[ti-brain]  Learned rules` under Settings section.

---

#### 20.12.7 Showing Learning in Action — Extraction Confidence UI

When an extraction uses a learned correction to improve its output,
show a visual indicator in the HITL panel to build user trust:

```
┌─────────────────────────────────────────────────────────────┐
│  discount_pct                           ✓ Applied 1 rule   │
│                                                             │
│  [  15%  ]                                                  │
│                                                             │
│  ⚡ Corrected from previous extraction (Ardoq AS · Jun 25)  │
│     Original AI extraction was 20% — corrected to 15%      │
└─────────────────────────────────────────────────────────────┘
```

The `⚡ Applied 1 rule` badge (green, small) replaces the confidence
percentage when a learned correction was applied. This is the key UX
moment that demonstrates value — the user sees the system getting
smarter without being told to trust it.

---

#### 20.12.8 Analytics — Learning Dashboard Widget

Add a widget to the main dashboard (app/(dashboard)/dashboard/page.tsx)
showing the learning system's impact:

```
┌────────────────────────────────────────────────────┐
│  Extraction accuracy                               │
│                                                    │
│  Corrections made        14                        │
│  Rules learned           9   (6 customer · 3 global)│
│  Avg confidence (30d)    91%  ↑ from 74% at start  │
│  Last extraction         3 fields auto-corrected   │
└────────────────────────────────────────────────────┘
```

Data source: aggregate from extraction_corrections table joined with
contract_terms confidence scores over time.

This widget is a retention mechanism — it shows the CFO that Verdix
is getting smarter on their contracts specifically, creating switching
cost through accumulated intelligence.

---

#### 20.12.9 Positioning Copy — How to Describe This Feature

Use this copy in the product UI, onboarding, and marketing:

**Feature name:** "Contract intelligence" (not "learning" or "AI training")

**One-line description:**
"Verdix gets smarter on your contracts every time your team
makes a correction. Apply corrections to all future extractions
from the same customer with one click."

**Onboarding tooltip (shown on first HITL correction):**
"Correction saved. Next time we process a contract from this
customer, we'll apply what you just taught us."

**Settings page intro:**
"Every correction your team makes in the review panel teaches
Verdix how your specific contracts are structured. These learned
rules are stored securely in your EU account and applied
automatically to future extractions."

**DO NOT say:**
- "AI training" (implies model fine-tuning, which this is not)
- "Machine learning" (imprecise and overpromises)
- "The AI learned" (anthropomorphises in a way that erodes trust)

**DO say:**
- "We applied your previous correction"
- "Learned from your team's review"
- "Calibrated to your contracts"
- "Your contract intelligence"

---

#### 20.12.10 Implementation Sequence for Vibe Coding Tool

Build the learning layer in this order:

1. Migration 011 (Section 20.12.1) — run in Supabase
2. POST /api/corrections route (20.12.2)
3. lib/learning-context.ts (20.12.3)
4. Update lib/contract-extractor.ts to call buildLearningContext (20.12.4)
5. HITL panel correction UX (20.12.5) — add below each editable field
6. Learned rules settings page (20.12.6)
7. "Applied rule" badge in HITL panel (20.12.7)
8. Analytics widget on dashboard (20.12.8)

Steps 1–4 are backend-only and can be built and tested without UI changes.
Steps 5–8 are UI and can be built in parallel with steps 1–4.

Do NOT build steps 6–8 before steps 1–4 are working end-to-end.
The learning system has no value without the correction data flowing first.


---

### 20.13 New Module — Partner Reconciliation

Implements Gustav's specific insight: companies with partner/reseller/supplier
agreements have no way to verify that invoices received from partners match
what was agreed in the signed partner agreement. This is the mirror image of
Billing Verification — instead of checking what you charge customers, you
check what partners charge you.

**User-facing name:** "Partner reconciliation"
**Internal enum value:** Add to module_type: `'PARTNER_RECON'`
**Nav label:** "Partner reconciliation"
**Nav icon:** ti-receipt

---

#### 20.13.1 Database — Add to module_type enum

```sql
-- Migration 012: Add PARTNER_RECON to module_type enum
ALTER TYPE module_type ADD VALUE 'PARTNER_RECON';
```

Also add a new table for partner invoice line items:

```sql
CREATE TABLE public.partner_invoices (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id            UUID REFERENCES public.contract_jobs(id) ON DELETE CASCADE,
  invoice_reference TEXT NOT NULL,       -- INV-2024-0847
  partner_name      TEXT NOT NULL,       -- Nets A/S
  invoice_date      DATE,
  invoice_amount    DECIMAL(12,2),
  currency          VARCHAR(3) DEFAULT 'EUR',
  status            TEXT DEFAULT 'pending'
    CHECK (status IN ('pending','approved','disputed','partial')),
  dispute_amount    DECIMAL(12,2),
  dispute_reason    TEXT,
  uploaded_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE public.partner_findings (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id            UUID REFERENCES public.contract_jobs(id) ON DELETE CASCADE,
  invoice_id        UUID REFERENCES public.partner_invoices(id),
  finding_type      TEXT NOT NULL
    CHECK (finding_type IN (
      'WRONG_RATE',        -- billed at wrong tier/rate
      'WRONG_VOLUME',      -- calculation uses wrong volume
      'WAIVED_FEE',        -- charged a fee that should be waived
      'DUPLICATE_CHARGE',  -- same item billed twice
      'EXPIRED_RATE',      -- using rate from expired tier
      'INCORRECT_CALC'     -- arithmetic error in invoice
    )),
  description       TEXT NOT NULL,
  agreed_amount     DECIMAL(10,2),
  billed_amount     DECIMAL(10,2),
  discrepancy       DECIMAL(10,2) NOT NULL,
  evidence          TEXT,             -- contract clause reference
  status            TEXT DEFAULT 'open'
    CHECK (status IN ('open','disputed','accepted','resolved')),
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.partner_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_findings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own_partner_invoices" ON public.partner_invoices
  FOR ALL USING (job_id IN (
    SELECT id FROM public.contract_jobs WHERE user_id = auth.uid()
  ));

CREATE POLICY "own_partner_findings" ON public.partner_findings
  FOR ALL USING (job_id IN (
    SELECT id FROM public.contract_jobs WHERE user_id = auth.uid()
  ));
```

---

#### 20.13.2 Folder Structure Addition

```
app/(dashboard)/
  ├── partner/                     # PARTNER RECONCILIATION
  │   ├── page.tsx                 # List of partner recon jobs
  │   ├── new/page.tsx             # Upload partner agreement + invoice
  │   └── [id]/page.tsx            # Partner invoice verification results
```

---

#### 20.13.3 New Wizard — Upload Partner Agreement + Invoice

File: `app/(dashboard)/partner/new/page.tsx`

Three-step wizard:

STEP 1 — Name and partner:
```
Input: "Job name" (e.g. "Nets A/S — May 2024 invoice")
Input: "Partner name" (e.g. "Nets A/S")
Select: "Agreement type"
  Options: Reseller · Payment processor · Technology partner
           Supplier · Distribution · Other
[ Next → ]
```

STEP 2 — Upload files:
```
TWO UPLOAD ZONES:

LEFT — Partner agreement PDF
  Label: "Partner agreement"
  Sub:   "Signed reseller or supplier agreement"
  Accept: .pdf
  Multiple: no

RIGHT — Partner invoice
  Label: "Invoice received"
  Sub:   "PDF or CSV invoice from the partner"
  Accept: .pdf, .csv, .xlsx
  Multiple: no

[ ← Back ]  [ Next → ]
```

STEP 3 — Review and start:
```
Summary + GDPR note (same as other modules)
[ ← Back ]  [ Start reconciliation → ]
```

---

#### 20.13.4 Partner Reconciliation Engine

File: `lib/partner-reconciler.ts`

The partner reconciliation engine works in two phases:

PHASE 1 — Extract partner agreement terms (uses same Claude extractor)
Same ContractTerms schema as other modules. Pay special attention to:
- Fee rates and tier thresholds
- Volume-based discounts or waivers
- Minimum charges and waiver conditions
- Rate effective dates and expiry

PHASE 2 — Parse the partner invoice
Accept PDF or CSV. For PDF: extract text with pdf-parse, then use Claude
to extract structured line items. For CSV: use billing-parser.ts patterns.

Extract per invoice line:
```typescript
interface PartnerInvoiceLine {
  description: string
  quantity: number | null
  unit_rate: number | null
  volume: number | null        // transaction volume, API calls, etc.
  amount_billed: number
  currency: string
  reference: string | null     // line item reference
}
```

PHASE 3 — Diff agreement terms vs invoice lines

Four detectors (deterministic, no AI):

DETECTOR 1 — WRONG_RATE:
If invoice uses rate X but agreement tier threshold puts this volume
in a lower rate bracket → flag discrepancy

DETECTOR 2 — WAIVED_FEE:
If invoice charges a minimum fee but the volume in the period exceeds
the waiver threshold → flag full minimum as overbilled

DETECTOR 3 — DUPLICATE_CHARGE:
If the same description appears twice on the invoice with the same
amount → flag one as potential duplicate

DETECTOR 4 — EXPIRED_RATE:
If invoice references a rate or tier that was superseded by a newer
amendment to the agreement → flag as expired rate used

---

#### 20.13.5 Results Page

File: `app/(dashboard)/partner/[id]/page.tsx`

Top bar (same pattern as billing verification):
```
[Partner name] · [Invoice reference] · [Date] · [Total invoiced]
Total discrepancy: €X,XXX         [Raise dispute]  [Approve invoice]
```

Split-screen view:
- LEFT: Agreement terms extracted (same HITL PDF panel style)
- RIGHT: Invoice line items with diff annotations

Findings table below split-screen:
```
Columns: Type · Description · Agreed · Billed · Discrepancy · Action
```

Two action buttons per finding:
- [Accept] — mark as accepted, don't include in dispute
- [Dispute] — include in dispute letter

Dispute letter generator:
Button: "Generate dispute letter →"
Produces a formal PDF letter addressed to the partner with:
- Invoice reference
- List of disputed line items with contract clause references
- Total disputed amount
- Request for corrected invoice

This is a high-value feature — it turns a finding into an actionable
document the CFO can send to the partner immediately.

---

#### 20.13.6 Sidebar Navigation Addition

Add to dashboard sidebar under a new section:

```
──── PARTNER RECON ────
[receipt]    Partner checks
[plus]       New reconciliation
```

---

#### 20.13.7 Landing Page Copy Reference

The partner reconciliation section on index.html uses this scenario:
- Partner: Nets A/S (payment processor)
- Customer: CoAccept AB (Gustav's company — real validation source)
- Invoice: INV-2024-0847, May 2024
- Agreement: §4.2 — 0.85% processing fee, Tier 2 (above €200K) = 0.72%
- Discrepancy 1: Billed at 0.85% (€2,443) instead of Tier 2 0.72% (€2,069) → €374 overbilled
- Discrepancy 2: Monthly minimum €800 charged despite €287K volume exceeding €100K waiver → €800 overbilled
- Total disputed: €1,174

Use this scenario as the demo/onboarding state for the partner
reconciliation module, as it directly references the real-world
validation from Gustav's customer discovery conversation.

---

### 20.14 Design Partner Programme — Application Page and API

Adds a pre-launch Design Partner acquisition flow to the marketing site
and a backend to capture and store applications.

---

#### 20.14.1 Design Partner Application API Route

File: `app/api/design-partner-apply/route.ts`

```typescript
// POST /api/design-partner-apply
// Body: {
//   name: string
//   email: string
//   company: string
//   billingPlatform: string
//   painDescription: string
//   modulesInterested: string[]  // ['billing_verification','auto_configure','partner_recon']
// }
```

Action:
1. Validate required fields (name, email, company)
2. Store in `design_partner_applications` table (see below)
3. Send confirmation email via Resend to applicant
4. Send notification email to hello@verdix.io
5. Return { success: true, message: 'Application received' }

```sql
-- Migration 013: Design Partner applications table
CREATE TABLE public.design_partner_applications (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name                TEXT NOT NULL,
  email               TEXT NOT NULL UNIQUE,
  company             TEXT NOT NULL,
  billing_platform    TEXT,
  pain_description    TEXT,
  modules_interested  TEXT[] DEFAULT '{}',
  status              TEXT DEFAULT 'pending'
    CHECK (status IN ('pending','contacted','onboarded','declined')),
  notes               TEXT,             -- internal notes from founder
  applied_at          TIMESTAMPTZ DEFAULT NOW()
);
-- No RLS needed — this is admin-only data, accessed via service role key
```

---

#### 20.14.2 Admin View — Design Partner Applications

File: `app/(dashboard)/admin/design-partners/page.tsx`

Protected route — only accessible if `profiles.is_admin = TRUE`.
Add `is_admin BOOLEAN DEFAULT FALSE` to profiles table.

Simple table showing all Design Partner applications:
```
Name · Company · Email · Platform · Modules · Status · Applied · Actions
```

Actions per row:
- [Contact] — marks status → 'contacted', opens email client
- [Onboard] — marks status → 'onboarded', triggers welcome email
- [Decline] — marks status → 'declined'

Notes field: inline editable text per application row.

---

#### 20.14.3 Confirmation Email Template

Sent to applicant on signup (via Resend):

```
Subject: Your Verdix Design Partner application — we'll be in touch

Hi [name],

Thank you for applying to the Verdix Design Partner programme.

We review every application personally and will be in touch within 48 hours
to schedule an introductory call.

What happens next:
1. We will reach out to schedule a 30-minute introductory call
2. We will run your first audit together — live, on your contracts
3. Design Partner pricing is locked in for the lifetime of your account

If you have any questions in the meantime, reply to this email.

— The Verdix team

---
Verdix · Revenue intelligence for B2B SaaS
privacy@verdix.io · verdix.io
```

---

#### 20.14.4 Landing Page Design Partner Section Reference

The Design Partner section on index.html includes:
- Dark forest green (#1A3D2B) card with mint accents
- "DESIGN PARTNER PROGRAMME · LIMITED TO 20 COMPANIES" badge
- Headline: "Become a Verdix Design Partner"
- Three benefit columns: Early access · Direct input on what we build · Preferred pricing, permanently
- Form fields: Full name · Work email · Company · Billing platform (select)
- Textarea: "What's your biggest billing or contract pain right now?"
- Checkbox group: Which modules are most relevant (all three modules)
- Submit button: "Apply to become a Design Partner →"
- Footer note: "Limited to 20 Design Partners · EU companies preferred · No commitment required"

On submit: POST to /api/design-partner-apply. Show inline confirmation on success.
Do NOT redirect — replace form area with personalised confirmation message.
Do NOT redirect — replace button text with confirmation message.

Match index.html exactly for styling. The form is the primary
customer acquisition mechanism for the pre-launch period.

---

#### 20.14.5 Build Sequence Addition

Add these steps to Phase 7 (Settings + polish) in Section 0:

```
29. Partner reconciliation — DB migrations 012 (20.13.1)
30. Partner recon wizard + upload page (20.13.3)
31. Partner reconciler engine — lib/partner-reconciler.ts (20.13.4)
32. Partner recon results page (20.13.5)
33. Design Partner apply API route + DB migration 013 (20.14.1)
34. Design Partner applications admin view (20.14.2)
35. Resend email templates — Design Partner confirmation + founder notification (20.14.3)
```


---

### 20.15 UI Card Design Standards (Visual Refinement — June 2026)

This section overrides any card styling described in Sections 1–19 and
earlier addendum sections. The reference implementation is index.html.

---

#### 20.15.1 Core Card Pattern

All product UI mockup cards — whether showing contract clauses, extracted
config items, or discrepancy findings — follow one consistent pattern:

```
Background:  #FFFFFF (white)
Border:      0.5px solid rgba(26,61,43,0.08)   ← very subtle forest tint
Border-radius: 10px
Padding:     10px 12px
```

DO NOT use coloured backgrounds (green, amber, red) on card surfaces.
Colour is reserved for borders and text only — never fills.

The only exception is the status/confidence border:
- High confidence / match:  border: 0.5px solid rgba(26,61,43,0.08)  (default)
- Needs review (medium):    border: 0.5px solid #FAC775              (amber)
- Error / mismatch:         border: 0.5px solid #F09595              (red)

---

#### 20.15.2 Contract Clause Display (Left Panel)

In the HITL review panel and partner reconciliation panel, contract
clauses extracted from PDFs are displayed as follows:

```html
<!-- Section label above the card -->
<div style="font-size:10px;color:#9CA3AF;margin-bottom:5px">§3.1 Clause name</div>

<!-- Clean white card — no coloured background -->
<div style="padding:10px 12px;background:#fff;border-radius:10px;
            border:0.5px solid rgba(26,61,43,0.08)">
  <div style="font-size:12px;font-weight:500;color:#1C1917;margin-bottom:2px">
    Primary value (e.g. $18,500 / month)
  </div>
  <div style="font-size:11px;color:#6B6660">
    Supporting detail (e.g. 50 named users · Feb 1, 2024)
  </div>
</div>
```

No border-left accent bars. No coloured backgrounds. Section label
in #9CA3AF (light grey) above the card, not inside it.

---

#### 20.15.3 Extracted Config Item Display (Right Panel)

In the HITL review panel, proposed billing configuration items:

```html
<div style="padding:10px 12px;background:#fff;border-radius:10px;
            border:0.5px solid [CONFIDENCE_BORDER]">
  <!-- Header row -->
  <div style="display:flex;justify-content:space-between;
              align-items:center;margin-bottom:4px">
    <div style="font-size:12px;font-weight:500;color:#1C1917">
      Item name
    </div>
    <!-- Confidence indicator — text only, no badge background -->
    <div style="font-size:10px;color:[CONF_COLOR];
                display:flex;align-items:center;gap:3px">
      <i class="ti ti-[CONF_ICON]" style="font-size:10px"></i> XX%
    </div>
  </div>
  <!-- Value in mono -->
  <div style="font-family:'JetBrains Mono',monospace;
              font-size:11px;color:#6B6660">
    $18,500 / month · 50 users
  </div>
  <!-- Warning note — only for medium/low confidence -->
  <div style="font-size:10px;color:[CONF_COLOR];margin-top:4px">
    Warning message here
  </div>
</div>
```

Confidence values:
```
≥95%:  CONF_BORDER = rgba(26,61,43,0.08)  CONF_COLOR = #27500A  ICON = check
70–94%: CONF_BORDER = #FAC775             CONF_COLOR = #BA7517  ICON = alert-triangle
<70%:  CONF_BORDER = #F09595             CONF_COLOR = #A32D2D  ICON = alert-circle
```

---

#### 20.15.4 TCV / Summary Row

The calculated total at the bottom of the right panel:

```html
<div style="padding:12px 14px;border-radius:10px;background:#F5F3EE;
            display:flex;align-items:center;justify-content:space-between;
            margin-bottom:14px">
  <div>
    <div style="font-size:10px;color:#6B6660;margin-bottom:1px">
      Calculated Year 1 TCV
    </div>
    <div style="font-size:9px;color:#9CA3AF">
      Discount months included · onboarding separate
    </div>
  </div>
  <div style="font-family:'JetBrains Mono',monospace;
              font-size:15px;font-weight:500;color:#1A3D2B">
    $200,325
  </div>
</div>
```

Background: parchment (#F5F3EE) — the one exception to white-only cards.
Used only for summary/total rows, never for individual clause or config items.

---

#### 20.15.5 Partner Reconciliation Card Pattern

The partner reconciliation results page uses a two-column layout:

LEFT — Agreement terms (same clause card pattern as 20.15.2)
RIGHT — Invoice discrepancy findings:

```html
<!-- Individual discrepancy item -->
<div style="padding:10px 12px;border-radius:10px;
            background:#FAFAF8;border:0.5px solid rgba(26,61,43,0.08);
            margin-bottom:8px">
  <div style="display:flex;justify-content:space-between;
              align-items:flex-start;margin-bottom:3px">
    <div style="font-size:11px;font-weight:500;color:#1C1917">
      Discrepancy description
    </div>
    <!-- Amount in colour — amber for overcharge, red for wrongly charged -->
    <div style="font-size:11px;font-weight:500;color:#BA7517">–€374</div>
  </div>
  <div style="font-size:10px;color:#9CA3AF">
    Explanation · clause reference
  </div>
</div>

<!-- Dispute total — forest green bar -->
<div style="font-size:11px;color:#D4EAD9;background:#1A3D2B;
            padding:10px 12px;border-radius:10px;
            display:flex;justify-content:space-between;width:100%">
  <span>Total dispute amount</span>
  <span style="font-family:'JetBrains Mono',monospace;
               font-weight:500;color:#fff">€1,174</span>
</div>
```

Action buttons (dispute / approve):
```
Dispute:  background:#1A3D2B  color:#fff   (solid forest, no border)
Approve:  background:#F5F3EE  color:#6B6660 (neutral, no border)
```

No coloured button backgrounds (red, green, amber) — only forest for
primary action, neutral grey for secondary.

---

#### 20.15.6 Panel Background

Left panels (PDF / agreement source): background #FAFAF8 (near-white, very subtle warmth)
Right panels (config / findings): background #FFFFFF (pure white)
Panel separator: border 0.5px solid rgba(26,61,43,0.08)

---

#### 20.15.7 Removed Elements

The following UI patterns from earlier spec sections are superseded
and must NOT be used anywhere in the application:

❌ border-left: 2px solid #1A3D2B accent bars on clause boxes
❌ background:#EAF3DE (green fill) on individual clause cards
❌ background:#FFF3E0 (amber fill) on warning clause cards
❌ background:#FCEBEB (red fill) on error clause cards
❌ Coloured pill/oval badges around finding type labels in tables
   (use plain coloured text instead — see Section 20.3)
❌ Gustav's quote card in the partner reconciliation section
❌ "CoAccept AB" as the demo partner company
   (use "Helios Technologies AB" — see Section 20.13.7)

---

#### 20.15.8 Apply To

These standards apply to:
- HITL review panel (Auto-Configure module)
- Partner reconciliation results panel
- Billing verification findings table
- Calculation breakdown section (Section 20.11)
- Any future product UI mockup components

The index.html file is the authoritative visual reference.
When in doubt, inspect the rendered card styles in index.html.

