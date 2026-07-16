import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { RemoteVault, UnauthorizedError } from './remote-provider'

// We stub globalThis.fetch per test and restore on teardown so unrelated
// network code can't accidentally hit a real server.
const realFetch = globalThis.fetch

function stubFetch(handler: (input: string, init?: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = ((input: unknown, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init))) as typeof fetch
}

describe('RemoteVault onUnauthorized', () => {
  beforeEach(() => {
    stubFetch(() => new Response('unauthorized', { status: 401 }))
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('fires callback before throwing on 401 from JSON endpoint (list)', async () => {
    let called = 0
    const vault = new RemoteVault({ onUnauthorized: () => (called += 1) })
    await expect(vault.list('')).rejects.toBeInstanceOf(UnauthorizedError)
    expect(called).toBe(1)
  })

  test('fires callback before throwing on 401 from text endpoint (read)', async () => {
    let called = 0
    const vault = new RemoteVault({ onUnauthorized: () => (called += 1) })
    await expect(vault.read('foo.md')).rejects.toBeInstanceOf(UnauthorizedError)
    expect(called).toBe(1)
  })

  test('does not require onUnauthorized — still throws cleanly without it', async () => {
    const vault = new RemoteVault()
    await expect(vault.list('')).rejects.toBeInstanceOf(UnauthorizedError)
  })
})

describe('RemoteVault rootPath (workspace scoping)', () => {
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  function capture(): { urls: string[]; bodies: string[] } {
    const urls: string[] = []
    const bodies: string[] = []
    stubFetch((input, init) => {
      urls.push(input)
      if (typeof init?.body === 'string') bodies.push(init.body)
      if (input.includes('/api/vault/list')) {
        return new Response(
          JSON.stringify([
            { path: 'quill/notes', isDirectory: true },
            { path: 'quill/h.md', isDirectory: false }
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
    return { urls, bodies }
  }

  test('prefixes outgoing paths with the workspace dir', async () => {
    const { urls, bodies } = capture()
    const vault = new RemoteVault({ rootPath: 'quill' })
    await vault.write('notes/a.md', 'x')
    await vault.delete('notes/a.md')
    await vault.mkdir('sub')
    await vault.rename('a.md', 'b.md')
    expect(urls[0]).toContain('/api/vault/file/quill/notes/a.md')
    expect(urls[1]).toContain('/api/vault/file/quill/notes/a.md')
    expect(bodies).toContainEqual(JSON.stringify({ path: 'quill/sub' }))
    expect(bodies).toContainEqual(JSON.stringify({ from: 'quill/a.md', to: 'quill/b.md' }))
  })

  test('list queries the workspace dir and strips the prefix from results', async () => {
    const { urls } = capture()
    const vault = new RemoteVault({ rootPath: 'quill' })
    const rootNodes = await vault.list('')
    expect(urls[0]).toContain('dir=quill')
    expect(rootNodes.map((n) => n.path)).toEqual(['notes', 'h.md'])

    await vault.list('notes')
    expect(urls[1]).toContain(`dir=${encodeURIComponent('quill/notes')}`)
  })

  test('no rootPath → behavior unchanged', async () => {
    const { urls } = capture()
    const vault = new RemoteVault()
    const nodes = await vault.list('')
    expect(urls[0]).not.toContain('dir=')
    expect(nodes.map((n) => n.path)).toEqual(['quill/notes', 'quill/h.md'])
  })
})

describe('RemoteVault credentials mode', () => {
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('omits credentials when Bearer headers are present (cross-origin desktop)', async () => {
    let seen: RequestInit | undefined
    stubFetch((_input, init) => {
      seen = init
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const vault = new RemoteVault({
      baseUrl: 'http://example.com',
      getAuthHeaders: () => ({ Authorization: 'Bearer t' })
    })
    await vault.list('')
    expect(seen?.credentials).toBe('omit')
  })

  test('keeps credentials: include for cookie mode (same-origin web)', async () => {
    let seen: RequestInit | undefined
    stubFetch((_input, init) => {
      seen = init
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const vault = new RemoteVault()
    await vault.list('')
    expect(seen?.credentials).toBe('include')
  })
})

describe('readBinary', () => {
  test('fetches the resource endpoint with the workspace prefix and returns bytes', async () => {
    const seen: string[] = []
    stubFetch((url) => {
      seen.push(url)
      return new Response(new Uint8Array([9, 8, 7]), {
        status: 200,
        headers: { 'content-type': 'image/png' }
      })
    })
    try {
      const vault = new RemoteVault({ baseUrl: '', rootPath: 'ws1' })
      const bytes = await vault.readBinary('img/pic.png')
      expect(Array.from(bytes)).toEqual([9, 8, 7])
      expect(seen[0]).toBe('/api/vault/resource/ws1/img/pic.png')
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('maps 401 to UnauthorizedError', async () => {
    stubFetch(() => new Response('', { status: 401 }))
    try {
      const vault = new RemoteVault({ baseUrl: '' })
      await expect(vault.readBinary('pic.png')).rejects.toBeInstanceOf(UnauthorizedError)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
