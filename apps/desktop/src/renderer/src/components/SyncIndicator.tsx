import { useEffect, useRef, useState } from 'react'
import { CloudOff, RefreshCw } from 'lucide-react'
import { useSync } from '../state/sync'
import { SyncPopover } from './SyncPopover'

// lucide's cloud outline, reused as the base of the composite states so
// the indicator stays visually consistent with the (separate) remote-
// mode cloud toggle next to it.
const CLOUD_PATH = 'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z'

type GlyphProps = { className?: string }

function cloudBase(dashed = false): React.ReactElement {
  return (
    <path
      d={CLOUD_PATH}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeDasharray={dashed ? '2.6 2.6' : undefined}
    />
  )
}

export function SyncOffIcon({ className }: GlyphProps) {
  return (
    <svg viewBox="0 0 24 24" className={className}>
      {cloudBase(true)}
      <path d="M12 11v4M10 13h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

export function SyncOkIcon({ className }: GlyphProps) {
  return (
    <svg viewBox="0 0 24 24" className={className}>
      {cloudBase()}
      <path
        d="m9.5 13 2 2 3.5-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function SyncDirtyIcon({ className }: GlyphProps) {
  return (
    <svg viewBox="0 0 24 24" className={className}>
      {cloudBase()}
      <circle cx="12.5" cy="13" r="2.2" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function SyncConflictIcon({ className }: GlyphProps) {
  return (
    <svg viewBox="0 0 24 24" className={className}>
      {cloudBase()}
      <path d="M12.5 9.5v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12.5" cy="16" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  )
}

/**
 * Status-bar sync entry point: state-dependent icon + ↑n ↓n badge,
 * clicking toggles the sync popover. Renders nothing outside local
 * folder workspaces.
 */
export function SyncIndicator() {
  const { root, snapshot, summary, busy } = useSync()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Workspace switch closes a stale popover.
  useEffect(() => setOpen(false), [root])

  if (!root) return null

  const conflictCount = summary.conflicts.length
  const pushCount = summary.pushable.length
  const pullCount = summary.pullable.length

  let icon: React.ReactNode
  let badge: string | null = null
  let cls = 'text-[var(--ink-ghost)] hover:text-[var(--ink)]'
  let title = '云同步'

  if (busy === 'push' || busy === 'pull' || busy === 'enable') {
    icon = <RefreshCw className="w-3 h-3 animate-spin" />
    cls = 'text-[var(--ink-soft)]'
    title = busy === 'pull' ? '正在拉取…' : '正在推送…'
  } else if (!snapshot || snapshot.state === 'disabled') {
    icon = <SyncOffIcon className="w-3.5 h-3.5" />
    title = '为此文件夹开启云同步'
  } else if (snapshot.state === 'offline') {
    icon = <CloudOff className="w-3.5 h-3.5" />
    title = `无法连接服务器：${snapshot.error}`
  } else if (conflictCount > 0) {
    icon = <SyncConflictIcon className="w-3.5 h-3.5" />
    badge = String(conflictCount)
    cls = 'text-[var(--accent)] bg-[var(--accent-soft)]'
    title = `${conflictCount} 个文件两端都有改动`
  } else if (pushCount > 0 || pullCount > 0) {
    icon = <SyncDirtyIcon className="w-3.5 h-3.5" />
    badge = [pushCount > 0 ? `↑${pushCount}` : '', pullCount > 0 ? `↓${pullCount}` : '']
      .filter(Boolean)
      .join(' ')
    cls = 'text-[var(--accent)] bg-[var(--accent-soft)]/60'
    title = `${pushCount} 待推送 · ${pullCount} 待拉取`
  } else {
    icon = <SyncOkIcon className="w-3.5 h-3.5" />
    cls = 'text-[var(--ink-faint)] hover:text-[var(--ink)]'
    title = snapshot.lastSyncAt
      ? `已同步 · ${new Date(snapshot.lastSyncAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
      : '已同步'
  }

  return (
    <div ref={wrapRef} className="relative flex items-center gap-3">
      <button
        onClick={() => setOpen((v) => !v)}
        title={title}
        aria-expanded={open}
        className={`no-drag px-1 py-1 rounded transition flex items-center gap-1 ${cls}`}
      >
        {icon}
        {badge && <span className="font-mono text-[10px] leading-none">{badge}</span>}
      </button>
      {/* Hairline between the sync indicator and the remote-mode cloud
        * toggle — two cloud glyphs side by side would read as one control. */}
      <div className="w-px h-3.5 bg-[var(--rule)]" aria-hidden />
      {open && <SyncPopover onClose={() => setOpen(false)} />}
    </div>
  )
}
