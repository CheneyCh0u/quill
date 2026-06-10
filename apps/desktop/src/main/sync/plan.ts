import type { SyncEntry, SyncStatus } from '@quill/shared-types'

/** Map of POSIX relative path → content sha256 hex. */
export type HashMap = Record<string, string>

/**
 * Three-way comparison of local / remote / last-synced hashes.
 * Returns only out-of-sync paths, sorted; `synced` is implicit absence.
 * Pure — all I/O (scanning, fetching, the lastSync store) lives in the
 * engine so this table stays trivially testable.
 */
export function computeSyncPlan(
  local: HashMap,
  remote: HashMap,
  lastSync: HashMap
): SyncEntry[] {
  const paths = new Set<string>([
    ...Object.keys(local),
    ...Object.keys(remote),
    ...Object.keys(lastSync)
  ])
  const entries: SyncEntry[] = []
  for (const path of paths) {
    const status = statusFor(local[path], remote[path], lastSync[path])
    if (status !== 'synced') entries.push({ path, status })
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path))
}

function statusFor(
  local: string | undefined,
  remote: string | undefined,
  base: string | undefined
): SyncStatus {
  if (local !== undefined && remote !== undefined) {
    if (local === remote) return 'synced' // includes "both changed identically"
    if (base === undefined) return 'conflict' // independent creations differ
    if (local === base) return 'remote-modified'
    if (remote === base) return 'local-modified'
    return 'conflict'
  }
  if (local !== undefined) {
    // remote missing
    if (base === undefined) return 'local-only'
    return local === base ? 'remote-deleted' : 'conflict'
  }
  if (remote !== undefined) {
    // local missing
    if (base === undefined) return 'cloud-only'
    return remote === base ? 'local-deleted' : 'conflict'
  }
  // Gone everywhere — stale tombstone, nothing to do.
  return 'synced'
}
