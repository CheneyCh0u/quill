import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentEvent,
  AgentProviderInfo,
  ApprovalPayload,
  Scope
} from '@quill/shared-types'
import { AgentClient } from '../lib/agent-client'
import { renderMarkdown } from '../lib/markdown'

type Turn = {
  runId: string
  prompt: string
  text: string
  toolCalls: { toolCallId: string; name: string; args: unknown }[]
  // Approvals waiting on user input, keyed by toolCallId.
  pendingApprovals: Map<string, ApprovalPayload>
  status: 'running' | 'done' | { error: string }
}

type Props = {
  /** Vault root + current selection — gives the agent file-system context. */
  scope: Scope
  /** Snapshot of the user's open buffer; injected into the system prompt. */
  currentBuffer?: string
  /** Currently highlighted selection inside the open buffer. */
  currentSelection?: string
  onClose: () => void
}

function newId(): string {
  return Math.random().toString(36).slice(2, 11)
}

export function AgentPanel({
  scope,
  currentBuffer,
  currentSelection,
  onClose
}: Props): JSX.Element {
  const client = useMemo(() => new AgentClient(), [])
  const [providers, setProviders] = useState<AgentProviderInfo[] | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  // Single-turn view for v0. Multi-turn / persisted history is a follow-up.
  const [turn, setTurn] = useState<Turn | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    client
      .fetchProviders()
      .then((p) => {
        if (cancelled) return
        setProviders(p.filter((x) => x.models.length > 0))
      })
      .catch((err) => {
        if (cancelled) return
        setLoadErr(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
      client.close()
    }
  }, [client])

  // Auto-scroll the conversation to the latest output as it streams in.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [turn?.text, turn?.toolCalls.length, turn?.pendingApprovals.size])

  function handleEvent(runId: string, event: AgentEvent): void {
    setTurn((prev) => {
      if (!prev || prev.runId !== runId) return prev
      const next: Turn = { ...prev, pendingApprovals: new Map(prev.pendingApprovals) }
      switch (event.type) {
        case 'text-delta':
          next.text = next.text + event.delta
          return next
        case 'tool-call':
          next.toolCalls = [
            ...next.toolCalls,
            { toolCallId: event.toolCallId, name: event.name, args: event.args }
          ]
          return next
        case 'tool-approval-request':
          next.pendingApprovals.set(event.toolCallId, event.payload)
          return next
        case 'tool-result':
          // No-op for v0; we already showed the tool call. The Build phase
          // continues automatically.
          return next
        case 'finish':
          next.status = 'done'
          return next
        case 'error':
          next.status = { error: event.message }
          return next
        default:
          return next
      }
    })
  }

  async function send(): Promise<void> {
    const text = prompt.trim()
    if (!text) return
    if (!providers || providers.length === 0) return
    const provider = providers[0]
    const modelId = provider.models[0]
    const runId = newId()
    const newTurn: Turn = {
      runId,
      prompt: text,
      text: '',
      toolCalls: [],
      pendingApprovals: new Map(),
      status: 'running'
    }
    setTurn(newTurn)
    setPrompt('')
    try {
      await client.run(
        runId,
        {
          providerId: provider.id,
          modelId,
          prompt: text,
          scope,
          mode: 'build', // skip Plan/Router for v0 simplicity
          currentBuffer,
          currentSelection
        },
        (event) => handleEvent(runId, event)
      )
    } catch (err) {
      setTurn((prev) =>
        prev && prev.runId === runId
          ? { ...prev, status: { error: err instanceof Error ? err.message : String(err) } }
          : prev
      )
    }
  }

  async function cancel(): Promise<void> {
    if (!turn || turn.status !== 'running') return
    await client.cancel(turn.runId)
  }

  async function respond(toolCallId: string, approved: boolean): Promise<void> {
    if (!turn) return
    await client.approve(turn.runId, toolCallId, {
      approved,
      reason: approved ? undefined : 'user denied'
    })
    setTurn((prev) => {
      if (!prev) return prev
      const next = { ...prev, pendingApprovals: new Map(prev.pendingApprovals) }
      next.pendingApprovals.delete(toolCallId)
      return next
    })
  }

  if (loadErr) {
    return (
      <PanelShell onClose={onClose} title="AI">
        <div className="p-4 text-sm text-[--accent]">{loadErr}</div>
      </PanelShell>
    )
  }
  if (providers === null) {
    return (
      <PanelShell onClose={onClose} title="AI">
        <div className="p-4 text-sm text-[--ink-faint]">加载中…</div>
      </PanelShell>
    )
  }
  if (providers.length === 0) {
    return (
      <PanelShell onClose={onClose} title="AI">
        <div className="p-4 text-sm text-[--ink-soft]">
          未配置 AI provider。请在 server 的 <code>config.yaml</code> 加上
          <code> ai.providers</code> 并填入 API key 后重启 server。
        </div>
      </PanelShell>
    )
  }

  const provider = providers[0]
  const model = provider.models[0]

  return (
    <PanelShell onClose={onClose} title={`AI · ${provider.id}/${model}`}>
      <div className="flex-1 overflow-y-auto scroll-thin px-4 py-3">
        {!turn && (
          <p className="text-sm text-[--ink-faint]">
            问点什么吧——agent 能读 vault 里的文件、写文件，写操作会先征求你的同意。
          </p>
        )}
        {turn && (
          <div className="space-y-3">
            <div className="text-sm text-[--ink]">
              <span className="text-[--ink-faint]">› </span>
              {turn.prompt}
            </div>
            {turn.toolCalls.map((tc) => (
              <div
                key={tc.toolCallId}
                className="text-xs font-mono bg-[--paper-soft] border border-[--rule-soft] rounded px-2 py-1 text-[--ink-soft]"
              >
                <span className="text-[--accent]">{tc.name}</span>(
                <span className="text-[--ink-faint]">{summarizeArgs(tc.args)}</span>)
              </div>
            ))}
            {[...turn.pendingApprovals.entries()].map(([id, payload]) => (
              <div
                key={id}
                className="bg-[--accent-soft] border border-[--accent] rounded p-3 text-sm"
              >
                <div className="text-[--ink] font-medium mb-1">需要确认</div>
                <pre className="text-xs font-mono text-[--ink-soft] whitespace-pre-wrap break-all mb-2">
                  {JSON.stringify(payload, null, 2)}
                </pre>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void respond(id, true)}
                    className="bg-[--ink] text-[--paper] text-xs rounded px-3 py-1 hover:opacity-90"
                  >
                    同意
                  </button>
                  <button
                    type="button"
                    onClick={() => void respond(id, false)}
                    className="bg-[--paper-dim] text-[--ink-soft] text-xs rounded px-3 py-1 hover:bg-[--paper-soft]"
                  >
                    拒绝
                  </button>
                </div>
              </div>
            ))}
            {turn.text && (
              <article
                className="prose-paper text-sm"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(turn.text) }}
              />
            )}
            {turn.status === 'running' && (
              <div className="text-xs text-[--ink-faint]">思考中…</div>
            )}
            {typeof turn.status === 'object' && (
              <div className="text-xs text-[--accent]">错误：{turn.status.error}</div>
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </div>
      <footer className="border-t border-[--rule-soft] p-3 flex flex-col gap-2">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void send()
            }
          }}
          placeholder="问点什么…（⌘↵ 发送）"
          rows={3}
          className="bg-[--paper-dim] border border-[--rule] rounded p-2 text-sm outline-none focus:border-[--accent] resize-none"
        />
        <div className="flex items-center gap-2 justify-end">
          {turn?.status === 'running' && (
            <button
              type="button"
              onClick={() => void cancel()}
              className="text-xs text-[--ink-faint] hover:text-[--accent] px-2 py-1"
            >
              取消
            </button>
          )}
          <button
            type="button"
            onClick={() => void send()}
            disabled={!prompt.trim() || turn?.status === 'running'}
            className="bg-[--ink] text-[--paper] text-sm rounded px-3 py-1 disabled:opacity-40"
          >
            发送
          </button>
        </div>
      </footer>
    </PanelShell>
  )
}

function PanelShell({
  title,
  onClose,
  children
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="h-full flex flex-col bg-[--paper] border-l border-[--rule]">
      <header className="h-12 flex items-center justify-between px-3 border-b border-[--rule-soft]">
        <span className="text-sm text-[--ink-soft]">{title}</span>
        <button
          type="button"
          onClick={onClose}
          className="text-[--ink-faint] hover:text-[--ink] text-sm px-2"
          aria-label="关闭 AI 面板"
        >
          ✕
        </button>
      </header>
      {children}
    </div>
  )
}

function summarizeArgs(args: unknown): string {
  if (typeof args !== 'object' || args === null) return String(args)
  const obj = args as Record<string, unknown>
  // Prefer common keys that name the target of the call.
  for (const key of ['path', 'query', 'url']) {
    if (typeof obj[key] === 'string') return `${key}=${obj[key]}`
  }
  return JSON.stringify(obj).slice(0, 80)
}
