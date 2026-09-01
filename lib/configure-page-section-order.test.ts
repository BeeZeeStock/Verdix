import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// Step E9C.3 §10 — a lightweight, non-brittle verification of the
// required Configure-page information architecture (Commercial Logic ->
// Billing Operations -> Manual Invoice -> Billing Timeline), without
// standing up a full render test for an 11,000+ line page component with
// no existing render-test precedent (confirmed: no test file for this
// page exists anywhere in the repo) and heavy fetch/auth/state
// dependencies that would make a genuine render harness both expensive
// and, per this task's own instruction, exactly the kind of "brittle
// pixel/layout test" to avoid. Instead: read the page's own source and
// assert the RELATIVE ORDER of each section's unique, unambiguous JSX
// anchor (confirmed by grep to appear exactly once each) — a real,
// permanent regression guard against the sections silently drifting back
// out of order, without asserting anything about pixels/styling/spacing.
describe('Configure page — required section order (Step E9C.3)', () => {
  const source = readFileSync(
    join(process.cwd(), 'app/(dashboard)/configure/[id]/page.tsx'),
    'utf-8',
  )

  function indexOfOnce(needle: string): number {
    const idx = source.indexOf(needle)
    expect(idx, `expected to find exactly one occurrence of ${JSON.stringify(needle)}`).toBeGreaterThan(-1)
    expect(source.indexOf(needle, idx + 1), `expected ${JSON.stringify(needle)} to appear exactly once`).toBe(-1)
    return idx
  }

  it('Commercial Logic renders before Billing Operations', () => {
    const commercialLogic = indexOfOnce('Commercial logic &amp; billing setup</h2>')
    const billingOperations = indexOfOnce('<OperationalInputsSection')
    expect(commercialLogic).toBeLessThan(billingOperations)
  })

  it('Billing Operations renders before Manual Invoice', () => {
    const billingOperations = indexOfOnce('<OperationalInputsSection')
    const manualInvoice = indexOfOnce('<ManualInvoiceCard jobId={id} />')
    expect(billingOperations).toBeLessThan(manualInvoice)
  })

  it('Manual Invoice renders before Billing Timeline', () => {
    const manualInvoice = indexOfOnce('<ManualInvoiceCard jobId={id} />')
    const billingTimeline = indexOfOnce('<BillingSummaryCard')
    expect(manualInvoice).toBeLessThan(billingTimeline)
  })

  // Rolling-band evaluation is NOT a top-level page.tsx section — it
  // renders INSIDE BillingSummaryCard itself (confirmed by reading that
  // file directly), after that component's own main period-entry list.
  // Verified here at the source level for the same reason as above.
  it('Billing Timeline renders before Rolling-band evaluation (within BillingSummaryCard itself)', () => {
    const billingSummaryCardSource = readFileSync(
      join(process.cwd(), 'app/_components/BillingSummaryCard.tsx'),
      'utf-8',
    )
    const mainEntries = billingSummaryCardSource.indexOf('upcomingPlanned.map(e => renderEntry(e, false))')
    const rollingBand = billingSummaryCardSource.indexOf('Rolling-band evaluation')
    expect(mainEntries).toBeGreaterThan(-1)
    expect(rollingBand).toBeGreaterThan(-1)
    expect(mainEntries).toBeLessThan(rollingBand)
  })
})
