/// <reference types="bun" />
import { describe, it, expect } from 'bun:test'
import { composeThemeAttribute, parseThemeAttribute } from './themeAttribute'

describe('composeThemeAttribute', () => {
  it('joins themeId and mode with a hyphen', () => {
    expect(composeThemeAttribute('claude', 'light')).toBe('claude-light')
    expect(composeThemeAttribute('ocean', 'dark')).toBe('ocean-dark')
    expect(composeThemeAttribute('solarized', 'light')).toBe('solarized-light')
  })

  it('preserves hyphens inside custom theme ids', () => {
    // Custom themes are file-named; users will pick names like `my-theme`
    // or `cool-mono`. The attribute parser has to find the *last* hyphen
    // to split mode off, not the first.
    expect(composeThemeAttribute('my-theme', 'light')).toBe('my-theme-light')
    expect(composeThemeAttribute('cool-mono', 'dark')).toBe('cool-mono-dark')
  })
})

describe('parseThemeAttribute', () => {
  it('splits attribute into themeId + mode', () => {
    expect(parseThemeAttribute('claude-light')).toEqual({ themeId: 'claude', mode: 'light' })
    expect(parseThemeAttribute('ocean-dark')).toEqual({ themeId: 'ocean', mode: 'dark' })
  })

  it('splits on the LAST hyphen so multi-word ids survive', () => {
    expect(parseThemeAttribute('my-theme-light')).toEqual({ themeId: 'my-theme', mode: 'light' })
    expect(parseThemeAttribute('cool-mono-dark')).toEqual({ themeId: 'cool-mono', mode: 'dark' })
  })

  it('rejects malformed values', () => {
    // Used by the renderer to validate values it reads from storage —
    // an unrecognised string should fall back to default, not crash.
    expect(parseThemeAttribute('')).toBeNull()
    expect(parseThemeAttribute('claude')).toBeNull()
    expect(parseThemeAttribute('claude-unknown')).toBeNull()
    expect(parseThemeAttribute('claude-')).toBeNull()
    expect(parseThemeAttribute('-light')).toBeNull()
  })
})
