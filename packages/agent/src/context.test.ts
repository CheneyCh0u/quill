import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createContextStore, scopeKey } from './context'
import type { Scope } from './scope'

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quill-ctx-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('scopeKey', () => {
  test('workspace scopes hash by absolute root', () => {
    const a = scopeKey({ kind: 'workspace', root: '/a/vault' })
    const b = scopeKey({ kind: 'workspace', root: '/a/vault' })
    const c = scopeKey({ kind: 'workspace', root: '/a/other' })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  test('workspace and single-file with same string do not collide', () => {
    const ws = scopeKey({ kind: 'workspace', root: '/a/file.md' })
    const sf = scopeKey({ kind: 'single-file', path: '/a/file.md' })
    expect(ws).not.toBe(sf)
  })

  test('untitled has a marker key, never collides with real scopes', () => {
    const u = scopeKey({ kind: 'untitled' })
    expect(u).toBe('untitled')
  })
})

describe('context store', () => {
  test('load returns null when no file exists', async () => {
    const store = createContextStore(dir)
    const result = await store.load({ kind: 'workspace', root: '/r' })
    expect(result).toBeNull()
  })

  test('save then load roundtrips items array', async () => {
    const store = createContextStore(dir)
    const scope: Scope = { kind: 'workspace', root: '/r' }
    const items = [
      { kind: 'user', text: 'hi' },
      { kind: 'assistant-text', text: 'hello' }
    ]
    await store.save(scope, items)
    const result = await store.load(scope)
    expect(result?.items).toEqual(items)
    expect(result?.scope).toEqual(scope)
  })

  test('save writes file at expected path', async () => {
    const store = createContextStore(dir)
    const scope: Scope = { kind: 'workspace', root: '/r' }
    await store.save(scope, [])
    const expected = join(dir, scopeKey(scope) + '.json')
    const stat = await fs.stat(expected)
    expect(stat.isFile()).toBe(true)
  })

  test('save writes a sidecar .meta.json with original scope for debugging', async () => {
    const store = createContextStore(dir)
    const scope: Scope = { kind: 'workspace', root: '/vault/notes' }
    await store.save(scope, [])
    const metaPath = join(dir, scopeKey(scope) + '.meta.json')
    const raw = await fs.readFile(metaPath, 'utf-8')
    const meta = JSON.parse(raw)
    expect(meta.scope).toEqual(scope)
    expect(typeof meta.updatedAt).toBe('number')
  })

  test('clear deletes both main file and meta sidecar', async () => {
    const store = createContextStore(dir)
    const scope: Scope = { kind: 'workspace', root: '/r' }
    await store.save(scope, [{ kind: 'user', text: 'x' }])
    await store.clear(scope)
    const main = join(dir, scopeKey(scope) + '.json')
    const meta = join(dir, scopeKey(scope) + '.meta.json')
    await expect(fs.stat(main)).rejects.toThrow()
    await expect(fs.stat(meta)).rejects.toThrow()
  })

  test('clear is a no-op when no file exists', async () => {
    const store = createContextStore(dir)
    await store.clear({ kind: 'workspace', root: '/never-saved' })
    // No throw expected.
  })

  test('untitled scope: save/load/clear are no-ops', async () => {
    const store = createContextStore(dir)
    const scope: Scope = { kind: 'untitled' }
    await store.save(scope, [{ kind: 'user', text: 'x' }])
    // Nothing should land on disk.
    const entries = await fs.readdir(dir).catch(() => [])
    expect(entries.filter((e) => e.endsWith('.json'))).toEqual([])
    // Load returns null.
    expect(await store.load(scope)).toBeNull()
    // Clear no-throws.
    await store.clear(scope)
  })

  test('different workspace scopes have isolated files', async () => {
    const store = createContextStore(dir)
    await store.save({ kind: 'workspace', root: '/a' }, [{ kind: 'user', text: 'A' }])
    await store.save({ kind: 'workspace', root: '/b' }, [{ kind: 'user', text: 'B' }])
    const ra = await store.load({ kind: 'workspace', root: '/a' })
    const rb = await store.load({ kind: 'workspace', root: '/b' })
    expect(ra?.items[0]).toEqual({ kind: 'user', text: 'A' })
    expect(rb?.items[0]).toEqual({ kind: 'user', text: 'B' })
  })

  test('load returns null on corrupt JSON without throwing', async () => {
    const store = createContextStore(dir)
    const scope: Scope = { kind: 'workspace', root: '/r' }
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, scopeKey(scope) + '.json'), 'not json', 'utf-8')
    const result = await store.load(scope)
    expect(result).toBeNull()
  })

  test('save truncates items[] over the cap and prepends a truncated marker', async () => {
    // Cap is 100 by default; saving 150 items should keep last 100 and add a
    // 'truncated' marker at index 0 with the dropped count (50).
    const store = createContextStore(dir, { maxItems: 100 })
    const scope: Scope = { kind: 'workspace', root: '/r' }
    const many = Array.from({ length: 150 }, (_, i) => ({ kind: 'user', text: `m${i}` }))
    await store.save(scope, many)
    const result = await store.load(scope)
    expect(result?.items.length).toBe(101) // 1 marker + 100 kept
    expect(result?.items[0]).toEqual({ kind: 'truncated', count: 50 })
    expect(result?.items[1]).toEqual({ kind: 'user', text: 'm50' })
    expect(result?.items[100]).toEqual({ kind: 'user', text: 'm149' })
  })

  test('save under the cap does not insert a truncation marker', async () => {
    const store = createContextStore(dir, { maxItems: 100 })
    const scope: Scope = { kind: 'workspace', root: '/r' }
    const some = Array.from({ length: 5 }, (_, i) => ({ kind: 'user', text: `m${i}` }))
    await store.save(scope, some)
    const result = await store.load(scope)
    expect(result?.items.length).toBe(5)
    expect(result?.items[0]).toEqual({ kind: 'user', text: 'm0' })
  })
})

