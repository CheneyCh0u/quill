/// <reference types="bun" />
import { describe, it, expect } from 'bun:test'
import { createOpenAI } from '@ai-sdk/openai'
import { generateText, tool } from 'ai'
import { z } from 'zod'
import { consumeStepStream, stripExecute, STEP_PROVIDER_OPTIONS } from './step'
import { createCodexFetch } from './codex-fetch'
import type { CodexTokens } from './codex-auth'
import type { AgentEvent } from '@quill/shared-types'

type Chunk = Record<string, unknown> & { type: string }

function makeStream(chunks: Chunk[]): AsyncIterable<Chunk> {
  return (async function* () {
    for (const c of chunks) yield c
  })()
}

function neverEndingStream(yielded: Chunk[], signal: AbortSignal): AsyncIterable<Chunk> {
  return (async function* () {
    for (const c of yielded) yield c
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve()
      signal.addEventListener('abort', () => resolve(), { once: true })
    })
  })()
}

describe('consumeStepStream', () => {
  it('emits deltas and step-finish, captures finish instead of emitting it, collects tool calls', async () => {
    const events: AgentEvent[] = []
    const out = await consumeStepStream(
      makeStream([
        { type: 'text-delta', text: 'hello' },
        { type: 'tool-call', toolCallId: 't1', toolName: 'read_file', input: { path: 'a.md' } },
        { type: 'finish-step', usage: { totalTokens: 10 } },
        { type: 'finish', totalUsage: { totalTokens: 30 }, finishReason: 'tool-calls' }
      ]),
      new AbortController().signal,
      (e) => events.push(e)
    )
    // 图循环里每步的 finish chunk 不是运行终局 — 不发 finish 事件
    expect(events.map((e) => e.type)).toEqual(['text-delta', 'tool-call', 'step-finish'])
    expect(out.finishReason).toBe('tool-calls')
    expect(out.usage).toEqual({ totalTokens: 30 })
    expect(out.toolCalls).toEqual([
      { toolCallId: 't1', name: 'read_file', args: { path: 'a.md' } }
    ])
  })

  it('falls back to the `delta` / `args` legacy shapes', async () => {
    const events: AgentEvent[] = []
    const out = await consumeStepStream(
      makeStream([
        { type: 'text-delta', delta: 'world' },
        { type: 'tool-call', toolCallId: 't2', toolName: 'grep', args: { pattern: 'x' } }
      ]),
      new AbortController().signal,
      (e) => events.push(e)
    )
    expect((events[0] as { delta: string }).delta).toBe('world')
    expect(out.toolCalls[0].args).toEqual({ pattern: 'x' })
  })

  it('emits error event when chunk.type === error', async () => {
    const events: AgentEvent[] = []
    await consumeStepStream(
      makeStream([{ type: 'error', error: new Error('boom') }]),
      new AbortController().signal,
      (e) => events.push(e)
    )
    expect(events[0].type).toBe('error')
    expect((events[0] as { message: string }).message).toContain('boom')
  })

  it('throws AbortError when abort fires mid-stream and stops emitting (#89 wedge guard)', async () => {
    const events: AgentEvent[] = []
    const controller = new AbortController()
    const stream = neverEndingStream([{ type: 'text-delta', text: 'partial' }], controller.signal)
    const done = consumeStepStream(stream, controller.signal, (e) => events.push(e))
    await new Promise((r) => setTimeout(r, 10))
    expect(events).toHaveLength(1)
    controller.abort()
    await expect(done).rejects.toMatchObject({ name: 'AbortError' })
    expect(events).toHaveLength(1)
  })

  it('throws AbortError when abort fires before the first chunk', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      consumeStepStream(
        makeStream([{ type: 'text-delta', text: 'no' }]),
        controller.signal,
        () => {}
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('multi-step serialization against the codex endpoint', () => {
  // 回归锁（两次线上 400 的根因）：transport 层设 store:false 而 SDK 不知
  // 情时，SDK 会把上一步的 reasoning/tool-call 序列化成 item_reference
  // （存储引用）——无存储端点上必炸（"Item … not found" 或 "Missing
  // required parameter: 'input[N].id'"）。修复 = SDK 调用层显式传
  // STEP_PROVIDER_OPTIONS，让它序列化完整 item。此测试走真实 SDK +
  // 真实 codexFetch，断言第二步请求体不含任何 item_reference。
  const TOKENS: CodexTokens = {
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAt: Date.now() + 3_600_000,
    accountId: 'acc'
  }

  it('feeds prior steps back as full items, never item_reference', async () => {
    const step1Sse =
      [
        {
          type: 'response.output_item.done',
          item: { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'ENC' }
        },
        {
          type: 'response.output_item.done',
          item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'read_file',
            arguments: '{"path":"a.md"}',
            status: 'completed'
          }
        },
        {
          type: 'response.completed',
          response: { id: 'r1', model: 'gpt-5.6', created_at: 1752600000, output: [] }
        }
      ]
        .map((e) => `data: ${JSON.stringify(e)}`)
        .join('\n\n') + '\n\ndata: [DONE]\n'
    const doneSse =
      'data: {"type":"response.completed","response":{"id":"r2","model":"gpt-5.6","created_at":1752600000,"output":[]}}\n\ndata: [DONE]\n'

    const bodies: Array<{ input: Array<Record<string, unknown>> }> = []
    let call = 0
    const codexFetch = createCodexFetch(
      async () => TOKENS,
      async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return new Response(call++ === 0 ? step1Sse : doneSse, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' }
        })
      }
    )
    const openai = createOpenAI({ apiKey: 'x', fetch: codexFetch as typeof fetch })
    const model = openai.responses('gpt-5.6')
    const tools = {
      read_file: tool({ description: 'read', inputSchema: z.object({ path: z.string() }) })
    }

    const step1 = await generateText({
      model,
      messages: [{ role: 'user', content: 'read a.md' }],
      tools,
      providerOptions: STEP_PROVIDER_OPTIONS
    })
    await generateText({
      model,
      messages: [
        { role: 'user', content: 'read a.md' },
        ...step1.response.messages,
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call_1',
              toolName: 'read_file',
              output: { type: 'json', value: { ok: true } }
            }
          ]
        }
      ],
      tools,
      providerOptions: STEP_PROVIDER_OPTIONS
    })

    const step2Input = bodies[1].input
    const types = step2Input.map((i) => i.type ?? i.role)
    expect(types).not.toContain('item_reference')
    const reasoning = step2Input.find((i) => i.type === 'reasoning')
    expect(reasoning?.id).toBe('rs_1')
    expect(reasoning?.encrypted_content).toBe('ENC')
    const fc = step2Input.find((i) => i.type === 'function_call')
    expect(fc?.call_id).toBe('call_1')
    expect('id' in (fc ?? {})).toBe(false) // 库引用 id 由 codexFetch 剥除
  })
})

describe('stripExecute', () => {
  it('keeps description and inputSchema but drops execute so the SDK never runs tools itself', () => {
    const tools = {
      demo: {
        description: 'a demo tool',
        inputSchema: z.object({ q: z.string() }),
        execute: async () => ({ ok: true })
      }
    }
    const stripped = stripExecute(tools as never)
    const demo = (stripped as Record<string, Record<string, unknown>>).demo
    expect(demo.description).toBe('a demo tool')
    expect(demo.inputSchema).toBeDefined()
    expect('execute' in demo).toBe(false)
  })
})
