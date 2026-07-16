import { describe, it, expect } from 'bun:test'
import {
  createCodexTokenSource,
  parseOpencodeAuth,
  pollCodexDeviceAuth,
  startCodexDeviceAuth,
  type CodexAuthStore,
  type CodexTokens
} from './codex-auth'

function fakeJwt(payload: Record<string, unknown>): string {
  return `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

/** Sequenced fetch mock — pops one queued response per call, records calls. */
function fetchQueue(responses: Response[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fn = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init })
    const next = responses.shift()
    if (!next) throw new Error('fetchQueue exhausted')
    return next
  }
  return { fn, calls }
}

function memoryStore(initial: CodexTokens | null): CodexAuthStore & { saved: CodexTokens[] } {
  let current = initial
  const saved: CodexTokens[] = []
  return {
    saved,
    load: async () => current,
    save: async (t) => {
      current = t
      saved.push(t)
    },
    clear: async () => {
      current = null
    }
  }
}

describe('startCodexDeviceAuth', () => {
  it('requests a user code and returns the verification info', async () => {
    const { fn, calls } = fetchQueue([
      jsonResponse({ device_auth_id: 'dev-1', user_code: 'ABCD-EFGH', interval: '5' })
    ])
    const pending = await startCodexDeviceAuth(fn)
    expect(pending).toEqual({
      deviceAuthId: 'dev-1',
      userCode: 'ABCD-EFGH',
      verificationUrl: 'https://auth.openai.com/codex/device',
      intervalMs: 8000
    })
    expect(calls[0].url).toBe('https://auth.openai.com/api/accounts/deviceauth/usercode')
    expect(JSON.parse(calls[0].init?.body as string).client_id).toMatch(/^app_/)
  })

  it('throws with status detail when the endpoint rejects', async () => {
    const { fn } = fetchQueue([new Response('nope', { status: 500 })])
    expect(startCodexDeviceAuth(fn)).rejects.toThrow('500')
  })
})

describe('pollCodexDeviceAuth', () => {
  const pending = {
    deviceAuthId: 'dev-1',
    userCode: 'ABCD-EFGH',
    verificationUrl: 'https://auth.openai.com/codex/device',
    intervalMs: 8000
  }

  it('reports pending while the user has not finished authorizing (403/404)', async () => {
    const q403 = fetchQueue([new Response('', { status: 403 })])
    expect(await pollCodexDeviceAuth(pending, q403.fn)).toEqual({ status: 'pending' })
    const q404 = fetchQueue([new Response('', { status: 404 })])
    expect(await pollCodexDeviceAuth(pending, q404.fn)).toEqual({ status: 'pending' })
  })

  it('exchanges the authorization code and extracts the account id from the JWT', async () => {
    const idToken = fakeJwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acc-42' }
    })
    const { fn, calls } = fetchQueue([
      jsonResponse({ authorization_code: 'code-1', code_verifier: 'ver-1' }),
      jsonResponse({
        id_token: idToken,
        access_token: 'at-new',
        refresh_token: 'rt-new',
        expires_in: 3600
      })
    ])
    const before = Date.now()
    const result = await pollCodexDeviceAuth(pending, fn)
    if (result.status !== 'connected') throw new Error(`expected connected, got ${result.status}`)
    expect(result.tokens.accessToken).toBe('at-new')
    expect(result.tokens.refreshToken).toBe('rt-new')
    expect(result.tokens.accountId).toBe('acc-42')
    expect(result.tokens.expiresAt).toBeGreaterThanOrEqual(before + 3600_000)

    expect(calls[0].url).toBe('https://auth.openai.com/api/accounts/deviceauth/token')
    expect(calls[1].url).toBe('https://auth.openai.com/oauth/token')
    const tokenBody = String(calls[1].init?.body)
    expect(tokenBody).toContain('grant_type=authorization_code')
    expect(tokenBody).toContain('code_verifier=ver-1')
  })
})

describe('createCodexTokenSource', () => {
  const fresh: CodexTokens = {
    accessToken: 'at-fresh',
    refreshToken: 'rt-fresh',
    expiresAt: Date.now() + 60 * 60_000,
    accountId: 'acc-1'
  }
  const stale: CodexTokens = { ...fresh, accessToken: 'at-stale', expiresAt: Date.now() + 1000 }

  it('returns stored tokens directly while they are still valid', async () => {
    const { fn, calls } = fetchQueue([])
    const source = createCodexTokenSource(memoryStore(fresh), fn)
    expect(await source()).toEqual(fresh)
    expect(calls.length).toBe(0)
  })

  it('refreshes near-expiry tokens and persists the rotated refresh token', async () => {
    const store = memoryStore(stale)
    const { fn, calls } = fetchQueue([
      jsonResponse({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 })
    ])
    const source = createCodexTokenSource(store, fn)
    const tokens = await source()
    expect(tokens.accessToken).toBe('at-2')
    expect(tokens.refreshToken).toBe('rt-2')
    expect(tokens.accountId).toBe('acc-1') // kept when the new JWT has none
    expect(store.saved.at(-1)?.refreshToken).toBe('rt-2')
    expect(String(calls[0].init?.body)).toContain('grant_type=refresh_token')
  })

  it('deduplicates concurrent refreshes into a single token request', async () => {
    const store = memoryStore(stale)
    const { fn, calls } = fetchQueue([
      jsonResponse({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 })
    ])
    const source = createCodexTokenSource(store, fn)
    const [a, b] = await Promise.all([source(), source()])
    expect(a.accessToken).toBe('at-2')
    expect(b.accessToken).toBe('at-2')
    expect(calls.length).toBe(1)
  })

  it('throws a login-required error when the store is empty', async () => {
    const { fn } = fetchQueue([])
    const source = createCodexTokenSource(memoryStore(null), fn)
    expect(source()).rejects.toThrow('未登录')
  })
})

describe('parseOpencodeAuth', () => {
  it('maps an opencode oauth entry to CodexTokens', () => {
    const tokens = parseOpencodeAuth({
      openai: {
        type: 'oauth',
        access: 'at-123',
        refresh: 'rt-456',
        expires: 1770000000000,
        accountId: 'acc-789'
      }
    })
    expect(tokens).toEqual({
      accessToken: 'at-123',
      refreshToken: 'rt-456',
      expiresAt: 1770000000000,
      accountId: 'acc-789'
    })
  })

  it('returns null when the openai entry is missing', () => {
    expect(parseOpencodeAuth({})).toBeNull()
    expect(parseOpencodeAuth(null)).toBeNull()
    expect(parseOpencodeAuth('nope')).toBeNull()
  })

  it('returns null for api-key entries or entries without a refresh token', () => {
    expect(parseOpencodeAuth({ openai: { type: 'api', key: 'sk-x' } })).toBeNull()
    expect(parseOpencodeAuth({ openai: { type: 'oauth', access: 'at' } })).toBeNull()
  })

  it('tolerates missing access/expires — refresh alone is enough to connect', () => {
    const tokens = parseOpencodeAuth({
      openai: { type: 'oauth', refresh: 'rt-only' }
    })
    expect(tokens).toEqual({
      accessToken: '',
      refreshToken: 'rt-only',
      expiresAt: 0,
      accountId: null
    })
  })
})
