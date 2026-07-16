import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { ApprovalPayload, Scope, SessionIndex } from '@quill/shared-types'
import { renderMarkdown } from '../lib/markdown'
import type { AgentSession, AgentTurn, SelectedModel } from '../lib/use-agent-session'
import type { AgentConnectionStatus } from '../lib/agent-client'
import { formatContextWindow, formatTokens } from '../lib/usage'

type Props = {
  /** Owned by Vault via useAgentSession so panel mount/unmount doesn't
   *  blow away the conversation. */
  session: AgentSession
  scope: Scope
  /** Cloud workspace the run is confined to (server pins scope.root). */
  workspaceId?: string
  /** Display label for the permission hint, e.g. "quill". */
  workspaceLabel?: string
  currentBuffer?: string
  currentSelection?: string
  onClose: () => void
}

export function AgentPanel({
  session,
  scope,
  workspaceId,
  workspaceLabel,
  currentBuffer,
  currentSelection,
  onClose
}: Props): JSX.Element {
  const {
    status,
    providers,
    catalog,
    loadErr,
    turns,
    prompt,
    setPrompt,
    selectedModel,
    setSelectedModel,
    contextTokens,
    lastUsage,
    compressionStatus,
    send,
    cancel,
    respond,
    sessions,
    switchSession,
    newSession,
    deleteSession
  } = session
  const bottomRef = useRef<HTMLDivElement>(null)
  const runningTurn = turns.find((t) => t.status === 'running')
  const latestTurn = turns[turns.length - 1] ?? null

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [
    turns.length,
    latestTurn?.text,
    latestTurn?.toolCalls.length,
    latestTurn?.pendingApprovals.size
  ])

  async function handleSend(): Promise<void> {
    const text = prompt.trim()
    if (!text) return
    setPrompt('')
    await send({ text, scope, workspaceId, currentBuffer, currentSelection })
  }

  if (loadErr) {
    return (
      <PanelShell onClose={onClose} status={status}>
        <div className="p-4 text-sm text-[var(--accent)]">{loadErr}</div>
      </PanelShell>
    )
  }
  if (providers === null || catalog === null) {
    return (
      <PanelShell onClose={onClose} status={status}>
        <div className="p-4 text-sm text-[var(--ink-faint)]">加载中…</div>
      </PanelShell>
    )
  }
  if (providers.length === 0 || !selectedModel) {
    return (
      <PanelShell onClose={onClose} status={status}>
        <div className="p-4 text-sm text-[var(--ink-soft)]">
          未配置 AI provider。点击右上角设置图标进入设置，配上一个 provider 即可使用。
        </div>
      </PanelShell>
    )
  }

  // Token budget: input + output of the LAST settled turn is the closest
  // proxy for "current context size" — the next turn's input will start
  // from roughly that number, plus the new prompt.
  const usedTokens = lastUsage ? lastUsage.input + lastUsage.output : 0

  return (
    <PanelShell
      onClose={onClose}
      status={status}
      header={
        <>
          <ModelPicker
            providers={providers}
            catalog={catalog}
            selected={selectedModel}
            onChange={setSelectedModel}
          />
          {contextTokens > 0 && (
            <TokenBudget used={usedTokens} window={contextTokens} />
          )}
        </>
      }
      sessionsMenu={
        <SessionMenu
          sessions={sessions}
          disabled={!!runningTurn}
          onSwitch={switchSession}
          onCreate={newSession}
          onDelete={deleteSession}
        />
      }
    >
      {compressionStatus !== 'idle' && (
        <CompressionBanner status={compressionStatus} />
      )}
      <div className="flex-1 overflow-y-auto scroll-thin px-4 py-3 space-y-6">
        {turns.length === 0 && (
          <p className="text-sm text-[var(--ink-faint)]">
            问点什么吧——agent 能读 vault 里的文件、写文件，写操作会先征求你的同意。
          </p>
        )}
        {turns.map((turn) => (
          <TurnView key={turn.runId} turn={turn} onRespond={respond} />
        ))}
        <div ref={bottomRef} />
      </div>
      <footer className="border-t border-[var(--rule-soft)] p-3 flex flex-col gap-2">
        {workspaceLabel && (
          <p className="text-[11px] text-[var(--ink-faint)] select-none">
            agent 可访问：<span className="font-mono">/{workspaceLabel}</span>
          </p>
        )}
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void handleSend()
            }
          }}
          placeholder="问点什么…（⌘↵ 发送）"
          rows={3}
          className="bg-[var(--paper-dim)] border border-[var(--rule)] rounded p-2 text-sm outline-none focus:border-[var(--accent)] resize-none"
        />
        <div className="flex items-center gap-2 justify-end">
          {runningTurn && (
            <button
              type="button"
              onClick={() => void cancel()}
              className="text-xs text-[var(--ink-faint)] hover:text-[var(--accent)] px-2 py-1"
            >
              取消
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={!prompt.trim() || !!runningTurn}
            className="bg-[var(--ink)] text-[var(--paper)] text-sm rounded px-3 py-1 disabled:opacity-40"
          >
            发送
          </button>
        </div>
      </footer>
    </PanelShell>
  )
}

