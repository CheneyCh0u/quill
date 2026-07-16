import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Menu, Settings as SettingsIcon, Sparkles, X } from 'lucide-react'
import { getFileType, type FileNode, type Scope, type Workspace } from '@quill/shared-types'
import { AgentPanel } from '../components/AgentPanel'
import { DownloadMenu } from '../components/DownloadMenu'
import { Editor } from '../components/Editor'
import { FileTree, type FileTreeHandle } from '../components/FileTree'
import { ModeSwitcher, type ViewMode } from '../components/ModeSwitcher'
import { Outline, OutlineSheetButton } from '../components/Outline'
import { Preview } from '../components/Preview'
import { WorkspaceSwitcher } from '../components/WorkspaceSwitcher'
import { RemoteVault, UnauthorizedError } from '@quill/vault-adapter'
import { notifyUnauthorized } from '../lib/auth-events'
import { useDialogs } from '../lib/dialogs'
import { useAgentSession } from '../lib/use-agent-session'
import {
  createWorkspace,
  fetchWorkspaces,
  pickActiveWorkspace,
  readStoredWorkspaceId,
  storeWorkspaceId
} from '../lib/workspaces'

type SaveStatus = 'idle' | 'saving' | 'saved' | { error: string }

export function Vault(): JSX.Element {
  const navigate = useNavigate()
  const dialogs = useDialogs()
  // Cloud workspace the whole page is scoped to. null until the registry
  // loads — the file tree waits for it (a tree against the vault root
  // would flash content from other workspaces).
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  useEffect(() => {
    let cancelled = false
    fetchWorkspaces()
      .then((list) => {
        if (cancelled) return
        setWorkspaces(list)
        setWorkspace(pickActiveWorkspace(list, readStoredWorkspaceId()))
      })
      .catch(() => {
        /* 401 already routed to login via notifyUnauthorized */
      })
    return () => {
      cancelled = true
    }
  }, [])

  const vault = useMemo(
    () =>
      new RemoteVault({
        onUnauthorized: notifyUnauthorized,
        rootPath: workspace?.remotePath ?? ''
      }),
    [workspace]
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
    // Sessions live per cloud workspace — switching workspaces loads
    // that workspace's active session (the old behavior was a hard reset).
    workspaceId: workspace?.id,
    onActivityComplete: () => {
      fileTreeRef.current?.refresh().catch(() => undefined)
      void reloadCurrentFileFromDisk()
    }
  })

  const dirty = buffer !== source

  // Workspace switch tears the whole page context down: file selection,
  // buffers, and the agent conversation (its permission scope changed).
  const switchWorkspace = useCallback(
    async (ws: Workspace): Promise<boolean> => {
      if (dirty) {
        const ok = await dialogs.confirm({
          title: '放弃未保存的修改',
          message: '当前文件有未保存的修改，确认放弃并切换工作区？',
          confirmText: '放弃',
          danger: true
        })
        if (!ok) return false
      }
      setWorkspace(ws)
      storeWorkspaceId(ws.id)
      setSelected(null)
      setSource('')
      setBuffer('')
      setLoadErr(null)
      return true
    },
    [dirty, dialogs]
  )

  const handleCreateWorkspace = useCallback(async (): Promise<void> => {
    const name = await dialogs.prompt({
      title: '新建工作区',
      label: '名称（即 vault 根下的目录名）',
      placeholder: 'research',
      confirmText: '创建并切换',
      validate: (v) =>
        /^[^/\\]+$/.test(v.trim()) && v.trim() !== '' ? null : '名称不能为空或包含斜杠'
    })
    if (!name?.trim()) return
    try {
      const ws = await createWorkspace(name.trim())
      setWorkspaces((prev) => [...prev, ws])
      await switchWorkspace(ws)
    } catch (err) {
      await dialogs.alert({
        title: '创建失败',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }, [dialogs, switchWorkspace])

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
    // Non-markdown text files have no preview, so opening them in 'edit'
    // mode skips a meaningless ModeSwitcher click.
    setMode(node.isMarkdown ? 'preview' : 'edit')
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
            className="md:hidden text-[var(--ink-soft)] p-1"
            aria-label="关闭侧栏"
          >
            <X className="w-4 h-4" />
          </button>
          {workspace ? (
            <WorkspaceSwitcher
              workspaces={workspaces}
              active={workspace}
              onSwitch={switchWorkspace}
              onCreate={() => void handleCreateWorkspace()}
            />
          ) : (
            <span className="font-display text-lg text-[var(--ink)] flex-1">Quill</span>
          )}
        </div>
        <div className="flex-1 overflow-hidden">
          {workspace === null ? (
            <p className="px-4 py-3 text-sm text-[var(--ink-faint)]">加载工作区…</p>
          ) : (
          <FileTree
            key={workspace.id}
            ref={fileTreeRef}
            vault={vault}
            selectedPath={selected?.path ?? null}
            onSelect={trySwitchFile}
            onPathRenamed={(oldPath, newPath) => {
              // If the renamed path is the open file, fold the new path into
              // selected so the editor header updates without reloading.
              // Re-derive isMarkdown/isText from the new extension since
              // rename can flip the file type (e.g. foo.md → foo.txt).
              if (selected && selected.path === oldPath) {
                const info = getFileType(newPath)
                setSelected({
                  ...selected,
                  path: newPath,
                  name: newPath.split('/').pop() ?? newPath,
                  isMarkdown: info.isMarkdown,
                  isText: info.isText
                })
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
          )}
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
            <Menu className="w-4 h-4" />
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
              {/* Markdown-specific UI: preview/edit toggle, outline button
                  on H5, and the markdown→HTML/PDF download menu. Hidden
                  for plain text / code files where they don't apply. */}
              {selected.isMarkdown && (
                <>
                  <ModeSwitcher value={mode} onChange={setMode} />
                  {mode === 'preview' && (
                    <OutlineSheetButton source={buffer} containerRef={previewScrollRef} />
                  )}
                  <DownloadMenu filePath={selected.path} content={buffer} />
                </>
              )}
            </>
          )}
          <button
            type="button"
            onClick={() => setAiOpen((o) => !o)}
            aria-pressed={aiOpen}
            title="AI 面板"
            aria-label="AI 面板"
            className={[
              'rounded p-1.5 transition-colors',
              aiOpen
                ? 'bg-[var(--accent-soft)] text-[var(--ink)]'
                : 'text-[var(--ink-faint)] hover:text-[var(--ink)] hover:bg-[var(--paper-soft)]'
            ].join(' ')}
          >
            <Sparkles className="w-4 h-4" />
          </button>
          <Link
            to="/settings"
            title="设置"
            aria-label="设置"
            className="text-[var(--ink-faint)] hover:text-[var(--ink)] hover:bg-[var(--paper-soft)] rounded p-1.5 leading-none"
          >
            <SettingsIcon className="w-4 h-4" />
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
                在左侧选择一个文件
              </div>
            )}
            {selected && !loadErr && (
              mode === 'edit' ? (
                <Editor
                  value={buffer}
                  onChange={setBuffer}
                  onSave={handleSave}
                  filePath={selected.path}
                />
              ) : (
                <Preview source={buffer} />
              )
            )}
          </div>
          {/* Side outline rail — md+ only, only in preview mode (the
              editor view doesn't have stable heading anchors to scroll
              to). Hidden for non-markdown files where Outline has nothing
              to extract. Hides itself further when the document has no
              headings. */}
          {selected?.isMarkdown && !loadErr && mode === 'preview' && (
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
            workspaceId={workspace?.id}
            workspaceLabel={workspace?.remotePath}
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
