import { promises as fs, type Stats } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, relative, join, basename } from 'node:path'
import { Hono } from 'hono'
import { z } from 'zod'
import { resolveInVault, PathGuardError } from './path-guard'

/**
 * Vault metadata entry returned by /api/vault/index and /api/vault/list.
 * Matches packages/shared-types FileNode minus the recursive `children`
 * field — list endpoints are flat (recursion is the index endpoint's job).
 */
export type VaultEntry = {
  path: string // POSIX, relative to vault root
  isDirectory: boolean
  size?: number
  mtime?: number
  hash?: string // content SHA-256, files only
}

// `.quill` is the desktop's per-folder sync metadata — never part of
// vault content, so it stays out of the index/list surface entirely.
const SKIP_DIRS = new Set(['.git', '.svn', '.hg', 'node_modules', '.quill'])

async function sha256(path: string): Promise<string> {
  // Buffer the whole file. For vault contents (markdown + assets) sizes are
  // small; if we ever store large binaries we'll switch to streaming.
  const buf = await fs.readFile(path)
  return createHash('sha256').update(buf).digest('hex')
}

function toPosix(absPath: string, vaultRoot: string): string {
  const rel = relative(vaultRoot, absPath)
  return rel.split(/[\\/]/).filter(Boolean).join('/')
}

async function walkIndex(vaultRoot: string): Promise<VaultEntry[]> {
  const out: VaultEntry[] = []
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue
      const abs = join(dir, e.name)
      const relPath = toPosix(abs, vaultRoot)
      if (e.isDirectory()) {
        out.push({ path: relPath, isDirectory: true })
        await walk(abs)
      } else if (e.isFile()) {
        let stats: Stats
        try {
          stats = await fs.stat(abs)
        } catch {
          continue
        }
        out.push({
          path: relPath,
          isDirectory: false,
          size: stats.size,
          mtime: stats.mtimeMs,
          hash: await sha256(abs)
        })
      }
    }
  }
  await walk(vaultRoot)
  return out
}

async function listOne(absDir: string, vaultRoot: string): Promise<VaultEntry[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: VaultEntry[] = []
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue
    const abs = join(absDir, e.name)
    const relPath = toPosix(abs, vaultRoot)
    if (e.isDirectory()) {
      out.push({ path: relPath, isDirectory: true })
    } else if (e.isFile()) {
      try {
        const stats = await fs.stat(abs)
        out.push({
          path: relPath,
          isDirectory: false,
          size: stats.size,
          mtime: stats.mtimeMs
        })
      } catch {
        continue
      }
    }
  }
  return out
}

