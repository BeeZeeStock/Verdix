-- Step 17A, item 3 — organization alias handling. A contract can express
-- the same real-world organisation under two different literal strings
-- used interchangeably (e.g. "CoAccept AB" and its short name "Remembill").
-- pii_entities is unique on (org_id, original_value) by design (see
-- 20260714000001_pii_entities.sql) — an alias is a genuinely different
-- string, so it must stay its own row/token, never silently merged into
-- the canonical entity's own span. This column is the smallest additive
-- link that still lets a caller (review UI, masking-completeness check)
-- treat the two rows as referring to the same underlying organisation,
-- without touching the existing uniqueness/token model at all.
--
-- Nullable, self-referencing, ON DELETE SET NULL (not CASCADE) — deleting
-- an alias never touches its canonical entity, and deleting the canonical
-- entity never cascades into deleting its aliases (they simply lose the
-- association, same discipline as source_job_id's own SET NULL above).

alter table pii_entities
  add column if not exists alias_of_entity_id uuid references pii_entities(id) on delete set null;

create index if not exists pii_entities_alias_of_idx
  on pii_entities(alias_of_entity_id) where alias_of_entity_id is not null;

comment on column pii_entities.alias_of_entity_id is
  'When set, this entity is a source alias (a different literal string) of the organisation entity it references — e.g. "Remembill" aliasing "CoAccept AB". Distinct row/token, never merged; used to keep alias masking traceable to its canonical organisation.';

-- Step 17A hardening (review pass 3), item 3 — a persisted alias
-- relationship must not be able to cross tenants, cross entity types, or
-- form a chain (alias-of-an-alias). service-role code (detect-pii/route.ts,
-- execute/route.ts) already can't currently construct any of these states
-- (see those files' own comments), but service-role code must not be the
-- ONLY barrier — a future refactor, a manual DB fix, or a bug must not be
-- able to silently corrupt cross-tenant PII masking.
--
-- Self-reference (alias.id != canonical.id) is a same-row fact, so it's a
-- plain, free, always-enforced CHECK constraint — no trigger needed for
-- this one.
alter table pii_entities
  add constraint pii_entities_alias_not_self
  check (alias_of_entity_id is null or alias_of_entity_id <> id);

-- Tenant match (alias.org_id = canonical.org_id) and type match
-- (alias.entity_type = canonical.entity_type) are cross-row facts that a
-- plain CHECK constraint cannot express (Postgres CHECK constraints may
-- only reference columns of the SAME row). One-hop-only (the referenced
-- canonical must not itself be an alias, in either direction — this row
-- can't point at an alias, and an existing alias can't point at this row
-- once this row itself becomes an alias) is likewise inherently cross-row.
-- A single, narrowly-scoped trigger enforces exactly these three
-- cross-row facts and nothing else — kept as one function, one trigger,
-- rather than splitting the logic across multiple mechanisms.
create or replace function enforce_pii_entity_alias_integrity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_canonical record;
  v_downstream_alias_count int;
begin
  if new.alias_of_entity_id is null then
    return new;
  end if;

  select org_id, entity_type, alias_of_entity_id
    into v_canonical
    from public.pii_entities
    where id = new.alias_of_entity_id;

  if not found then
    -- The FK on alias_of_entity_id already guarantees the row exists at
    -- commit time; this guards the (rare) intra-transaction ordering case
    -- explicitly rather than letting a NULL v_canonical silently pass the
    -- checks below.
    raise exception 'pii_entities.alias_of_entity_id references a row that does not exist: %', new.alias_of_entity_id;
  end if;

  if v_canonical.org_id <> new.org_id then
    raise exception 'pii_entities alias integrity violation: alias % (org %) cannot reference canonical entity % in a different org (%)',
      new.id, new.org_id, new.alias_of_entity_id, v_canonical.org_id;
  end if;

  if v_canonical.entity_type <> new.entity_type then
    raise exception 'pii_entities alias integrity violation: alias % (type %) cannot reference canonical entity % of a different type (%)',
      new.id, new.entity_type, new.alias_of_entity_id, v_canonical.entity_type;
  end if;

  -- One-hop only, direction 1: the row this alias points AT must itself be
  -- a genuine canonical (no alias_of_entity_id), never another alias —
  -- prevents alias -> alias -> canonical chains.
  if v_canonical.alias_of_entity_id is not null then
    raise exception 'pii_entities alias integrity violation: % cannot alias % because % is itself an alias (one-hop chains only)',
      new.id, new.alias_of_entity_id, new.alias_of_entity_id;
  end if;

  -- One-hop only, direction 2: nothing may already be pointing AT this row
  -- as ITS canonical — this row can't simultaneously be a canonical (for
  -- some other alias) and itself become an alias of something else, which
  -- would retroactively create the same kind of chain from the other side.
  select count(*) into v_downstream_alias_count
    from public.pii_entities
    where alias_of_entity_id = new.id;

  if v_downstream_alias_count > 0 then
    raise exception 'pii_entities alias integrity violation: % cannot become an alias — % existing row(s) already reference it as their canonical entity (one-hop chains only)',
      new.id, v_downstream_alias_count;
  end if;

  return new;
end;
$$;

drop trigger if exists pii_entities_alias_integrity on pii_entities;
create trigger pii_entities_alias_integrity
  before insert or update of alias_of_entity_id on pii_entities
  for each row
  execute function enforce_pii_entity_alias_integrity();

NOTIFY pgrst, 'reload schema';
