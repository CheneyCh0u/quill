import type { ViewMode } from '../types'

const items: { id: ViewMode; label: string }[] = [
  { id: 'edit', label: '编辑' },
  { id: 'split', label: '分栏' },
  { id: 'preview', label: '预览' }
]

type Props = {
  value: ViewMode
  onChange: (m: ViewMode) => void
}

export function ModeSwitcher({ value, onChange }: Props) {
  return (
    <div className="no-drag flex items-center gap-0.5 p-0.5 rounded-full bg-[var(--paper-soft)]">
      {items.map(({ id, label }) => {
        const active = id === value
        return (
          <button
            key={id}
            onClick={() => onChange(id)}
            className={`px-3 py-1 rounded-full text-[12px] transition ${
              active
                ? 'bg-[var(--ink)] text-[var(--paper)] font-medium'
                : 'text-[var(--ink-soft)] hover:text-[var(--ink)]'
            }`}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}
