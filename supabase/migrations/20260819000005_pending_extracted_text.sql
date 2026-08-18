-- Lets execute/route.ts reuse detect-pii/route.ts's PDF-text-extraction result
-- instead of re-extracting the same document via a second Bedrock call.
-- Self-cleaning: written once by detect-pii, read-and-cleared once by execute
-- (see both routes) — this is a short-lived handoff between two steps of the
-- same processing run, not a permanent raw-text store, so it doesn't become
-- a second place unmasked contract text sits at rest indefinitely.
alter table jobs add column if not exists pending_extracted_text text;

notify pgrst, 'reload schema';
