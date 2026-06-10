import { getFileType, type FileNode, type FileStat } from '@quill/shared-types'
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

function nameOf(p: string): string {
  return p.split('/').pop() ?? p
}

function toFileNode(e: ServerEntry): FileNode {
  if (e.isDirectory) {
    return {
      name: nameOf(e.path),
      path: e.path,
      isDirectory: true,
      isMarkdown: false,
      isText: false
    }
  }
  const info = getFileType(e.path)
  return {
    name: nameOf(e.path),
    path: e.path,
    isDirectory: false,
    isMarkdown: info.isMarkdown,
    isText: info.isText
  }
}

export type RemoteVaultOptions = {
  /** Server base URL — empty string means same-origin (web client default). */
  baseUrl?: string
  /**
   * Resolve auth headers to attach to every request. Sync or async.
   * Returning {} is fine for callers that rely on cookies (`credentials:
   * 'include'` is always set).
   *
   * Desktop uses this to inject `Authorization: Bearer <token>`, since
   * its `file://` renderer origin can't receive a SameSite=Lax cookie
   * from a remote https server.
   */
  getAuthHeaders?: () => Promise<Record<string, string>> | Record<string, string>
  /**
   * Fired whenever the server returns 401 — fires before the
   * UnauthorizedError throw so the host app can globally react (e.g. web
   * dispatches a window event that App.tsx listens to → redirect to
   * /login). Callers that already catch UnauthorizedError don't need this
   * to keep working; it's strictly additive.
   */
  onUnauthorized?: () => void
  /**
   * Cloud workspace directory under the vault root (e.g. "quill").
   * When set, every path this provider sends is prefixed with it and
   * every listed path comes back workspace-relative — callers operate
   * inside the workspace without knowing the vault layout.
   */
  rootPath?: string
}

/**
 * VaultProvider backed by the Quill server's REST API.
 *
 * Two auth transports are supported and can stack:
 *  - Cookies (browser, same-origin): `credentials: 'include'` is always
 *    set; the browser attaches `quill-session` automatically.
 *  - Bearer token (desktop, cross-origin): pass `getAuthHeaders` returning
 *    `{ Authorization: 'Bearer <token>' }`. The server's requireSession
 *    middleware accepts either and verifies the same JWT under the hood.
 *
 * Sync-status methods (push/pull/syncStatus) and a local-cache layer are
 * intentionally NOT here yet — when manual-sync UI lands, those become a
 * separate `SyncingRemoteVault` that composes this one.
 */
export class RemoteVault implements VaultProvider {
  readonly kind = 'remote' as const
  private readonly baseUrl: string
  private readonly getAuthHeaders: NonNullable<RemoteVaultOptions['getAuthHeaders']>
  private readonly onUnauthorized: () => void
  private readonly rootPath: string

  constructor(options: RemoteVaultOptions | string = {}) {
    // Tolerate the older positional-baseUrl signature so existing web
    // callers (`new RemoteVault()` / `new RemoteVault('http://x')`)
    // don't have to change.
    const opts = typeof options === 'string' ? { baseUrl: options } : options
    this.baseUrl = opts.baseUrl ?? ''
    this.getAuthHeaders = opts.getAuthHeaders ?? (() => ({}))
    this.onUnauthorized = opts.onUnauthorized ?? (() => undefined)
    this.rootPath = (opts.rootPath ?? '').replace(/^\/+|\/+$/g, '')
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`
  }

  /** Workspace-relative → vault-relative. */
  private full(path: string): string {
    const clean = path.replace(/^\/+/, '')
    if (!this.rootPath) return clean
    return clean ? `${this.rootPath}/${clean}` : this.rootPath
  }

  /** Vault-relative → workspace-relative (for listed entries). */
  private strip(path: string): string {
    if (!this.rootPath) return path
    const prefix = `${this.rootPath}/`
    return path.startsWith(prefix) ? path.slice(prefix.length) : path
  }

  /** Merge caller-supplied init with the auth headers + credentials.
   *  Headers can come in as Headers/array/record — preserve the user's
   *  values and let auth headers override only when not already set.
   *
   *  Bearer mode (auth headers present) gets `credentials: 'omit'`:
   *  cross-origin servers that return `Access-Control-Allow-Origin: *`
   *  reject preflight when credentials mode is 'include', and Bearer
   *  tokens don't need cookies anyway. Cookie mode (no auth headers,
   *  same-origin web) keeps `include` so the browser attaches the
   *  session cookie. */
  private async withAuth(init?: RequestInit): Promise<RequestInit> {
    const headers = new Headers(init?.headers)
    const auth = await this.getAuthHeaders()
    for (const [k, v] of Object.entries(auth)) {
      if (!headers.has(k)) headers.set(k, v)
    }
    const credentials = Object.keys(auth).length > 0 ? 'omit' : 'include'
    return { ...init, headers, credentials }
  }

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(this.url(path), await this.withAuth(init))
    if (res.status === 401) {
      this.onUnauthorized()
      throw new UnauthorizedError()
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`${res.status} ${res.statusText}: ${body}`)
    }
    return (await res.json()) as T
  }

  async read(path: string): Promise<string> {
    const res = await fetch(
      this.url(`/api/vault/file/${encodeURI(this.full(path))}`),
      await this.withAuth()
    )
    if (res.status === 401) {
      this.onUnauthorized()
      throw new UnauthorizedError()
    }
    if (res.status === 404) throw new Error(`file not found: ${path}`)
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    return res.text()
  }

  async write(path: string, content: string): Promise<void> {
    await this.call(`/api/vault/file/${encodeURI(this.full(path))}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: content
    })
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.call('/api/vault/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: this.full(oldPath), to: this.full(newPath) })
    })
  }

  async list(path: string): Promise<FileNode[]> {
    const dir = this.full(path)
    const url = `/api/vault/list${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`
    const entries = await this.call<ServerEntry[]>(url)
    return entries.map((e) => toFileNode({ ...e, path: this.strip(e.path) }))
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
      body: JSON.stringify({ path: this.full(path) })
    })
  }

  async delete(path: string): Promise<void> {
    await this.call(`/api/vault/file/${encodeURI(this.full(path))}`, { method: 'DELETE' })
  }

  async deleteDir(path: string, recursive: boolean): Promise<void> {
    await this.call(
      `/api/vault/dir/${encodeURI(this.full(path))}${recursive ? '?recursive=1' : ''}`,
      { method: 'DELETE' }
    )
  }
}
