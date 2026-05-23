/// <reference types="bun" />
import { describe, it, expect } from 'bun:test'
import { consumeBuildStream } from './build-stream'
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
    // After the seeded chunks, hang indefinitely — mirrors a wedged LLM
    // stream where the provider stops emitting but never closes the
    // connection. Resolves only when the test signals abort, so the
    // generator doesn't leak across tests.
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve()
      signal.addEventListener('abort', () => resolve(), { once: true })
    })
  })()
}

describe('consumeBuildStream', () => {
  it('translates known chunk types to AgentEvents', async () => {
    const events: AgentEvent[] = []
    await consumeBuildStream(
      makeStream([
        { type: 'text-delta', text: 'hello' },
        { type: 'tool-call', toolCallId: 't1', toolName: 'read_file', input: { path: 'a.md' } },
        { type: 'tool-result', toolCallId: 't1', toolName: 'read_file', output: { ok: true } },
        { type: 'finish-step', usage: { totalTokens: 10 } },
        { type: 'finish', totalUsage: { totalTokens: 30 }, finishReason: 'stop' }
      ]),
      new AbortController().signal,
      (e) => events.push(e)
    )
    expect(events.map((e) => e.type)).toEqual([
      'text-delta',
      'tool-call',
      'tool-result',
      'step-finish',
      'finish'
    ])
    expect((events[0] as { delta: string }).delta).toBe('hello')
    expect((events[4] as { finishReason: string }).finishReason).toBe('stop')
  })

  it('falls back to the `delta` shape when `text` is absent', async () => {
    const events: AgentEvent[] = []
    await consumeBuildStream(
      makeStream([{ type: 'text-delta', delta: 'world' }]),
      new AbortController().signal,
      (e) => events.push(e)
    )
    expect((events[0] as { delta: string }).delta).toBe('world')
  })

  it('emits error event when chunk.type === error', async () => {
    const events: AgentEvent[] = []
    await consumeBuildStream(
      makeStream([{ type: 'error', error: new Error('boom') }]),
      new AbortController().signal,
      (e) => events.push(e)
    )
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('error')
    expect((events[0] as { message: string }).message).toContain('boom')
  })

  it('ignores unknown chunk types without throwing', async () => {
    const events: AgentEvent[] = []
    await consumeBuildStream(
      makeStream([{ type: 'reasoning' }, { type: 'redacted' }, { type: 'finish' }]),
      new AbortController().signal,
      (e) => events.push(e)
    )
    expect(events.map((e) => e.type)).toEqual(['finish'])
  })

  it('returns promptly when abort fires mid-stream and stops emitting', async () => {
    const events: AgentEvent[] = []
    const controller = new AbortController()
    const stream = neverEndingStream(
      [{ type: 'text-delta', text: 'partial' }],
      controller.signal
    )

    const done = consumeBuildStream(stream, controller.signal, (e) => events.push(e))

    // Let the partial chunk get emitted, then abort. The hang at the end of
    // the stream should now unblock and the loop should bail out without
    // appending more events.
    await new Promise((r) => setTimeout(r, 10))
    expect(events).toHaveLength(1)
    controller.abort()
    await done

    // No further events after abort.
    expect(events).toHaveLength(1)
  })

  it('does not emit any events when abort fires before the first chunk', async () => {
    const events: AgentEvent[] = []
    const controller = new AbortController()
    controller.abort()

    await consumeBuildStream(
      makeStream([{ type: 'text-delta', text: 'should-not-see' }]),
      controller.signal,
      (e) => events.push(e)
    )
    expect(events).toHaveLength(0)
  })
})
