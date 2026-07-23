import { RefreshCw } from 'lucide-react'

type Props = {
  label: string
  refreshing: boolean
  onClick: () => void
  size?: 'compact' | 'regular'
}

export function RefreshButton({ label, refreshing, onClick, size = 'compact' }: Props) {
  const buttonSize = size === 'regular' ? 'p-1.5' : 'p-1'
  const iconSize = size === 'regular' ? 'h-4 w-4' : 'h-3.5 w-3.5'

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={refreshing}
      aria-label={label}
      aria-busy={refreshing}
      title={label}
      className={`${buttonSize} no-drag rounded-md text-[var(--ink-faint)] hover:bg-[var(--paper-soft)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]/50 transition-transform active:scale-95 disabled:cursor-wait disabled:opacity-60 motion-reduce:transition-none motion-reduce:active:scale-100`}
    >
      <RefreshCw
        aria-hidden="true"
        className={`${iconSize} ${refreshing ? 'animate-spin motion-reduce:animate-none' : ''}`}
      />
    </button>
  )
}
