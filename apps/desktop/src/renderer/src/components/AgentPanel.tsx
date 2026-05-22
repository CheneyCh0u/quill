import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Send,
  X,
  StopCircle,
  Loader2,
  ChevronDown,
  ChevronRight,
  Wrench,
  FilePlus,
  FilePen,
  FileText,
  Check,
  ListChecks,
  Route as RouteIcon,
  PlayCircle
} from 'lucide-react'
import { useApp } from '../state/app'
import { ipc } from '../lib/ipc'
import { render as renderMd } from '../lib/markdown'
import { itemsToMessages, type ConvItem } from '../lib/itemsToMessages'
import { sanitizeItems } from '../lib/sanitizeItems'
import { coerceUsage, sumUsage, formatTokens } from '../lib/usage'
import type {
  AgentEvent,
  AgentMode,
  ApprovalPayload,
  PlanStep,
  RouteDecision,
  Scope
} from '../types'

const WRITE_TOOL_NAMES = new Set(['write_file', 'apply_edit', 'create_file'])

/**
 * Parse a slash command prefix to force a routing mode. `/plan ...` and
 * `/build ...` skip the Router. Anything else (including bare `/plan` with no
 * text) goes through 'auto'.
 */
function parseSlashCommand(input: string): { mode: AgentMode; prompt: string } {
  const m = input.match(/^\/(plan|build)\s+([\s\S]+)$/)
  if (m) {
    return { mode: m[1] as AgentMode, prompt: m[2].trim() }
  }
  return { mode: 'auto', prompt: input }
}

type DefaultProvider = { id: string; model: string } | null

type ApprovalStatus = 'pending' | 'approved' | 'rejected'

type Item =
  | { kind: 'user'; text: string; forcedMode?: 'plan' | 'build' }
  | { kind: 'assistant-text'; text: string }
  | { kind: 'tool-call'; toolCallId: string; name: string; args: unknown }
  | { kind: 'tool-result'; toolCallId: string; name: string; result: unknown }
  | {
      kind: 'approval'
      toolCallId: string
      toolName: string
      payload: ApprovalPayload
      status: ApprovalStatus
      resultError?: string
      resultPath?: string
    }
  | { kind: 'route'; decision: RouteDecision }
  | {
      kind: 'plan'
      steps: PlanStep[]
      status: 'streaming' | 'awaiting' | 'complete' | 'dismissed'
      /** Per-step inclusion toggle, only used while status='awaiting' but
       *  preserved after for visual record. Defaults to all true when the
       *  plan first lands. */
      enabled?: boolean[]
    }
  | { kind: 'phase-divider'; phase: 'plan' | 'build' }
  | { kind: 'truncated'; count: number }
  | { kind: 'plan-usage'; usage: unknown }
  | { kind: 'error'; message: string }
  | { kind: 'finish'; usage?: unknown }

type Props = {
  onClose: () => void
}

function genRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function computeScope(
  workspaceRoot: string | undefined,
  currentPath: string | null,
  hasCurrentFile: boolean
): Scope | null {
  if (workspaceRoot) return { kind: 'workspace', root: workspaceRoot }
  if (currentPath) return { kind: 'single-file', path: currentPath }
  if (hasCurrentFile) return { kind: 'untitled' }
  return null
}

function scopeLabel(scope: Scope | null): string {
  if (!scope) return 'no scope'
  if (scope.kind === 'workspace') return `workspace · ${scope.root.split('/').pop()}`
  if (scope.kind === 'single-file') return `file · ${scope.path.split('/').pop()}`
  return 'untitled'
}

