import { describe, it, expect } from 'bun:test'
import { PROFILES, makeModel, migrateModelId } from './providers'
import type { CredentialProvider } from './credentials'

describe('openai-codex profile', () => {
  it('is registered with a subscription (oauth) kind and a usable catalog', () => {
    const profile = PROFILES['openai-codex']
    expect(profile).toBeDefined()
    expect(profile.kind).toBe('openai-codex')
    expect(profile.models.length).toBeGreaterThan(0)
    expect(profile.models.some((m) => m.id === profile.defaultModelId)).toBe(true)
  })

  it('migrates stale stored model ids to the default', () => {
    expect(migrateModelId('openai-codex', 'gpt-4-legacy')).toBe(
      PROFILES['openai-codex'].defaultModelId
    )
    expect(migrateModelId('openai-codex', PROFILES['openai-codex'].defaultModelId)).toBeNull()
  })
})

describe('makeModel openai-codex', () => {
  it('builds a responses-API model backed by subscription tokens', async () => {
    const credentials: CredentialProvider = {
      getKey: async () => null,
      getCodexTokens: async () => ({
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: Date.now() + 3_600_000,
        accountId: null
      })
    }
    const model = await makeModel('openai-codex', 'gpt-5.5', credentials)
    expect(typeof model).not.toBe('string')
    if (typeof model !== 'string') expect(model.modelId).toBe('gpt-5.5')
  })

  it('rejects hosts that cannot supply subscription tokens', async () => {
    const credentials: CredentialProvider = { getKey: async () => 'sk-ignored' }
    expect(makeModel('openai-codex', 'gpt-5.5', credentials)).rejects.toThrow('登录')
  })
})
