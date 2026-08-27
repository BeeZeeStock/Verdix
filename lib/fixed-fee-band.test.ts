import { describe, it, expect } from 'vitest'
import { resolveFixedFeeBand } from './fixed-fee-band'
import type { FixedFeeBand } from './types'

const BANDS: FixedFeeBand[] = [
  { from_unit: 1, to_unit: 500, monthly_fee: 500 },
  { from_unit: 501, to_unit: 1500, monthly_fee: 1200 },
  { from_unit: 1501, to_unit: 5000, monthly_fee: 2000 },
]

describe('resolveFixedFeeBand (item 13)', () => {
  it('a committed volume of 5,000 resolves to the 1,501–5,000 band -> €2,000/month', () => {
    const result = resolveFixedFeeBand(BANDS, 5000)
    expect(result).toEqual({ status: 'resolved', band: { from_unit: 1501, to_unit: 5000, monthly_fee: 2000 } })
  })

  it('a committed volume of 800 resolves to the 501–1,500 band', () => {
    const result = resolveFixedFeeBand(BANDS, 800)
    expect(result.status).toBe('resolved')
    if (result.status === 'resolved') expect(result.band.monthly_fee).toBe(1200)
  })

  it('fails closed (no_bands) when no band table was extracted', () => {
    expect(resolveFixedFeeBand(null, 5000).status).toBe('no_bands')
    expect(resolveFixedFeeBand([], 5000).status).toBe('no_bands')
  })

  it('fails closed (no_match) when no committed volume is known', () => {
    const result = resolveFixedFeeBand(BANDS, null)
    expect(result.status).toBe('no_match')
  })

  it('fails closed (no_match) when the volume falls outside every band', () => {
    const result = resolveFixedFeeBand(BANDS, 10000)
    expect(result.status).toBe('no_match')
  })
})
