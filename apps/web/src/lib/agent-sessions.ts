import type { SessionIndex, SessionMeta } from '@quill/shared-types'

/**
 * Web-side agent session store: localStorage-backed, keyed by cloud
 * workspace. Mirrors the desktop context store's invariants — the index
 * never goes empty, deleting the active session falls back to the most
 * recent survivor, and the pre-session global turns key migrates into
 * the first session that bootstraps.
 */
export type SessionStorageLike = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const LEGACY_TURNS_KEY = 'quill-agent-turns-v2'
const TITLE_MAX = 24

export function titleFromPrompt(prompt: string): string {
  const collapsed = prompt.replace(/\s+/g, ' ').trim()
  return collapsed.length > TITLE_MAX ? collapsed.slice(0, TITLE_MAX) + '…' : collapsed
}

function newId(): string {
  return Math.random().toString(36).slice(2, 11) + Date.now().toString(36)
}

function freshMeta(): SessionMeta {
  return { id: newId(), title: '', updatedAt: Date.now(), turnCount: 0 }
}

export function createAgentSessionStore(storage: SessionStorageLike, workspaceKey: string) {
  const indexKey = `quill:agent:sessions:${workspaceKey}`
  const turnsKey = (id: string): string => `quill:agent:turns:${workspaceKey}:${id}`

  function readIndex(): SessionIndex | null {
    try {
      const parsed = JSON.parse(storage.getItem(indexKey) ?? '') as SessionIndex
      if (parsed?.version !== 1 || !Array.isArray(parsed.sessions) || !parsed.sessions.length) {
        return null
      }
      return parsed
    } catch {
      return null
    }
  }

  function writeIndex(index: SessionIndex): SessionIndex {
    index.sessions.sort((a, b) => {
      if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt
      if (a.id === index.activeId) return -1
      if (b.id === index.activeId) return 1
      return 0
    })
    try {
      storage.setItem(indexKey, JSON.stringify(index))
    } catch {
      /* storage full / private mode — sessions become ephemeral */
    }
    return index
  }

  /** Bootstraps ≥1 session; adopts the legacy global turns key once. */
  function index(): SessionIndex {
    const existing = readIndex()
    if (existing) return existing

    const meta = freshMeta()
    const idx: SessionIndex = { version: 1, activeId: meta.id, sessions: [meta] }
    const legacy = storage.getItem(LEGACY_TURNS_KEY)
    if (legacy) {
      try {
        const turns = JSON.parse(legacy) as Array<{ prompt?: string }>
        if (Array.isArray(turns) && turns.length > 0) {
          storage.setItem(turnsKey(meta.id), legacy)
          meta.title = titleFromPrompt(turns[0]?.prompt ?? '') || '此前的对话'
          meta.turnCount = turns.length
        }
      } catch {
        /* corrupt legacy payload — start clean */
      }
      storage.removeItem(LEGACY_TURNS_KEY)
    }
    return writeIndex(idx)
  }

  function loadTurns(id: string): unknown[] {
    try {
      const parsed = JSON.parse(storage.getItem(turnsKey(id)) ?? '')
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  function saveTurns(
    id: string,
    turns: unknown[],
    meta: { title: string; turnCount: number }
  ): void {
    try {
      if (turns.length === 0) storage.removeItem(turnsKey(id))
      else storage.setItem(turnsKey(id), JSON.stringify(turns))
    } catch {
      /* drop silently, same policy as the old persist() */
    }
    const idx = index()
    const entry = idx.sessions.find((s) => s.id === id)
    if (entry) {
      entry.title = meta.title
      entry.turnCount = meta.turnCount
      entry.updatedAt = Date.now()
      idx.activeId = id
      writeIndex(idx)
    }
  }

  function create(): SessionIndex {
    const idx = index()
    const meta = freshMeta()
    idx.sessions.push(meta)
    idx.activeId = meta.id
    return writeIndex(idx)
  }

  function setActive(id: string): SessionIndex {
    const idx = index()
    if (idx.sessions.some((s) => s.id === id)) idx.activeId = id
    return writeIndex(idx)
  }

  function remove(id: string): SessionIndex {
    const idx = index()
    storage.removeItem(turnsKey(id))
    idx.sessions = idx.sessions.filter((s) => s.id !== id)
    if (idx.sessions.length === 0) {
      const meta = freshMeta()
      idx.sessions = [meta]
      idx.activeId = meta.id
    } else if (idx.activeId === id) {
      idx.activeId = idx.sessions.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a)).id
    }
    return writeIndex(idx)
  }

  return { index, loadTurns, saveTurns, create, setActive, remove }
}

export type AgentSessionStore = ReturnType<typeof createAgentSessionStore>
