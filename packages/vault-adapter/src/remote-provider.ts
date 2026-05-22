import type { FileNode, FileStat } from '@quill/shared-types'
import type { VaultProvider } from './types'

/**
 * Thrown when an HTTP call to the Quill server hits 401 — the calling
 * UI typically reacts by surfacing a login prompt or redirecting. Other
 * status codes throw a plain Error with the response body included so
 * callers can show a meaningful message.
 */
export class UnauthorizedError extends Error {
  constructor() {
    super('unauthorized')
    this.name = 'UnauthorizedError'
  }
}

type ServerEntry = {
  path: string
  isDirectory: boolean
  size?: number
  mtime?: number
  hash?: string
}

const MD_EXT = /\.(md|markdown|mdown|mkd)$/i

function nameOf(p: string): string {
  return p.split('/').pop() ?? p
}

function toFileNode(e: ServerEntry): FileNode {
  return {
    name: nameOf(e.path),
    path: e.path,
    isDirectory: e.isDirectory,
    isMarkdown: !e.isDirectory && MD_EXT.test(e.path)
  }
}

/**
 * VaultProvider backed by the Quill server's REST API.
 *
 * Cookie auth: `credentials: 'include'` lets the browser (or Electron
 * renderer's session) attach the `quill-session` cookie automatically.
 * The desktop app's renderer goes through the same Electron net stack as
 * regular fetch, so cookies set by a successful /api/auth/login persist
 * for subsequent vault calls without any extra wiring.
 *
 * baseUrl: empty by default (same origin, the web client's setup). The
 * desktop app passes the full server URL ("https://quill.example.com").
 *
 * Sync-status methods (push/pull/syncStatus) and a local-cache layer
 * are intentionally NOT here yet — when the manual-sync UI lands, those
 * become a separate `SyncingRemoteVault` that composes this one.
 */
export class RemoteVault implements VaultProvider {
  readonly kind = 'remote' as const

  constructor(private readonly baseUrl: string = '') {}

  private url(path: string): string {
    return `${this.baseUrl}${path}`
  }

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(this.url(path), { ...init, credentials: 'include' })
    if (res.status === 401) throw new UnauthorizedError()
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`${res.status} ${res.statusText}: ${body}`)
    }
    return (await res.json()) as T
  }

  async read(path: string): Promise<string> {
    const res = await fetch(this.url(`/api/vault/file/${encodeURI(path)}`), {
      credentials: 'include'
    })
    if (res.status === 401) throw new UnauthorizedError()
    if (res.status === 404) throw new Error(`file not found: ${path}`)
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    return res.text()
  }

  async write(path: string, content: string): Promise<void> {
    await this.call(`/api/vault/file/${encodeURI(path)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: content
    })
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.call('/api/vault/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: oldPath, to: newPath })
    })
  }

  async list(path: string): Promise<FileNode[]> {
    const dir = path.replace(/^\/+/, '')
    const url = `/api/vault/list${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`
    const entries = await this.call<ServerEntry[]>(url)
    return entries.map(toFileNode)
  }

  async stat(path: string): Promise<FileStat> {
    // The current server doesn't expose a dedicated /stat. Derive from
    // list of the parent; consumers that need this rarely (drag overlay)
    // can pay the extra round-trip. A real /api/vault/stat endpoint is a
    // future addition when sync-state UI starts using it heavily.
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    const siblings = await this.list(parent)
    const me = siblings.find((s) => s.path === path)
    if (!me) throw new Error(`not found: ${path}`)
    return {
      isFile: !me.isDirectory,
      isDirectory: me.isDirectory,
      size: 0,
      mtime: 0
    }
  }

  async mkdir(path: string): Promise<void> {
    await this.call('/api/vault/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: path.replace(/^\/+/, '') })
    })
  }

  async delete(path: string): Promise<void> {
    await this.call(`/api/vault/file/${encodeURI(path)}`, { method: 'DELETE' })
  }

  async deleteDir(path: string, recursive: boolean): Promise<void> {
    await this.call(
      `/api/vault/dir/${encodeURI(path)}${recursive ? '?recursive=1' : ''}`,
      { method: 'DELETE' }
    )
  }
}
