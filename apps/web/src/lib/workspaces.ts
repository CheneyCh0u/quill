import type { Workspace } from '@quill/shared-types'
import { notifyUnauthorized } from './auth-events'

/**
 * Cloud workspace API + active-workspace persistence for the web client.
 * Same-origin, cookie auth — mirrors how RemoteVault talks to the server.
 */

const STORAGE_KEY = 'quill:web:workspace'

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'include', ...init })
  if (res.status === 401) {
    notifyUnauthorized()
    throw new Error('unauthorized')
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText}: ${body}`)
  }
  return (await res.json()) as T
}

export function fetchWorkspaces(): Promise<Workspace[]> {
  return call<Workspace[]>('/api/workspaces')
}

export function createWorkspace(name: string): Promise<Workspace> {
  return call<Workspace>('/api/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, remotePath: name })
  })
}

/** Stored choice if it still exists, else the default workspace, else
 *  the first entry. Pure — storage I/O stays in the two helpers below. */
export function pickActiveWorkspace(
  list: Workspace[],
  storedId: string | null
): Workspace | null {
  if (storedId) {
    const stored = list.find((w) => w.id === storedId)
    if (stored) return stored
  }
  return list.find((w) => w.default) ?? list[0] ?? null
}

export function readStoredWorkspaceId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function storeWorkspaceId(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id)
  } catch {
    /* private mode etc. — selection just won't persist */
  }
}
