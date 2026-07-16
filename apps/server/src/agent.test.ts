import { describe, it, expect } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { createAgentRoutes } from './agent'
import { ProvidersStore } from './providers-store'
import { ServerCodexStore } from './codex-store'
import { signSession } from './auth'

const SECRET = 'test-secret'

function fakeJwt(payload: Record<string, unknown>): string {
  return `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

/** Pops one queued response per outbound OAuth request. */
function fetchQueue(responses: Response[]) {
  return async (): Promise<Response> => {
    const next = responses.shift()
    if (!next) throw new Error('fetchQueue exhausted')
    return next
  }
}

async function makeApp(opts?: { codex?: boolean; oauthResponses?: Response[] }) {
  const dir = mkdtempSync(join(tmpdir(), 'quill-agent-test-'))
  const store = new ProvidersStore(join(dir, 'providers.json'))
  await store.load()
  const codexStore = opts?.codex
    ? new ServerCodexStore(join(dir, 'codex-auth.json'))
    : undefined
  const { app } = createAgentRoutes({
    store,
    sessionSecret: SECRET,
    vaultRoot: dir,
    codexStore,
    codexFetch: opts?.oauthResponses ? fetchQueue(opts.oauthResponses) : undefined
  })
  const token = await signSession(SECRET, 1)
  const auth = { Authorization: `Bearer ${token}` }
  return { app, auth }
}

describe('GET /catalog', () => {
  it('excludes openai-codex when the host has no codex store', async () => {
    const { app, auth } = await makeApp()
    const res = await app.request('/catalog', { headers: auth })
    expect(res.status).toBe(200)
    const catalog = (await res.json()) as Array<{ id: string }>
    expect(catalog.length).toBeGreaterThan(0)
    expect(catalog.some((p) => p.id === 'openai-codex')).toBe(false)
  })

  it('includes openai-codex (kind openai-codex) when subscription login is enabled', async () => {
    const { app, auth } = await makeApp({ codex: true })
    const res = await app.request('/catalog', { headers: auth })
    const catalog = (await res.json()) as Array<{ id: string; kind: string }>
    const codex = catalog.find((p) => p.id === 'openai-codex')
    expect(codex).toBeDefined()
    expect(codex!.kind).toBe('openai-codex')
  })
})

describe('codex login lifecycle', () => {
  const loginResponses = (): Response[] => [
    jsonResponse({ device_auth_id: 'dev-1', user_code: 'ABCD-EFGH', interval: '5' }),
    new Response('', { status: 403 }), // first poll: user hasn't authorized yet
    jsonResponse({ authorization_code: 'code-1', code_verifier: 'ver-1' }),
    jsonResponse({
      id_token: fakeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-42' } }),
      access_token: 'at-1',
      refresh_token: 'rt-1',
      expires_in: 3600
    })
  ]

  it('walks start → pending → connected and then reports status + providers entry', async () => {
    const { app, auth } = await makeApp({ codex: true, oauthResponses: loginResponses() })

    const before = await app.request('/codex', { headers: auth })
    expect(((await before.json()) as { connected: boolean }).connected).toBe(false)

    const start = await app.request('/codex/login/start', { method: 'POST', headers: auth })
    expect(start.status).toBe(200)
    const pending = (await start.json()) as { userCode: string; verificationUrl: string }
    expect(pending.userCode).toBe('ABCD-EFGH')
    expect(pending.verificationUrl).toContain('auth.openai.com')

    const poll1 = await app.request('/codex/login/poll', { method: 'POST', headers: auth })
    expect(((await poll1.json()) as { status: string }).status).toBe('pending')

    const poll2 = await app.request('/codex/login/poll', { method: 'POST', headers: auth })
    const done = (await poll2.json()) as { status: string; accountId: string | null }
    expect(done.status).toBe('connected')
    expect(done.accountId).toBe('acc-42')

    const status = await app.request('/codex', { headers: auth })
    const s = (await status.json()) as { connected: boolean; model: string }
    expect(s.connected).toBe(true)
    expect(s.model.length).toBeGreaterThan(0) // defaulted on connect

    const providers = await app.request('/providers', { headers: auth })
    const list = (await providers.json()) as Array<{ id: string; models: string[] }>
    const codex = list.find((p) => p.id === 'openai-codex')
    expect(codex).toBeDefined()
    expect(codex!.models[0]).toBe(s.model)
  })

  it('rejects polling without a started flow', async () => {
    const { app, auth } = await makeApp({ codex: true })
    const res = await app.request('/codex/login/poll', { method: 'POST', headers: auth })
    expect(res.status).toBe(400)
  })

  it('updates the model when it is in the catalog and rejects unknown ids', async () => {
    const { app, auth } = await makeApp({ codex: true, oauthResponses: loginResponses() })
    await app.request('/codex/login/start', { method: 'POST', headers: auth })
    await app.request('/codex/login/poll', { method: 'POST', headers: auth })
    await app.request('/codex/login/poll', { method: 'POST', headers: auth })

    const ok = await app.request('/codex/model', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-terra' })
    })
    expect(ok.status).toBe(200)
    const s = (await (await app.request('/codex', { headers: auth })).json()) as {
      model: string
    }
    expect(s.model).toBe('gpt-5.6-terra')

    const bad = await app.request('/codex/model', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-9000' })
    })
    expect(bad.status).toBe(400)
  })

  it('logout disconnects and removes the providers entry', async () => {
    const { app, auth } = await makeApp({ codex: true, oauthResponses: loginResponses() })
    await app.request('/codex/login/start', { method: 'POST', headers: auth })
    await app.request('/codex/login/poll', { method: 'POST', headers: auth })
    await app.request('/codex/login/poll', { method: 'POST', headers: auth })

    const res = await app.request('/codex', { method: 'DELETE', headers: auth })
    expect(res.status).toBe(200)
    const s = (await (await app.request('/codex', { headers: auth })).json()) as {
      connected: boolean
    }
    expect(s.connected).toBe(false)
    const list = (await (await app.request('/providers', { headers: auth })).json()) as Array<{
      id: string
    }>
    expect(list.some((p) => p.id === 'openai-codex')).toBe(false)
  })

  it('returns 501 for codex routes when the host has no codex store', async () => {
    const { app, auth } = await makeApp()
    const res = await app.request('/codex', { headers: auth })
    expect(res.status).toBe(501)
  })
})

describe('POST /providers', () => {
  it('rejects configuring oauth providers via api key', async () => {
    const { app, auth } = await makeApp()
    const res = await app.request('/providers', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'openai-codex', api_key: 'sk-x', model: 'gpt-5.5' })
    })
    expect(res.status).toBe(400)
  })
})
