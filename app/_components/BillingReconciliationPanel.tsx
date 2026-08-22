'use client'

import { useCallback, useEffect, useState } from 'react'

type ReconciliationOperationView = {
  id: string
  operationType: string
  operationKey: string
  status: string
  retryCapability: string
  externalObjectId: string | null
  startedAt: string | null
  idempotencyWindowStillValid: boolean | null
}

type ComponentDelta = { componentKey: string; executedAmount: number; currentAmount: number; deltaAmount: number }

type ReconciliationState =
  | { kind: 'none' }
  | { kind: 'safe_to_resume'; attemptId: string; provider: string }
  | { kind: 'operation_outcome_uncertain'; attemptId: string; provider: string; operations: ReconciliationOperationView[]; uncertainOperationIds: string[] }
  | { kind: 'partially_executed'; attemptId: string; provider: string; operations: ReconciliationOperationView[] }
  | { kind: 'executed_same_plan'; attemptId: string; provider: string }
  | { kind: 'executed_plan_changed'; attemptId: string; provider: string; executedFingerprint: string; currentFingerprint: string }

type CorrectionAssessment =
  | { kind: 'none' }
  | { kind: 'additional_charge_indicated'; totalDelta: number; components: ComponentDelta[] }
  | { kind: 'credit_indicated'; totalDelta: number; components: ComponentDelta[] }
  | { kind: 'mixed_adjustment_indicated'; netDelta: number; components: ComponentDelta[] }
  | { kind: 'manual_assessment_required'; reasons: string[] }

interface ReconciliationData {
  state: ReconciliationState
  correctionAssessment: CorrectionAssessment
}

interface Props {
  jobId: string
  currency: string
  // Called after a successful admin action (verify succeeded/not executed)
  // so the parent page can refetch job-level state (execute_status may
  // now allow a normal retry). This panel never mutates job status itself.
  onResolved?: () => void
}

/**
 * Step 15, item 20 — a focused, admin-only panel shown only when the
 * derived reconciliation state actually requires attention (item 9: no
 * unnecessary admin work — 'none'/'safe_to_resume'/'executed_same_plan'
 * all render nothing). Every field displayed comes straight from GET
 * /api/jobs/[id]/billing-reconciliation — this component holds no
 * reconciliation state of its own beyond the last fetched snapshot, so a
 * page reload re-derives everything identically (item 24).
 *
 * Actions are narrow and server-validated (item 21/26): the only two
 * mutations this panel can trigger are POST reconcile-billing-operation's
 * 'succeeded'/'not_executed' outcomes — never a generic status edit, never
 * a "create correction invoice" button (item 20's explicit prohibition).
 */
