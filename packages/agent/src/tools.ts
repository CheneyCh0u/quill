import { tool } from 'ai'
import { z } from 'zod'
import { promises as fs } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import type { Dirent } from 'node:fs'
import { isSupportedTextFile, isViewableFile } from '@quill/shared-types'
import { inScope, type Scope } from './scope'
import type { ApprovalPayload, ApprovalResponse } from './approvals'
import { checkUrl } from './url-guard'
import { extractText } from './html-extract'

export type ApprovalRequester = (
  toolCallId: string,
  payload: ApprovalPayload
) => Promise<ApprovalResponse>

/** Injected for tests; defaults to global fetch in production. */
export type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>

const WEB_FETCH_TIMEOUT_MS = 15_000
const WEB_FETCH_BODY_CAP = 100_000 // bytes consumed from the wire
const WEB_FETCH_CONTENT_CAP = 50_000 // chars handed to the model

const MAX_RESULTS = 50
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '__pycache__',
  'dist',
  'build',
  'target',
  '.next',
  '.cache',
  'out',
  'release'
])

/**
 * Resolve a user-supplied path against the scope and verify it stays inside.
 * Throws a string error meant to be returned to the model as a tool error so
 * it can self-correct.
 */
function resolveInScope(scope: Scope, userPath: string): string {
  if (scope.kind === 'untitled') {
    throw new Error('untitled scope has no file system access')
  }
  const base = scope.kind === 'workspace' ? scope.root : dirname(scope.path)
  const abs = resolve(base, userPath)
  if (!inScope(scope, abs)) {
    throw new Error(`path "${userPath}" is outside the agent scope`)
  }
  return abs
}

/**
 * Walk all files in scope, depth-first. Hidden dirs and common ignore dirs
 * (node_modules, .git, etc.) are skipped. Stops early when cb signals stop
 * by returning true.
 */
async function walkScope(
  scope: Scope,
  cb: (filePath: string) => Promise<boolean | void>,
  rootOverride?: string
): Promise<void> {
  if (scope.kind === 'untitled') return
  if (scope.kind === 'single-file') {
    await cb(scope.path)
    return
  }
  const root = rootOverride ?? scope.root
  let stopped = false
  async function walk(dir: string): Promise<void> {
    if (stopped) return
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (stopped) return
      if (e.name.startsWith('.')) continue
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        await walk(join(dir, e.name))
      } else if (e.isFile()) {
        const stop = await cb(join(dir, e.name))
        if (stop) stopped = true
      }
    }
  }
  await walk(root)
}