export function AgentPanel({ onClose }: Props) {
  const { state, reloadCurrentFile } = useApp()
  const cur = state.currentFile
  // Snapshot the current file path through a ref so the event handler closure
  // (set once on mount) always reads the latest value without re-subscribing.
  const curPathRef = useRef<string | null>(null)
  curPathRef.current = cur?.path ?? null

  const scope = useMemo(
    () => computeScope(state.workspace?.rootPath, cur?.path ?? null, !!cur),
    [state.workspace?.rootPath, cur]
  )

  // Stable string id of the current scope — used as the dependency for the
  // load effect so we don't refetch on every buffer change.
  const scopeId = useMemo<string | null>(() => {
    if (!scope) return null
    if (scope.kind === 'workspace') return `w:${scope.root}`
    if (scope.kind === 'single-file') return `f:${scope.path}`
    return 'u'
  }, [scope])

  const [provider, setProvider] = useState<DefaultProvider>(null)
  const [providerError, setProviderError] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [items, setItems] = useState<Item[]>([])
  const [busy, setBusy] = useState(false)
  const [runId, setRunId] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Resolve the default provider on mount + when panel re-opens.
  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      const defId = await ipc.providers.getDefault()
      if (!alive) return
      if (!defId) {
        setProvider(null)
        setProviderError('未设置默认 provider — 去 ⌘, 设置里配置')
        return
      }
      const list = await ipc.providers.list()
      const meta = list.find((p) => p.id === defId)
      if (!alive) return
      if (!meta) {
        setProvider(null)
        setProviderError(`默认 provider "${defId}" 未配置`)
        return
      }
      setProvider({ id: meta.id, model: meta.model })
      setProviderError(null)
    }
    void load()
    return () => {
      alive = false
    }
  }, [])

  // Load persisted conversation when the scope changes (or on first mount).
  // Untitled scope is in-memory only — clear items so an old chat doesn't
  // bleed into a fresh untitled file.
  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      if (!scope) {
        setItems([])
        return
      }
      if (scope.kind === 'untitled') {
        setItems([])
        return
      }
      const persisted = await ipc.context.load(scope)
      if (!alive) return
      if (!persisted || !Array.isArray(persisted.items)) {
        setItems([])
        return
      }
      // sanitize: any in-flight statuses left over from a crashed session
      // get normalized so the panel doesn't render pending approvals or
      // streaming plans that can never resolve.
      const cleaned = sanitizeItems(persisted.items as ConvItem[]) as unknown as Item[]
      setItems(cleaned)
    }
    void load()
    return () => {
      alive = false
    }
  }, [scopeId, scope])

  // Subscribe once to agent events; filter by current runId in handler.
  useEffect(() => {
    const off = ipc.agent.onEvent(({ runId: incoming, event }) => {
      // Only consume events for our active run; stale events from a previous
      // cancelled run are ignored.
      setRunId((current) => {
        if (current !== incoming) return current
        applyEvent(event)
        return current
      })
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const applyEvent = (event: AgentEvent): void => {
    setItems((prev) => {
      if (event.type === 'text-delta') {
        const last = prev[prev.length - 1]
        if (last && last.kind === 'assistant-text') {
          return [...prev.slice(0, -1), { kind: 'assistant-text', text: last.text + event.delta }]
        }
        return [...prev, { kind: 'assistant-text', text: event.delta }]
      }
      if (event.type === 'tool-call') {
        // Write tools are surfaced via the approval card instead — the tool-call
        // bubble would be redundant since the card already shows the args.
        if (WRITE_TOOL_NAMES.has(event.name)) return prev
        return [
          ...prev,
          {
            kind: 'tool-call',
            toolCallId: event.toolCallId,
            name: event.name,
            args: event.args
          }
        ]
      }
      if (event.type === 'tool-approval-request') {
        return [
          ...prev,
          {
            kind: 'approval',
            toolCallId: event.toolCallId,
            toolName: String(event.payload.kind ?? 'write'),
            payload: event.payload,
            status: 'pending'
          }
        ]
      }
      if (event.type === 'tool-result') {
        // For write tools, fold the result into the matching approval card —
        // success is implied by status='approved', so we only attach an error
        // (e.g. fs failure post-approval) or a final path. If no approval card
        // exists (pre-approval scope/exists error), surface as a plain result.
        if (WRITE_TOOL_NAMES.has(event.name)) {
          // If the agent wrote the file currently open in the editor, the
          // editor's in-memory buffer is now stale — re-read from disk so
          // the change is visible. Done outside the setItems reducer to keep
          // the reducer pure.
          const wr = event.result as { ok?: boolean; path?: string } | undefined
          if (wr?.ok === true && wr.path && wr.path === curPathRef.current) {
            void reloadCurrentFile(wr.path)
          }
          const idx = prev.findIndex(
            (it) => it.kind === 'approval' && it.toolCallId === event.toolCallId
          )
          if (idx === -1) {
            return [
              ...prev,
              {
                kind: 'tool-result',
                toolCallId: event.toolCallId,
                name: event.name,
                result: event.result
              }
            ]
          }
          const card = prev[idx] as Extract<Item, { kind: 'approval' }>
          const r = event.result as { ok?: boolean; error?: string; path?: string } | undefined
          const next: Item = {
            ...card,
            resultError: r && r.ok === false ? r.error ?? 'unknown error' : undefined,
            resultPath: r && r.ok === true ? r.path : undefined
          }
          return [...prev.slice(0, idx), next, ...prev.slice(idx + 1)]
        }
        return [
          ...prev,
          {
            kind: 'tool-result',
            toolCallId: event.toolCallId,
            name: event.name,
            result: event.result
          }
        ]
      }
      if (event.type === 'route-decision') {
        return [...prev, { kind: 'route', decision: event.decision }]
      }
      if (event.type === 'phase-start') {
        // Only show a divider when Build follows Plan — Plan's own phase-start
        // would be redundant with the plan card appearing.
        if (event.phase === 'build') {
          return [...prev, { kind: 'phase-divider', phase: 'build' }]
        }
        return prev
      }
      if (event.type === 'plan-delta') {
        const idx = prev.findIndex((it) => it.kind === 'plan' && it.status === 'streaming')
        const partialSteps = (event.partial.steps ?? []).filter(
          (s): s is PlanStep => !!s && typeof s.title === 'string' && s.title.length > 0
        )
        if (idx === -1) {
          return [...prev, { kind: 'plan', steps: partialSteps, status: 'streaming' }]
        }
        const next: Item = { kind: 'plan', steps: partialSteps, status: 'streaming' }
        return [...prev.slice(0, idx), next, ...prev.slice(idx + 1)]
      }
      if (event.type === 'plan-complete') {
        const idx = prev.findIndex((it) => it.kind === 'plan' && it.status === 'streaming')
        // New flow: the run pauses here. We move to 'awaiting' to surface
        // the per-step checkboxes + 执行/取消 buttons. enabled[] mirrors
        // steps[] length and starts all-true.
        const final: Item = {
          kind: 'plan',
          steps: event.plan.steps,
          status: 'awaiting',
          enabled: event.plan.steps.map(() => true)
        }
        if (idx === -1) return [...prev, final]
        return [...prev.slice(0, idx), final, ...prev.slice(idx + 1)]
      }
      if (event.type === 'plan-approval-request') {
        // Audit-only signal — plan-complete already flipped to 'awaiting'
        // with the same data. Kept distinct in the backend for log clarity.
        return prev
      }
      if (event.type === 'plan-usage') {
        return [...prev, { kind: 'plan-usage', usage: event.usage }]
      }
      if (event.type === 'error') {
        return [...prev, { kind: 'error', message: event.message }]
      }
      if (event.type === 'finish') {
        return [...prev, { kind: 'finish', usage: event.usage }]
      }
      return prev
    })
    if (event.type === 'finish' || event.type === 'error') {
      setBusy(false)
      setRunId(null)
    }
  }

  // Auto-scroll on new items
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [items])

  // Debounced persistence: 400ms after the last items[] mutation, flush to
  // disk. Cheap because items[] only changes on agent events / user clicks
  // (not on input typing), so we're not thrashing the FS. Untitled scope is
  // memory-only.
  useEffect(() => {
    if (!scope || scope.kind === 'untitled') return
    if (items.length === 0) return // empty items = either fresh start or post-clear; nothing to write
    const t = window.setTimeout(() => {
      void ipc.context.save({ scope, items: items as unknown as unknown[] })
    }, 400)
    return () => window.clearTimeout(t)
  }, [items, scope])

  const canRun = !!scope && !!provider && !busy && input.trim().length > 0
  const canCancel = busy && runId !== null

  // Cumulative token usage for this conversation. Derived from items[] so it
  // survives restart for free and resets on 清空 (which empties items). We
  // sum every 'finish' and 'plan-usage' payload through coerceUsage; the
  // helper returns undefined when a payload has no recognizable shape, which
  // sumUsage silently skips.
  const totalUsage = useMemo(() => {
    const usages = items.flatMap((it) => {
      if (it.kind === 'finish') return [coerceUsage(it.usage)]
      if (it.kind === 'plan-usage') return [coerceUsage(it.usage)]
      return []
    })
    return sumUsage(usages)
  }, [items])

  const handleSend = useCallback(async () => {
    if (!canRun || !provider || !scope) return
    const raw = input.trim()
    const parsed = parseSlashCommand(raw)
    if (!parsed.prompt) return // bare `/plan` with no text — ignore
    setInput('')
    setItems((prev) => [
      ...prev,
      {
        kind: 'user',
        text: parsed.prompt,
        forcedMode: parsed.mode === 'auto' ? undefined : (parsed.mode as 'plan' | 'build')
      }
    ])
    const newRunId = genRunId()
    setRunId(newRunId)
    setBusy(true)
    // Prior conversation as model context. v1 keeps only text turns —
    // tool calls and approvals stay visible in the panel but don't feed
    // back into the LLM, since reconstructing them as ToolCallPart /
    // ToolResultPart messages is gnarly across providers.
    const history = itemsToMessages(items as unknown as ConvItem[])
    try {
      await ipc.agent.run({
        runId: newRunId,
        providerId: provider.id,
        modelId: provider.model,
        prompt: parsed.prompt,
        scope,
        mode: parsed.mode,
        history,
        currentBuffer: cur?.buffer,
        currentSelection: undefined
      })
    } catch (e) {
      setItems((prev) => [
        ...prev,
        { kind: 'error', message: e instanceof Error ? e.message : String(e) }
      ])
      setBusy(false)
      setRunId(null)
    }
  }, [canRun, provider, scope, input, cur])

  const handleCancel = useCallback(async () => {
    if (!runId) return
    await ipc.agent.cancel(runId)
    // The cancel itself produces an 'error' event with message 'cancelled'
    // which clears busy/runId. We don't clear here to avoid race.
  }, [runId])

  // Per-step checkbox toggle on an awaiting plan. Plain UI mutation; nothing
  // crosses IPC until the user clicks 执行.
  const handlePlanStepToggle = useCallback(
    (stepIndex: number): void => {
      setItems((prev) =>
        prev.map((it) => {
          if (it.kind !== 'plan' || it.status !== 'awaiting') return it
          const next = it.enabled ? [...it.enabled] : it.steps.map(() => true)
          next[stepIndex] = !(next[stepIndex] ?? true)
          return { ...it, enabled: next }
        })
      )
    },
    []
  )

  const handlePlanExecute = useCallback(async (): Promise<void> => {
    if (!runId) return
    // Snapshot the awaiting plan + its current enabled[] selection, build
    // the edited plan, and tell main to resume into Build with it.
    let edited: { steps: PlanStep[] } | null = null
    setItems((prev) => {
      const idx = prev.findIndex((it) => it.kind === 'plan' && it.status === 'awaiting')
      if (idx === -1) return prev
      const card = prev[idx] as Extract<Item, { kind: 'plan' }>
      const enabled = card.enabled ?? card.steps.map(() => true)
      const filtered = card.steps.filter((_, i) => enabled[i])
      // Need at least one step — if user unchecked all, treat as dismiss.
      if (filtered.length === 0) {
        return prev.map((it, i) =>
          i === idx ? ({ ...card, status: 'dismissed' as const } as Item) : it
        )
      }
      edited = { steps: filtered }
      return prev.map((it, i) =>
        i === idx ? ({ ...card, status: 'complete' as const } as Item) : it
      )
    })
    if (!edited) {
      await ipc.agent.respondPlanApproval({ runId, response: { approved: false } })
      return
    }
    await ipc.agent.respondPlanApproval({
      runId,
      response: { approved: true, plan: edited }
    })
  }, [runId])

  const handlePlanDismiss = useCallback(async (): Promise<void> => {
    if (!runId) return
    setItems((prev) =>
      prev.map((it) =>
        it.kind === 'plan' && it.status === 'awaiting'
          ? ({ ...it, status: 'dismissed' as const } as Item)
          : it
      )
    )
    await ipc.agent.respondPlanApproval({ runId, response: { approved: false } })
  }, [runId])

  const handleApproval = useCallback(
    async (toolCallId: string, approved: boolean): Promise<void> => {
      if (!runId) return
      // Optimistic UI: flip the card immediately so the user isn't waiting on
      // the IPC roundtrip + tool execute to confirm their click registered.
      setItems((prev) =>
        prev.map((it) =>
          it.kind === 'approval' && it.toolCallId === toolCallId && it.status === 'pending'
            ? { ...it, status: approved ? 'approved' : 'rejected' }
            : it
        )
      )
      await ipc.agent.respondApproval({
        runId,
        toolCallId,
        response: approved ? { approved: true } : { approved: false, reason: 'user rejected' }
      })
    },
    [runId]
  )

  // Cancel the active run if the panel unmounts (user closes it mid-run) so
  // the main process doesn't leak agent loops awaiting approval forever.
  const runIdRef = useRef<string | null>(null)
  useEffect(() => {
    runIdRef.current = runId
  }, [runId])
  useEffect(() => {
    return () => {
      const id = runIdRef.current
      if (id) void ipc.agent.cancel(id)
    }
  }, [])

  const handleClear = (): void => {
    setItems([])
    // 「清空」语义是双清：UI 起空白，磁盘文件也删掉。重启 Quill 不会重现旧对话。
    if (scope && scope.kind !== 'untitled') {
      void ipc.context.clear(scope)
    }
  }

  return (
    <aside className="w-[360px] shrink-0 border-l border-[var(--rule)] bg-[var(--paper-dim)] flex flex-col">
      <header className="h-11 px-4 flex items-center gap-2 border-b border-[var(--rule)] shrink-0 bg-[var(--paper)]">
        <span className="font-display italic text-[14px] text-[var(--ink)]">
          Agent
        </span>
        <div className="flex-1" />
        {items.length > 0 && (
          <button
            onClick={handleClear}
            disabled={busy}
            className="no-drag px-2 py-1 rounded-md text-[11px] text-[var(--ink-faint)] hover:text-[var(--ink)] hover:bg-[var(--paper-soft)] transition disabled:opacity-40"
            title="清空对话"
          >
            清空
          </button>
        )}
        <button
          onClick={onClose}
          className="no-drag p-1.5 rounded-md text-[var(--ink-faint)] hover:text-[var(--ink)] hover:bg-[var(--paper-soft)] transition"
          title="关闭 (⌘J)"
        >
          <X className="w-4 h-4" />
        </button>
      </header>

      {/* status strip: scope + provider + cumulative tokens */}
      <div className="px-4 py-2 border-b border-[var(--rule-soft)] flex items-center gap-3 text-[11px]">
        <span className="font-mono text-[var(--ink-faint)] truncate" title={scope ? JSON.stringify(scope) : ''}>
          {scopeLabel(scope)}
        </span>
        <span className="text-[var(--ink-ghost)]">·</span>
        {providerError ? (
          <span className="text-[var(--accent)] font-serif-zh italic">
            {providerError}
          </span>
        ) : provider ? (
          <span className="font-mono text-[var(--ink-faint)] truncate">
            {provider.id}/{provider.model}
          </span>
        ) : (
          <span className="text-[var(--ink-faint)] font-serif-zh italic">加载中…</span>
        )}
        {totalUsage.total > 0 && (
          <>
            <span className="text-[var(--ink-ghost)] ml-auto">·</span>
            <span
              className="font-mono text-[var(--ink-faint)] shrink-0 tabular-nums"
              title={`本次对话累计：输入 ${formatTokens(totalUsage.input)} / 输出 ${formatTokens(totalUsage.output)} / 共 ${formatTokens(totalUsage.total)} tokens`}
            >
              ↑{formatTokens(totalUsage.input)} ↓{formatTokens(totalUsage.output)}
            </span>
          </>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-auto px-4 py-3 space-y-3">
        {items.length === 0 && (
          <div className="font-serif-zh italic text-[12px] text-[var(--ink-faint)] text-center pt-8">
            {scope
              ? '问点什么 —— 比如「读 README.md 然后总结」'
              : '没有打开任何文件或文件夹'}
          </div>
        )}
        {items.map((item, i) => (
          <ItemView
            key={i}
            item={item}
            onApproval={handleApproval}
            onPlanStepToggle={handlePlanStepToggle}
            onPlanExecute={handlePlanExecute}
            onPlanDismiss={handlePlanDismiss}
          />
        ))}
        {busy && (
          <div className="flex items-center gap-2 text-[12px] text-[var(--ink-faint)]">
            <Loader2 className="w-3 h-3 animate-spin" />
            <span className="font-serif-zh italic">agent 思考中…</span>
          </div>
        )}
      </div>

      <footer className="border-t border-[var(--rule)] p-3 bg-[var(--paper)]">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void handleSend()
              }
            }}
            placeholder={
              scope ? '问 agent 一件事… (⌘↵ 发送)' : '请先打开一个文件或文件夹'
            }
            disabled={!scope || !provider || busy}
            rows={3}
            className="flex-1 resize-none px-3 py-2 rounded-md bg-[var(--paper-soft)] text-[13px] text-[var(--ink)] border border-transparent focus:border-[var(--accent)]/50 focus:bg-[var(--paper)] focus:outline-none disabled:opacity-50 placeholder:text-[var(--ink-faint)] placeholder:italic"
          />
          {canCancel ? (
            <button
              onClick={handleCancel}
              className="no-drag p-2 rounded-md bg-[var(--paper-soft)] text-[var(--accent)] hover:bg-[var(--paper)] transition active:scale-[0.96]"
              title="取消"
            >
              <StopCircle className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!canRun}
              className="no-drag p-2 rounded-md bg-[var(--accent)] text-[var(--paper)] disabled:opacity-40 disabled:cursor-not-allowed transition active:scale-[0.96]"
              title="发送 (⌘↵)"
            >
              <Send className="w-4 h-4" />
            </button>
          )}
        </div>
      </footer>
    </aside>
  )
}

