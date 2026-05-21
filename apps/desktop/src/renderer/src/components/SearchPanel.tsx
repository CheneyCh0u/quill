import { useEffect, useRef, useState } from 'react'
import { ChevronUp, ChevronDown, X, CaseSensitive, Regex, Search, Replace } from 'lucide-react'
import type { EditorView } from '@codemirror/view'
import {
  SearchQuery,
  setSearchQuery,
  findNext,
  findPrevious,
  replaceNext,
  replaceAll
} from '@codemirror/search'

export type SearchMode = 'find' | 'replace'

type Props = {
  view: EditorView
  mode: SearchMode
  initialQuery: string
  onClose: () => void
  onSwitchMode: (m: SearchMode) => void
}

type MatchInfo = { current: number; total: number }

function buildQuery(args: {
  search: string
  caseSensitive: boolean
  regexp: boolean
  replace: string
}): SearchQuery {
  return new SearchQuery({
    search: args.search,
    caseSensitive: args.caseSensitive,
    regexp: args.regexp,
    replace: args.replace
  })
}

function countMatches(view: EditorView, query: SearchQuery): MatchInfo {
  if (!query.search || !query.valid) return { current: 0, total: 0 }
  let total = 0
  let current = 0
  const selFrom = view.state.selection.main.from
  const selTo = view.state.selection.main.to
  try {
    const cursor = query.getCursor(view.state.doc) as Iterator<{ from: number; to: number }>
    let m = cursor.next()
    while (!m.done) {
      total += 1
      if (m.value.from === selFrom && m.value.to === selTo) {
        current = total
      }
      m = cursor.next()
    }
  } catch {
    return { current: 0, total: 0 }
  }
  return { current, total }
}

