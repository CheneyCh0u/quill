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
