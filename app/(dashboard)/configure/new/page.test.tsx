// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import NewConfigurePage from './page'

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
const RAW_INFRA_ERROR = '[AI_INFRA_ERROR] Stream timed out because of no activity for 60000 ms'

function makeFile(name = 'contract.pdf') {
  return new File(['%PDF-1.7 fake contract content'], name, { type: 'application/pdf' })
}

function selectFile(file: File) {
  const input = document.getElementById('contract-file') as HTMLInputElement
  fireEvent.change(input, { target: { files: [file] } })
}

type Call = { url: string; init?: RequestInit }

// A configurable mock covering the exact three endpoints this page calls,
// with independent per-call-count behavior for detect-pii (so a scenario
// can make the FIRST call fail and a SECOND, Retry-triggered call succeed).
function mockFetchSequence(opts: {
  detectPiiResponses: Array<{ ok: boolean; status?: number; body: unknown }>
}) {
  const calls: Call[] = []
  let detectPiiCallCount = 0
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (url === '/api/jobs' && init?.method === 'POST') {
      return { ok: true, json: async () => ({ jobId: JOB_ID }) } as Response
    }
    if (url === '/api/upload') {
      return { ok: true, json: async () => ({}) } as Response
    }
    if (url === `/api/jobs/${JOB_ID}/detect-pii`) {
      const resp = opts.detectPiiResponses[Math.min(detectPiiCallCount, opts.detectPiiResponses.length - 1)]
      detectPiiCallCount += 1
      return { ok: resp.ok, status: resp.status ?? (resp.ok ? 200 : 500), json: async () => resp.body } as Response
    }
    throw new Error(`unexpected fetch call in test: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, calls }
}

function jobPostCalls(calls: Call[]) {
  return calls.filter(c => c.url === '/api/jobs' && c.init?.method === 'POST')
}
function uploadCalls(calls: Call[]) {
  return calls.filter(c => c.url === '/api/upload')
}
function detectPiiCalls(calls: Call[]) {
  return calls.filter(c => c.url === `/api/jobs/${JOB_ID}/detect-pii`)
}

async function uploadAndFailProcessing() {
  const { fetchMock, calls } = mockFetchSequence({
    detectPiiResponses: [{ ok: false, status: 500, body: { error: RAW_INFRA_ERROR } }],
  })
  render(<NewConfigurePage />)
  selectFile(makeFile())
  fireEvent.click(screen.getByRole('button', { name: /Upload and process/ }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Retry processing' })).toBeInTheDocument())
  return { fetchMock, calls }
}

describe('NewConfigurePage — graceful failed-processing state', () => {
  it('shows the graceful "couldn\'t finish processing" panel, never the raw infra error text', async () => {
    await uploadAndFailProcessing()
    expect(screen.getByText("We couldn't finish processing this agreement")).toBeInTheDocument()
    expect(screen.getByText(/Your agreement is saved/)).toBeInTheDocument()
    expect(screen.getByText(/No billing configuration has been activated/)).toBeInTheDocument()
    expect(screen.queryByText(/Stream timed out/)).not.toBeInTheDocument()
    expect(screen.queryByText(/AI_INFRA_ERROR/)).not.toBeInTheDocument()
    expect(screen.queryByText(/60000 ms/)).not.toBeInTheDocument()
  })

  it('shows a "Retry processing" action', async () => {
    await uploadAndFailProcessing()
    expect(screen.getByRole('button', { name: 'Retry processing' })).toBeInTheDocument()
  })

  it('keeps "Back to agreements" available in the failed state', async () => {
    await uploadAndFailProcessing()
    expect(screen.getByRole('link', { name: 'Back to agreements' })).toHaveAttribute('href', '/configure')
  })
})

describe('NewConfigurePage — retry does not duplicate job/upload state', () => {
  it('Retry processing does not create a second job', async () => {
    const { fetchMock, calls } = await uploadAndFailProcessing()
    expect(jobPostCalls(calls).length).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: 'Retry processing' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await waitFor(() => expect(detectPiiCalls(calls).length).toBeGreaterThanOrEqual(2))

    expect(jobPostCalls(calls).length).toBe(1) // still exactly one — no duplicate job
  })

  it('Retry processing does not upload the file a second time', async () => {
    const { calls } = await uploadAndFailProcessing()
    expect(uploadCalls(calls).length).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: 'Retry processing' }))
    await waitFor(() => expect(detectPiiCalls(calls).length).toBeGreaterThanOrEqual(2))

    expect(uploadCalls(calls).length).toBe(1) // still exactly one — no second upload
  })

  it('Retry processing calls /detect-pii using the same job ID as the original attempt', async () => {
    const { calls } = await uploadAndFailProcessing()
    fireEvent.click(screen.getByRole('button', { name: 'Retry processing' }))
    await waitFor(() => expect(detectPiiCalls(calls).length).toBe(2))
    for (const c of detectPiiCalls(calls)) {
      expect(c.url).toBe(`/api/jobs/${JOB_ID}/detect-pii`)
    }
  })
})

describe('NewConfigurePage — successful retry proceeds through the existing pipeline', () => {
  it('a Retry that succeeds navigates to the pii-review page for the same job', async () => {
    const { calls } = mockFetchSequence({
      detectPiiResponses: [
        { ok: false, status: 500, body: { error: RAW_INFRA_ERROR } }, // first attempt fails
        { ok: true, body: { entities: [] } },                         // retry succeeds
      ],
    })
    render(<NewConfigurePage />)
    selectFile(makeFile())
    fireEvent.click(screen.getByRole('button', { name: /Upload and process/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry processing' })).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Retry processing' }))
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith(`/configure/${JOB_ID}/pii-review`))

    expect(detectPiiCalls(calls).length).toBe(2)
    expect(jobPostCalls(calls).length).toBe(1)
    expect(uploadCalls(calls).length).toBe(1)
  })
})

describe('NewConfigurePage — progress wording', () => {
  it('shows "Reading agreement" (not PII-masking wording) as the active stage while detect-pii (PDF extraction) is in flight', async () => {
    let resolveDetectPii!: (v: Response) => void
    const pending = new Promise<Response>(resolve => { resolveDetectPii = resolve })
    const calls: Call[] = []
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url === '/api/jobs' && init?.method === 'POST') return { ok: true, json: async () => ({ jobId: JOB_ID }) } as Response
      if (url === '/api/upload') return { ok: true, json: async () => ({}) } as Response
      if (url === `/api/jobs/${JOB_ID}/detect-pii`) return pending
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<NewConfigurePage />)
    selectFile(makeFile())
    fireEvent.click(screen.getByRole('button', { name: /Upload and process/ }))

    // Wait until the detect-pii call is actually the one in flight.
    await waitFor(() => expect(detectPiiCalls(calls).length).toBe(1))

    const readingItem = await screen.findByText('Reading agreement')
    expect(readingItem).toBeInTheDocument()
    expect(readingItem.className).toMatch(/font-medium/) // rendered as the ACTIVE stage

    // Must never claim PII checking/masking is what's happening right now.
    const checkingItem = screen.getByText('Checking sensitive information')
    expect(checkingItem.className).not.toMatch(/font-medium/)
    expect(screen.queryByText(/masking/i)).not.toBeInTheDocument()

    // Commercial-term extraction never runs on THIS page (it happens later,
    // in a different route, only after PII review) — must not appear as
    // part of this page's own active PROCESSING SEQUENCE at all (the
    // page's static subtitle elsewhere legitimately mentions "commercial
    // terms" as a product description — this only asserts the stage list
    // itself, scoped by its aria-label, never lists a third stage).
    const stageList = screen.getByLabelText('Processing steps')
    expect(stageList.children.length).toBe(2)
    expect(within(stageList).queryByText('Extracting commercial terms')).not.toBeInTheDocument()

    resolveDetectPii({ ok: true, json: async () => ({ entities: [] }) } as Response)
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith(`/configure/${JOB_ID}/pii-review`))
  })
})
