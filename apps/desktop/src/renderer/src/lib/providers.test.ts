import { describe, expect, it } from 'bun:test'
import {
  PROVIDERS,
  getProviderProfile,
  isKnownProvider,
  validateProviderConfig
} from './providers'

describe('PROVIDERS registry', () => {
  it('contains the 6 built-in providers', () => {
    const ids = PROVIDERS.map((p) => p.id).sort()
    expect(ids).toEqual(['anthropic', 'deepseek', 'glm', 'kimi', 'openai', 'qwen'])
  })

  it('every provider has baseURL and defaultModel', () => {
    for (const p of PROVIDERS) {
      expect(p.baseURL.length).toBeGreaterThan(0)
      expect(p.defaultModel.length).toBeGreaterThan(0)
      expect(p.name.length).toBeGreaterThan(0)
    }
  })

  it('every baseURL starts with https://', () => {
    for (const p of PROVIDERS) {
      expect(p.baseURL.startsWith('https://')).toBe(true)
    }
  })
})

describe('getProviderProfile', () => {
  it('returns the profile for a known id', () => {
    const kimi = getProviderProfile('kimi')
    expect(kimi).toBeDefined()
    expect(kimi?.baseURL).toBe('https://api.kimi.com/coding/v1')
    expect(kimi?.defaultModel).toBe('kimi-for-coding')
    expect(kimi?.kind).toBe('anthropic')
  })

  it('returns undefined for unknown id', () => {
    expect(getProviderProfile('not-a-provider')).toBeUndefined()
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

describe('validateProviderConfig', () => {
  it('rejects unknown provider id', () => {
    const r = validateProviderConfig({ id: 'foo', key: 'k', model: 'm' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/未知/)
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

  it('rejects empty model', () => {
    const r = validateProviderConfig({ id: 'kimi', key: 'sk-x', model: '' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/[Mm]odel|模型/)
  })

  it('rejects whitespace-only model', () => {
    const r = validateProviderConfig({ id: 'kimi', key: 'sk-x', model: '   ' })
    expect(r.ok).toBe(false)
  })

  it('returns trimmed config on success', () => {
    const r = validateProviderConfig({
      id: 'kimi',
      key: '  sk-secret  ',
      model: '  kimi-k2.5  '
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.config).toEqual({
        id: 'kimi',
        key: 'sk-secret',
        model: 'kimi-k2.5'
      })
    }
  })
})
