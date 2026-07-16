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
  kind: 'anthropic' | 'openai-compatible' | 'openai-codex'
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

// ---------------------------------------------------------------------------
// ChatGPT subscription login (openai-codex) — tokens live server-side;
// the client only sees connection status and drives the device-code flow.

export type CodexStatus = {
  connected: boolean
  accountId: string | null
  model: string
}

export type CodexLoginStart = {
  userCode: string
  verificationUrl: string
  intervalMs: number
}

export type CodexPollResult =
  | { status: 'pending' }
  | { status: 'connected'; accountId: string | null }

export const codexApi = {
  status: () => call<CodexStatus>('/api/agent/codex'),
  loginStart: () =>
    call<CodexLoginStart>('/api/agent/codex/login/start', { method: 'POST' }),
  loginPoll: () =>
    call<CodexPollResult>('/api/agent/codex/login/poll', { method: 'POST' }),
  loginCancel: () => call('/api/agent/codex/login/cancel', { method: 'POST' }),
  setModel: (model: string) =>
    call('/api/agent/codex/model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model })
    }),
  logout: () => call('/api/agent/codex', { method: 'DELETE' })
}
