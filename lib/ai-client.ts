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

// The model name passed to messages.create() is used for Anthropic direct calls.
// For Bedrock the modelId comes from AWS_BEDROCK_MODEL_ID env var instead.
const BEDROCK_MODEL_ID = process.env.AWS_BEDROCK_MODEL_ID ?? 'eu.anthropic.claude-sonnet-4-6'

type MessageParam = { role: 'user' | 'assistant'; content: string }
type CreateParams = {
  model: string
  max_tokens: number
  system?: string
  messages: MessageParam[]
}
type MessageResponse = {
  content: Array<{ type: string; text: string }>
}

function bedrockClient() {
  const bedrock = new BedrockRuntimeClient({
    region:      process.env.AWS_REGION ?? 'eu-west-1',
    credentials: {
      accessKeyId:     process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
    requestHandler: { requestTimeout: AI_CLIENT_TIMEOUT_MS },
    maxAttempts: AI_CLIENT_MAX_RETRIES + 1,
  })

  return {
    messages: {
      async create(params: CreateParams): Promise<MessageResponse> {
        const body = JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens:        params.max_tokens,
          system:            params.system,
          messages:          params.messages,
        })
        const res = await bedrock.send(new InvokeModelCommand({ modelId: BEDROCK_MODEL_ID, body }))
        return JSON.parse(Buffer.from(res.body).toString('utf8')) as MessageResponse
      },
    },
  }
}

// Returns either the Anthropic SDK client or a Bedrock-backed shim with the
// same .messages.create() interface, based on the USE_BEDROCK env var.
export function getAIClient(): { messages: { create(p: CreateParams): Promise<MessageResponse> } } {
  if (USE_BEDROCK) return bedrockClient()
  return newAnthropicClient() as unknown as ReturnType<typeof bedrockClient>
}

// Shared factory so every direct-Anthropic client in the app (this one, plus
// the standalone PDF-text-extraction clients in execute/ and detect-pii/
// routes) gets the same bounded timeout/retry behavior.
export function newAnthropicClient(): Anthropic {
  return new Anthropic({ timeout: AI_CLIENT_TIMEOUT_MS, maxRetries: AI_CLIENT_MAX_RETRIES })
}

export const AI_PROVIDER = USE_BEDROCK ? `bedrock:${BEDROCK_MODEL_ID}` : 'anthropic'

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
