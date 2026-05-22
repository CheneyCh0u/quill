import { describe, expect, it } from 'bun:test'
import { exportConversation } from './exportConversation'
import type { ConvItem } from './itemsToMessages'

describe('exportConversation — header', () => {
  it('includes scope label and a date line', () => {
    const md = exportConversation([], {
      scopeLabel: 'workspace · my-vault',
      exportedAt: new Date('2026-05-22T10:00:00Z')
    })
    expect(md).toContain('# Agent conversation — workspace · my-vault')
    expect(md).toMatch(/Exported.*2026-05-22/)
  })

  it('omits scope label when not provided', () => {
    const md = exportConversation([], {
      exportedAt: new Date('2026-05-22T10:00:00Z')
    })
    expect(md).toContain('# Agent conversation')
    expect(md).not.toContain('— ')
  })
})

describe('exportConversation — turns', () => {
  it('user turn becomes a `## You` section', () => {
    const items: ConvItem[] = [{ kind: 'user', text: 'read me' }]
    const md = exportConversation(items)
    expect(md).toContain('## You')
    expect(md).toContain('read me')
  })

  it('user turn with forcedMode notes the slash prefix', () => {
    const items: ConvItem[] = [
      { kind: 'user', text: 'do thing', forcedMode: 'build' }
    ]
    const md = exportConversation(items)
    expect(md).toContain('/build')
    expect(md).toContain('do thing')
  })

  it('assistant-text turn becomes a `## Agent` section with inline text', () => {
    const items: ConvItem[] = [
      { kind: 'user', text: 'q' },
      { kind: 'assistant-text', text: 'here is the answer' }
    ]
    const md = exportConversation(items)
    expect(md).toContain('## Agent')
    expect(md).toContain('here is the answer')
  })

  it('adjacent assistant-text items merge into one Agent section', () => {
    const items: ConvItem[] = [
      { kind: 'user', text: 'q' },
      { kind: 'assistant-text', text: 'part1 ' },
      { kind: 'assistant-text', text: 'part2' }
    ]
    const md = exportConversation(items)
    // Only ONE `## Agent` header for the merged text
    const headerMatches = md.match(/## Agent/g) ?? []
    expect(headerMatches.length).toBe(1)
    expect(md).toContain('part1 part2')
  })
})

describe('exportConversation — tool calls and results', () => {
  it('tool-call renders as a quoted block with JSON args', () => {
    const items: ConvItem[] = [
      { kind: 'tool-call', toolCallId: 't1', name: 'read_file', args: { path: '/x' } }
    ]
    const md = exportConversation(items)
    expect(md).toContain('read_file')
    expect(md).toMatch(/"path":\s*"\/x"/)
  })

  it('tool-result renders with the result JSON', () => {
    const items: ConvItem[] = [
      { kind: 'tool-result', toolCallId: 't1', name: 'read_file', result: { ok: true, content: 'hello' } }
    ]
    const md = exportConversation(items)
    expect(md).toMatch(/"ok":\s*true/)
    expect(md).toContain('hello')
  })
})

describe('exportConversation — approvals', () => {
  it('approved apply_edit shows old → new as a diff block', () => {
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
    const md = exportConversation(items)
    expect(md).toContain('apply_edit')
    expect(md).toContain('/x.md')
    expect(md).toMatch(/applied|✓/i)
    expect(md).toContain('- old')
    expect(md).toContain('+ new')
  })

  it('rejected approval is labeled clearly', () => {
    const items: ConvItem[] = [
      {
        kind: 'approval',
        toolCallId: 'a1',
        toolName: 'write_file',
        payload: { path: '/x', content: 'y' },
        status: 'rejected'
      }
    ]
    const md = exportConversation(items)
    expect(md).toMatch(/rejected|拒绝/i)
    expect(md).toContain('/x')
  })

  it('approved but with resultError marks failure', () => {
    const items: ConvItem[] = [
      {
        kind: 'approval',
        toolCallId: 'a1',
        toolName: 'apply_edit',
        payload: { path: '/x', old_text: 'a', new_text: 'b' },
        status: 'approved',
        resultError: 'EACCES'
      }
    ]
    const md = exportConversation(items)
    expect(md).toMatch(/failed|error/i)
    expect(md).toContain('EACCES')
  })
})

describe('exportConversation — plans and decoration', () => {
  it('plan renders as a numbered list with optional why and files', () => {
    const items: ConvItem[] = [
      {
        kind: 'plan',
        status: 'complete',
        steps: [
          { id: 's1', title: 'Read README', why: 'understand intent' },
          { id: 's2', title: 'Update version', files: ['package.json'] }
        ]
      }
    ]
    const md = exportConversation(items)
    expect(md).toMatch(/### Plan/i)
    expect(md).toContain('1. Read README')
    expect(md).toContain('understand intent')
    expect(md).toContain('2. Update version')
    expect(md).toContain('package.json')
  })

  it('dismissed plan is marked', () => {
    const items: ConvItem[] = [
      {
        kind: 'plan',
        status: 'dismissed',
        steps: [{ id: 's1', title: 'do thing' }]
      }
    ]
    const md = exportConversation(items)
    expect(md).toMatch(/dismissed|取消/i)
  })

  it('route decision becomes an italic note', () => {
    const items: ConvItem[] = [
      { kind: 'route', decision: { agent: 'plan', reason: 'multi-step task' } }
    ]
    const md = exportConversation(items)
    expect(md).toMatch(/\*via /)
    expect(md).toContain('multi-step task')
  })

  it('phase-divider becomes a horizontal rule', () => {
    const items: ConvItem[] = [{ kind: 'phase-divider', phase: 'build' }]
    const md = exportConversation(items)
    expect(md).toContain('---')
  })

  it('error is rendered as a blockquote with warning marker', () => {
    const items: ConvItem[] = [{ kind: 'error', message: 'failed to read' }]
    const md = exportConversation(items)
    expect(md).toMatch(/> .*failed to read/)
  })

  it('truncated marker becomes an italic note', () => {
    const items: ConvItem[] = [{ kind: 'truncated', count: 42 }]
    const md = exportConversation(items)
    expect(md).toContain('42')
    expect(md).toMatch(/truncated|截断/i)
  })

  it('skips finish and plan-usage (UI-only)', () => {
    const items: ConvItem[] = [
      { kind: 'user', text: 'q' },
      { kind: 'plan-usage', usage: { inputTokens: 100 } },
      { kind: 'finish', usage: { inputTokens: 200 } }
    ]
    const md = exportConversation(items)
    expect(md).not.toMatch(/finish|plan-usage/i)
    expect(md).not.toContain('200')
  })
})

describe('exportConversation — full document', () => {
  it('produces a coherent multi-section markdown for a realistic conversation', () => {
    const items: ConvItem[] = [
      { kind: 'user', text: '在 vault 加一个 settings 节' },
      { kind: 'route', decision: { agent: 'plan', reason: '需要先读再改' } },
      {
        kind: 'plan',
        status: 'complete',
        steps: [
          { id: 's1', title: 'Read README.md' },
          { id: 's2', title: 'Append # Settings section' }
        ]
      },
      { kind: 'phase-divider', phase: 'build' },
      { kind: 'assistant-text', text: '先读一下文件。' },
      { kind: 'tool-call', toolCallId: 't1', name: 'read_file', args: { path: '/r/README.md' } },
      { kind: 'tool-result', toolCallId: 't1', name: 'read_file', result: { ok: true, content: '# vault' } },
      {
        kind: 'approval',
        toolCallId: 'a1',
        toolName: 'apply_edit',
        payload: { path: '/r/README.md', old_text: '# vault', new_text: '# vault\n\n## Settings\n' },
        status: 'approved',
        resultPath: '/r/README.md'
      }
    ]
    const md = exportConversation(items, {
      scopeLabel: 'workspace · my-vault'
    })
    expect(md).toContain('# Agent conversation')
    expect(md).toContain('## You')
    expect(md).toContain('settings 节')
    expect(md).toMatch(/\*via /)
    expect(md).toMatch(/### Plan/)
    expect(md).toContain('---')
    expect(md).toContain('## Agent')
    expect(md).toContain('read_file')
    expect(md).toContain('apply_edit')
    expect(md).toContain('# Settings')
  })
})
