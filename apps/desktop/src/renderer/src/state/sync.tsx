import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { useApp } from './app'
import { usePrefs } from './prefs'
import { ipc } from '../lib/ipc'
import type { SyncSnapshot, Workspace } from '../types'
import { summarizeSync, type SyncSummary } from '../lib/syncSummary'

export type SyncBusy = 'check' | 'push' | 'pull' | 'enable' | 'resolve' | null

type Ctx = {
  /** Workspace root when sync applies (local folder workspace only);
   *  null hides the whole sync UI (single file / remote / empty). */
  root: string | null
  /** null = not checked yet for this workspace. */
  snapshot: SyncSnapshot | null
  summary: SyncSummary
  busy: SyncBusy
  error: string | null
  /** Saved server URL + token exist (Settings → 远程). */
  serverConfigured: boolean
  refresh: () => Promise<void>
  push: () => Promise<void>
  pull: () => Promise<void>
  enable: (name: string, remotePath: string) => Promise<void>
  bindExisting: (space: Workspace) => Promise<void>
  resolve: (path: string, keep: 'local' | 'remote') => Promise<void>
  disable: () => Promise<void>
  listSpaces: () => Promise<Workspace[]>
}

const SyncContext = createContext<Ctx | null>(null)

export function SyncProvider({ children }: { children: ReactNode }) {
  const { state } = useApp()
  const { prefs } = usePrefs()
  const root = state.workspace?.kind === 'local' ? state.workspace.rootPath : null

  const [snapshot, setSnapshot] = useState<SyncSnapshot | null>(null)
  const [busy, setBusy] = useState<SyncBusy>(null)
  const [error, setError] = useState<string | null>(null)
  const [serverConfigured, setServerConfigured] = useState(false)

  // Refs mirror the latest values for timer callbacks (avoids re-arming
  // the interval on every snapshot change).
  const rootRef = useRef(root)
  rootRef.current = root
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const busyRef = useRef(busy)
  busyRef.current = busy

  /** Run an action against the current root, guarding stale responses
   *  (workspace may switch while a request is in flight). */
  const run = useCallback(
    async (kind: Exclude<SyncBusy, null>, fn: (root: string) => Promise<SyncSnapshot>) => {
      const r = rootRef.current
      if (!r || busyRef.current) return
      setBusy(kind)
      setError(null)
      try {
        const snap = await fn(r)
        if (rootRef.current === r) setSnapshot(snap)
      } catch (err) {
        if (rootRef.current === r) {
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        setBusy(null)
      }
    },
    []
  )

  const refresh = useCallback(() => run('check', (r) => ipc.sync.status(r)), [run])
  const push = useCallback(() => run('push', (r) => ipc.sync.push(r)), [run])
  const pull = useCallback(() => run('pull', (r) => ipc.sync.pull(r)), [run])
  const enable = useCallback(
    (name: string, remotePath: string) =>
      run('enable', async (r) => {
        await ipc.sync.enable({ root: r, name, remotePath })
        // 「开启同步并首次推送」— enabling immediately uploads the folder.
        return ipc.sync.push(r)
      }),
    [run]
  )
  const bindExisting = useCallback(
    (space: Workspace) =>
      run('enable', async (r) => {
        await ipc.sync.bind({ root: r, space })
        // Binding an existing space is the "pull it down" flow.
        return ipc.sync.pull(r)
      }),
    [run]
  )
  const resolve = useCallback(
    (path: string, keep: 'local' | 'remote') =>
      run('resolve', (r) => ipc.sync.resolve({ root: r, path, keep })),
    [run]
  )
  const disable = useCallback(async () => {
    const r = rootRef.current
    if (!r) return
    setError(null)
    try {
      await ipc.sync.disable({ root: r, removeSpace: false })
      if (rootRef.current === r) setSnapshot({ state: 'disabled' })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])
  const listSpaces = useCallback(() => ipc.sync.spaces(), [])

  // Workspace switched — reset and re-check.
  useEffect(() => {
    setSnapshot(null)
    setError(null)
    if (!root) return
    void Promise.all([ipc.remote.getUrl(), ipc.remote.getToken()]).then(([u, t]) => {
      if (rootRef.current === root) setServerConfigured(!!u && !!t)
    })
    void refresh()
  }, [root, refresh])

  // A completed save changes local hashes — re-check shortly after so the
  // indicator flips to "pending" without waiting for the next timer tick.
  const saving = state.saving
  const prevSaving = useRef(saving)
  useEffect(() => {
    const wasSaving = prevSaving.current
    prevSaving.current = saving
    if (!wasSaving || saving) return
    if (snapshotRef.current?.state !== 'ready') return
    const t = setTimeout(() => void refresh(), 1500)
    return () => clearTimeout(t)
  }, [saving, refresh])

  // Auto-sync: refresh on a timer and push/pull whatever is pending.
  // Conflicts never auto-resolve — the engine skips them by design.
  useEffect(() => {
    if (!prefs.autoSync || !root) return
    const tick = async (): Promise<void> => {
      if (busyRef.current) return
      await refresh()
      const snap = snapshotRef.current
      if (snap?.state !== 'ready') return
      const s = summarizeSync(snap.entries)
      if (s.pushable.length > 0) await push()
      const after = snapshotRef.current
      if (after?.state === 'ready' && summarizeSync(after.entries).pullable.length > 0) {
        await pull()
      }
    }
    const id = setInterval(() => void tick(), prefs.autoSyncIntervalMin * 60_000)
    return () => clearInterval(id)
  }, [prefs.autoSync, prefs.autoSyncIntervalMin, root, refresh, push, pull])

  const summary = useMemo(
    () => summarizeSync(snapshot?.state === 'ready' ? snapshot.entries : []),
    [snapshot]
  )

  return (
    <SyncContext.Provider
      value={{
        root,
        snapshot,
        summary,
        busy,
        error,
        serverConfigured,
        refresh,
        push,
        pull,
        enable,
        bindExisting,
        resolve,
        disable,
        listSpaces
      }}
    >
      {children}
    </SyncContext.Provider>
  )
}

export function useSync(): Ctx {
  const ctx = useContext(SyncContext)
  if (!ctx) throw new Error('useSync must be used inside SyncProvider')
  return ctx
}
