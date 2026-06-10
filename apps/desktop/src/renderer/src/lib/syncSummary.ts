import type { SyncEntry, SyncStatus } from '../types'

const PUSH_STATUSES: ReadonlySet<SyncStatus> = new Set([
  'local-modified',
  'local-only',
  'local-deleted'
])
const PULL_STATUSES: ReadonlySet<SyncStatus> = new Set([
  'remote-modified',
  'cloud-only',
  'remote-deleted'
])

export type SyncSummary = {
  pushable: SyncEntry[]
  pullable: SyncEntry[]
  conflicts: SyncEntry[]
  /** Nothing pending in either direction and no conflicts. */
  clean: boolean
}

export function summarizeSync(entries: SyncEntry[]): SyncSummary {
  const pushable = entries.filter((e) => PUSH_STATUSES.has(e.status))
  const pullable = entries.filter((e) => PULL_STATUSES.has(e.status))
  const conflicts = entries.filter((e) => e.status === 'conflict')
  return { pushable, pullable, conflicts, clean: entries.length === 0 }
}

/** Per-file label in the popover diff list. */
export const SYNC_STATUS_LABELS: Record<SyncStatus, string> = {
  synced: '已同步',
  'local-modified': '已修改',
  'local-only': '新增',
  'local-deleted': '本地已删',
  'remote-modified': '云端更新',
  'cloud-only': '云端新增',
  'remote-deleted': '云端已删',
  conflict: '冲突'
}
