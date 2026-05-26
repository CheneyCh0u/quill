import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import {
  DialogStore,
  type AlertOptions,
  type ConfirmOptions,
  type DialogRequest,
  type PromptOptions
} from './dialog-store'

/**
 * Imperative replacement for window.alert / confirm / prompt — keeps the
 * app's visual language (paper / ink / accent vars, blur backdrop) and
 * works inside iframes / preview windows where the native dialogs would
 * sit at the host-frame chrome level.
 *
 * Use via `const dialogs = useDialogs()` inside a tree wrapped by
 * <DialogProvider>; each method returns a Promise that resolves with the
 * user's choice (or null/false for cancel).
 */
export type DialogAPI = {
  alert(opts: AlertOptions): Promise<void>
  confirm(opts: ConfirmOptions): Promise<boolean>
  prompt(opts: PromptOptions): Promise<string | null>
}

const Ctx = createContext<DialogAPI | null>(null)

export function useDialogs(): DialogAPI {
  const ctx = useContext(Ctx)
  if (!ctx) {
    throw new Error('useDialogs must be used inside <DialogProvider>')
  }
  return ctx
}

export function DialogProvider({ children }: { children: ReactNode }): JSX.Element {
  // Store survives re-renders so pending promises keep their resolvers.
  const storeRef = useRef<DialogStore | null>(null)
  if (storeRef.current === null) storeRef.current = new DialogStore()
  const store = storeRef.current

  const [current, setCurrent] = useState<DialogRequest | null>(() => store.current())

  useEffect(() => {
    const off = store.subscribe(() => setCurrent(store.current()))
    return off
  }, [store])

  const api = useMemo<DialogAPI>(
    () => ({
      alert: (opts) =>
        new Promise<void>((resolve) =>
          store.enqueue({ kind: 'alert', opts, resolve })
        ),
      confirm: (opts) =>
        new Promise<boolean>((resolve) =>
          store.enqueue({ kind: 'confirm', opts, resolve })
        ),
      prompt: (opts) =>
        new Promise<string | null>((resolve) =>
          store.enqueue({ kind: 'prompt', opts, resolve })
        )
    }),
    [store]
  )

  return (
    <Ctx.Provider value={api}>
      {children}
      {current && (
        <DialogShell req={current} onResolve={(v) => store.resolveCurrent(v)} />
      )}
    </Ctx.Provider>
  )
}

function DialogShell({
  req,
  onResolve
}: {
  req: DialogRequest
  onResolve: (value: unknown) => void
}): JSX.Element {
  // Esc always cancels (alert → void, confirm → false, prompt → null).
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return
      e.preventDefault()
      if (req.kind === 'alert') onResolve(undefined)
      else if (req.kind === 'confirm') onResolve(false)
      else onResolve(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [req, onResolve])

  const cancel = (): void => {
    if (req.kind === 'alert') onResolve(undefined)
    else if (req.kind === 'confirm') onResolve(false)
    else onResolve(null)
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[var(--ink)]/30 backdrop-blur-[2px]"
      onClick={cancel}
    >
      <div
        className="w-full max-w-sm rounded-xl bg-[var(--paper)] border border-[var(--rule)] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {req.kind === 'alert' && <AlertBody req={req} onResolve={onResolve} />}
        {req.kind === 'confirm' && <ConfirmBody req={req} onResolve={onResolve} />}
        {req.kind === 'prompt' && <PromptBody req={req} onResolve={onResolve} />}
      </div>
    </div>
  )
}

function DialogHeader({ title }: { title?: string }): JSX.Element | null {
  if (!title) return null
  return (
    <div className="px-5 pt-4 pb-2">
      <h3
        className="font-display text-base text-[var(--ink)]"
        style={{ fontWeight: 500 }}
      >
        {title}
      </h3>
    </div>
  )
}

