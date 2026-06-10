import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  checkStatus,
  enableSync,
  pushAll,
  pullAll,
  resolveConflict,
  disableSync,
  listSpaces,
  type FetchLike,
  type RemoteConfig
} from './engine'
import { readSyncFile } from './bind-store'

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/**
 * In-memory stand-in for apps/server: vault file CRUD with If-Match
 * semantics + the sync-space registry. Mocking the network boundary
 * only — local fs in these tests is the real thing.
 */
function fakeServer(): {
  cfg: RemoteConfig
  files: Map<string, string>
  spaces: Array<{ id: string; name: string; remotePath: string; createdAt: number }>
} {
  const files = new Map<string, string>()
  const spaces: Array<{ id: string; name: string; remotePath: string; createdAt: number }> =
    []
  let nextId = 1

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init)
    const url = new URL(req.url)
    const path = decodeURIComponent(url.pathname)

    if (path === '/api/sync/spaces' && req.method === 'GET') {
      return Response.json(spaces)
    }
    if (path === '/api/sync/spaces' && req.method === 'POST') {
      const body = (await req.json()) as { name: string; remotePath: string }
      if (spaces.some((s) => s.remotePath === body.remotePath)) {
        return Response.json({ error: 'remotePath already registered' }, { status: 409 })
      }
      const space = { id: `space-${nextId++}`, ...body, createdAt: 1 }
      spaces.push(space)
      return Response.json(space)
    }
    const delSpace = path.match(/^\/api\/sync\/spaces\/(.+)$/)
    if (delSpace && req.method === 'DELETE') {
      const i = spaces.findIndex((s) => s.id === delSpace[1])
      if (i === -1) return Response.json({ error: 'not found' }, { status: 404 })
      spaces.splice(i, 1)
      return Response.json({ ok: true })
    }

    if (path === '/api/vault/index' && req.method === 'GET') {
      return Response.json(
        [...files.entries()].map(([p, content]) => ({
          path: p,
          isDirectory: false,
          hash: sha256(content)
        }))
      )
    }
    const file = path.match(/^\/api\/vault\/file\/(.+)$/)
    if (file) {
      const p = file[1]
      const ifMatch = req.headers.get('If-Match')?.replace(/"/g, '')
      if (req.method === 'GET') {
        const content = files.get(p)
        if (content === undefined) {
          return Response.json({ error: 'not found' }, { status: 404 })
        }
        return new Response(content, { headers: { ETag: `"${sha256(content)}"` } })
      }
      if (req.method === 'PUT') {
        if (ifMatch) {
          const cur = files.get(p)
          if (cur === undefined || sha256(cur) !== ifMatch) {
            return Response.json({ error: 'precondition failed' }, { status: 412 })
          }
        }
        const body = await req.text()
        files.set(p, body)
        return Response.json(
          { hash: sha256(body) },
          { headers: { ETag: `"${sha256(body)}"` } }
        )
      }
      if (req.method === 'DELETE') {
        const cur = files.get(p)
        if (cur === undefined) return Response.json({ error: 'not found' }, { status: 404 })
        if (ifMatch && sha256(cur) !== ifMatch) {
          return Response.json({ error: 'precondition failed' }, { status: 412 })
        }
        files.delete(p)
        return Response.json({ ok: true })
      }
    }
    return Response.json({ error: `unhandled ${req.method} ${path}` }, { status: 500 })
  }) as FetchLike

  return {
    cfg: { serverUrl: 'https://fake.test', token: 't', fetchFn },
    files,
    spaces
  }
}

async function freshRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'quill-engine-'))
}

