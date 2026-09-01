-- Step 17H.4B0D4H1B3 — the atomic re-execution claim and the general
-- billing-hold compare-and-set that the production Model B+ cutover needs.
-- Two new RPCs, both service_role-only, mirroring H1A's own
-- (20260912000001_billing_hold.sql, still unapplied) row-locking/CAS
-- conventions exactly — no advisory lock needed for either: a plain
-- `SELECT ... FOR UPDATE` on the single jobs row being claimed is
-- sufficient and simpler, matching claim_scheduled_invoice/claim_parked_
-- event_fee's own established pattern for jobs-row-level claims.
--
-- Written but NOT applied this session. Confirmed read-only against the
-- live database before writing this file (Step 17H.4B0D4H1B3 §45): neither
-- `jobs.billing_hold` nor any H1A/H1B2 RPC exists live yet — this
-- migration necessarily depends on both (H1A's billing_hold column, H1B2's
-- apply_current_line_item_reconciliation), so all three must be applied,
-- in this chronological order, before any of this session's line-item-
-- reconciliation work becomes live. line_items.superseded_at/fee_id/
-- tier_id/reviewer_corrected_* and the current_line_items view WERE
-- confirmed already live (an earlier migration in this same sequence was
-- applied outside this session) — irrelevant to this file's own two new
-- functions, which touch only `jobs`, but recorded here since it was
-- checked as part of this same audit.
--
-- Step 17H.4B0D4H1B3.1 — amended in place (not layered; reconfirmed
-- read-only, live, immediately before this amendment: none of this file's
-- three functions exist yet — same "safe to amend, never applied"
-- discipline this project has used for every other still-unapplied
-- migration). Two changes:
--   (1) begin_job_reexecution gained a real, previously-missing guard: an
--       existing, WELL-FORMED billing_hold whose reason is already
--       'reexecution' now also refuses the claim, regardless of
--       execute_status. Audited and confirmed as a genuine gap in the
--       original H1B3 draft — that draft only ever checked execute_status
--       (EXTRACTING/APPROVING) and hold MALFORMEDNESS, never whether a
--       DIFFERENT, currently-valid reexecution hold already existed. Once
--       17H.4B0D4H1B3.1 lets non-execute operations (confirm-rule,
--       reconcile-line-items, reviewer PATCH) also establish a temporary
--       reexecution-reason hold on an APPROVED job whose execute_status
--       is NOT EXTRACTING (e.g. READY_TO_APPROVE), the original draft
--       would have let a concurrent execute() claim silently steal and
--       overwrite that hold — exactly the cross-operation race this
--       amendment closes.
--   (2) new function begin_job_configuration_mutation — the identical
--       claim semantics as begin_job_reexecution EXCEPT it never touches
--       execute_status (only execute owns that field); used by every
--       non-execute commercial-mutation surface.
--
-- Step 17H.4B0D4H1B3.3 — amended in place again (reconfirmed read-only,
-- live, immediately before this amendment: still none of this file's
-- functions exist yet). begin_job_reexecution now also refuses a job whose
-- module is not 'AUTO_CONFIGURE' (reason: 'wrong_module') — closes the
-- final cross-module reachability gap the H1B3.2 writer audit found:
-- nothing previously stopped this RPC (or the execute route calling it)
-- from being invoked against a BILLING_VERIFICATION/PARTNER_RECON job's
-- id, since the separation between /execute (AUTO_CONFIGURE) and /audit
-- (BILLING_VERIFICATION, guarded in application code in the same pass)
-- was UI convention only. Deliberately NOT applied to begin_job_
-- configuration_mutation — its callers are not proven AUTO_CONFIGURE-only
-- by contract, and this amendment's scope is specifically the execute/
-- re-execution lifecycle.
--
-- Step 17H.4B0D4H1B3.4 — amended in place again (reconfirmed read-only,
-- live, immediately before this amendment: still none of this file's
-- functions exist yet). Closes the final never-approved AUTO_CONFIGURE
-- gap: both begin_job_reexecution and begin_job_configuration_mutation
-- previously established a durable {reason:'reexecution'} hold ONLY when
-- billing_customer_id was already set — for a never-approved job, the row
-- lock held during the RPC's own transaction was the ONLY protection,
-- gone the instant the transaction committed, and an unresolved
-- reconciliation blocker on that same job left billing_hold NULL,
-- silently passing Approve's own billing_hold gate (which already accepts
-- PENDING_HUMAN_REVIEW as approvable — approve/route.ts's claimForApproval).
-- Both functions now establish real, durable ownership for every
-- AUTO_CONFIGURE job unconditionally (begin_job_configuration_mutation:
-- unconditionally when module='AUTO_CONFIGURE', unchanged/conditional-on-
-- billing_customer_id for every other module). was_previously_approved/
-- previously_approved are renamed has_existing_billing_schedule in both
-- functions' return shape — same underlying fact (billing_customer_id IS
-- NOT NULL), renamed because its ONLY remaining job is deciding a clean
-- outcome's target (schedule_rebuild_required when a schedule already
-- exists to go stale; NULL when there was never one to protect), never
-- whether ownership/reconciliation-safety applies at all.
--
-- ─────────────────────────────────────────────────────────────────────────
-- begin_job_reexecution — closes the exact race documented in the
-- 17H.4B0D4H1B3 spec: execute previously claimed `execute_status =
-- 'EXTRACTING'` in one UPDATE and established `billing_hold` in a
-- LATER, separate UPDATE — leaving a real, externally-observable window
-- where a job reads as EXTRACTING with billing_hold still NULL. The
-- scheduler's own hold-aware claim (claim_scheduled_invoice, H1A) takes a
-- `jobs FOR SHARE` lock and would see exactly that stale NULL during the
-- window, incorrectly proceeding to claim/bill against commercial state
-- that a re-execution has already started overwriting. This function
-- makes the status claim and the hold establishment ONE atomic UPDATE —
-- there is no commit at which EXTRACTING and a stale hold can coexist.
--
-- Status gate: refuses EXTRACTING (already claimed) and APPROVING (a
-- billing attempt is in flight — the execute claim previously ONLY
-- excluded EXTRACTING, meaning a re-execution could begin while an
-- Approve request was still running against the CURRENT commercial
-- terms; both status guards are checked in the SAME locked read as the
-- claim itself). Every other execute_status the application currently
-- uses (PENDING_HUMAN_REVIEW, READY_TO_APPROVE, COMPLETED, FAILED) remains
-- a valid re-execution entry point, unchanged from today's actual
-- behavior (execute/route.ts's prior claim was `.neq('execute_status',
-- 'EXTRACTING')` — every other status was already allowed).
--
-- Hold gate: a non-null billing_hold that fails lib/billing-hold.ts's
-- parseBillingHold (duplicated here in SQL — this function cannot call
-- TypeScript, and both are covered by their own tests) refuses the claim
-- outright, fail-closed, rather than silently establishing a fresh
-- reexecution hold over unreadable prior state. A well-formed prior hold
-- of ANY reason (including reconciliation_blocked/schedule_rebuild_
-- required from an earlier generation) is captured and returned, never
-- discarded — a new re-execution attempt is allowed to supersede it, but
-- the caller needs the exact prior value to restore it correctly if this
-- new attempt fails before committing fresh contract_terms.
--
-- New hold: only established when billing_customer_id IS NOT NULL (a
-- job with no live billing configuration has nothing for a reexecution
-- hold to protect) — {reason:'reexecution', started_at:p_started_at},
-- p_started_at supplied by the caller as this execution attempt's own
-- unique generation identity (never regenerated inside the function,
-- so the caller's own timestamp is exactly what a later CAS call must
-- echo back as its expected value).
create function begin_job_reexecution(
  p_job_id uuid,
  p_started_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_new_hold jsonb;
begin
  select execute_status, billing_hold, billing_customer_id, module
    into v_row
    from public.jobs
    where id = p_job_id
    for update;

  if not found then
    return jsonb_build_object('claimed', false, 'reason', 'not_found');
  end if;

  -- Step 17H.4B0D4H1B3.3 — defense-in-depth mirror of execute/route.ts's
  -- own new module guard, enforced HERE too under the same row lock this
  -- function already holds. The route-level check alone only protects
  -- against today's one caller; this RPC is the actual re-execution
  -- lifecycle primitive, and nothing else stops a future server-side
  -- caller (or a route-level regression) from invoking it directly against
  -- a BILLING_VERIFICATION/PARTNER_RECON job and placing it into
  -- execute_status='EXTRACTING' with a spurious reexecution hold. Checked
  -- before any other gate, zero mutation on rejection. Deliberately NOT
  -- added to begin_job_configuration_mutation (immediately below) — its
  -- callers (confirm-rule, reconcile-line-items, the reviewer PATCH) are
  -- not proven AUTO_CONFIGURE-only by contract, and this task's own scope
  -- is specifically the execute/re-execution lifecycle boundary.
  if v_row.module <> 'AUTO_CONFIGURE' then
    return jsonb_build_object('claimed', false, 'reason', 'wrong_module');
  end if;

  if v_row.execute_status in ('EXTRACTING', 'APPROVING') then
    return jsonb_build_object(
      'claimed', false, 'reason', 'status_conflict',
      'current_execute_status', v_row.execute_status
    );
  end if;

  if v_row.billing_hold is not null and (
    jsonb_typeof(v_row.billing_hold) <> 'object'
    or (v_row.billing_hold->>'reason') is null
    or (v_row.billing_hold->>'reason') not in ('reexecution', 'reconciliation_blocked', 'schedule_rebuild_required')
  ) then
    return jsonb_build_object('claimed', false, 'reason', 'malformed_hold');
  end if;

  -- 17H.4B0D4H1B3.1 — a well-formed, currently-active 'reexecution' hold
  -- means a DIFFERENT operation (another execute attempt, or — since
  -- 17H.4B0D4H1B3.1 — a confirm-rule/reconcile-line-items/reviewer-PATCH
  -- configuration mutation) already owns this job's commercial truth.
  -- execute_status alone cannot detect this for a job whose status isn't
  -- EXTRACTING/APPROVING (e.g. a confirm-rule mutation running against a
  -- READY_TO_APPROVE job) — checked as its own explicit gate, never
  -- folded into the malformed-hold check above.
  if v_row.billing_hold is not null and (v_row.billing_hold->>'reason') = 'reexecution' then
    return jsonb_build_object('claimed', false, 'reason', 'configuration_mutation_in_progress');
  end if;

  -- Step 17H.4B0D4H1B3.4 — UNCONDITIONAL: this function is now only ever
  -- reachable for module='AUTO_CONFIGURE' (the guard immediately above),
  -- so every successful claim establishes real, durable ownership —
  -- regardless of billing_customer_id. Previously this was conditional on
  -- billing_customer_id IS NOT NULL, meaning a never-approved job's claim
  -- left billing_hold NULL after the RPC's own transaction ended — the row
  -- lock this function held was NOT durable ownership beyond that single
  -- transaction, so a second concurrent claim (another execute attempt, or
  -- — since 17H.4B0D4H1B3.1 — a confirm-rule/reconcile/PATCH configuration
  -- mutation) could succeed immediately afterward, and an unresolved
  -- reconciliation blocker on that same never-approved job left billing_
  -- hold NULL too, silently passing Approve's billing_hold gate (Approve's
  -- own claim already accepts PENDING_HUMAN_REVIEW — see approve/route.ts).
  -- billing_customer_id is NOT removed from this function — it still
  -- becomes has_existing_billing_schedule below, the fact that decides
  -- what a CLEAN outcome resolves to (schedule_rebuild_required vs NULL)
  -- once reconciliation completes — but it no longer decides whether
  -- ownership itself is established at all.
  v_new_hold := jsonb_build_object('reason', 'reexecution', 'started_at', p_started_at);

  update public.jobs
    set execute_status = 'EXTRACTING', billing_hold = v_new_hold
    where id = p_job_id;

  return jsonb_build_object(
    'claimed', true,
    'previous_execute_status', v_row.execute_status,
    'previous_billing_hold', v_row.billing_hold,
    'new_billing_hold', v_new_hold,
    'has_existing_billing_schedule', v_row.billing_customer_id is not null
  );
end;
$$;

alter function begin_job_reexecution(uuid, timestamptz) owner to postgres;

revoke execute on function begin_job_reexecution(uuid, timestamptz) from public;
revoke execute on function begin_job_reexecution(uuid, timestamptz) from anon;
revoke execute on function begin_job_reexecution(uuid, timestamptz) from authenticated;
grant  execute on function begin_job_reexecution(uuid, timestamptz) to service_role;

comment on function begin_job_reexecution(uuid, timestamptz) is
  'Atomic re-execution claim (Step 17H.4B0D4H1B3/.1/.3/.4): sets execute_status=EXTRACTING and establishes a reexecution billing_hold in ONE update, for EVERY AUTO_CONFIGURE job (not only ones with billing_customer_id set) — closing both the EXTRACTING-with-NULL-hold window and the never-approved durable-ownership gap. Refuses a job whose module is not AUTO_CONFIGURE, EXTRACTING/APPROVING, any malformed existing hold, and any existing valid reexecution hold. Returns {claimed:false,reason} or {claimed:true, previous_execute_status, previous_billing_hold, new_billing_hold, has_existing_billing_schedule} — the last field decides a CLEAN outcome''s target (schedule_rebuild_required vs NULL), never whether ownership is established.';

-- ─────────────────────────────────────────────────────────────────────────
-- begin_job_configuration_mutation — Step 17H.4B0D4H1B3.1. The identical
-- ownership-claim semantics as begin_job_reexecution immediately above,
-- for every commercial-mutation surface that is NOT execute itself
-- (confirm-rule, reconcile-line-items, and — via the reviewer PATCH's own
-- new wrapper RPC — a reviewer's commercial correction). The ONLY
-- difference from begin_job_reexecution: this function never touches
-- execute_status at all — that field is owned exclusively by execute's
-- own claim/completion writes, and a confirm-rule/reconcile/PATCH
-- operation has no business setting EXTRACTING (which would, among other
-- things, incorrectly suggest a re-extraction is in flight).
--
-- Reuses the SAME 'reexecution' hold reason as its v1 "a commercial
-- configuration mutation is in progress" signal, deliberately, per
-- explicit instruction: the safety semantics are identical ("commercial
-- truth is currently being changed -> no new billing action may start"),
-- and every existing consumer (evaluateBillingGate, the scheduler's own
-- claim RPCs, begin_job_reexecution's own new self-conflict check above)
-- already understands this reason correctly with zero changes required.
-- Widening the hold-reason vocabulary, the TypeScript parser, every route
-- gate, and the scheduler's own logic — just to give this a differently-
-- named reason with byte-for-byte identical behavior everywhere it is
-- read — would be pure surface area with no safety benefit.
--
-- Gates, identical reasoning to begin_job_reexecution: refuses EXTRACTING
-- (an execute is in flight — its own contract_terms rewrite must never
-- race a confirm-rule mutation against the SAME prior contract_terms row)
-- and APPROVING (a billing attempt is in flight against current terms);
-- refuses a malformed existing hold, fail-closed; refuses an existing
-- valid 'reexecution' hold (another commercial-mutation operation, or an
-- execute, already owns the job — checked identically to begin_job_
-- reexecution's own new self-conflict guard, so the race is symmetric in
-- both directions: execute cannot steal a confirm-rule's hold, and a
-- confirm-rule cannot steal execute's, or another confirm-rule's).
--
-- New hold (revised, Step 17H.4B0D4H1B3.4): for an AUTO_CONFIGURE job,
-- ALWAYS established on a successful claim, regardless of billing_
-- customer_id — a never-approved AUTO_CONFIGURE job still needs durable
-- ownership (serializing it against a concurrent execute or another
-- config-mutation claim beyond this transaction's own row lock) AND a
-- real place to record an unresolved reconciliation blocker so Approve's
-- existing billing_hold gate can refuse first approval while commercial
-- reconciliation is unsafe. For every OTHER module, unchanged from
-- H1B3.1: only established when billing_customer_id IS NOT NULL — this
-- pass has no evidence those callers need or expect the new behavior.
-- has_existing_billing_schedule (billing_customer_id IS NOT NULL) is
-- still returned regardless of module or hold outcome — it is the fact a
-- caller's own clean-transition decision (schedule_rebuild_required vs
-- NULL) depends on, never the fact that decides whether a hold exists.
create function begin_job_configuration_mutation(
  p_job_id uuid,
  p_started_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_new_hold jsonb;
begin
  select execute_status, billing_hold, billing_customer_id, module
    into v_row
    from public.jobs
    where id = p_job_id
    for update;

  if not found then
    return jsonb_build_object('claimed', false, 'reason', 'not_found');
  end if;

  if v_row.execute_status in ('EXTRACTING', 'APPROVING') then
    return jsonb_build_object(
      'claimed', false, 'reason', 'status_conflict',
      'current_execute_status', v_row.execute_status
    );
  end if;

  if v_row.billing_hold is not null and (
    jsonb_typeof(v_row.billing_hold) <> 'object'
    or (v_row.billing_hold->>'reason') is null
    or (v_row.billing_hold->>'reason') not in ('reexecution', 'reconciliation_blocked', 'schedule_rebuild_required')
  ) then
    return jsonb_build_object('claimed', false, 'reason', 'malformed_hold');
  end if;

  if v_row.billing_hold is not null and (v_row.billing_hold->>'reason') = 'reexecution' then
    return jsonb_build_object('claimed', false, 'reason', 'configuration_mutation_in_progress');
  end if;

  -- Step 17H.4B0D4H1B3.4 — module now read (added to the locked SELECT
  -- above) specifically to decide THIS: an AUTO_CONFIGURE job always gets
  -- real, durable ownership on a successful claim, regardless of
  -- billing_customer_id — the identical "never-approved still needs a
  -- durable hold" fix begin_job_reexecution just received, since this
  -- function protects the exact same never-approved AUTO_CONFIGURE jobs
  -- from a config-mutation-vs-config-mutation or config-mutation-vs-
  -- execute race. Every OTHER module's behavior is UNCHANGED from H1B3.1
  -- — still conditional on billing_customer_id — per explicit instruction
  -- not to invent new semantics for BILLING_VERIFICATION/PARTNER_RECON
  -- callers this pass has no evidence about.
  v_new_hold := case
    when v_row.module = 'AUTO_CONFIGURE'
    then jsonb_build_object('reason', 'reexecution', 'started_at', p_started_at)
    when v_row.billing_customer_id is not null
    then jsonb_build_object('reason', 'reexecution', 'started_at', p_started_at)
    else null
  end;

  -- The ONE structural difference from begin_job_reexecution: execute_status
  -- is never written here.
  update public.jobs
    set billing_hold = v_new_hold
    where id = p_job_id;

  return jsonb_build_object(
    'claimed', true,
    'previous_billing_hold', v_row.billing_hold,
    'new_billing_hold', v_new_hold,
    'has_existing_billing_schedule', v_row.billing_customer_id is not null
  );
end;
$$;

alter function begin_job_configuration_mutation(uuid, timestamptz) owner to postgres;

revoke execute on function begin_job_configuration_mutation(uuid, timestamptz) from public;
revoke execute on function begin_job_configuration_mutation(uuid, timestamptz) from anon;
revoke execute on function begin_job_configuration_mutation(uuid, timestamptz) from authenticated;
grant  execute on function begin_job_configuration_mutation(uuid, timestamptz) to service_role;

comment on function begin_job_configuration_mutation(uuid, timestamptz) is
  'Atomic ownership claim for non-execute commercial-mutation operations (Step 17H.4B0D4H1B3.1/.4): confirm-rule, reconcile-line-items, reviewer PATCH, terms PATCH, semantic-key/fixed-fee-timing backfills. Identical semantics to begin_job_reexecution except it never writes execute_status. Refuses EXTRACTING/APPROVING, a malformed existing hold, and an existing valid reexecution hold. Establishes a temporary {reason:"reexecution", started_at} hold for every AUTO_CONFIGURE job unconditionally; for every other module, only when billing_customer_id is set (unchanged from H1B3.1). Returns {claimed:false,reason} or {claimed:true, previous_billing_hold, new_billing_hold, has_existing_billing_schedule} — the last field decides a caller''s clean-transition target, never whether a hold was established.';

-- ─────────────────────────────────────────────────────────────────────────
-- replace_billing_hold_if_unchanged — a general compare-and-set, distinct
-- from (and NOT a replacement for) H1A's own clear_billing_hold_if_
-- unchanged: that function's safety contract is deliberately narrow (only
-- ever clears TO null, and only when the caller's expectation is itself a
-- well-formed schedule_rebuild_required hold) — this migration does not
-- touch it, weaken it, or reuse its name, per explicit instruction. This
-- function instead generalizes to an arbitrary expected -> next transition
-- (reexecution -> reconciliation_blocked, reexecution -> schedule_rebuild_
-- required, or a restore back to whatever hold predated a re-execution
-- attempt that failed before committing fresh contract_terms) — every one
-- of which is a real, needed transition H1A's narrow function cannot
-- express. Safe specifically because it is service_role-only (never
-- reachable from any client-facing code path) and because every real
-- caller in this codebase computes BOTH p_expected_hold and p_next_hold
-- itself from a value it already trusts (a prior RPC's own returned hold,
-- or a value read earlier in the SAME request) — never from raw,
-- unvalidated client input. The IS NOT DISTINCT FROM comparison is a full
-- structural JSONB equality check, correctly treating "currently NULL"
-- as a legitimate, matchable expected value (unlike clear_billing_hold_
-- if_unchanged, which deliberately refuses a NULL expectation — this
-- function has no such restriction, since restoring TO a state that
-- happens to itself be null, FROM an expected null, is a real, valid use
-- here: a never-approved job's hold starts and often stays null).
create function replace_billing_hold_if_unchanged(
  p_job_id uuid,
  p_expected_hold jsonb,
  p_next_hold jsonb
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated int;
begin
  update public.jobs
    set billing_hold = p_next_hold
    where id = p_job_id
      and billing_hold is not distinct from p_expected_hold;
  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

alter function replace_billing_hold_if_unchanged(uuid, jsonb, jsonb) owner to postgres;

revoke execute on function replace_billing_hold_if_unchanged(uuid, jsonb, jsonb) from public;
revoke execute on function replace_billing_hold_if_unchanged(uuid, jsonb, jsonb) from anon;
revoke execute on function replace_billing_hold_if_unchanged(uuid, jsonb, jsonb) from authenticated;
grant  execute on function replace_billing_hold_if_unchanged(uuid, jsonb, jsonb) to service_role;

comment on function replace_billing_hold_if_unchanged(uuid, jsonb, jsonb) is
  'General billing_hold compare-and-set (Step 17H.4B0D4H1B3): UPDATE jobs SET billing_hold = p_next_hold WHERE billing_hold IS NOT DISTINCT FROM p_expected_hold. Distinct from H1A''s clear_billing_hold_if_unchanged (narrow, clear-to-null-only) — this is the general primitive used by reexecution->reconciliation_blocked/schedule_rebuild_required transitions and pre-terms-commit hold restoration. service_role only; every caller supplies both hold values from state it already trusts, never raw client input.';

notify pgrst, 'reload schema';