function ItemView({
  item,
  onApproval,
  onPlanStepToggle,
  onPlanExecute,
  onPlanDismiss
}: {
  item: Item
  onApproval: (toolCallId: string, approved: boolean) => Promise<void>
  onPlanStepToggle: (stepIndex: number) => void
  onPlanExecute: () => Promise<void>
  onPlanDismiss: () => Promise<void>
}) {
  if (item.kind === 'user') {
    return (
      <div className="ml-6 px-3 py-2 rounded-md bg-[var(--paper-soft)] text-[13px] text-[var(--ink)] whitespace-pre-wrap">
        {item.forcedMode && (
          <span className="inline-block mr-1.5 px-1.5 py-0.5 rounded text-[10px] font-mono text-[var(--accent)] bg-[var(--accent-soft)] align-baseline">
            /{item.forcedMode}
          </span>
        )}
        {item.text}
      </div>
    )
  }
  if (item.kind === 'route') {
    return <RouteBadgeView decision={item.decision} />
  }
  if (item.kind === 'plan') {
    return (
      <PlanCardView
        steps={item.steps}
        status={item.status}
        enabled={item.enabled}
        onStepToggle={onPlanStepToggle}
        onExecute={onPlanExecute}
        onDismiss={onPlanDismiss}
      />
    )
  }
  if (item.kind === 'phase-divider') {
    return <PhaseDividerView phase={item.phase} />
  }
  if (item.kind === 'truncated') {
    return (
      <div className="text-[11px] text-[var(--ink-faint)] font-serif-zh italic text-center py-1">
        — 之前 {item.count} 条已截断 —
      </div>
    )
  }
  if (item.kind === 'assistant-text') {
    return <AssistantText text={item.text} />
  }
  if (item.kind === 'tool-call') {
    return <ToolCallView name={item.name} args={item.args} />
  }
  if (item.kind === 'tool-result') {
    return <ToolResultView name={item.name} result={item.result} />
  }
  if (item.kind === 'approval') {
    return <ApprovalCardView item={item} onApproval={onApproval} />
  }
  if (item.kind === 'error') {
    return (
      <div className="text-[12px] text-[var(--accent)] font-serif-zh italic">
        ⚠ {item.message}
      </div>
    )
  }
  if (item.kind === 'finish') {
    return (
      <div className="text-[11px] text-[var(--ink-faint)] font-serif-zh italic text-right">
        done
      </div>
    )
  }
  return null
}

