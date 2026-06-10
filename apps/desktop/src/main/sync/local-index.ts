import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { HashMap } from './plan'

// Sync metadata, VCS internals and build output never sync.
const SKIP_DIRS = new Set(['.quill', '.git', '.svn', '.hg', 'node_modules'])

// v1 syncs text content only — the server file API is utf-8 text
// (PUT body / GET response), so binaries would be corrupted in transit.
// Skip them by extension; revisit when the server grows a binary PUT.
const BINARY_EXTS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'ico',
  'pdf',
  'zip',
  'gz',
  'tar',
  'mp3',
  'mp4',
  'mov',
  'woff',
  'woff2',
  'ttf',
  'otf'
])

function isBinary(name: string): boolean {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  return BINARY_EXTS.has(ext)
}

/**
 * Walk a workspace folder and hash every syncable file. Hashing matches
 * the server vault (sha256 over raw bytes) so equal content compares
 * equal across the wire.
 */
export async function buildLocalIndex(root: string): Promise<HashMap> {
  const index: HashMap = {}
  async function walk(dir: string, relPrefix: string): Promise<void> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        await walk(join(dir, e.name), rel)
      } else if (e.isFile() && !isBinary(e.name)) {
        const buf = await fs.readFile(join(dir, e.name))
        index[rel] = createHash('sha256').update(buf).digest('hex')
      }
    }
  }
  await walk(root, '')
  return index
}
