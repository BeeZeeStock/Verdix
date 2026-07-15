-- Add ignored flag to pii_entities for permanent whitelist (false positives)
alter table pii_entities add column if not exists ignored boolean not null default false;
create index if not exists pii_entities_ignored_idx on pii_entities(org_id, ignored) where ignored = false;
