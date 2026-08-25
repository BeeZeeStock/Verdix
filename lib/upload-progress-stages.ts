// Purely a client-side progress-label mapping for the new-contract upload
// page (app/(dashboard)/configure/new/page.tsx) — not a real backend
// state machine. 'reading' covers the PDF-to-text extraction sub-step of
// POST /api/jobs/[id]/detect-pii (the slow, Bedrock-backed part — the
// dominant share of that call's duration); 'checking' covers that same
// route's fast, local, non-AI PII-entity pass.
//
// Deliberately only these two — commercial-term extraction never runs on
// THIS page at all (it happens later, in POST /api/jobs/[id]/execute,
// only after the reviewer confirms PII on a different page), so listing
// it here as part of this page's own active sequence would misrepresent
// what this page's processing step actually does.
export type UploadProgressStage = 'reading' | 'checking'

export const UPLOAD_PROGRESS_STAGES: { key: UploadProgressStage; label: string }[] = [
  { key: 'reading',  label: 'Reading agreement' },
  { key: 'checking', label: 'Checking sensitive information' },
]
