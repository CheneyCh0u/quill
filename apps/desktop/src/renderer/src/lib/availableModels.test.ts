import { describe, expect, it } from 'bun:test'
import { buildAvailableModels, parseModelChoice, serializeModelChoice } from './availableModels'

const configured = [{ id: 'kimi', model: 'kimi-k2.5', addedAt: 1, updatedAt: 1 }]

describe('buildAvailableModels', () => {
  it('returns one entry per (provider, model) pair when the provider has multiple catalog models', () => {
    // Even though the user only set up Kimi with kimi-k2.5, all 4 Kimi
    // models become selectable — having an API key for a provider grants
    // access to all of its models.
    const result = buildAvailableModels(configured)
    expect(result.length).toBe(4)
    const ids = result.map((r) => r.modelId).sort()
    expect(ids).toEqual(['k2p5', 'k2p6', 'kimi-k2-thinking', 'kimi-k2.5'])
    for (const r of result) {
      expect(r.providerId).toBe('kimi')
      expect(r.providerName).toBe('Kimi (Coding Plan)')
      expect(r.contextTokens).toBe(262_144)
    }
  })

  it('returns empty list when no providers configured', () => {
    expect(buildAvailableModels([])).toEqual([])
  })

  it('skips configured providers that no longer exist in the catalog', () => {
    // Defensive: an obsolete provider id (removed from PROVIDERS) should not
    // produce a phantom entry.
    const result = buildAvailableModels([
      { id: 'kimi', model: 'kimi-k2.5', addedAt: 1, updatedAt: 1 },
      { id: 'phantom', model: 'x', addedAt: 1, updatedAt: 1 }
    ])
    expect(result.every((r) => r.providerId === 'kimi')).toBe(true)
  })

  it('skips providers whose catalog is currently empty', () => {
    // Anthropic / OpenAI / etc. are in PROVIDERS but with models: [] in PR1.
    // A stored config for one of these should produce no entries.
    const result = buildAvailableModels([
      { id: 'anthropic', model: 'claude-x', addedAt: 1, updatedAt: 1 }
    ])
    expect(result).toEqual([])
  })
})

describe('serializeModelChoice / parseModelChoice', () => {
  it('roundtrips a basic provider/model pair', () => {
    const s = serializeModelChoice({ providerId: 'kimi', modelId: 'kimi-k2.5' })
    expect(s).toBe('kimi/kimi-k2.5')
    expect(parseModelChoice(s)).toEqual({ providerId: 'kimi', modelId: 'kimi-k2.5' })
  })

  it('roundtrips model ids that contain a slash', () => {
    // Some providers nest model namespaces (e.g. anthropic/claude-3-5-sonnet
    // on Bedrock). Only the first slash should split provider from model.
    const s = serializeModelChoice({
      providerId: 'bedrock',
      modelId: 'anthropic/claude-3-5-sonnet'
    })
    expect(parseModelChoice(s)).toEqual({
      providerId: 'bedrock',
      modelId: 'anthropic/claude-3-5-sonnet'
    })
  })

  it('returns null on malformed input', () => {
    expect(parseModelChoice('')).toBeNull()
    expect(parseModelChoice('justaprovider')).toBeNull()
    expect(parseModelChoice('/missing-provider')).toBeNull()
    expect(parseModelChoice('provider/')).toBeNull()
  })
})
