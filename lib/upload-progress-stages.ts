// Progress-label mapping for the new-contract upload page (app/(dashboard)/
// configure/new/page.tsx). 'reading' covers the PDF-to-text extraction
// sub-step of POST /api/jobs/[id]/detect-pii (the slow, Bedrock-backed
// part — the dominant share of that call's duration); 'checking' covers
// that same route's fast, local, non-AI PII-entity pass; 'done' is a
// terminal marker meaning both real backend phases have actually
// completed (never set before the detect-pii request itself has resolved
// successfully — see page.tsx's own comment on why).
//
// Step 17A, item 6 — 'reading'->'checking' is now driven by the job's own
// real execute_status ('DETECTING_PII' -> 'CHECKING_PII', polled from
// GET /api/jobs/[id] while the detect-pii POST is in flight), not a fake
// client-side timer inferred from fetch-call boundaries. See
// runProcessing in page.tsx.
//
// Deliberately only these two real backend phases — commercial-term
// extraction never runs on THIS page at all (it happens later, in POST
// /api/jobs/[id]/execute, only after the reviewer confirms PII on a
// different page), so listing it here as part of this page's own active
// sequence would misrepresent what this page's processing step actually
// does.
export type UploadProgressStage = 'reading' | 'checking' | 'done'

export const UPLOAD_PROGRESS_STAGES: { key: 'reading' | 'checking'; label: string }[] = [
  { key: 'reading',  label: 'Reading agreement' },
  { key: 'checking', label: 'Checking sensitive information' },
]
