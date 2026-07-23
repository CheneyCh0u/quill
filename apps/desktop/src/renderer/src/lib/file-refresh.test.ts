import { describe, expect, it } from 'bun:test'
import {
  decideFileRefresh,
  refreshFileFromDisk,
  type RefreshableFile
} from './file-refresh'

describe('decideFileRefresh', () => {
  it.each([
    ['unchanged editor and disk', 'old', 'old', 'old', 'unchanged'],
    ['disk-only change', 'old', 'old', 'disk', 'reload'],
    ['editor-only change', 'old', 'editor', 'old', 'unchanged'],
    ['different two-sided changes', 'old', 'editor', 'disk', 'conflict'],
    ['matching two-sided changes', 'old', 'same', 'same', 'reload']
  ] as const)('%s', (_label, known, buffer, disk, expected) => {
    expect(decideFileRefresh(known, buffer, disk)).toBe(expected)
  })
})

describe('refreshFileFromDisk', () => {
  function harness(file: RefreshableFile, diskContent: string, confirm = false) {
    let current: RefreshableFile | null = file
    const applied: Array<{ path: string; content: string }> = []
    let confirmationCount = 0
    return {
      applied,
      confirmationCount: () => confirmationCount,
      run: () =>
        refreshFileFromDisk({
          getCurrentFile: () => current,
          read: async () => diskContent,
          confirmConflict: async () => {
            confirmationCount += 1
            return confirm
          },
          apply: (path, content) => applied.push({ path, content })
        }),
      setCurrent: (next: RefreshableFile | null) => {
        current = next
      }
    }
  }

  it('quietly applies a disk-only change', async () => {
    const h = harness({ path: '/r/a.md', content: 'old', buffer: 'old' }, 'disk')
    expect(await h.run()).toBe('reloaded')
    expect(h.applied).toEqual([{ path: '/r/a.md', content: 'disk' }])
    expect(h.confirmationCount()).toBe(0)
  })

  it('preserves an editor-only change', async () => {
    const h = harness({ path: '/r/a.md', content: 'old', buffer: 'editor' }, 'old')
    expect(await h.run()).toBe('unchanged')
    expect(h.applied).toEqual([])
  })

  it('keeps the buffer when a conflict is cancelled', async () => {
    const h = harness({ path: '/r/a.md', content: 'old', buffer: 'editor' }, 'disk')
    expect(await h.run()).toBe('cancelled')
    expect(h.applied).toEqual([])
    expect(h.confirmationCount()).toBe(1)
  })

  it('applies disk content when a conflict is confirmed', async () => {
    const h = harness({ path: '/r/a.md', content: 'old', buffer: 'editor' }, 'disk', true)
    expect(await h.run()).toBe('reloaded')
    expect(h.applied).toEqual([{ path: '/r/a.md', content: 'disk' }])
  })

  it('ignores the result after the active file changes', async () => {
    let release!: (value: string) => void
    let current: RefreshableFile | null = { path: '/r/a.md', content: 'old', buffer: 'old' }
    const applied: unknown[] = []
    const run = refreshFileFromDisk({
      getCurrentFile: () => current,
      read: () =>
        new Promise<string>((resolve) => {
          release = resolve
        }),
      confirmConflict: async () => true,
      apply: (...args) => applied.push(args)
    })
    current = { path: '/r/b.md', content: 'b', buffer: 'b' }
    release('disk')
    expect(await run).toBe('stale')
    expect(applied).toEqual([])
  })

  it('ignores a confirmed conflict after the active file changes', async () => {
    let current: RefreshableFile | null = { path: '/r/a.md', content: 'old', buffer: 'editor' }
    const applied: unknown[] = []
    const result = await refreshFileFromDisk({
      getCurrentFile: () => current,
      read: async () => 'disk',
      confirmConflict: async () => {
        current = { path: '/r/b.md', content: 'b', buffer: 'b' }
        return true
      },
      apply: (...args) => applied.push(args)
    })
    expect(result).toBe('stale')
    expect(applied).toEqual([])
  })
})
