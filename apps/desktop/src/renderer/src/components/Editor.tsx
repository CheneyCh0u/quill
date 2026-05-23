import { useEffect, useRef } from 'react'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { xml } from '@codemirror/lang-xml'
import { python } from '@codemirror/lang-python'
import { java } from '@codemirror/lang-java'
import { go } from '@codemirror/lang-go'
import { rust } from '@codemirror/lang-rust'
import { cpp } from '@codemirror/lang-cpp'
import { sql } from '@codemirror/lang-sql'
import { php } from '@codemirror/lang-php'
import { yaml } from '@codemirror/lang-yaml'
import { StreamLanguage, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { ruby } from '@codemirror/legacy-modes/mode/ruby'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { search } from '@codemirror/search'
import { oneDark } from '@codemirror/theme-one-dark'
import { getFileType, type FileLanguage } from '@quill/shared-types'
import type { Theme } from '../types'
import { usePrefs } from '../state/prefs'

type Props = {
  value: string
  onChange: (next: string) => void
  theme: Theme
  /** Used to pick the syntax highlighter. When absent the editor falls back
   *  to markdown — preserves the legacy behaviour for callers that haven't
   *  threaded the path through yet. */
  filePath?: string
  onViewChange?: (view: EditorView | null) => void
}

function languageExtension(lang: FileLanguage | null): Extension {
  switch (lang) {
    case 'markdown':
      return markdown()
    case 'javascript':
      // Covers js/ts/jsx/tsx — lang-javascript handles all four under flags.
      return javascript({ typescript: true, jsx: true })
    case 'json':
      return json()
    case 'html':
      return html()
    case 'css':
      return css()
    case 'xml':
      return xml()
    case 'python':
      return python()
    case 'java':
      return java()
    case 'go':
      return go()
    case 'rust':
      return rust()
    case 'cpp':
      return cpp()
    case 'sql':
      return sql()
    case 'php':
      return php()
    case 'yaml':
      return yaml()
    case 'shell':
      return StreamLanguage.define(shell)
    case 'ruby':
      return StreamLanguage.define(ruby)
    case 'toml':
      return StreamLanguage.define(toml)
    default:
      return []
  }
}

function langOf(filePath: string | undefined): FileLanguage | null {
  return filePath ? getFileType(filePath).language : 'markdown'
}

export function Editor({ value, onChange, theme, filePath, onViewChange }: Props) {
  const { prefs } = usePrefs()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const onViewChangeRef = useRef(onViewChange)
  const filePathRef = useRef(filePath)
  // Persist a single Compartment across renders so `reconfigure` can swap
  // the language extension without rebuilding the whole EditorState.
  const langCompartmentRef = useRef<Compartment>(new Compartment())
  onChangeRef.current = onChange
  onViewChangeRef.current = onViewChange
  filePathRef.current = filePath

  // Rebuild on theme OR showLineNumbers change — both affect the extension
  // list and CM6 needs a fresh state.create. Font size lives on a CSS var
  // (see index.css .cm-editor), so it reflows without a rebuild. filePath
  // is intentionally NOT a dep — language swaps go through reconfigure
  // below to preserve undo history and cursor position.
  useEffect(() => {
    if (!hostRef.current) return
    const langCompartment = langCompartmentRef.current
    const initialLang = langOf(filePathRef.current)

    const extensions = [
      history(),
      ...(prefs.showLineNumbers ? [lineNumbers()] : []),
      highlightActiveLine(),
      // Search state + match decorations. Driven by our own React panel; we
      // never call `openSearchPanel`, so CM6's built-in panel never shows up.
      search(),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      langCompartment.of(languageExtension(initialLang)),
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

  // Swap the syntax highlighter when the open file changes.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: langCompartmentRef.current.reconfigure(
        languageExtension(langOf(filePath))
      )
    })
  }, [filePath])

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