function AssistantText({ text }: { text: string }) {
  const html = useMemo(() => renderMd(text), [text])
  return <div className="prose-agent" dangerouslySetInnerHTML={{ __html: html }} />
}

function RouteBadgeView({ decision }: { decision: RouteDecision }) {
  const label = decision.agent === 'plan' ? 'via Plan → Build' : 'via Build'
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-[var(--ink-faint)] font-serif-zh italic">
      <RouteIcon className="w-3 h-3" />
      <span>{label}</span>
      <span className="text-[var(--ink-ghost)]">·</span>
      <span className="text-[var(--ink-soft)] not-italic font-sans truncate" title={decision.reason}>
        {decision.reason}
      </span>
    </div>
  )
}

function PhaseDividerView({ phase }: { phase: 'plan' | 'build' }) {
  return (
    <div className="flex items-center gap-2 text-[11px] text-[var(--ink-faint)] py-1">
      <div className="flex-1 border-t border-[var(--rule-soft)]" />
      <span className="flex items-center gap-1 font-serif-zh italic">
        <PlayCircle className="w-3 h-3 text-[var(--accent)]" />
        {phase === 'build' ? '开始执行' : '开始规划'}
      </span>
      <div className="flex-1 border-t border-[var(--rule-soft)]" />
    </div>
  )
}

