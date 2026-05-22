import { describe, expect, test } from 'bun:test'
import { makeTools } from './tools'
import type { Scope } from './scope'
import type { ApprovalPayload, ApprovalResponse } from './approvals'

type ToolMap = ReturnType<typeof makeTools>

async function exec(
  tools: ToolMap,
  input: { url: string },
  toolCallId = 'tc-web'
): Promise<unknown> {
  const t = tools.web_fetch as unknown as {
    execute: (i: unknown, opts: unknown) => Promise<unknown>
  }
  return t.execute(input, { toolCallId, messages: [], abortSignal: new AbortController().signal })
}

const approveAll = async (
  _id: string,
  _p: ApprovalPayload
): Promise<ApprovalResponse> => ({ approved: true })

const scope: Scope = { kind: 'workspace', root: '/r' }

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' }
  })
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}
function plainResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain' } })
}

describe('web_fetch — happy paths', () => {
  test('returns extracted text + title for HTML', async () => {
    const fetcher = async (_url: string | URL) =>
      htmlResponse('<html><head><title>Hello</title></head><body><p>world</p></body></html>')
    const tools = makeTools(scope, approveAll, fetcher as unknown as typeof fetch)
    const r = (await exec(tools, { url: 'https://example.com' })) as {
      ok: boolean
      title?: string
      content: string
      contentType: string
    }
    expect(r.ok).toBe(true)
    expect(r.title).toBe('Hello')
    expect(r.content).toContain('world')
    expect(r.contentType).toMatch(/text\/html/)
  })

  test('passes plain text through unchanged', async () => {
    const fetcher = async () => plainResponse('just some text')
    const tools = makeTools(scope, approveAll, fetcher as unknown as typeof fetch)
    const r = (await exec(tools, { url: 'https://example.com/x.txt' })) as {
      ok: boolean
      content: string
    }
    expect(r.ok).toBe(true)
    expect(r.content).toBe('just some text')
  })

  test('pretty-prints JSON', async () => {
    const fetcher = async () => jsonResponse({ a: 1, b: [2, 3] })
    const tools = makeTools(scope, approveAll, fetcher as unknown as typeof fetch)
    const r = (await exec(tools, { url: 'https://api.example.com/foo' })) as {
      ok: boolean
      content: string
    }
    expect(r.ok).toBe(true)
    expect(r.content).toContain('"a": 1')
  })

  test('surfaces final URL after redirects (uses Response.url)', async () => {
    const fetcher = async () => {
      const r = new Response('<p>x</p>', {
        status: 200,
        headers: { 'content-type': 'text/html' }
      })
      Object.defineProperty(r, 'url', { value: 'https://example.com/final' })
      return r
    }
    const tools = makeTools(scope, approveAll, fetcher as unknown as typeof fetch)
    const r = (await exec(tools, { url: 'https://example.com/redirect' })) as {
      ok: boolean
      url: string
    }
    expect(r.ok).toBe(true)
    expect(r.url).toBe('https://example.com/final')
  })
})

describe('web_fetch — URL guard', () => {
  test('rejects file:// before any fetch attempt', async () => {
    let called = false
    const fetcher = (async () => {
      called = true
      return plainResponse('nope')
    }) as unknown as typeof fetch
    const tools = makeTools(scope, approveAll, fetcher)
    const r = (await exec(tools, { url: 'file:///etc/passwd' })) as { ok: boolean; error?: string }
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/scheme/i)
    expect(called).toBe(false)
  })
  test('rejects localhost before any fetch attempt', async () => {
    let called = false
    const fetcher = (async () => {
      called = true
      return plainResponse('nope')
    }) as unknown as typeof fetch
    const tools = makeTools(scope, approveAll, fetcher)
    const r = (await exec(tools, { url: 'http://localhost:8080/' })) as {
      ok: boolean
      error?: string
    }
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/loopback|private/i)
    expect(called).toBe(false)
  })
  test('rejects private IP', async () => {
    const fetcher = (async () => plainResponse('nope')) as unknown as typeof fetch
    const tools = makeTools(scope, approveAll, fetcher)
    const r = (await exec(tools, { url: 'http://192.168.1.1/' })) as { ok: boolean }
    expect(r.ok).toBe(false)
  })
})

describe('web_fetch — errors', () => {
  test('returns ok:false with status for non-2xx', async () => {
    const fetcher = (async () => htmlResponse('Not found', 404)) as unknown as typeof fetch
    const tools = makeTools(scope, approveAll, fetcher)
    const r = (await exec(tools, { url: 'https://example.com/missing' })) as {
      ok: boolean
      error?: string
    }
    expect(r.ok).toBe(false)
    expect(r.error).toContain('404')
  })

  test('catches network rejection from fetcher', async () => {
    const fetcher = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const tools = makeTools(scope, approveAll, fetcher)
    const r = (await exec(tools, { url: 'https://example.com' })) as {
      ok: boolean
      error?: string
    }
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/ECONNREFUSED|network/i)
  })

  test('returns ok:false for unsupported content-type (e.g. PDF binary)', async () => {
    const fetcher = (async () => {
      return new Response('%PDF-1.5...', {
        status: 200,
        headers: { 'content-type': 'application/pdf' }
      })
    }) as unknown as typeof fetch
    const tools = makeTools(scope, approveAll, fetcher)
    const r = (await exec(tools, { url: 'https://example.com/x.pdf' })) as {
      ok: boolean
      error?: string
    }
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/application\/pdf|unsupported/i)
  })
})

describe('web_fetch — size cap', () => {
  test('truncates oversized content and sets truncated flag', async () => {
    const big = 'a'.repeat(120_000)
    const fetcher = (async () =>
      new Response(big, {
        status: 200,
        headers: { 'content-type': 'text/plain' }
      })) as unknown as typeof fetch
    const tools = makeTools(scope, approveAll, fetcher)
    const r = (await exec(tools, { url: 'https://example.com' })) as {
      ok: boolean
      content: string
      truncated: boolean
    }
    expect(r.ok).toBe(true)
    expect(r.truncated).toBe(true)
    expect(r.content.length).toBeLessThanOrEqual(50_000)
  })
})
