import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pin, PinOff } from 'lucide-react'
import { EditorView } from '@codemirror/view'
import { parseOutline, type OutlineItem } from '../lib/outline'

type Props = {
  source: string
  /** The scrolling container of the preview pane. When given, current-heading
   *  tracking follows preview scroll. */
  scrollContainer: HTMLDivElement | null
  /** Used in edit-only mode (no preview) to track current heading via cursor,
   *  and to move the cursor on click. */
  editorView: EditorView | null
}

// Tick widths by heading level — h1 longest, h6 shortest. The visual scale
// hints at the document hierarchy without forcing the user to read names.
const TICK_WIDTH: Record<number, number> = {
  1: 12,
  2: 9,
  3: 6,
  4: 5,
  5: 4,
  6: 4
}

const PIN_KEY = 'quill:outlinePinned'

function readPin(): boolean {
  try {
    return localStorage.getItem(PIN_KEY) === '1'
  } catch {
    return false
  }
}

export function OutlineRail({ source, scrollContainer, editorView }: Props) {
  const items = useMemo(() => parseOutline(source), [source])
  const [currentIndex, setCurrentIndex] = useState(-1)
  const [hover, setHover] = useState(false)
  const [pinned, setPinned] = useState(readPin)
  const closeTimer = useRef<number | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem(PIN_KEY, pinned ? '1' : '0')
    } catch {
      /* localStorage unavailable; silently skip */
    }
  }, [pinned])

  // Track current heading via preview scroll position. Uses getElementById on
  // the rendered preview — same lookup OutlinePanel used to scroll to a
  // heading, so it stays in sync as long as the preview is mounted.
  useEffect(() => {
    const container = scrollContainer
    if (!container || items.length === 0) return

    let raf = 0
    const compute = (): void => {
      const containerRect = container.getBoundingClientRect()
      // Trigger line ~80px below the top of the container; any heading above
      // this line is considered "passed."
      const triggerY = containerRect.top + 80
      let lastPassed = -1
      for (let i = 0; i < items.length; i++) {
        const el = document.getElementById(items[i].slug)
        if (!el) continue
        const r = el.getBoundingClientRect()
        if (r.top <= triggerY) lastPassed = i
        else break
      }
      setCurrentIndex((prev) => (prev === lastPassed ? prev : lastPassed))
    }

    const onScroll = (): void => {
      if (raf) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(compute)
    }

    compute()
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      container.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [scrollContainer, items])

  // Edit-only fallback: track cursor line. Only kicks in when there's no
  // preview scroll container — split / preview modes always win.
  useEffect(() => {
    if (scrollContainer || !editorView || items.length === 0) return

    let raf = 0
    let lastState = editorView.state
    const compute = (): void => {
      const head = editorView.state.selection.main.head
      const line = editorView.state.doc.lineAt(head).number - 1
      let lastPassed = -1
      for (let i = 0; i < items.length; i++) {
        if (items[i].line <= line) lastPassed = i
        else break
      }
      setCurrentIndex((prev) => (prev === lastPassed ? prev : lastPassed))
    }
    const tick = (): void => {
      if (editorView.state !== lastState) {
        lastState = editorView.state
        compute()
      }
      raf = requestAnimationFrame(tick)
    }
    compute()
    raf = requestAnimationFrame(tick)
    return () => {
      if (raf) cancelAnimationFrame(raf)
    }
  }, [scrollContainer, editorView, items])

  const jumpTo = useCallback(
    (item: OutlineItem) => {
      const target = document.getElementById(item.slug)
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' })

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

  const openDrawer = useCallback(() => {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    setHover(true)
  }, [])

  const scheduleClose = useCallback(() => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setHover(false), 180)
  }, [])

  useEffect(() => {
    return () => {
      if (closeTimer.current) window.clearTimeout(closeTimer.current)
    }
  }, [])

  if (items.length === 0) return null

  // Drawer is visible if: pinned, or mouse is hovering rail/drawer.
  const drawerVisible = pinned || hover

  return (
    // pointer-events-none on the wrapper lets clicks pass through to the
    // preview underneath; the rail + drawer each opt back in.
    <div className="absolute top-0 right-0 bottom-0 flex pointer-events-none z-20">
      {/* Drawer (slides in from the right edge). Always rendered for
       *  transitions; visibility toggled with opacity/translate. */}
      <div
        className={`self-start mt-12 mr-4 w-[240px] rounded-[10px] bg-[var(--paper)] border border-[var(--rule)] shadow-lg overflow-hidden transition-all duration-150 ${
          drawerVisible
            ? 'opacity-100 translate-x-0 pointer-events-auto'
            : 'opacity-0 translate-x-2 pointer-events-none'
        }`}
        onMouseEnter={openDrawer}
        onMouseLeave={scheduleClose}
      >
        <div className="px-3 pt-2.5 pb-1.5 flex items-center justify-between gap-2">
          <span className="font-display italic text-[12px] text-[var(--ink-faint)]">
            大纲
          </span>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] text-[var(--ink-ghost)]">
              {items.length}
            </span>
            <button
              onClick={() => setPinned((v) => !v)}
              title={pinned ? '取消固定（恢复悬停展开）' : '固定大纲'}
              className={`p-1 -mr-1 rounded transition ${
                pinned
                  ? 'text-[var(--accent)] hover:bg-[var(--paper-soft)]'
                  : 'text-[var(--ink-faint)] hover:text-[var(--ink)] hover:bg-[var(--paper-soft)]'
              }`}
            >
              {pinned ? (
                <Pin className="w-3 h-3" />
              ) : (
                <PinOff className="w-3 h-3" />
              )}
            </button>
          </div>
        </div>
        <ul className="max-h-[60vh] overflow-auto pb-1.5">
          {items.map((it, i) => {
            const active = i === currentIndex
            return (
              <li key={`${it.slug}-${i}`}>
                <button
                  onClick={() => jumpTo(it)}
                  style={{
                    paddingLeft: 12 + (it.level - 1) * 10,
                    boxShadow: active ? 'inset 2px 0 0 var(--accent)' : undefined
                  }}
                  className={`w-full text-left py-1 pr-3 truncate text-[12.5px] transition ${
                    active
                      ? 'bg-[var(--paper-soft)] text-[var(--ink)] font-medium'
                      : 'text-[var(--ink-soft)] hover:bg-[var(--paper-soft)] hover:text-[var(--ink)]'
                  }`}
                  title={it.text}
                >
                  {it.text || '(无标题)'}
                </button>
              </li>
            )
          })}
        </ul>
      </div>

      {/* The rail itself — sits flush against the window right edge. */}
      <div
        className="pointer-events-auto h-full w-[14px] flex flex-col items-end pt-12 pb-4 pr-1.5 gap-[5px]"
        aria-label="文档大纲"
        onMouseEnter={openDrawer}
        onMouseLeave={scheduleClose}
      >
        {items.map((it, i) => {
          const active = i === currentIndex
          const width = TICK_WIDTH[it.level] ?? 4
          return (
            <button
              key={`${it.slug}-${i}`}
              onClick={() => jumpTo(it)}
              title={it.text}
              style={{ width, height: 2 }}
              className={`shrink-0 transition-all rounded-[1px] ${
                active
                  ? 'bg-[var(--accent)]'
                  : it.level === 1
                    ? 'bg-[var(--ink-faint)] hover:bg-[var(--accent)]'
                    : 'bg-[var(--ink-ghost)] hover:bg-[var(--ink-faint)]'
              }`}
            />
          )
        })}
      </div>
    </div>
  )
}
