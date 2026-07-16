import { useEffect, useRef } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap
} from '@codemirror/language'
import { search } from '@codemirror/search'
import { oneDark } from '@codemirror/theme-one-dark'
import { languageExtension } from '@quill/core/codemirror'
import { getFileType, type FileLanguage } from '@quill/shared-types'
import { useTheme } from '../lib/theme'

type Props = {
  value: string
  onChange: (next: string) => void
  onSave: () => void
  /** Drives the syntax highlighter. When absent the editor falls back to
   *  markdown — preserves the legacy contract for callers that haven't
   *  threaded the path through. */
  filePath?: string
}

function langOf(filePath: string | undefined): FileLanguage | null {
  return filePath ? getFileType(filePath).language : 'markdown'
}

/**
 * CodeMirror 6 editor mirroring the desktop setup: fold gutter, line
 * numbers, history, defaultKeymap + Mod-s save shortcut, and the same
 * shared `languageExtension` map so language coverage stays in sync.
 *
 * Theme follows <html data-theme>: dark → oneDark, light → default
 * highlight style. The state is rebuilt when the theme flips because
 * oneDark is an Extension list, not a Compartment-friendly slot, and
 * theme changes happen infrequently enough that a rebuild is fine.
 */
export function Editor({ value, onChange, onSave, filePath }: Props): JSX.Element {
  const theme = useTheme()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  const filePathRef = useRef(filePath)
  // Persist a single Compartment across renders so `reconfigure` can swap
  // the language extension without rebuilding the whole EditorState.
  const langCompartmentRef = useRef<Compartment>(new Compartment())
  onChangeRef.current = onChange
  onSaveRef.current = onSave
  filePathRef.current = filePath

  // Rebuild on theme change — oneDark is a flat extension list, not
  // compartment-friendly. filePath is intentionally NOT a dep; language
  // swaps go through reconfigure below to preserve undo + cursor.
  useEffect(() => {
    if (!hostRef.current) return
    const langCompartment = langCompartmentRef.current
    const initialLang = langOf(filePathRef.current)

    const extensions = [
      history(),
      lineNumbers(),
      // foldGutter reads ranges from each language pack's syntax tree, so
      // every official lang gains click-to-collapse with no per-lang
      // wiring. Plain-text files just show no fold markers. Custom
      // markerDOM mirrors desktop (#121): stable classes let CSS keep
      // open-fold arrows hover-only while collapsed markers stay visible.
      foldGutter({
        markerDOM(open) {
          const marker = document.createElement('span')
          marker.className = open ? 'cm-fold-marker is-open' : 'cm-fold-marker is-closed'
          marker.textContent = open ? '⌄' : '›'
          return marker
        }
      }),
      highlightActiveLine(),
      // Search state — no panel UI yet, but the keymap (Mod-f / F3) opens
      // CM's default search bar.
      search(),
      keymap.of([
        // Mod-s before defaultKeymap so the browser's "save page" never
        // sees the keystroke. preventDefault: true is the magic word.
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            onSaveRef.current()
            return true
          }
        },
        ...defaultKeymap,
        ...historyKeymap,
        ...foldKeymap,
        indentWithTab
      ]),
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
    // Focus on mount so the user can start typing immediately after
    // opening a file.
    view.focus()
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // value sync handled separately below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme])

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

  // External value updates (e.g. file switch, agent rewrite) → replace
  // doc only when it actually diverges, so the user's typing isn't
  // clobbered while they're mid-keystroke.
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

  return <div ref={hostRef} className="h-full w-full overflow-hidden" />
}
