/// <reference types="bun" />
import { describe, it, expect } from 'bun:test'
import { parseThemeJson } from './themeSchema'

const validTokens = {
  paper: '#ffffff',
  paperDim: '#f4f4f4',
  paperSoft: '#eaeaea',
  paperEdge: '#dcdcdc',
  ink: '#111111',
  inkSoft: '#333333',
  inkFaint: '#666666',
  inkGhost: '#999999',
  rule: '#cccccc',
  ruleSoft: '#e2e2e2',
  accent: 'oklch(0.6 0.15 30)',
  accentSoft: '#f4d8c0'
}

describe('parseThemeJson', () => {
  it('accepts a complete theme JSON', () => {
    const result = parseThemeJson({
      id: 'sepia',
      name: 'Sepia',
      light: validTokens,
      dark: validTokens
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.theme.id).toBe('sepia')
      expect(result.theme.name).toBe('Sepia')
      expect(result.theme.builtin).toBe(false)
      expect(result.theme.light.paper).toBe('#ffffff')
    }
  })

  it('rejects empty id', () => {
    const r = parseThemeJson({ id: '', name: 'x', light: validTokens, dark: validTokens })
    expect(r.ok).toBe(false)
  })

  it('rejects id with disallowed characters', () => {
    // Restrictive on purpose — `id` becomes part of the file name and the
    // CSS data-theme attribute; allowing spaces / slashes would break both.
    for (const id of ['has space', 'has/slash', 'has.dot', 'CapsButThenSpace ']) {
      const r = parseThemeJson({ id, name: 'x', light: validTokens, dark: validTokens })
      expect(r.ok).toBe(false)
    }
  })

  it('accepts hyphen-separated and lowercase / mixed-case ids', () => {
    for (const id of ['sepia', 'my-theme', 'cool_mono', 'Theme1', 'a1']) {
      const r = parseThemeJson({ id, name: 'X', light: validTokens, dark: validTokens })
      expect(r.ok).toBe(true)
    }
  })

  it('rejects when a token is missing', () => {
    const incomplete = { ...validTokens } as Partial<typeof validTokens>
    delete incomplete.accent
    const r = parseThemeJson({
      id: 'broken',
      name: 'Broken',
      light: incomplete,
      dark: validTokens
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/accent|light/i)
  })

  it('rejects when a token is the wrong type', () => {
    const bad = { ...validTokens, accent: 12345 as unknown as string }
    const r = parseThemeJson({ id: 'wrong', name: 'X', light: bad, dark: validTokens })
    expect(r.ok).toBe(false)
  })

  it('rejects non-object input', () => {
    for (const raw of [null, undefined, 'string', 42, []]) {
      const r = parseThemeJson(raw)
      expect(r.ok).toBe(false)
    }
  })

  it('keeps extra unknown fields out of the resulting Theme', () => {
    // Forward-compatibility: a future schema might add `density`. v1 should
    // ignore unknown fields rather than reject the whole file.
    const r = parseThemeJson({
      id: 'sepia',
      name: 'Sepia',
      light: { ...validTokens, ghostly: 'whatever' },
      dark: validTokens,
      futureField: 'ignored'
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect((r.theme as unknown as { futureField?: unknown }).futureField).toBeUndefined()
      expect((r.theme.light as unknown as { ghostly?: unknown }).ghostly).toBeUndefined()
    }
  })
})
