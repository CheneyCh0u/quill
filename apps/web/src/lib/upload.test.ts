import { describe, expect, test } from 'bun:test'
import { detectCollisions, isSupportedTextUpload, planUpload, uploadFiles } from './upload'
import type { FileNode, FileStat } from '@quill/shared-types'
import type { VaultProvider } from '@quill/vault-adapter'

class FakeVault implements VaultProvider {
  readonly kind = 'remote' as const
  files = new Map<string, string>()
  dirs = new Set<string>()

  readBinary(path: string): Promise<Uint8Array> {
    const f = this.files.get(path)
    if (f === undefined) return Promise.reject(new Error(`not found: ${path}`))
    return Promise.resolve(new TextEncoder().encode(f))
  }

  read(path: string): Promise<string> {
    const f = this.files.get(path)
    if (!f) return Promise.reject(new Error(`not found: ${path}`))
    return Promise.resolve(f)
  }
  write(path: string, content: string): Promise<void> {
    this.files.set(path, content)
    return Promise.resolve()
  }
  rename(): Promise<void> {
    return Promise.resolve()
  }
  list(dir: string): Promise<FileNode[]> {
    const prefix = dir ? `${dir}/` : ''
    const out: FileNode[] = []
    for (const path of this.files.keys()) {
      if (!path.startsWith(prefix)) continue
      const rest = path.slice(prefix.length)
      if (rest.includes('/')) continue
      const isMd = rest.endsWith('.md')
      out.push({ name: rest, path, isDirectory: false, isMarkdown: isMd, isText: isMd })
    }
    return Promise.resolve(out)
  }
  stat(_path: string): Promise<FileStat> {
    return Promise.resolve({ isFile: true, isDirectory: false, size: 0, mtime: 0 })
  }
  mkdir(): Promise<void> {
    return Promise.resolve()
  }
  delete(): Promise<void> {
    return Promise.resolve()
  }
  deleteDir(): Promise<void> {
    return Promise.resolve()
  }
}

function f(name: string, content: string): File {
  return new File([content], name, { type: 'text/markdown' })
}

describe('upload helpers', () => {
  test('isSupportedTextUpload accepts markdown and other text formats', () => {
    expect(isSupportedTextUpload(f('a.md', ''))).toBe(true)
    expect(isSupportedTextUpload(f('a.markdown', ''))).toBe(true)
    expect(isSupportedTextUpload(f('a.mdown', ''))).toBe(true)
    expect(isSupportedTextUpload(f('a.mkd', ''))).toBe(true)
    expect(isSupportedTextUpload(f('a.txt', ''))).toBe(true)
    expect(isSupportedTextUpload(f('a.ts', ''))).toBe(true)
    expect(isSupportedTextUpload(f('a.json', ''))).toBe(true)
    expect(isSupportedTextUpload(f('a.yaml', ''))).toBe(true)
    expect(isSupportedTextUpload(f('Makefile', ''))).toBe(true)
  })

  test('isSupportedTextUpload rejects binary / unknown extensions', () => {
    expect(isSupportedTextUpload(f('a.png', ''))).toBe(false)
    expect(isSupportedTextUpload(f('a.pdf', ''))).toBe(false)
    expect(isSupportedTextUpload(f('a.unknownext', ''))).toBe(false)
  })

  test('planUpload joins dest dir with file name', () => {
    const plan = planUpload('notes', [f('a.md', '')])
    expect(plan[0].destPath).toBe('notes/a.md')
  })

  test('planUpload at root drops the leading slash', () => {
    const plan = planUpload('', [f('a.md', '')])
    expect(plan[0].destPath).toBe('a.md')
  })

  test('detectCollisions returns only names that already exist', async () => {
    const vault = new FakeVault()
    vault.files.set('notes/a.md', 'existing')
    vault.files.set('notes/b.md', 'existing')
    const collisions = await detectCollisions(vault, 'notes', [
      f('a.md', ''),
      f('c.md', '')
    ])
    expect(collisions.map((c) => c.file.name)).toEqual(['a.md'])
  })

  test('uploadFiles writes each item and reports results', async () => {
    const vault = new FakeVault()
    const items = planUpload('notes', [f('a.md', 'hello'), f('b.md', 'world')])
    const results = await uploadFiles(vault, items)
    expect(results).toEqual([
      { destPath: 'notes/a.md', ok: true },
      { destPath: 'notes/b.md', ok: true }
    ])
    expect(vault.files.get('notes/a.md')).toBe('hello')
    expect(vault.files.get('notes/b.md')).toBe('world')
  })

  test('uploadFiles surfaces per-item errors without aborting the batch', async () => {
    const vault = new FakeVault()
    vault.write = (path) => {
      if (path === 'notes/b.md') return Promise.reject(new Error('disk full'))
      vault.files.set(path, '')
      return Promise.resolve()
    }
    const items = planUpload('notes', [f('a.md', ''), f('b.md', ''), f('c.md', '')])
    const results = await uploadFiles(vault, items)
    expect(results.map((r) => r.ok)).toEqual([true, false, true])
    expect(results[1].error).toContain('disk full')
  })

  test('uploadFiles fires onProgress in order', async () => {
    const vault = new FakeVault()
    const items = planUpload('', [f('a.md', ''), f('b.md', '')])
    const calls: Array<[number, number]> = []
    await uploadFiles(vault, items, (done, total) => calls.push([done, total]))
    expect(calls).toEqual([
      [0, 2],
      [1, 2],
      [2, 2]
    ])
  })
})
