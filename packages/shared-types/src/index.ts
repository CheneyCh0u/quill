// Cross-process / cross-app shared types for Quill.
// Consumers: apps/desktop (main, preload, renderer), apps/server, apps/web,
// packages/{agent, vault-adapter, core}.
//
// What belongs here: data shapes that travel across process / network /
// package boundaries (IPC payloads, REST/WS messages, persisted records),
// plus dependency-free constants/helpers shared across processes (e.g.
// file-type recognition). Keep this package dependency-free.
// What does NOT belong: UI-only concerns (view mode, theme preference,
// recent-entry list), runtime API surfaces (window.quill), framework types.

export {
  getFileType,
  isSupportedTextFile,
  allTextExtensions
} from './fileTypes'
export type { FileLanguage, FileTypeInfo } from './fileTypes'

export {
  BUILTIN_THEME_IDS,
  BUILTIN_THEME_NAMES,
  DEFAULT_THEME_ID,
  isBuiltinThemeId
} from './themes'
export type { ThemeDef, ThemeMode, ThemePref, ThemeTokens, BuiltinThemeId } from './themes'

export type {
  SyncStatus,
  SyncEntry,
  Workspace,
  SyncBinding,
  SyncSnapshot
} from './sync'

// ============================================================
// File system
// ============================================================

export type FileNode = {
  name: string
  path: string
  isDirectory: boolean
  isMarkdown: boolean
  /** True when the file is a supported text format (includes markdown, code
   *  files, and plain-text formats). Renderer uses this to decide whether
   *  the entry is clickable in the file tree. */
  isText: boolean
  children?: FileNode[]
}

export type FileStat = {
  isFile: boolean
  isDirectory: boolean
  size: number
  mtime: number
}

// ============================================================
// App scopes / menu
// ============================================================

export type Scope =
  | { kind: 'workspace'; root: string }
  | { kind: 'single-file'; path: string }
  | { kind: 'untitled' }

export type MenuCommand =
  | 'new-file'
  | 'open-file'
  | 'open-folder'
  | 'save'
  | 'close-folder'
  | 'export-pdf'

// ============================================================
// Agent — message history (subset of ai-sdk v6 ModelMessage)
// ============================================================

export type ToolCallPart = {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  input: unknown
}

export type ToolResultOutput =
  | { type: 'json'; value: unknown }
  | { type: 'error-json'; value: unknown }
  | { type: 'execution-denied'; reason?: string }

export type ToolResultPart = {
  type: 'tool-result'
  toolCallId: string
  toolName: string
  output: ToolResultOutput
}

export type AssistantPart = { type: 'text'; text: string } | ToolCallPart

export type HistoryMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | AssistantPart[] }
  | { role: 'tool'; content: ToolResultPart[] }

// ============================================================
// Agent — runtime args + events
// ============================================================

export type AgentMode = 'auto' | 'plan' | 'build'

export type AgentRunArgs = {
  providerId: string
  modelId: string
  /** Optional per-phase model overrides. When omitted, the phase uses
   *  the top-level providerId/modelId. */
  planProviderId?: string
  planModelId?: string
  buildProviderId?: string
  buildModelId?: string
  prompt: string
  scope: Scope
  mode?: AgentMode
  history?: HistoryMessage[]
  currentBuffer?: string
  currentSelection?: string
}

export type ApprovalPayload = Record<string, unknown>
export type ApprovalResponse = { approved: boolean; reason?: string }
export type PlanApprovalResponse =
  | { approved: true; plan: Plan }
  | { approved: false }

export type RouteDecision = { agent: 'plan' | 'build'; reason: string }

export type PlanStep = {
  id: string
  title: string
  why?: string
  files?: string[]
}

export type Plan = { steps: PlanStep[] }

export type AgentEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-call'; toolCallId: string; name: string; args: unknown }
  | { type: 'tool-result'; toolCallId: string; name: string; result: unknown }
  | { type: 'tool-approval-request'; toolCallId: string; payload: ApprovalPayload }
  | { type: 'route-decision'; decision: RouteDecision }
  | { type: 'phase-start'; phase: 'plan' | 'build' }
  | { type: 'plan-delta'; partial: Partial<Plan> }
  | { type: 'plan-complete'; plan: Plan }
  | { type: 'plan-usage'; usage: unknown }
  | { type: 'plan-approval-request'; plan: Plan }
  | { type: 'compression-start' }
  | { type: 'compression-complete'; summary: string; originalCount: number }
  | { type: 'compression-error'; message: string }
  | { type: 'step-finish'; usage?: unknown }
  | { type: 'finish'; usage?: unknown; finishReason?: string }
  | { type: 'error'; message: string }

export type CompressionRunArgs = {
  providerId: string
  modelId: string
  messages: HistoryMessage[]
  originalCount: number
  lastInputTokens?: number
  contextTokens?: number
}

// ============================================================
// Agent WebSocket protocol
//
// Used by apps/server (/api/agent endpoint) and apps/web (AgentClient).
// One WebSocket connection per browser session; multiple concurrent runs
// are multiplexed by `runId`. Server messages always echo the run id so
// the client can dispatch events to the right local handler.
// ============================================================

// Agent conversation sessions — one scope holds many isolated sessions.
// Persisted by the desktop context store / web localStorage; metas cross
// IPC so they live here.
export type SessionMeta = {
  id: string
  /** First user prompt, truncated by the UI. Empty = untouched session. */
  title: string
  updatedAt: number
  turnCount: number
}

export type SessionIndex = {
  version: 1
  activeId: string
  sessions: SessionMeta[]
}

export type ClientAgentMessage =
  | {
      type: 'run'
      runId: string
      args: AgentRunArgs
      /** Cloud workspace the run is scoped to. The server resolves it to
       *  vault/<workspace dir> and overrides args.scope.root; omitted →
       *  the default workspace. Unknown ids are rejected. */
      workspaceId?: string
    }
  | { type: 'cancel'; runId: string }
  | {
      type: 'approval'
      runId: string
      toolCallId: string
      response: ApprovalResponse
    }
  | { type: 'plan-approval'; runId: string; response: PlanApprovalResponse }
  | { type: 'compress'; runId: string; args: CompressionRunArgs }

export type ServerAgentMessage = { type: 'event'; runId: string; event: AgentEvent }

// ============================================================
// Agent provider metadata
//
// Returned by GET /api/agent/providers so the web UI can build a model
// picker without ever seeing api_keys. Server side reads ai.providers
// in config.yaml and strips secrets before responding.
// ============================================================

export type AgentProviderInfo = {
  id: string
  models: string[]
}
