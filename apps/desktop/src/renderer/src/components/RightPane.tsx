import { useApp } from '../state/app'
import { useTheme } from '../state/theme'
import { useState } from 'react'
import type { EditorView } from '@codemirror/view'
import { PaneHeader } from './PaneHeader'
import { Editor } from './Editor'
import { Preview } from './Preview'
import { OutlinePanel } from './OutlinePanel'

export function RightPane() {
  const { state, setBuffer, toggleOutline } = useApp()
  const { theme } = useTheme()
  const cur = state.currentFile

  const [editorView, setEditorView] = useState<EditorView | null>(null)

  return (
    <div className="flex-1 flex flex-col min-w-0">
      <PaneHeader />

      {!cur && (
        <div className="flex-1 flex items-center justify-center text-neutral-400 dark:text-neutral-600 text-sm select-none">
          从左侧选一个 .md 文件
        </div>
      )}

      {cur && (
        <div className="flex-1 flex min-h-0">
          {state.viewMode !== 'preview' && (
            <div
              className={`min-w-0 ${state.viewMode === 'split' ? 'w-1/2 border-r border-neutral-200 dark:border-neutral-800' : 'flex-1'}`}
            >
              <Editor
                value={cur.buffer}
                onChange={setBuffer}
                theme={theme}
                onViewChange={setEditorView}
              />
            </div>
          )}
          {state.viewMode !== 'edit' && (
            <div className={`min-w-0 ${state.viewMode === 'split' ? 'w-1/2' : 'flex-1'}`}>
              <Preview value={cur.buffer} />
            </div>
          )}
          {state.outlineVisible && (
            <OutlinePanel
              source={cur.buffer}
              editorView={editorView}
              onClose={toggleOutline}
            />
          )}
        </div>
      )}
    </div>
  )
}
