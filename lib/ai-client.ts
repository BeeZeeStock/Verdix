import Anthropic from '@anthropic-ai/sdk'
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'

const USE_BEDROCK = process.env.USE_BEDROCK === 'true'

// Bound every call to a predictable worst case — the SDK's own default
// request timeout (~10 min) can exceed a route's Vercel maxDuration (300s
// for execute, 120s for detect-pii), so a genuinely stuck request would get
// killed by the platform instead of failing cleanly into our own error
// handling, leaving the job stuck in a "processing" state with no
// error_message ever written. 60s per attempt, 2 retries (the SDK's
// default) keeps the worst case for one call well under either budget.
const AI_CLIENT_TIMEOUT_MS = 60_000
const AI_CLIENT_MAX_RETRIES = 2

// Reasoning-tier calls (Opus + adaptive thinking on a full extraction/
// interpretation prompt) genuinely take longer than 60s — confirmed live:
// a full-contract extraction with high-effort thinking exceeded 60s of
// stream inactivity and was killed 3 times (the standard retry count),
// burning ~180s before failing outright. A longer per-attempt timeout AND
// fewer retries — a request-timeout failure here means "needed more time,"
// not "transient," so retrying at the same timeout would just repeat the
// same failure. Callers' route-level maxDuration must accommodate this
// (see propose-rule/interpret-rule/execute/audit route.ts exports).
const AI_REASONING_CLIENT_TIMEOUT_MS = 280_000
const AI_REASONING_CLIENT_MAX_RETRIES = 0

// The model name passed to messages.create() is used for Anthropic direct calls.
// For Bedrock the modelId comes from AWS_BEDROCK_MODEL_ID env var instead.
const BEDROCK_MODEL_ID = process.env.AWS_BEDROCK_MODEL_ID ?? 'eu.anthropic.claude-sonnet-4-6'

// EU cross-region inference profile for lightweight/fast-tier calls (e.g.
// meter-key matching) that don't need the full extraction model. Verified
// live against this AWS account before wiring in (2026-08-19): listed via
// ListInferenceProfiles as ACTIVE, and a real InvokeModel call against it
// returned a correctly-formatted response in ~1.3s.
const BEDROCK_FAST_MODEL_ID = process.env.AWS_BEDROCK_FAST_MODEL_ID ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0'

// EU cross-region inference profile for critical commercial-reasoning calls
// — full contract extraction, multi-sentence clause interpretation,
// rebate/credit rule generation, source-vs-reviewer-policy classification.
// Verified live against this AWS account (2026-08-20): a real InvokeModel
// call with thinking/output_config below returned a correctly-formatted
// response (model: "claude-opus-4-6") in ~2s for a trivial prompt.
const BEDROCK_REASONING_MODEL_ID = process.env.AWS_BEDROCK_REASONING_MODEL_ID ?? 'eu.anthropic.claude-opus-4-6-v1'

// Configurable, not hardcoded, so high vs xhigh vs max can be benchmarked
// later without a code change — see the reasoning-tier A/B test.
export type ReasoningEffort = 'high' | 'xhigh' | 'max'
const REASONING_EFFORT = (process.env.AI_REASONING_EFFORT as ReasoningEffort | undefined) ?? 'high'

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'document'; source: { type: 'base64'; media_type: string; data: string } }
type MessageParam = { role: 'user' | 'assistant'; content: string | ContentBlock[] }
type CreateParams = {
  model: string
  max_tokens: number
  system?: string
  messages: MessageParam[]
}
// thinking/thinking_tokens are only ever present on a reasoning-tier
// response (see bedrockClient's thinkingEffort param) — every other caller
// never sees a "thinking" block, since it's filtered out below before the
// response reaches them; content[0] is always the text/JSON output either way.
type MessageResponse = {
  content: Array<{ type: string; text: string }>
  usage?: { input_tokens: number; output_tokens: number; thinking_tokens?: number }
}

