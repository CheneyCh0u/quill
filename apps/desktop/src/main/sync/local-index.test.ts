import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildLocalIndex } from './local-index'

async function freshRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'quill-local-index-'))
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

describe('buildLocalIndex', () => {
  test('hashes files recursively with POSIX relative paths', async () => {
    const root = await freshRoot()
    await mkdir(join(root, 'docs'), { recursive: true })
    await writeFile(join(root, 'a.md'), '# A\n', 'utf8')
    await writeFile(join(root, 'docs', 'b.md'), '# B\n', 'utf8')

    const index = await buildLocalIndex(root)
    expect(index).toEqual({
      'a.md': sha256('# A\n'),
      'docs/b.md': sha256('# B\n')
    })
  })

  test('skips .quill, .git and binary extensions', async () => {
    const root = await freshRoot()
    await mkdir(join(root, '.quill'), { recursive: true })
    await mkdir(join(root, '.git'), { recursive: true })
    await writeFile(join(root, '.quill', 'sync.json'), '{}', 'utf8')
    await writeFile(join(root, '.git', 'HEAD'), 'ref\n', 'utf8')
    await writeFile(join(root, 'pic.png'), 'binary', 'utf8')
    await writeFile(join(root, 'note.md'), 'x', 'utf8')

    const index = await buildLocalIndex(root)
    expect(Object.keys(index)).toEqual(['note.md'])
  })

  test('hash matches the server vault hash for identical content', async () => {
    // Server hashes raw file bytes with sha256 (apps/server/src/vault.ts).
    // Local index must produce the same hex or every file looks modified.
    const root = await freshRoot()
    await writeFile(join(root, 'a.md'), '中文 content\n', 'utf8')
    const index = await buildLocalIndex(root)
    expect(index['a.md']).toBe(sha256('中文 content\n'))
  })
})
