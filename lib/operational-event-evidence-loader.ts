// Step 17H.2A item 2 — the ONE query+mapping every route handler that
// needs "the currently active operational_event_evidence for this job"
// shares: app/api/jobs/[id]/approve/route.ts (previously inline-duplicated
// there, twice — once for the preflight workload gate, again immediately
// before configureBilling to avoid staleness), rebuild-schedule/route.ts
// (previously had no copy at all — the root cause of that route's bug:
// configureBilling silently defaulted to [] and re-parked every
// event-gated fee on every rebuild, even ones already cleared to bill),
// and billing-summary/route.ts (previously a third independent copy).
//
// Deliberately a SEPARATE file from lib/operational-event-evidence.ts, not
// an added export there: that module is transitively imported into the
// CLIENT bundle (page.tsx, a 'use client' component, imports
// lib/committed-fixed-fee-resolver.ts -> lib/commercial-rule-status.ts ->
// lib/operational-event-evidence.ts, for its pure resolveOperational-
// EventEvidence/isOneTimeFeeHeldForExecution functions and types). A
// supabaseServer import inside that file evaluates lib/supabase.ts at
// module load time in the browser, where the service-role key is
// undefined, throwing "supabaseKey is required" and breaking the page —
// this is exactly that regression, caught and reverted. This loader file
// is only ever imported by route handlers (server-only) and must stay that
// way; never import it from lib/operational-event-evidence.ts or from any
// other file reachable from a client component.
import { supabaseServer } from './supabase'
import type { OperationalEventEvidence, OperationalEventEvidenceSource } from './operational-event-evidence'

// Callers that need a staleness-refresh (re-checking right before an
// external push, as approve/route.ts does) just call this again; it is
// intentionally not memoized so a second call always reflects the current
// database state.
export async function loadActiveOperationalEventEvidence(jobId: string): Promise<OperationalEventEvidence[]> {
  const { data: evidenceRows } = await supabaseServer
    .from('operational_event_evidence')
    .select('*')
    .eq('job_id', jobId)
    .eq('status', 'active')
  return (evidenceRows ?? []).map(r => ({
    id: r.id, subjectId: r.subject_id, eventType: r.event_type,
    occurredAt: r.occurred_at, source: r.source as OperationalEventEvidenceSource,
    recordedAt: r.recorded_at, recordedBy: r.recorded_by, status: r.status,
  }))
}
