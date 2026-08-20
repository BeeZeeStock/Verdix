import { describe, it, expect } from 'vitest'
import { unwrapEmbedded } from './postgrest-helpers'

describe('unwrapEmbedded', () => {
  it('returns the first element when PostgREST embeds as an array (no unique constraint on the FK)', () => {
    expect(unwrapEmbedded([{ a: 1 }, { a: 2 }])).toEqual({ a: 1 })
  })

  it('returns the value directly when PostgREST embeds as a single object (unique constraint on the FK)', () => {
    expect(unwrapEmbedded({ a: 1 })).toEqual({ a: 1 })
  })

  it('returns undefined for an empty array', () => {
    expect(unwrapEmbedded([])).toBeUndefined()
  })

  it('returns undefined for null/undefined', () => {
    expect(unwrapEmbedded(null)).toBeUndefined()
    expect(unwrapEmbedded(undefined)).toBeUndefined()
  })
})
