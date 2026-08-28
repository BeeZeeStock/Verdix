import { describe, it, expect } from 'vitest'
import { normaliseCadence } from './billing-cadence'

describe('normaliseCadence', () => {
  it('defaults to monthly when unset', () => {
    expect(normaliseCadence(null)).toBe('monthly')
    expect(normaliseCadence(undefined)).toBe('monthly')
  })
  it('recognizes semi-annual before the generic annual match', () => {
    expect(normaliseCadence('Semi-Annual')).toBe('semi-annual')
    expect(normaliseCadence('half-yearly')).toBe('semi-annual')
  })
  it('recognizes annual/yearly', () => {
    expect(normaliseCadence('Annual')).toBe('annual')
    expect(normaliseCadence('yearly')).toBe('annual')
  })
  it('recognizes quarterly', () => {
    expect(normaliseCadence('Quarterly')).toBe('quarterly')
  })
  it('falls back to monthly for anything else', () => {
    expect(normaliseCadence('Monthly')).toBe('monthly')
    expect(normaliseCadence('weekly')).toBe('monthly')
  })
})
