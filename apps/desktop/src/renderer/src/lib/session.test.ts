import { describe, expect, it } from 'bun:test'
import { parseLastSession } from './session'

describe('parseLastSession', () => {
  it('accepts a folder session', () => {
    const raw = JSON.stringify({ type: 'folder', path: '/Users/me/notes' })
    expect(parseLastSession(raw)).toEqual({ type: 'folder', path: '/Users/me/notes' })
  })

  it('accepts a file session', () => {
    const raw = JSON.stringify({ type: 'file', path: '/Users/me/a.md' })
    expect(parseLastSession(raw)).toEqual({ type: 'file', path: '/Users/me/a.md' })
  })

  it('returns null for missing value', () => {
    expect(parseLastSession(null)).toBeNull()
  })

  it('returns null for malformed JSON', () => {
    expect(parseLastSession('{oops')).toBeNull()
  })

  it('returns null for unknown type or empty path', () => {
    expect(parseLastSession(JSON.stringify({ type: 'remote', path: '/x' }))).toBeNull()
    expect(parseLastSession(JSON.stringify({ type: 'folder', path: '' }))).toBeNull()
    expect(parseLastSession(JSON.stringify({ type: 'folder' }))).toBeNull()
  })
})