function PlanCardView({
  steps,
  status,
  enabled,
  onStepToggle,
  onExecute,
  onDismiss
}: {
  steps: PlanStep[]
  status: 'streaming' | 'awaiting' | 'complete' | 'dismissed'
  enabled?: boolean[]
  onStepToggle: (stepIndex: number) => void
  onExecute: () => Promise<void>
  onDismiss: () => Promise<void>
}) {
  const editable = status === 'awaiting'
  const dimmed = status === 'dismissed'
  const enabledCount = editable
    ? (enabled ?? steps.map(() => true)).filter(Boolean).length
    : steps.length

  return (
    <div
      className={`rounded-md border ${editable ? 'border-[var(--accent)]/50' : 'border-[var(--rule)]'} bg-[var(--paper)] overflow-hidden ${dimmed ? 'opacity-60' : ''}`}
    >
      <div className="px-3 py-2 flex items-center gap-2 text-[12px] bg-[var(--paper-soft)] border-b border-[var(--rule-soft)]">
        <ListChecks className="w-3.5 h-3.5 text-[var(--accent)]" />
        <span className="font-serif-zh italic text-[var(--ink-soft)]">计划</span>
        {status === 'streaming' && (
          <Loader2 className="w-3 h-3 animate-spin text-[var(--ink-faint)]" />
        )}
        {status === 'awaiting' && (
          <span className="text-[11px] text-[var(--accent)] font-serif-zh italic">
            等待确认
          </span>
        )}
        {status === 'dismissed' && (
          <span className="text-[11px] text-[var(--ink-faint)] font-serif-zh italic">
            已取消
          </span>
        )}
        <span className="ml-auto font-mono text-[11px] text-[var(--ink-faint)]">
          {editable && enabledCount !== steps.length
            ? `${enabledCount}/${steps.length} 步`
            : `${steps.length} 步`}
        </span>
      </div>
      <ol className="px-3 py-2 space-y-1.5">
        {steps.map((step, i) => (
          <PlanStepItem
            key={step.id ?? `s-${i}`}
            index={i + 1}
            step={step}
            editable={editable}
            enabled={enabled?.[i] ?? true}
            onToggle={() => onStepToggle(i)}
          />
        ))}
        {steps.length === 0 && (
          <li className="text-[12px] text-[var(--ink-faint)] font-serif-zh italic py-1">
            正在生成…
          </li>
        )}
      </ol>
      {status === 'awaiting' && (
        <div className="flex border-t border-[var(--rule-soft)]">
          <button
            onClick={() => void onDismiss()}
            className="no-drag flex-1 px-3 py-2 text-[12px] text-[var(--ink-soft)] hover:bg-[var(--paper-soft)] transition border-r border-[var(--rule-soft)]"
          >
            取消
          </button>
          <button
            onClick={() => void onExecute()}
            disabled={enabledCount === 0}
            className="no-drag flex-1 px-3 py-2 text-[12px] font-medium text-[var(--paper)] bg-[var(--accent)] hover:opacity-90 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            执行 {enabledCount > 0 && enabledCount !== steps.length ? `(${enabledCount})` : ''}
          </button>
        </div>
      )}
    </div>
  )
}

