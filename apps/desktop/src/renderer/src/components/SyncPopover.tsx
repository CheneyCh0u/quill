import { useCallback, useEffect, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  CloudOff,
  Folder,
  Loader2,
  Plus,
  RefreshCw,
  Settings,
  Trash2
} from 'lucide-react'
import { useApp } from '../state/app'
import { useSync } from '../state/sync'
import { usePrefs } from '../state/prefs'
import { ipc } from '../lib/ipc'
import { SYNC_STATUS_LABELS } from '../lib/syncSummary'
import type { SyncEntry, Workspace } from '../types'

function entryGlyph(e: SyncEntry): React.ReactNode {
  switch (e.status) {
    case 'local-only':
      return <Plus className="w-3 h-3 text-[var(--accent)]" />
    case 'local-modified':
      return <span className="w-2 h-2 rounded-full bg-[var(--accent)] mx-0.5" />
    case 'local-deleted':
    case 'remote-deleted':
      return <Trash2 className="w-3 h-3 text-[var(--ink-faint)]" />
    default:
      return <ArrowDown className="w-3 h-3 text-[var(--ink-faint)]" />
  }
}

function DiffRow({ entry }: { entry: SyncEntry }) {
  const deleted = entry.status === 'local-deleted' || entry.status === 'remote-deleted'
  return (
    <div className="px-2 py-1 rounded flex items-center gap-2 hover:bg-[var(--paper-soft)]">
      {entryGlyph(entry)}
      <span
        className={`font-mono text-[11.5px] truncate ${
          deleted ? 'text-[var(--ink-soft)] line-through' : 'text-[var(--ink)]'
        }`}
      >
        {entry.path}
      </span>
      <span className="flex-1" />
      <span className="text-[11px] text-[var(--ink-faint)] shrink-0">
        {SYNC_STATUS_LABELS[entry.status]}
      </span>
    </div>
  )
}

/**
 * The sync panel floating above the status-bar indicator. One component,
 * five branches: no server config / not enabled (+ bind-existing list) /
 * conflicts / pending diffs / all clean. Offline gets a retry banner.
 */
