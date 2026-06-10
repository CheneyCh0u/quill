import { promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'
import type { SyncSnapshot, SyncSpace } from '@quill/shared-types'
import { computeSyncPlan, type HashMap } from './plan'
import { buildLocalIndex } from './local-index'
import { readSyncFile, writeSyncFile, removeSyncFile, type SyncFile } from './bind-store'

/**
 * Folder-workspace ↔ server sync engine. Electron-free on purpose:
 * callers inject server URL + token (from remote-store) and optionally
 * a fetch implementation, which is what the tests stub. All flows are
 * "compute plan → act per entry → persist new lastSync → re-check".
 */
/** Call-signature subset of fetch — what tests stub. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type RemoteConfig = {
  serverUrl: string
  token: string
  fetchFn?: FetchLike
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(`${status}: ${message}`)
    this.name = 'HttpError'
  }
}

function oldServerError(): Error {
  return new Error('服务器版本过旧（缺少 /api/sync/spaces），请更新服务端部署后重试')
}

function api(cfg: RemoteConfig) {
  const doFetch = cfg.fetchFn ?? fetch
  const base = cfg.serverUrl.replace(/\/+$/, '')
  const headers = (extra?: Record<string, string>): Record<string, string> => ({
    Authorization: `Bearer ${cfg.token}`,
    ...extra
  })
  const encodePath = (p: string): string => p.split('/').map(encodeURIComponent).join('/')

  return {
    async vaultIndex(): Promise<Array<{ path: string; isDirectory: boolean; hash?: string }>> {
      const r = await doFetch(`${base}/api/vault/index`, { headers: headers() })
      if (!r.ok) throw new HttpError(r.status, await r.text())
      return (await r.json()) as Array<{ path: string; isDirectory: boolean; hash?: string }>
    },
    async readFile(path: string): Promise<{ content: string; hash: string }> {
      const r = await doFetch(`${base}/api/vault/file/${encodePath(path)}`, {
        headers: headers()
      })
      if (!r.ok) throw new HttpError(r.status, await r.text())
      const content = await r.text()
      const hash = r.headers.get('ETag')?.replace(/"/g, '') ?? ''
      return { content, hash }
    },
    /** Returns the new remote hash, or null on a 412 (concurrent edit). */
    async writeFile(path: string, content: string, ifMatch?: string): Promise<string | null> {
      const r = await doFetch(`${base}/api/vault/file/${encodePath(path)}`, {
        method: 'PUT',
        headers: headers(ifMatch ? { 'If-Match': `"${ifMatch}"` } : undefined),
        body: content
      })
      if (r.status === 412) return null
      if (!r.ok) throw new HttpError(r.status, await r.text())
      return ((await r.json()) as { hash: string }).hash
    },
    /** true = deleted (404 counts: already gone), false = 412 conflict. */
    async deleteFile(path: string, ifMatch?: string): Promise<boolean> {
      const r = await doFetch(`${base}/api/vault/file/${encodePath(path)}`, {
        method: 'DELETE',
        headers: headers(ifMatch ? { 'If-Match': `"${ifMatch}"` } : undefined)
      })
      if (r.status === 412) return false
      if (r.status === 404) return true
      if (!r.ok) throw new HttpError(r.status, await r.text())
      return true
    },
    async listSpaces(): Promise<SyncSpace[]> {
      const r = await doFetch(`${base}/api/sync/spaces`, { headers: headers() })
      // Old deployments lack this route; their SPA fallback answers GET
      // with index.html (200, text/html) and POST with a bare 404.
      if (r.headers.get('Content-Type')?.includes('text/html')) throw oldServerError()
      if (r.status === 404) throw oldServerError()
      if (!r.ok) throw new HttpError(r.status, await r.text())
      return (await r.json()) as SyncSpace[]
    },
    async createSpace(name: string, remotePath: string): Promise<SyncSpace> {
      const r = await doFetch(`${base}/api/sync/spaces`, {
        method: 'POST',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ name, remotePath })
      })
      if (r.status === 404) throw oldServerError()
      if (!r.ok) throw new HttpError(r.status, await r.text())
      return (await r.json()) as SyncSpace
    },
    async deleteSpace(id: string): Promise<void> {
      const r = await doFetch(`${base}/api/sync/spaces/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: headers()
      })
      if (!r.ok && r.status !== 404) throw new HttpError(r.status, await r.text())
    }
  }
}

/** Remote index scoped to the space's directory, prefix stripped. */
async function remoteIndexFor(
  cfg: RemoteConfig,
  remotePath: string
): Promise<HashMap> {
  const prefix = `${remotePath}/`
  const entries = await api(cfg).vaultIndex()
  const map: HashMap = {}
  for (const e of entries) {
    if (e.isDirectory || !e.hash) continue
    if (!e.path.startsWith(prefix)) continue
    map[e.path.slice(prefix.length)] = e.hash
  }
  return map
}

async function snapshotFor(
  root: string,
  cfg: RemoteConfig,
  bound: SyncFile
): Promise<SyncSnapshot> {
  const binding = {
    spaceId: bound.spaceId,
    serverUrl: bound.serverUrl,
    remotePath: bound.remotePath
  }
  let remote: HashMap
  try {
    remote = await remoteIndexFor(cfg, bound.remotePath)
  } catch (err) {
    return {
      state: 'offline',
      binding,
      error: err instanceof Error ? err.message : String(err)
    }
  }
  const local = await buildLocalIndex(root)
  const entries = computeSyncPlan(local, remote, bound.lastSync)
  return {
    state: 'ready',
    binding,
    entries,
    fileCount: Object.keys(local).length,
    lastSyncAt: bound.lastSyncAt
  }
}

export async function checkStatus(root: string, cfg: RemoteConfig): Promise<SyncSnapshot> {
  const bound = await readSyncFile(root)
  if (!bound) return { state: 'disabled' }
  return snapshotFor(root, cfg, bound)
}

export async function listSpaces(cfg: RemoteConfig): Promise<SyncSpace[]> {
  return api(cfg).listSpaces()
}

/** Drop a registry entry without touching any files — the Settings
 *  window manages the list without having a workspace root in hand. */
export async function removeSpace(cfg: RemoteConfig, id: string): Promise<void> {
  await api(cfg).deleteSpace(id)
}

/** Register a new space on the server and bind this folder to it.
 *  Does NOT push — callers chain pushAll for the「开启并首次推送」flow. */
export async function enableSync(
  root: string,
  cfg: RemoteConfig,
  args: { name: string; remotePath: string }
): Promise<SyncSnapshot> {
  const space = await api(cfg).createSpace(args.name, args.remotePath)
  return bindSpace(root, cfg, space)
}

/** Bind this folder to an existing space (the "换电脑" flow). */
export async function bindSpace(
  root: string,
  cfg: RemoteConfig,
  space: SyncSpace
): Promise<SyncSnapshot> {
  const bound: SyncFile = {
    spaceId: space.id,
    serverUrl: cfg.serverUrl.replace(/\/+$/, ''),
    remotePath: space.remotePath,
    lastSyncAt: null,
    lastSync: {}
  }
  await writeSyncFile(root, bound)
  return snapshotFor(root, cfg, bound)
}

/** Unbind the folder. Files (local and remote) are never touched;
 *  optionally drop the server registry entry too. */
export async function disableSync(
  root: string,
  cfg: RemoteConfig,
  opts: { removeSpace: boolean }
): Promise<void> {
  const bound = await readSyncFile(root)
  await removeSyncFile(root)
  if (opts.removeSpace && bound) await api(cfg).deleteSpace(bound.spaceId)
}

/** Push every pushable entry. 412s are skipped (they surface as
 *  conflicts in the returned snapshot); other errors abort. */
export async function pushAll(root: string, cfg: RemoteConfig): Promise<SyncSnapshot> {
  return applyEntries(root, cfg, 'push')
}

/** Pull every pullable entry. */
export async function pullAll(root: string, cfg: RemoteConfig): Promise<SyncSnapshot> {
  return applyEntries(root, cfg, 'pull')
}

async function applyEntries(
  root: string,
  cfg: RemoteConfig,
  direction: 'push' | 'pull'
): Promise<SyncSnapshot> {
  const bound = await readSyncFile(root)
  if (!bound) return { state: 'disabled' }

  let remote: HashMap
  try {
    remote = await remoteIndexFor(cfg, bound.remotePath)
  } catch (err) {
    return {
      state: 'offline',
      binding: {
        spaceId: bound.spaceId,
        serverUrl: bound.serverUrl,
        remotePath: bound.remotePath
      },
      error: err instanceof Error ? err.message : String(err)
    }
  }
  const local = await buildLocalIndex(root)
  const plan = computeSyncPlan(local, remote, bound.lastSync)
  const a = api(cfg)
  let applied = false

  for (const entry of plan) {
    const remoteFull = `${bound.remotePath}/${entry.path}`
    if (direction === 'push') {
      if (entry.status === 'local-only' || entry.status === 'local-modified') {
        const content = await fs.readFile(join(root, entry.path), 'utf8')
        const ifMatch =
          entry.status === 'local-modified' ? bound.lastSync[entry.path] : undefined
        const newHash = await a.writeFile(remoteFull, content, ifMatch)
        if (newHash === null) continue // 412 → shows up as conflict on re-check
        bound.lastSync[entry.path] = newHash
        applied = true
      } else if (entry.status === 'local-deleted') {
        const ok = await a.deleteFile(remoteFull, bound.lastSync[entry.path])
        if (!ok) continue
        delete bound.lastSync[entry.path]
        applied = true
      }
    } else {
      if (entry.status === 'cloud-only' || entry.status === 'remote-modified') {
        const { content, hash } = await a.readFile(remoteFull)
        const abs = join(root, entry.path)
        await fs.mkdir(dirname(abs), { recursive: true })
        await fs.writeFile(abs, content, 'utf8')
        bound.lastSync[entry.path] = hash
        applied = true
      } else if (entry.status === 'remote-deleted') {
        await fs.rm(join(root, entry.path), { force: true })
        delete bound.lastSync[entry.path]
        applied = true
      }
    }
  }

  if (applied) bound.lastSyncAt = Date.now()
  await writeSyncFile(root, bound)
  return snapshotFor(root, cfg, bound)
}

/** "docs/a.md" → "docs/a.conflict-2026-06-10T14-32-05.md" */
function conflictBackupPath(path: string, ts: Date): string {
  const stamp = ts.toISOString().replace(/\.\d+Z$/, '').replace(/:/g, '-')
  const dot = path.lastIndexOf('.')
  const slash = path.lastIndexOf('/')
  if (dot > slash + 1) {
    return `${path.slice(0, dot)}.conflict-${stamp}${path.slice(dot)}`
  }
  return `${path}.conflict-${stamp}`
}

/**
 * Settle one conflicted path. The losing side is backed up locally as a
 * `.conflict-<timestamp>` sibling before being overwritten — content is
 * only ever deleted explicitly by the user.
 */
export async function resolveConflict(
  root: string,
  cfg: RemoteConfig,
  path: string,
  keep: 'local' | 'remote'
): Promise<SyncSnapshot> {
  const bound = await readSyncFile(root)
  if (!bound) return { state: 'disabled' }
  const a = api(cfg)
  const remoteFull = `${bound.remotePath}/${path}`
  const abs = join(root, path)

  const localContent = await fs.readFile(abs, 'utf8').catch(() => null)
  const remoteFile = await a
    .readFile(remoteFull)
    .catch((err) => (err instanceof HttpError && err.status === 404 ? null : Promise.reject(err)))

  const backupAbs = join(root, conflictBackupPath(path, new Date()))
  if (keep === 'local') {
    if (remoteFile && remoteFile.content !== localContent) {
      await fs.writeFile(backupAbs, remoteFile.content, 'utf8')
    }
    if (localContent !== null) {
      const newHash = await a.writeFile(remoteFull, localContent) // forced, no If-Match
      if (newHash) bound.lastSync[path] = newHash
    } else {
      await a.deleteFile(remoteFull) // forced delete: user chose "keep local (gone)"
      delete bound.lastSync[path]
    }
  } else {
    if (localContent !== null && (!remoteFile || remoteFile.content !== localContent)) {
      await fs.writeFile(backupAbs, localContent, 'utf8')
    }
    if (remoteFile) {
      await fs.mkdir(dirname(abs), { recursive: true })
      await fs.writeFile(abs, remoteFile.content, 'utf8')
      bound.lastSync[path] = remoteFile.hash
    } else {
      await fs.rm(abs, { force: true })
      delete bound.lastSync[path]
    }
  }
  bound.lastSyncAt = Date.now()
  await writeSyncFile(root, bound)
  return snapshotFor(root, cfg, bound)
}
