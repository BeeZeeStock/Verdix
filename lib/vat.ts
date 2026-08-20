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
