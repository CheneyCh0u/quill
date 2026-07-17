import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { makeTools } from './tools'
import type { ApprovalPayload, ApprovalResponse } from './approvals'

type ToolMap = ReturnType<typeof makeTools>

async function exec<K extends keyof ToolMap>(
  tools: ToolMap,
  name: K,
  input: Parameters<NonNullable<ToolMap[K]['execute']>>[0],
  toolCallId = 'tc-test'
): Promise<unknown> {
  const t = tools[name] as unknown as {
    execute: (i: unknown, opts: unknown) => Promise<unknown>
  }
  return t.execute(input, { toolCallId, messages: [], abortSignal: new AbortController().signal })
}

let dir = ''
const calls: Array<{ toolCallId: string; payload: ApprovalPayload }> = []
const approveAll = async (toolCallId: string, payload: ApprovalPayload): Promise<ApprovalResponse> => {
  calls.push({ toolCallId, payload })
  return { approved: true }
}
const denyAll = async (toolCallId: string, payload: ApprovalPayload): Promise<ApprovalResponse> => {
  calls.push({ toolCallId, payload })
  return { approved: false, reason: 'user denied' }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quill-tools-del-'))
  calls.length = 0
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('delete_file', () => {
  test('approved delete removes the file', async () => {
    const p = join(dir, 'a.md')
    await writeFile(p, 'bye', 'utf-8')
    const tools = makeTools({ kind: 'workspace', root: dir }, approveAll)
    const r = (await exec(tools, 'delete_file', { path: 'a.md' })) as { ok: boolean }
    expect(r.ok).toBe(true)
    expect(await fs.stat(p).catch(() => null)).toBeNull()
    expect(calls[0].payload.kind).toBe('delete_file')
    expect(calls[0].payload.path).toBe(p)
  })

  test('denied delete keeps the file', async () => {
    const p = join(dir, 'a.md')
    await writeFile(p, 'keep', 'utf-8')
    const tools = makeTools({ kind: 'workspace', root: dir }, denyAll)
    const r = (await exec(tools, 'delete_file', { path: 'a.md' })) as {
      ok: boolean
      error?: string
    }
    expect(r.ok).toBe(false)
    expect(r.error).toContain('denied')
    expect(await fs.readFile(p, 'utf-8')).toBe('keep')
  })

  test('errors if path not found, never asks for approval', async () => {
    const tools = makeTools({ kind: 'workspace', root: dir }, approveAll)
    const r = (await exec(tools, 'delete_file', { path: 'ghost.md' })) as {
      ok: boolean
      error?: string
    }
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not found/i)
    expect(calls.length).toBe(0)
  })

  test('errors if path is a directory, never asks for approval', async () => {
    await fs.mkdir(join(dir, 'sub'))
    const tools = makeTools({ kind: 'workspace', root: dir }, approveAll)
    const r = (await exec(tools, 'delete_file', { path: 'sub' })) as {
      ok: boolean
      error?: string
    }
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/delete_dir/)
    expect(calls.length).toBe(0)
  })

  test('out-of-scope path rejected before asking for approval', async () => {
    const tools = makeTools({ kind: 'workspace', root: dir }, approveAll)
    const r = (await exec(tools, 'delete_file', { path: '../escape.md' })) as {
      ok: boolean
    }
    expect(r.ok).toBe(false)
    expect(calls.length).toBe(0)
  })
})

describe('delete_dir', () => {
  test('approved delete removes the folder recursively, payload carries entryCount', async () => {
    await fs.mkdir(join(dir, 'sub/deep'), { recursive: true })
    await writeFile(join(dir, 'sub/a.md'), 'x', 'utf-8')
    await writeFile(join(dir, 'sub/deep/b.md'), 'y', 'utf-8')
    const tools = makeTools({ kind: 'workspace', root: dir }, approveAll)
    const r = (await exec(tools, 'delete_dir', { path: 'sub' })) as { ok: boolean }
    expect(r.ok).toBe(true)
    expect(await fs.stat(join(dir, 'sub')).catch(() => null)).toBeNull()
    expect(calls[0].payload.kind).toBe('delete_dir')
    // a.md + deep + deep/b.md
    expect(calls[0].payload.entryCount).toBe(3)
  })

  test('denied delete keeps the folder', async () => {
    await fs.mkdir(join(dir, 'sub'))
    await writeFile(join(dir, 'sub/a.md'), 'keep', 'utf-8')
    const tools = makeTools({ kind: 'workspace', root: dir }, denyAll)
    const r = (await exec(tools, 'delete_dir', { path: 'sub' })) as { ok: boolean }
    expect(r.ok).toBe(false)
    expect(await fs.readFile(join(dir, 'sub/a.md'), 'utf-8')).toBe('keep')
  })

  test('errors if path is a file, never asks for approval', async () => {
    await writeFile(join(dir, 'a.md'), 'x', 'utf-8')
    const tools = makeTools({ kind: 'workspace', root: dir }, approveAll)
    const r = (await exec(tools, 'delete_dir', { path: 'a.md' })) as {
      ok: boolean
      error?: string
    }
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/delete_file/)
    expect(calls.length).toBe(0)
  })

  test('refuses to delete the scope root, never asks for approval', async () => {
    const tools = makeTools({ kind: 'workspace', root: dir }, approveAll)
    const r = (await exec(tools, 'delete_dir', { path: '.' })) as {
      ok: boolean
      error?: string
    }
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/root/i)
    expect(calls.length).toBe(0)
    expect(await fs.stat(dir).catch(() => null)).not.toBeNull()
  })
})
