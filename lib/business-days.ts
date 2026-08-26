// Business-day / N-business-days-after-reference deadline primitives —
// Step 16B.3. Generic and reusable for ANY future "N business days after
// event X" rule (a rejection window in this slice, but structurally
// identical to a delivery-acceptance window, a dispute window, or a claim-
// finality window) — nothing in this file knows what a "meeting" or an
// "SQM" is.
//
// No ambient Date.now() anywhere — every function takes its reference
// instant as an explicit ISO timestamp parameter, the same discipline as
// every other evaluator in this codebase (see lib/billable-unit-
// candidate.ts's own header comment).
import type { DeadlineConvention } from './billable-unit-qualification'

export type HolidayCalendarId = 'SE-stockholm'

const DAY_MS = 86_400_000

// ── Timezone-aware civil date/time (IANA tz database via Intl) ──────────
//
// Deliberately built on Intl.DateTimeFormat rather than a bespoke offset
// table — Node's bundled ICU (already relied on elsewhere in this
// codebase, e.g. lib/currency-format.ts) carries the full IANA tz
// database, so this is correct across DST transitions without this module
// needing to encode Sweden's specific DST rules itself.
export interface CivilDateTime {
  year: number
  month: number  // 1-12
  day: number
  hour: number
  minute: number
  second: number
  ms: number
}

function civilDateTimeInTimeZone(isoTimestamp: string, timeZone: string): CivilDateTime {
  const d = new Date(isoTimestamp)
  if (Number.isNaN(d.getTime())) throw new Error(`business-days: invalid timestamp '${isoTimestamp}'`)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d)
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value)
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute'), second: get('second'), ms: d.getUTCMilliseconds() }
}

// Converts a LOCAL civil date/time in `timeZone` to a UTC instant. Standard
// round-trip technique: guess the UTC instant by taking the local
// components as if they were already UTC, then correct by the offset
// actually observed for THAT calendar date in the target zone — correct
// across a DST boundary because the offset is looked up for the TARGET
// date, not the origin instant.
function zonedCivilDateTimeToUtc(c: CivilDateTime, timeZone: string): number {
  const guessUtcMs = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second, c.ms)
  const guessLocal = civilDateTimeInTimeZone(new Date(guessUtcMs).toISOString(), timeZone)
  const guessLocalAsUtcMs = Date.UTC(guessLocal.year, guessLocal.month - 1, guessLocal.day, guessLocal.hour, guessLocal.minute, guessLocal.second, guessLocal.ms)
  const offsetMs = guessLocalAsUtcMs - guessUtcMs
  return guessUtcMs - offsetMs
}

function addCivilDays(c: CivilDateTime, days: number): CivilDateTime {
  const utc = new Date(Date.UTC(c.year, c.month - 1, c.day + days, c.hour, c.minute, c.second, c.ms))
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate(), hour: utc.getUTCHours(), minute: utc.getUTCMinutes(), second: utc.getUTCSeconds(), ms: utc.getUTCMilliseconds() }
}

// ── Swedish public holidays — algorithmic, not a hardcoded per-year table ─
//
// "Business Day" (OS-2026-09 §2.7): "Monday through Friday excluding
// public holidays in Stockholm, Sweden." Every holiday below is computed
// from its actual civil rule (a fixed calendar date, or a fixed offset
// from Easter Sunday, or "the Saturday falling in [date range]") rather
// than a table that would silently go stale past whatever year it was
// last updated through — a genuinely deterministic, reusable primitive,
// not a fixture-scoped approximation. Covers all 13 officially recognized
// Swedish public holidays (Whit Monday was removed from that list in
// 2005, replaced by National Day — not included here, correctly).
function easterSundayUtcMidnight(year: number): number {
  // Anonymous Gregorian algorithm (Meeus/Jones/Butcher) — standard,
  // deterministic Easter-date computation.
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return Date.UTC(year, month - 1, day)
}

// "The Saturday falling in [startUtcMs, startUtcMs + maxDays)" — Sweden's
// Midsummer Day and All Saints' Day are both defined this way rather than
// by a fixed calendar date.
function firstSaturdayFrom(startUtcMs: number, maxDays: number): number {
  for (let i = 0; i < maxDays; i++) {
    const ms = startUtcMs + i * DAY_MS
    if (new Date(ms).getUTCDay() === 6) return ms
  }
  throw new Error('business-days: no Saturday found in the expected range')
}

const holidayCache = new Map<number, Set<number>>()

