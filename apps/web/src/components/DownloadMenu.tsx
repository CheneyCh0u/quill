import { useEffect, useRef, useState } from 'react'
import { downloadAsHtml, downloadAsMarkdown, printAsPdf } from '../lib/download'

type Props = {
  filePath: string
  content: string
}

/** Three-option download dropdown. Hidden when there's nothing to
 *  export (no open file). */
export function DownloadMenu({ filePath, content }: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('click', onDocClick)
    return () => document.removeEventListener('click', onDocClick)
  }, [open])

  function pick(action: () => void): void {
    setOpen(false)
    // Defer so the click that closes us doesn't race the new dialog.
    setTimeout(action, 0)
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="下载"
        className="text-sm text-[var(--ink-faint)] hover:text-[var(--ink)] hover:bg-[var(--paper-soft)] rounded px-2 py-1"
      >
        ↓
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-40 bg-[var(--paper)] border border-[var(--rule)] rounded shadow-lg py-1 min-w-[140px]">
          <button
            type="button"
            onClick={() => pick(() => downloadAsMarkdown(filePath, content))}
            className="w-full text-left px-3 py-1.5 text-sm text-[var(--ink-soft)] hover:bg-[var(--paper-dim)]"
          >
            下载 Markdown
          </button>
          <button
            type="button"
            onClick={() => pick(() => downloadAsHtml(filePath, content))}
            className="w-full text-left px-3 py-1.5 text-sm text-[var(--ink-soft)] hover:bg-[var(--paper-dim)]"
          >
            下载 HTML
          </button>
          <button
            type="button"
            onClick={() => pick(() => printAsPdf(filePath, content))}
            className="w-full text-left px-3 py-1.5 text-sm text-[var(--ink-soft)] hover:bg-[var(--paper-dim)]"
          >
            打印 / PDF
          </button>
        </div>
      )}
    </div>
  )
}
