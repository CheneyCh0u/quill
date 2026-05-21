import { useCallback, useEffect, useRef, useState } from 'react'
import {
  MoreVertical,
  FileDown,
  FileText,
  FolderOpen,
  Link2,
  Loader2,
  Check
} from 'lucide-react'
import { useApp } from '../state/app'
import { useTheme } from '../state/theme'
import { exportToPdf, exportToHtml } from '../lib/export'
import { ipc } from '../lib/ipc'

function baseNameFor(path: string | null): string {
  if (!path) return 'untitled'
  const name = path.split(/[/\\]/).pop() ?? 'untitled'
  return name.replace(/\.[^.]+$/, '')
}

type Action = 'pdf' | 'html' | 'reveal' | 'copy-path'

export function ExportMenu() {
  const { state } = useApp()
  const { theme } = useTheme()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<Action | null>(null)
  const [justCopied, setJustCopied] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  const cur = state.currentFile
  const hasPath = !!cur?.path

  const doExportPdf = useCallback(async (): Promise<void> => {
    setOpen(false)
    if (!cur || busy) return
    setBusy('pdf')
    try {
      await exportToPdf({
        markdown: cur.buffer,
        defaultName: `${baseNameFor(cur.path)}.pdf`,
        theme
      })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('export pdf failed', err)
    } finally {
      setBusy(null)
    }
  }, [cur, busy, theme])

  const doExportHtml = useCallback(async (): Promise<void> => {
    setOpen(false)
    if (!cur || busy) return
    setBusy('html')
    try {
      await exportToHtml({
        markdown: cur.buffer,
        defaultName: `${baseNameFor(cur.path)}.html`,
        theme
      })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('export html failed', err)
    } finally {
      setBusy(null)
    }
  }, [cur, busy, theme])

  const doReveal = useCallback(async (): Promise<void> => {
    setOpen(false)
    if (!cur?.path) return
    try {
      await ipc.revealInFolder(cur.path)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('reveal failed', err)
    }
  }, [cur])

  const doCopyPath = useCallback(async (): Promise<void> => {
    if (!cur?.path) return
    try {
      await navigator.clipboard.writeText(cur.path)
      setJustCopied(true)
      window.setTimeout(() => {
        setJustCopied(false)
        setOpen(false)
      }, 700)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('copy path failed', err)
      setOpen(false)
    }
  }, [cur])

  // Native menu (File → Export → PDF…) triggers the same flow.
  useEffect(() => {
    return ipc.onMenu((cmd) => {
      if (cmd === 'export-pdf') void doExportPdf()
    })
  }, [doExportPdf])

  // Click-outside to close the dropdown.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  if (!cur) return null

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={!!busy}
        title="更多动作"
        className={`no-drag flex items-center justify-center w-8 h-8 rounded-md transition disabled:opacity-50 disabled:cursor-default ${
          open
            ? 'bg-[var(--paper-soft)] text-[var(--ink)]'
            : 'text-[var(--ink-faint)] hover:text-[var(--ink)] hover:bg-[var(--paper-soft)]'
        }`}
      >
        {busy ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <MoreVertical className="w-4 h-4" />
        )}
      </button>
      {open && (
        <div className="no-drag absolute top-full right-0 mt-1 min-w-[220px] py-1.5 rounded-[10px] bg-[var(--paper)] border border-[var(--rule)] shadow-lg z-50">
          <div className="font-display italic text-[11px] text-[var(--ink-faint)] px-3 pt-1 pb-1">
            导出
          </div>
          <MenuItem
            icon={<FileDown className="w-3.5 h-3.5" />}
            label="导出为 PDF…"
            shortcut="⌘⇧E"
            onClick={doExportPdf}
            loading={busy === 'pdf'}
          />
          <MenuItem
            icon={<FileText className="w-3.5 h-3.5" />}
            label="导出为 HTML…"
            onClick={doExportHtml}
            loading={busy === 'html'}
          />
          <div className="h-px bg-[var(--rule-soft)] mx-2 my-1.5" />
          <div className="font-display italic text-[11px] text-[var(--ink-faint)] px-3 pt-0.5 pb-1">
            文件
          </div>
          <MenuItem
            icon={<FolderOpen className="w-3.5 h-3.5" />}
            label="在 Finder 中显示"
            onClick={doReveal}
            disabled={!hasPath}
            disabledHint="未保存的文件没有路径"
          />
          <MenuItem
            icon={justCopied ? <Check className="w-3.5 h-3.5 text-[var(--accent)]" /> : <Link2 className="w-3.5 h-3.5" />}
            label={justCopied ? '已复制' : '复制文件路径'}
            shortcut="⌘⇧C"
            onClick={doCopyPath}
            disabled={!hasPath}
            disabledHint="未保存的文件没有路径"
          />
        </div>
      )}
    </div>
  )
}

type ItemProps = {
  icon: React.ReactNode
  label: string
  shortcut?: string
  onClick: () => void | Promise<void>
  loading?: boolean
  disabled?: boolean
  disabledHint?: string
}

function MenuItem({
  icon,
  label,
  shortcut,
  onClick,
  loading = false,
  disabled = false,
  disabledHint
}: ItemProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      title={disabled ? disabledHint : undefined}
      className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-[13px] text-left transition ${
        disabled
          ? 'text-[var(--ink-ghost)] cursor-default'
          : 'text-[var(--ink)] hover:bg-[var(--paper-soft)]'
      }`}
    >
      <span className={disabled ? 'text-[var(--ink-ghost)]' : 'text-[var(--ink-faint)]'}>
        {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : icon}
      </span>
      <span className="flex-1">{label}</span>
      {shortcut && (
        <kbd className="font-mono text-[10px] text-[var(--ink-faint)] tracking-wide">
          {shortcut}
        </kbd>
      )}
    </button>
  )
}
