import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { FileNode, Scope } from '@quill/shared-types'
import { AgentPanel } from '../components/AgentPanel'
import { DownloadMenu } from '../components/DownloadMenu'
import { Editor } from '../components/Editor'
import { FileTree, type FileTreeHandle } from '../components/FileTree'
import { ModeSwitcher, type ViewMode } from '../components/ModeSwitcher'
import { Outline, OutlineSheetButton } from '../components/Outline'
import { Preview } from '../components/Preview'
import { RemoteVault, UnauthorizedError } from '@quill/vault-adapter'
import { logout } from '../lib/auth'
import { notifyUnauthorized } from '../lib/auth-events'
import { useDialogs } from '../lib/dialogs'
import { useAgentSession } from '../lib/use-agent-session'

type SaveStatus = 'idle' | 'saving' | 'saved' | { error: string }

export function Vault(): JSX.Element {
  const navigate = useNavigate()
  const dialogs = useDialogs()
  const vault = useMemo(
    () => new RemoteVault({ onUnauthorized: notifyUnauthorized }),
    []
  )
  const [selected, setSelected] = useState<FileNode | null>(null)
  // `source` is the last-known disk content (what the server saw last);
  // `buffer` is the user's in-progress edits. dirty := source !== buffer.
  const [source, setSource] = useState<string>('')
  const [buffer, setBuffer] = useState<string>('')
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [mode, setMode] = useState<ViewMode>('preview')
  const [save, setSave] = useState<SaveStatus>('idle')
  const [aiOpen, setAiOpen] = useState(false)
  const fileTreeRef = useRef<FileTreeHandle | null>(null)
  // Preview's scroll container — Outline targets this when scrolling to
  // a heading, so heading lookups stay scoped (no false matches on the
  // rest of the page).
  const previewScrollRef = useRef<HTMLDivElement | null>(null)

  // The server overrides scope.root with its configured vault path. We
  // send a placeholder so the protocol's required field is satisfied.
  const agentScope: Scope = useMemo(
    () => ({ kind: 'workspace', root: '<vault>' }),
    []
  )

  // Agent session owned at this level (not inside AgentPanel) so the
  // conversation survives the AI panel being toggled closed. It also
  // persists settled turns to localStorage so a hard reload keeps them.
  // When a run finishes, refresh the file tree — the agent may have
  // written or deleted files via tool calls.
  const reloadCurrentFileFromDisk = useCallback(async () => {
    if (!selected) return
    try {
      const fresh = await vault.read(selected.path)
      setSource(fresh)
      // Only blow away the user's buffer if it was the same as source —
      // i.e. they haven't typed anything since last save. Otherwise the
      // agent's write goes into `source` so the dirty indicator surfaces
      // the conflict, but the user's typing stays intact.
      setBuffer((curBuf) => (curBuf === source ? fresh : curBuf))
    } catch {
      /* file may have been deleted by the agent — let the next interaction surface that */
    }
  }, [selected, vault, source])

  const agent = useAgentSession({
    onActivityComplete: () => {
      fileTreeRef.current?.refresh().catch(() => undefined)
      void reloadCurrentFileFromDisk()
    }
  })

  const dirty = buffer !== source

  // Load source whenever the selected file changes.
  useEffect(() => {
    if (!selected) return
    let cancelled = false
    setSave('idle')
    vault
      .read(selected.path)
      .then((text) => {
        if (cancelled) return
        setSource(text)
        setBuffer(text)
        setLoadErr(null)
      })
      .catch((err) => {
        if (cancelled) return
        if (err instanceof UnauthorizedError) {
          navigate('/login', { replace: true })
          return
        }
        setLoadErr(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [selected, vault, navigate])

  const handleSave = useCallback(async (): Promise<void> => {
    if (!selected || !dirty) return
    setSave('saving')
    try {
      await vault.write(selected.path, buffer)
      // The server may have transformed the content (line endings etc.);
      // re-fetch is overkill, just snapshot the buffer as the new source.
      setSource(buffer)
      setSave('saved')
      // Auto-dismiss the "saved" indicator after 2s so the next edit reads
      // back to idle naturally.
      window.setTimeout(() => setSave((s) => (s === 'saved' ? 'idle' : s)), 2000)
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        navigate('/login', { replace: true })
        return
      }
      setSave({ error: err instanceof Error ? err.message : String(err) })
    }
  }, [selected, dirty, buffer, vault, navigate])

  // Global ⌘S handler for when focus isn't on the textarea (e.g. user
  // clicked the preview pane). The Editor component still has its own
  // intercept for keystrokes that hit the textarea directly.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const isSaveCombo =
        (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's'
      if (isSaveCombo) {
        e.preventDefault()
        void handleSave()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleSave])

  // Warn before tab close / refresh when dirty. beforeunload's UI is
  // browser-controlled; we can't customize the message anymore (security
  // sanitization since ~2017) but the prompt still appears.
  useEffect(() => {
    if (!dirty) return
    function onBeforeUnload(e: BeforeUnloadEvent): void {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  async function trySwitchFile(node: FileNode): Promise<void> {
    if (dirty) {
      const ok = await dialogs.confirm({
        title: '放弃未保存的修改',
        message: '当前文件有未保存的修改，确认放弃并切换？',
        confirmText: '放弃',
        danger: true
      })
      if (!ok) return
    }
    setSelected(node)
    setSidebarOpen(false)
    setMode('preview')
  }

  async function onLogout(): Promise<void> {
    if (dirty) {
      const ok = await dialogs.confirm({
        title: '放弃未保存的修改',
        message: '当前文件有未保存的修改，确认登出？',
        confirmText: '登出',
        danger: true
      })
      if (!ok) return
    }
    await logout()
    navigate('/login', { replace: true })
  }

  return (
    <div className="h-[100dvh] flex">
      {/* Sidebar: full-screen drawer on mobile (so iOS Safari chrome
          samples paper-dim and stays light, not the dim-overlay color),
          fixed 72 inline on md+. */}
      <aside
        className={[
          'fixed inset-y-0 left-0 z-20 w-full bg-[var(--paper-dim)] flex flex-col',
          'md:w-72 md:border-r md:border-[var(--rule)]',
          'transition-transform duration-200 md:translate-x-0 md:static md:flex',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        ].join(' ')}
      >
        <div className="h-12 flex items-center gap-2 px-3 border-b border-[var(--rule-soft)]">
          {/* Close button on mobile only — without it the user would have
              to pick a file to dismiss the drawer. */}
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            className="md:hidden text-[var(--ink-soft)] text-lg leading-none px-1"
            aria-label="关闭侧栏"
          >
            ✕
          </button>
          <span className="font-display text-lg text-[var(--ink)] flex-1">
            Quill
          </span>
          <button
            type="button"
            onClick={onLogout}
            className="text-xs text-[var(--ink-faint)] hover:text-[var(--accent)] px-2 py-1"
          >
            登出
          </button>
        </div>
        <div className="flex-1 overflow-hidden">
          <FileTree
            ref={fileTreeRef}
            vault={vault}
            selectedPath={selected?.path ?? null}
            onSelect={trySwitchFile}
            onPathRenamed={(oldPath, newPath) => {
              // If the renamed path is the open file, fold the new path into
              // selected so the editor header updates without reloading.
              if (selected && selected.path === oldPath) {
                setSelected({ ...selected, path: newPath, name: newPath.split('/').pop() ?? newPath })
              }
            }}
            onPathDeleted={(path) => {
              if (selected && (selected.path === path || selected.path.startsWith(`${path}/`))) {
                setSelected(null)
                setSource('')
                setBuffer('')
              }
            }}
          />
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0">
        <header className="h-12 flex items-center gap-3 px-3 border-b border-[var(--rule-soft)]">
          <button
            type="button"
            onClick={() => setSidebarOpen((s) => !s)}
            className="md:hidden text-[var(--ink-soft)] p-2"
            aria-label="切换侧栏"
          >
            ☰
          </button>
          <span className="text-sm text-[var(--ink-soft)] truncate flex items-center gap-1.5 flex-1 min-w-0">
            <span className="truncate">{selected?.path ?? '选择一个文件'}</span>
            {dirty && (
              <span className="text-[var(--accent)] shrink-0" title="未保存">
                •
              </span>
            )}
          </span>
          {selected && (
            <>
              <SaveStatusIndicator status={save} dirty={dirty} onSave={handleSave} />
              <ModeSwitcher value={mode} onChange={setMode} />
              {mode === 'preview' && (
                <OutlineSheetButton source={buffer} containerRef={previewScrollRef} />
              )}
              <DownloadMenu filePath={selected.path} content={buffer} />
            </>
          )}
          <button
            type="button"
            onClick={() => setAiOpen((o) => !o)}
            aria-pressed={aiOpen}
            title="AI"
            className={[
              'text-sm rounded px-2 py-1 transition-colors',
              aiOpen
                ? 'bg-[var(--accent-soft)] text-[var(--ink)]'
                : 'text-[var(--ink-faint)] hover:text-[var(--ink)] hover:bg-[var(--paper-soft)]'
            ].join(' ')}
          >
            AI
          </button>
          <Link
            to="/settings"
            title="设置"
            className="text-base text-[var(--ink-faint)] hover:text-[var(--ink)] hover:bg-[var(--paper-soft)] rounded px-2 py-1 leading-none"
          >
            ⚙
          </Link>
        </header>
        <div className="flex-1 flex min-h-0">
          <div
            ref={previewScrollRef}
            className="flex-1 overflow-y-auto scroll-thin min-w-0"
          >
            {loadErr && (
              <div className="px-6 py-4 text-sm text-[var(--accent)]">{loadErr}</div>
            )}
            {!selected && !loadErr && (
              <div className="flex items-center justify-center h-full text-sm text-[var(--ink-faint)]">
                在左侧选择一个 markdown 文件
              </div>
            )}
            {selected && !loadErr && (
              mode === 'edit' ? (
                <Editor value={buffer} onChange={setBuffer} onSave={handleSave} />
              ) : (
                <Preview source={buffer} />
              )
            )}
          </div>
          {/* Side outline rail — md+ only, only in preview mode (the
              editor view doesn't have stable heading anchors to scroll
              to). Hides itself when the document has no headings. */}
          {selected && !loadErr && mode === 'preview' && (
            <div className="hidden md:block w-48 shrink-0">
              <Outline source={buffer} containerRef={previewScrollRef} />
            </div>
          )}
        </div>
      </main>

      {/* AgentPanel — side rail on md+, full-screen sheet on H5. */}
      {aiOpen && (
        <aside
          className={[
            'fixed inset-0 z-30 md:static md:z-auto md:w-96 md:flex-shrink-0',
            'md:border-l md:border-[var(--rule)]'
          ].join(' ')}
        >
          <AgentPanel
            session={agent}
            scope={agentScope}
            currentBuffer={selected ? buffer : undefined}
            onClose={() => setAiOpen(false)}
          />
        </aside>
      )}
    </div>
  )
}

function SaveStatusIndicator({
  status,
  dirty,
  onSave
}: {
  status: SaveStatus
  dirty: boolean
  onSave: () => void
}): JSX.Element {
  if (status === 'saving') {
    return <span className="text-xs text-[var(--ink-faint)]">保存中…</span>
  }
  if (status === 'saved') {
    return <span className="text-xs text-[var(--ink-faint)]">已保存</span>
  }
  if (typeof status === 'object') {
    return (
      <span className="text-xs text-[var(--accent)]" title={status.error}>
        保存失败
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={onSave}
      disabled={!dirty}
      className="text-xs text-[var(--ink-soft)] hover:text-[var(--ink)] disabled:opacity-40 disabled:cursor-not-allowed px-2 py-1 rounded hover:bg-[var(--paper-dim)]"
      title="保存 (⌘S)"
    >
      保存
    </button>
  )
}
