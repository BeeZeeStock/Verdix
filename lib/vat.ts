// VAT is a user/reviewer-controlled billing input, never inferred from
// supplier country, currency, or customer location — see the investigation
// this module followed from (VAT was previously hardcoded to 0 at every
// Remembill row-creation call site, and entirely absent from Stripe calls).
// This is deliberately NOT a tax-determination engine: it holds exactly one
// explicit treatment per customer (with an optional per-invoice override)
// and computes net/VAT/gross off it. Nothing here ever infers a rate.

export type VatMode = 'rate' | 'zero_rated' | 'not_configured'

export interface VatTreatment {
  mode: VatMode
  ratePct: number | null // set only when mode === 'rate'
}

export interface VatCalculation {
  netAmount: number
  vatRatePct: number // 0 for zero_rated
  vatAmount: number
  grossAmount: number
}

// Invoice-level override always wins over the customer's standing default —
// per the explicit "prefer customer-level VAT configuration with
// invoice-level override" instruction. A missing override falls through to
// the customer default; a missing customer default resolves to
// 'not_configured', which computeVat below refuses to bill against.
export function resolveVatTreatment(
  customerDefault: VatTreatment | null,
  invoiceOverride: VatTreatment | null,
): VatTreatment {
  return invoiceOverride ?? customerDefault ?? { mode: 'not_configured', ratePct: null }
}

export type VatResult =
  | { ok: true; calculation: VatCalculation }
  | { ok: false; reason: string }

// The single point where net/VAT/gross gets computed — Verdix owns this
// calculation end to end; the billing platform (Remembill/Stripe) never
// determines which rate applies, only mechanically applies the value
// Verdix already decided. Fails closed (ok: false) rather than guessing a
// rate when treatment is 'not_configured' — the caller must block invoice
// issuance on this, never substitute a default.
export function computeVat(netAmount: number, treatment: VatTreatment): VatResult {
  if (treatment.mode === 'not_configured') {
    return { ok: false, reason: 'VAT treatment has not been confirmed for this customer/invoice.' }
  }
  const vatRatePct = treatment.mode === 'zero_rated' ? 0 : (treatment.ratePct ?? 0)
  const vatAmount = Math.round(netAmount * vatRatePct) / 100
  const grossAmount = Math.round((netAmount + vatAmount) * 100) / 100
  return {
    ok: true,
    calculation: { netAmount: Math.round(netAmount * 100) / 100, vatRatePct, vatAmount, grossAmount },
  }
}

export type VatSource = 'customer_vat_config' | 'pending_job_vat' | 'promoted_from_pending' | 'not_configured'

export interface VatResolution {
  treatment: VatTreatment | null
  source: VatSource
  // True when a staged pending_vat_* value should be written into the
  // canonical customer_vat_config now — the caller (lib/vat-service.ts's
  // resolveEffectiveVatForJob) is the one that actually performs that
  // write; this function only decides whether one is needed, so the
  // decision itself stays pure/testable without a live DB.
  needsPromotion: boolean
}

// Pure decision logic for "what VAT treatment is actually in effect for
// this job right now, and does a stale staged value need promoting into
// the canonical store" — factored out of the DB-touching GET /vat-config
// route specifically so it's unit-testable without Supabase. Regression:
// a job whose VAT was staged (pending_vat_mode/pending_vat_rate_pct) BEFORE
// its billing_customer_id existed could end up in a state where the
// customer was later created (e.g. at approval) but the one-shot promotion
// in approve/route.ts either predated that code or failed silently — the
// job was left with a confirmed-looking staged value that customer_vat_config,
// invoice creation, and every other real consumer of VAT never actually saw.
// This makes that self-healing: any read that finds billing_customer_id set,
// no real customer_vat_config yet, but a genuine staged value, promotes it
// on the spot rather than reporting a false "not configured" the reviewer
// already resolved once. Never overwrites an EXISTING customer_vat_config —
// only fills a genuine gap.
export function resolveEffectiveVat(
  billingCustomerId: string | null,
  existingCustomerVat: VatTreatment | null,
  pending: { mode: VatMode | null; ratePct: number | null },
): VatResolution {
  const pendingTreatment: VatTreatment | null =
    pending.mode && pending.mode !== 'not_configured' ? { mode: pending.mode, ratePct: pending.ratePct } : null

  if (!billingCustomerId) {
    // No customer yet — pending_vat_* is the only place VAT can live, and
    // is genuinely just a draft until a customer exists to key the
    // canonical store on. Never "promoted" from here — there's nothing to
    // promote it INTO yet.
    return { treatment: pendingTreatment, source: pendingTreatment ? 'pending_job_vat' : 'not_configured', needsPromotion: false }
  }
  if (existingCustomerVat && existingCustomerVat.mode !== 'not_configured') {
    return { treatment: existingCustomerVat, source: 'customer_vat_config', needsPromotion: false }
  }
  if (pendingTreatment) {
    return { treatment: pendingTreatment, source: 'promoted_from_pending', needsPromotion: true }
  }
  return { treatment: null, source: 'not_configured', needsPromotion: false }
}

// Whether a platform-returned total for an issued invoice matches Verdix's
// own expected gross, within a small rounding tolerance (one minor unit,
// e.g. one öre/cent) — a real mismatch (the platform applied a different
// rate, dropped VAT, or rounded differently) must be surfaced, never
// silently accepted.
export function reconcileGrossAmount(expectedGross: number, actualGross: number | null): 'matched' | 'mismatch' | 'not_checked' {
  if (actualGross == null) return 'not_checked'
  const diffCents = Math.round(expectedGross * 100) - Math.round(actualGross * 100)
  return Math.abs(diffCents) <= 1 ? 'matched' : 'mismatch'
}

export interface InvoiceVatDisplay extends VatCalculation {
  // true = an immutable historical snapshot (this invoice was actually
  // sent, and planned_invoices.vat_* was written at that moment — see
  // supabase/migrations/20260821000007_vat_config.sql); false = a live
  // projection off the CURRENT customer default for an invoice not sent
  // yet, which legitimately changes if the rate changes before it sends.
  isSnapshot: boolean
}

// Resolves what to display for ONE invoice row's net/VAT/gross — prefers an
// already-snapshotted value over a live computation, which is what keeps an
// already-issued invoice's displayed VAT immutable even after a LATER VAT
// rate change for the same customer. Pure so the "prefer snapshot" rule is
// independently testable from both the fetch (billing-summary route) and
// the render (BillingSummaryCard).
export function resolveInvoiceVatDisplay(
  netAmount: number,
  snapshot: { vatMode: VatMode | null; vatRatePct: number | null; netAmount: number | null; vatAmount: number | null; grossAmount: number | null } | null,
  currentCustomerTreatment: VatTreatment | null,
): InvoiceVatDisplay | null {
  if (snapshot?.vatMode && snapshot.vatMode !== 'not_configured') {
    return {
      netAmount: snapshot.netAmount ?? netAmount,
      vatRatePct: snapshot.vatRatePct ?? 0,
      vatAmount: snapshot.vatAmount ?? 0,
      grossAmount: snapshot.grossAmount ?? netAmount,
      isSnapshot: true,
    }
  }
  if (currentCustomerTreatment && currentCustomerTreatment.mode !== 'not_configured') {
    const result = computeVat(netAmount, currentCustomerTreatment)
    if (result.ok) return { ...result.calculation, isSnapshot: false }
  }
  return null
}
