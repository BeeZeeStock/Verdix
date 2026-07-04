-- Add user_id to jobs for per-user data isolation.
-- text (not uuid) because Google OAuth sub values are numeric strings.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS user_id text;
CREATE INDEX IF NOT EXISTS jobs_user_id_idx ON jobs (user_id);
