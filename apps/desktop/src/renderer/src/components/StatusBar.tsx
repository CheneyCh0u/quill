import { useMemo } from 'react'
import { Sparkles } from 'lucide-react'
import { useApp } from '../state/app'
import { countWords } from '../lib/markdown'
import { ThemeToggle } from './ThemeToggle'

type Props = {
  agentOpen: boolean
  /** Undefined when the current workspace doesn't support the local agent
   *  (e.g. remote mode). Hides the toggle button entirely in that case. */
  onToggleAgent: (() => void) | undefined
}

export function StatusBar({ agentOpen, onToggleAgent }: Props) {
  const { state, mode, dirty } = useApp()
  const cur = state.currentFile

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
