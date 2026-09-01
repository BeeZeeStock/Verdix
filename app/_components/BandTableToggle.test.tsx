// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { BandTableToggle } from './BandTableToggle'

afterEach(() => { cleanup() })

const BANDS = [
  { from_unit: 0, to_unit: 500, monthly_fee: 250 },
  { from_unit: 501, to_unit: 5000, monthly_fee: 2000 },
  { from_unit: 5001, to_unit: null, monthly_fee: null },
]

describe('BandTableToggle — Step 17H.3C1', () => {
  it('collapsed by default: the schedule is not in the document until toggled', () => {
    render(<BandTableToggle bandTable={BANDS} cur="EUR" />)
    expect(screen.getByText(/View full band table/)).toBeInTheDocument()
    expect(screen.queryByText(/501–5,000/)).not.toBeInTheDocument()
  })

  it('expands on click to show every band, including an open-ended final band and a missing price', () => {
    render(<BandTableToggle bandTable={BANDS} cur="EUR" />)
    fireEvent.click(screen.getByText(/View full band table/))
    expect(screen.getByText(/0–500/)).toBeInTheDocument()
    expect(screen.getByText(/501–5,000/)).toBeInTheDocument()
    // Open-ended final band renders ∞, never a hard-coded upper number.
    expect(screen.getByText(/5,001–∞/)).toBeInTheDocument()
    expect(screen.getByText('Price required')).toBeInTheDocument()
    expect(screen.getByText(/Hide full band table/)).toBeInTheDocument()
  })

  it('collapses again on a second click', () => {
    render(<BandTableToggle bandTable={BANDS} cur="EUR" />)
    const button = screen.getByText(/View full band table/)
    fireEvent.click(button)
    expect(screen.getByText(/0–500/)).toBeInTheDocument()
    fireEvent.click(screen.getByText(/Hide full band table/))
    expect(screen.queryByText(/0–500/)).not.toBeInTheDocument()
  })

  it('highlights the row matching the resolved selectedBand — by from_unit, not array position or price', () => {
    render(<BandTableToggle bandTable={BANDS} cur="EUR" selectedBand={{ from_unit: 501, to_unit: 5000, monthly_fee: 2000 }} />)
    fireEvent.click(screen.getByText(/View full band table/))
    expect(screen.getByText(/501–5,000 \(selected\)/)).toBeInTheDocument()
    // Only the matching row is marked — never every row, never a
    // different row picked by position.
    expect(screen.queryByText(/0–500 \(selected\)/)).not.toBeInTheDocument()
    expect(screen.queryByText(/5,001–∞ \(selected\)/)).not.toBeInTheDocument()
  })

  it('two bands sharing an identical price are disambiguated correctly — highlighting never falls back to price equality', () => {
    const bandsWithSharedPrice = [
      { from_unit: 0, to_unit: 500, monthly_fee: 2000 },
      { from_unit: 501, to_unit: 5000, monthly_fee: 2000 },
    ]
    render(<BandTableToggle bandTable={bandsWithSharedPrice} cur="EUR" selectedBand={{ from_unit: 501, to_unit: 5000, monthly_fee: 2000 }} />)
    fireEvent.click(screen.getByText(/View full band table/))
    expect(screen.getByText(/501–5,000 \(selected\)/)).toBeInTheDocument()
    expect(screen.queryByText(/0–500 \(selected\)/)).not.toBeInTheDocument()
  })

  it('no selectedBand (unresolved state): nothing is highlighted', () => {
    render(<BandTableToggle bandTable={BANDS} cur="EUR" selectedBand={null} />)
    fireEvent.click(screen.getByText(/View full band table/))
    expect(screen.queryByText(/\(selected\)/)).not.toBeInTheDocument()
  })

  it('currency and formatting are never hard-coded — a non-EUR/SEK currency renders correctly', () => {
    render(<BandTableToggle bandTable={[{ from_unit: 0, to_unit: null, monthly_fee: 100 }]} cur="USD" />)
    fireEvent.click(screen.getByText(/View full band table/))
    expect(screen.getByText('$100.00')).toBeInTheDocument()
  })
})
