import { describe, it, expect } from 'vitest'
import { hasContractStarted } from './performance-share-timing'

describe('hasContractStarted — Step 17E.1, item B', () => {
  it('false when asOf is before contract_start_date', () => {
    expect(hasContractStarted('2026-10-01', new Date('2026-08-28T00:00:00'))).toBe(false)
  })

  it('true when asOf is on or after contract_start_date', () => {
    expect(hasContractStarted('2026-10-01', new Date('2026-10-01T00:00:00'))).toBe(true)
    expect(hasContractStarted('2026-10-01', new Date('2026-11-15T00:00:00'))).toBe(true)
  })

  it('true when no contract_start_date is stated at all — never blocked by an unknown date', () => {
    expect(hasContractStarted(null)).toBe(true)
    expect(hasContractStarted(undefined)).toBe(true)
  })
})
