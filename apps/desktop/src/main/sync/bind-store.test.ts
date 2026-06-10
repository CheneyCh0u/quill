import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readSyncFile, writeSyncFile, removeSyncFile } from './bind-store'

async function freshRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'quill-bind-'))
}

const sample = {
  spaceId: 'space-1',
  serverUrl: 'https://quill.example.com',
  remotePath: 'my-notes',
  lastSyncAt: 123,
  lastSync: { 'a.md': 'h1' }
}

describe('sync bind store (.quill/sync.json)', () => {
  test('read returns null when the folder was never bound', async () => {
    expect(await readSyncFile(await freshRoot())).toBeNull()
  })

  test('write then read round-trips', async () => {
    const root = await freshRoot()
    await writeSyncFile(root, sample)
    expect(await readSyncFile(root)).toEqual(sample)
  })

  test('read returns null for corrupt json instead of throwing', async () => {
    const root = await freshRoot()
    await writeSyncFile(root, sample)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(root, '.quill', 'sync.json'), 'not json', 'utf8')
    expect(await readSyncFile(root)).toBeNull()
  })

  test('remove deletes the binding', async () => {
    const root = await freshRoot()
    await writeSyncFile(root, sample)
    await removeSyncFile(root)
    expect(await readSyncFile(root)).toBeNull()
  })
})
