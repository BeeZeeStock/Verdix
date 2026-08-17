import { describe, it, expect } from 'vitest'
import { parseBooleanSetting, shouldAutoCreateOrg } from './feature-flags'

describe('parseBooleanSetting', () => {
  it('returns the default when unseeded (undefined)', () => {
    expect(parseBooleanSetting(undefined, true)).toBe(true)
    expect(parseBooleanSetting(undefined, false)).toBe(false)
  })

  it('returns the default when the row exists but value is null', () => {
    expect(parseBooleanSetting(null, true)).toBe(true)
  })

  it('treats the string "true" as true (the actual jsonb-round-trip shape)', () => {
    expect(parseBooleanSetting('true', false)).toBe(true)
  })

  it('treats the string "false" as false', () => {
    expect(parseBooleanSetting('false', true)).toBe(false)
  })

  it('treats a JS boolean true as true (defensive, in case storage format changes)', () => {
    expect(parseBooleanSetting(true, false)).toBe(true)
  })

  it('treats any other garbage string as false, not the default', () => {
    expect(parseBooleanSetting('yes', true)).toBe(false)
    expect(parseBooleanSetting('1', true)).toBe(false)
  })
})

describe('shouldAutoCreateOrg', () => {
  it('regression guard: never auto-creates when self-service is disabled, regardless of membership state', () => {
    expect(shouldAutoCreateOrg(false, false)).toBe(false)
    expect(shouldAutoCreateOrg(true, false)).toBe(false)
  })

  it('auto-creates only for an unknown identity while self-service is enabled', () => {
    expect(shouldAutoCreateOrg(false, true)).toBe(true)
  })

  it('never auto-creates for an identity that already has a membership', () => {
    expect(shouldAutoCreateOrg(true, true)).toBe(false)
  })
})
