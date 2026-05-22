// Renderer type surface.
//
// Cross-process types live in @quill/shared-types and are re-exported here
// so existing `import { X } from '../types'` call-sites keep working.
// UI-only types that never leave the renderer stay defined inline below.

export type {
  AgentEvent,
  AgentMode,
  AgentRunArgs,
  ApprovalPayload,
  ApprovalResponse,
  AssistantPart,
  CompressionRunArgs,
  FileNode,
  FileStat,
  HistoryMessage,
  MenuCommand,
  Plan,
  PlanApprovalResponse,
  PlanStep,
  RouteDecision,
  Scope,
  ToolCallPart,
  ToolResultOutput,
  ToolResultPart
} from '@quill/shared-types'

// ============================================================
// UI-only — never crosses IPC, lives only inside the renderer
// ============================================================

export type ViewMode = 'edit' | 'split' | 'preview'

export type ThemePref = 'system' | 'light' | 'dark'
export type Theme = 'light' | 'dark'

export type RecentEntry = {
  type: 'folder' | 'file'
  path: string
  name: string
  openedAt: number
}
