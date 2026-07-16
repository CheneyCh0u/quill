import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * ChatGPT 订阅（Codex）OAuth 凭证管理 — 设备码登录、token 刷新、opencode
 * 凭证复用。零 Electron 依赖：存储通过 CodexAuthStore 注入（desktop 用
 * safeStorage，server 将来可用 config 文件）。
 *
 * 流程与常量移植自经过验证的 opencode / Codex CLI 设备码实现：
 * auth.openai.com 的 device authorization → authorization_code + PKCE
 * verifier（由服务端下发）→ /oauth/token 换 access/refresh token。
 */

export const CODEX_PROVIDER_ID = 'openai-codex'
export const CODEX_API_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses'

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const ISSUER = 'https://auth.openai.com'
const USER_AGENT = 'quill/1.0'

export type CodexTokens = {
  accessToken: string
  refreshToken: string
  /** ms epoch when accessToken expires. 0 = unknown/expired, refresh first. */
  expiresAt: number
  /** ChatGPT-Account-Id header value; null when the JWT carried none. */
  accountId: string | null
}

/** Host-provided persistence for OAuth tokens (desktop: safeStorage file). */
export interface CodexAuthStore {
  load(): Promise<CodexTokens | null>
  save(tokens: CodexTokens): Promise<void>
  clear(): Promise<void>
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

// ---------------------------------------------------------------------------
// device authorization flow

export type DeviceAuthPending = {
  deviceAuthId: string
  userCode: string
  /** Page where the user types `userCode` to approve this device. */
  verificationUrl: string
  /** Suggested polling interval for pollCodexDeviceAuth. */
  intervalMs: number
}

export type DeviceAuthPollResult =
  | { status: 'pending' }
  | { status: 'connected'; tokens: CodexTokens }

export async function startCodexDeviceAuth(fetchFn: FetchLike = fetch): Promise<DeviceAuthPending> {
  const res = await fetchFn(`${ISSUER}/api/accounts/deviceauth/usercode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({ client_id: CLIENT_ID })
  })
  if (!res.ok) {
    throw new Error(`启动 ChatGPT 授权失败：${res.status} ${await res.text()}`)
  }
  const data = (await res.json()) as {
    device_auth_id: string
    user_code: string
    interval?: string
  }
  return {
    deviceAuthId: data.device_auth_id,
    userCode: data.user_code,
    verificationUrl: `${ISSUER}/codex/device`,
    // +3s guard so we never poll faster than the server asked for.
    intervalMs: Math.max(parseInt(data.interval ?? '', 10) || 5, 1) * 1000 + 3000
  }
}

type TokenResponse = {
  id_token?: string
  access_token: string
  refresh_token: string
  expires_in?: number
}

function parseJwtClaims(token?: string): Record<string, unknown> | undefined {
  if (!token) return undefined
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString())
  } catch {
    return undefined
  }
}

function extractAccountId(tokens: TokenResponse): string | null {
  const claims = parseJwtClaims(tokens.id_token) ?? parseJwtClaims(tokens.access_token)
  if (!claims) return null
  const authClaim = claims['https://api.openai.com/auth'] as
    | { chatgpt_account_id?: string }
    | undefined
  const orgs = claims.organizations as Array<{ id?: string }> | undefined
  return (
    (claims.chatgpt_account_id as string | undefined) ||
    authClaim?.chatgpt_account_id ||
    orgs?.[0]?.id ||
    null
  )
}

function toCodexTokens(tokens: TokenResponse, prevAccountId: string | null): CodexTokens {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    accountId: extractAccountId(tokens) ?? prevAccountId
  }
}

/**
 * One polling step of the device flow. 403/404 mean the user hasn't
 * finished authorizing in the browser yet — call again after
 * `pending.intervalMs`. On success the returned authorization_code (with
 * the server-issued PKCE verifier) is exchanged for tokens in one go.
 */
export async function pollCodexDeviceAuth(
  pending: DeviceAuthPending,
  fetchFn: FetchLike = fetch
): Promise<DeviceAuthPollResult> {
  const res = await fetchFn(`${ISSUER}/api/accounts/deviceauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({ device_auth_id: pending.deviceAuthId, user_code: pending.userCode })
  })
  if (!res.ok) {
    if (res.status === 403 || res.status === 404) return { status: 'pending' }
    throw new Error(`轮询 ChatGPT 授权失败：${res.status} ${await res.text()}`)
  }
  const data = (await res.json()) as { authorization_code: string; code_verifier: string }
  const tokenRes = await fetchFn(`${ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: data.authorization_code,
      redirect_uri: `${ISSUER}/deviceauth/callback`,
      client_id: CLIENT_ID,
      code_verifier: data.code_verifier
    }).toString()
  })
  if (!tokenRes.ok) {
    throw new Error(`ChatGPT token 交换失败：${tokenRes.status} ${await tokenRes.text()}`)
  }
  return { status: 'connected', tokens: toCodexTokens((await tokenRes.json()) as TokenResponse, null) }
}

// ---------------------------------------------------------------------------
// token refresh

async function refreshCodexTokens(prev: CodexTokens, fetchFn: FetchLike): Promise<CodexTokens> {
  const res = await fetchFn(`${ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: prev.refreshToken,
      client_id: CLIENT_ID
    }).toString()
  })
  if (!res.ok) {
    throw new Error(`ChatGPT token 刷新失败：${res.status} ${await res.text()}`)
  }
  return toCodexTokens((await res.json()) as TokenResponse, prev.accountId)
}

