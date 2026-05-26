import { useMemo } from 'react'
import { Cloud, CloudOff, Sparkles } from 'lucide-react'
import { useApp } from '../state/app'
import { countWords } from '../lib/markdown'
import { ThemeToggle } from './ThemeToggle'

type Props = {
  agentOpen: boolean
  /** Undefined when the current workspace doesn't support the local agent
   *  (e.g. remote mode). Hides the toggle button entirely in that case. */
  onToggleAgent: (() => void) | undefined
  /** Click handler for the cloud icon when the user is in local mode.
   *  Shell wires this to its smart connect handler (auto-reconnect or
   *  open the login dialog). */
  onConnectRemote: () => Promise<void> | void
  /** Click handler for the cloud icon when the user is already in remote
   *  mode — switches the active vault back to local and restores the
   *  snapshot captured at entry. */
  onExitRemote: () => Promise<void> | void
}

export function StatusBar({
  agentOpen,
  onToggleAgent,
  onConnectRemote,
  onExitRemote
}: Props) {
  const { state, mode, dirty } = useApp()
  const cur = state.currentFile
  const inRemote = state.workspace?.kind === 'remote'

  const words = useMemo(() => (cur ? countWords(cur.buffer) : 0), [cur])

  const saveNode = state.saving ? (
    <span className="font-serif-zh italic text-[var(--ink-faint)]">保存中…</span>
  ) : dirty ? (
    <span className="flex items-center gap-1.5 text-[var(--accent)]">
      <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)]" />
      未保存
    </span>
  ) : cur ? (
    <span className="font-serif-zh italic text-[var(--ink-faint)]">已保存</span>
  ) : null

  return (
    <footer className="h-7 px-4 flex items-center gap-3 text-[11px] text-[var(--ink-faint)] border-t border-[var(--rule)] bg-[var(--paper-dim)] select-none shrink-0">
      {cur ? (
        <>
          <span>
            <span className="text-[var(--ink-soft)]">{words.toLocaleString()}</span> 字
          </span>
          <span className="text-[var(--ink-ghost)]">·</span>
          {saveNode}
        </>
      ) : (
        <span className="font-serif-zh italic">
          {mode === 'empty' ? '未打开任何内容' : ''}
        </span>
      )}
      <div className="flex-1" />
      <button
        onClick={() => {
          if (inRemote) void onExitRemote()
          else void onConnectRemote()
        }}
        title={inRemote ? '返回本地' : '连接远程'}
        aria-pressed={inRemote}
        className={[
          'no-drag p-1 rounded transition flex items-center justify-center',
          inRemote
            ? 'text-[var(--accent)] bg-[var(--accent-soft)]/60'
            : 'text-[var(--ink-faint)] hover:text-[var(--ink)] hover:bg-[var(--paper-soft)]'
        ].join(' ')}
      >
        {inRemote ? (
          <Cloud className="w-3.5 h-3.5" />
        ) : (
          <CloudOff className="w-3.5 h-3.5" />
        )}
      </button>
      {onToggleAgent && (
        <button
          onClick={onToggleAgent}
          title={agentOpen ? '关闭 Agent (⌘J)' : '打开 Agent (⌘J)'}
          className={[
            'no-drag p-1 rounded transition flex items-center justify-center',
            agentOpen
              ? 'text-[var(--accent)] bg-[var(--accent-soft)]/60'
              : 'text-[var(--ink-faint)] hover:text-[var(--ink)] hover:bg-[var(--paper-soft)]'
          ].join(' ')}
        >
          <Sparkles className="w-3.5 h-3.5" />
        </button>
      )}
      <ThemeToggle />
    </footer>
  )
}
