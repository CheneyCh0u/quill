import { describe, it, expect } from 'bun:test'
import { CODEX_API_ENDPOINT, type CodexTokens } from './codex-auth'
import { createCodexFetch } from './codex-fetch'

const TOKENS: CodexTokens = {
  accessToken: 'at-1',
  refreshToken: 'rt-1',
  expiresAt: Date.now() + 3_600_000,
  accountId: 'acc-1'
}

type Recorded = { url: string; init?: RequestInit }

function recordingFetch(respond: (call: Recorded) => Response) {
  const calls: Recorded[] = []
  const fn = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const call = { url: String(input), init }
    calls.push(call)
    return respond(call)
  }
  return { fn, calls }
}

function sse(events: unknown[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}`).join('\n\n') + '\n\ndata: [DONE]\n'
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  })
}

describe('createCodexFetch', () => {
  it('rewrites /v1/responses to the ChatGPT codex endpoint with auth headers', async () => {
    const { fn, calls } = recordingFetch(() => sse([{ type: 'response.completed', response: {} }]))
    const codexFetch = createCodexFetch(async () => TOKENS, fn)
    await codexFetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5.5', stream: true })
    })
    expect(calls[0].url).toBe(CODEX_API_ENDPOINT)
    const headers = new Headers(calls[0].init?.headers)
    expect(headers.get('authorization')).toBe('Bearer at-1')
    expect(headers.get('originator')).toBe('opencode')
    expect(headers.get('chatgpt-account-id')).toBe('acc-1')
  })

  it('strips max_output_tokens and pins store:false + encrypted reasoning include', async () => {
    const { fn, calls } = recordingFetch(() => sse([{ type: 'response.completed', response: {} }]))
    const codexFetch = createCodexFetch(async () => TOKENS, fn)
    await codexFetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5.5', stream: true, max_output_tokens: 4096 })
    })
    const sent = JSON.parse(String(calls[0].init?.body))
    expect(sent.max_output_tokens).toBeUndefined()
    expect(sent.store).toBe(false)
    expect(sent.include).toContain('reasoning.encrypted_content')
  })

  it('strips stored-item reference ids but keeps required reasoning ids', async () => {
    // Codex 端点 store:false 下两条相反的规则（都来自真实 400）：
    // - function_call 等 item 的 id 是库引用 → 查不到 "Item with id 'fc_…'
    //   not found"，必须剥掉（call_id 是请求内配对，保留）
    // - reasoning item 的 id 是必填字段（"Missing required parameter:
    //   'input[N].id'"），加密推理内容靠 id 自描述，必须保留
    const { fn, calls } = recordingFetch(() => sse([{ type: 'response.completed', response: {} }]))
    const codexFetch = createCodexFetch(async () => TOKENS, fn)
    await codexFetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      body: JSON.stringify({
        stream: true,
        input: [
          { type: 'message', role: 'user', content: 'hi' },
          { type: 'reasoning', id: 'rs_r1', encrypted_content: 'blob' },
          { type: 'function_call', id: 'fc_abc', call_id: 'c1', name: 'read_file', arguments: '{}' },
          { type: 'function_call_output', id: 'fco_def', call_id: 'c1', output: '{}' }
        ]
      })
    })
    const sent = JSON.parse(String(calls[0].init?.body)) as {
      input: Array<Record<string, unknown>>
    }
    expect('id' in sent.input[0]).toBe(false)
    expect(sent.input[1].id).toBe('rs_r1')
    expect('id' in sent.input[2]).toBe(false)
    expect('id' in sent.input[3]).toBe(false)
    expect(sent.input[2].call_id).toBe('c1')
    expect(sent.input[3].call_id).toBe('c1')
  })

  it('passes streaming responses through untouched', async () => {
    const streamRes = sse([{ type: 'response.output_text.delta', delta: 'hi' }])
    const { fn } = recordingFetch(() => streamRes)
    const codexFetch = createCodexFetch(async () => TOKENS, fn)
    const res = await codexFetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ stream: true })
    })
    expect(res).toBe(streamRes)
  })

  it('forces stream:true for non-streaming calls and collapses the SSE back to JSON', async () => {
    const { fn, calls } = recordingFetch(() =>
      sse([
        { type: 'response.output_item.done', item: { type: 'message', content: 'hello' } },
        // codex quirk: completed carries an empty output array
        { type: 'response.completed', response: { id: 'r1', output: [] } }
      ])
    )
    const codexFetch = createCodexFetch(async () => TOKENS, fn)
    const res = await codexFetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5.5' })
    })
    expect(JSON.parse(String(calls[0].init?.body)).stream).toBe(true)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    const json = (await res.json()) as {
      id: string
      output: Array<{ type: string; content: string }>
    }
    expect(json.id).toBe('r1')
    expect(json.output).toEqual([{ type: 'message', content: 'hello' }])
  })

  it('returns 502 when a collapsed stream never delivered response.completed', async () => {
    const { fn } = recordingFetch(() => sse([{ type: 'response.output_text.delta', delta: 'x' }]))
    const codexFetch = createCodexFetch(async () => TOKENS, fn)
    const res = await codexFetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      body: JSON.stringify({})
    })
    expect(res.status).toBe(502)
  })

  it('leaves unrelated URLs unrewritten while still authenticating them', async () => {
    const { fn, calls } = recordingFetch(() => new Response('{}', { status: 200 }))
    const codexFetch = createCodexFetch(async () => TOKENS, fn)
    await codexFetch('https://api.openai.com/v1/models')
    expect(calls[0].url).toBe('https://api.openai.com/v1/models')
    const headers = new Headers(calls[0].init?.headers)
    expect(headers.get('authorization')).toBe('Bearer at-1')
  })
})
