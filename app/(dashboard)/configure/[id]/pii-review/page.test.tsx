// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { Suspense } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import PIIReviewPage from './page'

const pushMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

const JOB_ID = 'job-abc-123'

type PIIEntity = {
  id: string
  entity_type: string
  original_value: string
  token: string
  approved: boolean
  aliases?: string[]
  aliasOf?: string | null
}
type PIIOccurrence = {
  id: string
  detection_source: string
  confidence_pct: number
  pii_entity: PIIEntity
}

function entity(overrides: Partial<PIIEntity> & { id: string; original_value: string }): PIIOccurrence {
  return {
    id: `occ-${overrides.id}`,
    detection_source: 'regex',
    confidence_pct: 90,
    pii_entity: {
      entity_type: 'ORG',
      token: `[ORG_${overrides.id}]`,
      approved: false,
      ...overrides,
    } as PIIEntity,
  }
}

type Call = { url: string; init?: RequestInit }

// A small stateful fake backend — mirrors what app/api/jobs/[id]/pii/route.ts's
// PATCH handler actually does (approve marks approved:true; reject/ignore
// remove the occurrence from this job's list) so tests can assert on real
// end-state behavior (e.g. "the last pending row disappearing") rather than
// hand-coding every intermediate response.
function mockBackend(initial: PIIOccurrence[]) {
  let occurrences = initial
  const calls: Call[] = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const method = init?.method ?? 'GET'

    if (url === `/api/jobs/${JOB_ID}/pii` && method === 'GET') {
      return { ok: true, json: async () => occurrences } as Response
    }
    if (url === `/api/jobs/${JOB_ID}/pii` && method === 'PATCH') {
      const body = JSON.parse(init!.body as string) as { action: string; entityId: string }
      if (body.action === 'approve') {
        occurrences = occurrences.map(o =>
          o.pii_entity.id === body.entityId ? { ...o, pii_entity: { ...o.pii_entity, approved: true } } : o
        )
      } else if (body.action === 'reject' || body.action === 'ignore') {
        occurrences = occurrences.filter(o => o.pii_entity.id !== body.entityId)
      }
      return { ok: true, json: async () => ({ ok: true }) } as Response
    }
    if (url === `/api/jobs/${JOB_ID}/execute` && method === 'POST') {
      return { ok: true, json: async () => ({ jobId: JOB_ID, status: 'EXTRACTING' }) } as Response
    }
    if (url === `/api/jobs/${JOB_ID}` && method === 'DELETE') {
      return { ok: true, json: async () => ({ ok: true }) } as Response
    }
    throw new Error(`unexpected fetch call in test: ${method} ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, calls, getOccurrences: () => occurrences }
}

// `use(params)` suspends on the very first render even for an
// already-resolved Promise.resolve(...) — React has no synchronous way to
// read a plain Promise's internal state, so it always needs one real
// microtask tick via .then() before it can re-render with the unwrapped
// value. Wrapping in a Suspense boundary (this file's stand-in for the
// Suspense boundary Next.js's own router normally provides around a route
// segment) plus an awaited async act() flush is what lets that tick happen
// before assertions run.
async function renderPage() {
  let result: ReturnType<typeof render>
  await act(async () => {
    result = render(
      <Suspense fallback={<div>loading…</div>}>
        <PIIReviewPage params={Promise.resolve({ id: JOB_ID })} />
      </Suspense>
    )
  })
  return result!
}

function executeCalls(calls: Call[]) {
  return calls.filter(c => c.url === `/api/jobs/${JOB_ID}/execute`)
}
function deleteCalls(calls: Call[]) {
  return calls.filter(c => c.url === `/api/jobs/${JOB_ID}` && c.init?.method === 'DELETE')
}

describe('PIIReviewPage — row actions never advance the workflow', () => {
  it('approving the last pending row stays on PII Review and never calls /execute', async () => {
    const { calls } = mockBackend([entity({ id: '1', original_value: 'CoAccept AB' })])
    await renderPage()

    const approveBtn = await screen.findByRole('button', { name: 'Approve' })
    fireEvent.click(approveBtn)

    await waitFor(() => expect(screen.getByText('1 approved · 0 pending')).toBeInTheDocument())

    expect(executeCalls(calls)).toHaveLength(0)
    expect(pushMock).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /Approve all & extract contract terms/ })).toBeInTheDocument()
  })

  it('rejecting (×) the last pending row stays on PII Review and never calls /execute', async () => {
    const { calls } = mockBackend([entity({ id: '1', original_value: 'CoAccept AB' })])
    await renderPage()

    const rejectBtn = await screen.findByRole('button', { name: 'Reject detection' })
    fireEvent.click(rejectBtn)

    await waitFor(() => expect(screen.getByText('No PII detected')).toBeInTheDocument())

    expect(executeCalls(calls)).toHaveLength(0)
    expect(pushMock).not.toHaveBeenCalled()
    // The old auto-appearing "Extract with approved only" secondary CTA
    // must never exist — the only extraction trigger left on the page is
    // the single, always-visible primary CTA.
    expect(screen.queryByText(/Extract with approved only/)).not.toBeInTheDocument()
  })

  it('ignoring the last pending row stays on PII Review and never calls /execute', async () => {
    const { calls } = mockBackend([entity({ id: '1', original_value: 'Remembill' })])
    await renderPage()

    const ignoreBtn = await screen.findByRole('button', { name: 'Ignore, do not mask' })
    fireEvent.click(ignoreBtn)

    await waitFor(() => expect(screen.getByText('No PII detected')).toBeInTheDocument())

    expect(executeCalls(calls)).toHaveLength(0)
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('resolving the last pending row never renders a second extraction-triggering control', async () => {
    mockBackend([entity({ id: '1', original_value: 'CoAccept AB' })])
    await renderPage()

    const approveBtn = await screen.findByRole('button', { name: 'Approve' })
    fireEvent.click(approveBtn)
    await waitFor(() => expect(screen.getByText('1 approved · 0 pending')).toBeInTheDocument())

    // Exactly one button can ever start extraction.
    const extractButtons = screen.getAllByRole('button', { name: /extract/i })
    expect(extractButtons).toHaveLength(1)
    expect(extractButtons[0]).toHaveTextContent('Approve all & extract contract terms')
  })
})

describe('PIIReviewPage — the only path to extraction', () => {
  it('clicking "Approve all & extract contract terms" approves pending rows, calls /execute once, then navigates', async () => {
    const { calls } = mockBackend([
      entity({ id: '1', original_value: 'CoAccept AB' }),
      entity({ id: '2', original_value: 'Jane Doe', entity_type: 'PERSON' }),
    ])
    await renderPage()

    await screen.findByText('0 approved · 2 pending')
    fireEvent.click(screen.getByRole('button', { name: /Approve all & extract contract terms/ }))

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith(`/configure/${JOB_ID}`))

    expect(executeCalls(calls)).toHaveLength(1)
    const patchCalls = calls.filter(c => c.url === `/api/jobs/${JOB_ID}/pii` && c.init?.method === 'PATCH')
    expect(patchCalls).toHaveLength(2)
  })

  it('does not navigate if /execute fails, and surfaces an error instead', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (url === `/api/jobs/${JOB_ID}/pii` && method === 'GET') {
        return { ok: true, json: async () => [] } as Response
      }
      if (url === `/api/jobs/${JOB_ID}/execute` && method === 'POST') {
        return { ok: false, json: async () => ({ error: 'boom' }) } as Response
      }
      throw new Error(`unexpected fetch call: ${method} ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    await renderPage()

    await screen.findByText('No PII detected')
    fireEvent.click(screen.getByRole('button', { name: /Approve all & extract contract terms/ }))

    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument())
    expect(pushMock).not.toHaveBeenCalled()
  })
})

