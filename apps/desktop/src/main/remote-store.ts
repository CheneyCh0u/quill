import { safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * Persists the desktop's remote-vault connection. We store two things:
 *
 *  - The server's base URL ("https://quill.example.com"). Lives in
 *    ~/.quill/remote.json — plaintext, not a secret.
 *  - The session token (JWT) returned by /api/auth/login. Encrypted via
 *    Electron's safeStorage (OS keychain on macOS/Windows, libsecret on
 *    Linux); written to ~/.quill/remote.token.enc.
 *
 * Two-file split so a user inspecting their home dir can see "what
 * server am I connected to?" without having a decryptable secret on
 * disk next to it.
 */

const QUILL_DIR = join(homedir(), '.quill')
const REMOTE_FILE = join(QUILL_DIR, 'remote.json')
const TOKEN_FILE = join(QUILL_DIR, 'remote.token.enc')

type RemoteRecord = { url: string }

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(path, 'utf8')
    return JSON.parse(raw) as T
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await fs.mkdir(QUILL_DIR, { recursive: true })
  const tmp = path + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  await fs.rename(tmp, path)
}

export async function getRemoteUrl(): Promise<string | null> {
  const rec = await readJson<RemoteRecord>(REMOTE_FILE)
  return rec?.url ?? null
}

export async function setRemoteUrl(url: string | null): Promise<void> {
  if (url === null) {
    await fs.rm(REMOTE_FILE, { force: true })
    return
  }
  await writeJson(REMOTE_FILE, { url })
}

/** Encrypt and persist the session token via OS keychain. Returns false
 *  silently if the platform lacks an unlocked keychain — the user will
 *  just have to log in again next session. */
export async function setRemoteToken(token: string | null): Promise<void> {
  if (token === null) {
    await fs.rm(TOKEN_FILE, { force: true })
    return
  }
  if (!safeStorage.isEncryptionAvailable()) {
    // No keychain → don't fall back to plaintext, just refuse. Caller
    // logs in next time.
    return
  }
  await fs.mkdir(QUILL_DIR, { recursive: true })
  const enc = safeStorage.encryptString(token)
  await fs.writeFile(TOKEN_FILE, enc, { mode: 0o600 })
}

export async function getRemoteToken(): Promise<string | null> {
  try {
    const enc = await fs.readFile(TOKEN_FILE)
    if (!safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(enc)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    return null
  }
}

export async function clearRemote(): Promise<void> {
  await setRemoteUrl(null)
  await setRemoteToken(null)
}
