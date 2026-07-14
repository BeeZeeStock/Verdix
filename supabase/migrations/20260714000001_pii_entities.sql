-- PII entity library and per-job occurrence tracking
-- Entities are detected at extraction time, reviewed by users, and reused across contracts.
-- RLS follows the same pattern as existing tables: service role bypass, app-layer access control via requireOrg().

create table if not exists pii_entities (
  id             uuid        primary key default gen_random_uuid(),
  org_id         uuid        not null references organizations(id) on delete cascade,
  entity_type    text        not null,  -- 'PERSON','ORG','EMAIL','PHONE','IBAN','VAT_NUMBER','ADDRESS'
  original_value text        not null,
  token          text        not null,  -- e.g. '[PERSON_1]'
  approved       boolean     not null default false,
  source_job_id  uuid        references jobs(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique(org_id, original_value)
);

create table if not exists job_pii_occurrences (
  id               uuid        primary key default gen_random_uuid(),
  job_id           uuid        not null references jobs(id) on delete cascade,
  pii_entity_id    uuid        not null references pii_entities(id) on delete cascade,
  occurrence_count int         not null default 1,
  was_masked       boolean     not null default true,
  detection_source text,       -- 'regex', 'nlp', 'context_pattern', 'library'
  confidence_pct   int,
  created_at       timestamptz not null default now(),
  unique(job_id, pii_entity_id)
);

create index if not exists pii_entities_org_idx      on pii_entities(org_id);
create index if not exists pii_entities_approved_idx on pii_entities(org_id, approved) where approved = true;
create index if not exists job_pii_job_idx           on job_pii_occurrences(job_id);

alter table pii_entities        enable row level security;
alter table job_pii_occurrences enable row level security;

create policy "service role bypass" on pii_entities        for all using (true) with check (true);
create policy "service role bypass" on job_pii_occurrences for all using (true) with check (true);
