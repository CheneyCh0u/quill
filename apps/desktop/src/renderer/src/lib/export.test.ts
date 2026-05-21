import { describe, expect, it } from 'bun:test'
import { buildHtmlTemplate } from './export'

describe('buildHtmlTemplate', () => {
  it('wraps body in prose-paper article with the given theme', () => {
    const out = buildHtmlTemplate({
      body: '<h1 id="hello">Hello</h1>',
      css: '/* nothing */',
      theme: 'light',
      title: 'demo'
    })
    expect(out).toContain('<html data-theme="light">')
    expect(out).toContain('<body data-theme="light">')
    expect(out).toContain('class="prose-paper"')
    expect(out).toContain('<h1 id="hello">Hello</h1>')
  })

  it('html-escapes the title', () => {
    const out = buildHtmlTemplate({
      body: '',
      css: '',
      theme: 'dark',
      title: '<script>alert(1)</script>'
    })
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(out).not.toContain('<script>alert(1)</script>')
  })

  it('embeds the css verbatim inside <style>', () => {
    const css = '.foo { color: red; }\n.bar { background: blue; }'
    const out = buildHtmlTemplate({ body: '', css, theme: 'light', title: 't' })
    expect(out).toContain(css)
  })

  it('includes the Paper-UI font link (Fraunces + Geist)', () => {
    const out = buildHtmlTemplate({ body: '', css: '', theme: 'light', title: 't' })
    expect(out).toContain('fonts.googleapis.com')
    expect(out).toContain('Fraunces')
    expect(out).toContain('Geist')
    expect(out).toContain('Noto+Serif+SC')
  })

  it('reflects dark theme in color-scheme', () => {
    const out = buildHtmlTemplate({ body: '', css: '', theme: 'dark', title: 't' })
    expect(out).toContain('color-scheme: dark')
  })
})
