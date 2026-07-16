import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'

/**
 * Paper-styled dropdown replacing the native HTML `<select>`.
 * The popover renders through `createPortal(document.body)` so it isn't
 * clipped by parent `overflow:hidden` (notably the providers settings
 * modal). Position is computed from the trigger's bounding rect.
 */

export type SelectOption = {
  value: string
  /** Main label rendered in the row. */
  label: string
  /** Optional secondary text rendered after the label, dimmer. */
  hint?: string
}

/**
 * Whether a captured scroll event should close the popover. Scrolls that
 * originate *inside* the popover are the user browsing a long option list
 * (e.g. the 22-model codex catalog) and must not close it; anything else
 * is an ancestor container scrolling underneath us — close to avoid a
 * detached popover.
 */
export function scrollShouldClose(
  popoverEl: { contains(node: unknown): boolean } | null,
  target: unknown
): boolean {
  return !popoverEl || !target || !popoverEl.contains(target)
}

type Props = {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  className?: string
  /** Accessible name. Defaults to the current option's label. */
  ariaLabel?: string
  disabled?: boolean
}

export function Select({
  value,
  onChange,
  options,
  placeholder,
  className,
  ariaLabel,
  disabled
}: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<{
    top: number
    left: number
    width: number
  } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  const current = options.find((o) => o.value === value)

  const reposition = useCallback(() => {
    if (!triggerRef.current) return
    const r = triggerRef.current.getBoundingClientRect()
    setCoords({ top: r.bottom + 4, left: r.left, width: r.width })
  }, [])

  // Recompute position when opening, and on viewport / scroll changes
  // while open. Close on scroll of an ancestor container — keeps things
  // simple vs. tracking every parent scroll. Scrolling the option list
  // itself must NOT close (capture-phase listener sees those too).
  useLayoutEffect(() => {
    if (!open) return
    reposition()
    const onScroll = (e: Event): void => {
      if (!scrollShouldClose(popRef.current, e.target)) return
      setOpen(false)
    }
    const onResize = (): void => reposition()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open, reposition])

  // Click outside (anywhere not on the trigger or popover) closes.
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      const t = e.target as Node | null
      if (!t) return
      if (triggerRef.current?.contains(t)) return
      if (popRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  // Escape closes.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
        aria-label={ariaLabel ?? current?.label ?? placeholder}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={[
          'no-drag w-full px-3 py-1.5 rounded-md bg-[var(--paper)] text-[13px] font-mono text-[var(--ink)] border border-[var(--rule)]',
          'flex items-center justify-between gap-2 text-left cursor-pointer',
          'hover:border-[var(--accent)]/40 focus:border-[var(--accent)]/60 focus:outline-none',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          className ?? ''
        ].join(' ')}
      >
        <span className="truncate flex-1">
          {current ? (
            <>
              <span>{current.label}</span>
              {current.hint && (
                <span className="ml-2 text-[var(--ink-faint)]">{current.hint}</span>
              )}
            </>
          ) : (
            <span className="text-[var(--ink-faint)] font-serif-zh italic">
              {placeholder ?? '请选择…'}
            </span>
          )}
        </span>
        <ChevronDown
          className={`w-3 h-3 text-[var(--ink-faint)] shrink-0 transition-transform ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>
      {open && coords &&
        createPortal(
          <div
            ref={popRef}
            role="listbox"
            style={{
              position: 'fixed',
              top: coords.top,
              left: coords.left,
              width: coords.width,
              maxHeight: 280,
              zIndex: 1000
            }}
            className="bg-[var(--paper)] border border-[var(--rule)] rounded-md shadow-lg overflow-y-auto py-1"
          >
            {options.length === 0 && (
              <div className="px-3 py-2 text-[12px] text-[var(--ink-faint)] font-serif-zh italic">
                无可选项
              </div>
            )}
            {options.map((opt) => {
              const selected = opt.value === value
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    onChange(opt.value)
                    setOpen(false)
                  }}
                  className={[
                    'no-drag w-full text-left px-3 py-1.5 text-[13px] font-mono flex items-center gap-2',
                    selected
                      ? 'bg-[var(--accent-soft)] text-[var(--ink)]'
                      : 'text-[var(--ink)] hover:bg-[var(--paper-soft)]'
                  ].join(' ')}
                >
                  <span className="truncate flex-1">
                    <span>{opt.label}</span>
                    {opt.hint && (
                      <span className="ml-2 text-[var(--ink-faint)]">{opt.hint}</span>
                    )}
                  </span>
                  {selected && <Check className="w-3 h-3 text-[var(--accent)] shrink-0" />}
                </button>
              )
            })}
          </div>,
          document.body
        )}
    </>
  )
}
