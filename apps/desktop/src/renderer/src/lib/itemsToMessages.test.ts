import { describe, expect, it } from 'bun:test'
import { itemsToMessages, type ConvItem } from './itemsToMessages'

describe('itemsToMessages — text-only basics', () => {
  it('returns empty array for empty input', () => {
    expect(itemsToMessages([])).toEqual([])
  })

  it('user item becomes a user message', () => {
    const items: ConvItem[] = [{ kind: 'user', text: 'hi' }]
    expect(itemsToMessages(items)).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('assistant-text item becomes an assistant message with string content', () => {
    // When the assistant turn has only text, content stays a plain string —
    // matches the simpler ModelMessage shape and avoids unnecessary parts arrays.
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

  it('drops a fully-empty assistant run', () => {
    const items: ConvItem[] = [
      { kind: 'user', text: 'q' },
      { kind: 'assistant-text', text: '' }
    ]
    expect(itemsToMessages(items)).toEqual([{ role: 'user', content: 'q' }])
  })

  it('strips the forcedMode tag from user prompts', () => {
    const items: ConvItem[] = [{ kind: 'user', text: 'do thing', forcedMode: 'build' }]
    expect(itemsToMessages(items)).toEqual([{ role: 'user', content: 'do thing' }])
  })

  it('skips pure UI decoration (route / phase-divider / error / finish / truncated / plan)', () => {
    // Plan stays in the panel for human review but doesn't replay into the
    // model — the model will already have seen the plan during the original
    // run, and serializing structured plans cross-provider is brittle.
    const items: ConvItem[] = [
      { kind: 'user', text: 'q' },
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
})

describe('itemsToMessages — tool calls', () => {
  it('assistant message bundles text and tool-call parts into a content array', () => {
    const items: ConvItem[] = [
      { kind: 'user', text: 'read it' },
      { kind: 'assistant-text', text: 'sure, let me look' },
      { kind: 'tool-call', toolCallId: 't1', name: 'read_file', args: { path: '/x.md' } }
    ]
    expect(itemsToMessages(items)).toEqual([
      { role: 'user', content: 'read it' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'sure, let me look' },
          { type: 'tool-call', toolCallId: 't1', toolName: 'read_file', input: { path: '/x.md' } }
        ]
      }
    ])
  })

  it('tool-result follows its assistant call as a separate tool message with json output', () => {
    const items: ConvItem[] = [
      { kind: 'tool-call', toolCallId: 't1', name: 'read_file', args: { path: '/x' } },
      {
        kind: 'tool-result',
        toolCallId: 't1',
        name: 'read_file',
        result: { ok: true, content: 'file contents' }
      }
    ]
    const out = itemsToMessages(items)
    expect(out).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 't1', toolName: 'read_file', input: { path: '/x' } }
        ]
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 't1',
            toolName: 'read_file',
            output: { type: 'json', value: { ok: true, content: 'file contents' } }
          }
        ]
      }
    ])
  })

  it('multiple tool-calls in the same assistant turn cluster into one message', () => {
    const items: ConvItem[] = [
      { kind: 'tool-call', toolCallId: 't1', name: 'read_file', args: { path: '/a' } },
      { kind: 'tool-call', toolCallId: 't2', name: 'read_file', args: { path: '/b' } }
    ]
    const out = itemsToMessages(items)
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: 't1', toolName: 'read_file', input: { path: '/a' } },
        { type: 'tool-call', toolCallId: 't2', toolName: 'read_file', input: { path: '/b' } }
      ]
    })
  })

  it('alternating tool-call + tool-result then more text produces three messages', () => {
    const items: ConvItem[] = [
      { kind: 'tool-call', toolCallId: 't1', name: 'read_file', args: { path: '/x' } },
      { kind: 'tool-result', toolCallId: 't1', name: 'read_file', result: { ok: true } },
      { kind: 'assistant-text', text: 'done' }
    ]
    const out = itemsToMessages(items)
    expect(out.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant'])
  })

  it('orphan tool-result (no matching tool-call) is dropped', () => {
    // Defensive: a persisted session might be corrupted; we don't want
    // streamText to reject the whole conversation.
    const items: ConvItem[] = [
      { kind: 'tool-result', toolCallId: 'orphan', name: 'read_file', result: { ok: true } }
    ]
    expect(itemsToMessages(items)).toEqual([])
  })
})

