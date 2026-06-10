import { describe, expect, test } from 'bun:test'
import { createAgentSessionStore, titleFromPrompt, type SessionStorageLike } from './agent-sessions'

function fakeStorage(seed: Record<string, string> = {}): SessionStorageLike & {
  dump: () => Record<string, string>
} {
  const m = new Map(Object.entries(seed))
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    dump: () => Object.fromEntries(m)
  }
}

describe('titleFromPrompt', () => {
  test('collapses whitespace, truncates to 24 chars, empty for blank', () => {
    expect(titleFromPrompt('  a \n b ')).toBe('a b')
    const long = '这是一段非常非常长的提问内容，会超过二十四个字符的截断阈值'
    expect(titleFromPrompt(long)).toBe(long.slice(0, 24) + '…')
    expect(titleFromPrompt('   ')).toBe('')
  })
})

describe('agent session store (web)', () => {
  test('index bootstraps one active empty session per workspace', () => {
    const store = createAgentSessionStore(fakeStorage(), 'ws1')
    const index = store.index()
    expect(index.sessions).toHaveLength(1)
    expect(index.activeId).toBe(index.sessions[0].id)
  })

  test('saveTurns + loadTurns roundtrip, meta updates', () => {
    const store = createAgentSessionStore(fakeStorage(), 'ws1')
    const { activeId } = store.index()
    store.saveTurns(activeId, [{ runId: 'r1', prompt: 'hi' }], { title: 'hi', turnCount: 1 })
    expect(store.loadTurns(activeId)).toEqual([{ runId: 'r1', prompt: 'hi' }])
    expect(store.index().sessions[0]).toMatchObject({ title: 'hi', turnCount: 1 })
  })

  test('sessions are isolated per workspace and per session', () => {
    const storage = fakeStorage()
    const a = createAgentSessionStore(storage, 'wsA')
    const b = createAgentSessionStore(storage, 'wsB')
    a.saveTurns(a.index().activeId, [{ runId: 'a' }], { title: 'a', turnCount: 1 })
    expect(b.loadTurns(b.index().activeId)).toEqual([])
    expect(b.index().activeId).not.toBe(a.index().activeId)
  })

  test('create / setActive / remove keep the never-empty invariant', () => {
    const store = createAgentSessionStore(fakeStorage(), 'ws1')
    const first = store.index().activeId
    store.saveTurns(first, [{ runId: '1' }], { title: 's1', turnCount: 1 })

    const afterCreate = store.create()
    expect(afterCreate.sessions).toHaveLength(2)
    expect(afterCreate.activeId).not.toBe(first)

    store.setActive(first)
    expect(store.index().activeId).toBe(first)

    const afterRemove = store.remove(first) // delete active → switch to survivor
    expect(afterRemove.sessions).toHaveLength(1)
    expect(afterRemove.activeId).toBe(afterCreate.activeId)
    expect(store.loadTurns(first)).toEqual([])

    const afterLast = store.remove(afterCreate.activeId) // delete last → fresh one
    expect(afterLast.sessions).toHaveLength(1)
    expect(afterLast.activeId).not.toBe(afterCreate.activeId)
  })

  test('legacy global turns key migrates into the first session once', () => {
    const storage = fakeStorage({
      'quill-agent-turns-v2': JSON.stringify([{ runId: 'old', prompt: '老对话' }])
    })
    const store = createAgentSessionStore(storage, 'ws1')
    const index = store.index()
    expect(store.loadTurns(index.activeId)).toEqual([{ runId: 'old', prompt: '老对话' }])
    expect(index.sessions[0].title).toBe('老对话')
    expect(storage.getItem('quill-agent-turns-v2')).toBeNull()
    // Another workspace later does NOT re-import the legacy data.
    const other = createAgentSessionStore(storage, 'ws2')
    expect(other.loadTurns(other.index().activeId)).toEqual([])
  })
})
