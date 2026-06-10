import { describe, expect, test } from 'bun:test'
import { computeSyncPlan } from './plan'

// Three-way comparison: local hashes vs remote hashes vs the hash each
// path had at last sync. Covers the 8-state table from
// docs/web-server.md「同步模型」.

describe('computeSyncPlan', () => {
  test('identical everywhere → no entries (synced is implicit)', () => {
    const plan = computeSyncPlan({ 'a.md': 'h1' }, { 'a.md': 'h1' }, { 'a.md': 'h1' })
    expect(plan).toEqual([])
  })

  test('local changed, remote untouched → local-modified', () => {
    const plan = computeSyncPlan({ 'a.md': 'h2' }, { 'a.md': 'h1' }, { 'a.md': 'h1' })
    expect(plan).toEqual([{ path: 'a.md', status: 'local-modified' }])
  })

  test('remote changed, local untouched → remote-modified', () => {
    const plan = computeSyncPlan({ 'a.md': 'h1' }, { 'a.md': 'h2' }, { 'a.md': 'h1' })
    expect(plan).toEqual([{ path: 'a.md', status: 'remote-modified' }])
  })

  test('both changed differently → conflict', () => {
    const plan = computeSyncPlan({ 'a.md': 'h2' }, { 'a.md': 'h3' }, { 'a.md': 'h1' })
    expect(plan).toEqual([{ path: 'a.md', status: 'conflict' }])
  })

  test('both changed to the same content → synced (hashes agree)', () => {
    const plan = computeSyncPlan({ 'a.md': 'h2' }, { 'a.md': 'h2' }, { 'a.md': 'h1' })
    expect(plan).toEqual([])
  })

  test('new local file, never synced → local-only', () => {
    const plan = computeSyncPlan({ 'new.md': 'h1' }, {}, {})
    expect(plan).toEqual([{ path: 'new.md', status: 'local-only' }])
  })

  test('new remote file, never synced → cloud-only', () => {
    const plan = computeSyncPlan({}, { 'new.md': 'h1' }, {})
    expect(plan).toEqual([{ path: 'new.md', status: 'cloud-only' }])
  })

  test('same path created on both sides with same content → synced', () => {
    const plan = computeSyncPlan({ 'a.md': 'h1' }, { 'a.md': 'h1' }, {})
    expect(plan).toEqual([])
  })

  test('same path created on both sides with different content → conflict', () => {
    const plan = computeSyncPlan({ 'a.md': 'h1' }, { 'a.md': 'h2' }, {})
    expect(plan).toEqual([{ path: 'a.md', status: 'conflict' }])
  })

  test('local deleted, remote untouched → local-deleted', () => {
    const plan = computeSyncPlan({}, { 'a.md': 'h1' }, { 'a.md': 'h1' })
    expect(plan).toEqual([{ path: 'a.md', status: 'local-deleted' }])
  })

  test('local deleted but remote changed since → conflict', () => {
    const plan = computeSyncPlan({}, { 'a.md': 'h2' }, { 'a.md': 'h1' })
    expect(plan).toEqual([{ path: 'a.md', status: 'conflict' }])
  })

  test('remote deleted, local untouched → remote-deleted', () => {
    const plan = computeSyncPlan({ 'a.md': 'h1' }, {}, { 'a.md': 'h1' })
    expect(plan).toEqual([{ path: 'a.md', status: 'remote-deleted' }])
  })

  test('remote deleted but local changed since → conflict', () => {
    const plan = computeSyncPlan({ 'a.md': 'h2' }, {}, { 'a.md': 'h1' })
    expect(plan).toEqual([{ path: 'a.md', status: 'conflict' }])
  })

  test('deleted on both sides → no entry (forget the tombstone)', () => {
    const plan = computeSyncPlan({}, {}, { 'a.md': 'h1' })
    expect(plan).toEqual([])
  })

  test('entries come back sorted by path', () => {
    const plan = computeSyncPlan(
      { 'z.md': 'h2', 'a.md': 'h2' },
      { 'z.md': 'h1', 'a.md': 'h1' },
      { 'z.md': 'h1', 'a.md': 'h1' }
    )
    expect(plan.map((e) => e.path)).toEqual(['a.md', 'z.md'])
  })
})
