import { useApp } from '../state/app'
import { useTheme } from '../state/theme'
import { useEffect, useState } from 'react'
import type { EditorView } from '@codemirror/view'
import { getFileType } from '@quill/shared-types'
import { PaneHeader } from './PaneHeader'
import { Editor } from './Editor'
import { Preview } from './Preview'
import { OutlineRail } from './OutlineRail'
import { SearchPanel, type SearchMode } from './SearchPanel'

type SearchUi = {
  mode: SearchMode
  initialQuery: string
  /** Bumped each time Cmd+F/R is pressed so the panel re-mounts (refocus +
   *  fresh state) even when already open. */
  epoch: number
}

export function RightPane() {
  const { state, setBuffer, setViewMode } = useApp()
  const { theme } = useTheme()
  const cur = state.currentFile
  // Untitled buffers are implicitly markdown (Cmd+N creates an .md file by
  // default). Code/text files we opened from disk get edit-only — preview
  // and outline only make sense for markdown.
  const isMarkdownFile = !cur?.path || getFileType(cur.path).isMarkdown
  const effectiveViewMode = isMarkdownFile ? state.viewMode : 'edit'

  const [editorView, setEditorView] = useState<EditorView | null>(null)
  const [previewScrollEl, setPreviewScrollEl] = useState<HTMLDivElement | null>(null)
  const [search, setSearch] = useState<SearchUi | null>(null)

  // Global Cmd+F / Cmd+R triggers. Captured at window level so they work
  // regardless of which child currently has focus (editor, sidebar, etc).
  useEffect(() => {
    if (!cur) return
    const handler = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return
      const k = e.key.toLowerCase()
      if (k !== 'f' && k !== 'r') return
      e.preventDefault()

      // Pull selection from editor (if mounted) as the initial query;
      // preview-only mode has no editor so fall back to empty.
      let initialQuery = ''
      if (editorView) {
        const sel = editorView.state.selection.main
        if (sel.from !== sel.to) {
          initialQuery = editorView.state.sliceDoc(sel.from, sel.to)
        }
      }

      // Search needs the editor visible. Auto-pop preview-only into split so
      // the user sees what they're matching against.
      if (state.viewMode === 'preview') setViewMode('split')

      setSearch((prev) => ({
        mode: k === 'r' ? 'replace' : 'find',
        initialQuery: initialQuery || prev?.initialQuery || '',
        epoch: (prev?.epoch ?? 0) + 1
      }))
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [cur, editorView, state.viewMode, setViewMode])

  // Switching files closes any open search panel — its query / matches refer
  // to the old document, so re-opening on the new one is correct.
  useEffect(() => {
    setSearch(null)
  }, [cur?.path])

  return (
    <div className="flex-1 flex flex-col min-w-0 relative">
      <PaneHeader />

      {!cur && (
        <div className="flex-1 flex items-center justify-center text-[var(--ink-faint)] text-sm select-none font-serif-zh italic">
          从左侧选一个文件
        </div>
      )}

      {cur && (
        <>
          <div className="flex-1 flex min-h-0">
            {effectiveViewMode !== 'preview' && (
              <div
                className={`min-w-0 flex flex-col ${effectiveViewMode === 'split' ? 'w-1/2 border-r border-[var(--rule)]' : 'flex-1'}`}
              >
                {search && editorView && (
                  <SearchPanel
                    key={search.epoch}
                    view={editorView}
                    mode={search.mode}
                    initialQuery={search.initialQuery}
                    onClose={() => setSearch(null)}
                    onSwitchMode={(m) =>
                      setSearch((s) => (s ? { ...s, mode: m } : s))
                    }
                  />
                )}
                <div className="flex-1 min-h-0">
                  <Editor
                    value={cur.buffer}
                    onChange={setBuffer}
                    theme={theme}
                    filePath={cur.path ?? undefined}
                    onViewChange={setEditorView}
                  />
                </div>
              </div>
            )}
            {effectiveViewMode !== 'edit' && (
              <div className={`min-w-0 ${effectiveViewMode === 'split' ? 'w-1/2' : 'flex-1'}`}>
                <Preview value={cur.buffer} scrollRef={setPreviewScrollEl} />
              </div>
            )}
          </div>
          {isMarkdownFile && (
            <OutlineRail
              source={cur.buffer}
              scrollContainer={effectiveViewMode === 'edit' ? null : previewScrollEl}
              editorView={editorView}
            />
          )}
        </>
      )}
    </div>
  )
}
