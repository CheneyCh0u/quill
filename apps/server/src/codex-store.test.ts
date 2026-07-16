import { describe, it, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CodexTokens } from '@quill/agent'
import { ServerCodexStore } from './codex-store'

const TOKENS: CodexTokens = {
  accessToken: 'at-1',
  refreshToken: 'rt-1',
  expiresAt: 1_800_000_000_000,
  accountId: 'acc-1'
}

function tempStorePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'quill-codex-store-')), 'codex-auth.json')
}

describe('ServerCodexStore', () => {
  it('returns null tokens and empty model before first login', async () => {
    const store = new ServerCodexStore(tempStorePath())
    expect(await store.load()).toBeNull()
    expect(await store.getModel()).toBe('')
  })

  it('round-trips tokens through save/load and survives a fresh instance', async () => {
    const path = tempStorePath()
    await new ServerCodexStore(path).save(TOKENS)
    expect(await new ServerCodexStore(path).load()).toEqual(TOKENS)
  })

  it('persists the model choice independently of tokens', async () => {
    const path = tempStorePath()
    const store = new ServerCodexStore(path)
    await store.save(TOKENS)
    await store.setModel('gpt-5.6-terra')
    expect(await new ServerCodexStore(path).getModel()).toBe('gpt-5.6-terra')
  })

  it('clear drops tokens but keeps the model preference', async () => {
    const store = new ServerCodexStore(tempStorePath())
    await store.save(TOKENS)
    await store.setModel('gpt-5.6')
    await store.clear()
    expect(await store.load()).toBeNull()
    expect(await store.getModel()).toBe('gpt-5.6')
  })

  it('writes the state file chmod 0600 like providers.json', async () => {
    const path = tempStorePath()
    await new ServerCodexStore(path).save(TOKENS)
    const mode = (await fs.stat(path)).mode & 0o777
    expect(mode).toBe(0o600)
  })
})
