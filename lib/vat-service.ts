import { supabaseServer } from './supabase'
import type { VatTreatment } from './vat'

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
