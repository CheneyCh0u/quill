import { describe, expect, it } from 'bun:test'
import { buildSystemPrompt } from './prompt'
import type { Scope } from './scope'

describe('buildSystemPrompt', () => {
  it('workspace mode mentions root path and full tool set', () => {
    const scope: Scope = { kind: 'workspace', root: '/work/notes' }
    const p = buildSystemPrompt(scope)
    expect(p).toContain('workspace mode')
    expect(p).toContain('/work/notes')
    expect(p).toContain('read_file')
    expect(p).toContain('list_dir')
    expect(p).toContain('search_in_scope')
    expect(p).toContain('grep')
    expect(p).toContain('rejected by the runtime')
  })

  it('declares web_fetch and tells the agent to surface failures to the user', () => {
    // Available in all scopes — it doesn't touch the fs.
    for (const scope of [
      { kind: 'workspace', root: '/r' } as Scope,
      { kind: 'single-file', path: '/r/x.md' } as Scope,
      { kind: 'untitled' } as Scope
    ]) {
      const p = buildSystemPrompt(scope)
      expect(p).toContain('web_fetch')
      // The user explicitly wants "fetch fail → tell user" behavior.
      expect(p).toMatch(/ok:\s*false|fail|cannot fetch|tell the user/i)
    }
  })

  it('workspace mode declares write tools and approval requirement', () => {
    const scope: Scope = { kind: 'workspace', root: '/r' }
    const p = buildSystemPrompt(scope)
    expect(p).toContain('write_file')
    expect(p).toContain('apply_edit')
    expect(p).toContain('create_file')
    expect(p).toMatch(/approv/i)
    // Prefer apply_edit for narrow changes (token economy).
    expect(p).toMatch(/prefer apply_edit|apply_edit.*small|small.*apply_edit/i)
  })

  it('workspace mode declares delete tools with a permanence warning', () => {
    const scope: Scope = { kind: 'workspace', root: '/r' }
    const p = buildSystemPrompt(scope)
    expect(p).toContain('delete_file')
    expect(p).toContain('delete_dir')
    expect(p).toMatch(/permanent/i)
  })

  it('single-file mode declares write_file and apply_edit but not create_file', () => {
    const scope: Scope = { kind: 'single-file', path: '/r/x.md' }
    const p = buildSystemPrompt(scope)
    expect(p).toContain('write_file')
    expect(p).toContain('apply_edit')
    // create_file is meaningless when scope is exactly one file.
    expect(p).not.toContain('create_file')
    // Deleting the one open file is not a supported flow.
    expect(p).not.toContain('delete_file')
    expect(p).not.toContain('delete_dir')
  })

  it('single-file mode pins the exact file path', () => {
    const scope: Scope = { kind: 'single-file', path: '/work/notes/x.md' }
    const p = buildSystemPrompt(scope)
    expect(p).toContain('single-file mode')
    expect(p).toContain('/work/notes/x.md')
    expect(p).toContain('only the file above')
  })

  it('untitled mode declares no file system access', () => {
    const scope: Scope = { kind: 'untitled' }
    const p = buildSystemPrompt(scope)
    expect(p).toContain('untitled')
    expect(p).toContain('No file system access')
    expect(p).toContain('text only')
  })

  it('injects current buffer when provided', () => {
    const scope: Scope = { kind: 'single-file', path: '/x.md' }
    const buffer = '# Hello\nworld'
    const p = buildSystemPrompt(scope, buffer)
    expect(p).toContain('Currently open file content')
    expect(p).toContain('# Hello')
  })

  it('truncates buffers over 4000 chars and marks them truncated', () => {
    const scope: Scope = { kind: 'workspace', root: '/r' }
    const huge = 'a'.repeat(5000)
    const p = buildSystemPrompt(scope, huge)
    expect(p).toContain('(truncated)')
    expect(p).toContain('[truncated]')
    // Cap is 4000 chars; a 4500-char run of 'a' would only appear if the
    // truncation didn't take. Precise proxy that doesn't break when the
    // surrounding prompt scaffolding grows.
    expect(p).not.toContain('a'.repeat(4500))
  })

  it('injects selection when provided', () => {
    const scope: Scope = { kind: 'workspace', root: '/r' }
    const p = buildSystemPrompt(scope, undefined, 'this paragraph')
    expect(p).toContain("User's selection")
    expect(p).toContain('this paragraph')
  })

  it('omits buffer and selection sections when neither is given', () => {
    const scope: Scope = { kind: 'workspace', root: '/r' }
    const p = buildSystemPrompt(scope)
    expect(p).not.toContain('Currently open file content')
    expect(p).not.toContain("User's selection")
  })

  it('always reminds the agent to respond in the user language', () => {
    const scope: Scope = { kind: 'workspace', root: '/r' }
    const p = buildSystemPrompt(scope)
    expect(p).toContain('same language')
  })

  it('injects plan steps when provided and tells Build to follow them', () => {
    const scope: Scope = { kind: 'workspace', root: '/r' }
    const plan = {
      steps: [
        { id: 's1', title: 'Read README.md', why: 'understand intent' },
        { id: 's2', title: 'Update version in package.json' }
      ]
    }
    const p = buildSystemPrompt(scope, undefined, undefined, plan)
    expect(p).toMatch(/plan|approved plan|follow/i)
    expect(p).toContain('Read README.md')
    expect(p).toContain('Update version in package.json')
    // Build should be allowed to deviate when needed but explain why — otherwise
    // it'd be brittle to discoveries during execution.
    expect(p).toMatch(/deviat|adjust|explain/i)
  })

  it('omits plan section when plan is undefined', () => {
    const p = buildSystemPrompt({ kind: 'workspace', root: '/r' })
    expect(p).not.toMatch(/approved plan|follow this plan/i)
  })
})
