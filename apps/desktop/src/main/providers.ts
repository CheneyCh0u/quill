import { safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { migrateModelId } from '@quill/agent'

/**
 * Storage layout under ~/.quill/:
 *
 *   providers/
 *     <id>.enc      — API key, encrypted via Electron safeStorage (OS keychain)
 *     <id>.json     — metadata: { id, model, addedAt, updatedAt }
 *   prefs.json      — { defaultProviderId?: string }
 *
 * Keys are NEVER returned to the renderer. The agent runtime (#2) reads
 * them in main when it needs to call the LLM API.
 */

const QUILL_DIR = join(homedir(), '.quill')
const PROVIDERS_DIR = join(QUILL_DIR, 'providers')
const PREFS_FILE = join(QUILL_DIR, 'prefs.json')

export type StoredProviderMeta = {
  id: string
  model: string
  addedAt: number
  updatedAt: number
}

async function ensureDirs(): Promise<void> {
  await fs.mkdir(PROVIDERS_DIR, { recursive: true })
}

function sanitizeId(id: string): string {
  // Belt-and-suspenders against path traversal — renderer validates ids
  // against the PROVIDERS registry, but main re-checks before using as a
  // filename.
  if (!/^[a-z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid provider id: ${id}`)
  }
  return id
}

export async function listProviders(): Promise<StoredProviderMeta[]> {
  await ensureDirs()
  let entries: string[] = []
  try {
    entries = await fs.readdir(PROVIDERS_DIR)
  } catch {
    return []
  }
  const metas: StoredProviderMeta[] = []
  for (const f of entries) {
    if (!f.endsWith('.json')) continue
    try {
      const raw = await fs.readFile(join(PROVIDERS_DIR, f), 'utf-8')
      const meta = JSON.parse(raw) as StoredProviderMeta
      // Migration: stored model may be from an older catalog (e.g. a
      // model id we no longer present). Snap to the provider's default
      // and re-persist so the renderer doesn't ever see stale data.
      const snapTo = migrateModelId(meta.id, meta.model)
      if (snapTo) {
        // eslint-disable-next-line no-console
        console.log(
          `[providers] migrating stored ${meta.id} model: ${meta.model} → ${snapTo}`
        )
        meta.model = snapTo
        meta.updatedAt = Date.now()
        await fs
          .writeFile(join(PROVIDERS_DIR, f), JSON.stringify(meta, null, 2), 'utf-8')
          .catch(() => {
            /* best-effort — next load will retry */
          })
      }
      metas.push(meta)
    } catch {
      // skip corrupt entry rather than fail the whole list
    }
  }
  return metas
}

export async function upsertProvider(
  id: string,
  key: string,
  model: string
): Promise<void> {
  await ensureDirs()
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'safeStorage 不可用（系统 keychain 未就绪），拒绝以明文存储 API key'
    )
  }
  const safeId = sanitizeId(id)
  const keyPath = join(PROVIDERS_DIR, `${safeId}.enc`)

  // Encrypt key via OS keychain
  const encrypted = safeStorage.encryptString(key)
  await fs.writeFile(keyPath, encrypted)

  await writeProviderMeta(safeId, model)
}

/**
 * Write just the metadata entry (no key). Besides upsertProvider, the
 * ChatGPT subscription login uses this to surface `openai-codex` in the
 * configured-providers list — its credential is an OAuth token stored
 * separately (see codex.ts), not an API key.
 */
export async function writeProviderMeta(id: string, model: string): Promise<void> {
  await ensureDirs()
  const safeId = sanitizeId(id)
  const metaPath = join(PROVIDERS_DIR, `${safeId}.json`)

  // Preserve addedAt on update so user can see original install date
  let addedAt = Date.now()
  try {
    const existing = JSON.parse(await fs.readFile(metaPath, 'utf-8'))
    if (typeof existing.addedAt === 'number') addedAt = existing.addedAt
  } catch {
    /* new entry */
  }

  const meta: StoredProviderMeta = {
    id: safeId,
    model,
    addedAt,
    updatedAt: Date.now()
  }
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8')
}

/**
 * Update only the model field — leaves the encrypted key alone. Used when
 * the user edits a configured provider but doesn't want to re-type the key.
 * Throws if the provider isn't yet configured.
 */
export async function updateProviderModel(id: string, model: string): Promise<void> {
  await ensureDirs()
  const safeId = sanitizeId(id)
  const metaPath = join(PROVIDERS_DIR, `${safeId}.json`)
  const raw = await fs.readFile(metaPath, 'utf-8') // throws if not configured
  const existing = JSON.parse(raw)
  const meta: StoredProviderMeta = {
    id: safeId,
    model,
    addedAt: typeof existing.addedAt === 'number' ? existing.addedAt : Date.now(),
    updatedAt: Date.now()
  }
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8')
}

export async function removeProvider(id: string): Promise<void> {
  const safeId = sanitizeId(id)
  await fs.unlink(join(PROVIDERS_DIR, `${safeId}.enc`)).catch(() => {})
  await fs.unlink(join(PROVIDERS_DIR, `${safeId}.json`)).catch(() => {})

  // If this was the default, clear it so UI doesn't dangle a dead pointer
  if ((await getDefaultProvider()) === safeId) {
    await setDefaultProvider(null)
  }
}

/**
 * Read an API key into memory. Main-only — never exposed via IPC. Agent
 * runtime calls this when instantiating an ai-sdk model.
 */
export async function getProviderKey(id: string): Promise<string | null> {
  if (!safeStorage.isEncryptionAvailable()) return null
  const safeId = sanitizeId(id)
  try {
    const buf = await fs.readFile(join(PROVIDERS_DIR, `${safeId}.enc`))
    return safeStorage.decryptString(buf)
  } catch {
    return null
  }
}

/**
 * Reachability probe — HEAD request with 5s timeout. Does NOT validate the
 * API key (we don't burn tokens just to test); only checks that the URL
 * resolves and answers. 4xx is considered "reachable" (auth issue means we
 * found the server).
 */
export async function testProvider(
  baseURL: string
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const res = await fetch(baseURL, { method: 'HEAD', signal: controller.signal })
    return { ok: true, status: res.status }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
}

type Prefs = {
  defaultProviderId?: string
}

async function readPrefs(): Promise<Prefs> {
  try {
    const raw = await fs.readFile(PREFS_FILE, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

async function writePrefs(prefs: Prefs): Promise<void> {
  await ensureDirs()
  await fs.writeFile(PREFS_FILE, JSON.stringify(prefs, null, 2), 'utf-8')
}

export async function getDefaultProvider(): Promise<string | null> {
  return (await readPrefs()).defaultProviderId ?? null
}

export async function setDefaultProvider(id: string | null): Promise<void> {
  const prefs = await readPrefs()
  if (id === null) {
    delete prefs.defaultProviderId
  } else {
    prefs.defaultProviderId = sanitizeId(id)
  }
  await writePrefs(prefs)
}
