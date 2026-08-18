-- Audit trail for document/data deletion — the Privacy Policy promises
-- specific retention windows (90 days for uploaded contracts, 30 days after
-- subscription termination for account data); this table records that the
-- promised deletions actually happened, for both manual (job delete) and
-- scheduled (retention cron) deletion paths.
--
-- Deliberately holds only identifiers, never document content — see
-- lib/deletion-log.ts.
create table if not exists deletion_log (
  id                  uuid primary key default gen_random_uuid(),
  object_id           text not null,        -- storage path or row id being removed
  object_type         text not null,        -- 'contract_pdf' | 'billing_csv' | 'job' | ...
  org_id              uuid,
  reason              text not null,        -- 'manual_delete' | 'retention_expired' | ...
  scheduled_for       timestamptz,          -- when retention policy said this was due
  deleted_at          timestamptz not null default now(),
  storage_removed     boolean not null default false,
  error               text                  -- set if the underlying object couldn't be removed
);

create index on deletion_log (org_id, deleted_at desc);

alter table deletion_log enable row level security;
create policy "service_role_only" on deletion_log for all to service_role using (true) with check (true);
revoke all on deletion_log from anon, authenticated;

-- ── Retention column on jobs — drives the scheduled-deletion cron ───────────
-- document_deleted_at is set once the retention cron removes a job's
-- uploaded document. The cron computes eligibility live from jobs.updated_at
-- rather than a separate "completed at" column — see the cron route's own
-- comment for the reasoning and the retention-policy ambiguity it flags
-- (the Privacy Policy says "90 days after job completion" but doesn't say
-- what happens to a job that never completed, e.g. status FAILED).
alter table jobs add column if not exists document_deleted_at timestamptz;

notify pgrst, 'reload schema';
