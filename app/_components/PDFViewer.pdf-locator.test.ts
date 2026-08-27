// Step 17B0.4, item 7 — a real PDF-level locator test. Unit tests against
// hand-typed strings alone (see PDFViewer.test.ts) can prove norm()/
// pickMatch()'s own logic is correct, but cannot prove that a real PDF's
// text layer — with its own font encoding, spacing, and line-break
// artifacts — actually contains a match for a given source_sections/
// field_sources heading. This test extracts text from a real (sanitized,
// hand-built, checked-in) PDF fixture via pdf-parse — a genuinely separate
// extraction path from pdfjs-dist's browser text layer, but exercising the
// SAME real-world "does this exact string exist verbatim in real
// PDF-extracted text" question — and runs it through the exact matching
// function (pickMatch) PDFViewer.tsx itself uses.
//
// lib/__fixtures__/pdf-locator-test.pdf contains the real Remembill
// headings named in this step's brief, verbatim, across two pages (main
// agreement / Bilaga 1) — see the generator comment at the top of that
// fixture's own creation script for how it was built and verified.
//
// What this does NOT cover: pdfjs-dist's own browser-side text-layer DOM
// rendering, and the actual visible marker/highlight paintSection draws —
// those need a real browser and are a manual check (see this step's
// report). This test covers everything upstream of that: the real
// PDF-extracted text genuinely contains each heading, and pickMatch finds
// it using the same normalization PDFViewer.tsx runs in production.
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll } from 'vitest'
import { PDFParse } from 'pdf-parse'
import { norm, pickMatch } from './PDFViewer'

const FIXTURE_PATH = new URL('../../lib/__fixtures__/pdf-locator-test.pdf', import.meta.url)

type Window = { combined: string; normalized: string }

// A simplified stand-in for PDFViewer.tsx's own buildWindowedText — that
// function walks real DOM Text nodes (unavailable here, no browser), but
// the actual thing under test is pickMatch's string matching, not DOM
// walking. Slides a window across each page's extracted text at every
// character position (small fixture, fast), same 120-char window size and
// "needle near the start of some window" shape pickMatch's own maxIdx
// cascade expects.
function buildTextWindows(pageText: string): Window[] {
  const windows: Window[] = []
  for (let i = 0; i < pageText.length; i++) {
    const combined = pageText.slice(i, i + 120)
    windows.push({ combined, normalized: norm(combined) })
  }
  return windows
}

let pageWindows: Window[][]

beforeAll(async () => {
  const buf = readFileSync(FIXTURE_PATH)
  const parser = new PDFParse({ data: buf })
  const result = await parser.getText()
  await parser.destroy()
  expect(result.pages.length).toBe(2)
  pageWindows = result.pages.map(p => buildTextWindows(p.text))
})

function matchesSomewhere(heading: string): boolean {
  const needle = norm(heading)
  return pageWindows.some(windows => pickMatch(windows, needle) !== null)
}

describe('17B0.4 item 7 — real PDF text-layer match for every required real heading', () => {
  it('"2. Pilot och affärsmodell" → match found', () => {
    expect(matchesSomewhere('2. Pilot och affärsmodell')).toBe(true)
  })

  it('"3. Modellen i korthet" → match found', () => {
    expect(matchesSomewhere('3. Modellen i korthet')).toBe(true)
  })

  it('"4. Fast plattform efter avtalad volym" → match found', () => {
    expect(matchesSomewhere('4. Fast plattform efter avtalad volym')).toBe(true)
  })

  it('"5. Resultatdel efter värdeviktad betalgrad" → match found', () => {
    expect(matchesSomewhere('5. Resultatdel efter värdeviktad betalgrad')).toBe(true)
  })

  it('"4. Avtalad volym" → match found (main agreement, distinct from Bilaga 1\'s headings)', () => {
    expect(matchesSomewhere('4. Avtalad volym')).toBe(true)
  })

  it('each heading is found on its correct page — main agreement heading is NOT on the Bilaga 1 page and vice versa', () => {
    const needleMain = norm('4. Avtalad volym')
    const needleBilaga = norm('2. Pilot och affärsmodell')
    expect(pickMatch(pageWindows[0], needleMain)).not.toBeNull() // page 1 = main agreement
    expect(pickMatch(pageWindows[1], needleMain)).toBeNull()
    expect(pickMatch(pageWindows[1], needleBilaga)).not.toBeNull() // page 2 = Bilaga 1
    expect(pickMatch(pageWindows[0], needleBilaga)).toBeNull()
  })
})

describe('17B0.4 item 7 — normalized/invented UI labels are NOT relied upon as locators', () => {
  it('a friendly display_label-style string never matches real PDF text — proving exact_source_heading, not display_label, must be the locator', () => {
    // The exact bug this step fixes: extraction was previously writing
    // invented compound labels like this instead of the real heading.
    expect(matchesSomewhere('Bilaga 1, Section 2')).toBe(false)
    expect(matchesSomewhere('Bilaga 1, Section 5')).toBe(false)
    expect(matchesSomewhere('Bilaga 1 – Pris och kommersiell modell, Section 2')).toBe(false)
    expect(matchesSomewhere('Section 4. Avtalad volym')).toBe(false)
  })

  it('the corresponding real exact_source_heading DOES match, for the same clauses', () => {
    expect(matchesSomewhere('2. Pilot och affärsmodell')).toBe(true)
    expect(matchesSomewhere('5. Resultatdel efter värdeviktad betalgrad')).toBe(true)
    expect(matchesSomewhere('4. Avtalad volym')).toBe(true)
  })
})
