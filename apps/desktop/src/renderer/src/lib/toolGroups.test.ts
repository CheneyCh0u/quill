import { describe, it, expect } from 'bun:test'
import { groupToolItems, summarizeGroup, type GroupableItem } from './toolGroups'

const call = (id: string, name = 'read_file'): GroupableItem => ({
  kind: 'tool-call',
  toolCallId: id,
  name,
  args: { path: `${id}.md` }
})
const result = (id: string, name = 'read_file'): GroupableItem => ({
  kind: 'tool-result',
  toolCallId: id,
  name,
  result: { ok: true }
})
const text = (t: string): GroupableItem => ({ kind: 'assistant-text', text: t }) as GroupableItem

describe('groupToolItems', () => {
  it('merges consecutive resolved tool calls into one group and keeps args paired', () => {
    const out = groupToolItems([
      call('a', 'list_dir'),
      result('a', 'list_dir'),
      call('b'),
      result('b'),
      text('答案')
    ])
    expect(out.map((e) => e.kind)).toEqual(['tool-group', 'passthrough'])
    const group = out[0]
    if (group.kind !== 'tool-group') throw new Error('expected group')
    expect(group.entries.map((e) => e.toolCallId)).toEqual(['a', 'b'])
    expect(group.entries[0].args).toEqual({ path: 'a.md' })
  })

  it('text between tool runs splits them into separate groups', () => {
    const out = groupToolItems([
      call('a'),
      result('a'),
      text('先说两句'),
      call('b'),
      result('b'),
      call('c'),
      result('c')
    ])
    expect(out.map((e) => e.kind)).toEqual(['tool-group', 'passthrough', 'tool-group'])
    const second = out[2]
    if (second.kind !== 'tool-group') throw new Error('expected group')
    expect(second.entries.length).toBe(2)
  })

  it('an unresolved call (still running) stays standalone and does not join the group', () => {
    const out = groupToolItems([call('a'), result('a'), call('running')])
    expect(out.map((e) => e.kind)).toEqual(['tool-group', 'passthrough'])
    const last = out[1]
    if (last.kind !== 'passthrough') throw new Error('expected passthrough')
    expect((last.item as { kind: string }).kind).toBe('tool-call')
  })

  it('passes non-tool items through with their original indexes', () => {
    const items = [text('hi'), call('a'), result('a')]
    const out = groupToolItems(items)
    const first = out[0]
    if (first.kind !== 'passthrough') throw new Error('expected passthrough')
    expect(first.index).toBe(0)
  })
})

describe('summarizeGroup', () => {
  it('joins unique names with repeat counts', () => {
    expect(
      summarizeGroup([
        { toolCallId: 'a', name: 'list_dir', result: 1, args: {} },
        { toolCallId: 'b', name: 'read_file', result: 1, args: {} },
        { toolCallId: 'c', name: 'read_file', result: 1, args: {} },
        { toolCallId: 'd', name: 'read_file', result: 1, args: {} }
      ])
    ).toBe('list_dir · read_file ×3')
  })
})