export function SyncPopover({ onClose }: { onClose: () => void }) {
  const { state } = useApp()
  const {
    snapshot,
    summary,
    busy,
    error,
    serverConfigured,
    refresh,
    push,
    pull,
    enable,
    bindExisting,
    resolve,
    disable,
    listSpaces
  } = useSync()
  const { prefs } = usePrefs()
  const rootName = state.workspace?.rootName ?? ''

  const [remotePath, setRemotePath] = useState(rootName)
  const [view, setView] = useState<'main' | 'bind'>('main')
  const [spaces, setSpaces] = useState<Workspace[] | null>(null)
  const [confirmingDisable, setConfirmingDisable] = useState(false)

  // Re-check when the panel opens so the list is fresh.
  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadSpaces = useCallback(async () => {
    setView('bind')
    setSpaces(null)
    try {
      setSpaces(await listSpaces())
    } catch {
      setSpaces([])
    }
  }, [listSpaces])

  const openSettings = useCallback(() => {
    void ipc.openSettingsWindow()
    onClose()
  }, [onClose])

  const body = (() => {
    // Branch e — no server configured at all.
    if (!serverConfigured && (!snapshot || snapshot.state === 'disabled')) {
      return (
        <div className="px-4 pt-4 pb-4">
          <div className="flex items-center gap-2 mb-1">
            <CloudOff className="w-4 h-4 text-[var(--ink-ghost)]" />
            <span className="font-medium text-[13px] text-[var(--ink)]">
              尚未配置远程服务器
            </span>
          </div>
          <p className="font-serif-zh italic text-[11.5px] text-[var(--ink-faint)] leading-relaxed mb-3">
            云同步需要一个 Quill 自部署服务。先在设置 → 远程里填好服务器地址与访问密码。
          </p>
          <button
            onClick={openSettings}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-[var(--rule)] text-[12px] text-[var(--ink-soft)] hover:bg-[var(--paper-soft)] hover:text-[var(--ink)] transition"
          >
            <Settings className="w-3 h-3" />
            打开设置 → 远程
          </button>
        </div>
      )
    }

    // Branch b — pick an existing space (换电脑场景).
    if (view === 'bind') {
      return (
        <>
          <div className="px-4 pt-4 pb-2">
            <div className="font-medium text-[13px] text-[var(--ink)] mb-1">
              云端工作区
            </div>
            <p className="font-serif-zh italic text-[11.5px] text-[var(--ink-faint)]">
              绑定后会把云端内容拉取到当前文件夹。
            </p>
          </div>
          <div className="px-2 pb-2 space-y-px max-h-48 overflow-auto">
            {spaces === null ? (
              <div className="px-2 py-3 flex items-center gap-2 text-[11.5px] text-[var(--ink-faint)]">
                <Loader2 className="w-3 h-3 animate-spin" /> 加载中…
              </div>
            ) : spaces.length === 0 ? (
              <p className="px-2 py-3 font-serif-zh italic text-[11.5px] text-[var(--ink-faint)]">
                服务器上还没有云端工作区。
              </p>
            ) : (
              spaces.map((s) => (
                <button
                  key={s.id}
                  onClick={() => void bindExisting(s)}
                  disabled={busy !== null}
                  className="w-full px-2 py-2 rounded flex items-center gap-2.5 hover:bg-[var(--paper-soft)] disabled:opacity-50 text-left transition"
                >
                  <Folder className="w-3.5 h-3.5 text-[var(--ink-faint)] shrink-0" />
                  <span className="flex-1 min-w-0">
                    <span className="block text-[12px] text-[var(--ink)]">{s.name}</span>
                    <span className="block font-mono text-[10.5px] text-[var(--ink-faint)] truncate">
                      /{s.remotePath}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
          <div className="px-4 py-2.5 border-t border-[var(--rule-soft)]">
            <button
              onClick={() => setView('main')}
              className="text-[11px] text-[var(--ink-faint)] hover:text-[var(--ink)]"
            >
              ← 返回
            </button>
          </div>
        </>
      )
    }

    // Branch a — bound? no → enable form.
    if (!snapshot || snapshot.state === 'disabled') {
      return (
        <div className="px-4 pt-4 pb-4">
          <div className="font-medium text-[13px] text-[var(--ink)] mb-1">
            为「{rootName}」开启云同步
          </div>
          <p className="font-serif-zh italic text-[11.5px] text-[var(--ink-faint)] leading-relaxed mb-3">
            将此文件夹与服务器上的目录建立双向同步。开启记录保存在服务器，换电脑后仍可识别。
          </p>
          <label className="block text-[11px] text-[var(--ink-soft)] mb-1">
            云端目录（vault 根下）
          </label>
          <input
            value={remotePath}
            onChange={(e) => setRemotePath(e.target.value)}
            className="w-full px-2.5 py-1.5 mb-3 rounded-md bg-[var(--paper)] font-mono text-[12px] text-[var(--ink)] border border-[var(--rule)] focus:outline-none focus:border-[var(--accent)]/50"
          />
          <button
            onClick={() => void enable(rootName, remotePath.trim())}
            disabled={busy !== null || !remotePath.trim()}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md bg-[var(--accent)] text-[var(--paper)] text-[12px] font-medium hover:opacity-90 disabled:opacity-50 transition"
          >
            {busy === 'enable' && <Loader2 className="w-3 h-3 animate-spin" />}
            开启同步并首次推送
          </button>
          <p className="mt-2 text-[11px] text-[var(--ink-faint)] text-center">
            或{' '}
            <button
              onClick={() => void loadSpaces()}
              className="underline decoration-[var(--ink-ghost)] hover:text-[var(--ink)]"
            >
              绑定已有的云端工作区…
            </button>
          </p>
        </div>
      )
    }

    if (snapshot.state === 'offline') {
      return (
        <div className="px-4 py-4">
          <div className="flex items-center gap-2 mb-1">
            <CloudOff className="w-4 h-4 text-[var(--ink-ghost)]" />
            <span className="font-medium text-[13px] text-[var(--ink)]">无法连接服务器</span>
          </div>
          <p className="font-mono text-[11px] text-[var(--ink-faint)] break-all mb-3">
            {snapshot.error}
          </p>
          <button
            onClick={() => void refresh()}
            disabled={busy !== null}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-[var(--rule)] text-[12px] text-[var(--ink-soft)] hover:bg-[var(--paper-soft)] disabled:opacity-50 transition"
          >
            {busy === 'check' ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <RefreshCw className="w-3 h-3" />
            )}
            重试
          </button>
        </div>
      )
    }

    // Ready — conflicts first, then pending diffs, then clean.
    const { pushable, pullable, conflicts } = summary
    return (
      <>
        {conflicts.length > 0 && (
          <div className="px-2 pt-2 pb-1">
            <p className="px-2 pb-1.5 font-serif-zh italic text-[11px] text-[var(--ink-faint)]">
              {conflicts.length} 个文件两端都有改动；被覆盖一侧会先备份为
              *.conflict-时间 文件。
            </p>
            <div className="space-y-1">
              {conflicts.map((e) => (
                <div key={e.path} className="px-2 py-1.5 rounded bg-[var(--accent-soft)]/40">
                  <div className="font-mono text-[11.5px] text-[var(--ink)] truncate">
                    {e.path}
                  </div>
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <button
                      onClick={() => void resolve(e.path, 'local')}
                      disabled={busy !== null}
                      className="flex-1 px-2 py-1 rounded border border-[var(--rule)] text-[11px] text-[var(--ink-soft)] hover:bg-[var(--paper-soft)] disabled:opacity-50 transition"
                    >
                      保留本地 ↑
                    </button>
                    <button
                      onClick={() => void resolve(e.path, 'remote')}
                      disabled={busy !== null}
                      className="flex-1 px-2 py-1 rounded border border-[var(--rule)] text-[11px] text-[var(--ink-soft)] hover:bg-[var(--paper-soft)] disabled:opacity-50 transition"
                    >
                      保留云端 ↓
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {summary.clean ? (
          <div className="px-4 py-5 text-center">
            <p className="font-serif-zh italic text-[12.5px] text-[var(--ink-soft)]">
              本地与云端一致
            </p>
            <p className="text-[11px] text-[var(--ink-faint)] mt-1">
              {snapshot.fileCount} 个文件
              {snapshot.lastSyncAt
                ? ` · 上次同步 ${new Date(snapshot.lastSyncAt).toLocaleString('zh-CN', {
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit'
                  })}`
                : ''}
            </p>
          </div>
        ) : (
          <>
            <div className="px-2 py-2 max-h-52 overflow-auto">
              {pushable.length > 0 && (
                <>
                  <div className="px-2 pt-1 pb-1.5 flex items-center gap-1.5 text-[11px] text-[var(--ink-faint)]">
                    <ArrowUp className="w-3 h-3" />
                    待推送{' '}
                    <span className="text-[var(--ink-soft)] font-medium">
                      {pushable.length}
                    </span>
                  </div>
                  <div className="space-y-px">
                    {pushable.map((e) => (
                      <DiffRow key={e.path} entry={e} />
                    ))}
                  </div>
                </>
              )}
              {pullable.length > 0 && (
                <>
                  <div className="px-2 pt-3 pb-1.5 flex items-center gap-1.5 text-[11px] text-[var(--ink-faint)]">
                    <ArrowDown className="w-3 h-3" />
                    待拉取{' '}
                    <span className="text-[var(--ink-soft)] font-medium">
                      {pullable.length}
                    </span>
                  </div>
                  <div className="space-y-px">
                    {pullable.map((e) => (
                      <DiffRow key={e.path} entry={e} />
                    ))}
                  </div>
                </>
              )}
            </div>
            {(pushable.length > 0 || pullable.length > 0) && (
              <div className="px-4 py-3 border-t border-[var(--rule-soft)] flex items-center gap-2">
                {pushable.length > 0 && (
                  <button
                    onClick={() => void push()}
                    disabled={busy !== null}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md bg-[var(--accent)] text-[var(--paper)] text-[12px] font-medium hover:opacity-90 disabled:opacity-50 transition"
                  >
                    {busy === 'push' ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <ArrowUp className="w-3 h-3" />
                    )}
                    推送 {pushable.length} 项
                  </button>
                )}
                {pullable.length > 0 && (
                  <button
                    onClick={() => void pull()}
                    disabled={busy !== null}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md border border-[var(--rule)] text-[var(--ink-soft)] text-[12px] hover:bg-[var(--paper-soft)] hover:text-[var(--ink)] disabled:opacity-50 transition"
                  >
                    {busy === 'pull' ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <ArrowDown className="w-3 h-3" />
                    )}
                    拉取 {pullable.length} 项
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </>
    )
  })()

  const bound = snapshot && snapshot.state !== 'disabled'

  return (
    <div className="absolute bottom-full right-0 mb-2 w-80 rounded-lg border border-[var(--rule)] bg-[var(--paper)] shadow-[0_8px_28px_rgba(0,0,0,0.14),0_2px_6px_rgba(0,0,0,0.08)] text-[12px] z-50">
      {/* Header — only when bound (the enable / no-server branches carry
        * their own titles). */}
      {bound && view === 'main' && (
        <div className="px-4 pt-3.5 pb-3 border-b border-[var(--rule-soft)]">
          <div className="flex items-center gap-2">
            <span className="font-medium text-[13px] text-[var(--ink)]">云同步</span>
            <span className="font-display italic text-[12px] text-[var(--ink-faint)] truncate">
              {rootName}
            </span>
            <span className="flex-1" />
            <button
              onClick={openSettings}
              title="同步设置"
              className="p-1 rounded text-[var(--ink-faint)] hover:text-[var(--ink)] hover:bg-[var(--paper-soft)] transition"
            >
              <Settings className="w-3 h-3" />
            </button>
          </div>
          <div className="mt-1 text-[11px] text-[var(--ink-faint)]">
            {prefs.autoSync ? `自动同步 每 ${prefs.autoSyncIntervalMin} 分钟` : '自动同步已关闭'}
            {' · '}
            <span className="font-mono">{snapshot.binding.remotePath}</span>
          </div>
        </div>
      )}

      {body}

      {error && (
        <p className="px-4 pb-2 font-serif-zh italic text-[11.5px] text-[var(--accent)] break-all">
          {error}
        </p>
      )}

      {bound && view === 'main' && (
        <div className="px-4 pb-3 pt-1 flex items-center justify-between text-[11px] text-[var(--ink-faint)]">
          <button
            onClick={() => void refresh()}
            disabled={busy !== null}
            className="flex items-center gap-1 hover:text-[var(--ink)] disabled:opacity-50 transition"
          >
            {busy === 'check' ? (
              <Loader2 className="w-2.5 h-2.5 animate-spin" />
            ) : (
              <RefreshCw className="w-2.5 h-2.5" />
            )}
            立即检查
          </button>
          {confirmingDisable ? (
            <span className="flex items-center gap-2">
              <span className="font-serif-zh italic">关闭同步？不删除任何文件</span>
              <button
                onClick={() => void disable().then(() => setConfirmingDisable(false))}
                className="text-[var(--accent)] hover:underline"
              >
                确认
              </button>
              <button
                onClick={() => setConfirmingDisable(false)}
                className="hover:text-[var(--ink)]"
              >
                取消
              </button>
            </span>
          ) : (
            <button
              onClick={() => setConfirmingDisable(true)}
              className="hover:text-[var(--accent)] transition"
            >
              关闭此文件夹的同步…
            </button>
          )}
        </div>
      )}
    </div>
  )
}
