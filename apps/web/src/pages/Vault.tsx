import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { FileNode } from '@quill/shared-types'
import { Editor } from '../components/Editor'
import { FileTree } from '../components/FileTree'
import { ModeSwitcher, type ViewMode } from '../components/ModeSwitcher'
import { Preview } from '../components/Preview'
import { RemoteVault, UnauthorizedError } from '../lib/remote-vault'
import { logout } from '../lib/auth'

type SaveStatus = 'idle' | 'saving' | 'saved' | { error: string }

export function Vault(): JSX.Element {
  const navigate = useNavigate()
  const vault = useMemo(() => new RemoteVault(), [])
  const [selected, setSelected] = useState<FileNode | null>(null)
  // `source` is the last-known disk content (what the server saw last);
  // `buffer` is the user's in-progress edits. dirty := source !== buffer.
  const [source, setSource] = useState<string>('')
  const [buffer, setBuffer] = useState<string>('')
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [mode, setMode] = useState<ViewMode>('preview')
  const [save, setSave] = useState<SaveStatus>('idle')

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

  function trySwitchFile(node: FileNode): void {
    if (dirty) {
      const ok = window.confirm(
        '当前文件有未保存的修改，确认放弃并切换？'
      )
      if (!ok) return
    }
    setSelected(node)
    setSidebarOpen(false)
    setMode('preview')
  }

  async function onLogout(): Promise<void> {
    if (dirty && !window.confirm('当前文件有未保存的修改，确认登出？')) return
    await logout()
    navigate('/login', { replace: true })
  }

  return (
    <div className="h-[100dvh] flex">
      <aside
        className={[
          'fixed inset-y-0 left-0 z-20 w-72 bg-[--paper-dim] border-r border-[--rule] flex flex-col',
          'transition-transform duration-200 md:translate-x-0 md:static md:flex',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        ].join(' ')}
      >
        <div className="h-12 flex items-center justify-between px-3 border-b border-[--rule-soft]">
          <span className="font-display text-lg text-[--ink]">Quill</span>
          <button
            type="button"
            onClick={onLogout}
            className="text-xs text-[--ink-faint] hover:text-[--accent] px-2 py-1"
          >
            登出
          </button>
        </div>
        <div className="flex-1 overflow-hidden">
          <FileTree
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

      {sidebarOpen && (
        <button
          type="button"
          aria-label="关闭侧栏"
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-10 bg-[--ink] opacity-30 md:hidden"
        />
      )}

      <main className="flex-1 flex flex-col min-w-0">
        <header className="h-12 flex items-center gap-3 px-3 border-b border-[--rule-soft]">
          <button
            type="button"
            onClick={() => setSidebarOpen((s) => !s)}
            className="md:hidden text-[--ink-soft] p-2"
            aria-label="切换侧栏"
          >
            ☰
          </button>
          <span className="text-sm text-[--ink-soft] truncate flex items-center gap-1.5 flex-1 min-w-0">
            <span className="truncate">{selected?.path ?? '选择一个文件'}</span>
            {dirty && (
              <span className="text-[--accent] shrink-0" title="未保存">
                •
              </span>
            )}
          </span>
          {selected && (
            <>
              <SaveStatusIndicator status={save} dirty={dirty} onSave={handleSave} />
              <ModeSwitcher value={mode} onChange={setMode} />
            </>
          )}
        </header>
        <div className="flex-1 overflow-y-auto scroll-thin">
          {loadErr && (
            <div className="px-6 py-4 text-sm text-[--accent]">{loadErr}</div>
          )}
          {!selected && !loadErr && (
            <div className="flex items-center justify-center h-full text-sm text-[--ink-faint]">
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
      </main>
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
    return <span className="text-xs text-[--ink-faint]">保存中…</span>
  }
  if (status === 'saved') {
    return <span className="text-xs text-[--ink-faint]">已保存</span>
  }
  if (typeof status === 'object') {
    return (
      <span className="text-xs text-[--accent]" title={status.error}>
        保存失败
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={onSave}
      disabled={!dirty}
      className="text-xs text-[--ink-soft] hover:text-[--ink] disabled:opacity-40 disabled:cursor-not-allowed px-2 py-1 rounded hover:bg-[--paper-dim]"
      title="保存 (⌘S)"
    >
      保存
    </button>
  )
}
