// @vitest-environment jsdom
// Step: surgical UI fix — Commercial BoM component-name editing.
// Focused tests for CorrectionInput's new pencil-on-hover presentation,
// isolated from the rest of the (enormous) configure page. Correction
// semantics/persistence are unchanged — onChange still writes straight into
// the SAME corrections[item.id] local state the caller already owned; only
// the presentation (always-visible form -> pencil-reveal inline editor)
// changed. See lib/product-name-corrections.test.ts for the unchanged,
// separately-tested persistence layer this component's onChange feeds.
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { CorrectionInput } from './page'

afterEach(() => cleanup())

describe('CorrectionInput — BoM component-name pencil-on-hover editing', () => {
  it('normal state renders only the plain name — no always-visible input/label', () => {
    render(<CorrectionInput displayName="Platform subscription (periods 4–12)" correctedValue="" onChange={vi.fn()} />)
    expect(screen.getByText('Platform subscription (periods 4–12)')).toBeInTheDocument()
    expect(screen.queryByText(/edit component name/i)).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/enter correct name/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('renders the extracted/current name for every representative component kind (generic, not per-fixture)', () => {
    for (const name of ['Platform subscription (periods 4–12)', 'Issued payment request', 'Completed payment success', 'Requests 5,001+']) {
      cleanup()
      render(<CorrectionInput displayName={name} correctedValue="" onChange={vi.fn()} />)
      expect(screen.getByText(name)).toBeInTheDocument()
    }
  })

  it('an edit affordance (pencil) exists and is titled for both name and pencil targets', () => {
    render(<CorrectionInput displayName="Issued payment request" correctedValue="" onChange={vi.fn()} />)
    const editTargets = screen.getAllByTitle('Edit component name')
    // one on the name span, one on the pencil button — both trigger the same edit
    expect(editTargets.length).toBe(2)
  })

  it('clicking the pencil enters inline edit mode, prepopulated with the current displayed name', () => {
    render(<CorrectionInput displayName="Completed payment success" correctedValue="" onChange={vi.fn()} />)
    const [, pencil] = screen.getAllByTitle('Edit component name')
    fireEvent.click(pencil)
    const input = screen.getByRole('textbox') as HTMLInputElement
    expect(input.value).toBe('Completed payment success')
  })

  it('clicking the name text itself also enters edit mode (touch/no-hover devices)', () => {
    render(<CorrectionInput displayName="Requests 5,001+" correctedValue="" onChange={vi.fn()} />)
    const [nameSpan] = screen.getAllByTitle('Edit component name')
    fireEvent.click(nameSpan)
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('editor prepopulates with an EXISTING correction, not the original extracted name, when one is already staged', () => {
    render(<CorrectionInput displayName="Requests 5,001+" correctedValue="Overage — requests above plan" onChange={vi.fn()} />)
    expect(screen.getByText('Overage — requests above plan')).toBeInTheDocument()
    fireEvent.click(screen.getAllByTitle('Edit component name')[1])
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Overage — requests above plan')
  })

  it('cancel restores read state without calling onChange', () => {
    const onChange = vi.fn()
    render(<CorrectionInput displayName="Issued payment request" correctedValue="" onChange={onChange} />)
    fireEvent.click(screen.getAllByTitle('Edit component name')[1])
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Something typed then abandoned' } })
    fireEvent.click(screen.getByTitle('Cancel'))
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByText('Issued payment request')).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('Escape key cancels exactly like the cancel button', () => {
    const onChange = vi.fn()
    render(<CorrectionInput displayName="Issued payment request" correctedValue="" onChange={onChange} />)
    fireEvent.click(screen.getAllByTitle('Edit component name')[1])
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('save commits the typed name via onChange and returns to read state showing the new name', () => {
    const onChange = vi.fn()
    render(<CorrectionInput displayName="Issued payment request" correctedValue="" onChange={onChange} />)
    fireEvent.click(screen.getAllByTitle('Edit component name')[1])
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Per-request billing fee' } })
    fireEvent.click(screen.getByTitle('Save'))
    expect(onChange).toHaveBeenCalledWith('Per-request billing fee')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('Enter key saves exactly like the save button', () => {
    const onChange = vi.fn()
    render(<CorrectionInput displayName="Issued payment request" correctedValue="" onChange={onChange} />)
    fireEvent.click(screen.getAllByTitle('Edit component name')[1])
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Per-request billing fee' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('Per-request billing fee')
  })

  it('save is disabled (button) and a no-op (Enter) for a blank/whitespace-only draft — never clears an existing correction accidentally', () => {
    const onChange = vi.fn()
    render(<CorrectionInput displayName="Issued payment request" correctedValue="" onChange={onChange} />)
    fireEvent.click(screen.getAllByTitle('Edit component name')[1])
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } })
    expect(screen.getByTitle('Save')).toBeDisabled()
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('the pencil/edit affordance is present regardless of confidence — callers no longer confidence-gate rendering this component at all', () => {
    // This component itself never reads confidence_score (removed from its
    // props entirely) — the BoM's warning triangle is the only remaining
    // confidence-gated element, rendered by the caller, independently.
    render(<CorrectionInput displayName="High-confidence fee" correctedValue="" onChange={vi.fn()} />)
    expect(screen.getAllByTitle('Edit component name').length).toBe(2)
  })
})
