/**
 * Step 17H.4B0D4H1B4E2 §20-22, §26 — the ONE authoritative billing-safety
 * status surface. jobs.billing_hold (lib/billing-hold.ts) has been real
 * and operationally enforced since H1A/H1B — this is its first GUI
 * surface. Deliberately translates every internal reason into commercial
 * language (§22) — never "Model B+", "reconciliation planner",
 * "reexecution generation", or "CAS" anywhere in this component. This is a
 * DIFFERENT axis from Commercial Status (are required decisions resolved?)
 * and from BillingReconciliationPanel (does previously-executed billing
 * still match the current plan?) — see §26/§23; it answers "is
 * current/future billing safe to continue right now?" and must never be
 * duplicated in another card (§21).
 */
export type BillingHoldValue = { reason: 'reexecution' | 'reconciliation_blocked' | 'schedule_rebuild_required'; started_at?: string } | null | undefined

interface Props {
  hold: BillingHoldValue
  onRebuild: () => void
  rebuilding: boolean
  rebuildError: string | null
  // Step 17H.4B0D4H1B4E6 §32 — count of outstanding commercial decisions
  // (the SAME commercialRuleWorkload.totalToConfirm the "Rule
  // interpretations confirmed"/Commercial Logic surfaces already read —
  // never a second, independently-derived count). Optional so every
  // existing caller/fixture that predates this awareness keeps rendering
  // exactly as before (treated as 0/none outstanding). Backend hold
  // semantics are completely untouched by this — this only changes how
  // schedule_rebuild_required is WORDED and whether its CTA reads as
  // primary, never whether/when the hold itself is set or cleared.
  commercialDecisionsOutstanding?: number
}

export function BillingSafetyBanner({ hold, onRebuild, rebuilding, rebuildError, commercialDecisionsOutstanding = 0 }: Props) {
  if (!hold) return null // No warning surface required.

  // Step 17H.4B0D4H1B4E6 §32 — schedule_rebuild_required's OWN wording used
  // to unconditionally claim "the commercial configuration is up to date,"
  // which is misleading whenever commercial decisions are ALSO still
  // outstanding: the schedule can't be usefully rebuilt from a
  // configuration that isn't itself finished yet. Never changes the hold
  // ITSELF or when rebuild-schedule is called — purely which of two
  // truthful sentences is shown, and whether the rebuild action reads as
  // the primary next step or a secondary one still blocked on something
  // else.
  const rebuildBlockedByDecisions = hold.reason === 'schedule_rebuild_required' && commercialDecisionsOutstanding > 0

  const copy = hold.reason === 'reexecution'
    ? {
        icon: 'ti-refresh', color: '#B45309', bg: '#FFFBEB', border: 'rgba(217,119,6,0.25)',
        title: 'Configuration update in progress',
        body: 'The commercial configuration is being updated. Billing is temporarily paused.',
      }
    : hold.reason === 'reconciliation_blocked'
    ? {
        icon: 'ti-alert-triangle', color: '#B91C1C', bg: '#FEF2F2', border: 'rgba(185,28,28,0.2)',
        title: 'Commercial configuration needs review',
        body: 'Verdix found configuration differences it cannot safely reconcile automatically. Future billing is paused until they are resolved.',
      }
    : rebuildBlockedByDecisions
    ? {
        icon: 'ti-calendar-exclamation', color: '#B45309', bg: '#FFFBEB', border: 'rgba(217,119,6,0.25)',
        title: 'Billing schedule will need rebuilding',
        body: `Resolve the remaining commercial configuration first (${commercialDecisionsOutstanding} decision${commercialDecisionsOutstanding === 1 ? '' : 's'} outstanding). The existing future schedule was created from an earlier configuration.`,
      }
    : {
        icon: 'ti-calendar-exclamation', color: '#B45309', bg: '#FFFBEB', border: 'rgba(217,119,6,0.25)',
        title: 'Billing schedule needs rebuilding',
        body: 'The commercial configuration is up to date, but the future billing schedule was created from an earlier configuration.',
      }

  return (
    <div className="flex-shrink-0 mx-8 mt-4 rounded-xl border px-4 py-3 flex items-start gap-3" style={{ borderColor: copy.border, background: copy.bg }}>
      <i className={`ti ${copy.icon} mt-0.5 flex-shrink-0`} style={{ fontSize: 16, color: copy.color }} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium mb-0.5" style={{ color: copy.color }}>{copy.title}</p>
        <p className="text-xs leading-relaxed" style={{ color: copy.color, opacity: 0.85 }}>{copy.body}</p>
        {rebuildError && <p className="text-xs text-red-600 mt-2">{rebuildError}</p>}
        {hold.reason === 'schedule_rebuild_required' && (
          <button
            onClick={onRebuild}
            disabled={rebuilding}
            className="inline-flex items-center gap-2 text-xs font-semibold px-3 py-1.5 rounded-xl transition-colors disabled:opacity-40 mt-3"
            // Step 17H.4B0D4H1B4E6 §32 — "Rebuild CTA should only be
            // primary when rebuild is genuinely actionable": still the
            // same real button/onClick either way (never hidden or
            // disabled beyond the existing `rebuilding` state — rebuild
            // stays a legitimate, callable action even while decisions
            // are outstanding), only its visual weight changes.
            style={rebuildBlockedByDecisions
              ? { background: 'transparent', color: '#92400E', border: '1px solid rgba(217,119,6,0.4)' }
              : { background: '#1A3D2B', color: '#fff' }}
          >
            {rebuilding
              ? <><i className="ti ti-loader-2 animate-spin" style={{ fontSize: 11 }} /> Rebuilding…</>
              : <><i className="ti ti-calendar-plus" style={{ fontSize: 11 }} /> Rebuild billing schedule</>}
          </button>
        )}
      </div>
    </div>
  )
}
