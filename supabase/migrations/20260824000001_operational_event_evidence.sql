-- Step 13 — operational event evidence. Answers "did the required
-- real-world event actually happen?", a structurally different question
-- from commercial_rule_interpretations (which records reviewer INTERPRETATION
-- decisions about what the contract means — see that table's own header
-- comment). Deliberately a new, dedicated, minimal table: audited existing
-- persistence (jobs, contract_terms, commercial_rule_interpretations,
-- sync_events, usage_ledger) and none of them represent "an operational
-- fact occurred, on this date, attested by this authority" — usage_ledger
-- is Verdix's own SaaS metering, sync_events is agreement-sync accounting,
-- neither is about a customer contract's one-time-fee billability trigger.
--
-- subject_id addresses a specific OneTimeFee via its stable fee_id
-- (lib/types.ts's OneTimeFee.fee_id, added alongside this migration) —
-- never fee_label, which Step 11 already documented as collision-prone
-- (lib/rulebook/MILESTONE_BILLING_FINDINGS.md). Building a registry keyed
-- to a display label would compound that known risk; fee_id is assigned
-- once, at extraction normalization time, for any fee that enters the
-- Step 12 BillabilityCondition lifecycle.
create table if not exists operational_event_evidence (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  job_id       uuid not null references jobs(id) on delete cascade,
  subject_id   text not null,
  event_type   text not null check (event_type in (
    'contract_signature', 'delivery', 'customer_acceptance', 'final_acceptance', 'change_order_signature'
  )),
  -- When the real-world event happened, per the attesting reviewer —
  -- distinct from recorded_at (when Verdix learned about it). Validated at
  -- the application layer against an explicit server asOf — never in the
  -- future relative to when it's recorded.
  occurred_at  timestamptz not null,
  -- 'reviewer_attestation' is the only source Step 13 lets any route mint.
  -- 'trusted_system_event' exists in the closed set for a future
  -- e-signature/CRM/ERP integration (Step 13 item 25) but has no writer —
  -- no application code path can construct one; enforced structurally by
  -- there being no route that accepts a source value from a caller at all
  -- (see app/api/jobs/[id]/operational-events/attest/route.ts).
  source       text not null check (source in ('reviewer_attestation', 'trusted_system_event')),
  recorded_at  timestamptz not null default now(),
  recorded_by  text not null,
  status       text not null default 'active' check (status in ('active', 'revoked')),
  revoked_at   timestamptz,
  revoked_by   text,
  constraint operational_event_evidence_revoked_shape check (
    (status = 'active' and revoked_at is null and revoked_by is null) or
    (status = 'revoked' and revoked_at is not null and revoked_by is not null)
  ),
  created_at   timestamptz not null default now()
);

-- Item 14 — at most one ACTIVE evidence record per (subject, event) at the
-- database level, not just application logic. Correction is
-- revoke-then-create, never an in-place overwrite of occurred_at/source —
-- item 12's append-only/immutability requirement. A partial index (WHERE
-- status = 'active') rather than a plain unique constraint, so a revoked
-- row never blocks a later, corrected attestation from being inserted.
create unique index if not exists operational_event_evidence_active_uidx
  on operational_event_evidence (job_id, subject_id, event_type)
  where status = 'active';

create index if not exists operational_event_evidence_lookup_idx
  on operational_event_evidence (job_id, subject_id, event_type, status);

create index if not exists operational_event_evidence_org_idx
  on operational_event_evidence (org_id);

alter table operational_event_evidence enable row level security;

drop policy if exists "service_role_only" on operational_event_evidence;
create policy "service_role_only" on operational_event_evidence
  for all to service_role using (true) with check (true);

revoke all on operational_event_evidence from anon, authenticated;

notify pgrst, 'reload schema';
