// DB-touching assembly for lib/qualified-unit-aggregation.ts (pure) — same
// split as every other 16B *-service.ts file. Fulfils the
// "16B.4 TODO — computeQualifiedUnitCount" note left at the bottom of
// lib/billable-unit-candidate.ts.
//
// No new table. The aggregate is fully, deterministically recomputable
// from already-immutable data (terminal billable_unit_candidates rows +
// append/revoke-only source_coverage rows) at any asOf — see lib/
// qualified-unit-aggregation.ts's own header on why persisting it would be
// redundant, not merely undesirable. If a future caller needs execution
// idempotency (e.g. "never invoice the same period twice even under
// concurrent scheduler runs"), that is the EXISTING billing-execution
// idempotency layer's job (planned_invoices / the scheduler's own
// idempotency keys) — not a reason to add a second one here.
import { listCandidatesForJob, buildSourceBindingRoleKeyMap } from './billable-unit-candidate-service'
import { listQualificationRulesForJob } from './billable-unit-qualification-service'
import { listSourceRolesForJob } from './source-roles-service'
import { listSourceBindingsForRole } from './source-bindings-service'
import { listSourceCoverageForJob } from './source-coverage-service'
import {
  aggregateQualifiedUnits,
  type QualifiedUnitAggregateResult,
} from './qualified-unit-aggregation'
import type { SourceBinding } from './source-bindings'
import type { QualifiedUnitAggregateQuantitySource } from './commercial-quantity-source'

export async function computeQualifiedUnitAggregate(params: {
  jobId: string
  orgId: string
  unitType: string
  periodStart: string
  periodEnd: string
  asOf: string
}): Promise<QualifiedUnitAggregateResult> {
  const { jobId, orgId, unitType, periodStart, periodEnd, asOf } = params

  // ALL rule versions for this unit_type — which one(s) actually govern
  // the period (possibly more than one, on a mid-period amendment) is
  // resolved PURELY, inside aggregateQualifiedUnits itself
  // (resolveRuleSegmentsForPeriod) — never pre-selected here.
  const ruleVersions = await listQualificationRulesForJob(jobId, unitType)

  const candidates = await listCandidatesForJob(jobId, unitType)
  const sourceBindingRoleKeys = await buildSourceBindingRoleKeyMap(jobId)

  const roles = await listSourceRolesForJob(jobId)
  const sourceBindings: SourceBinding[] = []
  for (const role of roles) {
    const bindings = await listSourceBindingsForRole(role.id)
    sourceBindings.push(...bindings)
  }

  const coverage = await listSourceCoverageForJob(jobId)

  return aggregateQualifiedUnits({
    jobId, orgId, unitType, periodStart, periodEnd, asOf,
    ruleVersions, candidates, sourceBindings, sourceBindingRoleKeys, coverage,
  })
}

// Item 2/6 — the one seam that lets lib/usage-pull.ts's existing,
// unchanged commercial-input resolution ask "what is this job's qualified-
// unit quantity for this window" without knowing anything about candidates,
// rules, or coverage itself. metricKey is deliberately just `unitType`
// passed straight through — usage-pull.ts never learns a domain vocabulary
// (SQM/meeting/OS-2026-09), only whatever meter_key its own caller
// configured.
export async function resolveQualifiedUnitAggregateQuantitySource(params: {
  jobId: string
  orgId: string
  unitType: string
  periodStart: string
  periodEnd: string
  asOf: string
}): Promise<QualifiedUnitAggregateQuantitySource> {
  const aggregate = await computeQualifiedUnitAggregate(params)
  return {
    kind: 'qualified_unit_aggregate',
    metricKey: params.unitType,
    periodStart: params.periodStart,
    periodEnd: params.periodEnd,
    aggregate,
  }
}
