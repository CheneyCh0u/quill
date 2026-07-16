import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { buildOutline, type OutlineNode } from '../lib/outline'

type Props = {
  source: string
  /** Element to scroll inside on heading click. Usually the preview's
   *  scroll container — falls back to document.getElementById which works
   *  when the preview lives in the page-level scroll. */
  containerRef?: React.RefObject<HTMLElement | null>
}

/**
 * Side-rail outline: a flat list of headings indented by level. Click
 * jumps the preview to that heading.
 *
 * Hidden when there are no headings — empty document doesn't deserve a
 * 0-item rail eating layout space.
 */
export function Outline({ source, containerRef }: Props): JSX.Element | null {
  const nodes = useMemo(() => buildOutline(source), [source])
  if (nodes.length === 0) return null
  return (
    <aside className="h-full overflow-y-auto scroll-thin border-l border-[var(--rule-soft)] bg-[var(--paper-dim)] py-3 px-3 min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-[var(--ink-faint)] mb-2 px-1">
        大纲
      </div>
      <nav className="space-y-0.5">
        {nodes.map((n) => (
          <OutlineRow key={n.slug} node={n} containerRef={containerRef} />
        ))}
      </nav>
    </aside>
  )
}

function OutlineRow({
  node,
  containerRef
}: {
  node: OutlineNode
  containerRef?: React.RefObject<HTMLElement | null>
}): JSX.Element {
  function scrollTo(): void {
    const root = containerRef?.current ?? document
    const el = root.querySelector<HTMLElement>(
      // CSS.escape handles weird CJK / colon edge cases.
      `#${CSS.escape(node.slug)}`
    )
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  return (
    <button
      type="button"
      onClick={scrollTo}
      title={node.text}
      className="w-full text-left text-xs text-[var(--ink-soft)] hover:text-[var(--ink)] hover:bg-[var(--paper-soft)] rounded px-1.5 py-1 truncate transition-colors"
      style={{ paddingLeft: `${(node.level - 1) * 10 + 6}px` }}
    >
      {node.text}
    </button>
  )
}

/**
 * Mobile / H5 variant: a button + bottom-sheet that pops the same
 * outline list. Used inside the Vault header when no horizontal space
 * for a side rail.
 */
export function OutlineSheetButton({
  source,
  containerRef
}: Props): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const nodes = useMemo(() => buildOutline(source), [source])
  if (nodes.length === 0) return null
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="大纲"
        className="md:hidden text-sm text-[var(--ink-faint)] hover:text-[var(--ink)] hover:bg-[var(--paper-soft)] rounded px-2 py-1"
      >
        ≡
      </button>
      {open && (
        <div
          className="md:hidden fixed inset-0 z-40 flex items-end bg-[var(--ink)]/30"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-h-[70dvh] overflow-y-auto bg-[var(--paper)] rounded-t-xl border-t border-[var(--rule)] p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm text-[var(--ink)] font-medium">大纲</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-[var(--ink-faint)] px-2"
                aria-label="关闭"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <nav className="space-y-0.5">
              {nodes.map((n) => (
                <button
                  key={n.slug}
                  type="button"
                  onClick={() => {
                    const root = containerRef?.current ?? document
                    const el = root.querySelector<HTMLElement>(`#${CSS.escape(n.slug)}`)
                    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                    setOpen(false)
                  }}
                  title={n.text}
                  className="w-full text-left text-sm text-[var(--ink-soft)] hover:bg-[var(--paper-dim)] rounded px-2 py-1.5 truncate"
                  style={{ paddingLeft: `${(n.level - 1) * 14 + 8}px` }}
                >
                  {n.text}
                </button>
              ))}
            </nav>
          </div>
        </div>
      )}
    </>
  )
}