describe('PIIReviewPage — icon labels match actual behavior', () => {
  it('gives Reject and Ignore distinct, accurate accessible names and tooltips', async () => {
    mockBackend([entity({ id: '1', original_value: 'CoAccept AB' })])
    await renderPage()

    const rejectBtn = await screen.findByRole('button', { name: 'Reject detection' })
    expect(rejectBtn).toHaveAttribute('title', expect.stringContaining('this contract only'))

    const ignoreBtn = screen.getByRole('button', { name: 'Ignore, do not mask' })
    expect(ignoreBtn).toHaveAttribute('title', expect.stringContaining('whole organisation'))
  })
})

describe('PIIReviewPage — escape routes', () => {
  it('"Back to contracts" is a plain, non-destructive link', async () => {
    mockBackend([])
    await renderPage()

    await screen.findByText('No PII detected')
    const link = screen.getByRole('link', { name: /Back to contracts/ })
    expect(link).toHaveAttribute('href', '/configure')
  })

  it('"Discard upload" does nothing if the confirmation is declined', async () => {
    const { calls } = mockBackend([entity({ id: '1', original_value: 'CoAccept AB' })])
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    await renderPage()

    await screen.findByText('0 approved · 1 pending')
    fireEvent.click(screen.getByRole('button', { name: 'Discard this contract upload' }))

    expect(window.confirm).toHaveBeenCalledWith(
      'Discard this contract upload? This will remove this job and its derived PII-review data.'
    )
    expect(deleteCalls(calls)).toHaveLength(0)
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('"Discard upload" deletes the exact job and navigates back to contracts once confirmed', async () => {
    const { calls } = mockBackend([entity({ id: '1', original_value: 'CoAccept AB' })])
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await renderPage()

    await screen.findByText('0 approved · 1 pending')
    fireEvent.click(screen.getByRole('button', { name: 'Discard this contract upload' }))

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/configure'))
    expect(deleteCalls(calls)).toHaveLength(1)
  })

  it('shows an error and does not navigate if discard fails', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (url === `/api/jobs/${JOB_ID}/pii` && method === 'GET') {
        return { ok: true, json: async () => [] } as Response
      }
      if (url === `/api/jobs/${JOB_ID}` && method === 'DELETE') {
        return { ok: false, json: async () => ({ error: 'Only an admin can discard this upload.' }) } as Response
      }
      throw new Error(`unexpected fetch call: ${method} ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await renderPage()

    await screen.findByText('No PII detected')
    fireEvent.click(screen.getByRole('button', { name: 'Discard this contract upload' }))

    await waitFor(() => expect(screen.getByText('Only an admin can discard this upload.')).toBeInTheDocument())
    expect(pushMock).not.toHaveBeenCalled()
  })
})

describe('PIIReviewPage — alias-group display is preserved (regression)', () => {
  it('still shows alias hints and independent org identifiers correctly', async () => {
    mockBackend([
      entity({ id: '1', original_value: 'CoAccept AB', aliases: ['Remembill'] }),
      entity({ id: '2', original_value: 'NordicFit Test AB' }),
      entity({ id: '3', original_value: '556677-8899', entity_type: 'ORGANIZATION_IDENTIFIER' }),
    ])
    await renderPage()

    await screen.findByText('CoAccept AB')
    expect(screen.getByText(/Alias: Remembill/)).toBeInTheDocument()
    expect(screen.getByText('NordicFit Test AB')).toBeInTheDocument()
    expect(screen.getByText('556677-8899')).toBeInTheDocument()
    expect(screen.getByText('0 approved · 3 pending')).toBeInTheDocument()
  })
})
