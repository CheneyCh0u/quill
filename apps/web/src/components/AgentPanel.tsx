import { useEffect, useRef, useState } from 'react'
import type { ApprovalPayload, Scope } from '@quill/shared-types'
import { renderMarkdown } from '../lib/markdown'
import type { AgentSession, AgentTurn, SelectedModel } from '../lib/use-agent-session'
import type { AgentConnectionStatus } from '../lib/agent-client'
import { formatContextWindow, formatTokens } from '../lib/usage'

type Props = {
  /** Owned by Vault via useAgentSession so panel mount/unmount doesn't
   *  blow away the conversation. */
  session: AgentSession
  scope: Scope
  currentBuffer?: string
  currentSelection?: string
  onClose: () => void
}

export function AgentPanel({
  session,
  scope,
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
    reset
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
    await send({ text, scope, currentBuffer, currentSelection })
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
          未配置 AI provider。点击右上角 ⚙ 进入设置，配上一个 provider 即可使用。
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
      onReset={turns.length > 0 ? reset : undefined}
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
      {turn.toolCalls.map((tc) => (
        <div
          key={tc.toolCallId}
          className="text-xs font-mono bg-[var(--paper-soft)] border border-[var(--rule-soft)] rounded px-2 py-1 text-[var(--ink-soft)]"
        >
          <span className="text-[var(--accent)]">{tc.name}</span>(
          <span className="text-[var(--ink-faint)]">{summarizeArgs(tc.args)}</span>)
        </div>
      ))}
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
  onReset,
  children
}: {
  /** Custom header content (model picker + token budget). Falls back to
   *  a plain "AI" label when omitted (for the loading / empty states). */
  header?: React.ReactNode
  status: AgentConnectionStatus
  onClose: () => void
  /** When present, show a 清空 button — lets the user drop a stale
   *  conversation without closing the whole panel. */
  onReset?: () => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="w-full h-full flex flex-col bg-[var(--paper)] md:border-l md:border-[var(--rule)]">
      <header className="h-12 flex items-center gap-2 px-3 border-b border-[var(--rule-soft)]">
        <ConnectionDot status={status} />
        <div className="flex-1 flex items-center gap-2 min-w-0">
          {header ?? <span className="text-sm text-[var(--ink-soft)]">AI</span>}
        </div>
        {onReset && (
          <button
            type="button"
            onClick={onReset}
            className="text-xs text-[var(--ink-faint)] hover:text-[var(--ink)] hover:bg-[var(--paper-soft)] rounded px-2 py-1"
            title="清空当前对话"
          >
            清空
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="text-[var(--ink-faint)] hover:text-[var(--ink)] text-sm px-2"
          aria-label="关闭 AI 面板"
        >
          ✕
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
