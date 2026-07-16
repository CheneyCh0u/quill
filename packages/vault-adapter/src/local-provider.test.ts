import { describe, expect, test } from 'bun:test'
import { LocalProvider, type QuillFsBridge } from './local-provider'

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
    readFileBinary: async (path) => {
      calls.push({ method: 'readFileBinary', args: [path] })
      return new Uint8Array([1, 2, 3])
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
        {
          name: 'a.md',
          path: `${path}/a.md`,
          isDirectory: false,
          isMarkdown: true,
          isText: true
        }
      ]
    },
    stat: async (path) => {
      calls.push({ method: 'stat', args: [path] })
      return { isFile: true, isDirectory: false, size: 42, mtime: 100 }
    },
    mkdir: async (path) => {
      calls.push({ method: 'mkdir', args: [path] })
    },
    delete: async (path) => {
      calls.push({ method: 'delete', args: [path] })
    },
    deleteDir: async (path, recursive) => {
      calls.push({ method: 'deleteDir', args: [path, recursive] })
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
      {
        name: 'a.md',
        path: '/x/a.md',
        isDirectory: false,
        isMarkdown: true,
        isText: true
      }
    ])
  })

  test('stat forwards to bridge.stat and returns its result', async () => {
    const { bridge, calls } = makeBridge()
    const provider = new LocalProvider(bridge)
    const result = await provider.stat('/x/a.md')
    expect(calls).toEqual([{ method: 'stat', args: ['/x/a.md'] }])
    expect(result).toEqual({ isFile: true, isDirectory: false, size: 42, mtime: 100 })
  })

  test('mkdir forwards to bridge.mkdir', async () => {
    const { bridge, calls } = makeBridge()
    const provider = new LocalProvider(bridge)
    await provider.mkdir('/x/sub')
    expect(calls).toEqual([{ method: 'mkdir', args: ['/x/sub'] }])
  })

  test('delete forwards to bridge.delete', async () => {
    const { bridge, calls } = makeBridge()
    const provider = new LocalProvider(bridge)
    await provider.delete('/x/a.md')
    expect(calls).toEqual([{ method: 'delete', args: ['/x/a.md'] }])
  })

  test('deleteDir forwards path + recursive flag to bridge.deleteDir', async () => {
    const { bridge, calls } = makeBridge()
    const provider = new LocalProvider(bridge)
    await provider.deleteDir('/x/sub', true)
    expect(calls).toEqual([{ method: 'deleteDir', args: ['/x/sub', true] }])
  })
})

describe('readBinary', () => {
  test('passes through to the bridge and returns raw bytes', async () => {
    const { bridge, calls } = makeBridge()
    const vault = new LocalProvider(bridge)
    const bytes = await vault.readBinary('/ws/pic.png')
    expect(Array.from(bytes)).toEqual([1, 2, 3])
    expect(calls.at(-1)).toEqual({ method: 'readFileBinary', args: ['/ws/pic.png'] })
  })
})
