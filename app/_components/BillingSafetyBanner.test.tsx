// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { BillingSafetyBanner } from './BillingSafetyBanner'

afterEach(() => { cleanup() })

describe('BillingSafetyBanner — Step 17H.4B0D4H1B4E2 §20', () => {
  it('NULL hold: renders nothing', () => {
    const { container } = render(<BillingSafetyBanner hold={null} onRebuild={vi.fn()} rebuilding={false} rebuildError={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('reexecution: shows "Configuration update in progress" with no action button', () => {
    render(<BillingSafetyBanner hold={{ reason: 'reexecution' }} onRebuild={vi.fn()} rebuilding={false} rebuildError={null} />)
    expect(screen.getByText('Configuration update in progress')).toBeInTheDocument()
    expect(screen.getByText(/temporarily paused/)).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    // Never leaks internal terminology (§22).
    expect(screen.queryByText(/Model B\+|reconciliation planner|reexecution generation|CAS/i)).not.toBeInTheDocument()
  })

  it('reconciliation_blocked: shows "Commercial configuration needs review" with no action button', () => {
    render(<BillingSafetyBanner hold={{ reason: 'reconciliation_blocked' }} onRebuild={vi.fn()} rebuilding={false} rebuildError={null} />)
    expect(screen.getByText('Commercial configuration needs review')).toBeInTheDocument()
    expect(screen.getByText(/cannot safely reconcile automatically/)).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('schedule_rebuild_required: shows "Billing schedule needs rebuilding" with a working Rebuild action', () => {
    const onRebuild = vi.fn()
    render(<BillingSafetyBanner hold={{ reason: 'schedule_rebuild_required' }} onRebuild={onRebuild} rebuilding={false} rebuildError={null} />)
    expect(screen.getByText('Billing schedule needs rebuilding')).toBeInTheDocument()
    const button = screen.getByRole('button', { name: /rebuild billing schedule/i })
    fireEvent.click(button)
    expect(onRebuild).toHaveBeenCalledTimes(1)
  })

  it('schedule_rebuild_required, rebuilding: disables the action and shows progress state', () => {
    render(<BillingSafetyBanner hold={{ reason: 'schedule_rebuild_required' }} onRebuild={vi.fn()} rebuilding={true} rebuildError={null} />)
    expect(screen.getByRole('button', { name: /rebuilding/i })).toBeDisabled()
  })

  it('schedule_rebuild_required with a rebuild error: surfaces the error text', () => {
    render(<BillingSafetyBanner hold={{ reason: 'schedule_rebuild_required' }} onRebuild={vi.fn()} rebuilding={false} rebuildError="Network error — please try again" />)
    expect(screen.getByText('Network error — please try again')).toBeInTheDocument()
  })
})

// Step 17H.4B0D4H1B4E6 §32 — schedule_rebuild_required must not claim "the
// commercial configuration is up to date" while commercial decisions are
// ALSO still outstanding. Backend hold semantics are untouched — only
// wording/CTA prominence change.
describe('BillingSafetyBanner — Step 17H.4B0D4H1B4E6 §32 (commercial-decision-aware rebuild wording)', () => {
  it('schedule_rebuild_required with NO outstanding decisions (default): unchanged wording, primary (green) CTA', () => {
    render(<BillingSafetyBanner hold={{ reason: 'schedule_rebuild_required' }} onRebuild={vi.fn()} rebuilding={false} rebuildError={null} />)
    expect(screen.getByText('Billing schedule needs rebuilding')).toBeInTheDocument()
    expect(screen.getByText(/commercial configuration is up to date/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /rebuild billing schedule/i })).toHaveStyle({ background: '#1A3D2B' })
  })

  it('schedule_rebuild_required WITH outstanding decisions: never claims configuration is up to date, names the outstanding count, secondary (non-primary) CTA styling', () => {
    render(<BillingSafetyBanner hold={{ reason: 'schedule_rebuild_required' }} onRebuild={vi.fn()} rebuilding={false} rebuildError={null} commercialDecisionsOutstanding={2} />)
    expect(screen.getByText('Billing schedule will need rebuilding')).toBeInTheDocument()
    expect(screen.queryByText(/commercial configuration is up to date/)).not.toBeInTheDocument()
    expect(screen.getByText(/Resolve the remaining commercial configuration first \(2 decisions outstanding\)/)).toBeInTheDocument()
    const button = screen.getByRole('button', { name: /rebuild billing schedule/i })
    expect(button).toHaveStyle({ background: 'transparent' })
  })

  it('singular decision count reads "1 decision outstanding", not "1 decisions"', () => {
    render(<BillingSafetyBanner hold={{ reason: 'schedule_rebuild_required' }} onRebuild={vi.fn()} rebuilding={false} rebuildError={null} commercialDecisionsOutstanding={1} />)
    expect(screen.getByText(/1 decision outstanding/)).toBeInTheDocument()
    expect(screen.queryByText(/1 decisions outstanding/)).not.toBeInTheDocument()
  })

  it('the rebuild button remains a real, callable action even while decisions are outstanding — never hidden or disabled beyond the existing rebuilding state', () => {
    const onRebuild = vi.fn()
    render(<BillingSafetyBanner hold={{ reason: 'schedule_rebuild_required' }} onRebuild={onRebuild} rebuilding={false} rebuildError={null} commercialDecisionsOutstanding={3} />)
    const button = screen.getByRole('button', { name: /rebuild billing schedule/i })
    expect(button).not.toBeDisabled()
    fireEvent.click(button)
    expect(onRebuild).toHaveBeenCalledTimes(1)
  })

  it('commercialDecisionsOutstanding is irrelevant to reexecution/reconciliation_blocked — unchanged wording', () => {
    render(<BillingSafetyBanner hold={{ reason: 'reconciliation_blocked' }} onRebuild={vi.fn()} rebuilding={false} rebuildError={null} commercialDecisionsOutstanding={5} />)
    expect(screen.getByText('Commercial configuration needs review')).toBeInTheDocument()
  })
})
