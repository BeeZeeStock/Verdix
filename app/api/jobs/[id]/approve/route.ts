import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { configureBilling } from '@/lib/billing-writer'
import { computeCommercialRuleWorkload } from '@/lib/commercial-rule-status'
import { detectRuleInteractionCandidates } from '@/lib/rule-interactions'
import { setCustomerVatConfig } from '@/lib/vat-service'
import type { ContractTerms } from '@/lib/types'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id } = await params
  const body = await req.json()
  const { modifiedLineItems, billing_platform: billingPlatformOverride } = body

  const { data: job, error } = await supabaseServer
    .from('jobs')
    .select('id, name, currency, billing_customer_id, billing_platform, execute_status, contract_terms ( * ), line_items ( * )')
    .eq('id', id)
    .eq('org_id', org.orgId)
    .single()

  if (error || !job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  // Capture status before we overwrite it — a re-push of an already-COMPLETED
  // job should not generate a second sync event.
  const wasAlreadyCompleted = (job as unknown as Record<string, unknown>).execute_status === 'COMPLETED'

  const termsArr = job.contract_terms as unknown as ContractTerms[]
  const terms = termsArr?.[0] ?? ({} as ContractTerms)
  const lineItems = (modifiedLineItems ?? job.line_items ?? []) as Array<{
    product_name: string; quantity: number; unit_price: number
    billing_period: string; total_amount: number; currency: string
  }>

  // Server-side mirror of the Configure page's Approve-button gate — the
  // client disables the button until every extracted usage metric has a
  // confirmed contract_meter_mappings row, but that's UI-only. Without this
  // check, a contract can be pushed to billing (base fee configured) while
  // its usage-based overage silently has no meter mapped to pull from —
  // real billing would then skip it every cycle with no visible error.
  const unitTypes = Array.from(new Set((terms.overage_tiers ?? []).map(t => t.unit_type).filter(Boolean)))
  let meterMappingWorkload = { total: 0, confirmed: 1 }
  if (unitTypes.length > 0) {
    const { data: mappings } = await supabaseServer
      .from('contract_meter_mappings')
      .select('contract_unit_type, confirmed')
      .eq('job_id', id)
    const confirmedTypes = new Set((mappings ?? []).filter(m => m.confirmed).map(m => m.contract_unit_type))
    const unconfirmed = unitTypes.filter(u => !confirmedTypes.has(u))
    meterMappingWorkload = { total: 1, confirmed: unconfirmed.length === 0 ? 1 : 0 }
    if (unconfirmed.length > 0) {
      return NextResponse.json(
        { error: `Confirm billing meter mappings before approving: ${unconfirmed.join(', ')}` },
        { status: 400 },
      )
    }
  }

  // Server-side mirror of the Configure page's commercial-rule-workload gate
  // (lib/commercial-rule-status.ts) — a minimum-commitment/tier-calculation/
  // escalator/discount/service-credit/rule-interaction left genuinely
  // unresolved must block the push, not just show a client-side badge that
  // a race or a bypassed request could skip past. This is the actual
  // enforcement the "Do not push this invoice" requirement depends on.
  const unresolvedInteractions = detectRuleInteractionCandidates({
    service_credits: terms.service_credits, discounts: terms.discounts, escalators: terms.escalators,
  }).filter(cand => {
    const credit = (terms.service_credits ?? []).find(c => c.credit_rule_id === cand.creditId)
    return !!credit?.interpretation && !credit.interpretation.requires_confirmation && !credit.interpretation.interaction_note
  })
  const workload = computeCommercialRuleWorkload(terms, meterMappingWorkload, unresolvedInteractions.length)
  if (workload.totalToConfirm > 0 || workload.interactionsToConfirm > 0) {
    return NextResponse.json(
      { error: `Confirm all commercial rules before approving — ${workload.totalToConfirm + workload.interactionsToConfirm} decision(s) outstanding.` },
      { status: 400 },
    )
  }

  // VAT must be explicitly configured (rate or zero-rated) before push —
  // never inferred, never silently defaulted. Staged on the job itself
  // (jobs.pending_vat_mode) until a billing_customer_id exists; promoted
  // into customer_vat_config below once configureBilling creates one.
  const existingCustomerId = (job as unknown as Record<string, unknown>).billing_customer_id as string | undefined
  if (!existingCustomerId) {
    const { data: vatRow } = await supabaseServer.from('jobs').select('pending_vat_mode').eq('id', id).single()
    if (!vatRow?.pending_vat_mode || vatRow.pending_vat_mode === 'not_configured') {
      return NextResponse.json(
        { error: 'Billing blocked: VAT treatment has not been confirmed for this customer/invoice.' },
        { status: 400 },
      )
    }
  }

  try {
    // A job already configured on a platform must stay on it — repushing
    // (e.g. to sync edited terms) must never silently switch platforms.
    // detectOrgPlatform() inside configureBilling picks arbitrarily among an
    // org's active connectors when more than one is configured, which is
    // only safe to fall back on for a job that's never been pushed before.
    const existingPlatform = (job as unknown as Record<string, unknown>).billing_platform as string | null
    const platformToUse = billingPlatformOverride ?? existingPlatform ?? undefined
    const result = await configureBilling(terms, lineItems, platformToUse, id, org.orgId, existingCustomerId ?? undefined)

    await supabaseServer.from('jobs').update({
      execute_status: 'COMPLETED',
      billing_platform: result.platform,
      billing_subscription_id: result.subscriptionId,
      billing_customer_id: result.customerId,
    }).eq('id', id)

    // Promote the job's pending VAT treatment (set pre-approval, since no
    // billing_customer_id existed to key customer_vat_config on yet) into
    // the real customer_vat_config row now that configureBilling has
    // created one — every future invoice for this customer inherits it as
    // its standing default from here on. A re-push that already has a
    // customer (existingCustomerId was set) already has its VAT configured
    // via customer_vat_config directly and skips this.
    if (!existingCustomerId) {
      const { data: vatRow } = await supabaseServer.from('jobs').select('pending_vat_mode, pending_vat_rate_pct').eq('id', id).single()
      if (vatRow?.pending_vat_mode && vatRow.pending_vat_mode !== 'not_configured') {
        await setCustomerVatConfig(
          org.orgId, result.customerId,
          { mode: vatRow.pending_vat_mode, ratePct: vatRow.pending_vat_mode === 'rate' ? vatRow.pending_vat_rate_pct : null },
          org.userEmail,
        ).then(({ error: vatError }) => { if (vatError) console.error('[approve] VAT promotion failed', vatError) })
      }
    }

    // Only count a sync event on the first successful configuration.
    // Re-pushing an already-configured contract to fix a mismatch does not
    // consume an additional sync credit.
    if (!wasAlreadyCompleted) {
      const { recordSync } = await import('@/lib/billing')
      await recordSync(org.orgId, id, 'contract_configure').catch(err => console.error('[approve] recordSync failed', err))
    }

    return NextResponse.json({
      success: true,
      platform: result.platform,
      stripeSubscriptionId: result.subscriptionId,
      customerId: result.customerId,
      dashboardUrl: result.dashboardUrl,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await supabaseServer.from('jobs').update({
      execute_status: 'FAILED',
      error_message: message,
    }).eq('id', id)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