describe('sync engine', () => {
  test('checkStatus is disabled for an unbound folder', async () => {
    const { cfg } = fakeServer()
    const snap = await checkStatus(await freshRoot(), cfg)
    expect(snap).toEqual({ state: 'disabled' })
  })

  test('enableSync registers a space and binds the folder', async () => {
    const root = await freshRoot()
    await writeFile(join(root, 'a.md'), 'A', 'utf8')
    const server = fakeServer()

    const snap = await enableSync(root, server.cfg, {
      name: 'my-notes',
      remotePath: 'my-notes'
    })

    expect(server.spaces).toHaveLength(1)
    expect(snap.state).toBe('ready')
    if (snap.state !== 'ready') throw new Error('unreachable')
    expect(snap.binding.remotePath).toBe('my-notes')
    expect(snap.entries).toEqual([{ path: 'a.md', status: 'local-only' }])

    const bound = await readSyncFile(root)
    expect(bound?.spaceId).toBe('space-1')
  })

  test('enableSync surfaces a duplicate remotePath as an error', async () => {
    const root = await freshRoot()
    const server = fakeServer()
    server.spaces.push({ id: 'x', name: 'x', remotePath: 'taken', createdAt: 1 })

    await expect(
      enableSync(root, server.cfg, { name: 'x', remotePath: 'taken' })
    ).rejects.toThrow(/409|already/)
    expect(await readSyncFile(root)).toBeNull()
  })

  test('pushAll uploads new + modified files under the remotePath prefix', async () => {
    const root = await freshRoot()
    await mkdir(join(root, 'docs'), { recursive: true })
    await writeFile(join(root, 'a.md'), 'A', 'utf8')
    await writeFile(join(root, 'docs', 'b.md'), 'B', 'utf8')
    const server = fakeServer()
    await enableSync(root, server.cfg, { name: 'n', remotePath: 'n' })

    const snap = await pushAll(root, server.cfg)

    expect(server.files.get('n/a.md')).toBe('A')
    expect(server.files.get('n/docs/b.md')).toBe('B')
    expect(snap.state).toBe('ready')
    if (snap.state !== 'ready') throw new Error('unreachable')
    expect(snap.entries).toEqual([])
    expect(snap.lastSyncAt).toBeGreaterThan(0)
  })

  test('pushAll propagates local edits and deletions', async () => {
    const root = await freshRoot()
    await writeFile(join(root, 'a.md'), 'A', 'utf8')
    await writeFile(join(root, 'gone.md'), 'bye', 'utf8')
    const server = fakeServer()
    await enableSync(root, server.cfg, { name: 'n', remotePath: 'n' })
    await pushAll(root, server.cfg)

    await writeFile(join(root, 'a.md'), 'A v2', 'utf8')
    const { rm } = await import('node:fs/promises')
    await rm(join(root, 'gone.md'))

    const snap = await pushAll(root, server.cfg)

    expect(server.files.get('n/a.md')).toBe('A v2')
    expect(server.files.has('n/gone.md')).toBe(false)
    if (snap.state !== 'ready') throw new Error('unreachable')
    expect(snap.entries).toEqual([])
  })

  test('pullAll writes cloud files locally and applies remote deletions', async () => {
    const root = await freshRoot()
    await writeFile(join(root, 'stays.md'), 'local copy', 'utf8')
    const server = fakeServer()
    await enableSync(root, server.cfg, { name: 'n', remotePath: 'n' })
    await pushAll(root, server.cfg)

    // Another machine adds, edits and deletes on the server.
    server.files.set('n/new/cloud.md', 'from cloud')
    server.files.set('n/stays.md', 'edited remotely')
    const before = await pushAll(root, server.cfg) // no-op, refresh
    if (before.state !== 'ready') throw new Error('unreachable')

    const snap = await pullAll(root, server.cfg)

    expect(await readFile(join(root, 'new', 'cloud.md'), 'utf8')).toBe('from cloud')
    expect(await readFile(join(root, 'stays.md'), 'utf8')).toBe('edited remotely')
    if (snap.state !== 'ready') throw new Error('unreachable')
    expect(snap.entries).toEqual([])

    server.files.delete('n/stays.md')
    await pullAll(root, server.cfg)
    await expect(readFile(join(root, 'stays.md'), 'utf8')).rejects.toThrow()
  })

  test('push races a remote edit → 412 → entry surfaces as conflict, others land', async () => {
    const root = await freshRoot()
    await writeFile(join(root, 'a.md'), 'A', 'utf8')
    await writeFile(join(root, 'b.md'), 'B', 'utf8')
    const server = fakeServer()
    await enableSync(root, server.cfg, { name: 'n', remotePath: 'n' })
    await pushAll(root, server.cfg)

    // Both sides edit a.md; only local edits b.md.
    await writeFile(join(root, 'a.md'), 'A local', 'utf8')
    await writeFile(join(root, 'b.md'), 'B local', 'utf8')
    server.files.set('n/a.md', 'A remote')

    const snap = await pushAll(root, server.cfg)

    expect(server.files.get('n/b.md')).toBe('B local')
    expect(server.files.get('n/a.md')).toBe('A remote') // not clobbered
    if (snap.state !== 'ready') throw new Error('unreachable')
    expect(snap.entries).toEqual([{ path: 'a.md', status: 'conflict' }])
  })

  test('resolveConflict keep local: backs up remote copy, overwrites server', async () => {
    const root = await freshRoot()
    await writeFile(join(root, 'a.md'), 'A', 'utf8')
    const server = fakeServer()
    await enableSync(root, server.cfg, { name: 'n', remotePath: 'n' })
    await pushAll(root, server.cfg)
    await writeFile(join(root, 'a.md'), 'A local', 'utf8')
    server.files.set('n/a.md', 'A remote')

    const snap = await resolveConflict(root, server.cfg, 'a.md', 'local')

    expect(server.files.get('n/a.md')).toBe('A local')
    if (snap.state !== 'ready') throw new Error('unreachable')
    const backups = (await readdir(root)).filter((f) => f.includes('.conflict-'))
    expect(backups).toHaveLength(1)
    expect(await readFile(join(root, backups[0]), 'utf8')).toBe('A remote')
    // The backup itself is a fresh local file → pending push, like any new file.
    expect(snap.entries).toEqual([{ path: backups[0], status: 'local-only' }])
  })

  test('resolveConflict keep remote: backs up local copy, overwrites local', async () => {
    const root = await freshRoot()
    await writeFile(join(root, 'a.md'), 'A', 'utf8')
    const server = fakeServer()
    await enableSync(root, server.cfg, { name: 'n', remotePath: 'n' })
    await pushAll(root, server.cfg)
    await writeFile(join(root, 'a.md'), 'A local', 'utf8')
    server.files.set('n/a.md', 'A remote')

    const snap = await resolveConflict(root, server.cfg, 'a.md', 'remote')

    expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('A remote')
    if (snap.state !== 'ready') throw new Error('unreachable')
    // The backup file is new local content → shows as local-only until pushed.
    const backups = (await readdir(root)).filter((f) => f.includes('.conflict-'))
    expect(backups).toHaveLength(1)
    expect(await readFile(join(root, backups[0]), 'utf8')).toBe('A local')
    expect(snap.entries).toEqual([
      { path: backups[0], status: 'local-only' }
    ])
  })

  test('a server without the sync-spaces API reads as "server too old"', async () => {
    // Old deployments 404 on /api/sync/spaces (the SPA fallback even
    // serves HTML on GET). Surface that as an actionable message, not
    // a bare "404: 404 Not Found".
    const root = await freshRoot()
    const oldServer: FetchLike = async (input, init) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      if (new URL(req.url).pathname.startsWith('/api/sync/spaces')) {
        if (req.method === 'GET') {
          return new Response('<!doctype html>', {
            headers: { 'Content-Type': 'text/html; charset=UTF-8' }
          })
        }
        return Response.json({ error: 'not found' }, { status: 404 })
      }
      return Response.json([], { status: 200 })
    }
    const cfg: RemoteConfig = { serverUrl: 'https://old.test', token: 't', fetchFn: oldServer }

    await expect(enableSync(root, cfg, { name: 'n', remotePath: 'n' })).rejects.toThrow(
      /服务器版本过旧/
    )
    await expect(listSpaces(cfg)).rejects.toThrow(/服务器版本过旧/)
  })

  test('checkStatus reports offline when the server is unreachable', async () => {
    const root = await freshRoot()
    const server = fakeServer()
    await enableSync(root, server.cfg, { name: 'n', remotePath: 'n' })

    const deadCfg: RemoteConfig = {
      ...server.cfg,
      fetchFn: (async () => {
        throw new Error('ECONNREFUSED')
      }) as FetchLike
    }
    const snap = await checkStatus(root, deadCfg)
    expect(snap.state).toBe('offline')
  })

  test('disableSync unbinds; removeSpace also drops the registry entry', async () => {
    const root = await freshRoot()
    const server = fakeServer()
    await enableSync(root, server.cfg, { name: 'n', remotePath: 'n' })

    await disableSync(root, server.cfg, { removeSpace: true })

    expect(await checkStatus(root, server.cfg)).toEqual({ state: 'disabled' })
    expect(server.spaces).toHaveLength(0)
    expect(await listSpaces(server.cfg)).toEqual([])
  })
})
