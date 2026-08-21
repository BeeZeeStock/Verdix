import { supabaseServer } from './supabase'
import { resolveEffectiveVat, type VatTreatment, type VatMode, type VatResolution } from './vat'

type VatConfigRow = { vat_mode: 'rate' | 'zero_rated' | 'not_configured'; vat_rate_pct: number | null }

function toTreatment(row: VatConfigRow | null | undefined): VatTreatment | null {
  if (!row) return null
  return { mode: row.vat_mode, ratePct: row.vat_rate_pct }
}

export async function getCustomerVatConfig(orgId: string, billingCustomerId: string): Promise<VatTreatment | null> {
  const { data } = await supabaseServer
    .from('customer_vat_config')
    .select('vat_mode, vat_rate_pct')
    .eq('org_id', orgId)
    .eq('billing_customer_id', billingCustomerId)
    .maybeSingle()
  return toTreatment(data as VatConfigRow | null)
}

// I/O wrapper around lib/vat.ts's resolveEffectiveVat (the pure decision) —
// fetches the real customer_vat_config, decides the effective treatment,
// and performs the self-healing promotion write when the decision calls
// for one. Every consumer of job-level VAT status (GET /api/jobs/[id]/vat-config
// — and therefore Review Panel, main GUI, and Billing Summary, which all
// share the one useVatConfig hook that calls it) goes through this single
// function so they can never disagree about the effective value.
export async function resolveEffectiveVatForJob(
  orgId: string,
  job: { billing_customer_id: string | null; pending_vat_mode: VatMode | null; pending_vat_rate_pct: number | null },
): Promise<VatResolution> {
  const existing = job.billing_customer_id ? await getCustomerVatConfig(orgId, job.billing_customer_id) : null
  const resolution = resolveEffectiveVat(job.billing_customer_id, existing, { mode: job.pending_vat_mode, ratePct: job.pending_vat_rate_pct })
  if (resolution.needsPromotion && job.billing_customer_id && resolution.treatment) {
    const { error } = await setCustomerVatConfig(orgId, job.billing_customer_id, resolution.treatment, null)
    if (error) {
      // Promotion failed (e.g. transient DB error) — still report the
      // staged value so the reviewer isn't shown a false "not configured",
      // but don't claim it as canonical since the write didn't actually
      // land; the next read will retry the promotion.
      console.error('[vat-service] self-heal promotion failed', error)
      return { ...resolution, source: 'pending_job_vat' }
    }
  }
  return resolution
}

export async function setCustomerVatConfig(
  orgId: string,
  billingCustomerId: string,
  treatment: VatTreatment,
  updatedBy: string | null,
): Promise<{ error: string | null }> {
  const { error } = await supabaseServer
    .from('customer_vat_config')
    .upsert(
      {
        org_id: orgId, billing_customer_id: billingCustomerId,
        vat_mode: treatment.mode, vat_rate_pct: treatment.mode === 'rate' ? treatment.ratePct : null,
        updated_by: updatedBy, updated_at: new Date().toISOString(),
      },
      { onConflict: 'org_id,billing_customer_id' },
    )
  return { error: error?.message ?? null }
}

export async function getInvoiceVatOverride(plannedInvoiceId: string): Promise<VatTreatment | null> {
  const { data } = await supabaseServer
    .from('planned_invoice_vat_overrides')
    .select('vat_mode, vat_rate_pct')
    .eq('planned_invoice_id', plannedInvoiceId)
    .maybeSingle()
  return toTreatment(data as VatConfigRow | null)
}

export async function setInvoiceVatOverride(
  plannedInvoiceId: string,
  orgId: string,
  treatment: VatTreatment,
  reason: string | null,
  setBy: string | null,
): Promise<{ error: string | null }> {
  const { error } = await supabaseServer
    .from('planned_invoice_vat_overrides')
    .upsert(
      {
        planned_invoice_id: plannedInvoiceId, org_id: orgId,
        vat_mode: treatment.mode, vat_rate_pct: treatment.mode === 'rate' ? treatment.ratePct : null,
        reason, set_by: setBy,
      },
      { onConflict: 'planned_invoice_id' },
    )
  return { error: error?.message ?? null }
}