function DialogMessage({ children }: { children: ReactNode }): JSX.Element {
  return <div className="px-5 py-3 text-sm text-[var(--ink-soft)]">{children}</div>
}

function DialogFooter({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="px-5 py-3 bg-[var(--paper-dim)] border-t border-[var(--rule)] flex items-center justify-end gap-2">
      {children}
    </div>
  )
}

function CancelButton({
  children,
  onClick
}: {
  children: ReactNode
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-3 py-1 text-xs text-[var(--ink-soft)] hover:bg-[var(--paper-soft)] rounded border border-[var(--rule)]"
    >
      {children}
    </button>
  )
}

function PrimaryButton({
  children,
  onClick,
  autoFocus,
  type = 'button'
}: {
  children: ReactNode
  onClick?: () => void
  autoFocus?: boolean
  type?: 'button' | 'submit'
}): JSX.Element {
  return (
    <button
      // eslint-disable-next-line jsx-a11y/no-autofocus -- modal opens, focus belongs on primary action
      autoFocus={autoFocus}
      type={type}
      onClick={onClick}
      className="px-3 py-1 rounded bg-[var(--accent)] text-[var(--paper)] text-xs font-medium hover:opacity-90"
    >
      {children}
    </button>
  )
}

function AlertBody({
  req,
  onResolve
}: {
  req: Extract<DialogRequest, { kind: 'alert' }>
  onResolve: (value: unknown) => void
}): JSX.Element {
  return (
    <>
      <DialogHeader title={req.opts.title} />
      <DialogMessage>{req.opts.message}</DialogMessage>
      <DialogFooter>
        <PrimaryButton autoFocus onClick={() => onResolve(undefined)}>
          {req.opts.okText ?? '好的'}
        </PrimaryButton>
      </DialogFooter>
    </>
  )
}

function ConfirmBody({
  req,
  onResolve
}: {
  req: Extract<DialogRequest, { kind: 'confirm' }>
  onResolve: (value: unknown) => void
}): JSX.Element {
  return (
    <>
      <DialogHeader title={req.opts.title} />
      <DialogMessage>{req.opts.message}</DialogMessage>
      <DialogFooter>
        <CancelButton onClick={() => onResolve(false)}>
          {req.opts.cancelText ?? '取消'}
        </CancelButton>
        <PrimaryButton autoFocus onClick={() => onResolve(true)}>
          {req.opts.confirmText ?? '确认'}
        </PrimaryButton>
      </DialogFooter>
    </>
  )
}

function PromptBody({
  req,
  onResolve
}: {
  req: Extract<DialogRequest, { kind: 'prompt' }>
  onResolve: (value: unknown) => void
}): JSX.Element {
  const [value, setValue] = useState(req.opts.defaultValue ?? '')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus + select on open so the user can type or overwrite immediately.
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  function submit(): void {
    const v = value
    if (req.opts.validate) {
      const err = req.opts.validate(v)
      if (err !== null) {
        setError(err)
        return
      }
    }
    onResolve(v)
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <DialogHeader title={req.opts.title} />
      <div className="px-5 py-3 space-y-2">
        {req.opts.label && (
          <label className="block text-xs text-[var(--ink-soft)]">
            {req.opts.label}
          </label>
        )}
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            if (error) setError(null)
          }}
          placeholder={req.opts.placeholder}
          className="w-full bg-[var(--paper)] border border-[var(--rule)] rounded px-2 py-1.5 text-sm text-[var(--ink)] focus:outline-none focus:border-[var(--accent)]"
        />
        {error && <p className="text-xs text-[var(--accent)]">{error}</p>}
      </div>
      <DialogFooter>
        <CancelButton onClick={() => onResolve(null)}>
          {req.opts.cancelText ?? '取消'}
        </CancelButton>
        <PrimaryButton type="submit">
          {req.opts.confirmText ?? '确认'}
        </PrimaryButton>
      </DialogFooter>
    </form>
  )
}