export function createVaultRoutes(vaultRoot: string): Hono {
  const app = new Hono()

  // Recursive scan + content hash. Costs scale with vault size; clients call
  // it once at workspace open then operate on individual paths.
  app.get('/index', async (c) => {
    const entries = await walkIndex(vaultRoot)
    return c.json(entries)
  })

  // Single-level listing for lazy file-tree expansion. `dir` is optional —
  // omitted means vault root.
  app.get('/list', async (c) => {
    const dir = c.req.query('dir') ?? ''
    let abs: string
    try {
      abs = resolveInVault(vaultRoot, dir)
    } catch (e) {
      if (e instanceof PathGuardError) return c.json({ error: e.message }, 400)
      throw e
    }
    const entries = await listOne(abs, vaultRoot)
    return c.json(entries)
  })

  // Read file. Returns 404 if missing. ETag = sha256 hex, lets clients
  // skip pulls when the cached hash matches.
  app.get('/file/:path{.+}', async (c) => {
    const userPath = c.req.param('path')
    let abs: string
    try {
      abs = resolveInVault(vaultRoot, decodeURIComponent(userPath))
    } catch (e) {
      if (e instanceof PathGuardError) return c.json({ error: e.message }, 400)
      throw e
    }
    let content: string
    try {
      content = await fs.readFile(abs, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return c.json({ error: 'not found' }, 404)
      }
      throw e
    }
    const hash = await sha256(abs)
    c.header('ETag', `"${hash}"`)
    return c.text(content)
  })

  // Write file. Auto-mkdir parents. Optional If-Match for optimistic
  // concurrency: 412 if the stored hash differs (caller is overwriting
  // someone else's write).
  app.put('/file/:path{.+}', async (c) => {
    const userPath = c.req.param('path')
    let abs: string
    try {
      abs = resolveInVault(vaultRoot, decodeURIComponent(userPath))
    } catch (e) {
      if (e instanceof PathGuardError) return c.json({ error: e.message }, 400)
      throw e
    }
    const ifMatch = c.req.header('If-Match')
    if (ifMatch) {
      try {
        const current = await sha256(abs)
        const want = ifMatch.replace(/"/g, '')
        if (current !== want) {
          return c.json({ error: 'precondition failed', currentHash: current }, 412)
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
        // File didn't exist — If-Match against a missing file is a logical
        // mismatch. Reject so the client knows the remote state changed.
        return c.json({ error: 'precondition failed: file missing' }, 412)
      }
    }
    const body = await c.req.text()
    await fs.mkdir(dirname(abs), { recursive: true })
    await fs.writeFile(abs, body, 'utf8')
    const newHash = await sha256(abs)
    c.header('ETag', `"${newHash}"`)
    return c.json({ hash: newHash })
  })

  // Delete a single file (not directories — use /dir/* for those). Same
  // If-Match contract as PUT.
  app.delete('/file/:path{.+}', async (c) => {
    const userPath = c.req.param('path')
    let abs: string
    try {
      abs = resolveInVault(vaultRoot, decodeURIComponent(userPath))
    } catch (e) {
      if (e instanceof PathGuardError) return c.json({ error: e.message }, 400)
      throw e
    }
    const ifMatch = c.req.header('If-Match')
    if (ifMatch) {
      try {
        const current = await sha256(abs)
        const want = ifMatch.replace(/"/g, '')
        if (current !== want) {
          return c.json({ error: 'precondition failed', currentHash: current }, 412)
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          return c.json({ error: 'not found' }, 404)
        }
        throw e
      }
    }
    // unlink() on a directory throws platform-dependent codes (EISDIR on
    // Linux, EPERM on macOS). Stat-then-decide gives one predictable path.
    try {
      const st = await fs.stat(abs)
      if (st.isDirectory()) {
        return c.json({ error: 'is a directory — use DELETE /dir/' }, 400)
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return c.json({ error: 'not found' }, 404)
      }
      throw e
    }
    await fs.unlink(abs)
    return c.json({ ok: true })
  })

  const MkdirSchema = z.object({ path: z.string() })
  app.post('/mkdir', async (c) => {
    const parsed = MkdirSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid body' }, 400)
    let abs: string
    try {
      abs = resolveInVault(vaultRoot, parsed.data.path)
    } catch (e) {
      if (e instanceof PathGuardError) return c.json({ error: e.message }, 400)
      throw e
    }
    await fs.mkdir(abs, { recursive: true })
    return c.json({ ok: true })
  })

  app.delete('/dir/:path{.+}', async (c) => {
    const userPath = c.req.param('path')
    const recursive = c.req.query('recursive') === '1' || c.req.query('recursive') === 'true'
    let abs: string
    try {
      abs = resolveInVault(vaultRoot, decodeURIComponent(userPath))
    } catch (e) {
      if (e instanceof PathGuardError) return c.json({ error: e.message }, 400)
      throw e
    }
    if (abs === vaultRoot) {
      // Defense-in-depth: never delete the vault root itself, even if the
      // client manages to construct a path that resolves there.
      return c.json({ error: 'cannot delete vault root' }, 400)
    }
    try {
      if (recursive) {
        await fs.rm(abs, { recursive: true, force: false })
      } else {
        await fs.rmdir(abs)
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return c.json({ error: 'not found' }, 404)
      if (code === 'ENOTEMPTY') {
        return c.json({ error: 'directory not empty (pass recursive=1)' }, 409)
      }
      if (code === 'ENOTDIR') {
        return c.json({ error: 'not a directory — use DELETE /file/' }, 400)
      }
      throw e
    }
    return c.json({ ok: true })
  })

  const MoveSchema = z.object({ from: z.string(), to: z.string() })
  app.post('/move', async (c) => {
    const parsed = MoveSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid body' }, 400)
    let absFrom: string
    let absTo: string
    try {
      absFrom = resolveInVault(vaultRoot, parsed.data.from)
      absTo = resolveInVault(vaultRoot, parsed.data.to)
    } catch (e) {
      if (e instanceof PathGuardError) return c.json({ error: e.message }, 400)
      throw e
    }
    await fs.mkdir(dirname(absTo), { recursive: true })
    try {
      await fs.rename(absFrom, absTo)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return c.json({ error: 'source not found' }, 404)
      }
      throw e
    }
    return c.json({ ok: true })
  })

  // Binary resource (images etc.). Identical to GET /file/ but skips utf8
  // decoding and sets Content-Type by extension.
  app.get('/resource/:path{.+}', async (c) => {
    const userPath = c.req.param('path')
    let abs: string
    try {
      abs = resolveInVault(vaultRoot, decodeURIComponent(userPath))
    } catch (e) {
      if (e instanceof PathGuardError) return c.json({ error: e.message }, 400)
      throw e
    }
    let data: Buffer
    try {
      data = await fs.readFile(abs)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return c.json({ error: 'not found' }, 404)
      }
      throw e
    }
    const hash = createHash('sha256').update(data).digest('hex')
    // Construct the Response directly — Hono's c.body() overloads don't
    // play nice with Buffer/Uint8Array under strict TS, and Bun's Response
    // takes any BodyInit at runtime.
    return new Response(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), {
      headers: {
        ETag: `"${hash}"`,
        'Cache-Control': 'private, max-age=3600',
        'Content-Type': mimeFor(basename(abs))
      }
    })
  })

  return app
}

function mimeFor(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  switch (ext) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    case 'svg':
      return 'image/svg+xml'
    case 'pdf':
      return 'application/pdf'
    default:
      return 'application/octet-stream'
  }
}
