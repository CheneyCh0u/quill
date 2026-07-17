import { useEffect, useState } from 'react'
import { useApp } from '../state/app'
import { getRecent } from '../lib/recent'
import type { RecentEntry } from '../types'

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const s = Math.floor(diff / 1000)
  if (s < 60) return '刚刚'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  return new Date(ts).toLocaleDateString()
}

type ActionCardProps = {
  label: string
  hint: string
  shortcut: string
  onClick: () => void
}

function ActionCard({ label, hint, shortcut, onClick }: ActionCardProps) {
  return (
    <button
      onClick={onClick}
      className="no-drag group rounded-[10px] py-7 px-5 text-left bg-[var(--paper-soft)] border border-[var(--rule-soft)] hover:border-[var(--accent)]/40 hover:bg-[var(--paper-dim)] transition"
    >
      <div className="text-[var(--ink)] text-sm font-medium mb-1">{label}</div>
      <div className="font-serif-zh italic text-xs text-[var(--ink-faint)]">{hint}</div>
      <div className="mt-3">
        <kbd className="font-mono text-[11px] tracking-wide px-1.5 py-0.5 rounded border border-[var(--rule)] bg-[var(--paper)] text-[var(--ink-soft)]">
          {shortcut}
        </kbd>
      </div>
    </button>
  )
}

type EmptyStateProps = {
  /** Triggered by the "连接远程" card. Resolves with the saved config
   *  if one exists (silent reconnect) or surfaces the login dialog
   *  otherwise — Shell owns that decision. */
  onConnectRemote: () => Promise<void> | void
}

export function EmptyState({ onConnectRemote }: EmptyStateProps) {
  const { newFile, openFolder, openFile, openFolderAt, openFileAt } = useApp()
  const [recent, setRecent] = useState<RecentEntry[]>([])

  useEffect(() => {
    setRecent(getRecent())
  }, [])

  return (
    // flex + m-auto (not justify-center): centered while the content fits,
    // but when the recent list makes it taller than the window the top must
    // stay reachable via scroll instead of being clipped under the titlebar.
    <div className="h-full w-full overflow-y-auto flex select-none px-8">
      <div className="w-full max-w-[720px] m-auto pt-16 pb-12">
        <div className="text-center mb-12">
          <p className="text-[11px] uppercase tracking-[0.22em] text-[var(--ink-faint)] mb-3">
            a quiet place to write
          </p>
          <h1
            className="font-display-wonk text-[88px] leading-none text-[var(--ink)]"
            style={{ fontWeight: 400 }}
          >
            Quill
          </h1>
          <p className="font-serif-zh italic text-sm text-[var(--ink-soft)] mt-4">
            让 markdown 回到它的本意 —— 文字。
          </p>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <ActionCard
            label="打开文件夹"
            hint="作为 vault 工作"
            shortcut="⌘⇧O"
            onClick={openFolder}
          />
          <ActionCard
            label="打开文件"
            hint="单文件模式"
            shortcut="⌘O"
            onClick={openFile}
          />
          <ActionCard
            label="新建文件"
            hint="空白纸张"
            shortcut="⌘N"
            onClick={newFile}
          />
          <ActionCard
            label="连接远程"
            hint="自部署服务"
            shortcut="·"
            onClick={() => {
              void onConnectRemote()
            }}
          />
        </div>

        <p className="mt-4 text-center text-xs text-[var(--ink-faint)]">
          或者把一份 .md 文件 / 文件夹拖到这里
        </p>

        {recent.length > 0 && (
          <div className="mt-12">
            <p className="font-display italic text-[13px] text-[var(--ink-faint)] mb-3 tracking-wide">
              最近 / Recent
            </p>
            <ul className="divide-y divide-[var(--rule-soft)]">
              {recent.map((r) => (
                <li key={r.path}>
                  <button
                    onClick={() => {
                      if (r.type === 'folder') void openFolderAt(r.path)
                      else void openFileAt(r.path)
                    }}
                    className="no-drag w-full py-2.5 px-2 -mx-2 rounded-md flex items-center gap-3 hover:bg-[var(--paper-dim)] transition text-left"
                  >
                    <span
                      className={`text-[13px] shrink-0 ${
                        r.type === 'folder'
                          ? 'text-[var(--accent)]'
                          : 'text-[var(--ink-faint)]'
                      }`}
                    >
                      {r.type === 'folder' ? '▸' : '▪'}
                    </span>
                    <span className="text-sm text-[var(--ink)] truncate">{r.name}</span>
                    <span className="text-xs text-[var(--ink-faint)] truncate ml-2 hidden sm:block">
                      {r.path}
                    </span>
                    <span className="font-serif-zh italic text-xs text-[var(--ink-faint)] shrink-0 ml-auto">
                      {timeAgo(r.openedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