export function SearchPanel({ view, mode, initialQuery, onClose, onSwitchMode }: Props) {
  const [query, setQuery] = useState(initialQuery)
  const [replacement, setReplacement] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [regex, setRegex] = useState(false)
  const [matchInfo, setMatchInfo] = useState<MatchInfo>({ current: 0, total: 0 })
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const replaceInputRef = useRef<HTMLInputElement | null>(null)

  // Push the current query into the editor whenever something changes.
  useEffect(() => {
    if (!view) return
    const q = buildQuery({ search: query, caseSensitive, regexp: regex, replace: replacement })
    view.dispatch({ effects: setSearchQuery.of(q) })
  }, [view, query, replacement, caseSensitive, regex])

  // Recompute match counts. Poll view.state by identity — every transaction
  // creates a fresh state object, so the check is O(1) and only the actual
  // recount (which iterates the doc) runs when something really changed.
  useEffect(() => {
    if (!view) return
    let lastState = view.state
    let raf = 0
    const compute = (): void => {
      const q = buildQuery({ search: query, caseSensitive, regexp: regex, replace: replacement })
      setMatchInfo(countMatches(view, q))
    }
    compute()
    const tick = (): void => {
      if (view.state !== lastState) {
        lastState = view.state
        compute()
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [view, query, replacement, caseSensitive, regex])

  useEffect(() => {
    searchInputRef.current?.focus()
    searchInputRef.current?.select()
  }, [mode])

  const close = (): void => {
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: '' })) })
    view.focus()
    onClose()
  }

  const onFindKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) findPrevious(view)
      else findNext(view)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'Tab' && mode === 'replace') {
      e.preventDefault()
      replaceInputRef.current?.focus()
    }
  }

  const onReplaceKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.metaKey || e.ctrlKey || e.shiftKey) replaceAll(view)
      else replaceNext(view)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault()
      searchInputRef.current?.focus()
    }
  }

  const hasQuery = query.length > 0
  const noMatches = hasQuery && matchInfo.total === 0
  const countLabel = !hasQuery
    ? null
    : matchInfo.total === 0
      ? '无匹配'
      : matchInfo.current === 0
        ? `${matchInfo.total} 处`
        : `${matchInfo.current} / ${matchInfo.total}`

  const fieldCls =
    'flex-1 min-w-0 px-2 py-1 text-[13px] bg-[var(--paper-soft)] border border-transparent rounded-md focus:outline-none focus:border-[var(--accent)]/40 focus:bg-[var(--paper)] text-[var(--ink)] placeholder:text-[var(--ink-faint)] placeholder:italic placeholder:font-["Fraunces"]'
  const iconBtnCls =
    'no-drag p-1 rounded-md text-[var(--ink-faint)] hover:text-[var(--ink)] hover:bg-[var(--paper-soft)] transition disabled:opacity-40 disabled:cursor-default'
  const toggleCls = (on: boolean): string =>
    `${iconBtnCls} ${on ? '!bg-[var(--paper-soft)] !text-[var(--accent)]' : ''}`

  return (
    <div className="no-drag shrink-0 border-b border-[var(--rule)] bg-[var(--paper-dim)] px-3 py-2 flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <Search className="w-3.5 h-3.5 text-[var(--ink-faint)] shrink-0" />
        <input
          ref={searchInputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onFindKey}
          placeholder="查找…"
          className={fieldCls}
        />
        {countLabel !== null && (
          <span
            className={`font-serif-zh italic text-[11.5px] tabular-nums px-1 select-none shrink-0 ${
              noMatches ? 'text-[var(--accent)]' : 'text-[var(--ink-faint)]'
            }`}
            title={
              matchInfo.total > 0 && matchInfo.current === 0 ? '回车跳到第一个' : undefined
            }
          >
            {countLabel}
          </span>
        )}
        <button
          onClick={() => setCaseSensitive((v) => !v)}
          className={toggleCls(caseSensitive)}
          title="区分大小写"
        >
          <CaseSensitive className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => setRegex((v) => !v)}
          className={toggleCls(regex)}
          title="正则表达式"
        >
          <Regex className="w-3.5 h-3.5" />
        </button>
        <div className="w-px h-4 bg-[var(--rule)] mx-0.5" />
        <button
          onClick={() => findPrevious(view)}
          disabled={!hasQuery || matchInfo.total === 0}
          title="上一个 (⇧↵)"
          className={iconBtnCls}
        >
          <ChevronUp className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => findNext(view)}
          disabled={!hasQuery || matchInfo.total === 0}
          title="下一个 (↵)"
          className={iconBtnCls}
        >
          <ChevronDown className="w-3.5 h-3.5" />
        </button>
        <div className="w-px h-4 bg-[var(--rule)] mx-0.5" />
        <button
          onClick={() => onSwitchMode(mode === 'find' ? 'replace' : 'find')}
          title={mode === 'find' ? '切换到替换 (⌘R)' : '仅查找 (⌘F)'}
          className={`${iconBtnCls} ${mode === 'replace' ? '!bg-[var(--paper-soft)] !text-[var(--accent)]' : ''}`}
        >
          <Replace className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={close}
          title="关闭 (Esc)"
          className={iconBtnCls}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {mode === 'replace' && (
        <div className="flex items-center gap-1.5 pl-[20px]">
          <input
            ref={replaceInputRef}
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={onReplaceKey}
            placeholder="替换为…"
            className={fieldCls}
          />
          <button
            onClick={() => replaceNext(view)}
            disabled={!hasQuery || matchInfo.total === 0}
            className="no-drag px-2.5 py-1 text-[12px] rounded-md text-[var(--ink-soft)] hover:text-[var(--ink)] hover:bg-[var(--paper-soft)] transition disabled:opacity-40 disabled:cursor-default"
            title="替换并跳到下一个 (↵)"
          >
            替换
          </button>
          <button
            onClick={() => replaceAll(view)}
            disabled={!hasQuery || matchInfo.total === 0}
            className="no-drag px-2.5 py-1 text-[12px] rounded-md text-[var(--ink-soft)] hover:text-[var(--ink)] hover:bg-[var(--paper-soft)] transition disabled:opacity-40 disabled:cursor-default font-medium"
            title="全部替换 (⌘↵)"
          >
            全部
          </button>
        </div>
      )}
    </div>
  )
}
