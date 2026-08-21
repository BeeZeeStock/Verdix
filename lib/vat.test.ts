import { describe, it, expect } from 'vitest'
import { resolveVatTreatment, computeVat, reconcileGrossAmount, resolveEffectiveVat, resolveInvoiceVatDisplay, type VatTreatment } from './vat'

describe('resolveVatTreatment', () => {
  it('invoice-level override always wins over the customer default', () => {
    const customerDefault: VatTreatment = { mode: 'rate', ratePct: 25 }
    const override: VatTreatment = { mode: 'zero_rated', ratePct: null }
    expect(resolveVatTreatment(customerDefault, override)).toEqual(override)
  })

  it('falls back to the customer default when no override is set', () => {
    const customerDefault: VatTreatment = { mode: 'rate', ratePct: 25 }
    expect(resolveVatTreatment(customerDefault, null)).toEqual(customerDefault)
  })

  it('resolves to not_configured when neither exists — never guesses a rate', () => {
    expect(resolveVatTreatment(null, null)).toEqual({ mode: 'not_configured', ratePct: null })
  })
})

describe('computeVat', () => {
  it('worked example from the spec: net 183,550 at 25% -> VAT 45,887.50, gross 229,437.50', () => {
    const result = computeVat(183_550, { mode: 'rate', ratePct: 25 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.calculation.vatAmount).toBe(45_887.5)
    expect(result.calculation.grossAmount).toBe(229_437.5)
  })

  it('zero_rated bills 0 VAT explicitly, gross equals net', () => {
    const result = computeVat(10_000, { mode: 'zero_rated', ratePct: null })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.calculation.vatAmount).toBe(0)
    expect(result.calculation.grossAmount).toBe(10_000)
  })

  it('not_configured fails closed — never falls back to 0% or any other silent default', () => {
    const result = computeVat(10_000, { mode: 'not_configured', ratePct: null })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/not been confirmed/)
  })
})

describe('reconcileGrossAmount', () => {
  it('matches within a one-cent rounding tolerance', () => {
    expect(reconcileGrossAmount(229_437.5, 229_437.51)).toBe('matched')
  })
  it('flags a real mismatch rather than silently accepting it', () => {
    expect(reconcileGrossAmount(229_437.5, 230_000)).toBe('mismatch')
  })
  it('reports not_checked when the platform returned no comparable total', () => {
    expect(reconcileGrossAmount(229_437.5, null)).toBe('not_checked')
  })
})

// Regression: job 83c5d8dc had pending_vat_rate_pct=25 staged on the job
// AND a real billing_customer_id, yet customer_vat_config was still null —
// the 25% never became the canonical, usable value any real consumer
// (invoice creation, Review Panel, Billing Summary) actually saw. These
// pin down the exact hierarchy/self-heal decision that fixes it.
describe('resolveEffectiveVat — canonical hierarchy: customer_vat_config > staged pending_vat_* > unconfigured', () => {
  it('no billing_customer_id yet: staged pending value is reported but never marked for promotion — nothing exists to promote it into', () => {
    const result = resolveEffectiveVat(null, null, { mode: 'rate', ratePct: 25 })
    expect(result).toEqual({ treatment: { mode: 'rate', ratePct: 25 }, source: 'pending_job_vat', needsPromotion: false })
  })

  it('no billing_customer_id and nothing staged: genuinely not configured', () => {
    const result = resolveEffectiveVat(null, null, { mode: null, ratePct: null })
    expect(result).toEqual({ treatment: null, source: 'not_configured', needsPromotion: false })
  })

  // The exact bug: billing_customer_id exists, customer_vat_config is
  // still empty, but a real staged value is sitting unpromoted.
  it('billing_customer_id exists, no customer_vat_config yet, but a staged pending value exists: promotes it — this is the exact stale-data case found live', () => {
    const result = resolveEffectiveVat('cus_123', null, { mode: 'rate', ratePct: 25 })
    expect(result).toEqual({ treatment: { mode: 'rate', ratePct: 25 }, source: 'promoted_from_pending', needsPromotion: true })
  })

  it('billing_customer_id exists and customer_vat_config is ALREADY set: that wins outright — a stale pending value is never allowed to overwrite a real, already-confirmed customer default', () => {
    const result = resolveEffectiveVat('cus_123', { mode: 'zero_rated', ratePct: null }, { mode: 'rate', ratePct: 25 })
    expect(result).toEqual({ treatment: { mode: 'zero_rated', ratePct: null }, source: 'customer_vat_config', needsPromotion: false })
  })

  it('billing_customer_id exists, nothing configured anywhere: genuinely not configured, still blocking', () => {
    const result = resolveEffectiveVat('cus_123', null, { mode: null, ratePct: null })
    expect(result).toEqual({ treatment: null, source: 'not_configured', needsPromotion: false })
  })

  it('a customer_vat_config row explicitly stored as not_configured is treated the same as no row at all', () => {
    const result = resolveEffectiveVat('cus_123', { mode: 'not_configured', ratePct: null }, { mode: 'rate', ratePct: 25 })
    expect(result.source).toBe('promoted_from_pending')
  })
})

describe('resolveInvoiceVatDisplay — historical invoices stay immutable', () => {
  it('an already-sent invoice with a real snapshot uses the SNAPSHOT, even if the live customer default has since changed to a different rate', () => {
    // Snapshot taken when the rate was 25%; customer default has since
    // moved to 20% — the already-issued invoice must still show 25%/9,625/48,125.
    const display = resolveInvoiceVatDisplay(
      38_500,
      { vatMode: 'rate', vatRatePct: 25, netAmount: 38_500, vatAmount: 9_625, grossAmount: 48_125 },
      { mode: 'rate', ratePct: 20 },
    )
    expect(display).toEqual({ netAmount: 38_500, vatRatePct: 25, vatAmount: 9_625, grossAmount: 48_125, isSnapshot: true })
  })

  it('a scheduled invoice with no snapshot yet computes live off the CURRENT customer default — this is the one case that legitimately reflects a later rate change', () => {
    const display = resolveInvoiceVatDisplay(38_500, null, { mode: 'rate', ratePct: 25 })
    expect(display).toEqual({ netAmount: 38_500, vatRatePct: 25, vatAmount: 9_625, grossAmount: 48_125, isSnapshot: false })
  })

  it('a scheduled invoice with no snapshot and no configured customer default returns null — never a fabricated 0% VAT', () => {
    expect(resolveInvoiceVatDisplay(38_500, null, null)).toBeNull()
    expect(resolveInvoiceVatDisplay(38_500, null, { mode: 'not_configured', ratePct: null })).toBeNull()
  })

  it('the worked example from the spec: 38,500 net at 25% -> 9,625 VAT -> 48,125 gross', () => {
    const display = resolveInvoiceVatDisplay(38_500, null, { mode: 'rate', ratePct: 25 })
    expect(display?.vatAmount).toBe(9_625)
    expect(display?.grossAmount).toBe(48_125)
  })
})