// thinkingEffort is only ever set by getReasoningAIClient() below — every
// other caller (getAIClient/getFastAIClient) gets today's exact unmodified
// request shape. When set, adds Bedrock's adaptive-thinking fields to the
// request body and strips the resulting "thinking" content block(s) before
// returning, so every existing caller's response.content[0] is still always
// the text/JSON output — no caller needs to know whether thinking was used.
// Deliberately does NOT set temperature/top_p — Bedrock's thinking mode
// doesn't accept them alongside thinking, and CreateParams never carried
// them in the first place, so there's nothing to strip on that front either.
function bedrockClient(modelId: string, thinkingEffort?: ReasoningEffort) {
  const timeoutMs = thinkingEffort ? AI_REASONING_CLIENT_TIMEOUT_MS : AI_CLIENT_TIMEOUT_MS
  const maxRetries = thinkingEffort ? AI_REASONING_CLIENT_MAX_RETRIES : AI_CLIENT_MAX_RETRIES
  const bedrock = new BedrockRuntimeClient({
    region:      process.env.AWS_REGION ?? 'eu-west-1',
    credentials: {
      accessKeyId:     process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
    requestHandler: { requestTimeout: timeoutMs },
    maxAttempts: maxRetries + 1,
  })

  return {
    messages: {
      async create(params: CreateParams): Promise<MessageResponse> {
        const body = JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens:        params.max_tokens,
          system:            params.system,
          messages:          params.messages,
          ...(thinkingEffort ? { thinking: { type: 'adaptive' }, output_config: { effort: thinkingEffort } } : {}),
        })
        const res = await bedrock.send(new InvokeModelCommand({ modelId, body }))
        const parsed = JSON.parse(Buffer.from(res.body).toString('utf8')) as MessageResponse & {
          usage?: { input_tokens: number; output_tokens: number; output_tokens_details?: { thinking_tokens?: number } }
        }
        if (!thinkingEffort) return parsed
        return {
          ...parsed,
          content: parsed.content.filter(b => b.type !== 'thinking'),
          usage: parsed.usage && {
            input_tokens: parsed.usage.input_tokens,
            output_tokens: parsed.usage.output_tokens,
            thinking_tokens: parsed.usage.output_tokens_details?.thinking_tokens,
          },
        }
      },
    },
  }
}

// Returns either the Anthropic SDK client or a Bedrock-backed shim with the
// same .messages.create() interface, based on the USE_BEDROCK env var.
// Medium-complexity work — see getReasoningAIClient() for critical
// commercial-reasoning calls and getFastAIClient() for lightweight matching.
export function getAIClient(): { messages: { create(p: CreateParams): Promise<MessageResponse> } } {
  if (USE_BEDROCK) return bedrockClient(BEDROCK_MODEL_ID)
  return newAnthropicClient() as unknown as ReturnType<typeof bedrockClient>
}

// Same routing as getAIClient(), but for lightweight/fast-tier calls (e.g.
// meter-key matching) — uses the EU Haiku profile instead of the full
// extraction model when Bedrock is active. Falls back to a direct Anthropic
// Haiku client otherwise, matching the same non-Bedrock dev-mode behavior
// getAIClient() already has. Never appropriate for anything that determines
// an amount, eligibility condition, contractual scope, billing period, or
// reviewer-policy requirement — those go through getReasoningAIClient().
export function getFastAIClient(): { messages: { create(p: CreateParams): Promise<MessageResponse> } } {
  if (USE_BEDROCK) return bedrockClient(BEDROCK_FAST_MODEL_ID)
  return newAnthropicClient() as unknown as ReturnType<typeof bedrockClient>
}

