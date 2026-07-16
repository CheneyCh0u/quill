import { describe, expect, it } from 'bun:test'
import {
  PROVIDERS,
  getProviderProfile,
  getProviderModel,
  isKnownProvider,
  isConfigurableProvider,
  validateProviderConfig
} from './providers'

describe('PROVIDERS registry', () => {
  it('contains the 7 built-in providers', () => {
    const ids = PROVIDERS.map((p) => p.id).sort()
    expect(ids).toEqual([
      'anthropic',
      'deepseek',
      'glm',
      'kimi',
      'openai',
      'openai-codex',
      'qwen'
    ])
  })

  it('every provider has baseURL, name, and models[] (possibly empty)', () => {
    for (const p of PROVIDERS) {
      expect(p.baseURL.length).toBeGreaterThan(0)
      expect(p.name.length).toBeGreaterThan(0)
      expect(Array.isArray(p.models)).toBe(true)
    }
  })

  it('every baseURL starts with https://', () => {
    for (const p of PROVIDERS) {
      expect(p.baseURL.startsWith('https://')).toBe(true)
    }
  })

  it('a provider with non-empty models has a defaultModelId pointing to one of them', () => {
    for (const p of PROVIDERS) {
      if (p.models.length === 0) continue
      const found = p.models.find((m) => m.id === p.defaultModelId)
      expect(found).toBeDefined()
    }
  })

  it('every model has a positive contextTokens', () => {
    for (const p of PROVIDERS) {
      for (const m of p.models) {
        expect(typeof m.id).toBe('string')
        expect(m.id.length).toBeGreaterThan(0)
        expect(typeof m.contextTokens).toBe('number')
        expect(m.contextTokens).toBeGreaterThan(0)
      }
    }
  })
})

describe('Kimi (the only provider with models this round)', () => {
  it('exposes 4 models all at 262K context', () => {
    const kimi = getProviderProfile('kimi')!
    expect(kimi.models.length).toBe(4)
    const ids = kimi.models.map((m) => m.id)
    expect(ids).toContain('kimi-k2-thinking')
    expect(ids).toContain('k2p6')
    expect(ids).toContain('k2p5')
    expect(ids).toContain('kimi-k2.5')
    for (const m of kimi.models) {
      expect(m.contextTokens).toBe(262_144)
    }
  })

  it('default model is one of the 4', () => {
    const kimi = getProviderProfile('kimi')!
    expect(kimi.models.some((m) => m.id === kimi.defaultModelId)).toBe(true)
  })
})

describe('other providers temporarily have empty models[]', () => {
  it('anthropic / openai / deepseek / glm / qwen have models: []', () => {
    for (const id of ['anthropic', 'openai', 'deepseek', 'glm', 'qwen'] as const) {
      const p = getProviderProfile(id)!
      expect(p.models.length).toBe(0)
    }
  })
})

describe('isConfigurableProvider', () => {
  it('true for providers with at least one model', () => {
    expect(isConfigurableProvider('kimi')).toBe(true)
  })
  it('false for providers with empty models[]', () => {
    expect(isConfigurableProvider('anthropic')).toBe(false)
    expect(isConfigurableProvider('openai')).toBe(false)
  })
  it('false for unknown providers', () => {
    expect(isConfigurableProvider('foo')).toBe(false)
  })
})

describe('getProviderModel', () => {
  it('returns the model when id matches', () => {
    const m = getProviderModel('kimi', 'kimi-k2.5')
    expect(m?.id).toBe('kimi-k2.5')
    expect(m?.contextTokens).toBe(262_144)
  })
  it('returns undefined for unknown model id', () => {
    expect(getProviderModel('kimi', 'no-such-model')).toBeUndefined()
  })
  it('returns undefined for unknown provider', () => {
    expect(getProviderModel('nope', 'kimi-k2.5')).toBeUndefined()
  })
})

describe('isKnownProvider', () => {
  it('returns true for known ids', () => {
    expect(isKnownProvider('kimi')).toBe(true)
    expect(isKnownProvider('anthropic')).toBe(true)
  })
  it('returns false for unknown ids', () => {
    expect(isKnownProvider('foo')).toBe(false)
    expect(isKnownProvider('')).toBe(false)
  })
})

describe('openai-codex (ChatGPT subscription)', () => {
  it('is an oauth provider with a usable model catalog', () => {
    const codex = getProviderProfile('openai-codex')!
    expect(codex.auth).toBe('oauth')
    expect(codex.kind).toBe('openai-codex')
    expect(codex.models.length).toBeGreaterThan(0)
    expect(codex.models.some((m) => m.id === codex.defaultModelId)).toBe(true)
  })

  it('is rejected by the api-key validator — it configures via login instead', () => {
    const r = validateProviderConfig({ id: 'openai-codex', key: 'sk-x', model: 'gpt-5.5' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/登录/)
  })
})

describe('validateProviderConfig', () => {
  it('rejects unknown provider id', () => {
    const r = validateProviderConfig({ id: 'foo', key: 'k', model: 'm' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/未知|unknown/i)
  })

  it('rejects providers with no models configured yet', () => {
    const r = validateProviderConfig({ id: 'anthropic', key: 'sk-x', model: 'whatever' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/no models|未配置/i)
  })

  it('rejects empty key', () => {
    const r = validateProviderConfig({ id: 'kimi', key: '', model: 'kimi-k2.5' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/Key/)
  })

  it('rejects whitespace-only key', () => {
    const r = validateProviderConfig({ id: 'kimi', key: '   ', model: 'kimi-k2.5' })
    expect(r.ok).toBe(false)
  })

  it('rejects model not in provider models[]', () => {
    const r = validateProviderConfig({
      id: 'kimi',
      key: 'sk-x',
      model: 'kimi-for-coding'
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/not in|无效|model/i)
  })

  it('accepts a model present in provider.models', () => {
    const r = validateProviderConfig({
      id: 'kimi',
      key: 'sk-secret',
      model: 'kimi-k2.5'
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.config.model).toBe('kimi-k2.5')
  })

  it('returns trimmed key + model on success', () => {
    const r = validateProviderConfig({
      id: 'kimi',
      key: '  sk-secret  ',
      model: '  kimi-k2.5  '
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.config).toEqual({ id: 'kimi', key: 'sk-secret', model: 'kimi-k2.5' })
    }
  })
})
