import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
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

  return { load, save, clear }
}

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