// Critical-reasoning tier — Opus 4.6 with adaptive thinking, EU Bedrock only.
// For calls whose output changes contractual billing logic: full commercial-
// term extraction, multi-sentence clause interpretation, rebate/credit/
// service-credit rule generation, source-vs-reviewer-policy classification,
// tier/minimum/proration semantics, amendment/precedence interpretation,
// final commercial-rule validation. NOT yet wired into any call site — see
// the routing audit/proposal before any existing getAIClient() call is
// switched to this one.
// No non-Bedrock (direct Anthropic) reasoning-tier model is configured —
// falls back to the same default client getAIClient() uses when Bedrock is
// off (e.g. local dev without AWS credentials), same degrade-gracefully
// pattern as getFastAIClient().
export function getReasoningAIClient(): { messages: { create(p: CreateParams): Promise<MessageResponse> } } {
  if (USE_BEDROCK) return bedrockClient(BEDROCK_REASONING_MODEL_ID, REASONING_EFFORT)
  return newAnthropicClient(true) as unknown as ReturnType<typeof bedrockClient>
}

// Shared factory so every direct-Anthropic client in the app gets the same
// bounded timeout/retry behavior. reasoning=true applies the same longer
// timeout/fewer-retries budget getReasoningAIClient()'s Bedrock path uses —
// only the non-Bedrock (e.g. local dev without AWS credentials) fallback
// for getReasoningAIClient() ever passes it.
export function newAnthropicClient(reasoning = false): Anthropic {
  return new Anthropic({
    timeout: reasoning ? AI_REASONING_CLIENT_TIMEOUT_MS : AI_CLIENT_TIMEOUT_MS,
    maxRetries: reasoning ? AI_REASONING_CLIENT_MAX_RETRIES : AI_CLIENT_MAX_RETRIES,
  })
}

export const AI_PROVIDER = USE_BEDROCK ? `bedrock:${BEDROCK_MODEL_ID}` : 'anthropic'

// Shared PDF-to-text step used by every pipeline (execute, detect-pii, audit,
// partner-recon) — previously each route hand-rolled its own `new Anthropic()`
// call for this, which bypassed getAIClient()'s Bedrock/EU routing entirely
// (and ran on the RAW, unmasked document, since masking can't happen until
// there's text to mask). Routing through getAIClient() means the same
// USE_BEDROCK switch that pins the commercial-terms extraction call to an
// EU AWS region now also covers this earlier, raw-document step.
export async function extractDocumentText(buffer: Buffer, isPdf: boolean, instruction: string): Promise<string> {
  if (!isPdf) return buffer.toString('utf-8')
  const client = getAIClient()
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } },
        { type: 'text', text: instruction },
      ],
    }],
  })
  const c = response.content[0]
  return c?.type === 'text' ? c.text : ''
}

// Anthropic's SDK throws Anthropic.APIError (and its subclasses — RateLimitError,
// BadRequestError [covers "credit balance is too low"], AuthenticationError,
// InternalServerError, APIConnectionError, APIConnectionTimeoutError, ...) for
// every failure that originates from the API/network layer rather than from
// our own code. Bedrock throttling/connection errors don't share that class
// hierarchy, so they're matched by message/name as a fallback. Used to decide
// whether a job failure is an infrastructure problem (admin-only detail, e.g.
// "run out of Anthropic credit") versus a genuine extraction/business-logic
// issue that's fine to show the customer directly.
export function isAIInfraError(err: unknown): boolean {
  if (err instanceof Anthropic.APIError) return true
  const text = `${err instanceof Error ? err.name : ''} ${err instanceof Error ? err.message : String(err)}`.toLowerCase()
  return /rate.?limit|credit balance|overloaded|insufficient.*quota|throttl|timeout|econnrefused|econnreset|etimedout|5\d\d\b/.test(text)
}

// Prefixes a stored error_message so downstream readers (app/api/jobs/[id]/route.ts's
// GET handler) can tell an infra-level failure apart from a normal one without
// a schema migration, and show the real detail only to admins.
export const AI_INFRA_ERROR_PREFIX = '[AI_INFRA_ERROR] '
