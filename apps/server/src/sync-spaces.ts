import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { z } from 'zod'

/**
 * Registry of folder workspaces that opted into cloud sync. Desktop
 * clients use it to (a) record "this folder syncs to <remotePath>" and
 * (b) discover spaces created from another machine. Lives in STATE_DIR
 * next to providers.json — it's server state, not vault content.
 */
export type SyncSpace = {
  id: string
  name: string
  /** Directory under the vault root this space maps to. POSIX, relative. */
  remotePath: string
  createdAt: number
}

const CreateSchema = z.object({
  name: z.string().min(1),
  remotePath: z.string().min(1)
})

/** remotePath must stay inside the vault: relative, no `..` segments. */
function isSafeRemotePath(p: string): boolean {
  if (p.startsWith('/') || p.includes('\\')) return false
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
}

async function readSpaces(file: string): Promise<SyncSpace[]> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as SyncSpace[]
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

async function writeSpaces(file: string, spaces: SyncSpace[]): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(spaces, null, 2) + '\n', 'utf8')
  await fs.rename(tmp, file)
}

export function createSyncSpaceRoutes(storeFile: string): Hono {
  const app = new Hono()

  app.get('/', async (c) => c.json(await readSpaces(storeFile)))

  app.post('/', async (c) => {
    const parsed = CreateSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid body' }, 400)
    const { name, remotePath } = parsed.data
    if (!isSafeRemotePath(remotePath)) {
      return c.json({ error: 'invalid remotePath' }, 400)
    }
    const spaces = await readSpaces(storeFile)
    if (spaces.some((s) => s.remotePath === remotePath)) {
      return c.json({ error: 'remotePath already registered' }, 409)
    }
    const space: SyncSpace = { id: randomUUID(), name, remotePath, createdAt: Date.now() }
    await writeSpaces(storeFile, [...spaces, space])
    return c.json(space)
  })

  app.delete('/:id', async (c) => {
    const id = c.req.param('id')
    const spaces = await readSpaces(storeFile)
    const next = spaces.filter((s) => s.id !== id)
    if (next.length === spaces.length) return c.json({ error: 'not found' }, 404)
    await writeSpaces(storeFile, next)
    return c.json({ ok: true })
  })

  return app
}
