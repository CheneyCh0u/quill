import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Send,
  X,
  StopCircle,
  Loader2,
  ChevronDown,
  ChevronRight,
  FilePlus,
  FilePen,
  FileText,
  Check,
  ListChecks,
  Route as RouteIcon,
  PlayCircle,
  Download,
  Plus,
  Trash2
} from 'lucide-react'
import { useApp } from '../state/app'
import { ipc } from '../lib/ipc'
import { render as renderMd } from '../lib/markdown'
import { itemsToMessages, type ConvItem } from '../lib/itemsToMessages'
import { sanitizeItems } from '../lib/sanitizeItems'
import { groupToolItems, summarizeGroup, type ToolGroupEntry } from '../lib/toolGroups'
import { deriveSessionTitle } from '../lib/sessionTitle'
import { coerceUsage, sumUsage, formatTokens } from '../lib/usage'
import { exportConversation } from '../lib/exportConversation'
import { clampPanelWidth, PANEL_WIDTH_DEFAULT } from '../lib/panelWidth'
import {
  buildAvailableModels,
  parseModelChoice,
  serializeModelChoice,
  type AvailableModel,
  type ModelChoice
} from '../lib/availableModels'
import { shouldCompress, splitForCompression } from '../lib/compressionTrigger'
import { getProviderModel } from '../lib/providers'
import { createWatchdog, type Watchdog } from '../lib/watchdog'
import type { SessionIndex, SessionMeta } from '../types'

// Renderer-side dead-man switch: if main goes silent for this long while a
// run is still believed to be active, the UI recovers itself. main-side
// guards (terminal-event-guard, IPC try/catch) handle every normal exit;
// the watchdog is for things they can't reach — main process crash, IPC
// delivery failure, listener race that drops the terminal event. See #89.
const AGENT_WATCHDOG_MS = 5 * 60 * 1000
import { Select } from './Select'
import type {
  AgentEvent,
  AgentMode,
  ApprovalPayload,
  PlanStep,
  RouteDecision,
  Scope
} from '../types'

const COMPRESSION_THRESHOLD = 0.9
const KEEP_RECENT_TURNS = 6

const PANEL_WIDTH_STORAGE_KEY = 'quill.agent.width'
const PLAN_CHOICE_STORAGE_KEY = 'quill.agent.planModel'
const BUILD_CHOICE_STORAGE_KEY = 'quill.agent.buildModel'

function readStoredWidth(): number {
  try {
    const raw = window.localStorage.getItem(PANEL_WIDTH_STORAGE_KEY)
    if (!raw) return PANEL_WIDTH_DEFAULT
    return clampPanelWidth(parseInt(raw, 10))
  } catch {
    return PANEL_WIDTH_DEFAULT
  }
}

function readStoredChoice(key: string): ModelChoice | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    return parseModelChoice(raw)
  } catch {
    return null
  }
}

function writeStoredChoice(key: string, choice: ModelChoice | null): void {
  try {
    if (choice) window.localStorage.setItem(key, serializeModelChoice(choice))
    else window.localStorage.removeItem(key)
  } catch {
    /* best-effort */
  }
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return (tokens / 1_000_000).toFixed(1) + 'M'
  return Math.round(tokens / 1000) + 'K'
}