function swedishPublicHolidaysForYear(year: number): Set<number> {
  const cached = holidayCache.get(year)
  if (cached) return cached
  const easter = easterSundayUtcMidnight(year)
  const holidays = new Set<number>([
    Date.UTC(year, 0, 1),                          // Nyårsdagen (New Year's Day)
    Date.UTC(year, 0, 6),                           // Trettondedag jul (Epiphany)
    easter - 2 * DAY_MS,                            // Långfredagen (Good Friday)
    easter,                                         // Påskdagen (Easter Sunday)
    easter + DAY_MS,                                // Annandag påsk (Easter Monday)
    Date.UTC(year, 4, 1),                           // Första maj (May Day)
    easter + 39 * DAY_MS,                           // Kristi himmelsfärdsdag (Ascension Day)
    easter + 49 * DAY_MS,                           // Pingstdagen (Whit Sunday)
    Date.UTC(year, 5, 6),                           // Sveriges nationaldag (National Day, since 2005)
    firstSaturdayFrom(Date.UTC(year, 5, 20), 7),    // Midsommardagen (Midsummer Day: Sat in Jun 20-26)
    firstSaturdayFrom(Date.UTC(year, 9, 31), 7),    // Alla helgons dag (All Saints' Day: Sat in Oct 31-Nov 6)
    Date.UTC(year, 11, 25),                         // Juldagen (Christmas Day)
    Date.UTC(year, 11, 26),                         // Annandag jul (Boxing Day)
  ])
  holidayCache.set(year, holidays)
  return holidays
}

function isCivilDateBusinessDay(c: { year: number; month: number; day: number }, calendar: HolidayCalendarId): boolean {
  const utcMidnight = Date.UTC(c.year, c.month - 1, c.day)
  const dow = new Date(utcMidnight).getUTCDay()
  if (dow === 0 || dow === 6) return false
  if (calendar === 'SE-stockholm') return !swedishPublicHolidaysForYear(c.year).has(utcMidnight)
  throw new Error(`business-days: unsupported holiday_calendar '${calendar}'`)
}

// Public predicate — a business day is determined by the CIVIL date in the
// given timezone, not the raw UTC instant (a UTC timestamp near midnight
// Stockholm time can fall on a different local calendar date).
export function isBusinessDayAt(isoTimestamp: string, calendar: HolidayCalendarId, timezone: string): boolean {
  return isCivilDateBusinessDay(civilDateTimeInTimeZone(isoTimestamp, timezone), calendar)
}

// ── N-business-days-after-reference deadline ─────────────────────────────
export interface ComputeBusinessDayDeadlineParams {
  referenceTime: string
  businessDays: number
  calendar: HolidayCalendarId
  timezone: string
  convention: DeadlineConvention
  // Step 16B.3 hardening — 'end_of_business_day' is only a real,
  // contractually-meaningful convention with an explicit local cutoff
  // ('HH:MM:SS'). This function never defaults or guesses one — a
  // hardcoded 23:59:59.999 would silently mean "end of CALENDAR day," a
  // materially different (and unstated) choice. Required exactly when
  // convention === 'end_of_business_day'; ignored otherwise. Callers are
  // expected to have already resolved this from rule configuration (see
  // lib/billable-unit-candidate-finality.ts's resolveRejectionDeadline,
  // which returns 'unresolved' rather than calling this function at all
  // when it's missing).
  businessDayEndLocalTime?: string
}

function parseLocalTimeOfDay(hhmmss: string): { hour: number; minute: number; second: number } {
  const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(hhmmss)
  if (!match) throw new Error(`computeBusinessDayDeadline: businessDayEndLocalTime must be 'HH:MM:SS', got '${hhmmss}'`)
  const hour = Number(match[1]); const minute = Number(match[2]); const second = Number(match[3])
  if (hour > 23 || minute > 59 || second > 59) throw new Error(`computeBusinessDayDeadline: businessDayEndLocalTime '${hhmmss}' is out of range`)
  return { hour, minute, second }
}

// The reference day itself never counts as one of the N business days,
// even if it is itself a business day — "N Business Days AFTER the event"
// starts counting from the NEXT calendar day. Deterministic and
// reproducible: identical inputs always produce the identical instant.
export function computeBusinessDayDeadline(params: ComputeBusinessDayDeadlineParams): string {
  const { referenceTime, businessDays, calendar, timezone, convention, businessDayEndLocalTime } = params
  if (!Number.isInteger(businessDays) || businessDays <= 0) {
    throw new Error(`computeBusinessDayDeadline: businessDays must be a positive integer, got ${businessDays}`)
  }
  const referenceCivil = civilDateTimeInTimeZone(referenceTime, timezone)
  let cursor = referenceCivil
  let counted = 0
  while (counted < businessDays) {
    cursor = addCivilDays(cursor, 1)
    if (isCivilDateBusinessDay(cursor, calendar)) counted++
  }

  if (convention === 'same_clock_time') {
    const deadlineCivil: CivilDateTime = { ...cursor, hour: referenceCivil.hour, minute: referenceCivil.minute, second: referenceCivil.second, ms: referenceCivil.ms }
    return new Date(zonedCivilDateTimeToUtc(deadlineCivil, timezone)).toISOString()
  }
  if (convention === 'end_of_business_day') {
    if (!businessDayEndLocalTime) {
      throw new Error("computeBusinessDayDeadline: convention 'end_of_business_day' requires businessDayEndLocalTime — without it this would silently mean 'end of calendar day' instead")
    }
    const { hour, minute, second } = parseLocalTimeOfDay(businessDayEndLocalTime)
    const deadlineCivil: CivilDateTime = { ...cursor, hour, minute, second, ms: 999 }
    return new Date(zonedCivilDateTimeToUtc(deadlineCivil, timezone)).toISOString()
  }
  throw new Error(`computeBusinessDayDeadline: unsupported deadline_convention '${convention as string}'`)
}
