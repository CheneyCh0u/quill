import { describe, expect, it } from 'bun:test'
import { checkUrl } from './url-guard'

const ok = (s: string): URL => {
  const r = checkUrl(s)
  if (!r.ok) throw new Error(`expected ok for ${s}, got: ${r.error}`)
  return r.url
}

const blocked = (s: string): string => {
  const r = checkUrl(s)
  if (r.ok) throw new Error(`expected blocked for ${s}, got ok`)
  return r.error
}

describe('checkUrl — schemes', () => {
  it('accepts https', () => {
    expect(ok('https://example.com/path').hostname).toBe('example.com')
  })
  it('accepts http', () => {
    expect(ok('http://example.com').hostname).toBe('example.com')
  })
  it('blocks file://', () => {
    expect(blocked('file:///etc/passwd')).toMatch(/scheme/i)
  })
  it('blocks ftp://', () => {
    expect(blocked('ftp://example.com')).toMatch(/scheme/i)
  })
  it('blocks data:', () => {
    expect(blocked('data:text/plain,hello')).toMatch(/scheme/i)
  })
  it('blocks javascript:', () => {
    expect(blocked('javascript:alert(1)')).toMatch(/scheme/i)
  })
})

describe('checkUrl — malformed', () => {
  it('blocks empty', () => {
    expect(blocked('')).toMatch(/invalid/i)
  })
  it('blocks not-a-url', () => {
    expect(blocked('hello world')).toMatch(/invalid/i)
  })
})

describe('checkUrl — loopback / private hosts', () => {
  it('blocks localhost', () => {
    expect(blocked('http://localhost/x')).toMatch(/private|loopback/i)
  })
  it('blocks 127.0.0.1', () => {
    expect(blocked('http://127.0.0.1/')).toMatch(/private|loopback/i)
  })
  it('blocks 127.0.0.5 (any 127.x.x.x)', () => {
    expect(blocked('http://127.0.0.5/')).toMatch(/private|loopback/i)
  })
  it('blocks ::1', () => {
    expect(blocked('http://[::1]/')).toMatch(/private|loopback/i)
  })
  it('blocks 10.0.0.5 (RFC1918)', () => {
    expect(blocked('http://10.0.0.5/')).toMatch(/private/i)
  })
  it('blocks 192.168.1.1', () => {
    expect(blocked('http://192.168.1.1/')).toMatch(/private/i)
  })
  it('blocks 172.16.0.1 — 172.31.x.x (RFC1918)', () => {
    expect(blocked('http://172.16.0.1/')).toMatch(/private/i)
    expect(blocked('http://172.31.255.255/')).toMatch(/private/i)
  })
  it('does NOT block 172.32.0.1 (outside RFC1918)', () => {
    expect(() => ok('http://172.32.0.1/')).not.toThrow()
  })
  it('does NOT block 172.15.0.1 (outside RFC1918)', () => {
    expect(() => ok('http://172.15.0.1/')).not.toThrow()
  })
  it('blocks 169.254.169.254 (cloud metadata)', () => {
    expect(blocked('http://169.254.169.254/latest/meta-data/')).toMatch(
      /private|link-local|metadata/i
    )
  })
  it('blocks 0.0.0.0', () => {
    expect(blocked('http://0.0.0.0/')).toMatch(/private|loopback/i)
  })
})

describe('checkUrl — happy paths', () => {
  it('accepts well-formed public URL', () => {
    expect(ok('https://github.com/HanchenZhou/quill').hostname).toBe('github.com')
  })
  it('preserves path and query', () => {
    const u = ok('https://example.com/foo?bar=baz')
    expect(u.pathname).toBe('/foo')
    expect(u.search).toBe('?bar=baz')
  })
  it('accepts an explicit port on a public host', () => {
    expect(ok('https://example.com:8443/').hostname).toBe('example.com')
  })
})
