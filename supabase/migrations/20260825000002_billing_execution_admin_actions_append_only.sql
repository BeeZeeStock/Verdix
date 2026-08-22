-- Step 14 correction — billing_execution_admin_actions' append-only
-- guarantee was originally expressed as "no UPDATE/DELETE RLS policy for
-- service_role", which is NOT a real guarantee: confirmed live that
-- service_role bypasses row level security entirely in this project (the
-- standard Supabase default — RLS policies never apply to it regardless of
-- what is or isn't granted), so the original migration's protection was
-- illusory — application convention only, not database-enforced. A
-- trigger fires at the executor level for every role, including
-- service_role, and is the correct enforcement layer here (same principle
-- already applied to the identity-immutability triggers on
-- billing_execution_attempts/operations, confirmed live to hold against
-- service_role).

create or replace function billing_execution_admin_actions_reject_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'billing_execution_admin_actions is append-only — % is not permitted (id=%)', tg_op, coalesce(old.id, new.id);
end;
$$;

drop trigger if exists billing_execution_admin_actions_no_update on billing_execution_admin_actions;
create trigger billing_execution_admin_actions_no_update
  before update on billing_execution_admin_actions
  for each row execute function billing_execution_admin_actions_reject_mutation();

drop trigger if exists billing_execution_admin_actions_no_delete on billing_execution_admin_actions;
create trigger billing_execution_admin_actions_no_delete
  before delete on billing_execution_admin_actions
  for each row execute function billing_execution_admin_actions_reject_mutation();
