import { describe, expect, it } from 'bun:test'
import { sanitizeItems } from './sanitizeItems'
import type { ConvItem } from './itemsToMessages'

describe('sanitizeItems', () => {
  it('passes clean items through unchanged', () => {
    const items: ConvItem[] = [
      { kind: 'user', text: 'hi' },
      { kind: 'assistant-text', text: 'hello' }
    ]
    expect(sanitizeItems(items)).toEqual(items)
  })

  it('turns pending approvals into rejected with session-ended error', () => {
    const items: ConvItem[] = [
      {
        kind: 'approval',
        toolCallId: 't1',
        toolName: 'apply_edit',
        payload: { path: '/x' },
        status: 'pending'
      }
    ]
    const out = sanitizeItems(items)
    expect(out[0]).toMatchObject({
      kind: 'approval',
      toolCallId: 't1',
      status: 'rejected',
      resultError: 'session ended'
    })
  })

  it('keeps approved / rejected approvals as they were', () => {
    const items: ConvItem[] = [
      {
        kind: 'approval',
        toolCallId: 't1',
        toolName: 'apply_edit',
        payload: {},
        status: 'approved',
        resultPath: '/x'
      },
      {
        kind: 'approval',
        toolCallId: 't2',
        toolName: 'apply_edit',
        payload: {},
        status: 'rejected'
      }
    ]
    expect(sanitizeItems(items)).toEqual(items)
  })

  it('completes a streaming plan', () => {
    const items: ConvItem[] = [
      { kind: 'plan', steps: [{ id: 's1', title: 'do thing' }], status: 'streaming' }
    ]
    const out = sanitizeItems(items) as Array<Extract<ConvItem, { kind: 'plan' }>>
    expect(out[0].status).toBe('complete')
    expect(out[0].steps).toEqual([{ id: 's1', title: 'do thing' }])
  })

  it('dismisses an awaiting plan — session was killed before user decided', () => {
    const items: ConvItem[] = [
      { kind: 'plan', steps: [{ id: 's1', title: 'do thing' }], status: 'awaiting' }
    ]
    const out = sanitizeItems(items) as Array<Extract<ConvItem, { kind: 'plan' }>>
    expect(out[0].status).toBe('dismissed')
  })

  it('is idempotent', () => {
    const items: ConvItem[] = [
      {
        kind: 'approval',
        toolCallId: 't1',
        toolName: 'apply_edit',
        payload: {},
        status: 'pending'
      },
      { kind: 'plan', steps: [], status: 'streaming' }
    ]
    const once = sanitizeItems(items)
    const twice = sanitizeItems(once)
    expect(twice).toEqual(once)
  })
})
