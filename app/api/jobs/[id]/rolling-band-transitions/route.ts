/**
 * GET  /api/jobs/[id]/rolling-band-transitions
 *   Read-only. Runs the SAME live evaluation (lib/rolling-band-migration-
 *   pull.ts's evaluateRollingBandMigrations) a scheduler would, for every
 *   'executable' rolling_band_migration mechanism on this job's contract —
 *   but never persists anything (detection/persistence only happens from
 *   the invoice-scheduler cron; see that route's own comment). Also lists
 *   any transition already persisted for this job, with each row's
 *   lifecycle status (pending_notice/decision_required/pending_effective_date/
 *   pricing_required/active) resolved fresh via lib/rolling-band-
 *   transition.ts's resolveTransitionLifecycleStatus.
 *
 * POST /api/jobs/[id]/rolling-band-transitions
 *   Two independent, narrowly-scoped mutating actions (Step 17C.2a splits
 *   what used to be one combined "confirm notice" call, since item 1/2
 *   require notice confirmation and effective-timing resolution to be
 *   independently provable facts):
 *
 *   body: { action: 'confirm_notice', transition_id }
 *     Confirms advance notice was actually given. Does NOT touch
 *     effective_from/effective_rule at all.
 *
 *   body: { action: 'resolve_effective_rule', transition_id, kind, specific_date? }
 *     Resolves the typed effective-timing authority (item 1) from a
 *     reviewer's STRUCTURED pick (never free-text/inferred) — kind is one
 *     of 'next_billing_period' | 'next_renewal_term' | 'specific_date'
 *     (the last requires `specific_date`, an ISO date string). Compiles via
 *     compileTransitionEffectiveRule, resolves an actual date via
 *     resolveEffectiveDateFromRule (the SAME cadence/renewal-window
 *     machinery every other date in this chain uses), then persists both
 *     via resolve_rolling_band_transition_effective_rule. Returns 422 if
 *     the contract lacks the structured fields the chosen kind needs
 *     (e.g. next_renewal_term with no known contract_term_months) — never
 *     falls back to guessing a different kind.
 *
 *   body: { action: 'resolve_volume_rule', transition_id, kind, value? }
 *     Step 17C.2c — resolves the SEPARATE, independent decision of which
 *     contracted/included volume governs future overage once this
 *     transition's band is active. kind is one of 'band_upper_bound' |
 *     'rolling_average' | 'unchanged' | 'specific_volume' (the last
 *     requires a numeric `value`). Never derived from the band's own
 *     to_unit automatically — a reviewer (or, in future, extraction) must
 *     explicitly say so via band_upper_bound. Compiles via
 *     compileVolumeTransitionRule, persists via
 *     resolve_rolling_band_transition_volume_rule. No time-based guard
 *     (unlike resolve_effective_rule): this never feeds a pre-built
 *     schedule, only future overage calculations, so correcting it after
 *     the pricing band is already active is always safe.
 *
 *   Neither action ever activates a transition directly: activation is a
 *   pure function of (notice_required, notice_status, notice_confirmed_at,
 *   effective_rule, effective_from, asOf), re-derived on every read — see
 *   resolveTransitionLifecycleStatus. After a successful
 *   resolve_effective_rule call, this route also best-effort triggers
 *   lib/rolling-band-migration-pull.ts's reconcileActiveRollingBandTransitions
 *   (idempotent, safe no-op if the transition isn't active yet) so a
 *   resolution that immediately lands in the past doesn't have to wait for
 *   the next scheduler tick to reconcile the future schedule.
 *   resolve_volume_rule never triggers reconciliation — the fixed-fee
 *   schedule doesn't read the volume rule at all (see lib/rolling-band-
 *   schedule-reconciliation.ts's own header).
 *
 * Step 17C.2/17C.2a/17C.2c.
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import {
  evaluateRollingBandMigrations, resolveEffectiveDateFromRule, compileTransitionEffectiveRule, compileVolumeTransitionRule,
  reconcileActiveRollingBandTransitions, resolveVolumeRuleVersionAsOf,
  type PersistedRollingBandTransitionRow, type PersistedVolumeTransitionRuleVersion, type TransitionEffectiveRuleSelection, type VolumeTransitionRuleSelection,
} from '@/lib/rolling-band-migration-pull'
import { resolveTransitionLifecycleStatus } from '@/lib/rolling-band-transition'
import { unwrapEmbedded } from '@/lib/postgrest-helpers'
import type { ContractTerms } from '@/lib/types'

async function loadOwnedJobWithTerms(jobId: string, orgId: string) {
  const { data: job } = await supabaseServer
    .from('jobs')
    .select('id, contract_terms ( base_fee_bands, base_fee_committed_volume, contract_start_date, billing_frequency, contract_term_months, renewal_term_months, unsupported_commercial_mechanisms )')
    .eq('id', jobId)
    .eq('org_id', orgId)
    .maybeSingle()
  if (!job) return null
  return { id: job.id, orgId, terms: (unwrapEmbedded(job.contract_terms) ?? null) as ContractTerms | null }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id: jobId } = await params
  const owned = await loadOwnedJobWithTerms(jobId, org.orgId)
  if (!owned) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  const evaluations = owned.terms ? await evaluateRollingBandMigrations({ jobId, orgId: owned.orgId, terms: owned.terms }) : []

  const { data: rows, error } = await supabaseServer
    .from('rolling_band_pricing_transitions')
    .select('*')
    .eq('job_id', jobId)
    .order('detected_at', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const asOf = new Date()

  // Step 17C.2d — volume_transition_rule is no longer a column on this
  // table; the CURRENT (asOf now) rule is resolved from the append/
  // versioned history for display, via the SAME asOf-replay function real
  // billing calculations use — never a bespoke "just take the latest row"
  // shortcut that could drift from what resolveEffectiveCommercialStateForPeriod
  // itself would resolve.
  const transitionIds = (rows ?? []).map((row: PersistedRollingBandTransitionRow) => row.id)
  let volumeRuleVersions: PersistedVolumeTransitionRuleVersion[] = []
  if (transitionIds.length > 0) {
    const { data: versionRows, error: versionsError } = await supabaseServer
      .from('rolling_band_volume_rule_versions')
      .select('id, transition_id, rule, resolved_at, superseded_at')
      .in('transition_id', transitionIds)
    if (versionsError) return NextResponse.json({ error: versionsError.message }, { status: 500 })
    volumeRuleVersions = (versionRows ?? []) as PersistedVolumeTransitionRuleVersion[]
  }

  const transitions = (rows ?? []).map((row: PersistedRollingBandTransitionRow) => ({
    ...row,
    volume_transition_rule: resolveVolumeRuleVersionAsOf(volumeRuleVersions, row.id, asOf),
    lifecycle_status: resolveTransitionLifecycleStatus(row, asOf),
  }))

  return NextResponse.json({ evaluations, transitions })
}

type PostBody =
  | { action: 'confirm_notice'; transition_id: string }
  | ({ action: 'resolve_effective_rule'; transition_id: string } & TransitionEffectiveRuleSelection)
  | ({ action: 'resolve_volume_rule'; transition_id: string } & VolumeTransitionRuleSelection)

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id: jobId } = await params
  const owned = await loadOwnedJobWithTerms(jobId, org.orgId)
  if (!owned) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  const body = await req.json().catch(() => null) as PostBody | null
  if (!body?.transition_id || !body.action) {
    return NextResponse.json({ error: 'action and transition_id are required' }, { status: 400 })
  }

  const { data: existing } = await supabaseServer
    .from('rolling_band_pricing_transitions')
    .select('id')
    .eq('id', body.transition_id)
    .eq('job_id', jobId)
    .maybeSingle()
  if (!existing) return NextResponse.json({ error: 'Transition not found for this job' }, { status: 404 })

  if (body.action === 'confirm_notice') {
    const { data, error } = await supabaseServer.rpc('confirm_rolling_band_transition_notice', {
      p_transition_id: body.transition_id,
      p_confirmed_by: org.userEmail,
    })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    // A composite-typed Postgres function returning NULL (this RPC's own
    // WHERE guard matching zero rows) is NOT serialized as JSON null by
    // PostgREST — it comes back as an object with every field null (a real,
    // confirmed row_to_json(NULL::sometype) behavior). `id` is the primary
    // key and can only be null in that pathological case, never for a real
    // row — checking it, not the object's own truthiness, is what actually
    // detects a no-op here.
    if (!data?.id) return NextResponse.json({ error: 'Notice was already confirmed (or the transition no longer exists)' }, { status: 409 })
    return NextResponse.json({ transition: data })
  }

  if (body.action === 'resolve_effective_rule') {
    if (!owned.terms) return NextResponse.json({ error: 'No contract terms found for this job' }, { status: 400 })
    if (body.kind === 'specific_date' && !body.specific_date) {
      return NextResponse.json({ error: 'specific_date is required when kind is specific_date' }, { status: 400 })
    }
    const rule = compileTransitionEffectiveRule(
      body.kind === 'specific_date' ? { kind: 'specific_date', specific_date: body.specific_date } : { kind: body.kind },
    )
    const effectiveDate = resolveEffectiveDateFromRule({ rule, terms: owned.terms, after: new Date() })
    if (!effectiveDate) {
      return NextResponse.json({ error: `Cannot resolve an effective date for '${body.kind}' from this contract's known fields — Decision required.` }, { status: 422 })
    }
    const effectiveFromDate = `${effectiveDate.getFullYear()}-${String(effectiveDate.getMonth() + 1).padStart(2, '0')}-${String(effectiveDate.getDate()).padStart(2, '0')}`

    const { data, error } = await supabaseServer.rpc('resolve_rolling_band_transition_effective_rule', {
      p_transition_id: body.transition_id,
      p_effective_rule: rule,
      p_effective_from: effectiveFromDate,
    })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    // See confirm_notice's own comment above — check .id, not object truthiness.
    if (!data?.id) return NextResponse.json({ error: 'This transition can no longer have its effective timing changed (it is a pricing_required record, or its effective date has already arrived)' }, { status: 409 })

    if (owned.terms) {
      try {
        await reconcileActiveRollingBandTransitions({ jobId, orgId: org.orgId, terms: owned.terms })
      } catch (reconcileErr) {
        console.error(`[rolling-band-transitions] best-effort reconciliation failed for job ${jobId}:`, reconcileErr)
      }
    }

    return NextResponse.json({ transition: data })
  }

  if (body.action === 'resolve_volume_rule') {
    if (body.kind === 'specific_volume' && (body.value == null || !Number.isFinite(body.value))) {
      return NextResponse.json({ error: 'a finite numeric value is required when kind is specific_volume' }, { status: 400 })
    }
    const rule = compileVolumeTransitionRule(
      body.kind === 'specific_volume' ? { kind: 'specific_volume', value: body.value } : { kind: body.kind },
    )
    // Step 17C.2d — returns the newly-inserted VERSION row (append/
    // supersede), not a rolling_band_pricing_transitions row.
    const { data, error } = await supabaseServer.rpc('resolve_rolling_band_transition_volume_rule', {
      p_transition_id: body.transition_id,
      p_volume_rule: rule,
    })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    // See confirm_notice's own comment above — check .id, not object truthiness.
    if (!data?.id) return NextResponse.json({ error: 'This transition has no valid price configured (pricing_required) — there is no volume treatment to resolve' }, { status: 409 })
    return NextResponse.json({ volume_rule_version: data })
  }

  return NextResponse.json({ error: `Unknown action` }, { status: 400 })
}
