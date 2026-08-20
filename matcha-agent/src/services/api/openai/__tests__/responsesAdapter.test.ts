import { describe, expect, test } from 'bun:test'
import {
  buildResponsesRequest,
  createOpenAIResponsesStream,
} from '../responsesAdapter.js'

describe('buildResponsesRequest', () => {
  test('includes reasoning effort for ChatGPT Responses requests', () => {
    const request = buildResponsesRequest({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      toolChoice: undefined,
      reasoningEffort: 'xhigh',
    })

    expect(request.reasoning).toEqual({ effort: 'xhigh' })
  })

  test('does not include unsupported max_output_tokens parameter', () => {
    const request = buildResponsesRequest({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      toolChoice: undefined,
    }) as Record<string, unknown>

    expect('max_output_tokens' in request).toBe(false)
  })

  test('posts OpenAI Responses requests to the configured API base URL', async () => {
    const originalBaseUrl = process.env.OPENAI_BASE_URL
    const originalApiKey = process.env.OPENAI_API_KEY
    process.env.OPENAI_BASE_URL = 'https://api.example/v1'
    process.env.OPENAI_API_KEY = 'responses-secret'
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const fetchOverride = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push({ url: String(input), init })
      return new Response(
        'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":2}}}\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }) as typeof fetch

    try {
      const stream = await createOpenAIResponsesStream({
        request: buildResponsesRequest({
          model: 'gpt-5',
          messages: [{ role: 'user', content: 'hello' }],
          tools: [],
          toolChoice: undefined,
        }),
        signal: new AbortController().signal,
        fetchOverride,
      })
      const events = []
      for await (const event of stream) events.push(event)

      expect(calls[0]?.url).toBe('https://api.example/v1/responses')
      expect(calls[0]?.init?.method).toBe('POST')
      expect(calls[0]?.init?.headers).toMatchObject({
        Authorization: 'Bearer responses-secret',
        Accept: 'text/event-stream',
      })
      expect(events).toEqual([
        {
          type: 'response.completed',
          response: {
            status: 'completed',
            usage: { input_tokens: 1, output_tokens: 2 },
          },
        },
      ])
    } finally {
      if (originalBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
      else process.env.OPENAI_BASE_URL = originalBaseUrl
      if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = originalApiKey
    }
  })
})