export function makeTools(
  scope: Scope,
  requestApproval: ApprovalRequester,
  fetcher: Fetcher = (input, init) => fetch(input, init)
) {
  return {
    read_file: tool({
      description:
        'Read the full text content of a file inside the agent scope. Provide an absolute path (recommended) or one relative to the scope root.',
      inputSchema: z.object({
        path: z.string().describe('Absolute or scope-relative path to the file')
      }),
      execute: async ({ path }) => {
        try {
          const abs = resolveInScope(scope, path)
          if (isViewableFile(abs)) {
            return {
              ok: false,
              error: `"${path}" is a binary viewable file (image/pdf) — cannot be read as text`
            }
          }
          const content = await fs.readFile(abs, 'utf-8')
          return { ok: true, path: abs, content }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }
    }),

    list_dir: tool({
      description:
        'List entries (files and folders) in a directory inside scope. Omit `path` to list the scope root.',
      inputSchema: z.object({
        path: z
          .string()
          .optional()
          .describe('Directory to list. Defaults to scope root.')
      }),
      execute: async ({ path }) => {
        if (scope.kind === 'untitled') {
          return { ok: false, error: 'untitled scope has no file system access' }
        }
        try {
          const target = path
            ? resolveInScope(scope, path)
            : scope.kind === 'workspace'
              ? scope.root
              : dirname(scope.path)
          const entries = await fs.readdir(target, { withFileTypes: true })
          return {
            ok: true,
            path: target,
            entries: entries
              .filter((e) => !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
              .map((e) => ({
                name: e.name,
                type: e.isDirectory() ? ('dir' as const) : ('file' as const)
              }))
          }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }
    }),

    search_in_scope: tool({
      description:
        'Case-insensitive substring search across all text files in the scope (markdown, code, plain text). Binary files are skipped. Returns matching file paths and line numbers. Capped at 50 results.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Substring to search for')
      }),
      execute: async ({ query }) => {
        if (scope.kind === 'untitled') {
          return { ok: false, error: 'untitled scope has no file system access' }
        }
        const needle = query.toLowerCase()
        const matches: Array<{ path: string; line: number; text: string }> = []
        await walkScope(scope, async (filePath) => {
          if (!isSupportedTextFile(filePath)) return
          try {
            const content = await fs.readFile(filePath, 'utf-8')
            const lines = content.split('\n')
            for (let i = 0; i < lines.length; i++) {
              if (matches.length >= MAX_RESULTS) return true
              if (lines[i].toLowerCase().includes(needle)) {
                matches.push({
                  path: filePath,
                  line: i + 1,
                  text: lines[i].trim().slice(0, 200)
                })
              }
            }
          } catch {
            /* skip unreadable file */
          }
          return false
        })
        return {
          ok: true,
          matches,
          truncated: matches.length >= MAX_RESULTS
        }
      }
    }),

    grep: tool({
      description:
        'Regex grep across files in scope (or a subset). Pattern is JS regex source without delimiters; case-insensitive. Optional `path` limits to a single file or subdirectory. Capped at 50 results.',
      inputSchema: z.object({
        pattern: z.string().min(1).describe('JS regex source, e.g. "TODO|FIXME"'),
        path: z
          .string()
          .optional()
          .describe('Optional file or subdirectory to limit search to')
      }),
      execute: async ({ pattern, path: userPath }) => {
        if (scope.kind === 'untitled') {
          return { ok: false, error: 'untitled scope has no file system access' }
        }
        let re: RegExp
        try {
          re = new RegExp(pattern, 'i')
        } catch (err) {
          return {
            ok: false,
            error: `invalid regex: ${err instanceof Error ? err.message : String(err)}`
          }
        }
        const matches: Array<{ path: string; line: number; text: string }> = []
        const processFile = async (filePath: string): Promise<boolean | void> => {
          try {
            const content = await fs.readFile(filePath, 'utf-8')
            const lines = content.split('\n')
            for (let i = 0; i < lines.length; i++) {
              if (matches.length >= MAX_RESULTS) return true
              if (re.test(lines[i])) {
                matches.push({
                  path: filePath,
                  line: i + 1,
                  text: lines[i].trim().slice(0, 200)
                })
              }
            }
          } catch {
            /* skip */
          }
          return false
        }

        if (userPath) {
          let targetPath: string
          try {
            targetPath = resolveInScope(scope, userPath)
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) }
          }
          const stat = await fs.stat(targetPath).catch(() => null)
          if (!stat) return { ok: false, error: 'path not found' }
          if (stat.isFile()) {
            await processFile(targetPath)
          } else {
            await walkScope(scope, processFile, targetPath)
          }
        } else {
          await walkScope(scope, processFile)
        }
        return {
          ok: true,
          matches,
          truncated: matches.length >= MAX_RESULTS
        }
      }
    }),

    write_file: tool({
      description:
        'Replace the entire contents of a file inside scope. Use this for big rewrites; prefer apply_edit for small substring changes to save tokens. The user must approve each call before disk is touched.',
      inputSchema: z.object({
        path: z.string().describe('Absolute or scope-relative path'),
        content: z.string().describe('New full file content')
      }),
      execute: async ({ path, content }, { toolCallId }) => {
        let abs: string
        try {
          abs = resolveInScope(scope, path)
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
        const decision = await requestApproval(toolCallId, {
          kind: 'write_file',
          path: abs,
          content
        })
        if (!decision.approved) {
          return { ok: false, error: decision.reason ?? 'user denied' }
        }
        try {
          await fs.mkdir(dirname(abs), { recursive: true })
          await fs.writeFile(abs, content, 'utf-8')
          return { ok: true, path: abs }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }
    }),

    apply_edit: tool({
      description:
        'Replace one occurrence of an exact substring inside a file. `old_text` must match a unique span (verbatim, including whitespace). Errors if old_text is missing or appears more than once — in that case widen old_text with surrounding context until unique. The user must approve before disk is touched.',
      inputSchema: z.object({
        path: z.string().describe('Absolute or scope-relative path'),
        old_text: z.string().min(1).describe('Exact substring to find (must be unique)'),
        new_text: z.string().describe('Replacement text')
      }),
      execute: async ({ path, old_text, new_text }, { toolCallId }) => {
        let abs: string
        try {
          abs = resolveInScope(scope, path)
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
        let current: string
        try {
          current = await fs.readFile(abs, 'utf-8')
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
        const first = current.indexOf(old_text)
        if (first === -1) {
          return { ok: false, error: 'old_text not found in file' }
        }
        const second = current.indexOf(old_text, first + 1)
        if (second !== -1) {
          return {
            ok: false,
            error: 'old_text matches multiple locations; widen it with surrounding context to be unique'
          }
        }
        const next = current.slice(0, first) + new_text + current.slice(first + old_text.length)
        const decision = await requestApproval(toolCallId, {
          kind: 'apply_edit',
          path: abs,
          old_text,
          new_text
        })
        if (!decision.approved) {
          return { ok: false, error: decision.reason ?? 'user denied' }
        }
        try {
          await fs.writeFile(abs, next, 'utf-8')
          return { ok: true, path: abs }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }
    }),

    create_file: tool({
      description:
        'Create a new file inside scope. Errors if the file already exists — use write_file or apply_edit instead. Intermediate directories are created as needed. The user must approve before disk is touched.',
      inputSchema: z.object({
        path: z.string().describe('Absolute or scope-relative path to the new file'),
        content: z.string().describe('Initial file content')
      }),
      execute: async ({ path, content }, { toolCallId }) => {
        let abs: string
        try {
          abs = resolveInScope(scope, path)
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
        // Pre-check existence so we never ask the user to approve a doomed call.
        const exists = await fs
          .stat(abs)
          .then(() => true)
          .catch(() => false)
        if (exists) {
          return { ok: false, error: `file already exists: ${abs}` }
        }
        const decision = await requestApproval(toolCallId, {
          kind: 'create_file',
          path: abs,
          content
        })
        if (!decision.approved) {
          return { ok: false, error: decision.reason ?? 'user denied' }
        }
        try {
          await fs.mkdir(dirname(abs), { recursive: true })
          // 'wx' = fail if exists. Belt-and-suspenders against a race.
          await fs.writeFile(abs, content, { encoding: 'utf-8', flag: 'wx' })
          return { ok: true, path: abs }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }
    }),

    delete_file: tool({
      description:
        'Delete a single file inside scope. Errors if the path is a directory — use delete_dir for folders. The user must approve before disk is touched. Deletion is permanent (no trash).',
      inputSchema: z.object({
        path: z.string().describe('Absolute or scope-relative path to the file')
      }),
      execute: async ({ path }, { toolCallId }) => {
        let abs: string
        try {
          abs = resolveInScope(scope, path)
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
        // Pre-check so we never ask the user to approve a doomed call.
        const stat = await fs.stat(abs).catch(() => null)
        if (!stat) {
          return { ok: false, error: `path not found: ${abs}` }
        }
        if (stat.isDirectory()) {
          return { ok: false, error: `"${path}" is a directory — use delete_dir instead` }
        }
        const decision = await requestApproval(toolCallId, {
          kind: 'delete_file',
          path: abs
        })
        if (!decision.approved) {
          return { ok: false, error: decision.reason ?? 'user denied' }
        }
        try {
          await fs.rm(abs)
          return { ok: true, path: abs }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }
    }),

    delete_dir: tool({
      description:
        'Delete a folder and everything inside it, recursively, inside scope. Errors if the path is a file — use delete_file instead. The user must approve before disk is touched. Deletion is permanent (no trash).',
      inputSchema: z.object({
        path: z.string().describe('Absolute or scope-relative path to the folder')
      }),
      execute: async ({ path }, { toolCallId }) => {
        let abs: string
        try {
          abs = resolveInScope(scope, path)
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
        if (scope.kind === 'workspace' && abs === scope.root) {
          return { ok: false, error: 'cannot delete the scope root folder' }
        }
        const stat = await fs.stat(abs).catch(() => null)
        if (!stat) {
          return { ok: false, error: `path not found: ${abs}` }
        }
        if (!stat.isDirectory()) {
          return { ok: false, error: `"${path}" is a file — use delete_file instead` }
        }
        const entryCount = (await fs.readdir(abs, { recursive: true })).length
        const decision = await requestApproval(toolCallId, {
          kind: 'delete_dir',
          path: abs,
          entryCount
        })
        if (!decision.approved) {
          return { ok: false, error: decision.reason ?? 'user denied' }
        }
        try {
          await fs.rm(abs, { recursive: true })
          return { ok: true, path: abs }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }
    }),

    web_fetch: tool({
      description:
        "Fetch a URL and return its text content. Use this when the user pastes a link or refers to one. Returns ok:false on errors (bad URL, blocked private/loopback host, non-2xx status, network failure, unsupported content type like PDF or images); surface the error to the user instead of silently retrying. HTML pages are stripped of script/style/nav and title is extracted. Content capped at ~50KB.",
      inputSchema: z.object({
        url: z.string().describe('Full http(s) URL')
      }),
      execute: async ({ url }) => {
        const guard = checkUrl(url)
        if (!guard.ok) return { ok: false, error: guard.error }

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), WEB_FETCH_TIMEOUT_MS)
        let res: Response
        try {
          res = await fetcher(guard.url, {
            redirect: 'follow',
            signal: controller.signal,
            headers: { 'user-agent': 'Quill-Agent/1.0' }
          })
        } catch (err) {
          clearTimeout(timer)
          if (controller.signal.aborted) {
            return { ok: false, error: `fetch timed out after ${WEB_FETCH_TIMEOUT_MS / 1000}s` }
          }
          return {
            ok: false,
            error: `network error: ${err instanceof Error ? err.message : String(err)}`
          }
        }
        clearTimeout(timer)

        if (!res.ok) {
          return { ok: false, error: `fetch returned HTTP ${res.status}` }
        }

        const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
        const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml')
        const isJson = contentType.includes('application/json')
        const isPlain = contentType.startsWith('text/') && !isHtml
        if (!isHtml && !isJson && !isPlain) {
          return { ok: false, error: `unsupported content type: ${contentType || 'unknown'}` }
        }

        // Read up to WEB_FETCH_BODY_CAP bytes; reject huge bodies early.
        let raw: string
        try {
          raw = await readBodyCapped(res, WEB_FETCH_BODY_CAP)
        } catch (err) {
          return {
            ok: false,
            error: `read error: ${err instanceof Error ? err.message : String(err)}`
          }
        }

        let title: string | undefined
        let content: string
        if (isHtml) {
          const extracted = extractText(raw)
          title = extracted.title
          content = extracted.text
        } else if (isJson) {
          try {
            content = JSON.stringify(JSON.parse(raw), null, 2)
          } catch {
            content = raw
          }
        } else {
          content = raw
        }

        const overCap = content.length > WEB_FETCH_CONTENT_CAP
        if (overCap) content = content.slice(0, WEB_FETCH_CONTENT_CAP)

        return {
          ok: true,
          url: res.url || guard.url.toString(),
          status: res.status,
          contentType,
          title,
          content,
          truncated: overCap || raw.length >= WEB_FETCH_BODY_CAP
        }
      }
    })
  }
}

async function readBodyCapped(res: Response, cap: number): Promise<string> {
  // Prefer streaming so a multi-MB response doesn't allocate fully. If the
  // platform doesn't expose a reader (rare in our Electron/Bun targets),
  // fall back to .text() and slice.
  const reader = res.body?.getReader()
  if (!reader) {
    const t = await res.text()
    return t.slice(0, cap)
  }
  const decoder = new TextDecoder('utf-8', { fatal: false })
  let out = ''
  while (out.length < cap) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) {
      out += decoder.decode(value, { stream: true })
    }
  }
  out += decoder.decode()
  return out.slice(0, cap)
}

export type AgentTools = ReturnType<typeof makeTools>
