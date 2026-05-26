/**
 * REST wrappers for /api/agent/{catalog,providers}.
 *
 * The shape mirrors the server: `catalog` is the static list of supported
 * providers (id, kind, baseURL, models), `providers` is what the user has
 * configured (id, model — never api_key over the wire).
 */

import { UnauthorizedError } from '@quill/vault-adapter'
import { notifyUnauthorized } from './auth-events'

export type CatalogModel = {
  id: string
  /** Total context window in tokens. 0 means unknown — UI suppresses the
   *  "(X K)" annotation in that case. */
  contextTokens: number
  label?: string
}

export type CatalogEntry = {
  id: string
  kind: 'anthropic' | 'openai-compatible'
  baseURL: string
  models: CatalogModel[]
  defaultModelId: string
}

export type ConfiguredProvider = {
  id: string
  models: string[]
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, credentials: 'include' })
  if (res.status === 401) {
    notifyUnauthorized()
    throw new UnauthorizedError()
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(body || `${res.status} ${res.statusText}`)
  }
  return (await res.json()) as T
}

export const providersApi = {
  catalog: () => call<CatalogEntry[]>('/api/agent/catalog'),
  list: () => call<ConfiguredProvider[]>('/api/agent/providers'),
  upsert: (args: { id: string; api_key?: string; model: string }) =>
    call('/api/agent/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args)
    }),
  remove: (id: string) =>
    call(`/api/agent/providers/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
