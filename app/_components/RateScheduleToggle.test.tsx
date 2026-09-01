// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { RateScheduleToggle } from './RateScheduleToggle'

afterEach(() => { cleanup() })

const SCHEDULE = [
  { from: 0, to: 5, rate_pct: 0 },
  { from: 5, to: 25, rate_pct: 3.2 },
  { from: 25, to: null, rate_pct: 4.5 },
]

describe('RateScheduleToggle — Step 17H.3C2', () => {
  it('collapsed by default: the schedule is not in the document until toggled', () => {
    render(<RateScheduleToggle rateSchedule={SCHEDULE} />)
    expect(screen.getByText(/View rate schedule/)).toBeInTheDocument()
    expect(screen.queryByText(/5–25%/)).not.toBeInTheDocument()
  })

  it('expands on click to show every band, including an open-ended final band', () => {
    render(<RateScheduleToggle rateSchedule={SCHEDULE} />)
    fireEvent.click(screen.getByText(/View rate schedule/))
    expect(screen.getByText('0–5%')).toBeInTheDocument()
    expect(screen.getByText('5–25%')).toBeInTheDocument()
    // Open-ended final band renders ∞, never a hard-coded upper number.
    expect(screen.getByText('25–∞%')).toBeInTheDocument()
    expect(screen.getByText('4.5%')).toBeInTheDocument()
    expect(screen.getByText(/Hide rate schedule/)).toBeInTheDocument()
  })

  it('collapses again on a second click', () => {
    render(<RateScheduleToggle rateSchedule={SCHEDULE} />)
    fireEvent.click(screen.getByText(/View rate schedule/))
    expect(screen.getByText('0–5%')).toBeInTheDocument()
    fireEvent.click(screen.getByText(/Hide rate schedule/))
    expect(screen.queryByText('0–5%')).not.toBeInTheDocument()
  })

  it('renders a schedule of any length, with no hard-coded percentages', () => {
    const oneRow = [{ from: 0, to: null, rate_pct: 10 }]
    render(<RateScheduleToggle rateSchedule={oneRow} />)
    fireEvent.click(screen.getByText(/View rate schedule/))
    expect(screen.getByText('0–∞%')).toBeInTheDocument()
    expect(screen.getByText('10%')).toBeInTheDocument()
    expect(screen.queryByText('4.5%')).not.toBeInTheDocument()
  })
})
