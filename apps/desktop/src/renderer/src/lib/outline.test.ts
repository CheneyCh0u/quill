/// <reference types="bun" />
import { describe, it, expect } from 'bun:test'
import { parseOutline, slugify } from './outline'

describe('parseOutline', () => {
  it('returns [] for an empty document', () => {
    expect(parseOutline('')).toEqual([])
  })

  it('returns [] for a doc with no headings', () => {
    expect(parseOutline('just a paragraph\n\nand another')).toEqual([])
  })

  it('extracts a single H1', () => {
    expect(parseOutline('# Hello')).toEqual([
      { level: 1, text: 'Hello', slug: 'hello', line: 0 }
    ])
  })

  it('extracts H1 through H6 in document order with correct levels', () => {
    const src = [
      '# H1',
      '## H2',
      '### H3',
      '#### H4',
      '##### H5',
      '###### H6'
    ].join('\n')
    const out = parseOutline(src)
    expect(out.map((i) => i.level)).toEqual([1, 2, 3, 4, 5, 6])
    expect(out.map((i) => i.text)).toEqual(['H1', 'H2', 'H3', 'H4', 'H5', 'H6'])
  })

  it('reports 0-indexed source line numbers', () => {
    const src = ['# top', '', 'body', '', '## sub'].join('\n')
    const out = parseOutline(src)
    expect(out.map((i) => i.line)).toEqual([0, 4])
  })

  it('skips # inside fenced code blocks', () => {
    const src = [
      '# Real heading',
      '',
      '```bash',
      '# this is a shell comment, not a heading',
      'echo hi',
      '```',
      '',
      '## Another real one'
    ].join('\n')
    const out = parseOutline(src)
    expect(out.map((i) => i.text)).toEqual(['Real heading', 'Another real one'])
  })

  it('disambiguates duplicate headings with -1, -2 suffixes', () => {
    const src = ['# Foo', '## Foo', '### Foo'].join('\n')
    const out = parseOutline(src)
    expect(out.map((i) => i.slug)).toEqual(['foo', 'foo-1', 'foo-2'])
  })

  it('strips inline formatting from heading text and slug', () => {
    const src = '## **Bold** and `code` and *em*'
    const out = parseOutline(src)
    expect(out).toEqual([
      {
        level: 2,
        text: 'Bold and code and em',
        slug: 'bold-and-code-and-em',
        line: 0
      }
    ])
  })

  it('supports CJK characters in slug', () => {
    const src = '# 第一章 概述'
    const out = parseOutline(src)
    expect(out).toEqual([
      { level: 1, text: '第一章 概述', slug: '第一章-概述', line: 0 }
    ])
  })

  it('falls back to a positional slug if heading text yields empty slug', () => {
    // Punctuation-only heading would slugify to empty string
    const src = '# !!!'
    const out = parseOutline(src)
    expect(out[0].slug).toBe('heading-0')
  })
})

describe('slugify', () => {
  it('lowercases ASCII and joins words with dashes', () => {
    expect(slugify('Hello World')).toBe('hello-world')
  })

  it('drops punctuation', () => {
    expect(slugify('What?! Now.')).toBe('what-now')
  })

  it('preserves CJK', () => {
    expect(slugify('第一章')).toBe('第一章')
  })

  it('returns empty string for punctuation-only input', () => {
    expect(slugify('!!!')).toBe('')
  })
})