function PlanStepItem({
  index,
  step,
  editable,
  enabled,
  onToggle
}: {
  index: number
  step: PlanStep
  editable: boolean
  enabled: boolean
  onToggle: () => void
}) {
  const [open, setOpen] = useState(false)
  const hasDetail = !!step.why || (step.files && step.files.length > 0)
  const muted = editable && !enabled
  return (
    <li className="text-[12px] leading-[1.5]">
      <div className={`flex items-start gap-2 ${muted ? 'opacity-50' : ''}`}>
        {editable && (
          <input
            type="checkbox"
            checked={enabled}
            onChange={onToggle}
            className="no-drag mt-[3px] shrink-0 accent-[var(--accent)] cursor-pointer"
            title={enabled ? '取消勾选以跳过此步' : '勾选以包含此步'}
          />
        )}
        <button
          onClick={() => hasDetail && setOpen((v) => !v)}
          className={`no-drag flex-1 flex items-start gap-2 text-left ${
            hasDetail ? 'cursor-pointer hover:text-[var(--ink)]' : 'cursor-default'
          }`}
        >
          <span className="font-mono text-[var(--ink-faint)] shrink-0 mt-[1px]">
            {String(index).padStart(2, '0')}.
          </span>
          <span className={`text-[var(--ink)] flex-1 ${muted ? 'line-through' : ''}`}>
            {step.title}
          </span>
          {hasDetail &&
            (open ? (
              <ChevronDown className="w-3 h-3 mt-1 text-[var(--ink-faint)]" />
            ) : (
              <ChevronRight className="w-3 h-3 mt-1 text-[var(--ink-faint)]" />
            ))}
        </button>
      </div>
      {open && hasDetail && (
        <div className="ml-7 mt-1 text-[11px] text-[var(--ink-soft)] space-y-0.5">
          {step.why && <div className="font-serif-zh italic">why: {step.why}</div>}
          {step.files && step.files.length > 0 && (
            <div className="font-mono text-[var(--ink-faint)] truncate" title={step.files.join(', ')}>
              files: {step.files.join(', ')}
            </div>
          )}
        </div>
      )}
    </li>
  )
}

