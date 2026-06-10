import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Folder, Loader2, Plus } from 'lucide-react'
import { useApp } from '../state/app'
import { createCloudWorkspace, fetchCloudWorkspaces } from '../lib/cloudWorkspaces'
import type { Workspace } from '../types'

/**
 * Remote-mode sidebar header: current cloud workspace + chevron, a
 * dropdown listing the server's workspaces (switch) and an inline
 * create row. Lives only in remote mode — local folder workspaces keep
 * the plain name header.
 */
export function CloudWorkspaceSwitcher() {
  const { state, dirty, switchRemoteWorkspace, askConfirm } = useApp()
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<Workspace[] | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  const ws = state.workspace
  const active = ws?.cloudWorkspace

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

  const toggle = useCallback(async () => {
    setOpen((v) => {
      if (!v) {
        setList(null)
        setError(null)
        setCreating(false)
        setNewName('')
        void fetchCloudWorkspaces()
          .then(setList)
          .catch((err) => {
            setList([])
            setError(err instanceof Error ? err.message : String(err))
          })
      }
      return !v
    })
  }, [])

  const guardedSwitch = useCallback(
    async (target: Workspace): Promise<void> => {
      if (target.id === active?.id) {
        setOpen(false)
        return
      }
      if (dirty) {
        const ok = await askConfirm({
          title: '放弃未保存的修改',
          message: '当前文件有未保存的修改，切换工作区会丢弃它们。',
          confirmLabel: '放弃并切换',
          danger: true
        })
        if (!ok) return
      }
      setBusy(true)
      try {
        await switchRemoteWorkspace(target)
        setOpen(false)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [active, dirty, askConfirm, switchRemoteWorkspace]
  )

  const handleCreate = useCallback(async (): Promise<void> => {
    const name = newName.trim()
    if (!name || /[/\\]/.test(name)) {
      setError('名称不能为空或包含斜杠')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const created = await createCloudWorkspace(name)
      await guardedSwitch(created)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [newName, guardedSwitch])

  if (ws?.kind !== 'remote') return null

  return (
    <div ref={wrapRef} className="relative min-w-0">
      <button
        onClick={() => void toggle()}
        aria-expanded={open}
        className="no-drag mt-0.5 max-w-full flex items-center gap-1 group"
        title="切换云端工作区"
      >
        <span className="font-display text-[14px] text-[var(--ink)] truncate">
          {active?.name ?? ws.rootName}
        </span>
        {active?.default && (
          <span className="text-[9px] px-1 py-px rounded bg-[var(--paper-edge)] text-[var(--ink-faint)] shrink-0">
            默认
          </span>
        )}
        <ChevronDown
          className={`w-3 h-3 text-[var(--ink-faint)] group-hover:text-[var(--ink)] shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1.5 w-56 rounded-lg border border-[var(--rule)] bg-[var(--paper)] shadow-[0_8px_28px_rgba(0,0,0,0.14),0_2px_6px_rgba(0,0,0,0.08)] text-[12.5px] z-50">
          <p className="px-3 pt-2.5 pb-1 text-[10px] uppercase tracking-[0.18em] text-[var(--ink-faint)] select-none">
            cloud workspaces
          </p>
          <div className="px-1.5 pb-1 max-h-56 overflow-y-auto">
            {list === null ? (
              <div className="px-2 py-2.5 flex items-center gap-2 text-[var(--ink-faint)]">
                <Loader2 className="w-3 h-3 animate-spin" /> 加载中…
              </div>
            ) : (
              list.map((w) => {
                const isActive = w.id === active?.id
                return (
                  <button
                    key={w.id}
                    onClick={() => void guardedSwitch(w)}
                    disabled={busy}
                    className={`w-full px-2 py-1.5 rounded-md flex items-center gap-2 text-left transition disabled:opacity-50 ${
                      isActive ? 'bg-[var(--paper-soft)]' : 'hover:bg-[var(--paper-soft)]'
                    }`}
                  >
                    <Folder className="w-3 h-3 text-[var(--ink-faint)] shrink-0" />
                    <span
                      className={`flex-1 truncate ${isActive ? 'text-[var(--ink)]' : 'text-[var(--ink-soft)]'}`}
                    >
                      {w.name}
                    </span>
                    {w.default && (
                      <span className="text-[9px] px-1 py-px rounded bg-[var(--paper-edge)] text-[var(--ink-faint)] shrink-0">
                        默认
                      </span>
                    )}
                    {isActive && <Check className="w-3 h-3 text-[var(--accent)] shrink-0" />}
                  </button>
                )
              })
            )}
          </div>
          <div className="border-t border-[var(--rule-soft)] px-1.5 py-1">
            {creating ? (
              <div className="px-1 py-1 flex items-center gap-1.5">
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => {
                    setNewName(e.target.value)
                    if (error) setError(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleCreate()
                  }}
                  placeholder="工作区名"
                  className="flex-1 min-w-0 px-2 py-1 rounded bg-[var(--paper)] font-mono text-[11.5px] text-[var(--ink)] border border-[var(--rule)] focus:outline-none focus:border-[var(--accent)]/60"
                />
                <button
                  onClick={() => void handleCreate()}
                  disabled={busy || !newName.trim()}
                  className="px-2 py-1 rounded bg-[var(--accent)] text-[var(--paper)] text-[11px] font-medium hover:opacity-90 disabled:opacity-50 transition shrink-0"
                >
                  {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : '创建'}
                </button>
              </div>
            ) : (
              <button
                onClick={() => setCreating(true)}
                className="w-full px-2 py-1.5 rounded-md flex items-center gap-2 text-[var(--ink-soft)] hover:text-[var(--ink)] hover:bg-[var(--paper-soft)] transition"
              >
                <Plus className="w-3 h-3 shrink-0" />
                新建工作区…
              </button>
            )}
          </div>
          {error && (
            <p className="px-3 pb-2 font-serif-zh italic text-[11px] text-[var(--accent)] break-all">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
