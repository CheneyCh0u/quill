import { useEffect, useRef, useState } from 'react'
import type { Workspace } from '@quill/shared-types'

type Props = {
  workspaces: Workspace[]
  active: Workspace
  /** Returns false to keep the menu open (e.g. dirty-confirm declined). */
  onSwitch: (ws: Workspace) => Promise<boolean> | boolean
  onCreate: () => void
}

/**
 * Sidebar-header workspace switcher: current name + chevron, dropdown
 * with the full list (default badge, active check) and a create action.
 * Touch targets stay ≥40px so the same control works in the H5 drawer.
 */
export function WorkspaceSwitcher({ workspaces, active, onSwitch, onCreate }: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent | TouchEvent): void {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={wrapRef} className="relative flex-1 min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="max-w-full flex items-center gap-1.5 px-1.5 py-1.5 -ml-1.5 rounded-md hover:bg-[var(--paper-soft)] transition-colors"
      >
        <CloudGlyph className="w-3.5 h-3.5 text-[var(--ink-faint)] shrink-0" />
        <span className="font-display text-lg text-[var(--ink)] truncate leading-none">
          {active.name}
        </span>
        <ChevronGlyph
          className={`w-3 h-3 text-[var(--ink-faint)] shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 right-0 md:right-auto md:min-w-[240px] top-full mt-1 rounded-lg border border-[var(--rule)] bg-[var(--paper)] shadow-[0_8px_28px_rgba(0,0,0,0.14),0_2px_6px_rgba(0,0,0,0.08)] text-sm z-40"
        >
          <p className="px-3 pt-2.5 pb-1 text-[10px] uppercase tracking-[0.18em] text-[var(--ink-faint)] select-none">
            workspaces
          </p>
          <div className="px-1.5 pb-1 max-h-[50dvh] overflow-y-auto">
            {workspaces.map((ws) => {
              const isActive = ws.id === active.id
              return (
                <button
                  key={ws.id}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  onClick={async () => {
                    if (isActive) {
                      setOpen(false)
                      return
                    }
                    const ok = await onSwitch(ws)
                    if (ok) setOpen(false)
                  }}
                  className={`w-full min-h-[40px] px-2 py-1.5 rounded-md flex items-center gap-2 text-left transition-colors ${
                    isActive ? 'bg-[var(--paper-soft)]' : 'hover:bg-[var(--paper-soft)]'
                  }`}
                >
                  <FolderGlyph className="w-3.5 h-3.5 text-[var(--ink-faint)] shrink-0" />
                  <span
                    className={`flex-1 truncate ${isActive ? 'text-[var(--ink)]' : 'text-[var(--ink-soft)]'}`}
                  >
                    {ws.name}
                  </span>
                  {ws.default && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--paper-edge)] text-[var(--ink-faint)] shrink-0">
                      默认
                    </span>
                  )}
                  {!ws.default && typeof ws.fileCount === 'number' && (
                    <span className="text-[10px] text-[var(--ink-ghost)] font-mono shrink-0">
                      {ws.fileCount} 文件
                    </span>
                  )}
                  {isActive && <CheckGlyph className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />}
                </button>
              )
            })}
          </div>
          <div className="border-t border-[var(--rule-soft)] px-1.5 py-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                onCreate()
              }}
              className="w-full min-h-[40px] px-2 py-1.5 rounded-md flex items-center gap-2 text-[var(--ink-soft)] hover:text-[var(--ink)] hover:bg-[var(--paper-soft)] transition-colors"
            >
              <PlusGlyph className="w-3 h-3 shrink-0" />
              新建工作区…
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// Inline glyphs — the web app doesn't ship an icon library; keep the
// lucide-style strokes consistent with the rest of the product.
function CloudGlyph({ className }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
    </svg>
  )
}
function ChevronGlyph({ className }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}
function FolderGlyph({ className }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  )
}
function CheckGlyph({ className }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}
function PlusGlyph({ className }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M5 12h14M12 5v14" />
    </svg>
  )
}
