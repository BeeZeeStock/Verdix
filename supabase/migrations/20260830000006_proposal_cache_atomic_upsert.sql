-- Step 16A.1 — atomic per-key write for contract_terms.ai_proposal_cache.
--
-- Production incident (OS-2026-09, 2026-08-26): propose-rule/route.ts
-- previously read the whole ai_proposal_cache JSONB column, merged one
-- cache key into it in JavaScript, and wrote the whole column back. Two
-- rule cards on the same job (e.g. two different service credits) mount
-- and call propose-rule concurrently; each request's JS-side read
-- happened before either request's write landed, so the later write's
-- "whole column" snapshot didn't include the earlier write's key — the
-- earlier key was silently reverted to its pre-request value. Observed
-- live: the Annual Rebate's freshly-computed, correct proposal was
-- overwritten back to its stale pre-fix value by the Invalid Meeting
-- Credit's concurrent write.
--
-- This function makes the read-modify-write atomic at the database row
-- level instead: a single UPDATE statement computing jsonb_set against
-- the CURRENT row value. Postgres serializes concurrent UPDATEs to the
-- same row via ordinary MVCC row locking — the second writer's jsonb_set
-- is computed against the first writer's already-committed value, so two
-- concurrent calls for two different keys can never lose either key. Two
-- concurrent calls for the SAME key still serialize; whichever commits
-- last simply overwrites that one key (last COMMITTED write wins for that
-- key — ordering between two truly concurrent requests is not guaranteed,
-- only that one of them deterministically ends up last — and no unrelated
-- key is ever touched or lost).
--
-- No advisory lock needed — unlike a multi-step balance-check-then-insert
-- operation, this is expressible as one atomic SQL statement, so Postgres's
-- own row-level concurrency control is sufficient.
create or replace function set_proposal_cache_entry(
  p_contract_terms_id uuid,
  p_cache_key text,
  p_cache_entry jsonb
) returns void
language sql
security invoker
set search_path = ''
as $$
  update public.contract_terms
  set ai_proposal_cache = jsonb_set(
    coalesce(ai_proposal_cache, '{}'::jsonb),
    array[p_cache_key],
    p_cache_entry,
    true
  )
  where id = p_contract_terms_id;
$$;

-- Structurally scoped: exactly one hardcoded table (public.contract_terms),
-- exactly one hardcoded column (ai_proposal_cache), exactly one row
-- (WHERE id = $1), exactly one key (ARRAY[$2]) — no dynamic SQL, no
-- caller-supplied table/column names, so this cannot be turned into
-- arbitrary DB mutation regardless of what a caller passes for
-- p_cache_key/p_cache_entry (plain text/jsonb values, never interpreted as
-- identifiers or code).
--
-- security invoker (not definer) — the only caller is app code using the
-- service-role client (supabaseServer), which already bypasses RLS on its
-- own; this function needs no elevated privileges of its own, so it gets
-- none. Locked to service_role only, same as every other privileged RPC
-- in this schema — anon/authenticated must never reach this directly from
-- the browser; the existing authenticated route (propose-rule) is still
-- the only path a client request can take to reach it.
revoke execute on function set_proposal_cache_entry(uuid, text, jsonb) from public;
revoke execute on function set_proposal_cache_entry(uuid, text, jsonb) from anon;
revoke execute on function set_proposal_cache_entry(uuid, text, jsonb) from authenticated;
grant  execute on function set_proposal_cache_entry(uuid, text, jsonb) to service_role;
