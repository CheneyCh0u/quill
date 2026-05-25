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

// Renderer-local aliases for the cross-package theme types. `Theme` is
// kept as a synonym for `ThemeMode` because dozens of call-sites already
// use `Theme` to mean "light or dark" — renaming would be churn.
export type { ThemeMode, ThemePref, ThemeTokens, ThemeDef, BuiltinThemeId } from '@quill/shared-types'
import type { ThemeMode } from '@quill/shared-types'
export type Theme = ThemeMode

export type RecentEntry = {
  type: 'folder' | 'file'
  path: string
  name: string
  openedAt: number
}
