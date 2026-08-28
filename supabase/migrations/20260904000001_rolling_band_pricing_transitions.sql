-- Step 17C.2 (revised 17C.2a) — persistence for a detected, prospective
-- rolling-window volume-band pricing transition (e.g. Remembill's "if the
-- rolling 3-month average of issued payment requests exceeds the
-- contracted volume, the platform-fee band migrates to the corresponding
-- level from the next contract period, after advance notice").
--
-- A trigger firing must never rewrite the signed agreement or any prior
-- invoice — this table is purely a versioned, prospective record of the
-- detection + its own lifecycle (notice, effective timing). The DETECTION
-- identity of a row (which rolling window produced it, and what it found)
-- is immutable once inserted, protected by a trigger below — the same
-- append/revoke-adjacent discipline this schema already uses for
-- financial facts (operational_input_period_values,
-- candidate_unit_evidence), but lighter: a transition's LIFECYCLE state
-- (notice_status, effective_rule, effective_from, status) is legitimately
-- progressive — detected -> notice confirmed / effective timing resolved
-- (independently, in either order) -> active — and is expected to change
-- over time via ordinary, narrowly-scoped updates, not append/revoke.
-- What must never change is WHICH rolling window produced this detection
-- and what it found.
--
-- Idempotency (17C.2 item 12): (job_id, trigger_metric, trigger_window_end)
-- is the natural identity of "this exact detection event" — two
-- schedulers evaluating the same trigger for the same job/metric/window
-- must resolve to the SAME row, never create a duplicate. Enforced by both
-- a unique constraint and the atomic detect_* RPCs below (advisory-locked,
-- same technique as Step 17C.1b's replace_operational_input_period_value /
-- the credit ledger's reserve_credit_balance).
--
-- 'active' is deliberately NOT a value status can hold in this table — it
-- is always DERIVED at read time from notice_required/notice_status/
-- notice_confirmed_at/effective_rule/effective_from + the caller's own
-- asOf (see lib/rolling-band-transition.ts's resolveTransitionLifecycleStatus)
-- — there is no lazy-write-on-read path to keep synchronized and no way
-- for a stale stored value to disagree with the truth.
--
-- Step 17C.2a additions:
--   effective_rule    — item 1: the typed authority for what "next
--                        contract period"/"effective from" means for THIS
--                        transition. Null until either extraction states it
--                        unambiguously (contract_derived, via
--                        RollingBandMigrationConfig.effective_rule, applied
--                        at detection time — see detect_rolling_band_pricing_transition
--                        below) or a reviewer explicitly resolves it
--                        (reviewer_policy, via resolve_rolling_band_transition_effective_rule).
--                        Always null/non-null in lockstep with effective_from
--                        (see the shape constraint below) — there is no
--                        "we have a date but don't know why" state.
--   'decision_required'/'pricing_required' — new stored status values.
--                        decision_required: notice is settled (confirmed or
--                        not required) but effective_rule/effective_from is
--                        still unresolved — item 1's explicit "do not guess"
--                        state. pricing_required: item 7's durable record of
--                        a rolling average that exceeded every priced band
--                        (e.g. >150,000 -> Offereras) — never activates
--                        until a valid price is configured; no notice/
--                        effective-date question even applies to this row.
--
-- Step 17C.2c addition (revised 17C.2d — see rolling_band_volume_rule_versions
-- below):
--   The volume decision — WHICH CONTRACTED/INCLUDED VOLUME governs future
--   overage once a transition's band is active — is a SEPARATE typed
--   decision from effective_rule/status above: which pricing band applies
--   (and when) is answered by effective_rule/notice/status; the volume is
--   its own, independent commercial fact, never derived automatically from
--   the new band's own upper bound. See lib/types.ts's VolumeTransitionRule.
--   Left unresolved, the fixed-fee/base-platform-fee side of the transition
--   can still activate normally — only the OVERAGE threshold for affected
--   future periods is held (lib/usage-pull.ts skips billing overage for
--   such a period rather than guessing 5,000 or 15,000).
--
-- Step 17C.2d — that decision is itself HISTORICALLY REPLAYABLE: a reviewer
-- changing their mind about which volume rule applies (e.g. band_upper_bound
-- in January, specific_volume=10,000 from March onward) must never rewrite
-- what an already-calculated January period used. Stored as its own
-- append/versioned child table (rolling_band_volume_rule_versions, below)
-- rather than a single mutable column on this table — the smallest
-- extension of the SAME resolved_at/superseded_at effective-history shape
-- already used elsewhere in this schema (e.g. candidate_unit_evidence's
-- own active-window convention), scoped down to exactly two timestamps
-- since a volume rule has no other versioned fields to track.
create table if not exists rolling_band_pricing_transitions (
  id                   uuid primary key default gen_random_uuid(),
  job_id               uuid not null references jobs(id) on delete cascade,
  org_id               uuid not null references organizations(id) on delete cascade,

  -- Detection identity — immutable once inserted (see trigger below).
  trigger_metric       text not null,
  trigger_window_end   date not null,
  trigger_value        numeric not null,
  from_band            jsonb not null,
  to_band              jsonb not null,
  detected_at          timestamptz not null default now(),

  -- Lifecycle — mutable only via the narrowly-scoped RPCs below (the
  -- table's sole write paths besides the initial detect insert).
  notice_required      boolean not null,
  notice_status        text check (notice_status in ('pending', 'confirmed')),
  notice_confirmed_at  timestamptz,
  notice_confirmed_by  text,
  -- Step 17C.2a, item 1 — the typed, provenanced authority for
  -- effective_from. See lib/types.ts's TransitionEffectiveRule.
  effective_rule       jsonb,
  effective_from       date,
  status               text not null default 'pending_notice'
                          check (status in ('pending_notice', 'decision_required', 'pending_effective_date', 'pricing_required')),

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint rolling_band_pricing_transitions_unique_detection
    unique (job_id, trigger_metric, trigger_window_end),
  constraint rolling_band_pricing_transitions_notice_shape check (
    (notice_required = true  and notice_status is not null)
    or
    (notice_required = false and notice_status is null and notice_confirmed_at is null and notice_confirmed_by is null)
  ),
  constraint rolling_band_pricing_transitions_confirmation_shape check (
    (notice_status is distinct from 'confirmed')
    or
    (notice_confirmed_at is not null and notice_confirmed_by is not null)
  ),
  -- Step 17C.2a — effective_rule and effective_from are always resolved
  -- together; there is no state where one is known and the other isn't.
  constraint rolling_band_pricing_transitions_effective_rule_shape check (
    (effective_rule is null) = (effective_from is null)
  ),
  -- Step 17C.2a, item 7 — a pricing_required row is a "no valid price
  -- exists" record, structurally unrelated to the notice/effective-date
  -- question; never persisted with notice_required = true.
  constraint rolling_band_pricing_transitions_pricing_required_shape check (
    status <> 'pricing_required' or notice_required = false
  )
);

create index if not exists rolling_band_pricing_transitions_job_idx
  on rolling_band_pricing_transitions (job_id);

alter table rolling_band_pricing_transitions enable row level security;
create policy "service_role_only" on rolling_band_pricing_transitions
  for all to service_role using (true) with check (true);
revoke all on rolling_band_pricing_transitions from anon, authenticated;

-- Step 17C.2d — the append/versioned history of a transition's volume
-- decision (see this file's own header). Exactly one row has
-- superseded_at is null at any time for a given transition_id (the
-- CURRENTLY effective rule) — enforced by the partial unique index below,
-- the same backstop pattern operational_input_period_values' own
-- "at most one active row" index uses. Historical replay answers "what was
-- the volume rule effective as of instant T" via
-- resolved_at <= T and (superseded_at is null or superseded_at > T) — see
-- lib/rolling-band-migration-pull.ts's resolveVolumeRuleVersionAsOf.
-- rule/resolved_at/superseded_at rows are never updated in place once
-- inserted (only ever superseded_at is set exactly once, by the next
-- version's own insert) — an already-calculated period's asOf replay can
-- never be retroactively changed by a later reviewer decision.
create table if not exists rolling_band_volume_rule_versions (
  id             uuid primary key default gen_random_uuid(),
  transition_id  uuid not null references rolling_band_pricing_transitions(id) on delete cascade,
  job_id         uuid not null references jobs(id) on delete cascade,
  org_id         uuid not null references organizations(id) on delete cascade,
  rule           jsonb not null,
  resolved_at    timestamptz not null default now(),
  superseded_at  timestamptz,
  created_at     timestamptz not null default now()
);

create index if not exists rolling_band_volume_rule_versions_transition_idx
  on rolling_band_volume_rule_versions (transition_id, resolved_at);

-- At most one currently-effective (superseded_at is null) version per
-- transition — the DB-level backstop behind resolve_rolling_band_transition_volume_rule's
-- own advisory lock, exactly like operational_input_period_values' partial
-- unique index for its own "at most one active row" invariant.
create unique index if not exists rolling_band_volume_rule_versions_active_uidx
  on rolling_band_volume_rule_versions (transition_id) where superseded_at is null;

alter table rolling_band_volume_rule_versions enable row level security;
create policy "service_role_only" on rolling_band_volume_rule_versions
  for all to service_role using (true) with check (true);
revoke all on rolling_band_volume_rule_versions from anon, authenticated;

-- Locks the DETECTION identity fields only — notice_status/
-- notice_confirmed_at/notice_confirmed_by/effective_rule/effective_from/
-- status/updated_at remain ordinarily updatable (via the RPCs below),
-- unlike operational_input_period_values' own fully-append-only
-- discipline. A transition's underlying detection (which window, what
-- average, which bands) is a historical fact that must never be
-- rewritten; its lifecycle is legitimately progressive state.
create or replace function prevent_rolling_band_transition_identity_rewrite()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.job_id is distinct from old.job_id
     or new.org_id is distinct from old.org_id
     or new.trigger_metric is distinct from old.trigger_metric
     or new.trigger_window_end is distinct from old.trigger_window_end
     or new.trigger_value is distinct from old.trigger_value
     or new.from_band is distinct from old.from_band
     or new.to_band is distinct from old.to_band
     or new.detected_at is distinct from old.detected_at
     or new.notice_required is distinct from old.notice_required
  then
    raise exception 'rolling_band_pricing_transitions: detection identity fields (job_id, org_id, trigger_metric, trigger_window_end, trigger_value, from_band, to_band, detected_at, notice_required) are immutable once inserted — row %', old.id;
  end if;
  return new;
end;
$$;

create trigger rolling_band_pricing_transitions_identity_immutable
  before update on rolling_band_pricing_transitions
  for each row execute function prevent_rolling_band_transition_identity_rewrite();

-- Idempotent detection of a REAL, priced transition — one of the two
-- insert paths (the other is detect_rolling_band_pricing_required_event
-- below, for the "no valid price" case). Advisory-locked per (job_id,
-- trigger_metric, trigger_window_end), same technique as Step 17C.1b's
-- replace_operational_input_period_value: if a row for this exact
-- detection already exists, it is returned UNCHANGED (never a second row,
-- never an update to the existing one) — two concurrent scheduler runs
-- evaluating the same trigger converge on the same result.
--
-- Step 17C.2a, item 1 — effective_from is NEVER set here, even when
-- p_notice_required is false: initial status is 'pending_notice' when
-- notice is required, else 'decision_required' (never 'pending_effective_date'
-- — that would falsely claim a timing authority nothing has established
-- yet). p_effective_rule/p_effective_from let a CONTRACT-DERIVED rule
-- (RollingBandMigrationConfig.effective_rule) resolve timing immediately
-- at detection, exactly like a reviewer would via
-- resolve_rolling_band_transition_effective_rule — both null is the
-- common case today (no extraction path populates this yet).
--
-- Step 17C.2c — p_volume_transition_rule is the SAME kind of optional
-- contract-derived shortcut, for the separate volume decision
-- (RollingBandMigrationConfig.volume_transition_rule). Independent of
-- p_effective_rule: a contract can state one, both, or neither explicitly.
-- Step 17C.2d — when given, it becomes this transition's FIRST version row
-- in rolling_band_volume_rule_versions (resolved_at = now(), never
-- superseded) rather than a column on this table — see that table's own
-- header. Only written on the actual insert path (never on the idempotent
-- "already detected, return existing" path below), so re-running detection
-- for an already-detected window never creates a duplicate version.
create or replace function detect_rolling_band_pricing_transition(
  p_job_id uuid, p_org_id uuid, p_trigger_metric text, p_trigger_window_end date,
  p_trigger_value numeric, p_from_band jsonb, p_to_band jsonb, p_notice_required boolean,
  p_effective_rule jsonb default null, p_effective_from date default null,
  p_volume_transition_rule jsonb default null
) returns rolling_band_pricing_transitions
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.rolling_band_pricing_transitions;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    p_job_id::text || '|' || p_trigger_metric || '|' || p_trigger_window_end::text, 0
  ));

  select * into v_row from public.rolling_band_pricing_transitions
  where job_id = p_job_id and trigger_metric = p_trigger_metric and trigger_window_end = p_trigger_window_end;

  if found then
    return v_row;
  end if;

  insert into public.rolling_band_pricing_transitions (
    job_id, org_id, trigger_metric, trigger_window_end, trigger_value, from_band, to_band,
    notice_required, notice_status, effective_rule, effective_from, status
  ) values (
    p_job_id, p_org_id, p_trigger_metric, p_trigger_window_end, p_trigger_value, p_from_band, p_to_band,
    p_notice_required,
    case when p_notice_required then 'pending' else null end,
    p_effective_rule, p_effective_from,
    case
      when p_notice_required then 'pending_notice'
      when p_effective_rule is not null then 'pending_effective_date'
      else 'decision_required'
    end
  )
  returning * into v_row;

  if p_volume_transition_rule is not null then
    insert into public.rolling_band_volume_rule_versions (transition_id, job_id, org_id, rule, resolved_at)
    values (v_row.id, p_job_id, p_org_id, p_volume_transition_rule, now());
  end if;

  return v_row;
end;
$$;

revoke execute on function detect_rolling_band_pricing_transition(uuid, uuid, text, date, numeric, jsonb, jsonb, boolean, jsonb, date, jsonb) from public;
revoke execute on function detect_rolling_band_pricing_transition(uuid, uuid, text, date, numeric, jsonb, jsonb, boolean, jsonb, date, jsonb) from anon;
revoke execute on function detect_rolling_band_pricing_transition(uuid, uuid, text, date, numeric, jsonb, jsonb, boolean, jsonb, date, jsonb) from authenticated;
grant  execute on function detect_rolling_band_pricing_transition(uuid, uuid, text, date, numeric, jsonb, jsonb, boolean, jsonb, date, jsonb) to service_role;

-- Step 17C.2a, item 7 — the OTHER insert path: a rolling average that
-- triggered the upward rule but resolved to a band with no configured
-- numeric price ("Offereras"/quote required, e.g. >150,000). Same
-- idempotent advisory-lock/identity pattern as detect_rolling_band_pricing_transition
-- (shares the same unique-detection constraint — at most one row per
-- (job, metric, window) regardless of which of the two RPCs created it,
-- since the two outcomes are mutually exclusive for the same window).
-- notice_required is always false here: there is no notice question for a
-- transition that has no valid price to notice anyone about.
create or replace function detect_rolling_band_pricing_required_event(
  p_job_id uuid, p_org_id uuid, p_trigger_metric text, p_trigger_window_end date,
  p_trigger_value numeric, p_from_band jsonb, p_proposed_band jsonb
) returns rolling_band_pricing_transitions
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.rolling_band_pricing_transitions;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    p_job_id::text || '|' || p_trigger_metric || '|' || p_trigger_window_end::text, 0
  ));

  select * into v_row from public.rolling_band_pricing_transitions
  where job_id = p_job_id and trigger_metric = p_trigger_metric and trigger_window_end = p_trigger_window_end;

  if found then
    return v_row;
  end if;

  insert into public.rolling_band_pricing_transitions (
    job_id, org_id, trigger_metric, trigger_window_end, trigger_value, from_band, to_band,
    notice_required, notice_status, status
  ) values (
    p_job_id, p_org_id, p_trigger_metric, p_trigger_window_end, p_trigger_value, p_from_band, p_proposed_band,
    false, null, 'pricing_required'
  )
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function detect_rolling_band_pricing_required_event(uuid, uuid, text, date, numeric, jsonb, jsonb) from public;
revoke execute on function detect_rolling_band_pricing_required_event(uuid, uuid, text, date, numeric, jsonb, jsonb) from anon;
revoke execute on function detect_rolling_band_pricing_required_event(uuid, uuid, text, date, numeric, jsonb, jsonb) from authenticated;
grant  execute on function detect_rolling_band_pricing_required_event(uuid, uuid, text, date, numeric, jsonb, jsonb) to service_role;

-- Step 17C.2a — notice confirmation, now decoupled from effective-timing
-- resolution (previously one combined RPC set both at once; item 1/2
-- require them to be independently provable facts — notice_confirmed_at
-- must be comparable against whatever effective_from a LATER or EARLIER
-- resolve_rolling_band_transition_effective_rule call establishes, not
-- assumed simultaneous with it). Re-checks notice_status = 'pending' at
-- the moment of write so a concurrent double-confirm matches zero rows
-- rather than clobbering the first confirmation's own confirmed_at/by.
create or replace function confirm_rolling_band_transition_notice(
  p_transition_id uuid, p_confirmed_by text
) returns rolling_band_pricing_transitions
language sql
security invoker
set search_path = ''
as $$
  update public.rolling_band_pricing_transitions
  set notice_status = 'confirmed', notice_confirmed_at = now(), notice_confirmed_by = p_confirmed_by,
      status = case when effective_from is not null then 'pending_effective_date' else 'decision_required' end,
      updated_at = now()
  where id = p_transition_id and notice_status = 'pending'
  returning *;
$$;

revoke execute on function confirm_rolling_band_transition_notice(uuid, text) from public;
revoke execute on function confirm_rolling_band_transition_notice(uuid, text) from anon;
revoke execute on function confirm_rolling_band_transition_notice(uuid, text) from authenticated;
grant  execute on function confirm_rolling_band_transition_notice(uuid, text) to service_role;

-- Step 17C.2a, item 1 — resolves the typed effective-timing authority for
-- a transition. p_effective_rule/p_effective_from are computed by the
-- CALLER (lib/rolling-band-migration-pull.ts's compileTransitionEffectiveRule
-- + resolveEffectiveDateFromRule, via the existing cadence/renewal-window
-- machinery — never guessed here, never a raw "add 1 month"). Allowed to
-- be called more than once (a reviewer may change their mind about which
-- rule applies) — but ONLY while the transition has not yet reached its
-- own effective date, per the guard below: once a resolved effective_from
-- has actually arrived, silently rewriting it would be exactly the kind
-- of retroactive change to an already-active transition's own timeline
-- this whole design forbids. A no-op (0 rows) past that point signals the
-- caller to surface a real error instead of silently reinterpreting an
-- already-effective transition.
create or replace function resolve_rolling_band_transition_effective_rule(
  p_transition_id uuid, p_effective_rule jsonb, p_effective_from date
) returns rolling_band_pricing_transitions
language sql
security invoker
set search_path = ''
as $$
  update public.rolling_band_pricing_transitions
  set effective_rule = p_effective_rule, effective_from = p_effective_from,
      status = case
        when notice_required and notice_status is distinct from 'confirmed' then 'pending_notice'
        else 'pending_effective_date'
      end,
      updated_at = now()
  where id = p_transition_id
    and status <> 'pricing_required'
    and (effective_from is null or effective_from > current_date)
  returning *;
$$;

revoke execute on function resolve_rolling_band_transition_effective_rule(uuid, jsonb, date) from public;
revoke execute on function resolve_rolling_band_transition_effective_rule(uuid, jsonb, date) from anon;
revoke execute on function resolve_rolling_band_transition_effective_rule(uuid, jsonb, date) from authenticated;
grant  execute on function resolve_rolling_band_transition_effective_rule(uuid, jsonb, date) to service_role;

-- Step 17C.2c (revised 17C.2d) — resolves the SEPARATE, independent volume
-- decision (see rolling_band_volume_rule_versions' own header). p_volume_rule
-- is computed by the CALLER (lib/rolling-band-migration-pull.ts's
-- compileVolumeTransitionRule) — never a formula evaluated here.
--
-- Step 17C.2d — no longer an in-place UPDATE: supersedes whichever version
-- is currently active (superseded_at is null) and APPENDS a new one,
-- exactly like Step 17C.1b's replace_operational_input_period_value does
-- for operational_input_period_values — an already-calculated period's
-- historical asOf replay must keep seeing whatever rule was active back
-- then, never the reviewer's later correction. Advisory-locked per
-- transition_id so two concurrent resolutions can never both supersede the
-- same active version and insert two "active" rows at once (the partial
-- unique index is the DB-level backstop behind this lock, not a substitute
-- for it).
--
-- No time-based guard on the RESOLUTION itself (unlike
-- resolve_rolling_band_transition_effective_rule): this never feeds a
-- pre-built schedule (lib/rolling-band-schedule-reconciliation.ts never
-- reads it — the base platform fee is entirely unaffected by this rule) —
-- it only governs future, not-yet-computed overage line items, so a
-- reviewer correcting their choice after the pricing band is already
-- active is always safe: superseding only ever changes what a FUTURE
-- overage calculation resolves to (asOf >= this new version's own
-- resolved_at), never an already-invoiced amount or an earlier asOf
-- replay. Blocked for a pricing_required row (never a real transition to
-- attach a volume decision to).
create or replace function resolve_rolling_band_transition_volume_rule(
  p_transition_id uuid, p_volume_rule jsonb
) returns rolling_band_volume_rule_versions
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job_id uuid;
  v_org_id uuid;
  v_row public.rolling_band_volume_rule_versions;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_transition_id::text, 0));

  select job_id, org_id into v_job_id, v_org_id from public.rolling_band_pricing_transitions
  where id = p_transition_id and status <> 'pricing_required';

  if v_job_id is null then
    return null;
  end if;

  update public.rolling_band_volume_rule_versions
  set superseded_at = now()
  where transition_id = p_transition_id and superseded_at is null;

  insert into public.rolling_band_volume_rule_versions (transition_id, job_id, org_id, rule, resolved_at)
  values (p_transition_id, v_job_id, v_org_id, p_volume_rule, now())
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function resolve_rolling_band_transition_volume_rule(uuid, jsonb) from public;
revoke execute on function resolve_rolling_band_transition_volume_rule(uuid, jsonb) from anon;
revoke execute on function resolve_rolling_band_transition_volume_rule(uuid, jsonb) from authenticated;
grant  execute on function resolve_rolling_band_transition_volume_rule(uuid, jsonb) to service_role;
