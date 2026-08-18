-- ═══════════════════════════════════════════════════════════════════════════
-- SECURITY FIX — 2026-08-19 audit
--
-- Nearly every RLS policy in this schema was written as
--   create policy "..." on X for all using (true) with check (true);
-- with NO `to <role>` clause. In Postgres/Supabase, a policy without `to`
-- applies to PUBLIC — i.e. anon AND authenticated, not just service_role,
-- despite most of these being named "service role bypass". Since the app's
-- anon key (NEXT_PUBLIC_SUPABASE_ANON_KEY) is shipped to every browser by
-- design, this meant any caller could read/write every table below directly
-- via the Supabase Data API, bypassing requireOrg() entirely.
--
-- Worse: organizations and org_memberships — the tables requireOrg() itself
-- trusts to decide who belongs to which org — had RLS explicitly DISABLED
-- (20260704000002_org_rls.sql), which combined with Supabase's default
-- anon/authenticated grants on public-schema tables is a full auth bypass:
-- anyone could INSERT an org_memberships row making themselves owner of any
-- org_id, then use the app's own UI/API to reach that org's data.
--
-- This app's real access-control boundary is, and remains, requireOrg() in
-- application code — every legitimate read/write goes through supabaseServer
-- (the service-role client, which bypasses RLS by design). Nothing in this
-- migration changes that. The fix here is narrower: make sure anon/
-- authenticated genuinely have NO usable access at the database layer,
-- matching what was already correctly done for the storage.objects policy.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── organizations / org_memberships: re-enable RLS, deny anon/authenticated ──
alter table organizations enable row level security;
alter table org_memberships enable row level security;

drop policy if exists "service role bypass" on organizations;
drop policy if exists "service_role_only" on organizations;
create policy "service_role_only" on organizations for all to service_role using (true) with check (true);

drop policy if exists "service role bypass" on org_memberships;
drop policy if exists "service_role_only" on org_memberships;
create policy "service_role_only" on org_memberships for all to service_role using (true) with check (true);

revoke all on organizations from anon, authenticated;
revoke all on org_memberships from anon, authenticated;

-- ── org_integrations: replace the broken current_user-based policy ──────────
-- current_user is the Postgres connection role (anon/authenticated), never
-- an email — the existing policy could never actually match a real caller.
-- Accidentally safe (always denies), but dead code presenting as a real
-- tenant check. Replaced with the same explicit service_role-only pattern.
drop policy if exists "org members can read integrations" on org_integrations;
drop policy if exists "service_role_only" on org_integrations;
create policy "service_role_only" on org_integrations for all to service_role using (true) with check (true);
revoke all on org_integrations from anon, authenticated;

-- ── Every other table below: same fix, mechanically applied ─────────────────
-- alter ... enable row level security is idempotent if already enabled.
-- drop policy if exists covers both this codebase's two naming conventions
-- ("service role bypass" and "service_role_only") without erroring if a
-- table only ever had one of them.
do $$
declare
  t text;
  tables text[] := array[
    'jobs', 'contract_terms', 'line_items', 'leakage_findings',
    'partner_invoices', 'partner_findings', 'extraction_corrections',
    'design_partner_applications', 'pii_entities', 'job_pii_occurrences',
    'user_consents', 'verdix_plans', 'org_subscriptions', 'sync_events',
    'verdix_settings', 'billing_meters', 'contract_meter_mappings',
    'org_billing_config', 'usage_ledger', 'commercial_rule_interpretations',
    'demo_leads', 'planned_invoices'
  ];
begin
  foreach t in array tables loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', 'service role bypass', t);
    execute format('drop policy if exists %I on %I', 'service_role_only', t);
    execute format(
      'create policy %I on %I for all to service_role using (true) with check (true)',
      'service_role_only', t
    );
    execute format('revoke all on %I from anon, authenticated', t);
  end loop;
end $$;

-- ── SECURITY DEFINER functions: revoke the PUBLIC execute grant Postgres ────
-- adds by default. These run as their defining (elevated) role and take a
-- caller-supplied org_id_param with no internal membership check — reachable
-- via PostgREST's /rest/v1/rpc/<fn> with just the anon key. Revoking PUBLIC
-- execute means only service_role (i.e. the app's own server-side calls, if
-- any) can invoke them; this can't affect the app itself since all its
-- Supabase access already goes through the service-role client.
do $$
declare
  fn text;
  fns text[] := array[
    'increment_usage_counter(uuid, text, bigint)',
    'deduct_usage_counter(uuid, text, bigint)',
    'record_usage(uuid, text, bigint, uuid, timestamptz)',
    'sum_usage_for_period(uuid, text, timestamptz, timestamptz)'
  ];
begin
  foreach fn in array fns loop
    begin
      execute format('revoke execute on function %s from public', fn);
    exception when undefined_function then
      -- Signature drifted from what this migration assumes, or the function
      -- was since dropped — skip rather than fail the whole migration.
      raise notice 'skipped revoke on %, function not found with that signature', fn;
    end;
  end loop;
end $$;

notify pgrst, 'reload schema';
