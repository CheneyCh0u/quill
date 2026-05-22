import { describe, expect, it } from 'bun:test'
import { extractText } from './html-extract'

describe('extractText — title', () => {
  it('pulls <title> content', () => {
    const r = extractText('<html><head><title>Hello world</title></head><body>x</body></html>')
    expect(r.title).toBe('Hello world')
  })
  it('trims and collapses whitespace in title', () => {
    const r = extractText('<title>  Foo\n   bar  </title>')
    expect(r.title).toBe('Foo bar')
  })
  it('returns undefined title when missing', () => {
    const r = extractText('<p>no title</p>')
    expect(r.title).toBeUndefined()
  })
})

describe('extractText — block strip', () => {
  it('removes script content', () => {
    const r = extractText('<p>keep</p><script>alert("nope")</script>')
    expect(r.text).toContain('keep')
    expect(r.text).not.toContain('alert')
  })
  it('removes style content', () => {
    const r = extractText('<style>.x{color:red}</style><p>keep</p>')
    expect(r.text).toContain('keep')
    expect(r.text).not.toContain('color:red')
  })
  it('removes nav/header/footer/aside/iframe/noscript', () => {
    const html = `
      <header>top</header>
      <nav>menu</nav>
      <aside>side</aside>
      <iframe>frame</iframe>
      <noscript>fallback</noscript>
      <main>main content here</main>
      <footer>bottom</footer>
    `
    const r = extractText(html)
    expect(r.text).toContain('main content here')
    expect(r.text).not.toContain('top')
    expect(r.text).not.toContain('menu')
    expect(r.text).not.toContain('side')
    expect(r.text).not.toContain('frame')
    expect(r.text).not.toContain('fallback')
    expect(r.text).not.toContain('bottom')
  })
  it('case-insensitive tag matching', () => {
    const r = extractText('<SCRIPT>x</SCRIPT><p>keep</p>')
    expect(r.text).toContain('keep')
    expect(r.text).not.toContain('x')
  })
  it('handles attributes in stripped tags', () => {
    const r = extractText('<script src="x.js" defer>noise</script><p>keep</p>')
    expect(r.text).not.toContain('noise')
    expect(r.text).toContain('keep')
  })
})

describe('extractText — tag stripping', () => {
  it('removes remaining tags but keeps inner text', () => {
    const r = extractText('<p>hello <strong>world</strong></p>')
    expect(r.text).toBe('hello world')
  })
  it('collapses runs of whitespace', () => {
    const r = extractText('<p>a   b\n\nc</p>')
    expect(r.text).toBe('a b c')
  })
  it('preserves text across multiple paragraphs as separated', () => {
    const r = extractText('<p>line 1</p><p>line 2</p>')
    // Either single-spaced or newline-separated is fine — verify both present.
    expect(r.text).toContain('line 1')
    expect(r.text).toContain('line 2')
  })
})

describe('extractText — entity decoding', () => {
  it('decodes common named entities', () => {
    const r = extractText('<p>&amp; &lt; &gt; &quot; &apos; &nbsp;a</p>')
    expect(r.text).toContain('&')
    expect(r.text).toContain('<')
    expect(r.text).toContain('>')
    expect(r.text).toContain('"')
    expect(r.text).toContain("'")
    // &nbsp; collapses with surrounding text
    expect(r.text).toMatch(/ a/)
  })
  it('decodes numeric entities (decimal and hex)', () => {
    const r = extractText('<p>&#65;&#x42;&#x4f;</p>')
    expect(r.text).toBe('ABO')
  })
})

describe('extractText — edge cases', () => {
  it('empty input returns empty text and no title', () => {
    const r = extractText('')
    expect(r.text).toBe('')
    expect(r.title).toBeUndefined()
  })
  it('plain text input passes through unchanged', () => {
    const r = extractText('just some plain text')
    expect(r.text).toBe('just some plain text')
  })
  it('does not crash on unbalanced tags', () => {
    const r = extractText('<p>open<script>')
    expect(typeof r.text).toBe('string')
  })
})
