import { describe, expect, test } from 'bun:test'
import { summarizeSync } from './syncSummary'
import type { SyncEntry } from '../types'

const entries: SyncEntry[] = [
  { path: 'a.md', status: 'local-modified' },
  { path: 'b.md', status: 'local-only' },
  { path: 'c.md', status: 'local-deleted' },
  { path: 'd.md', status: 'remote-modified' },
  { path: 'e.md', status: 'cloud-only' },
  { path: 'f.md', status: 'remote-deleted' },
  { path: 'g.md', status: 'conflict' }
]

describe('summarizeSync', () => {
  test('groups entries by direction', () => {
    const s = summarizeSync(entries)
    expect(s.pushable.map((e) => e.path)).toEqual(['a.md', 'b.md', 'c.md'])
    expect(s.pullable.map((e) => e.path)).toEqual(['d.md', 'e.md', 'f.md'])
    expect(s.conflicts.map((e) => e.path)).toEqual(['g.md'])
  })

  test('clean is true only when nothing is pending', () => {
    expect(summarizeSync([]).clean).toBe(true)
    expect(summarizeSync(entries).clean).toBe(false)
  })
})
