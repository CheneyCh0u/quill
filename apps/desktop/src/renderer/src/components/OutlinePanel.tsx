import { useCallback, useMemo } from 'react'
import { X } from 'lucide-react'
import { EditorView } from '@codemirror/view'
import { parseOutline, type OutlineItem } from '../lib/outline'

type Props = {
  source: string
  editorView: EditorView | null
  onClose: () => void
}

export function OutlinePanel({ source, editorView, onClose }: Props) {
  const items = useMemo(() => parseOutline(source), [source])

  const jumpTo = useCallback(
    (item: OutlineItem) => {
      // Scroll the preview pane to the heading. getElementById walks the live
      // DOM, so it works regardless of which preview instance is mounted.
      const target = document.getElementById(item.slug)
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' })

      // Also move the editor's cursor to the source line so the two panes stay
      // mentally synced. No-op if editor isn't currently mounted.
      if (editorView) {
        const totalLines = editorView.state.doc.lines
        const lineIdx = Math.max(1, Math.min(totalLines, item.line + 1))
        const pos = editorView.state.doc.line(lineIdx).from
        editorView.dispatch({
          selection: { anchor: pos },
          effects: EditorView.scrollIntoView(pos, { y: 'start' })
        })
      }
    },
    [editorView]
  )

  return (
    <aside className="w-56 shrink-0 border-l border-neutral-200 dark:border-neutral-800 bg-neutral-50/60 dark:bg-neutral-950/40 flex flex-col">
      <div className="h-9 px-3 flex items-center gap-2 border-b border-neutral-200 dark:border-neutral-800 shrink-0">
        <span className="text-xs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400 flex-1">
          大纲
        </span>
        <button
          onClick={onClose}
          className="no-drag p-1 -mr-1 rounded hover:bg-neutral-200/70 dark:hover:bg-neutral-800 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
          title="收起大纲"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="flex-1 overflow-auto py-1">
        {items.length === 0 ? (
          <div className="px-3 py-2 text-xs text-neutral-400 dark:text-neutral-500 select-none">
            还没有标题
          </div>
        ) : (
          <ul className="text-sm">
            {items.map((item, i) => (
              <li key={`${item.slug}-${i}`}>
                <button
                  onClick={() => jumpTo(item)}
                  style={{ paddingLeft: 10 + (item.level - 1) * 12 }}
                  className="no-drag w-full text-left py-1 pr-2 truncate hover:bg-neutral-100 dark:hover:bg-neutral-900 text-neutral-700 dark:text-neutral-200"
                  title={item.text}
                >
                  {item.text}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}