/**
 * Returns a callable that always resolves to *valid* tokens: stored ones
 * while they have >30s left, otherwise refreshed via refresh_token.
 * The refresh token rotates on every refresh, so the rotated pair is
 * persisted back into the store immediately — losing it bricks the login.
 * Concurrent callers share one in-flight refresh.
 */
export function createCodexTokenSource(
  store: CodexAuthStore,
  fetchFn: FetchLike = fetch
): () => Promise<CodexTokens> {
  let refreshing: Promise<CodexTokens> | null = null
  return async () => {
    const stored = await store.load()
    if (!stored) {
      throw new Error('ChatGPT 订阅未登录 — 在设置 → 大模型供应商里登录 OpenAI')
    }
    if (stored.accessToken && stored.expiresAt > Date.now() + 30_000) return stored
    if (!refreshing) {
      refreshing = refreshCodexTokens(stored, fetchFn)
        .then(async (next) => {
          await store.save(next)
          return next
        })
        .finally(() => {
          refreshing = null
        })
    }
    return refreshing
  }
}

// ---------------------------------------------------------------------------
// opencode credential reuse

/**
 * Maps opencode's `auth.json` shape (`{ openai: { type: 'oauth', access,
 * refresh, expires, accountId } }`) to CodexTokens. Returns null when the
 * file has no reusable oauth login (missing entry, api-key entry, or no
 * refresh token).
 */
export function parseOpencodeAuth(data: unknown): CodexTokens | null {
  if (!data || typeof data !== 'object') return null
  const entry = (data as Record<string, unknown>).openai
  if (!entry || typeof entry !== 'object') return null
  const auth = entry as Record<string, unknown>
  if (auth.type !== 'oauth' || typeof auth.refresh !== 'string' || auth.refresh.length === 0) {
    return null
  }
  return {
    accessToken: typeof auth.access === 'string' ? auth.access : '',
    refreshToken: auth.refresh,
    expiresAt: typeof auth.expires === 'number' ? auth.expires : 0,
    accountId: typeof auth.accountId === 'string' ? auth.accountId : null
  }
}

export function defaultOpencodeAuthPath(): string {
  return join(homedir(), '.local', 'share', 'opencode', 'auth.json')
}

/** Reads opencode's auth.json; null when absent or without an oauth login. */
export async function readOpencodeAuth(
  filePath = defaultOpencodeAuthPath()
): Promise<CodexTokens | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    return parseOpencodeAuth(JSON.parse(raw))
  } catch {
    return null
  }
}
