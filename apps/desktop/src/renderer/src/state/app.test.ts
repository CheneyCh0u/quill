import { describe, expect, it } from 'bun:test'
import { reducer } from './app'
import type { FileNode } from '../types'

const baseFile = { path: '/r/a.md', content: 'old', buffer: 'old' }

const node = (name: string, path: string, isDir = false): FileNode => ({
  name,
  path,
  isDirectory: isDir,
  isMarkdown: !isDir && name.endsWith('.md')
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
