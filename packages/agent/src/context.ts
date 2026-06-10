import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { SessionIndex, SessionMeta } from '@quill/shared-types'
import type { Scope } from './scope'

/**
 * Per-scope key used as the filename under ~/.quill/contexts/. Workspace and
 * single-file scopes get a sha256 of a kind-prefixed string so a workspace
 * named `/x/foo.md` doesn't collide with the file `/x/foo.md`. Untitled
 * returns the literal `'untitled'` marker but the store no-ops on it anyway.
 */
export function scopeKey(scope: Scope): string {
  if (scope.kind === 'untitled') return 'untitled'
  const seed =
    scope.kind === 'workspace' ? `workspace:${scope.root}` : `file:${scope.path}`
  return createHash('sha256').update(seed).digest('hex')
}

export type PersistedConversation = {
  version: 1
  scope: Scope
  items: unknown[]
  updatedAt: number
}

export type ContextStoreOptions = {
  /** Hard cap on items written to disk. Older items are dropped and a
   *  `{ kind: 'truncated', count: N }` marker is inserted at index 0. */
  maxItems?: number
}

export function createContextStore(rootDir: string, opts: ContextStoreOptions = {}) {
  const maxItems = opts.maxItems ?? 100

  function pathFor(key: string): { main: string; meta: string } {
    return {
      main: join(rootDir, `${key}.json`),
      meta: join(rootDir, `${key}.meta.json`)
    }
  }

  async function load(scope: Scope): Promise<PersistedConversation | null> {
    if (scope.kind === 'untitled') return null
    const { main } = pathFor(scopeKey(scope))
    let raw: string
    try {
      raw = await fs.readFile(main, 'utf-8')
    } catch {
      return null
    }
    try {
      const parsed = JSON.parse(raw) as PersistedConversation
      if (parsed?.version !== 1 || !Array.isArray(parsed.items)) return null
      return parsed
    } catch {
      return null
    }
  }

  async function save(scope: Scope, items: unknown[]): Promise<void> {
    if (scope.kind === 'untitled') return
    await fs.mkdir(rootDir, { recursive: true })
    const trimmed = trimItems(items, maxItems)
    const key = scopeKey(scope)
    const { main, meta } = pathFor(key)
    const payload: PersistedConversation = {
      version: 1,
      scope,
      items: trimmed,
      updatedAt: Date.now()
    }
    await fs.writeFile(main, JSON.stringify(payload, null, 2), 'utf-8')
    await fs.writeFile(
      meta,
      JSON.stringify({ scope, updatedAt: payload.updatedAt }, null, 2),
      'utf-8'
    )
  }

  async function clear(scope: Scope): Promise<void> {
    if (scope.kind === 'untitled') return
    const { main, meta } = pathFor(scopeKey(scope))
    await fs.unlink(main).catch(() => undefined)
    await fs.unlink(meta).catch(() => undefined)
  }

  // ---------------- Sessions ----------------
  // Layout per scope: <rootDir>/<scopeKey>/{index.json, <sessionId>.json}.
  // The flat <scopeKey>.json written by the pre-session store migrates
  // into the first session on first access.

  function dirFor(scope: Scope): string {
    return join(rootDir, scopeKey(scope))
  }
  function indexPath(scope: Scope): string {
    return join(dirFor(scope), 'index.json')
  }
  function sessionPath(scope: Scope, id: string): string {
    return join(dirFor(scope), `${id}.json`)
  }

  function freshSession(): SessionMeta {
    return { id: randomUUID(), title: '', updatedAt: Date.now(), turnCount: 0 }
  }

  // Untitled scopes never persist — hand back a stable ephemeral index so
  // the UI flow is identical, with all writes dropped.
  const UNTITLED_INDEX: SessionIndex = {
    version: 1,
    activeId: 'untitled',
    sessions: [{ id: 'untitled', title: '', updatedAt: 0, turnCount: 0 }]
  }

  async function readIndex(scope: Scope): Promise<SessionIndex | null> {
    try {
      const parsed = JSON.parse(await fs.readFile(indexPath(scope), 'utf-8')) as SessionIndex
      if (parsed?.version !== 1 || !Array.isArray(parsed.sessions)) return null
      return parsed
    } catch {
      return null
    }
  }

  async function writeIndex(scope: Scope, index: SessionIndex): Promise<void> {
    await fs.mkdir(dirFor(scope), { recursive: true })
    // Most-recent first — the dropdown renders this order directly. Ties
    // (same-millisecond create after a save) resolve to the active one.
    index.sessions.sort((a, b) => {
      if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt
      if (a.id === index.activeId) return -1
      if (b.id === index.activeId) return 1
      return 0
    })
    await fs.writeFile(indexPath(scope), JSON.stringify(index, null, 2), 'utf-8')
  }

  /** Index for the scope. Guarantees ≥1 session (the panel always has an
   *  active conversation); migrates the legacy flat file on first touch. */
  async function sessions(scope: Scope): Promise<SessionIndex> {
    if (scope.kind === 'untitled') return UNTITLED_INDEX
    const existing = await readIndex(scope)
    if (existing && existing.sessions.length > 0) return existing

    // Legacy flat conversation → first session. Title is left empty (the
    // item shape is renderer-private); the UI labels it by recency.
    const legacy = await load(scope)
    const meta = freshSession()
    const index: SessionIndex = { version: 1, activeId: meta.id, sessions: [meta] }
    if (legacy) {
      meta.title = '此前的对话'
      meta.updatedAt = legacy.updatedAt
      meta.turnCount = legacy.items.length
      await fs.mkdir(dirFor(scope), { recursive: true })
      await fs.writeFile(
        sessionPath(scope, meta.id),
        JSON.stringify({ ...legacy, updatedAt: legacy.updatedAt }, null, 2),
        'utf-8'
      )
      await clear(scope) // remove the flat file so migration runs once
    }
    await writeIndex(scope, index)
    return index
  }

  async function loadSession(
    scope: Scope,
    id: string
  ): Promise<PersistedConversation | null> {
    if (scope.kind === 'untitled') return null
    try {
      const parsed = JSON.parse(
        await fs.readFile(sessionPath(scope, id), 'utf-8')
      ) as PersistedConversation
      if (parsed?.version !== 1 || !Array.isArray(parsed.items)) return null
      return parsed
    } catch {
      return null
    }
  }

  async function saveSession(
    scope: Scope,
    id: string,
    items: unknown[],
    meta: { title: string; turnCount: number }
  ): Promise<void> {
    if (scope.kind === 'untitled') return
    const index = await sessions(scope)
    const payload: PersistedConversation = {
      version: 1,
      scope,
      items: trimItems(items, maxItems),
      updatedAt: Date.now()
    }
    await fs.mkdir(dirFor(scope), { recursive: true })
    await fs.writeFile(sessionPath(scope, id), JSON.stringify(payload, null, 2), 'utf-8')
    const entry = index.sessions.find((s) => s.id === id)
    if (entry) {
      entry.title = meta.title
      entry.turnCount = meta.turnCount
      entry.updatedAt = payload.updatedAt
    } else {
      index.sessions.push({ id, ...meta, updatedAt: payload.updatedAt })
    }
    index.activeId = id
    await writeIndex(scope, index)
  }

  async function createSession(scope: Scope): Promise<SessionIndex> {
    if (scope.kind === 'untitled') return UNTITLED_INDEX
    const index = await sessions(scope)
    const meta = freshSession()
    index.sessions.push(meta)
    index.activeId = meta.id
    await writeIndex(scope, index)
    return readIndex(scope) as Promise<SessionIndex>
  }

  async function setActiveSession(scope: Scope, id: string): Promise<void> {
    if (scope.kind === 'untitled') return
    const index = await sessions(scope)
    if (!index.sessions.some((s) => s.id === id)) return
    index.activeId = id
    await writeIndex(scope, index)
  }

  /** Deletes data on disk. Invariant: the index never goes empty — the
   *  active falls back to the most recent survivor, or a fresh session. */
  async function deleteSession(scope: Scope, id: string): Promise<SessionIndex> {
    if (scope.kind === 'untitled') return UNTITLED_INDEX
    const index = await sessions(scope)
    await fs.unlink(sessionPath(scope, id)).catch(() => undefined)
    index.sessions = index.sessions.filter((s) => s.id !== id)
    if (index.sessions.length === 0) {
      const meta = freshSession()
      index.sessions = [meta]
      index.activeId = meta.id
    } else if (index.activeId === id) {
      index.activeId = index.sessions.reduce((a, b) =>
        b.updatedAt > a.updatedAt ? b : a
      ).id
    }
    await writeIndex(scope, index)
    return (await readIndex(scope)) as SessionIndex
  }

  return {
    load,
    save,
    clear,
    sessions,
    loadSession,
    saveSession,
    createSession,
    setActiveSession,
    deleteSession
  }
}

export type { SessionIndex, SessionMeta } from '@quill/shared-types'

export type ContextStore = ReturnType<typeof createContextStore>

/**
 * Keep at most `max` items. When trimming, prepend a `{ kind: 'truncated',
 * count: <dropped> }` marker so the UI can show "earlier N messages
 * truncated" without losing the count.
 */
function trimItems(items: unknown[], max: number): unknown[] {
  if (items.length <= max) return items
  const dropped = items.length - max
  return [{ kind: 'truncated', count: dropped }, ...items.slice(dropped)]
}
