import type { FileNode, FileStat } from '@quill/shared-types'
import type { VaultProvider } from '@quill/vault-adapter'

/**
 * Thrown when an HTTP call hits 401 — the auth wrapper redirects to /login.
 * Other status codes throw plain Error with the response body so the caller
 * can surface a useful message.
 */
export class UnauthorizedError extends Error {
  constructor() {
    super('unauthorized')
    this.name = 'UnauthorizedError'
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'include'
  })
  if (res.status === 401) throw new UnauthorizedError()
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText}: ${body}`)
  }
  return (await res.json()) as T
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
 * VaultProvider backed by the Quill server's REST API. Single-level `list`
 * via /api/vault/list?dir=... matches the design doc lazy-load model;
 * sync-status methods will be added when manual sync UI lands.
 */
export class RemoteVault implements VaultProvider {
  readonly kind = 'remote' as const

  constructor(private readonly baseUrl: string = '') {}

  private url(path: string): string {
    return `${this.baseUrl}${path}`
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
    await call(this.url(`/api/vault/file/${encodeURI(path)}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: content
    })
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await call(this.url('/api/vault/move'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: oldPath, to: newPath })
    })
  }

  async list(path: string): Promise<FileNode[]> {
    const dir = path.replace(/^\/+/, '')
    const url = this.url(`/api/vault/list${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`)
    const entries = await call<ServerEntry[]>(url)
    return entries.map(toFileNode)
  }

  async stat(path: string): Promise<FileStat> {
    // The current server doesn't expose a dedicated /stat. Derive from list
    // of the parent; for the rare consumer that needs this (drag-overlay)
    // we'll add a real /stat endpoint when sync-state UI starts using it.
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
    await call(this.url('/api/vault/mkdir'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: path.replace(/^\/+/, '') })
    })
  }

  async delete(path: string): Promise<void> {
    await call(this.url(`/api/vault/file/${encodeURI(path)}`), {
      method: 'DELETE'
    })
  }

  async deleteDir(path: string, recursive: boolean): Promise<void> {
    const url = this.url(
      `/api/vault/dir/${encodeURI(path)}${recursive ? '?recursive=1' : ''}`
    )
    await call(url, { method: 'DELETE' })
  }
}
