// Shared form primitives for the settings panels — extracted from
// GeneralPanel once RemotePanel needed the same Row / PillGroup / Toggle.

type RowProps = {
  label: string
  hint?: string
  children: React.ReactNode
}

export function Row({ label, hint, children }: RowProps) {
  return (
    <div className="flex items-start py-4 border-b border-[var(--rule-soft)] last:border-b-0">
      <div className="w-[140px] shrink-0 pt-1">
        <div className="text-[13.5px] font-medium text-[var(--ink)]">{label}</div>
        {hint && (
          <div className="font-serif-zh italic text-[12px] text-[var(--ink-faint)] mt-0.5">
            {hint}
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  )
}

type PillProps<T extends string | number> = {
  options: Array<{ value: T; label: string }>
  value: T
  onChange: (v: T) => void
}

export function PillGroup<T extends string | number>({
  options,
  value,
  onChange
}: PillProps<T>) {
  return (
    <div className="inline-flex items-center gap-0.5 p-0.5 rounded-full bg-[var(--paper-soft)]">
      {options.map((opt) => {
        const isActive = opt.value === value
        return (
          <button
            key={String(opt.value)}
            onClick={() => onChange(opt.value)}
            className={`px-3.5 py-1 rounded-full text-[12.5px] transition ${
              isActive
                ? 'bg-[var(--ink)] text-[var(--paper)] font-medium'
                : 'text-[var(--ink-soft)] hover:text-[var(--ink)]'
            }`}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

type ToggleProps = {
  checked: boolean
  onChange: (v: boolean) => void
}

export function Toggle({ checked, onChange }: ToggleProps) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`relative inline-flex items-center w-10 h-5 rounded-full transition ${
        checked ? 'bg-[var(--accent)]' : 'bg-[var(--paper-soft)] border border-[var(--rule)]'
      }`}
      aria-pressed={checked}
    >
      <span
        className={`absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full bg-[var(--paper)] shadow transition-transform ${
          checked ? 'translate-x-[22px]' : 'translate-x-[3px]'
        }`}
      />
    </button>
  )
}
