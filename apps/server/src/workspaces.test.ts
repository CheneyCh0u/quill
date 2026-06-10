import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Hono } from 'hono'
import {
  createWorkspaceRoutes,
  ensureWorkspaceState,
  resolveWorkspaceRoot
} from './workspaces'

async function freshEnv(): Promise<{ stateDir: string; vaultRoot: string; storeFile: string; legacyFile: string }> {
  const base = await mkdtemp(join(tmpdir(), 'quill-ws-'))
  const stateDir = join(base, 'state')
  const vaultRoot = join(base, 'vault')
  await mkdir(stateDir, { recursive: true })
  await mkdir(vaultRoot, { recursive: true })
  return {
    stateDir,
    vaultRoot,
    storeFile: join(stateDir, 'workspaces.json'),
    legacyFile: join(stateDir, 'sync-spaces.json')
  }
}

async function req(app: Hono, method: string, path: string, body?: unknown) {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      ...(body !== undefined
        ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
        : {})
    })
  )
}

describe('ensureWorkspaceState', () => {
  test('creates the default quill workspace + directory on first boot', async () => {
    const env = await freshEnv()
    await ensureWorkspaceState(env)

    const stored = JSON.parse(await readFile(env.storeFile, 'utf8')) as Array<{
      name: string
      remotePath: string
      default?: boolean
    }>
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ name: 'quill', remotePath: 'quill', default: true })
    expect((await stat(join(env.vaultRoot, 'quill'))).isDirectory()).toBe(true)
  })

  test('migrates legacy sync-spaces.json preserving ids', async () => {
    const env = await freshEnv()
    const legacy = [
      { id: 'keep-this-id', name: 'langgraph-learning', remotePath: 'langgraph-learning', createdAt: 1 }
    ]
    await writeFile(env.legacyFile, JSON.stringify(legacy), 'utf8')
    await mkdir(join(env.vaultRoot, 'langgraph-learning'), { recursive: true })

    await ensureWorkspaceState(env)

    const stored = JSON.parse(await readFile(env.storeFile, 'utf8')) as Array<{
      id: string
      remotePath: string
      default?: boolean
    }>
    const migrated = stored.find((w) => w.remotePath === 'langgraph-learning')
    expect(migrated?.id).toBe('keep-this-id')
    expect(stored.some((w) => w.default)).toBe(true)
  })

  test('sweeps loose vault-root entries into quill/, skipping workspace dirs', async () => {
    const env = await freshEnv()
    await writeFile(env.legacyFile, JSON.stringify([
      { id: 'x', name: 'lg', remotePath: 'langgraph-learning', createdAt: 1 }
    ]), 'utf8')
    await mkdir(join(env.vaultRoot, 'langgraph-learning'), { recursive: true })
    await writeFile(join(env.vaultRoot, 'langgraph-learning', 'note.md'), 'n', 'utf8')
    await writeFile(join(env.vaultRoot, 'h.md'), 'hello', 'utf8')
    await writeFile(join(env.vaultRoot, '1.json'), '{}', 'utf8')
    await mkdir(join(env.vaultRoot, 'loose-dir'), { recursive: true })
    await writeFile(join(env.vaultRoot, 'loose-dir', 'a.md'), 'a', 'utf8')

    await ensureWorkspaceState(env)

    // Loose entries moved under quill/, workspace dir untouched.
    expect(await readFile(join(env.vaultRoot, 'quill', 'h.md'), 'utf8')).toBe('hello')
    expect(await readFile(join(env.vaultRoot, 'quill', '1.json'), 'utf8')).toBe('{}')
    expect(await readFile(join(env.vaultRoot, 'quill', 'loose-dir', 'a.md'), 'utf8')).toBe('a')
    expect(await readFile(join(env.vaultRoot, 'langgraph-learning', 'note.md'), 'utf8')).toBe('n')
    const rootEntries = (await readdir(env.vaultRoot)).sort()
    expect(rootEntries).toEqual(['langgraph-learning', 'quill'])
  })

  test('is idempotent — second run changes nothing', async () => {
    const env = await freshEnv()
    await writeFile(join(env.vaultRoot, 'h.md'), 'hello', 'utf8')
    await ensureWorkspaceState(env)
    const after1 = await readFile(env.storeFile, 'utf8')
    await ensureWorkspaceState(env)
    expect(await readFile(env.storeFile, 'utf8')).toBe(after1)
    expect(await readFile(join(env.vaultRoot, 'quill', 'h.md'), 'utf8')).toBe('hello')
  })
})

describe('workspace routes', () => {
  async function freshApp() {
    const env = await freshEnv()
    await ensureWorkspaceState(env)
    const app = new Hono()
    app.route('/api/workspaces', createWorkspaceRoutes(env.storeFile, env.vaultRoot))
    return { app, env }
  }

  test('GET lists the default workspace with fileCount', async () => {
    const { app, env } = await freshApp()
    await writeFile(join(env.vaultRoot, 'quill', 'a.md'), 'a', 'utf8')
    const r = await req(app, 'GET', '/api/workspaces')
    expect(r.status).toBe(200)
    const list = (await r.json()) as Array<{ name: string; default?: boolean; fileCount?: number }>
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: 'quill', default: true, fileCount: 1 })
  })

  test('POST creates workspace + directory; duplicates 409; traversal 400', async () => {
    const { app, env } = await freshApp()
    const r = await req(app, 'POST', '/api/workspaces', { name: 'research', remotePath: 'research' })
    expect(r.status).toBe(200)
    expect((await stat(join(env.vaultRoot, 'research'))).isDirectory()).toBe(true)

    expect((await req(app, 'POST', '/api/workspaces', { name: 'r2', remotePath: 'research' })).status).toBe(409)
    expect((await req(app, 'POST', '/api/workspaces', { name: 'evil', remotePath: '../out' })).status).toBe(400)
  })

  test('DELETE refuses the default workspace, removes others (registry only)', async () => {
    const { app, env } = await freshApp()
    const list = (await (await req(app, 'GET', '/api/workspaces')).json()) as Array<{ id: string }>
    const def = list[0]
    expect((await req(app, 'DELETE', `/api/workspaces/${def.id}`)).status).toBe(400)

    const created = (await (
      await req(app, 'POST', '/api/workspaces', { name: 'tmp', remotePath: 'tmp' })
    ).json()) as { id: string }
    await writeFile(join(env.vaultRoot, 'tmp', 'keep.md'), 'k', 'utf8')
    expect((await req(app, 'DELETE', `/api/workspaces/${created.id}`)).status).toBe(200)
    // Files stay on disk — delete only drops the registry entry.
    expect(await readFile(join(env.vaultRoot, 'tmp', 'keep.md'), 'utf8')).toBe('k')
  })
})

describe('resolveWorkspaceRoot', () => {
  test('no id → default workspace dir; valid id → its dir; unknown → null', async () => {
    const env = await freshEnv()
    await ensureWorkspaceState(env)
    const app = new Hono()
    app.route('/api/workspaces', createWorkspaceRoutes(env.storeFile, env.vaultRoot))
    const created = (await (
      await req(app, 'POST', '/api/workspaces', { name: 'r', remotePath: 'research' })
    ).json()) as { id: string }

    expect(await resolveWorkspaceRoot(env.storeFile, env.vaultRoot, undefined)).toBe(
      join(env.vaultRoot, 'quill')
    )
    expect(await resolveWorkspaceRoot(env.storeFile, env.vaultRoot, created.id)).toBe(
      join(env.vaultRoot, 'research')
    )
    expect(await resolveWorkspaceRoot(env.storeFile, env.vaultRoot, 'nope')).toBeNull()
  })
})
