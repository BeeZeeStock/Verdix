import { describe, it, expect } from 'vitest'
import { getLastNCompletedCadenceWindows } from './tariff'

function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

describe('getLastNCompletedCadenceWindows — Step 17C.2, section 3', () => {
  it('at month close, returns exactly the 3 most recently COMPLETED monthly periods, oldest first', () => {
    const anchor = new Date(2026, 9, 1) // contract starts 2026-10-01, monthly cadence
    // asOf is exactly the instant the 3rd period (Dec) closes: Jan 1 00:00.
    const asOf = new Date(2027, 0, 1)
    const windows = getLastNCompletedCadenceWindows({ anchorDate: anchor, cadence: 'monthly', asOf, n: 3 })
    expect(windows.map(w => [fmt(w.start), fmt(w.end)])).toEqual([
      ['2026-10-01', '2026-10-31'],
      ['2026-11-01', '2026-11-30'],
      ['2026-12-01', '2026-12-31'],
    ])
  })

  it('the CURRENTLY-OPEN period is never included — asOf mid-period excludes that period entirely', () => {
    const anchor = new Date(2026, 9, 1)
    const asOf = new Date(2027, 0, 15) // mid-January — January itself is still open
    const windows = getLastNCompletedCadenceWindows({ anchorDate: anchor, cadence: 'monthly', asOf, n: 3 })
    // Still Oct/Nov/Dec — January (open) never appears.
    expect(windows.map(w => [fmt(w.start), fmt(w.end)])).toEqual([
      ['2026-10-01', '2026-10-31'],
      ['2026-11-01', '2026-11-30'],
      ['2026-12-01', '2026-12-31'],
    ])
  })

  it('one instant before a period closes, that period is correctly excluded (boundary is exact)', () => {
    const anchor = new Date(2026, 9, 1) // contract starts Oct 1 — no window before it exists at all
    const oneMsBeforeClose = new Date(2026, 11, 31, 23, 59, 59, 999) // Dec 31 23:59:59.999 — Dec not yet closed
    const windows = getLastNCompletedCadenceWindows({ anchorDate: anchor, cadence: 'monthly', asOf: oneMsBeforeClose, n: 3 })
    // Only Oct and Nov have closed (Dec closes exactly at the NEXT
    // instant, Jan 1 00:00:00.000) — asked for 3, correctly got 2, never
    // padded with an invented pre-contract window.
    expect(windows.map(w => fmt(w.end))).toEqual(['2026-10-31', '2026-11-30'])
  })

  it('fewer than n periods have closed yet — returns fewer than n, never padded/invented', () => {
    const anchor = new Date(2026, 9, 1)
    const asOf = new Date(2026, 10, 1) // Nov 1 00:00 — only Oct has closed (Nov's own window just started)
    const windows = getLastNCompletedCadenceWindows({ anchorDate: anchor, cadence: 'monthly', asOf, n: 3 })
    expect(windows).toHaveLength(1)
    expect(fmt(windows[0].start)).toBe('2026-10-01')
  })

  it('zero periods closed yet (asOf before the contract even started) — returns empty', () => {
    const anchor = new Date(2026, 9, 1)
    const asOf = new Date(2026, 8, 15)
    const windows = getLastNCompletedCadenceWindows({ anchorDate: anchor, cadence: 'monthly', asOf, n: 3 })
    expect(windows).toHaveLength(0)
  })
})