export function BillingReconciliationPanel({ jobId, currency, onResolved }: Props) {
  const [data, setData] = useState<ReconciliationData | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actingOperationId, setActingOperationId] = useState<string | null>(null)
  const [externalIdDrafts, setExternalIdDrafts] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/jobs/${jobId}/billing-reconciliation`)
      if (res.ok) setData(await res.json())
    } finally {
      setLoading(false)
    }
  }, [jobId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  const verify = async (operationId: string, outcome: 'succeeded' | 'not_executed') => {
    setActionError(null)
    if (outcome === 'succeeded' && !externalIdDrafts[operationId]?.trim()) {
      setActionError('Enter the object ID found on the billing platform before verifying succeeded.')
      return
    }
    setActingOperationId(operationId)
    try {
      const body: Record<string, unknown> = { operationId, outcome }
      if (outcome === 'succeeded') body.externalObjectId = externalIdDrafts[operationId].trim()
      const res = await fetch(`/api/jobs/${jobId}/reconcile-billing-operation`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) { setActionError(json.error ?? 'Verification failed.'); return }
      await load()
      onResolved?.()
    } catch {
      setActionError('Network error — please try again.')
    } finally {
      setActingOperationId(null)
    }
  }

  const fmt = (n: number) => `${currency} ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  if (loading || !data) return null
  const { state, correctionAssessment } = data
  if (state.kind === 'none' || state.kind === 'safe_to_resume' || state.kind === 'executed_same_plan') return null

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-4 space-y-3">
      <p className="text-sm font-semibold text-amber-900 flex items-center gap-1.5">
        <i className="ti ti-alert-triangle" style={{ fontSize: 14 }} /> Billing reconciliation required
      </p>

      {state.kind === 'operation_outcome_uncertain' && (
        <div className="space-y-2">
          <p className="text-xs text-amber-800">
            An operation on the {state.provider} attempt has an unknown outcome. Check the billing platform directly, then record what you found — Verdix cannot safely guess.
          </p>
          {state.operations.map(op => (
            <div key={op.id} className="rounded-lg border border-amber-200 bg-white px-3 py-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-ink">{op.operationType} <span className="text-stone">({op.operationKey})</span></span>
                <span className={op.status === 'outcome_uncertain' ? 'text-amber-700 font-medium' : op.status === 'succeeded' ? 'text-green-700' : 'text-stone'}>
                  {op.status === 'outcome_uncertain' ? 'Outcome unknown' : op.status}
                </span>
              </div>
              {op.status === 'outcome_uncertain' && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    type="text" placeholder="External object ID (if found)"
                    value={externalIdDrafts[op.id] ?? ''}
                    onChange={e => setExternalIdDrafts(prev => ({ ...prev, [op.id]: e.target.value }))}
                    className="text-xs border border-stone-200 rounded px-2 py-1 flex-1 min-w-[160px]"
                  />
                  <button
                    disabled={actingOperationId === op.id}
                    onClick={() => verify(op.id, 'succeeded')}
                    className="text-xs font-medium px-2 py-1 rounded bg-forest text-white disabled:opacity-40"
                  >
                    Verify succeeded
                  </button>
                  <button
                    disabled={actingOperationId === op.id}
                    onClick={() => verify(op.id, 'not_executed')}
                    className="text-xs font-medium px-2 py-1 rounded border border-stone-300 text-ink disabled:opacity-40"
                  >
                    Verify not executed
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {state.kind === 'partially_executed' && (
        <div className="space-y-2">
          <p className="text-xs text-amber-800">
            A previous attempt on {state.provider} partially succeeded — some financial side effects already occurred, some did not. This cannot be safely retried automatically; manual recovery on the billing platform is required.
          </p>
          {state.operations.map(op => (
            <div key={op.id} className="rounded-lg border border-amber-200 bg-white px-3 py-2 text-xs flex items-center justify-between gap-2">
              <span className="font-medium text-ink">{op.operationType} <span className="text-stone">({op.operationKey})</span></span>
              <span className={op.status === 'succeeded' ? 'text-green-700' : 'text-stone'}>
                {op.status}{op.externalObjectId ? ` — ${op.externalObjectId}` : ''}
              </span>
            </div>
          ))}
        </div>
      )}

      {state.kind === 'executed_plan_changed' && (
        <div className="space-y-2">
          <p className="text-xs text-amber-800">
            Billing already executed on {state.provider} using an earlier billing plan. The current configuration differs and cannot be billed again automatically.
          </p>

          {correctionAssessment.kind === 'manual_assessment_required' && (
            <div className="text-xs text-amber-800 bg-white border border-amber-200 rounded-lg px-3 py-2">
              <p className="font-medium mb-1">Manual assessment required</p>
              <ul className="list-disc list-inside space-y-0.5">
                {correctionAssessment.reasons.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </div>
          )}

          {(correctionAssessment.kind === 'additional_charge_indicated'
            || correctionAssessment.kind === 'credit_indicated'
            || correctionAssessment.kind === 'mixed_adjustment_indicated') && (
            <div className="text-xs bg-white border border-amber-200 rounded-lg px-3 py-2 space-y-1">
              {correctionAssessment.components.map(c => (
                <div key={c.componentKey} className="flex items-center justify-between gap-2">
                  <span className="text-stone">{c.componentKey}</span>
                  <span className="text-right">
                    {fmt(c.executedAmount)} → {fmt(c.currentAmount)}{' '}
                    <strong className={c.deltaAmount > 0 ? 'text-red-600' : 'text-green-700'}>
                      ({c.deltaAmount > 0 ? '+' : ''}{fmt(c.deltaAmount)})
                    </strong>
                  </span>
                </div>
              ))}
              <div className="pt-1.5 mt-1.5 border-t border-amber-100 flex items-center justify-between font-semibold">
                <span>
                  {correctionAssessment.kind === 'additional_charge_indicated' ? 'Additional charge indicated'
                    : correctionAssessment.kind === 'credit_indicated' ? 'Credit indicated'
                    : 'Net adjustment indicated'}
                </span>
                <span>{fmt('totalDelta' in correctionAssessment ? correctionAssessment.totalDelta : correctionAssessment.netDelta)}</span>
              </div>
            </div>
          )}

          {correctionAssessment.kind === 'none' && (
            <p className="text-xs text-stone">No component-level amount difference was detected between the executed and current plans.</p>
          )}

          <p className="text-[11px] text-amber-700 italic">
            Automatic rebilling is disabled. This is an assessment only — it does not authorize any billing action.
          </p>
        </div>
      )}

      {actionError && <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-2 py-1.5">{actionError}</p>}
    </div>
  )
}