describe('session store', () => {
  const scope: Scope = { kind: 'workspace', root: '/r' }

  test('sessions() bootstraps one empty active session', async () => {
    const store = createContextStore(dir)
    const index = await store.sessions(scope)
    expect(index.sessions).toHaveLength(1)
    expect(index.activeId).toBe(index.sessions[0].id)
    expect(index.sessions[0].turnCount).toBe(0)
  })

  test('saveSession persists items + meta; loadSession roundtrips', async () => {
    const store = createContextStore(dir)
    const { activeId } = await store.sessions(scope)
    await store.saveSession(scope, activeId, [{ kind: 'user', text: 'hi' }], {
      title: '帮我整理笔记',
      turnCount: 1
    })
    const loaded = await store.loadSession(scope, activeId)
    expect(loaded?.items).toEqual([{ kind: 'user', text: 'hi' }])
    const index = await store.sessions(scope)
    expect(index.sessions[0]).toMatchObject({ title: '帮我整理笔记', turnCount: 1 })
  })

  test('createSession adds an empty session, makes it active, sorts recent-first', async () => {
    const store = createContextStore(dir)
    const first = await store.sessions(scope)
    await store.saveSession(scope, first.activeId, [{ k: 1 }], { title: 'a', turnCount: 1 })
    const after = await store.createSession(scope)
    expect(after.sessions).toHaveLength(2)
    expect(after.activeId).not.toBe(first.activeId)
    expect(after.sessions[0].id).toBe(after.activeId) // newest first
    expect(await store.loadSession(scope, after.activeId)).toBeNull()
  })

  test('setActiveSession switches; isolation between sessions holds', async () => {
    const store = createContextStore(dir)
    const first = await store.sessions(scope)
    await store.saveSession(scope, first.activeId, [{ s: 1 }], { title: 's1', turnCount: 1 })
    const after = await store.createSession(scope)
    await store.saveSession(scope, after.activeId, [{ s: 2 }], { title: 's2', turnCount: 1 })

    await store.setActiveSession(scope, first.activeId)
    const index = await store.sessions(scope)
    expect(index.activeId).toBe(first.activeId)
    expect((await store.loadSession(scope, first.activeId))?.items).toEqual([{ s: 1 }])
    expect((await store.loadSession(scope, after.activeId))?.items).toEqual([{ s: 2 }])
  })

  test('deleteSession removes data; deleting active switches to most recent', async () => {
    const store = createContextStore(dir)
    const first = await store.sessions(scope)
    await store.saveSession(scope, first.activeId, [{ s: 1 }], { title: 's1', turnCount: 1 })
    const second = await store.createSession(scope)
    await store.saveSession(scope, second.activeId, [{ s: 2 }], { title: 's2', turnCount: 1 })

    const after = await store.deleteSession(scope, second.activeId)
    expect(after.sessions).toHaveLength(1)
    expect(after.activeId).toBe(first.activeId)
    expect(await store.loadSession(scope, second.activeId)).toBeNull()
  })

  test('deleting the last session bootstraps a fresh empty one', async () => {
    const store = createContextStore(dir)
    const { activeId } = await store.sessions(scope)
    await store.saveSession(scope, activeId, [{ s: 1 }], { title: 's1', turnCount: 1 })
    const after = await store.deleteSession(scope, activeId)
    expect(after.sessions).toHaveLength(1)
    expect(after.activeId).not.toBe(activeId)
    expect(after.sessions[0].turnCount).toBe(0)
  })

  test('legacy single-file conversation migrates into the first session', async () => {
    const store = createContextStore(dir)
    await store.save(scope, [{ kind: 'user', text: 'old talk' }]) // legacy writer
    const index = await store.sessions(scope)
    expect(index.sessions).toHaveLength(1)
    const loaded = await store.loadSession(scope, index.activeId)
    expect(loaded?.items).toEqual([{ kind: 'user', text: 'old talk' }])
    // Legacy flat file is gone — no double-migration on next call.
    const again = await store.sessions(scope)
    expect(again.sessions).toHaveLength(1)
    expect(again.activeId).toBe(index.activeId)
  })

  test('untitled scope gets an ephemeral session and never touches disk', async () => {
    const store = createContextStore(dir)
    const index = await store.sessions({ kind: 'untitled' })
    expect(index.sessions).toHaveLength(1)
    await store.saveSession({ kind: 'untitled' }, index.activeId, [{ x: 1 }], {
      title: 'x',
      turnCount: 1
    })
    expect(await fs.readdir(dir).catch(() => [])).toEqual([])
  })
})
