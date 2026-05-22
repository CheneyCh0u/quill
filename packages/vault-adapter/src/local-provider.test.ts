import { describe, expect, test } from 'bun:test'
import { LocalProvider, type QuillFsBridge } from './local-provider'
import { NotSupportedError } from './types'

function makeBridge(): {
  bridge: QuillFsBridge
  calls: Array<{ method: string; args: unknown[] }>
} {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const bridge: QuillFsBridge = {
    readFile: async (path) => {
      calls.push({ method: 'readFile', args: [path] })
      return 'content'
    },
    writeFile: async (path, content) => {
      calls.push({ method: 'writeFile', args: [path, content] })
    },
    rename: async (oldPath, newPath) => {
      calls.push({ method: 'rename', args: [oldPath, newPath] })
    },
    listDir: async (path) => {
      calls.push({ method: 'listDir', args: [path] })
      return [
        { name: 'a.md', path: `${path}/a.md`, isDirectory: false, isMarkdown: true }
      ]
    },
    stat: async (path) => {
      calls.push({ method: 'stat', args: [path] })
      return { isFile: true, isDirectory: false, size: 42, mtime: 100 }
    }
  }
  return { bridge, calls }
}

describe('LocalProvider', () => {
  test('kind is local', () => {
    const { bridge } = makeBridge()
    const provider = new LocalProvider(bridge)
    expect(provider.kind).toBe('local')
  })

  test('read forwards to bridge.readFile', async () => {
    const { bridge, calls } = makeBridge()
    const provider = new LocalProvider(bridge)
    const result = await provider.read('/x/a.md')
    expect(result).toBe('content')
    expect(calls).toEqual([{ method: 'readFile', args: ['/x/a.md'] }])
  })

  test('write forwards path + content to bridge.writeFile', async () => {
    const { bridge, calls } = makeBridge()
    const provider = new LocalProvider(bridge)
    await provider.write('/x/a.md', 'hello')
    expect(calls).toEqual([{ method: 'writeFile', args: ['/x/a.md', 'hello'] }])
  })

  test('rename forwards oldPath + newPath to bridge.rename', async () => {
    const { bridge, calls } = makeBridge()
    const provider = new LocalProvider(bridge)
    await provider.rename('/x/a.md', '/x/b.md')
    expect(calls).toEqual([{ method: 'rename', args: ['/x/a.md', '/x/b.md'] }])
  })

  test('list forwards to bridge.listDir and returns its result', async () => {
    const { bridge, calls } = makeBridge()
    const provider = new LocalProvider(bridge)
    const result = await provider.list('/x')
    expect(calls).toEqual([{ method: 'listDir', args: ['/x'] }])
    expect(result).toEqual([
      { name: 'a.md', path: '/x/a.md', isDirectory: false, isMarkdown: true }
    ])
  })

  test('stat forwards to bridge.stat and returns its result', async () => {
    const { bridge, calls } = makeBridge()
    const provider = new LocalProvider(bridge)
    const result = await provider.stat('/x/a.md')
    expect(calls).toEqual([{ method: 'stat', args: ['/x/a.md'] }])
    expect(result).toEqual({ isFile: true, isDirectory: false, size: 42, mtime: 100 })
  })

  test('mkdir rejects with NotSupportedError (no IPC backing yet)', async () => {
    const { bridge } = makeBridge()
    const provider = new LocalProvider(bridge)
    await expect(provider.mkdir('foo')).rejects.toBeInstanceOf(NotSupportedError)
  })

  test('delete rejects with NotSupportedError', async () => {
    const { bridge } = makeBridge()
    const provider = new LocalProvider(bridge)
    await expect(provider.delete('foo.md')).rejects.toBeInstanceOf(NotSupportedError)
  })

  test('deleteDir rejects with NotSupportedError', async () => {
    const { bridge } = makeBridge()
    const provider = new LocalProvider(bridge)
    await expect(provider.deleteDir('foo', true)).rejects.toBeInstanceOf(
      NotSupportedError
    )
  })
})
