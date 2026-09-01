/**
 * GET /api/jobs/[id]/rule-interpretations
 *
 * Read-only: every revision (current and historical) of every commercial
 * rule confirmed on this job, so downstream views (Commercial Logic &
 * Billing Setup's own rows, the Edit-commercial-rule drawer) can show who
 * confirmed the current interpretation and when, link back to the source
 * clause, and browse prior versions — without duplicating that bookkeeping
 * into contract_terms/contract_meter_mappings, which only hold the current
 * operational value, not the audit trail. Returns every row (not just
 * is_current) so callers can group by (rule_type, contract_unit_type) and
 * separate "current" from "history" themselves, which is what "View
 * previous version" needs.
 *
 * Resilient to the audit table not existing yet (pending migration) — this
 * is a read for a nice-to-have enrichment, not the write path, so a missing
 * table degrades to "no confirmed-rule metadata available" rather than
 * breaking the page that renders it.
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try { await requireOrg() } catch (res) { return res as Response }

  const { id: jobId } = await params

  let { data, error } = await supabaseServer
    .from('commercial_rule_interpretations')
    .select('rule_type, contract_unit_type, revision_number, is_current, source_clause, reviewer_input, approved_interpretation, reviewer_email, reviewer_name, created_at, propagation_status, decision_provenance')
    .eq('job_id', jobId)
    .order('revision_number', { ascending: false })

  // decision_provenance requires a migration (20260821000003_commercial_rule_
  // provenance.sql) that may not have run yet in every environment — same
  // degrade-gracefully pattern confirm-rule/route.ts already uses when
  // writing this column. A read must not 500 just because this enrichment
  // column isn't there yet.
  if (error?.message?.includes('decision_provenance')) {
    const fallback = await supabaseServer
      .from('commercial_rule_interpretations')
      .select('rule_type, contract_unit_type, revision_number, is_current, source_clause, reviewer_input, approved_interpretation, reviewer_email, reviewer_name, created_at, propagation_status')
      .eq('job_id', jobId)
      .order('revision_number', { ascending: false })
    data = fallback.data?.map(row => ({ ...row, decision_provenance: null })) ?? null
    error = fallback.error
  }

  if (error) {
    if (error.message.includes('commercial_rule_interpretations')) return NextResponse.json({ interpretations: [] })
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ interpretations: data ?? [] })
}
