// Folder-workspace ↔ server cloud sync. Shapes travel desktop-main ↔
// renderer (IPC) and desktop ↔ server (REST), so they live here.

/** Per-file sync status, computed by three-way hash comparison
 *  (local / remote / hash recorded at last sync). Mirrors the model in
 *  docs/web-server.md「同步模型」. */
export type SyncStatus =
  | 'synced'
  | 'local-modified' //  local ≠ lastSync, remote == lastSync   → push
  | 'local-only' //      local exists, no remote, no lastSync   → push
  | 'local-deleted' //   local gone, remote == lastSync         → push (delete)
  | 'remote-modified' // local == lastSync, remote ≠ lastSync   → pull
  | 'cloud-only' //      remote exists, no local, no lastSync   → pull
  | 'remote-deleted' //  remote gone, local == lastSync         → pull (delete)
  | 'conflict' //        both sides diverged from lastSync      → manual

export type SyncEntry = {
  /** POSIX path relative to the workspace root. */
  path: string
  status: SyncStatus
}

/** Registry entry on the server (STATE_DIR/sync-spaces.json). */
export type SyncSpace = {
  id: string
  name: string
  /** Directory under the server vault root this space maps to. */
  remotePath: string
  createdAt: number
}

/** Binding stored inside the workspace folder (.quill/sync.json),
 *  minus the lastSync hash index which never crosses IPC. */
export type SyncBinding = {
  spaceId: string
  serverUrl: string
  remotePath: string
}

/** What the renderer renders. `entries` holds only out-of-sync files. */
export type SyncSnapshot =
  | { state: 'disabled' }
  | { state: 'offline'; binding: SyncBinding; error: string }
  | {
      state: 'ready'
      binding: SyncBinding
      entries: SyncEntry[]
      /** Total tracked files (synced + not), for the "142 个文件" line. */
      fileCount: number
      lastSyncAt: number | null
    }
