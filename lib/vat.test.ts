import { describe, it, expect } from 'vitest'
import { resolveVatTreatment, computeVat, reconcileGrossAmount, type VatTreatment } from './vat'

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