function TurnView({
  turn,
  onRespond
}: {
  turn: AgentTurn
  onRespond: (toolCallId: string, approved: boolean) => Promise<void>
}): JSX.Element {
  // Synthetic "history compressed" turn — rendered distinctly so the user
  // notices the prior conversation was summarized rather than retained
  // verbatim. The runId prefix is how useAgentSession marks these.
  if (turn.runId.startsWith('summary-')) {
    return (
      <div className="rounded-md border border-[var(--rule)] bg-[var(--paper-dim)] px-3 py-2 space-y-1">
        <div className="text-[11px] uppercase tracking-wider text-[var(--ink-faint)]">
          {turn.prompt}
        </div>
        <article
          className="prose-paper text-sm"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(turn.text) }}
        />
      </div>
    )
  }
  return (
    <div className="space-y-3">
      <div className="text-sm text-[var(--ink)]">
        <span className="text-[var(--ink-faint)]">› </span>
        {turn.prompt}
      </div>
      <ToolCallsView toolCalls={turn.toolCalls} running={turn.status === 'running'} />
      {[...turn.pendingApprovals.entries()].map(([id, payload]) => (
        <ApprovalCard
          key={id}
          payload={payload}
          onApprove={() => void onRespond(id, true)}
          onReject={() => void onRespond(id, false)}
        />
      ))}
      {turn.text && (
        <article
          className="prose-paper text-sm"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(turn.text) }}
        />
      )}
      {turn.status === 'running' && (
        <div className="text-xs text-[var(--ink-faint)]">思考中…</div>
      )}
      {typeof turn.status === 'object' && (
        <div className="text-xs text-[var(--accent)]">错误：{turn.status.error}</div>
      )}
    </div>
  )
}

function PanelShell({
  header,
  status,
  onClose,
  sessionsMenu,
  children
}: {
  /** Custom header content (model picker + token budget). Falls back to
   *  a plain "AI" label when omitted (for the loading / empty states). */
  header?: React.ReactNode
  status: AgentConnectionStatus
  onClose: () => void
  /** Session switcher (替代旧「清空」— 新建会话覆盖其语义且对话可找回). */
  sessionsMenu?: React.ReactNode
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="w-full h-full flex flex-col bg-[var(--paper)] md:border-l md:border-[var(--rule)]">
      <header className="h-12 flex items-center gap-2 px-3 border-b border-[var(--rule-soft)]">
        <ConnectionDot status={status} />
        <div className="flex-1 flex items-center gap-2 min-w-0">
          {header ?? <span className="text-sm text-[var(--ink-soft)]">AI</span>}
        </div>
        {sessionsMenu}
        <button
          type="button"
          onClick={onClose}
          className="text-[var(--ink-faint)] hover:text-[var(--ink)] px-2"
          aria-label="关闭 AI 面板"
        >
          <X className="w-4 h-4" />
        </button>
      </header>
      {children}
    </div>
  )
}

