import { describe, expect, test } from 'bun:test'
import { buildOutline, slugify } from './outline'

describe('slugify', () => {
  test('lowercases and dashes spaces', () => {
    expect(slugify('Hello World')).toBe('hello-world')
  })
  test('strips punctuation', () => {
    expect(slugify('Foo, Bar! Baz?')).toBe('foo-bar-baz')
  })
  test('keeps CJK', () => {
    expect(slugify('章节一')).toBe('章节一')
  })
  test('keeps mixed CJK + latin', () => {
    expect(slugify('Section 简介')).toBe('section-简介')
  })
  test('collapses consecutive dashes', () => {
    expect(slugify('a -- b -- c')).toBe('a-b-c')
  })
  test('trims surrounding dashes', () => {
    expect(slugify('-- hi --')).toBe('hi')
  })
  test('drops markdown decorators', () => {
    expect(slugify('**bold** and `code`')).toBe('bold-and-code')
  })
})

describe('buildOutline', () => {
  test('returns flat list of headings with level + text + slug', () => {
    const md = `# Top\n\nintro\n\n## Section A\n\ntext\n\n### Detail\n\nmore\n\n## Section B`
    expect(buildOutline(md)).toEqual([
      { level: 1, text: 'Top', slug: 'top' },
      { level: 2, text: 'Section A', slug: 'section-a' },
      { level: 3, text: 'Detail', slug: 'detail' },
      { level: 2, text: 'Section B', slug: 'section-b' }
    ])
  })

  test('disambiguates duplicate slugs with -2 / -3', () => {
    const md = `## Notes\n\n## Notes\n\n## Notes`
    expect(buildOutline(md).map((n) => n.slug)).toEqual([
      'notes',
      'notes-2',
      'notes-3'
    ])
  })

  test('handles markdown formatting inside headings', () => {
    const md = `## **Bold** _italic_ \`code\``
    const out = buildOutline(md)
    expect(out).toHaveLength(1)
    expect(out[0].text).toBe('**Bold** _italic_ `code`')
    expect(out[0].slug).toBe('bold-italic-code')
  })

  test('skips empty / whitespace-only headings', () => {
    const md = `# Real\n\n##   \n\n## Other`
    expect(buildOutline(md).map((n) => n.text)).toEqual(['Real', 'Other'])
  })

  test('empty source → empty list', () => {
    expect(buildOutline('')).toEqual([])
  })

  test('no headings → empty list', () => {
    expect(buildOutline('Just a paragraph.\n\nAnother one.')).toEqual([])
  })

  test('CJK heading slugs survive', () => {
    const md = `# 介绍\n\n## 章节一\n\n## 章节二`
    expect(buildOutline(md).map((n) => n.slug)).toEqual(['介绍', '章节一', '章节二'])
  })
})
