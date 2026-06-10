import type { Workspace } from '../types'
import { ipc } from './ipc'

/**
 * Cloud workspace API for the desktop's remote mode. Same registry the
 * sync engine talks to (main process), but these calls run in the
 * renderer with the saved Bearer token — the switcher UI doesn't need a
 * round-trip through main.
 */

async function authed(): Promise<{ base: string; headers: Record<string, string> }> {
  const [url, token] = await Promise.all([ipc.remote.getUrl(), ipc.remote.getToken()])
  if (!url || !token) throw new Error('未配置远程服务器')
  return { base: url.replace(/\/+$/, ''), headers: { Authorization: `Bearer ${token}` } }
}

export async function fetchCloudWorkspaces(): Promise<Workspace[]> {
  const { base, headers } = await authed()
  const r = await fetch(`${base}/api/workspaces`, { headers })
  if (!r.ok) throw new Error(`加载工作区失败：${r.status}`)
  return (await r.json()) as Workspace[]
}

export async function createCloudWorkspace(name: string): Promise<Workspace> {
  const { base, headers } = await authed()
  const r = await fetch(`${base}/api/workspaces`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, remotePath: name })
  })
  if (r.status === 409) throw new Error('同名工作区已存在')
  if (!r.ok) throw new Error(`创建失败:${r.status} ${await r.text().catch(() => '')}`)
  return (await r.json()) as Workspace
}

/** Stored choice if it still exists, else the default, else the first. */
export function pickCloudWorkspace(
  list: Workspace[],
  storedId: string | null
): Workspace | null {
  if (storedId) {
    const stored = list.find((w) => w.id === storedId)
    if (stored) return stored
  }
  return list.find((w) => w.default) ?? list[0] ?? null
}

const keyFor = (serverUrl: string): string => `quill:remote-workspace:${serverUrl}`

export function readStoredCloudWorkspaceId(serverUrl: string): string | null {
  try {
    return localStorage.getItem(keyFor(serverUrl))
  } catch {
    return null
  }
}

export function storeCloudWorkspaceId(serverUrl: string, id: string): void {
  try {
    localStorage.setItem(keyFor(serverUrl), id)
  } catch {
    /* best-effort persistence only */
  }
}