describe('getLastNCompletedCadenceWindows — boundary tests across month length', () => {
  it('correctly spans a 31-day month, a 30-day month, and February (28 days, non-leap) in one 3-window slice', () => {
    const anchor = new Date(2027, 0, 1) // Jan 1, 2027 (2027 is not a leap year)
    const asOf = new Date(2027, 3, 1) // April 1 — Jan/Feb/Mar all closed
    const windows = getLastNCompletedCadenceWindows({ anchorDate: anchor, cadence: 'monthly', asOf, n: 3 })
    expect(windows.map(w => [fmt(w.start), fmt(w.end)])).toEqual([
      ['2027-01-01', '2027-01-31'], // 31 days
      ['2027-02-01', '2027-02-28'], // 28 days
      ['2027-03-01', '2027-03-31'], // 31 days
    ])
  })

  it('correctly includes a leap-year February (29 days)', () => {
    const anchor = new Date(2028, 0, 1) // 2028 IS a leap year
    const asOf = new Date(2028, 3, 1)
    const windows = getLastNCompletedCadenceWindows({ anchorDate: anchor, cadence: 'monthly', asOf, n: 3 })
    expect(fmt(windows[1].end)).toBe('2028-02-29')
  })

  it('correctly spans an anchor date near month-end (day 31) across months with fewer days — the window still starts on day 31 or clamps sensibly via the Date constructor\'s own rollover, and boundaries stay internally consistent', () => {
    const anchor = new Date(2027, 0, 31) // Jan 31 anchor
    const asOf = new Date(2027, 4, 1)
    const windows = getLastNCompletedCadenceWindows({ anchorDate: anchor, cadence: 'monthly', asOf, n: 3 })
    expect(windows).toHaveLength(3)
    // Whatever exact dates result, every window's end must be >= its own
    // start, and windows must be chronologically ordered with no overlap —
    // the real invariant this test protects, independent of exactly which
    // day-of-month the JS Date rollover lands on.
    for (const w of windows) expect(w.end.getTime()).toBeGreaterThanOrEqual(w.start.getTime())
    for (let i = 1; i < windows.length; i++) expect(windows[i].start.getTime()).toBeGreaterThan(windows[i - 1].end.getTime())
  })
})

describe('getLastNCompletedCadenceWindows — DST changes', () => {
  it('a 3-month rolling window spanning a DST fall-back transition (Sweden: late October) produces exactly 3 correct, non-overlapping, gapless-boundary windows', () => {
    // 2026-10-01 -> Nov -> Dec, evaluated at close of December: this exact
    // span crosses Sweden's real 2026 DST fall-back (late October) — the
    // same real-world span Step 17C.1a's own DST bug was found in.
    const anchor = new Date(2026, 9, 1)
    const asOf = new Date(2027, 0, 1)
    const windows = getLastNCompletedCadenceWindows({ anchorDate: anchor, cadence: 'monthly', asOf, n: 3 })
    expect(windows.map(w => [fmt(w.start), fmt(w.end)])).toEqual([
      ['2026-10-01', '2026-10-31'],
      ['2026-11-01', '2026-11-30'],
      ['2026-12-01', '2026-12-31'],
    ])
    // Each window's end is midnight local time (00:00:00.000) on its
    // final calendar day — never 23:00/01:00, which a DST-unsafe
    // raw-millisecond subtraction would have produced (see
    // enumerateCadenceWindows' own header comment for the exact historical
    // bug this guards against).
    for (const w of windows) {
      expect(w.end.getHours()).toBe(0)
      expect(w.end.getMinutes()).toBe(0)
      expect(w.end.getSeconds()).toBe(0)
      expect(w.end.getMilliseconds()).toBe(0)
    }
  })

  it('a 3-month rolling window spanning a DST spring-forward transition (Sweden: late March) is equally correct', () => {
    const anchor = new Date(2027, 1, 1) // Feb 1, 2027
    const asOf = new Date(2027, 4, 1) // evaluate at close of April (Feb/Mar/Apr — crosses late-March DST)
    const windows = getLastNCompletedCadenceWindows({ anchorDate: anchor, cadence: 'monthly', asOf, n: 3 })
    expect(windows.map(w => [fmt(w.start), fmt(w.end)])).toEqual([
      ['2027-02-01', '2027-02-28'],
      ['2027-03-01', '2027-03-31'],
      ['2027-04-01', '2027-04-30'],
    ])
    for (const w of windows) expect(w.end.getHours()).toBe(0)
  })
})
