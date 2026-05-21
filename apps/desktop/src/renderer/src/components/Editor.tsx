import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { search } from '@codemirror/search'
import { oneDark } from '@codemirror/theme-one-dark'
import type { Theme } from '../types'
import { usePrefs } from '../state/prefs'

type Props = {
  value: string
  onChange: (next: string) => void
  theme: Theme
  onViewChange?: (view: EditorView | null) => void
}

export function Editor({ value, onChange, theme, onViewChange }: Props) {
  const { prefs } = usePrefs()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const onViewChangeRef = useRef(onViewChange)
  onChangeRef.current = onChange
  onViewChangeRef.current = onViewChange

  // Rebuild on theme OR showLineNumbers change — both affect the extension
  // list and CM6 needs a fresh state.create. Font size lives on a CSS var
  // (see index.css .cm-editor), so it reflows without a rebuild.
  useEffect(() => {
    if (!hostRef.current) return

    const extensions = [
      history(),
      ...(prefs.showLineNumbers ? [lineNumbers()] : []),
      highlightActiveLine(),
      // Search state + match decorations. Driven by our own React panel; we
      // never call `openSearchPanel`, so CM6's built-in panel never shows up.
      search(),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      markdown(),
      EditorView.lineWrapping,
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChangeRef.current(u.state.doc.toString())
      }),
      ...(theme === 'dark' ? [oneDark] : [])
    ]

    const state = EditorState.create({ doc: value, extensions })
    const view = new EditorView({ state, parent: hostRef.current })
    viewRef.current = view
    onViewChangeRef.current?.(view)
    return () => {
      onViewChangeRef.current?.(null)
      view.destroy()
      viewRef.current = null
    }
    // value sync handled separately below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, prefs.showLineNumbers])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value }
      })
    }
  }, [value])

  return <div ref={hostRef} className="h-full w-full" />
}
