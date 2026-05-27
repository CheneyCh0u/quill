import { describe, expect, it } from 'bun:test'
import { captureSnapshot, reducer } from './app'
import type { FileNode } from '../types'

const baseFile = { path: '/r/a.md', content: 'old', buffer: 'old' }

const node = (name: string, path: string, isDir = false): FileNode => ({
  name,
  path,
  isDirectory: isDir,
  isMarkdown: !isDir && name.endsWith('.md'),
  isText: !isDir && name.endsWith('.md')
})

describe('RELOAD_CURRENT_FILE', () => {
  it('replaces content and buffer when the path matches and buffer is clean', () => {
    const next = reducer(
      {
        workspace: null,
        currentFile: baseFile,
        viewMode: 'split',
        sidebarCollapsed: false,
        saving: false
      },
      { type: 'RELOAD_CURRENT_FILE', path: '/r/a.md', content: 'new' }
    )
    expect(next.currentFile?.content).toBe('new')
    expect(next.currentFile?.buffer).toBe('new')
  })

  it('updates content but preserves buffer when user has unsaved edits', () => {
    // The user typed some local changes before the agent wrote. We update
    // content (disk truth changed) but leave buffer intact so their work
    // isn't silently overwritten.
    const next = reducer(
      {
        workspace: null,
        currentFile: { path: '/r/a.md', content: 'old', buffer: 'old + user typing' },
        viewMode: 'split',
        sidebarCollapsed: false,
        saving: false
      },
      { type: 'RELOAD_CURRENT_FILE', path: '/r/a.md', content: 'new from agent' }
    )
    expect(next.currentFile?.content).toBe('new from agent')
    expect(next.currentFile?.buffer).toBe('old + user typing')
  })

  it('is a no-op when path does not match current file', () => {
    const before = {
      workspace: null,
      currentFile: baseFile,
      viewMode: 'split' as const,
      sidebarCollapsed: false,
      saving: false
    }
    const next = reducer(before, {
      type: 'RELOAD_CURRENT_FILE',
      path: '/r/other.md',
      content: 'whatever'
    })
    expect(next).toEqual(before)
  })

  it('is a no-op when no file is open', () => {
    const before = {
      workspace: null,
      currentFile: null,
      viewMode: 'split' as const,
      sidebarCollapsed: false,
      saving: false
    }
    const next = reducer(before, {
      type: 'RELOAD_CURRENT_FILE',
      path: '/r/a.md',
      content: 'whatever'
    })
    expect(next).toEqual(before)
  })
})

describe('REFRESH_TREE', () => {
  it('replaces the workspace tree, preserving root + name', () => {
    const oldTree = [node('a.md', '/r/a.md')]
    const newTree = [node('a.md', '/r/a.md'), node('b.md', '/r/b.md')]
    const next = reducer(
      {
        workspace: { kind: 'local', rootPath: '/r', rootName: 'r', tree: oldTree },
        currentFile: null,
        viewMode: 'split',
        sidebarCollapsed: false,
        saving: false
      },
      { type: 'REFRESH_TREE', tree: newTree }
    )
    expect(next.workspace?.tree).toEqual(newTree)
    expect(next.workspace?.rootPath).toBe('/r')
    expect(next.workspace?.rootName).toBe('r')
  })

  it('is a no-op when no workspace is open', () => {
    const before = {
      workspace: null,
      currentFile: null,
      viewMode: 'split' as const,
      sidebarCollapsed: false,
      saving: false
    }
    const next = reducer(before, {
      type: 'REFRESH_TREE',
      tree: [node('a.md', '/r/a.md')]
    })
    expect(next).toEqual(before)
  })
})

describe('OPEN_WORKSPACE', () => {
  it('clears a stale currentFile from a previous single-file or workspace mode', () => {
    // Symptom: user previews /old/a.md, then connects to a remote vault
    // (or opens another folder). Without clearing, the editor keeps
    // rendering the stale file with content that doesn't belong to the
    // newly-opened workspace.
    const next = reducer(
      {
        workspace: null,
        currentFile: baseFile,
        viewMode: 'split',
        sidebarCollapsed: false,
        saving: false
      },
      {
        type: 'OPEN_WORKSPACE',
        kind: 'remote',
        rootPath: 'http://example.com',
        rootName: 'example.com',
        tree: [node('x.md', 'x.md')]
      }
    )
    expect(next.currentFile).toBeNull()
    expect(next.workspace?.kind).toBe('remote')
  })

  it('clears currentFile when switching from one local workspace to another', () => {
    const next = reducer(
      {
        workspace: { kind: 'local', rootPath: '/A', rootName: 'A', tree: [] },
        currentFile: { path: '/A/notes.md', content: 'A notes', buffer: 'A notes' },
        viewMode: 'split',
        sidebarCollapsed: false,
        saving: false
      },
      {
        type: 'OPEN_WORKSPACE',
        kind: 'local',
        rootPath: '/B',
        rootName: 'B',
        tree: [node('b.md', '/B/b.md')]
      }
    )
    expect(next.currentFile).toBeNull()
    expect(next.workspace?.rootPath).toBe('/B')
  })
})

describe('captureSnapshot', () => {
  it('captures the rootPath of an open local workspace', () => {
    expect(
      captureSnapshot({
        workspace: { kind: 'local', rootPath: '/vault', rootName: 'vault', tree: [] },
        currentFile: null,
        viewMode: 'split',
        sidebarCollapsed: false,
        saving: false
      })
    ).toEqual({ kind: 'workspace', rootPath: '/vault' })
  })

  it('prefers workspace over single file when both are present', () => {
    expect(
      captureSnapshot({
        workspace: { kind: 'local', rootPath: '/vault', rootName: 'vault', tree: [] },
        currentFile: baseFile,
        viewMode: 'split',
        sidebarCollapsed: false,
        saving: false
      })
    ).toEqual({ kind: 'workspace', rootPath: '/vault' })
  })

  it('captures the file path when only a single file is open', () => {
    expect(
      captureSnapshot({
        workspace: null,
        currentFile: { path: '/r/a.md', content: 'x', buffer: 'x' },
        viewMode: 'split',
        sidebarCollapsed: false,
        saving: false
      })
    ).toEqual({ kind: 'single', path: '/r/a.md' })
  })

  it('returns empty when no path-backed file is open', () => {
    expect(
      captureSnapshot({
        workspace: null,
        currentFile: { path: null, content: '', buffer: 'untitled draft' },
        viewMode: 'split',
        sidebarCollapsed: false,
        saving: false
      })
    ).toEqual({ kind: 'empty' })
  })

  it('returns empty when there is no workspace and no file', () => {
    expect(
      captureSnapshot({
        workspace: null,
        currentFile: null,
        viewMode: 'split',
        sidebarCollapsed: false,
        saving: false
      })
    ).toEqual({ kind: 'empty' })
  })

  it('returns empty when currently in remote mode (does not snapshot remote)', () => {
    // Guard: captureSnapshot should never store a remote workspace as the
    // "previous local state" — the cloud-icon caller is responsible for
    // only invoking it before entering remote, but if it slips through we
    // want the safe fallback ('empty') instead of recording the remote URL
    // as a local rootPath.
    expect(
      captureSnapshot({
        workspace: {
          kind: 'remote',
          rootPath: 'https://example.com',
          rootName: 'example.com',
          tree: []
        },
        currentFile: null,
        viewMode: 'split',
        sidebarCollapsed: false,
        saving: false
      })
    ).toEqual({ kind: 'empty' })
  })
})
