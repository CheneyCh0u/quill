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
  dir = await mkdtemp(join(tmpdir(), 'quill-tools-'))
  calls.length = 0
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('write_file', () => {
  test('approved write replaces file content', async () => {
    const p = join(dir, 'a.md')
    await writeFile(p, 'old', 'utf-8')
    const tools = makeTools({ kind: 'workspace', root: dir }, approveAll)
    const r = (await exec(tools, 'write_file', { path: 'a.md', content: 'new' })) as {
      ok: boolean
      path?: string
    }
    expect(r.ok).toBe(true)
    expect(await fs.readFile(p, 'utf-8')).toBe('new')
    expect(calls[0].payload.kind).toBe('write_file')
  })

  test('approved write creates parent file (must already exist semantically — write_file replaces)', async () => {
    const p = join(dir, 'missing.md')
    const tools = makeTools({ kind: 'workspace', root: dir }, approveAll)
    const r = (await exec(tools, 'write_file', { path: 'missing.md', content: 'x' })) as {
      ok: boolean
    }
    // write_file is "full replace" semantically. It tolerates creating a new
    // file inside scope — create_file is for the "must not exist" guarantee.
    expect(r.ok).toBe(true)
    expect(await fs.readFile(p, 'utf-8')).toBe('x')
  })

  test('denied write does not touch disk and returns ok:false', async () => {
    const p = join(dir, 'a.md')
    await writeFile(p, 'old', 'utf-8')
    const tools = makeTools({ kind: 'workspace', root: dir }, denyAll)
    const r = (await exec(tools, 'write_file', { path: 'a.md', content: 'new' })) as {
      ok: boolean
      error?: string
    }
    expect(r.ok).toBe(false)
    expect(r.error).toContain('denied')
    expect(await fs.readFile(p, 'utf-8')).toBe('old')
  })

  test('out-of-scope path rejected before asking for approval', async () => {
    const tools = makeTools({ kind: 'workspace', root: dir }, approveAll)
    const r = (await exec(tools, 'write_file', {
      path: '../escape.md',
      content: 'x'
    })) as { ok: boolean; error?: string }
    expect(r.ok).toBe(false)
    expect(calls.length).toBe(0)
  })
})

describe('apply_edit', () => {
  test('exact unique substring replace', async () => {
    const p = join(dir, 'a.md')
    await writeFile(p, '# hi\n\nold line\n\nend', 'utf-8')
    const tools = makeTools({ kind: 'workspace', root: dir }, approveAll)
    const r = (await exec(tools, 'apply_edit', {
      path: 'a.md',
      old_text: 'old line',
      new_text: 'new line'
    })) as { ok: boolean }
    expect(r.ok).toBe(true)
    expect(await fs.readFile(p, 'utf-8')).toBe('# hi\n\nnew line\n\nend')
  })

  test('error if old_text not found', async () => {
    const p = join(dir, 'a.md')
    await writeFile(p, 'aaa', 'utf-8')
    const tools = makeTools({ kind: 'workspace', root: dir }, approveAll)
    const r = (await exec(tools, 'apply_edit', {
      path: 'a.md',
      old_text: 'zzz',
      new_text: 'yyy'
    })) as { ok: boolean; error?: string }
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not found/i)
    expect(calls.length).toBe(0)
  })

  test('error if old_text appears more than once (ambiguous)', async () => {
    const p = join(dir, 'a.md')
    await writeFile(p, 'foo\nfoo\n', 'utf-8')
    const tools = makeTools({ kind: 'workspace', root: dir }, approveAll)
    const r = (await exec(tools, 'apply_edit', {
      path: 'a.md',
      old_text: 'foo',
      new_text: 'bar'
    })) as { ok: boolean; error?: string }
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/multiple|ambiguous|unique/i)
    expect(calls.length).toBe(0)
  })

  test('denied edit does not touch disk', async () => {
    const p = join(dir, 'a.md')
    await writeFile(p, 'old', 'utf-8')
    const tools = makeTools({ kind: 'workspace', root: dir }, denyAll)
    const r = (await exec(tools, 'apply_edit', {
      path: 'a.md',
      old_text: 'old',
      new_text: 'new'
    })) as { ok: boolean }
    expect(r.ok).toBe(false)
    expect(await fs.readFile(p, 'utf-8')).toBe('old')
  })
})

describe('create_file', () => {
  test('approved create writes a new file', async () => {
    const tools = makeTools({ kind: 'workspace', root: dir }, approveAll)
    const r = (await exec(tools, 'create_file', {
      path: 'new.md',
      content: 'hello'
    })) as { ok: boolean }
    expect(r.ok).toBe(true)
    expect(await fs.readFile(join(dir, 'new.md'), 'utf-8')).toBe('hello')
  })

  test('errors if file exists, never asks for approval', async () => {
    const p = join(dir, 'exists.md')
    await writeFile(p, 'a', 'utf-8')
    const tools = makeTools({ kind: 'workspace', root: dir }, approveAll)
    const r = (await exec(tools, 'create_file', {
      path: 'exists.md',
      content: 'b'
    })) as { ok: boolean; error?: string }
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/exists/i)
    expect(calls.length).toBe(0)
    expect(await fs.readFile(p, 'utf-8')).toBe('a')
  })

  test('creates intermediate dirs (mkdir -p)', async () => {
    const tools = makeTools({ kind: 'workspace', root: dir }, approveAll)
    const r = (await exec(tools, 'create_file', {
      path: 'sub/deep/new.md',
      content: 'x'
    })) as { ok: boolean }
    expect(r.ok).toBe(true)
    expect(await fs.readFile(join(dir, 'sub/deep/new.md'), 'utf-8')).toBe('x')
  })

  test('denied create does not touch disk', async () => {
    const tools = makeTools({ kind: 'workspace', root: dir }, denyAll)
    const r = (await exec(tools, 'create_file', {
      path: 'new.md',
      content: 'x'
    })) as { ok: boolean }
    expect(r.ok).toBe(false)
    const stat = await fs.stat(join(dir, 'new.md')).catch(() => null)
    expect(stat).toBeNull()
  })
})

describe('single-file scope', () => {
  test('write_file to the scoped file works', async () => {
    const p = join(dir, 'only.md')
    await writeFile(p, 'old', 'utf-8')
    const tools = makeTools({ kind: 'single-file', path: p }, approveAll)
    const r = (await exec(tools, 'write_file', { path: p, content: 'new' })) as {
      ok: boolean
    }
    expect(r.ok).toBe(true)
    expect(await fs.readFile(p, 'utf-8')).toBe('new')
  })

  test('write_file to sibling rejected', async () => {
    const p = join(dir, 'only.md')
    await writeFile(p, 'old', 'utf-8')
    const tools = makeTools({ kind: 'single-file', path: p }, approveAll)
    const r = (await exec(tools, 'write_file', {
      path: join(dir, 'sibling.md'),
      content: 'x'
    })) as { ok: boolean }
    expect(r.ok).toBe(false)
    expect(calls.length).toBe(0)
  })
})

describe('read_file on viewable binaries', () => {
  test('refuses images/pdf instead of returning mojibake', async () => {
    const tools = makeTools({ kind: 'workspace', root: dir }, approveAll)
    await writeFile(join(dir, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const r = (await exec(tools, 'read_file', { path: 'pic.png' })) as {
      ok: boolean
      error?: string
    }
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/binary|图片|viewable|not.*text/i)
  })
})
