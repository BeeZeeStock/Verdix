-- Full audit trail for the in-panel AI-assisted rule-interpretation flow.
-- Append-only, one row per revision — mirrors extraction_corrections'
-- append-only convention rather than update-in-place, so a reviewer's prior
-- interpretation is never lost when they change their mind later. Keeps the
-- source clause / reviewer's own words / AI's proposal / final approved
-- rule as four distinct fields rather than collapsing them into one, so
-- Verdix can always show "what the contract said" vs "how we chose to
-- operationalize it" separately.
create table if not exists commercial_rule_interpretations (
  id                          uuid primary key default gen_random_uuid(),
  job_id                      uuid not null references jobs(id) on delete cascade,
  rule_type                   text not null,   -- 'minimum_commitment' | 'escalator' | 'partial_period' | 'meter_mapping'
  contract_unit_type          text,            -- metric name, when scoped to one metric (null for job-level rules)
  revision_number             int not null default 1,
  is_current                  boolean not null default true,
  source_clause                text,
  source_text                 text,
  original_extraction         jsonb,
  reviewer_input               text,
  ai_proposed_interpretation  jsonb,
  approved_interpretation     jsonb not null,
  reviewer_email               text not null,
  reviewer_name                text,
  affected_components          text[] not null default '{}',
  -- Per-component write outcome from confirm-rule's propagation sequence,
  -- e.g. {"contract_terms":"applied","contract_meter_mappings":"applied"} —
  -- lets a partial failure stay visible and retryable instead of silently
  -- reporting "Applied" when only some of the downstream writes succeeded.
  propagation_status          jsonb not null default '{}',
  created_at                  timestamptz not null default now()
);

create index on commercial_rule_interpretations (job_id, rule_type, contract_unit_type, is_current);

alter table commercial_rule_interpretations enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'commercial_rule_interpretations' and policyname = 'service_role_only') then
    create policy "service_role_only" on commercial_rule_interpretations for all using (true) with check (true);
  end if;
end $$;

notify pgrst, 'reload schema';