const WRITE_TOOL_NAMES = new Set([
  'write_file',
  'apply_edit',
  'create_file',
  'delete_file',
  'delete_dir'
])
const DELETE_TOOL_NAMES = new Set(['delete_file', 'delete_dir'])

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
  | {
      kind: 'compressed-summary'
      summary: string
      originalCount: number
      atTokens?: number
    }
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
  const { state, reloadCurrentFile, reloadWorkspaceTree } = useApp()
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
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([])
  // Persisted per-phase choices. null means "use the default provider".
  const [planChoice, setPlanChoice] = useState<ModelChoice | null>(() =>
    readStoredChoice(PLAN_CHOICE_STORAGE_KEY)
  )
  const [buildChoice, setBuildChoice] = useState<ModelChoice | null>(() =>
    readStoredChoice(BUILD_CHOICE_STORAGE_KEY)
  )
  const [pickerOpen, setPickerOpen] = useState(false)
  const [input, setInput] = useState('')
  const [items, setItems] = useState<Item[]>([])
  // Session index for the current scope. The store guarantees ≥1 entry;
  // null only while the initial fetch is in flight.
  const [sessionIndex, setSessionIndex] = useState<SessionIndex | null>(null)
  const [busy, setBusy] = useState(false)
  const [runId, setRunId] = useState<string | null>(null)
  // Compression is a side-band run that triggers automatically after a
  // normal finish event when last usage crosses the threshold. We
  // surface its status to the UI ("压缩中…") via a flag rather than
  // mixing it into the main `busy` so the user can keep typing.
  const [compressing, setCompressing] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Resolve the default provider + full configured list on mount.
  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      const [defId, list] = await Promise.all([
        ipc.providers.getDefault(),
        ipc.providers.list()
      ])
      if (!alive) return
      setAvailableModels(buildAvailableModels(list))
      if (!defId) {
        setProvider(null)
        setProviderError('未设置默认 provider — 去 ⌘, 设置里配置')
        return
      }
      const meta = list.find((p) => p.id === defId)
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

  // Persist Plan/Build choices whenever they change. Stored values dropped
  // by validation (below) also propagate via this effect.
  useEffect(() => {
    writeStoredChoice(PLAN_CHOICE_STORAGE_KEY, planChoice)
  }, [planChoice])
  useEffect(() => {
    writeStoredChoice(BUILD_CHOICE_STORAGE_KEY, buildChoice)
  }, [buildChoice])

  // After availableModels loads, drop any stored choice that no longer
  // matches a real (provider, model) pair — the provider may have been
  // deleted in Settings, or its catalog reshuffled.
  useEffect(() => {
    if (availableModels.length === 0) return
    const has = (c: ModelChoice | null): boolean =>
      !c ||
      availableModels.some(
        (m) => m.providerId === c.providerId && m.modelId === c.modelId
      )
    if (!has(planChoice)) setPlanChoice(null)
    if (!has(buildChoice)) setBuildChoice(null)
  }, [availableModels, planChoice, buildChoice])

  // Effective model used by each phase. Falls back to the default provider's
  // (id, model) when no override was picked.
  const defaultChoice: ModelChoice | null = provider
    ? { providerId: provider.id, modelId: provider.model }
    : null
  const effectivePlan: ModelChoice | null = planChoice ?? defaultChoice
  const effectiveBuild: ModelChoice | null = buildChoice ?? defaultChoice

  // Load the scope's session index + active session when the scope
  // changes (or on first mount). Untitled scope gets an ephemeral session
  // (store no-ops on writes) so the flow is uniform.
  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      if (!scope) {
        setSessionIndex(null)
        setItems([])
        return
      }
      const index = await ipc.context.sessions(scope)
      if (!alive) return
      setSessionIndex(index)
      const persisted = await ipc.context.loadSession({
        scope,
        sessionId: index.activeId
      })
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
        // Any sign of life resets the watchdog.
        watchdogRef.current?.touch()
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
          if (wr?.ok === true && wr.path) {
            // A deleted path no longer exists on disk — reloading it would
            // error. The sidebar refresh below is what removes the entry.
            if (wr.path === curPathRef.current && !DELETE_TOOL_NAMES.has(event.name)) {
              void reloadCurrentFile(wr.path)
            }
            // Also refresh the workspace tree so a `create_file` shows up in
            // the sidebar immediately. No-op outside workspace mode.
            void reloadWorkspaceTree()
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
      if (event.type === 'compression-start') {
        // Indicator is driven by the `compressing` flag set outside the
        // reducer; nothing to add to items[].
        return prev
      }
      if (event.type === 'compression-complete') {
        // Splice prefix → single summary item, keep tail (which includes
        // any items the user added while compression was in flight).
        const pending = pendingCompressionRef.current
        pendingCompressionRef.current = null
        if (!pending || prev.length < pending.originalCount) return prev
        const summary: Item = {
          kind: 'compressed-summary',
          summary: event.summary,
          originalCount: pending.originalCount,
          atTokens: pending.atTokens
        }
        return [summary, ...prev.slice(pending.originalCount)]
      }
      if (event.type === 'compression-error') {
        pendingCompressionRef.current = null
        return [...prev, { kind: 'error', message: '压缩失败: ' + event.message }]
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
      watchdogRef.current?.stop()
    }
    if (event.type === 'compression-start') setCompressing(true)
    if (event.type === 'compression-complete' || event.type === 'compression-error') {
      setCompressing(false)
    }
  }

  // Auto-scroll on new items
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [items])

  // Debounced persistence: 400ms after the last items[] mutation, flush
  // the ACTIVE SESSION to disk. Cheap because items[] only changes on
  // agent events / user clicks (not on input typing). Untitled scope is
  // memory-only (the store drops the write).
  useEffect(() => {
    if (!scope || scope.kind === 'untitled' || !sessionIndex) return
    if (items.length === 0) return // fresh session; nothing to write
    const sessionId = sessionIndex.activeId
    const title = deriveSessionTitle(items as Array<{ kind: string; text?: string }>)
    const turnCount = items.filter((i) => i.kind === 'user').length
    const t = window.setTimeout(() => {
      void ipc.context.saveSession({
        scope,
        sessionId,
        items: items as unknown as unknown[],
        title,
        turnCount
      })
      // Mirror the meta into local state so the dropdown shows fresh
      // titles without a refetch.
      setSessionIndex((prev) =>
        prev
          ? {
              ...prev,
              sessions: prev.sessions.map((m) =>
                m.id === sessionId ? { ...m, title, turnCount, updatedAt: Date.now() } : m
              )
            }
          : prev
      )
    }, 400)
    return () => window.clearTimeout(t)
  }, [items, scope, sessionIndex?.activeId])

  // Compression trigger: after every items[] update, if the most recent
  // finish event with usage crosses the threshold against the Build model's
  // context window, fire a compression run. The pendingCompressionRef
  // remembers how many items were submitted so the splice on
  // compression-complete only replaces the right prefix.
  const pendingCompressionRef = useRef<{ originalCount: number; atTokens?: number } | null>(
    null
  )
  useEffect(() => {
    if (compressing) return
    if (pendingCompressionRef.current) return // already in flight
    if (!provider) return
    // Find the most recent finish item (skip nothing — only finish carries
    // the input/output usage we need).
    let lastFinishUsage: ReturnType<typeof coerceUsage> = undefined
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].kind === 'finish') {
        lastFinishUsage = coerceUsage(
          (items[i] as Extract<Item, { kind: 'finish' }>).usage
        )
        break
      }
    }
    if (!lastFinishUsage) return

    // Use the effective Build model (override or default) for the context-
    // window check + the compression call itself.
    const effBuildProvider = buildChoice?.providerId ?? provider.id
    const effBuildModelId = buildChoice?.modelId ?? provider.model
    const modelInfo = getProviderModel(effBuildProvider, effBuildModelId)
    if (!modelInfo) return // unknown model → no contextTokens → skip

    if (!shouldCompress(lastFinishUsage, modelInfo.contextTokens, COMPRESSION_THRESHOLD)) {
      return
    }

    const { toCompress } = splitForCompression(
      items as unknown as ConvItem[],
      KEEP_RECENT_TURNS
    )
    if (toCompress.length === 0) return // not enough older turns to summarize

    const messages = itemsToMessages(toCompress)
    if (messages.length === 0) return

    const compressionRunId = `compress-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    pendingCompressionRef.current = {
      originalCount: toCompress.length,
      atTokens: lastFinishUsage.total
    }
    void ipc.agent.compress({
      runId: compressionRunId,
      providerId: effBuildProvider,
      modelId: effBuildModelId,
      messages,
      originalCount: toCompress.length,
      lastInputTokens: lastFinishUsage.input,
      contextTokens: modelInfo.contextTokens
    })
  }, [items, compressing, provider, buildChoice])

  // 工具行归组（#125/#130）：连续的已完成调用折成一个 tool-group，
  // 未解析的调用（正在运行）独立透传。纯函数，见 lib/toolGroups。
  const displayEntries = useMemo(() => groupToolItems(items), [items])

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
    watchdogRef.current?.start()
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
        // Per-phase overrides — main falls back to providerId/modelId when
        // these are undefined, so omit when no user override.
        planProviderId: planChoice?.providerId,
        planModelId: planChoice?.modelId,
        buildProviderId: buildChoice?.providerId,
        buildModelId: buildChoice?.modelId,
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
      watchdogRef.current?.stop()
    }
  }, [canRun, provider, scope, input, cur, planChoice, buildChoice])

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
    // Compute the edited plan BEFORE setItems. In React 18 the updater
    // passed to setItems runs during the next render — mutating an outer
    // variable from inside the updater and reading it on the next line
    // (the old pattern) always sees `null`, so the dismiss path used to
    // be taken even when the user clicked Execute. itemsRef gives us
    // the latest items[] synchronously here.
    const snapshot = itemsRef.current
    const idx = snapshot.findIndex(
      (it) => it.kind === 'plan' && it.status === 'awaiting'
    )
    if (idx === -1) return
    const card = snapshot[idx] as Extract<Item, { kind: 'plan' }>
    const enabled = card.enabled ?? card.steps.map(() => true)
    const filtered = card.steps.filter((_, i) => enabled[i])

    if (filtered.length === 0) {
      // No steps enabled → treat as dismiss.
      setItems((prev) =>
        prev.map((it) =>
          it.kind === 'plan' && it.status === 'awaiting'
            ? ({ ...it, status: 'dismissed' as const } as Item)
            : it
        )
      )
      await ipc.agent.respondPlanApproval({ runId, response: { approved: false } })
      return
    }

    // Optimistic UI update — flip the card to 'complete' immediately.
    setItems((prev) =>
      prev.map((it) =>
        it.kind === 'plan' && it.status === 'awaiting'
          ? ({ ...it, status: 'complete' as const } as Item)
          : it
      )
    )
    await ipc.agent.respondPlanApproval({
      runId,
      response: { approved: true, plan: { steps: filtered } }
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

  // Mirror items[] in a ref so handlers (handlePlanExecute, etc.) can
  // read the latest snapshot synchronously without putting `items` in
  // their useCallback deps (which would re-create the callbacks on every
  // panel event and churn child re-renders).
  const itemsRef = useRef<Item[]>(items)
  useEffect(() => {
    itemsRef.current = items
  }, [items])

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

  // Watchdog: armed when a run starts, touched on every incoming agent
  // event, fires after AGENT_WATCHDOG_MS of total silence to recover the
  // UI. Created once at mount; the onTimeout closure only uses stable
  // refs / state setters so it stays accurate without re-creation.
  const watchdogRef = useRef<Watchdog | null>(null)
  useEffect(() => {
    const w = createWatchdog(AGENT_WATCHDOG_MS, () => {
      const id = runIdRef.current
      setBusy(false)
      setRunId(null)
      setItems((prev) => [
        ...prev,
        {
          kind: 'error',
          message: `agent 5 分钟无响应，已自动中断；如果 main 进程仍在跑可在日志里追踪 runId=${id ?? 'unknown'}`
        }
      ])
      if (id) void ipc.agent.cancel(id)
    })
    watchdogRef.current = w
    return () => {
      w.stop()
      watchdogRef.current = null
    }
  }, [])

  // ---- Session actions. All gated on !busy: switching the items array
  // mid-run would route streaming events into the wrong conversation.
  const loadSessionItems = useCallback(
    async (sessionId: string): Promise<void> => {
      if (!scope) return
      const persisted = await ipc.context.loadSession({ scope, sessionId })
      const cleaned =
        persisted && Array.isArray(persisted.items)
          ? (sanitizeItems(persisted.items as ConvItem[]) as unknown as Item[])
          : []
      setItems(cleaned)
    },
    [scope]
  )

  const handleSwitchSession = useCallback(
    async (sessionId: string): Promise<void> => {
      if (!scope || busy) return
      await ipc.context.setActiveSession({ scope, sessionId })
      setSessionIndex((prev) => (prev ? { ...prev, activeId: sessionId } : prev))
      await loadSessionItems(sessionId)
    },
    [scope, busy, loadSessionItems]
  )

  const handleNewSession = useCallback(async (): Promise<void> => {
    if (!scope || busy) return
    const index = await ipc.context.createSession(scope)
    setSessionIndex(index)
    setItems([])
  }, [scope, busy])

  const handleDeleteSession = useCallback(
    async (sessionId: string): Promise<void> => {
      if (!scope || busy) return
      const wasActive = sessionIndex?.activeId === sessionId
      const index = await ipc.context.deleteSession({ scope, sessionId })
      setSessionIndex(index)
      if (wasActive) await loadSessionItems(index.activeId)
    },
    [scope, busy, sessionIndex, loadSessionItems]
  )

  const handleExport = useCallback(async (): Promise<void> => {
    if (items.length === 0) return
    const md = exportConversation(items as unknown as ConvItem[], {
      scopeLabel: scope ? scopeLabel(scope) : undefined
    })
    // Default filename: agent-<scope-tail>-<YYYY-MM-DD>.md. Tail is the
    // vault folder name or file basename — gives the user a recognizable
    // file in the save dialog without exposing the full absolute path.
    const tail = scope
      ? scope.kind === 'workspace'
        ? (scope.root.split('/').pop() ?? 'workspace')
        : scope.kind === 'single-file'
          ? (scope.path.split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'file')
          : 'untitled'
      : 'untitled'
    const today = new Date().toISOString().slice(0, 10)
    const defaultName = `agent-${tail}-${today}.md`
    const target = await ipc.saveFileDialog(defaultName)
    if (!target) return
    await ipc.vault.write(target, md)
  }, [items, scope])

  // Resizable width — pointer drag on the left edge handle. Persisted to
  // localStorage so the user's preferred width survives restarts. Drag
  // anchor is right-side (panel sits at the right of the window), so
  // dragging LEFT widens and RIGHT narrows.
  const [width, setWidth] = useState<number>(() => readStoredWidth())
  useEffect(() => {
    try {
      window.localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(width))
    } catch {
      /* localStorage may be unavailable — best-effort */
    }
  }, [width])
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const handleResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      dragRef.current = { startX: e.clientX, startW: width }
      setDragging(true)
      e.currentTarget.setPointerCapture(e.pointerId)
    },
    [width]
  )
  const handleResizeMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d) return
    setWidth(clampPanelWidth(d.startW + (d.startX - e.clientX)))
  }, [])
  const handleResizeEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    dragRef.current = null
    setDragging(false)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }, [])

  return (
    <aside
      className="shrink-0 border-l border-[var(--rule)] bg-[var(--paper-dim)] flex flex-col relative"
      style={{ width: `${width}px` }}
    >
      <div
        onPointerDown={handleResizeStart}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
        onPointerCancel={handleResizeEnd}
        className={`absolute left-0 top-0 bottom-0 w-1 -translate-x-1/2 cursor-col-resize z-10 ${
          dragging ? 'bg-[var(--accent)]/40' : 'hover:bg-[var(--accent)]/30'
        } transition-colors`}
        title="拖动调整宽度"
      />
      <header className="h-11 px-4 flex items-center gap-2 border-b border-[var(--rule)] shrink-0 bg-[var(--paper)]">
        <SessionMenu
          index={sessionIndex}
          disabled={busy}
          onSwitch={(id) => void handleSwitchSession(id)}
          onCreate={() => void handleNewSession()}
          onDelete={(id) => void handleDeleteSession(id)}
        />
        <div className="flex-1" />
        <button
          onClick={() => void handleNewSession()}
          disabled={busy}
          className="no-drag p-1.5 rounded-md text-[var(--ink-faint)] hover:text-[var(--ink)] hover:bg-[var(--paper-soft)] transition disabled:opacity-40"
          title="新建会话"
        >
          <Plus className="w-4 h-4" />
        </button>
        {items.length > 0 && (
          <button
            onClick={() => void handleExport()}
            disabled={busy}
            className="no-drag p-1.5 rounded-md text-[var(--ink-faint)] hover:text-[var(--ink)] hover:bg-[var(--paper-soft)] transition disabled:opacity-40"
            title="导出为 markdown"
          >
            <Download className="w-4 h-4" />
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
        {compressing && (
          <span className={`flex items-center gap-1 ${totalUsage.total > 0 ? '' : 'ml-auto'} text-[var(--accent)] font-serif-zh italic`}>
            <Loader2 className="w-3 h-3 animate-spin" />
            压缩中…
          </span>
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
        {displayEntries.map((entry) =>
          entry.kind === 'tool-group' ? (
            <ToolGroupView key={`g-${entry.entries[0].toolCallId}`} entries={entry.entries} />
          ) : (
            <ItemView
              key={entry.index}
              item={entry.item}
              onApproval={handleApproval}
              onPlanStepToggle={handlePlanStepToggle}
              onPlanExecute={handlePlanExecute}
              onPlanDismiss={handlePlanDismiss}
              toolRunning={entry.item.kind === 'tool-call' && busy}
            />
          )
        )}
        {busy && (
          <div className="flex items-center gap-2 text-[12px] text-[var(--ink-faint)]">
            <Loader2 className="w-3 h-3 animate-spin" />
            <span className="font-serif-zh italic">agent 思考中…</span>
          </div>
        )}
      </div>

      <footer className="border-t border-[var(--rule)] bg-[var(--paper)]">
        <ModelPickerStrip
          plan={effectivePlan}
          build={effectiveBuild}
          planIsOverride={planChoice !== null}
          buildIsOverride={buildChoice !== null}
          availableModels={availableModels}
          open={pickerOpen}
          onToggle={() => setPickerOpen((v) => !v)}
          onSelectPlan={setPlanChoice}
          onSelectBuild={setBuildChoice}
        />
        <div className="flex items-end gap-2 p-3">
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
  onPlanDismiss,
  toolRunning
}: {
  item: Item
  onApproval: (toolCallId: string, approved: boolean) => Promise<void>
  onPlanStepToggle: (stepIndex: number) => void
  onPlanExecute: () => Promise<void>
  onPlanDismiss: () => Promise<void>
  /** tool-call items only: the call hasn't resolved and the run is live. */
  toolRunning?: boolean
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
  if (item.kind === 'compressed-summary') {
    return <CompressedSummaryView item={item} />
  }
  if (item.kind === 'assistant-text') {
    return <AssistantText text={item.text} />
  }
  if (item.kind === 'tool-call') {
    return <ToolCallView name={item.name} args={item.args} running={toolRunning} />
  }
  if (item.kind === 'tool-result') {
    // 正常路径下结果行都进了 tool-group（见 groupToolItems）；这里只是
    // 防御性兜底。
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

  const isDelete = toolName === 'delete_file' || toolName === 'delete_dir'

  const icon = isDelete ? (
    <Trash2 className="w-3.5 h-3.5" />
  ) : toolName === 'create_file' ? (
    <FilePlus className="w-3.5 h-3.5" />
  ) : toolName === 'apply_edit' ? (
    <FilePen className="w-3.5 h-3.5" />
  ) : (
    <FileText className="w-3.5 h-3.5" />
  )

  const title =
    toolName === 'delete_file'
      ? '删除文件'
      : toolName === 'delete_dir'
        ? '删除文件夹'
        : toolName === 'create_file'
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
            <Check className="w-3 h-3" /> {isDelete ? '已删除' : '已应用'}
          </span>
        )}
        {status === 'approved' && resultError && (
          <span className="text-[11px] text-[var(--accent)]">
            {isDelete ? '删除失败' : '写入失败'}
          </span>
        )}
        {status === 'rejected' && (
          <span className="text-[11px] text-[var(--ink-faint)] font-serif-zh italic">
            已拒绝
          </span>
        )}
      </div>

      {isDelete ? (
        <div className="px-3 py-2 text-[11px] text-[var(--ink-soft)]">
          {toolName === 'delete_dir'
            ? `将递归删除该文件夹（含 ${Number(payload.entryCount ?? 0)} 项），不可撤销。`
            : '将永久删除该文件，不可撤销。'}
        </div>
      ) : toolName === 'apply_edit' ? (
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

/** Mirrors web's summarizeArgs — one glanceable token for the collapsed row. */
function summarizeArgs(args: unknown): string {
  if (typeof args !== 'object' || args === null) return String(args)
  const obj = args as Record<string, unknown>
  for (const key of ['path', 'query', 'url', 'pattern']) {
    if (typeof obj[key] === 'string') return `${key}=${obj[key]}`
  }
  return JSON.stringify(obj).slice(0, 80)
}

/**
 * 只在调用还没有结果时渲染（有结果后由 ToolResultView 一行代表整次调用，
 * 见 #125）。运行中带 spinner，是 transcript 里唯一"摊开"的工具行。
 */
function ToolCallView({
  name,
  args,
  running
}: {
  name: string
  args: unknown
  running?: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="text-[12px] border-l-2 border-[var(--rule)] pl-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="no-drag flex items-center gap-1 text-[var(--ink-soft)] hover:text-[var(--ink)] transition w-full text-left"
      >
        {running ? (
          <Loader2 className="w-3 h-3 animate-spin text-[var(--accent)] shrink-0" />
        ) : open ? (
          <ChevronDown className="w-3 h-3 shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 shrink-0" />
        )}
        <span className="font-mono">{name}</span>
        {!open && (
          <span className="font-mono text-[11px] text-[var(--ink-faint)] truncate ml-1 min-w-0">
            {summarizeArgs(args)}
          </span>
        )}
      </button>
      {open && (
        <pre className="font-mono text-[11px] text-[var(--ink-faint)] mt-0.5 overflow-x-auto whitespace-pre-wrap break-all">
          {JSON.stringify(args, null, 2)}
        </pre>
      )}
    </div>
  )
}

/**
 * 连续完成调用的折叠组（#130）：≥2 条时收成一行组头（`› N 个工具调用 ·
 * 名称摘要`），展开后是逐条可再展开的结果行；单条不加组头直接平铺。
 */
function ToolGroupView({ entries }: { entries: ToolGroupEntry[] }) {
  const [open, setOpen] = useState(false)
  if (entries.length === 1) {
    const e = entries[0]
    return <ToolResultView name={e.name} result={e.result} args={e.args} />
  }
  return (
    <div className="text-[12px] border-l-2 border-[var(--accent)]/40 pl-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="no-drag flex items-center gap-1 text-[var(--ink-soft)] hover:text-[var(--ink)] transition w-full text-left"
      >
        {open ? (
          <ChevronDown className="w-3 h-3 shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 shrink-0" />
        )}
        <span className="font-serif-zh italic">{entries.length} 个工具调用</span>
        {!open && (
          <span className="font-mono text-[11px] text-[var(--ink-faint)] truncate ml-1 min-w-0">
            {summarizeGroup(entries)}
          </span>
        )}
      </button>
      {open && (
        <div className="mt-1 space-y-1">
          {entries.map((e) => (
            <ToolResultView key={e.toolCallId} name={e.name} result={e.result} args={e.args} />
          ))}
        </div>
      )}
    </div>
  )
}

/** One collapsed row per finished call: `› name → preview`; expanding shows
 *  the arguments (when the call item is nearby) plus the full result. */
function ToolResultView({
  name,
  result,
  args
}: {
  name: string
  result: unknown
  args?: unknown
}) {
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
        className="no-drag flex items-center gap-1 text-[var(--ink-soft)] hover:text-[var(--ink)] transition w-full text-left"
      >
        {open ? (
          <ChevronDown className="w-3 h-3 shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 shrink-0" />
        )}
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
        <div className="mt-1 space-y-1">
          {args !== undefined && (
            <pre className="font-mono text-[11px] text-[var(--ink-faint)] overflow-x-auto whitespace-pre-wrap break-all">
              {JSON.stringify(args, null, 2)}
            </pre>
          )}
          <pre className="font-mono text-[11px] text-[var(--ink-faint)] overflow-x-auto whitespace-pre-wrap break-all max-h-[200px] overflow-y-auto border-t border-[var(--rule-soft)] pt-1">
            {full}
          </pre>
        </div>
      )}
    </div>
  )
}

// =============================================================================
// Model picker — compact strip + popover above the textarea
// =============================================================================

function ModelPickerStrip({
  plan,
  build,
  planIsOverride,
  buildIsOverride,
  availableModels,
  open,
  onToggle,
  onSelectPlan,
  onSelectBuild
}: {
  plan: ModelChoice | null
  build: ModelChoice | null
  planIsOverride: boolean
  buildIsOverride: boolean
  availableModels: AvailableModel[]
  open: boolean
  onToggle: () => void
  onSelectPlan: (c: ModelChoice | null) => void
  onSelectBuild: (c: ModelChoice | null) => void
}) {
  return (
    <div className="border-t border-[var(--rule-soft)] bg-[var(--paper-dim)]">
      <button
        onClick={onToggle}
        className="no-drag w-full px-3 py-1.5 flex items-center gap-2 text-[11px] text-[var(--ink-soft)] hover:text-[var(--ink)] hover:bg-[var(--paper-soft)] transition text-left"
        title={open ? '收起' : '更改 Plan / Build 模型'}
      >
        <ModelLabel kind="Plan" choice={plan} override={planIsOverride} models={availableModels} />
        <span className="text-[var(--ink-ghost)]">·</span>
        <ModelLabel kind="Build" choice={build} override={buildIsOverride} models={availableModels} />
        <span className="ml-auto text-[var(--ink-faint)]">
          {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        </span>
      </button>
      {open && (
        <ModelPickerPopover
          plan={plan}
          build={build}
          availableModels={availableModels}
          onSelectPlan={onSelectPlan}
          onSelectBuild={onSelectBuild}
        />
      )}
    </div>
  )
}

function ModelLabel({
  kind,
  choice,
  override,
  models
}: {
  kind: 'Plan' | 'Build'
  choice: ModelChoice | null
  override: boolean
  models: AvailableModel[]
}) {
  if (!choice) {
    return (
      <span className="flex items-center gap-1">
        <span className="text-[var(--ink-faint)]">{kind}</span>
        <span className="font-serif-zh italic text-[var(--ink-faint)]">—</span>
      </span>
    )
  }
  const matched = models.find(
    (m) => m.providerId === choice.providerId && m.modelId === choice.modelId
  )
  return (
    <span className="flex items-center gap-1 min-w-0">
      <span className={override ? 'text-[var(--accent)]' : 'text-[var(--ink-faint)]'}>
        {kind}
      </span>
      <span className="font-mono text-[var(--ink)] truncate">{choice.modelId}</span>
      {matched && (
        <span className="font-mono text-[var(--ink-faint)]">
          {formatContext(matched.contextTokens)}
        </span>
      )}
    </span>
  )
}

function ModelPickerPopover({
  plan,
  build,
  availableModels,
  onSelectPlan,
  onSelectBuild
}: {
  plan: ModelChoice | null
  build: ModelChoice | null
  availableModels: AvailableModel[]
  onSelectPlan: (c: ModelChoice | null) => void
  onSelectBuild: (c: ModelChoice | null) => void
}) {
  if (availableModels.length === 0) {
    return (
      <div className="px-3 pb-2 text-[11px] font-serif-zh italic text-[var(--ink-faint)]">
        没有已配置的模型 — 去 ⌘, 设置里加 provider
      </div>
    )
  }
  const value = (c: ModelChoice | null): string => (c ? serializeModelChoice(c) : '')
  const onChange =
    (set: (c: ModelChoice | null) => void) =>
    (v: string): void => {
      if (!v) set(null)
      else set(parseModelChoice(v))
    }
  return (
    <div className="px-3 pb-3 pt-1 space-y-2 border-t border-[var(--rule-soft)]">
      <PickerRow
        label="Plan"
        value={value(plan)}
        onChange={onChange(onSelectPlan)}
        models={availableModels}
      />
      <PickerRow
        label="Build"
        value={value(build)}
        onChange={onChange(onSelectBuild)}
        models={availableModels}
      />
      <div className="font-serif-zh italic text-[10px] text-[var(--ink-faint)]">
        留空 = 跟随设置里的默认 provider
      </div>
    </div>
  )
}

function PickerRow({
  label,
  value,
  onChange,
  models
}: {
  label: string
  value: string
  onChange: (value: string) => void
  models: AvailableModel[]
}) {
  const options = [
    { value: '', label: '默认 (跟随设置)' },
    ...models.map((m) => ({
      value: `${m.providerId}/${m.modelId}`,
      label: `${m.providerName} · ${m.modelId}`,
      hint: formatContext(m.contextTokens)
    }))
  ]
  return (
    <div className="flex items-center gap-2">
      <span className="w-10 shrink-0 text-[11px] text-[var(--ink-soft)]">{label}</span>
      <div className="flex-1 min-w-0">
        <Select value={value} onChange={onChange} options={options} ariaLabel={`${label} 模型`} />
      </div>
    </div>
  )
}

function CompressedSummaryView({
  item
}: {
  item: Extract<Item, { kind: 'compressed-summary' }>
}) {
  const [open, setOpen] = useState(false)
  const html = useMemo(() => renderMd(item.summary), [item.summary])
  return (
    <div className="rounded-md border border-[var(--rule)] bg-[var(--paper)] overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="no-drag w-full px-3 py-2 flex items-center gap-2 text-[11px] bg-[var(--paper-soft)] border-b border-[var(--rule-soft)] hover:bg-[var(--paper)] transition text-left"
      >
        {open ? (
          <ChevronDown className="w-3 h-3 text-[var(--ink-faint)]" />
        ) : (
          <ChevronRight className="w-3 h-3 text-[var(--ink-faint)]" />
        )}
        <span className="font-serif-zh italic text-[var(--ink-soft)]">
          之前 {item.originalCount} 条对话已压缩
        </span>
        {item.atTokens && (
          <span className="ml-auto font-mono text-[var(--ink-faint)]">
            @ {formatTokens(item.atTokens)} tokens
          </span>
        )}
      </button>
      {open && (
        <div className="px-3 py-2 prose-agent" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  )
}

/** Session title for display — empty title means an untouched session. */
function sessionLabel(meta: SessionMeta | undefined): string {
  return meta?.title || '新会话'
}

function sessionTime(updatedAt: number): string {
  if (!updatedAt) return ''
  const d = new Date(updatedAt)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay
    ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

/**
 * Header session switcher: current session title + chevron, dropdown
 * with the scope's sessions (recent first, inline delete confirm). The
 * 清空 button this replaces had destroy-only semantics; "new session"
 * covers it and keeps the old conversation reachable.
 */
function SessionMenu({
  index,
  disabled,
  onSwitch,
  onCreate,
  onDelete
}: {
  index: SessionIndex | null
  disabled: boolean
  onSwitch: (id: string) => void
  onCreate: () => void
  onDelete: (id: string) => void
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

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

  useEffect(() => {
    if (!open) setConfirmingId(null)
  }, [open])

  const active = index?.sessions.find((m) => m.id === index.activeId)

  return (
    <div ref={wrapRef} className="relative min-w-0 max-w-[60%]">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="no-drag max-w-full flex items-center gap-1.5 px-1.5 py-1 -ml-1.5 rounded-md hover:bg-[var(--paper-soft)] transition group"
        title="切换会话"
      >
        <span className="font-display italic text-[14px] text-[var(--ink)] truncate">
          {sessionLabel(active)}
        </span>
        <ChevronDown
          className={`w-3 h-3 text-[var(--ink-faint)] group-hover:text-[var(--ink)] shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && index && (
        <div className="absolute left-0 top-full mt-1.5 w-72 rounded-lg border border-[var(--rule)] bg-[var(--paper)] shadow-[0_8px_28px_rgba(0,0,0,0.14),0_2px_6px_rgba(0,0,0,0.08)] text-[12px] z-50">
          <p className="px-3 pt-2.5 pb-1 text-[10px] uppercase tracking-[0.18em] text-[var(--ink-faint)] select-none">
            sessions
          </p>
          <div className="px-1.5 pb-1 max-h-64 overflow-y-auto">
            {index.sessions.map((m) => {
              const isActive = m.id === index.activeId
              if (confirmingId === m.id) {
                return (
                  <div
                    key={m.id}
                    className="px-2 py-1.5 rounded-md bg-[var(--accent-soft)]/40 flex items-center gap-2"
                  >
                    <span className="flex-1 font-serif-zh italic text-[11.5px] text-[var(--ink-soft)] truncate">
                      删除「{sessionLabel(m)}」？
                    </span>
                    <button
                      onClick={() => {
                        setConfirmingId(null)
                        onDelete(m.id)
                      }}
                      className="text-[11px] text-[var(--accent)] hover:underline shrink-0"
                    >
                      删除
                    </button>
                    <button
                      onClick={() => setConfirmingId(null)}
                      className="text-[11px] text-[var(--ink-faint)] hover:text-[var(--ink)] shrink-0"
                    >
                      取消
                    </button>
                  </div>
                )
              }
              return (
                <div
                  key={m.id}
                  className={`px-2 py-1.5 rounded-md flex items-center gap-2 group/row cursor-pointer transition ${
                    isActive ? 'bg-[var(--paper-soft)]' : 'hover:bg-[var(--paper-soft)]'
                  } ${disabled ? 'opacity-50 pointer-events-none' : ''}`}
                  onClick={() => {
                    if (!isActive) onSwitch(m.id)
                    setOpen(false)
                  }}
                >
                  <div className="flex-1 min-w-0">
                    <div
                      className={`truncate ${isActive ? 'text-[var(--ink)]' : 'text-[var(--ink-soft)]'}`}
                    >
                      {sessionLabel(m)}
                    </div>
                    <div className="text-[10.5px] text-[var(--ink-faint)]">
                      {sessionTime(m.updatedAt)}
                      {m.turnCount > 0 ? ` · ${m.turnCount} 轮` : ' · 空'}
                    </div>
                  </div>
                  {isActive ? (
                    <Check className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                  ) : (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setConfirmingId(m.id)
                      }}
                      className="p-1 rounded text-[var(--ink-ghost)] hover:text-[var(--accent)] opacity-0 group-hover/row:opacity-100 transition shrink-0"
                      title="删除会话"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          <div className="border-t border-[var(--rule-soft)] px-1.5 py-1">
            <button
              onClick={() => {
                setOpen(false)
                onCreate()
              }}
              disabled={disabled}
              className="w-full px-2 py-1.5 rounded-md flex items-center gap-2 text-[var(--ink-soft)] hover:text-[var(--ink)] hover:bg-[var(--paper-soft)] disabled:opacity-50 transition"
            >
              <Plus className="w-3 h-3 shrink-0" />
              新建会话
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
