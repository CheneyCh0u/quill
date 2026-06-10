import { describe, expect, test, beforeEach } from 'bun:test'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Hono } from 'hono'
import { createVaultRoutes } from './vault'

async function freshVault(): Promise<{ root: string; app: Hono }> {
  const root = await mkdtemp(join(tmpdir(), 'quill-vault-'))
  await mkdir(join(root, 'notes'), { recursive: true })
  await writeFile(join(root, 'notes', 'a.md'), '# A\n', 'utf8')
  await writeFile(join(root, 'notes', 'b.md'), '# B\n', 'utf8')
  const app = new Hono()
  app.route('/api/vault', createVaultRoutes(root))
  return { root, app }
}

async function req(app: Hono, method: string, path: string, init?: RequestInit) {
  return app.fetch(new Request(`http://localhost${path}`, { method, ...init }))
}

describe('vault routes', () => {
  let root: string
  let app: Hono
  beforeEach(async () => {
    const fresh = await freshVault()
    root = fresh.root
    app = fresh.app
  })

  test('GET /index returns recursive entries with hash for files', async () => {
    const r = await req(app, 'GET', '/api/vault/index')
    expect(r.status).toBe(200)
    const data = (await r.json()) as Array<{
      path: string
      isDirectory: boolean
      hash?: string
    }>
    const a = data.find((e) => e.path === 'notes/a.md')
    expect(a?.isDirectory).toBe(false)
    expect(a?.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(data.find((e) => e.path === 'notes')?.isDirectory).toBe(true)
  })

  test('GET /list?dir=notes returns single-level listing', async () => {
    const r = await req(app, 'GET', '/api/vault/list?dir=notes')
    expect(r.status).toBe(200)
    const data = (await r.json()) as Array<{ path: string }>
    expect(data.map((e) => e.path).sort()).toEqual(['notes/a.md', 'notes/b.md'])
  })

  test('GET /file/notes/a.md returns content + ETag', async () => {
    const r = await req(app, 'GET', '/api/vault/file/notes/a.md')
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('# A\n')
    expect(r.headers.get('etag')).toMatch(/^"[a-f0-9]{64}"$/)
  })

  test('GET /file/missing.md returns 404', async () => {
    const r = await req(app, 'GET', '/api/vault/file/missing.md')
    expect(r.status).toBe(404)
  })

  test('PUT /file creates nested dirs and returns new hash', async () => {
    const r = await req(app, 'PUT', '/api/vault/file/deep/nested/c.md', {
      body: '# C\n',
      headers: { 'Content-Type': 'text/plain' }
    })
    expect(r.status).toBe(200)
    const data = (await r.json()) as { hash: string }
    expect(data.hash).toMatch(/^[a-f0-9]{64}$/)
    // Round-trip read
    const read = await req(app, 'GET', '/api/vault/file/deep/nested/c.md')
    expect(await read.text()).toBe('# C\n')
  })

  test('PUT with mismatched If-Match returns 412', async () => {
    const stale = '0'.repeat(64)
    const r = await req(app, 'PUT', '/api/vault/file/notes/a.md', {
      body: '# bumped\n',
      headers: { 'If-Match': `"${stale}"` }
    })
    expect(r.status).toBe(412)
  })

  test('PUT with matching If-Match succeeds', async () => {
    // Get the current hash from a read first
    const read = await req(app, 'GET', '/api/vault/file/notes/a.md')
    const etag = read.headers.get('etag')!
    const r = await req(app, 'PUT', '/api/vault/file/notes/a.md', {
      body: '# new\n',
      headers: { 'If-Match': etag }
    })
    expect(r.status).toBe(200)
  })

  test('DELETE /file removes the file', async () => {
    const r = await req(app, 'DELETE', '/api/vault/file/notes/a.md')
    expect(r.status).toBe(200)
    const check = await req(app, 'GET', '/api/vault/file/notes/a.md')
    expect(check.status).toBe(404)
  })

  test('DELETE /file on a directory returns 400', async () => {
    const r = await req(app, 'DELETE', '/api/vault/file/notes')
    expect(r.status).toBe(400)
  })

  test('POST /mkdir creates nested dirs', async () => {
    const r = await req(app, 'POST', '/api/vault/mkdir', {
      body: JSON.stringify({ path: 'a/b/c' }),
      headers: { 'Content-Type': 'application/json' }
    })
    expect(r.status).toBe(200)
    const list = await req(app, 'GET', '/api/vault/list?dir=a/b')
    const data = (await list.json()) as Array<{ path: string; isDirectory: boolean }>
    expect(data.find((e) => e.path === 'a/b/c')?.isDirectory).toBe(true)
  })

  test('DELETE /dir without recursive refuses non-empty dir', async () => {
    const r = await req(app, 'DELETE', '/api/vault/dir/notes')
    expect(r.status).toBe(409)
  })

  test('DELETE /dir?recursive=1 wipes the subtree', async () => {
    const r = await req(app, 'DELETE', '/api/vault/dir/notes?recursive=1')
    expect(r.status).toBe(200)
    const list = await req(app, 'GET', '/api/vault/list?dir=')
    const data = (await list.json()) as Array<{ path: string }>
    expect(data.find((e) => e.path === 'notes')).toBeUndefined()
  })

  test('DELETE /dir on the vault root never matches the route', async () => {
    // The :path{.+} pattern requires ≥1 character, so DELETE /dir/ 404s
    // before reaching the handler. That's enough to keep the root safe —
    // the handler's explicit root-check is defense-in-depth for the case
    // where someone restructures the route in future.
    const r = await req(app, 'DELETE', '/api/vault/dir/?recursive=1')
    expect(r.status).toBe(404)
  })

  test('POST /move renames a file', async () => {
    const r = await req(app, 'POST', '/api/vault/move', {
      body: JSON.stringify({ from: 'notes/a.md', to: 'notes/renamed.md' }),
      headers: { 'Content-Type': 'application/json' }
    })
    expect(r.status).toBe(200)
    expect((await req(app, 'GET', '/api/vault/file/notes/a.md')).status).toBe(404)
    expect((await req(app, 'GET', '/api/vault/file/notes/renamed.md')).status).toBe(200)
  })

  test('path traversal via url-encoded .. returns 400', async () => {
    // The URL constructor normalizes literal "../" away, so the real attack
    // is url-encoded — %2e%2e%2f = "../". After decodeURIComponent inside
    // the handler the path-guard sees the traversal.
    const probes = [
      ['GET', '/api/vault/file/%2e%2e%2fetc%2fpasswd'],
      ['GET', '/api/vault/list?dir=%2e%2e%2fescape'],
      ['DELETE', '/api/vault/file/%2e%2e%2foops'],
      ['DELETE', '/api/vault/dir/%2e%2e%2foops']
    ] as const
    for (const [method, path] of probes) {
      const r = await req(app, method, path)
      expect(r.status).toBe(400)
    }
  })

  test('GET /index skips .quill sync metadata', async () => {
    await mkdir(join(root, '.quill'), { recursive: true })
    await writeFile(join(root, '.quill', 'sync.json'), '{}', 'utf8')
    const r = await req(app, 'GET', '/api/vault/index')
    const data = (await r.json()) as Array<{ path: string }>
    expect(data.some((e) => e.path.startsWith('.quill'))).toBe(false)
  })

  // Cleanup — bun:test doesn't have afterEach hooks bundled per-test; do
  // it lazily by trusting tmpdir cleanup at process exit. Keeping `root`
  // referenced so the closure stays valid through the suite.
  test('cleanup hook', async () => {
    await rm(root, { recursive: true, force: true })
  })
})