function shortPath(p: string): string {
  const parts = p.split('/')
  if (parts.length <= 3) return p
  return '…/' + parts.slice(-2).join('/')
}

function ApprovalCardView({
  item,
  onApproval
}: {
  item: Extract<Item, { kind: 'approval' }>
  onApproval: (toolCallId: string, approved: boolean) => Promise<void>
}) {
  const { payload, status, toolName, resultError, resultPath } = item
  const path = String(payload.path ?? '')
  const [contentOpen, setContentOpen] = useState(status === 'pending')

  const icon =
    toolName === 'create_file' ? (
      <FilePlus className="w-3.5 h-3.5" />
    ) : toolName === 'apply_edit' ? (
      <FilePen className="w-3.5 h-3.5" />
    ) : (
      <FileText className="w-3.5 h-3.5" />
    )

  const title =
    toolName === 'create_file'
      ? '新建文件'
      : toolName === 'apply_edit'
        ? '编辑文件'
        : toolName === 'write_file'
          ? '覆写文件'
          : '写入'

  const borderColor =
    status === 'pending'
      ? 'border-[var(--accent)]/60'
      : status === 'approved'
        ? 'border-[var(--rule)]'
        : 'border-[var(--accent)]/30'

  return (
    <div className={`rounded-md border ${borderColor} bg-[var(--paper)] overflow-hidden`}>
      <div className="px-3 py-2 flex items-center gap-2 text-[12px] bg-[var(--paper-soft)] border-b border-[var(--rule-soft)]">
        <span className="text-[var(--accent)]">{icon}</span>
        <span className="font-serif-zh italic text-[var(--ink-soft)]">{title}</span>
        <span
          className="font-mono text-[11px] text-[var(--ink-faint)] truncate flex-1"
          title={path}
        >
          {shortPath(path)}
        </span>
        {status === 'approved' && !resultError && (
          <span className="text-[11px] text-[var(--ink-soft)] flex items-center gap-1">
            <Check className="w-3 h-3" /> 已应用
          </span>
        )}
        {status === 'approved' && resultError && (
          <span className="text-[11px] text-[var(--accent)]">写入失败</span>
        )}
        {status === 'rejected' && (
          <span className="text-[11px] text-[var(--ink-faint)] font-serif-zh italic">
            已拒绝
          </span>
        )}
      </div>

      {toolName === 'apply_edit' ? (
        <ApplyEditPreview
          oldText={String(payload.old_text ?? '')}
          newText={String(payload.new_text ?? '')}
          open={contentOpen}
          onToggle={() => setContentOpen((v) => !v)}
        />
      ) : (
        <WriteContentPreview
          content={String(payload.content ?? '')}
          open={contentOpen}
          onToggle={() => setContentOpen((v) => !v)}
        />
      )}

      {resultError && (
        <div className="px-3 py-2 text-[11px] text-[var(--accent)] border-t border-[var(--rule-soft)] font-mono">
          {resultError}
        </div>
      )}
      {resultPath && status === 'approved' && !resultError && (
        <div
          className="px-3 py-1.5 text-[11px] text-[var(--ink-faint)] border-t border-[var(--rule-soft)] font-mono truncate"
          title={resultPath}
        >
          {resultPath}
        </div>
      )}

      {status === 'pending' && (
        <div className="flex border-t border-[var(--rule-soft)]">
          <button
            onClick={() => void onApproval(item.toolCallId, false)}
            className="no-drag flex-1 px-3 py-2 text-[12px] text-[var(--ink-soft)] hover:bg-[var(--paper-soft)] transition border-r border-[var(--rule-soft)]"
          >
            拒绝
          </button>
          <button
            onClick={() => void onApproval(item.toolCallId, true)}
            className="no-drag flex-1 px-3 py-2 text-[12px] font-medium text-[var(--paper)] bg-[var(--accent)] hover:opacity-90 transition"
          >
            批准
          </button>
        </div>
      )}
    </div>
  )
}

