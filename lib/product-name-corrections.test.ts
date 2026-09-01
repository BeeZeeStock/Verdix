import { describe, it, expect } from 'vitest'
import { applyProductNameCorrections, buildProductNameCorrectionRequests, type ProductNameCorrections } from './product-name-corrections'

type Item = { id: string; product_name: string; unit_price?: number }

describe('applyProductNameCorrections — Step 17H.4B0D4H1B4E2.6 §8-14/25', () => {
  it('a genuine name correction overrides product_name for exactly that item', () => {
    const items: Item[] = [{ id: 'a', product_name: 'Extracted Name' }]
    const corrections: ProductNameCorrections = { a: { value: 'Corrected Name', remember: true } }
    expect(applyProductNameCorrections(items, corrections)).toEqual([{ id: 'a', product_name: 'Corrected Name' }])
  })

  it('no correction for an item leaves its original product_name untouched', () => {
    const items: Item[] = [{ id: 'a', product_name: 'Extracted Name' }]
    expect(applyProductNameCorrections(items, {})).toEqual([{ id: 'a', product_name: 'Extracted Name' }])
  })

  it('corrections are isolated per item id — one item\'s correction never leaks onto another', () => {
    const items: Item[] = [
      { id: 'a', product_name: 'Fee A' },
      { id: 'b', product_name: 'Fee B' },
    ]
    const corrections: ProductNameCorrections = { a: { value: 'Corrected A', remember: true } }
    const result = applyProductNameCorrections(items, corrections)
    expect(result.find(i => i.id === 'a')?.product_name).toBe('Corrected A')
    expect(result.find(i => i.id === 'b')?.product_name).toBe('Fee B')
  })

  it('other fields (e.g. unit_price) are never touched by this mapping — it only ever rewrites product_name', () => {
    const items: Item[] = [{ id: 'a', product_name: 'Fee A', unit_price: 100 }]
    const corrections: ProductNameCorrections = { a: { value: 'Renamed Fee A', remember: true } }
    const result = applyProductNameCorrections(items, corrections)
    expect(result[0].unit_price).toBe(100)
    expect(result[0].product_name).toBe('Renamed Fee A')
  })

  // Step 17H.4B0D4H1B4E2.6 §8-9 — this is the REGRESSION SHAPE for the bug
  // that was found and removed at its actual source (ReviewPanel's price-
  // correction flow no longer ever writes into this state — see that
  // file's own comment at the two removed call sites). This test documents
  // the contract this function relies on: `corrections` must hold ONLY
  // product_name values, since this function has no way to distinguish a
  // legitimate name from a stray price string — the guarantee comes from
  // upstream write-site discipline, not from this function's own logic.
  it('documents the contract: a non-name value placed in corrections would be submitted as product_name verbatim — proving why the write-site fix (not a runtime guard here) is what closes the bug', () => {
    const items: Item[] = [{ id: 'a', product_name: 'Success fee per completed payment', unit_price: 1.7 }]
    const accidentallyPriceShaped: ProductNameCorrections = { a: { value: '1.7', remember: true } }
    const result = applyProductNameCorrections(items, accidentallyPriceShaped)
    // This function trusts its input completely — it's the CALLER'S job
    // (ReviewPanel's price-correction flow) to never populate this state
    // with anything but a real name correction. That call site no longer
    // does; this test exists so any future regression there is at least
    // documented as reachable through this exact mapping.
    expect(result[0].product_name).toBe('1.7')
  })
})

describe('buildProductNameCorrectionRequests — Step 17H.4B0D4H1B4E2.6 §8-14/25', () => {
  it('builds one product_name-fieldName request per non-empty correction', () => {
    const items: Item[] = [{ id: 'a', product_name: 'Extracted Name' }]
    const corrections: ProductNameCorrections = { a: { value: 'Corrected Name', remember: true } }
    const requests = buildProductNameCorrectionRequests(items, corrections, { jobId: 'job-1' })
    expect(requests).toEqual([{
      jobId: 'job-1', fieldName: 'product_name', extractedValue: 'Extracted Name',
      correctedValue: 'Corrected Name', customerName: undefined, applyToFuture: true,
    }])
  })

  it('an empty-value correction entry is skipped — never logs a no-op correction', () => {
    const items: Item[] = [{ id: 'a', product_name: 'Extracted Name' }]
    const corrections: ProductNameCorrections = { a: { value: '', remember: true } }
    expect(buildProductNameCorrectionRequests(items, corrections, { jobId: 'job-1' })).toEqual([])
  })

  it('multiple items each produce their own independent request — no cross-item collision', () => {
    const items: Item[] = [
      { id: 'a', product_name: 'Fee A' },
      { id: 'b', product_name: 'Fee B' },
    ]
    const corrections: ProductNameCorrections = {
      a: { value: 'Renamed A', remember: true },
      b: { value: 'Renamed B', remember: false },
    }
    const requests = buildProductNameCorrectionRequests(items, corrections, { jobId: 'job-1' })
    expect(requests).toHaveLength(2)
    expect(requests.find(r => r.correctedValue === 'Renamed A')?.applyToFuture).toBe(true)
    expect(requests.find(r => r.correctedValue === 'Renamed B')?.applyToFuture).toBe(false)
  })

  it('every request always carries fieldName: "product_name" — this batch never logs any other field', () => {
    const items: Item[] = [{ id: 'a', product_name: 'Fee A' }]
    const corrections: ProductNameCorrections = { a: { value: 'Renamed A', remember: true } }
    const requests = buildProductNameCorrectionRequests(items, corrections, { jobId: 'job-1' })
    expect(requests.every(r => r.fieldName === 'product_name')).toBe(true)
  })
})
