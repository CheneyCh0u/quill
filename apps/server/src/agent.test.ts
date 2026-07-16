import { describe, it, expect } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { createAgentRoutes } from './agent'
import { ProvidersStore } from './providers-store'
import { signSession } from './auth'

const SECRET = 'test-secret'

async function makeApp() {
  const dir = mkdtempSync(join(tmpdir(), 'quill-agent-test-'))
  const store = new ProvidersStore(join(dir, 'providers.json'))
  await store.load()
  const { app } = createAgentRoutes({
    store,
    sessionSecret: SECRET,
    vaultRoot: dir
  })
  const token = await signSession(SECRET, 1)
  const auth = { Authorization: `Bearer ${token}` }
  return { app, auth }
}

describe('GET /catalog', () => {
  it('excludes desktop-only oauth providers (openai-codex)', async () => {
    const { app, auth } = await makeApp()
    const res = await app.request('/catalog', { headers: auth })
    expect(res.status).toBe(200)
    const catalog = (await res.json()) as Array<{ id: string }>
    expect(catalog.length).toBeGreaterThan(0)
    expect(catalog.some((p) => p.id === 'openai-codex')).toBe(false)
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
