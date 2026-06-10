import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { HashMap } from './plan'

/**
 * Per-workspace sync state, stored INSIDE the folder at .quill/sync.json
 * (not in app data) so the binding survives moving / copying the folder
 * to another machine. Holds the space binding plus the hash every file
 * had at last successful sync — the comparison base for plan.ts.
 */
export type SyncFile = {
  spaceId: string
  serverUrl: string
  remotePath: string
  lastSyncAt: number | null
  lastSync: HashMap
}

function fileFor(root: string): string {
  return join(root, '.quill', 'sync.json')
}

export async function readSyncFile(root: string): Promise<SyncFile | null> {
  let raw: string
  try {
    raw = await fs.readFile(fileFor(root), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as SyncFile
    if (!parsed || typeof parsed.spaceId !== 'string') return null
    return parsed
  } catch {
    // Corrupt metadata reads as "not bound" — the user can re-enable;
    // real notes are never touched by this file.
    return null
  }
}

export async function writeSyncFile(root: string, data: SyncFile): Promise<void> {
  const file = fileFor(root)
  await fs.mkdir(join(root, '.quill'), { recursive: true })
  const tmp = file + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  await fs.rename(tmp, file)
}

export async function removeSyncFile(root: string): Promise<void> {
  await fs.rm(fileFor(root), { force: true })
}