describe('itemsToMessages — approvals (write tools)', () => {
  it('approved write becomes tool-call + tool-result(json)', () => {
    const items: ConvItem[] = [
      {
        kind: 'approval',
        toolCallId: 'a1',
        toolName: 'apply_edit',
        payload: { path: '/x.md', old_text: 'old', new_text: 'new' },
        status: 'approved',
        resultPath: '/x.md'
      }
    ]
    expect(itemsToMessages(items)).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'a1',
            toolName: 'apply_edit',
            input: { path: '/x.md', old_text: 'old', new_text: 'new' }
          }
        ]
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'a1',
            toolName: 'apply_edit',
            output: { type: 'json', value: { ok: true, path: '/x.md' } }
          }
        ]
      }
    ])
  })

  it('rejected write becomes tool-call + tool-result(execution-denied)', () => {
    const items: ConvItem[] = [
      {
        kind: 'approval',
        toolCallId: 'a1',
        toolName: 'write_file',
        payload: { path: '/x', content: 'y' },
        status: 'rejected',
        resultError: 'user rejected'
      }
    ]
    const out = itemsToMessages(items)
    expect(out[1]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'a1',
          toolName: 'write_file',
          output: { type: 'execution-denied', reason: 'user rejected' }
        }
      ]
    })
  })

  it('approval with resultError on an approved card surfaces as error-json output', () => {
    // The user clicked approve but the fs write failed (post-approval error).
    const items: ConvItem[] = [
      {
        kind: 'approval',
        toolCallId: 'a1',
        toolName: 'create_file',
        payload: { path: '/x', content: 'y' },
        status: 'approved',
        resultError: 'EACCES'
      }
    ]
    const out = itemsToMessages(items)
    expect(out[1]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'a1',
          toolName: 'create_file',
          output: { type: 'error-json', value: { error: 'EACCES' } }
        }
      ]
    })
  })

  it('pending approval is dropped (sanitize should have flipped these on load)', () => {
    // Belt-and-suspenders: even if sanitizeItems missed one, we don't want
    // to feed an undecided write into the model context.
    const items: ConvItem[] = [
      {
        kind: 'approval',
        toolCallId: 'a1',
        toolName: 'apply_edit',
        payload: {},
        status: 'pending'
      }
    ]
    expect(itemsToMessages(items)).toEqual([])
  })
})

describe('itemsToMessages — mixed sequences', () => {
  it('text + read tool + approved write in one assistant turn', () => {
    const items: ConvItem[] = [
      { kind: 'user', text: 'rename heading' },
      { kind: 'assistant-text', text: 'reading first' },
      { kind: 'tool-call', toolCallId: 't1', name: 'read_file', args: { path: '/a.md' } },
      { kind: 'tool-result', toolCallId: 't1', name: 'read_file', result: { ok: true, content: '# old' } },
      { kind: 'assistant-text', text: 'now editing' },
      {
        kind: 'approval',
        toolCallId: 'a1',
        toolName: 'apply_edit',
        payload: { path: '/a.md', old_text: 'old', new_text: 'new' },
        status: 'approved',
        resultPath: '/a.md'
      },
      { kind: 'assistant-text', text: 'done' }
    ]
    const out = itemsToMessages(items)
    // Expected role sequence: user → assistant(text+tool-call) → tool →
    // assistant(text+tool-call) → tool → assistant(text)
    expect(out.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant'
    ])
  })
})
