/// <reference types="bun" />
import { describe, it, expect } from 'bun:test'
import { render } from './markdown'

describe('render', () => {
  it('emits id attribute on headings matching outline slug', () => {
    const html = render('# Hello world')
    expect(html).toContain('id="hello-world"')
  })

  it('disambiguates duplicate heading ids with -1, -2', () => {
    const html = render('# Foo\n\n## Foo\n\n### Foo')
    expect(html).toContain('id="foo"')
    expect(html).toContain('id="foo-1"')
    expect(html).toContain('id="foo-2"')
  })

  it('does not double-inject id on subsequent renders', () => {
    // Each render() call should get a fresh slug-counter env, so the same
    // source produces the same ids twice in a row.
    const a = render('# Foo\n## Foo')
    const b = render('# Foo\n## Foo')
    expect(a).toBe(b)
  })
})
