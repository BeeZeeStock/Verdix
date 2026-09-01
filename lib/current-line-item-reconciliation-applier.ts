// Step 17H.4B0D4H1B2 — the narrow, DB-touching persistence layer around the
// pure Model B+ planner (lib/current-line-item-reconciliation-plan.ts). This
// module owns exactly two things: serializing a planner-produced plan into
// the RPC's narrow payload shape, and invoking+interpreting the RPC
// (apply_current_line_item_reconciliation, supabase/migrations/
// 20260913000001_current_line_item_reconciliation_applier.sql). It does NOT
// re-run the planner, does NOT inspect jobs.billing_hold, does NOT mutate
// jobs, and does NOT retry automatically — all orchestration concerns are
// explicitly deferred to H1B3. Nothing in the application calls this module
// yet; execute/route.ts's existing unconditional line_items INSERT is
// unchanged by this pass.
import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  CurrentLineItemReconciliationPlan, FreshLineItemLike,
  ReconciliationUpdate, ReconciliationInsert, ReconciliationSupersede,
} from './current-line-item-reconciliation-plan'

// The exact, narrow shape the RPC accepts — deliberately NOT the full plan
// object (blockers are never sent; family/reason diagnostic fields on
// updates/inserts/supersedes are stripped, since the RPC has no use for
// them — see the migration's own header for why blockers stay an
// orchestration-only concern).
export interface CurrentLineItemReconciliationApplyPayload {
  p_job_id: string
  p_expected_current_row_ids: string[]
  p_expected_current_rows: unknown[]
  p_updates: Array<{ id: string; changes: Record<string, unknown> }>
  p_inserts: unknown[]
  p_supersedes: Array<{ id: string }>
}

// Pure — no I/O. Reuses the planner's own output verbatim wherever the
// shape already matches (expectedCurrentRows, each insert's `row`), and
// strips only the fields the RPC genuinely has no parameter for. Never
// re-sorts/re-derives expectedCurrentRowIds — the planner's own ordering is
// preserved exactly, since ordering has no correctness meaning for the RPC
// (documented set-equality check) but IS meaningful for this function's own
// serialization tests (a silent re-sort would hide a caller bug upstream).
export function serializeReconciliationPlanForApplier<F extends FreshLineItemLike>(
  jobId: string,
  plan: CurrentLineItemReconciliationPlan<F>,
): CurrentLineItemReconciliationApplyPayload {
  return {
    p_job_id: jobId,
    p_expected_current_row_ids: plan.expectedCurrentRowIds,
    p_expected_current_rows: plan.expectedCurrentRows,
    p_updates: plan.updates.map((u: ReconciliationUpdate) => ({ id: u.id, changes: u.changes })),
    p_inserts: plan.inserts.map((i: ReconciliationInsert<F>) => i.row),
    p_supersedes: plan.supersedes.map((s: ReconciliationSupersede) => ({ id: s.id })),
  }
}

export type ApplyCurrentLineItemReconciliationResult =
  | { status: 'applied'; updatedCount: number; insertedCount: number; supersededCount: number }
  | {
      status: 'stale_plan'
      reason: 'current_set_changed' | 'current_row_changed'
      affectedIds?: string[]
      missingFromActual?: string[]
      extraInActual?: string[]
    }
  | { status: 'invalid_plan'; reason: string }
  | { status: 'error'; message: string }

// The RPC returns a single jsonb object (never `setof`, since the three
// result shapes have genuinely different fields — a discriminated union is
// the honest model, not a composite type with mostly-null columns).
interface RawRpcResult {
  status: 'applied' | 'stale_plan' | 'invalid_plan'
  reason?: string
  updated_count?: number
  inserted_count?: number
  superseded_count?: number
  affected_ids?: string[]
  missing_from_actual?: string[]
  extra_in_actual?: string[]
}

function parseRpcResult(raw: RawRpcResult): ApplyCurrentLineItemReconciliationResult {
  if (raw.status === 'applied') {
    return {
      status: 'applied',
      updatedCount: raw.updated_count ?? 0,
      insertedCount: raw.inserted_count ?? 0,
      supersededCount: raw.superseded_count ?? 0,
    }
  }
  if (raw.status === 'stale_plan') {
    return {
      status: 'stale_plan',
      reason: raw.reason === 'current_row_changed' ? 'current_row_changed' : 'current_set_changed',
      ...(raw.affected_ids ? { affectedIds: raw.affected_ids } : {}),
      ...(raw.missing_from_actual ? { missingFromActual: raw.missing_from_actual } : {}),
      ...(raw.extra_in_actual ? { extraInActual: raw.extra_in_actual } : {}),
    }
  }
  return { status: 'invalid_plan', reason: raw.reason ?? 'unknown' }
}

// The only exported entry point that actually touches the database. Never
// invoked by this pass — H1B3 is the first caller. No retry: a stale_plan
// or invalid_plan result is handed back to the caller verbatim; deciding
// whether/how to re-plan and retry is explicitly an orchestration decision
// this function does not make.
export async function applyCurrentLineItemReconciliationPlan<F extends FreshLineItemLike>(
  supabase: SupabaseClient,
  jobId: string,
  plan: CurrentLineItemReconciliationPlan<F>,
): Promise<ApplyCurrentLineItemReconciliationResult> {
  const payload = serializeReconciliationPlanForApplier(jobId, plan)
  const { data, error } = await supabase.rpc('apply_current_line_item_reconciliation', payload)
  if (error) return { status: 'error', message: error.message }
  return parseRpcResult(data as RawRpcResult)
}
