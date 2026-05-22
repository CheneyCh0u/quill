import { describe, expect, it } from 'bun:test'
import { coerceUsage, sumUsage, formatTokens } from './usage'

describe('coerceUsage', () => {
  it('returns undefined for non-object input', () => {
    expect(coerceUsage(undefined)).toBeUndefined()
    expect(coerceUsage(null)).toBeUndefined()
    expect(coerceUsage('nope')).toBeUndefined()
    expect(coerceUsage(42)).toBeUndefined()
  })

  it('reads canonical AI SDK v6 fields (inputTokens / outputTokens / totalTokens)', () => {
    const u = coerceUsage({ inputTokens: 120, outputTokens: 80, totalTokens: 200 })
    expect(u).toEqual({ input: 120, output: 80, total: 200 })
  })

  it('falls back to promptTokens / completionTokens (older SDK shape)', () => {
    const u = coerceUsage({ promptTokens: 50, completionTokens: 30 })
    expect(u).toEqual({ input: 50, output: 30, total: 80 })
  })

  it('computes total when only input/output present', () => {
    const u = coerceUsage({ inputTokens: 10, outputTokens: 5 })
    expect(u?.total).toBe(15)
  })

  it('treats missing fields as zero', () => {
    const u = coerceUsage({ inputTokens: 10 })
    expect(u).toEqual({ input: 10, output: 0, total: 10 })
  })

  it('returns undefined when no recognizable token fields exist', () => {
    expect(coerceUsage({ irrelevant: 1 })).toBeUndefined()
    expect(coerceUsage({})).toBeUndefined()
  })

  it('tolerates non-number values (NaN / string) and skips them', () => {
    const u = coerceUsage({ inputTokens: 'oops', outputTokens: 7 })
    expect(u).toEqual({ input: 0, output: 7, total: 7 })
  })
})

describe('sumUsage', () => {
  it('returns zeros for empty input', () => {
    expect(sumUsage([])).toEqual({ input: 0, output: 0, total: 0 })
  })

  it('sums multiple usage snapshots', () => {
    const total = sumUsage([
      { input: 100, output: 50, total: 150 },
      { input: 30, output: 20, total: 50 }
    ])
    expect(total).toEqual({ input: 130, output: 70, total: 200 })
  })

  it('skips undefined entries silently', () => {
    const total = sumUsage([
      { input: 10, output: 10, total: 20 },
      undefined,
      { input: 5, output: 5, total: 10 }
    ])
    expect(total).toEqual({ input: 15, output: 15, total: 30 })
  })
})

describe('formatTokens', () => {
  it('formats small counts with no thousands separator', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(42)).toBe('42')
    expect(formatTokens(999)).toBe('999')
  })

  it('inserts commas at thousands', () => {
    expect(formatTokens(1234)).toBe('1,234')
    expect(formatTokens(1_000_000)).toBe('1,000,000')
  })
})
