/// <reference types="bun" />
import { describe, it, expect } from 'bun:test'
import { z } from 'zod'
import { consumeStepStream, stripExecute } from './step'
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
