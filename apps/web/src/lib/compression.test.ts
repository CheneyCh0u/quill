import { describe, expect, test } from 'bun:test'
import { shouldCompress } from './compression'

describe('shouldCompress', () => {
  test('returns false when usage is missing', () => {
    expect(shouldCompress(undefined, 100_000)).toBe(false)
  })

  test('returns false when contextTokens is zero', () => {
    expect(shouldCompress({ input: 99_999, output: 99_999, total: 199_998 }, 0)).toBe(false)
  })

  test('returns false when negative contextTokens (defensive)', () => {
    expect(shouldCompress({ input: 100, output: 100, total: 200 }, -1)).toBe(false)
  })

  test('returns false when well below threshold', () => {
    // 1K + 1K = 2K, threshold 0.85 of 262K = 222K — way under.
    expect(shouldCompress({ input: 1000, output: 1000, total: 2000 }, 262_144)).toBe(false)
  })

  test('returns true when at threshold', () => {
    // input+output = 0.9 * 262144 = ~236K, comfortably past 0.85 * 262K.
    expect(
      shouldCompress({ input: 120_000, output: 116_000, total: 236_000 }, 262_144)
    ).toBe(true)
  })

  test('respects custom threshold', () => {
    const usage = { input: 50_000, output: 50_000, total: 100_000 }
    // 100K vs 262K = 38%; threshold 0.5 means trigger at 131K, NOT yet.
    expect(shouldCompress(usage, 262_144, 0.5)).toBe(false)
    // threshold 0.3 = 78K, NOW it triggers.
    expect(shouldCompress(usage, 262_144, 0.3)).toBe(true)
  })

  test('ignores invalid threshold values', () => {
    expect(shouldCompress({ input: 1000, output: 1000, total: 2000 }, 1000, 0)).toBe(
      false
    )
    expect(shouldCompress({ input: 1000, output: 1000, total: 2000 }, 1000, 1.5)).toBe(
      false
    )
  })
})
