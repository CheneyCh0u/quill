import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Workspace } from '@quill/shared-types'

/**
 * Cloud workspaces: first-level directories under the vault root. One
 * registry (STATE_DIR/workspaces.json) serves both the web/desktop
 * workspace switcher and the desktop folder-sync binding — a synced
 * folder IS a workspace. Successor of the sync-spaces registry; ids are
 * preserved on migration so desktop .quill/sync.json bindings survive.
 */

const DEFAULT_NAME = 'quill'

const CreateSchema = z.object({
  name: z.string().min(1),
  remotePath: z.string().min(1)
})

/** remotePath must stay inside the vault: relative, no `..` segments. */
function isSafeRemotePath(p: string): boolean {
  if (p.startsWith('/') || p.includes('\\')) return false
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
}

async function readWorkspaces(file: string): Promise<Workspace[]> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as Workspace[]
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

async function writeWorkspaces(file: string, list: Workspace[]): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(list, null, 2) + '\n', 'utf8')
  await fs.rename(tmp, file)
}

export type WorkspaceStateEnv = {
  /** STATE_DIR/workspaces.json */
  storeFile: string
  /** STATE_DIR/sync-spaces.json — pre-workspace registry, if any. */
  legacyFile: string
  vaultRoot: string
}

/**
 * Startup invariants, all idempotent:
 *  1. Migrate the legacy sync-spaces registry, PRESERVING ids — desktop
 *     folder bindings reference them.
 *  2. Ensure the default `quill` workspace (registry entry + directory).
 *  3. Sweep loose vault-root entries (not belonging to any registered
 *     workspace) into the default workspace so every file lives in
 *     exactly one workspace.
 */
export async function ensureWorkspaceState(env: WorkspaceStateEnv): Promise<void> {
  let list = await readWorkspaces(env.storeFile)

  if (list.length === 0) {
    const legacy = await readWorkspaces(env.legacyFile)
    if (legacy.length > 0) list = [...legacy]
  }

  if (!list.some((w) => w.default)) {
    const clash = list.find((w) => w.remotePath === DEFAULT_NAME)
    if (clash) {
      // A legacy space already claimed the quill directory — promote it.
      clash.default = true
    } else {
      list.push({
        id: randomUUID(),
        name: DEFAULT_NAME,
        remotePath: DEFAULT_NAME,
        default: true,
        createdAt: Date.now()
      })
    }
  }

  for (const w of list) {
    await fs.mkdir(join(env.vaultRoot, w.remotePath), { recursive: true })
  }
  await writeWorkspaces(env.storeFile, list)

  // Sweep: anything at the vault root that isn't a workspace top-level
  // dir moves into the default workspace. Hidden bookkeeping stays put.
  const def = list.find((w) => w.default)!
  const topDirs = new Set(list.map((w) => w.remotePath.split('/')[0]))
  const entries = await fs.readdir(env.vaultRoot)
  for (const name of entries) {
    if (topDirs.has(name) || name.startsWith('.')) continue
    const from = join(env.vaultRoot, name)
    const to = join(env.vaultRoot, def.remotePath, name)
    await fs.rename(from, to)
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ event: 'workspace-sweep', moved: name, into: def.remotePath }))
  }
}

/**
 * Agent scope resolution: no id → the default workspace; a registered
 * id → its directory; anything else → null (caller rejects the run).
 */
export async function resolveWorkspaceRoot(
  storeFile: string,
  vaultRoot: string,
  workspaceId: string | undefined
): Promise<string | null> {
  const list = await readWorkspaces(storeFile)
  const w =
    workspaceId === undefined
      ? list.find((x) => x.default)
      : list.find((x) => x.id === workspaceId)
  return w ? join(vaultRoot, w.remotePath) : null
}

async function countFiles(dir: string): Promise<number> {
  let n = 0
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    if (e.isDirectory()) n += await countFiles(join(dir, e.name))
    else if (e.isFile()) n += 1
  }
  return n
}

export function createWorkspaceRoutes(storeFile: string, vaultRoot: string): Hono {
  const app = new Hono()

  app.get('/', async (c) => {
    const list = await readWorkspaces(storeFile)
    const withCounts = await Promise.all(
      list.map(async (w) => ({
        ...w,
        fileCount: await countFiles(join(vaultRoot, w.remotePath))
      }))
    )
    return c.json(withCounts)
  })

  app.post('/', async (c) => {
    const parsed = CreateSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid body' }, 400)
    const { name, remotePath } = parsed.data
    if (!isSafeRemotePath(remotePath)) {
      return c.json({ error: 'invalid remotePath' }, 400)
    }
    const list = await readWorkspaces(storeFile)
    if (list.some((w) => w.remotePath === remotePath)) {
      return c.json({ error: 'remotePath already registered' }, 409)
    }
    const ws: Workspace = { id: randomUUID(), name, remotePath, createdAt: Date.now() }
    await fs.mkdir(join(vaultRoot, remotePath), { recursive: true })
    await writeWorkspaces(storeFile, [...list, ws])
    return c.json(ws)
  })

  app.delete('/:id', async (c) => {
    const id = c.req.param('id')
    const list = await readWorkspaces(storeFile)
    const target = list.find((w) => w.id === id)
    if (!target) return c.json({ error: 'not found' }, 404)
    if (target.default) {
      return c.json({ error: 'default workspace cannot be deleted' }, 400)
    }
    await writeWorkspaces(storeFile, list.filter((w) => w.id !== id))
    return c.json({ ok: true })
  })

  return app
}
