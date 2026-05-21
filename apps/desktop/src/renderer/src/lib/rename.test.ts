import { describe, expect, it } from 'bun:test'
import { validateRenameTarget } from './rename'

describe('validateRenameTarget', () => {
  it('rejects empty name', () => {
    const r = validateRenameTarget('/work/notes/x.md', '')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/空/)
  })

  it('rejects whitespace-only name', () => {
    const r = validateRenameTarget('/work/notes/x.md', '   ')
    expect(r.ok).toBe(false)
  })

  it('rejects names containing forward slash', () => {
    const r = validateRenameTarget('/work/notes/x.md', 'foo/bar.md')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/[\\/]/)
  })

  it('rejects names containing backslash', () => {
    const r = validateRenameTarget('/work/notes/x.md', 'foo\\bar.md')
    expect(r.ok).toBe(false)
  })

  it('keeps the directory and replaces the file segment', () => {
    const r = validateRenameTarget('/work/notes/x.md', 'design-doc.md')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.newPath).toBe('/work/notes/design-doc.md')
      expect(r.newName).toBe('design-doc.md')
    }
  })

  it('auto-appends the current extension when name has none', () => {
    const r = validateRenameTarget('/work/notes/x.md', 'design-doc')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.newName).toBe('design-doc.md')
  })

  it('respects an explicit extension different from current', () => {
    const r = validateRenameTarget('/work/notes/x.md', 'design-doc.markdown')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.newName).toBe('design-doc.markdown')
  })

  it('trims surrounding whitespace before validation', () => {
    const r = validateRenameTarget('/work/notes/x.md', '  design  ')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.newName).toBe('design.md')
  })

  it('returns ok with identical newPath when name is unchanged', () => {
    const r = validateRenameTarget('/work/notes/x.md', 'x.md')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.newPath).toBe('/work/notes/x.md')
  })

  it('works on Windows-style paths', () => {
    const r = validateRenameTarget('C:\\work\\notes\\x.md', 'design.md')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.newPath).toBe('C:\\work\\notes\\design.md')
  })

  it('defaults to .md when current path has no extension', () => {
    const r = validateRenameTarget('/work/notes/x', 'design')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.newName).toBe('design.md')
  })
})
