-- contract_terms has always been intended as one canonical row per job
-- (jobs.contract_terms_id is a single FK), but was written via plain
-- .insert() on every extraction with no uniqueness constraint — a
-- re-extraction silently created a second row. confirm-rule's
-- .maybeSingle() query for contract_terms by job_id errors (returns no row)
-- the moment a second row exists, silently breaking every future rule
-- confirmation on that job; propose-rule/interpret-rule's unordered
-- jobs -> contract_terms(...) join can instead serve stale, pre-re-extraction
-- data. Both are fixed alongside this migration by switching execute/audit
-- to upsert-on-job_id and having confirm-rule/propose-rule/interpret-rule
-- fetch via jobs.contract_terms_id explicitly.
--
-- Dry-run (run directly against production via the service-role client
-- before writing this migration, 2026-08-20): 38 contract_terms rows, 38
-- distinct job_ids, ZERO duplicates. The cleanup below is a defensive no-op
-- for the common case, not a response to observed bad data — kept anyway in
-- case a duplicate is created between the dry-run and this migration being
-- applied (both ship in the same deploy, so the window is effectively
-- nonexistent, but the cost of leaving this out is a migration that fails
-- outright if it's ever wrong).
--
-- Only auto-resolves the unambiguous case (jobs.contract_terms_id points at
-- exactly one of the duplicate rows for that job) by deleting the OTHER
-- rows. Anything ambiguous (pointer is null, or points at neither/some other
-- row) is left untouched and reported via RAISE NOTICE — the migration then
-- refuses to add the unique constraint while any such case remains, rather
-- than silently constraining over data it can't safely resolve.
do $$
declare
  ambiguous_count integer;
  rec record;
begin
  -- Resolve the unambiguous case: delete every contract_terms row for a job
  -- EXCEPT the one jobs.contract_terms_id currently points to, but only for
  -- jobs where that pointer actually matches one of that job's rows.
  delete from contract_terms ct
  using jobs j
  where ct.job_id = j.id
    and j.contract_terms_id is not null
    and j.contract_terms_id in (select id from contract_terms ct2 where ct2.job_id = j.id)
    and ct.id <> j.contract_terms_id
    and (select count(*) from contract_terms ct3 where ct3.job_id = j.id) > 1;

  -- Ambiguous case: a job with >1 contract_terms row where the pointer is
  -- null or doesn't match any of them. Report, don't touch.
  select count(*) into ambiguous_count
  from (
    select ct.job_id
    from contract_terms ct
    group by ct.job_id
    having count(*) > 1
  ) dupes
  join jobs j on j.id = dupes.job_id
  where j.contract_terms_id is null
     or j.contract_terms_id not in (select id from contract_terms ct2 where ct2.job_id = j.id);

  if ambiguous_count > 0 then
    for rec in
      select ct.job_id, j.contract_terms_id as pointer, array_agg(ct.id) as row_ids
      from contract_terms ct
      join jobs j on j.id = ct.job_id
      group by ct.job_id, j.contract_terms_id
      having count(*) > 1
        and (j.contract_terms_id is null or j.contract_terms_id not in (select id from contract_terms ct2 where ct2.job_id = ct.job_id))
    loop
      raise notice 'AMBIGUOUS contract_terms duplicate for job_id=%: pointer=%, rows=%. Not auto-resolved — needs manual review before this migration can proceed.', rec.job_id, rec.pointer, rec.row_ids;
    end loop;
    raise exception 'contract_terms_job_id_unique: % ambiguous duplicate job_id(s) found — resolve manually (see NOTICEs above) and re-run this migration.', ambiguous_count;
  end if;
end $$;

alter table contract_terms
  add constraint contract_terms_job_id_unique unique (job_id);