function WriteContentPreview({
  content,
  open,
  onToggle
}: {
  content: string
  open: boolean
  onToggle: () => void
}) {
  const lineCount = content.split('\n').length
  const charCount = content.length
  return (
    <div>
      <button
        onClick={onToggle}
        className="no-drag w-full px-3 py-1.5 flex items-center gap-1 text-[11px] text-[var(--ink-soft)] hover:bg-[var(--paper-soft)] transition"
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <span className="font-mono">
          {lineCount} 行 · {charCount} 字符
        </span>
      </button>
      {open && (
        <pre className="px-3 pb-2 font-mono text-[11px] text-[var(--ink)] whitespace-pre-wrap break-all max-h-[240px] overflow-y-auto">
          {content}
        </pre>
      )}
    </div>
  )
}

function ApplyEditPreview({
  oldText,
  newText,
  open,
  onToggle
}: {
  oldText: string
  newText: string
  open: boolean
  onToggle: () => void
}) {
  return (
    <div>
      <button
        onClick={onToggle}
        className="no-drag w-full px-3 py-1.5 flex items-center gap-1 text-[11px] text-[var(--ink-soft)] hover:bg-[var(--paper-soft)] transition"
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <span className="font-mono">
          -{oldText.split('\n').length} / +{newText.split('\n').length} 行
        </span>
      </button>
      {open && (
        <div className="px-3 pb-2 space-y-1">
          <pre className="font-mono text-[11px] whitespace-pre-wrap break-all max-h-[120px] overflow-y-auto bg-[color-mix(in_oklch,var(--accent)_10%,transparent)] text-[var(--ink)] px-2 py-1 rounded border-l-2 border-[var(--accent)]/50">
            <span className="text-[var(--accent)] mr-1">−</span>
            {oldText}
          </pre>
          <pre className="font-mono text-[11px] whitespace-pre-wrap break-all max-h-[120px] overflow-y-auto bg-[color-mix(in_oklch,var(--accent-soft)_60%,transparent)] text-[var(--ink)] px-2 py-1 rounded border-l-2 border-[var(--accent-soft)]">
            <span className="text-[var(--ink-soft)] mr-1">+</span>
            {newText}
          </pre>
        </div>
      )}
    </div>
  )
}

function ToolCallView({ name, args }: { name: string; args: unknown }) {
  return (
    <div className="text-[12px] border-l-2 border-[var(--rule)] pl-2">
      <div className="flex items-center gap-1 text-[var(--ink-soft)]">
        <Wrench className="w-3 h-3" />
        <span className="font-mono">{name}</span>
      </div>
      <pre className="font-mono text-[11px] text-[var(--ink-faint)] mt-0.5 overflow-x-auto whitespace-pre-wrap break-all">
        {JSON.stringify(args, null, 2)}
      </pre>
    </div>
  )
}

function ToolResultView({ name, result }: { name: string; result: unknown }) {
  const [open, setOpen] = useState(false)
  const preview =
    typeof result === 'string'
      ? result.slice(0, 120)
      : JSON.stringify(result).slice(0, 120)
  const full = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
  return (
    <div className="text-[12px] border-l-2 border-[var(--accent)]/40 pl-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="no-drag flex items-center gap-1 text-[var(--ink-soft)] hover:text-[var(--ink)] transition"
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <span className="font-mono">{name}</span>
        <span className="font-serif-zh italic text-[var(--ink-faint)] ml-1">→</span>
        {!open && (
          <span className="font-mono text-[11px] text-[var(--ink-faint)] truncate ml-1 max-w-[200px]">
            {preview}
            {full.length > 120 ? '…' : ''}
          </span>
        )}
      </button>
      {open && (
        <pre className="font-mono text-[11px] text-[var(--ink-faint)] mt-1 overflow-x-auto whitespace-pre-wrap break-all max-h-[200px] overflow-y-auto">
          {full}
        </pre>
      )}
    </div>
  )
}
