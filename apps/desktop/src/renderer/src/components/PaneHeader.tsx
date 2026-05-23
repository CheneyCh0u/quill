import { useCallback, useEffect, useRef, useState } from 'react'
import { PanelLeftOpen } from 'lucide-react'
import { getFileType } from '@quill/shared-types'
import { useApp } from '../state/app'
import { ModeSwitcher } from './ModeSwitcher'
import { ExportMenu } from './ExportMenu'

function splitPath(path: string): { dir: string | null; name: string } {
  const segs = path.split(/[/\\]/)
  const name = segs[segs.length - 1] ?? path
  const dir = segs.length > 1 ? segs[segs.length - 2] : null
  return { dir, name }
}

export function PaneHeader() {
  const { state, mode, dirty, setViewMode, toggleSidebar, renameCurrentFile } = useApp()
  const cur = state.currentFile
  const showExpand = mode === 'workspace' && state.sidebarCollapsed
  const hasPath = !!cur?.path
  // Untitled (no path yet) defaults to markdown, so the mode switcher and
  // export menu still make sense. Non-markdown files (.py, .json, ...) get
  // them hidden — preview/outline/PDF are markdown-only.
  const isMarkdownFile = !cur?.path || getFileType(cur.path).isMarkdown

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // When path changes (switched files), exit any in-flight edit.
  useEffect(() => {
    setEditing(false)
    setError(null)
  }, [cur?.path])

  const startEditing = useCallback(() => {
    if (!cur?.path) return
    const name = splitPath(cur.path).name
    setDraft(name)
    setError(null)
    setEditing(true)
  }, [cur?.path])

  const cancelEditing = useCallback(() => {
    setEditing(false)
    setError(null)
  }, [])

  const commitEditing = useCallback(async () => {
    if (!editing) return
    setError(null)
    try {
      await renameCurrentFile(draft)
      setEditing(false)
    } catch (err) {
      const msg =
        err instanceof Error && err.message === 'TARGET_EXISTS'
          ? '已有同名文件'
          : err instanceof Error
            ? err.message
            : '重命名失败'
      setError(msg)
      // Keep edit mode open so user can fix the name.
    }
  }, [editing, draft, renameCurrentFile])

  // Focus + select up to extension when entering edit mode (macOS Finder
  // behaviour: select the basename, leave .md untouched).
  useEffect(() => {
    if (!editing || !inputRef.current) return
    const el = inputRef.current
    el.focus()
    const dotIdx = draft.lastIndexOf('.')
    el.setSelectionRange(0, dotIdx > 0 ? dotIdx : draft.length)
  }, [editing]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="h-11 px-4 flex items-center gap-2 border-b border-[var(--rule)] shrink-0 bg-[var(--paper)]">
      {showExpand && (
        <button
          onClick={toggleSidebar}
          className="no-drag p-1.5 rounded-md hover:bg-[var(--paper-soft)] text-[var(--ink-faint)] hover:text-[var(--ink)] transition"
          title="展开侧栏"
        >
          <PanelLeftOpen className="w-4 h-4" />
        </button>
      )}

      <div className="flex-1 flex items-center gap-2 min-w-0">
        {cur && !editing && (
          <>
            {cur.path ? (
              <>
                {(() => {
                  const { dir, name } = splitPath(cur.path)
                  return (
                    <>
                      {dir && (
                        <span className="font-display italic text-[13px] text-[var(--ink-faint)] truncate shrink min-w-0">
                          {dir} /
                        </span>
                      )}
                      <span
                        onDoubleClick={startEditing}
                        className="font-display text-[14px] text-[var(--ink)] truncate cursor-text select-none no-drag"
                        title={`${cur.path}\n双击重命名`}
                      >
                        {name}
                      </span>
                    </>
                  )
                })()}
              </>
            ) : (
              <span
                className="font-display italic text-[14px] text-[var(--ink-faint)]"
                title="未保存的新文件无法重命名"
              >
                Untitled
              </span>
            )}
            {dirty && (
              <span
                className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] shrink-0"
                title="未保存"
              />
            )}
          </>
        )}

        {cur && editing && hasPath && (
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value)
                if (error) setError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void commitEditing()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  cancelEditing()
                }
              }}
              onBlur={cancelEditing}
              className="no-drag font-display text-[14px] text-[var(--ink)] bg-[var(--paper-soft)] rounded-md px-2 py-0.5 outline-none focus:ring-1 focus:ring-[var(--accent)]/40 min-w-0 max-w-[420px]"
              style={{ width: `${Math.max(draft.length + 2, 12)}ch` }}
            />
            {error ? (
              <span className="font-serif-zh italic text-[12px] text-[var(--accent)] truncate">
                {error}
              </span>
            ) : (
              <span className="font-serif-zh italic text-[12px] text-[var(--ink-faint)]">
                Enter 确认 · Esc 取消
              </span>
            )}
          </div>
        )}
      </div>

      {cur && (
        <>
          {isMarkdownFile && (
            <ModeSwitcher value={state.viewMode} onChange={setViewMode} />
          )}
          <ExportMenu />
        </>
      )}
    </div>
  )
}
