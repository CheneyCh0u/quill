import { describe, expect, it } from 'bun:test'
import { itemsToMessages, type ConvItem } from './itemsToMessages'

describe('itemsToMessages', () => {
  it('returns empty array for empty input', () => {
    expect(itemsToMessages([])).toEqual([])
  })

  it('user item becomes a user message', () => {
    const items: ConvItem[] = [{ kind: 'user', text: 'hi' }]
    expect(itemsToMessages(items)).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('assistant-text item becomes an assistant message', () => {
    const items: ConvItem[] = [{ kind: 'assistant-text', text: 'hello' }]
    expect(itemsToMessages(items)).toEqual([{ role: 'assistant', content: 'hello' }])
  })

  it('alternating user/assistant produces alternating messages', () => {
    const items: ConvItem[] = [
      { kind: 'user', text: 'q1' },
      { kind: 'assistant-text', text: 'a1' },
      { kind: 'user', text: 'q2' },
      { kind: 'assistant-text', text: 'a2' }
    ]
    expect(itemsToMessages(items)).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' }
    ])
  })

  it('adjacent assistant-text items merge into one assistant message', () => {
    // streaming text-delta typically creates one assistant-text item per
    // run, but defensive about defragmented streams from older sessions
    const items: ConvItem[] = [
      { kind: 'user', text: 'q' },
      { kind: 'assistant-text', text: 'partial1 ' },
      { kind: 'assistant-text', text: 'partial2' }
    ]
    expect(itemsToMessages(items)).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'partial1 partial2' }
    ])
  })

  it('skips tool-call / tool-result / approval / plan / route / phase-divider / error / finish / truncated', () => {
    // v1 only carries text turns into model context. UI decoration is kept
    // visible by AgentPanel but not fed back to the LLM.
    const items: ConvItem[] = [
      { kind: 'user', text: 'q' },
      { kind: 'tool-call', toolCallId: 't1', name: 'read_file', args: {} },
      { kind: 'tool-result', toolCallId: 't1', name: 'read_file', result: {} },
      { kind: 'approval', toolCallId: 'a1', toolName: 'apply_edit', payload: {}, status: 'approved' },
      { kind: 'plan', steps: [{ id: 's1', title: 'step' }], status: 'complete' },
      { kind: 'route', decision: { agent: 'plan', reason: 'r' } },
      { kind: 'phase-divider', phase: 'build' },
      { kind: 'error', message: 'oops' },
      { kind: 'finish' },
      { kind: 'truncated', count: 5 },
      { kind: 'assistant-text', text: 'a' }
    ]
    expect(itemsToMessages(items)).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' }
    ])
  })

  it('user item with forcedMode tag does not leak the slash prefix', () => {
    const items: ConvItem[] = [{ kind: 'user', text: 'do thing', forcedMode: 'build' }]
    expect(itemsToMessages(items)).toEqual([{ role: 'user', content: 'do thing' }])
  })

  it('drops empty assistant runs', () => {
    // Adjacent assistant-text items with all-empty text should not produce
    // an empty assistant message.
    const items: ConvItem[] = [
      { kind: 'user', text: 'q' },
      { kind: 'assistant-text', text: '' }
    ]
    expect(itemsToMessages(items)).toEqual([{ role: 'user', content: 'q' }])
  })
})