function ConnectionDot({ status }: { status: AgentConnectionStatus }): JSX.Element {
  const config: Record<AgentConnectionStatus, { color: string; title: string }> = {
    open: { color: 'bg-[oklch(0.66_0.13_145)]', title: '已连接' },
    connecting: { color: 'bg-[var(--ink-ghost)] animate-pulse', title: '正在连接…' },
    reconnecting: { color: 'bg-[var(--accent)] animate-pulse', title: '正在重连…' },
    closed: { color: 'bg-[var(--ink-ghost)]', title: '已断开' }
  }
  const c = config[status]
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${c.color} shrink-0`}
      title={c.title}
      aria-label={c.title}
    />
  )
}

function ModelPicker({
  providers,
  catalog,
  selected,
  onChange
}: {
  providers: import('@quill/shared-types').AgentProviderInfo[]
  catalog: import('./../lib/providers-api').CatalogEntry[]
  selected: SelectedModel
  onChange: (m: SelectedModel) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const catalogById = new Map(catalog.map((p) => [p.id, p]))
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('click', onDocClick)
    return () => document.removeEventListener('click', onDocClick)
  }, [open])

  return (
    <div ref={ref} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-sm text-[var(--ink)] hover:bg-[var(--paper-soft)] rounded px-2 py-1 min-w-0 max-w-full"
        title="切换模型"
      >
        <span className="truncate font-mono">
          {selected.providerId}/{selected.modelId}
        </span>
        <span className="text-[var(--ink-faint)] shrink-0">▾</span>
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 bg-[var(--paper)] border border-[var(--rule)] rounded shadow-lg min-w-[220px] max-h-[60vh] overflow-y-auto py-1">
          {providers.map((p) => {
            const cat = catalogById.get(p.id)
            // Only show models that exist in the catalog (have real context-window data).
            const models = cat?.models ?? []
            if (models.length === 0) return null
            return (
              <div key={p.id} className="py-0.5">
                <div className="px-3 py-0.5 text-[10px] uppercase tracking-wider text-[var(--ink-faint)]">
                  {p.id}
                </div>
                {models.map((m) => {
                  const active =
                    selected.providerId === p.id && selected.modelId === m.id
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => {
                        onChange({ providerId: p.id, modelId: m.id })
                        setOpen(false)
                      }}
                      className={[
                        'w-full text-left px-3 py-1.5 text-sm flex items-center gap-2',
                        active
                          ? 'bg-[var(--accent-soft)] text-[var(--ink)]'
                          : 'text-[var(--ink-soft)] hover:bg-[var(--paper-dim)]'
                      ].join(' ')}
                    >
                      <span className="font-mono truncate flex-1">{m.label ?? m.id}</span>
                      {m.contextTokens > 0 && (
                        <span className="text-[10px] text-[var(--ink-faint)] shrink-0">
                          {formatContextWindow(m.contextTokens)}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function CompressionBanner({
  status
}: {
  status: 'compressing' | { error: string }
}): JSX.Element {
  if (status === 'compressing') {
    return (
      <div className="px-4 py-2 text-xs text-[var(--ink-soft)] bg-[var(--paper-dim)] border-b border-[var(--rule-soft)] flex items-center gap-2">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse" />
        正在压缩对话历史…
      </div>
    )
  }
  return (
    <div className="px-4 py-2 text-xs text-[var(--accent)] bg-[var(--accent-soft)] border-b border-[var(--accent)]/30">
      压缩失败：{status.error}。下一轮可能因上下文过长而失败。
    </div>
  )
}

function TokenBudget({ used, window: total }: { used: number; window: number }): JSX.Element {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0
  // Color crosses warning around 70%, alarm at 90%.
  const tone =
    pct >= 90
      ? 'text-[var(--accent)]'
      : pct >= 70
        ? 'text-[var(--ink)]'
        : 'text-[var(--ink-faint)]'
  return (
    <span
      className={`text-[11px] font-mono shrink-0 ${tone}`}
      title={`${formatTokens(used)} of ${formatTokens(total)} tokens (${pct}%)`}
    >
      {formatContextWindow(used)} / {formatContextWindow(total)}
    </span>
  )
}

/**
 * 工具调用折叠视图（#125）：已完成的归组进「N 个工具调用」，默认收起、
 * 点开逐条查看；运行中只把最新一条摊出来（带 spinner）——「每次只显示
 * 正在运行的命令」。
 */
function ToolCallsView({
  toolCalls,
  running
}: {
  toolCalls: { toolCallId: string; name: string; args: unknown }[]
  running: boolean
}): JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (toolCalls.length === 0) return null
  const current = running ? toolCalls[toolCalls.length - 1] : null
  const done = current ? toolCalls.slice(0, -1) : toolCalls
  return (
    <div className="space-y-1">
      {done.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-xs text-[var(--ink-faint)] hover:text-[var(--ink)] transition"
          >
            {open ? '▾' : '▸'} {done.length} 个工具调用
          </button>
          {open &&
            done.map((tc) => (
              <div
                key={tc.toolCallId}
                className="mt-1 text-xs font-mono bg-[var(--paper-soft)] border border-[var(--rule-soft)] rounded px-2 py-1 text-[var(--ink-soft)]"
              >
                <span className="text-[var(--accent)]">{tc.name}</span>(
                <span className="text-[var(--ink-faint)]">{summarizeArgs(tc.args)}</span>)
              </div>
            ))}
        </div>
      )}
      {current && (
        <div className="flex items-center gap-2 text-xs font-mono bg-[var(--paper-soft)] border border-[var(--rule-soft)] rounded px-2 py-1 text-[var(--ink-soft)]">
          <span className="inline-block w-3 h-3 border border-[var(--accent)] border-t-transparent rounded-full animate-spin shrink-0" />
          <span>
            <span className="text-[var(--accent)]">{current.name}</span>(
            <span className="text-[var(--ink-faint)]">{summarizeArgs(current.args)}</span>)
          </span>
        </div>
      )}
    </div>
  )
}

function summarizeArgs(args: unknown): string {
  if (typeof args !== 'object' || args === null) return String(args)
  const obj = args as Record<string, unknown>
  for (const key of ['path', 'query', 'url']) {
    if (typeof obj[key] === 'string') return `${key}=${obj[key]}`
  }
  return JSON.stringify(obj).slice(0, 80)
}

// ============================================================
// Tool approval rendering
//
// The agent's write tools (create_file / write_file / apply_edit) ship
// rich `payload`s — for create/write that's the full file content as a
// markdown string, for apply_edit it's old_text + new_text. Stringifying
// the payload as JSON dumps the body with `\n` escape sequences, which
// is the bug the user reported. Below we dispatch on `payload.kind` and
// hand off to a small per-shape view.
//
// Unknown payloads fall through to the JSON dump — better an ugly
// readable thing than failing to render at all.
// ============================================================

type WritePayload = { kind: 'create_file' | 'write_file'; path: string; content: string }
type EditPayload = { kind: 'apply_edit'; path: string; old_text: string; new_text: string }

function isWritePayload(p: ApprovalPayload): p is WritePayload & ApprovalPayload {
  return (
    (p.kind === 'create_file' || p.kind === 'write_file') &&
    typeof p.path === 'string' &&
    typeof p.content === 'string'
  )
}
function isEditPayload(p: ApprovalPayload): p is EditPayload & ApprovalPayload {
  return (
    p.kind === 'apply_edit' &&
    typeof p.path === 'string' &&
    typeof p.old_text === 'string' &&
    typeof p.new_text === 'string'
  )
}

/** Trim absolute server paths down to a vault-relative display path so
 *  the user sees `notes/a.md` instead of `/data/vault/notes/a.md`. */
function shortPath(p: string): string {
  return p.replace(/^\/data\/vault\/?/, '').replace(/^\/+/, '') || '/'
}

const KIND_LABEL: Record<string, string> = {
  create_file: '新建文件',
  write_file: '覆写文件',
  apply_edit: '编辑文件'
}

function ApprovalCard({
  payload,
  onApprove,
  onReject
}: {
  payload: ApprovalPayload
  onApprove: () => void
  onReject: () => void
}): JSX.Element {
  // Default to open so the user immediately sees what they're approving.
  const [open, setOpen] = useState(true)
  const kindLabel = typeof payload.kind === 'string' ? KIND_LABEL[payload.kind] ?? '需要确认' : '需要确认'
  const path = typeof payload.path === 'string' ? payload.path : null

  return (
    <div className="rounded-md border border-[var(--accent)] bg-[var(--paper)] overflow-hidden text-sm">
      <div className="px-3 py-2 flex items-center gap-2 bg-[var(--accent-soft)] border-b border-[var(--accent)]/30">
        <span className="text-[var(--accent)] font-medium">{kindLabel}</span>
        {path && (
          <span
            className="font-mono text-[11px] text-[var(--ink-soft)] truncate flex-1"
            title={path}
          >
            {shortPath(path)}
          </span>
        )}
      </div>

      {isWritePayload(payload) ? (
        <WriteBody content={payload.content} open={open} onToggle={() => setOpen((v) => !v)} />
      ) : isEditPayload(payload) ? (
        <EditBody
          oldText={payload.old_text}
          newText={payload.new_text}
          open={open}
          onToggle={() => setOpen((v) => !v)}
        />
      ) : (
        <GenericBody payload={payload} />
      )}

      <div className="flex border-t border-[var(--rule-soft)]">
        <button
          type="button"
          onClick={onReject}
          className="flex-1 px-3 py-2 text-xs text-[var(--ink-soft)] hover:bg-[var(--paper-soft)] border-r border-[var(--rule-soft)] transition-colors"
        >
          拒绝
        </button>
        <button
          type="button"
          onClick={onApprove}
          className="flex-1 px-3 py-2 text-xs font-medium text-[var(--paper)] bg-[var(--accent)] hover:opacity-90 transition-opacity"
        >
          同意
        </button>
      </div>
    </div>
  )
}

function WriteBody({
  content,
  open,
  onToggle
}: {
  content: string
  open: boolean
  onToggle: () => void
}): JSX.Element {
  const lineCount = content.split('\n').length
  const charCount = content.length
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-3 py-1.5 flex items-center gap-1 text-[11px] text-[var(--ink-soft)] hover:bg-[var(--paper-soft)] transition-colors"
      >
        <span className="text-[var(--ink-faint)]">{open ? '▾' : '▸'}</span>
        <span className="font-mono">
          {lineCount} 行 · {charCount} 字符
        </span>
      </button>
      {open && (
        // `whitespace-pre-wrap` keeps real newlines visible (no \n
        // escapes), `break-all` so a single long line doesn't blow out
        // the panel width on H5.
        <pre className="px-3 pb-2 font-mono text-[11px] text-[var(--ink)] whitespace-pre-wrap break-all max-h-[280px] overflow-y-auto">
          {content}
        </pre>
      )}
    </div>
  )
}

function EditBody({
  oldText,
  newText,
  open,
  onToggle
}: {
  oldText: string
  newText: string
  open: boolean
  onToggle: () => void
}): JSX.Element {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-3 py-1.5 flex items-center gap-1 text-[11px] text-[var(--ink-soft)] hover:bg-[var(--paper-soft)] transition-colors"
      >
        <span className="text-[var(--ink-faint)]">{open ? '▾' : '▸'}</span>
        <span className="font-mono">
          −{oldText.split('\n').length} / +{newText.split('\n').length} 行
        </span>
      </button>
      {open && (
        <div className="px-3 pb-2 space-y-1">
          <pre className="font-mono text-[11px] whitespace-pre-wrap break-all max-h-[140px] overflow-y-auto bg-[color-mix(in_oklch,var(--accent)_10%,transparent)] text-[var(--ink)] px-2 py-1 rounded border-l-2 border-[var(--accent)]/50">
            <span className="text-[var(--accent)] mr-1">−</span>
            {oldText}
          </pre>
          <pre className="font-mono text-[11px] whitespace-pre-wrap break-all max-h-[140px] overflow-y-auto bg-[color-mix(in_oklch,var(--accent-soft)_60%,transparent)] text-[var(--ink)] px-2 py-1 rounded border-l-2 border-[var(--accent-soft)]">
            <span className="text-[var(--ink-soft)] mr-1">+</span>
            {newText}
          </pre>
        </div>
      )}
    </div>
  )
}

function GenericBody({ payload }: { payload: ApprovalPayload }): JSX.Element {
  return (
    <pre className="px-3 py-2 font-mono text-[11px] text-[var(--ink-soft)] whitespace-pre-wrap break-all max-h-[240px] overflow-y-auto">
      {JSON.stringify(payload, null, 2)}
    </pre>
  )
}

/**
 * Header session switcher (会话 button + dropdown). Touch targets stay
 * ≥44px and the dropdown caps to the viewport so the same control works
 * in the H5 full-screen sheet.
 */
function SessionMenu({
  sessions,
  disabled,
  onSwitch,
  onCreate,
  onDelete
}: {
  sessions: SessionIndex | null
  disabled: boolean
  onSwitch: (id: string) => void
  onCreate: () => void
  onDelete: (id: string) => void
}): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent | TouchEvent): void {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => {
    if (!open) setConfirmingId(null)
  }, [open])

  if (!sessions) return null

  function timeLabel(updatedAt: number): string {
    if (!updatedAt) return ''
    const d = new Date(updatedAt)
    return d.toDateString() === new Date().toDateString()
      ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
  }

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`flex items-center gap-1 px-2 py-1.5 rounded text-xs transition-colors ${
          open
            ? 'bg-[var(--paper-soft)] text-[var(--ink)]'
            : 'text-[var(--ink-faint)] hover:text-[var(--ink)] hover:bg-[var(--paper-soft)]'
        }`}
        title="会话"
      >
        <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
        </svg>
        会话
        <svg viewBox="0 0 24 24" className={`w-2.5 h-2.5 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-72 max-w-[calc(100vw-24px)] rounded-lg border border-[var(--rule)] bg-[var(--paper)] shadow-[0_8px_28px_rgba(0,0,0,0.14),0_2px_6px_rgba(0,0,0,0.08)] text-sm z-50">
          <p className="px-3 pt-2.5 pb-1 text-[10px] uppercase tracking-[0.18em] text-[var(--ink-faint)] select-none">
            sessions
          </p>
          <div className="px-1.5 pb-1 max-h-[50dvh] overflow-y-auto">
            {sessions.sessions.map((m) => {
              const isActive = m.id === sessions.activeId
              if (confirmingId === m.id) {
                return (
                  <div
                    key={m.id}
                    className="min-h-[44px] px-2.5 py-2 rounded-md bg-[var(--accent-soft)]/40 flex items-center gap-2"
                  >
                    <span className="flex-1 text-[12px] text-[var(--ink-soft)] truncate">
                      删除「{m.title || '新会话'}」？
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmingId(null)
                        onDelete(m.id)
                      }}
                      className="text-xs text-[var(--accent)] px-2 py-1.5 shrink-0"
                    >
                      删除
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingId(null)}
                      className="text-xs text-[var(--ink-faint)] px-2 py-1.5 shrink-0"
                    >
                      取消
                    </button>
                  </div>
                )
              }
              return (
                <div
                  key={m.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    if (!isActive && !disabled) onSwitch(m.id)
                    setOpen(false)
                  }}
                  className={`min-h-[44px] px-2.5 py-2 rounded-md flex items-center gap-2 cursor-pointer transition-colors ${
                    isActive ? 'bg-[var(--paper-soft)]' : 'hover:bg-[var(--paper-soft)]'
                  } ${disabled ? 'opacity-50' : ''}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className={`truncate text-[13px] ${isActive ? 'text-[var(--ink)]' : 'text-[var(--ink-soft)]'}`}>
                      {m.title || '新会话'}
                    </div>
                    <div className="text-[11px] text-[var(--ink-faint)]">
                      {timeLabel(m.updatedAt)}
                      {m.turnCount > 0 ? ` · ${m.turnCount} 轮` : ' · 空'}
                    </div>
                  </div>
                  {isActive ? (
                    <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  ) : (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        if (!disabled) setConfirmingId(m.id)
                      }}
                      className="p-2 -m-1 rounded text-[var(--ink-ghost)] hover:text-[var(--accent)] shrink-0"
                      title="删除会话"
                      aria-label="删除会话"
                    >
                      <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 6h18" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          <div className="border-t border-[var(--rule-soft)] px-1.5 py-1">
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                setOpen(false)
                onCreate()
              }}
              className="w-full min-h-[44px] px-2.5 rounded-md flex items-center gap-2 text-[var(--ink-soft)] hover:text-[var(--ink)] hover:bg-[var(--paper-soft)] disabled:opacity-50 transition-colors"
            >
              <svg viewBox="0 0 24 24" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M5 12h14M12 5v14" />
              </svg>
              新建会话
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
