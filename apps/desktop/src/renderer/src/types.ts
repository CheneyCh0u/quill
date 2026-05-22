// Mirror of types exported from src/preload/index.ts. Keep in sync.

export type FileNode = {
  name: string
  path: string
  isDirectory: boolean
  isMarkdown: boolean
  children?: FileNode[]
}

export type MenuCommand =
  | 'new-file'
  | 'open-file'
  | 'open-folder'
  | 'save'
  | 'close-folder'
  | 'export-pdf'

export type ViewMode = 'edit' | 'split' | 'preview'

export type ThemePref = 'system' | 'light' | 'dark'
export type Theme = 'light' | 'dark'

export type RecentEntry = {
  type: 'folder' | 'file'
  path: string
  name: string
  openedAt: number
}

export type Scope =
  | { kind: 'workspace'; root: string }
  | { kind: 'single-file'; path: string }
  | { kind: 'untitled' }

// Subset of ai-sdk v6's ModelMessage we serialize across IPC. Mirror only —
// the canonical shape lives in renderer/lib/itemsToMessages.ts (Message type)
// and the runtime layer in main accepts it structurally.
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

export type AgentRunArgs = {
  providerId: string
  modelId: string
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

export type AgentMode = 'auto' | 'plan' | 'build'

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
  | { type: 'step-finish'; usage?: unknown }
  | { type: 'finish'; usage?: unknown; finishReason?: string }
  | { type: 'error'; message: string }
