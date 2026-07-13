import Anthropic from '@anthropic-ai/sdk'
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'

const USE_BEDROCK = process.env.USE_BEDROCK === 'true'

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
  return new Anthropic() as unknown as ReturnType<typeof bedrockClient>
}

export const AI_PROVIDER = USE_BEDROCK ? `bedrock:${BEDROCK_MODEL_ID}` : 'anthropic'
