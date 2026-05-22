import { contextBridge, ipcRenderer } from 'electron'

export type FileNode = {
  name: string
  path: string
  isDirectory: boolean
  isMarkdown: boolean
  children?: FileNode[]
}

export type FileStat = {
  isFile: boolean
  isDirectory: boolean
  size: number
  mtime: number
}

export type MenuCommand =
  | 'new-file'
  | 'open-file'
  | 'open-folder'
  | 'save'
  | 'close-folder'
  | 'export-pdf'

export type Scope =
  | { kind: 'workspace'; root: string }
  | { kind: 'single-file'; path: string }
  | { kind: 'untitled' }

// Mirror of renderer/types.ts HistoryMessage. Subset of ai-sdk v6
// ModelMessage that the agent runtime accepts for cross-session context.
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
  | { type: 'step-finish'; usage?: unknown }
  | { type: 'finish'; usage?: unknown; finishReason?: string }
  | { type: 'error'; message: string }

const api = {
  platform: process.platform,
  versions: process.versions,
  dialog: {
    openFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFolder'),
    openFile: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFile'),
    saveFile: (
      defaultName?: string,
      filters?: Array<{ name: string; extensions: string[] }>
    ): Promise<string | null> =>
      ipcRenderer.invoke('dialog:saveFile', defaultName, filters),
    confirmOpenChoice: (args: {
      candidateName: string
      currentName: string
      dirty: boolean
    }): Promise<'new' | 'current' | 'cancel'> =>
      ipcRenderer.invoke('dialog:confirmOpenChoice', args)
  },
  app: {
    openInNewWindow: (args: {
      filePath?: string
      folderPath?: string
      newFile?: boolean
    }): Promise<void> => ipcRenderer.invoke('app:openInNewWindow', args),
    openSettings: (): Promise<void> => ipcRenderer.invoke('app:openSettings'),
    version: (): Promise<string> => ipcRenderer.invoke('app:version')
  },
  agent: {
    run: (args: { runId: string } & AgentRunArgs): Promise<void> =>
      ipcRenderer.invoke('agent:run', args),
    cancel: (runId: string): Promise<boolean> => ipcRenderer.invoke('agent:cancel', runId),
    respondApproval: (args: {
      runId: string
      toolCallId: string
      response: ApprovalResponse
    }): Promise<boolean> => ipcRenderer.invoke('agent:approval-respond', args),
    onEvent(cb: (payload: { runId: string; event: AgentEvent }) => void): () => void {
      const handler = (_: unknown, payload: { runId: string; event: AgentEvent }): void =>
        cb(payload)
      ipcRenderer.on('agent:event', handler)
      return () => {
        ipcRenderer.off('agent:event', handler)
      }
    }
  },
  context: {
    load: (
      scope: Scope
    ): Promise<{ version: 1; scope: Scope; items: unknown[]; updatedAt: number } | null> =>
      ipcRenderer.invoke('context:load', scope),
    save: (args: { scope: Scope; items: unknown[] }): Promise<void> =>
      ipcRenderer.invoke('context:save', args),
    clear: (scope: Scope): Promise<void> => ipcRenderer.invoke('context:clear', scope)
  },
  providers: {
    list: (): Promise<Array<{ id: string; model: string; addedAt: number; updatedAt: number }>> =>
      ipcRenderer.invoke('providers:list'),
    upsert: (args: { id: string; key: string; model: string }): Promise<void> =>
      ipcRenderer.invoke('providers:upsert', args),
    updateModel: (args: { id: string; model: string }): Promise<void> =>
      ipcRenderer.invoke('providers:updateModel', args),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('providers:remove', id),
    test: (baseURL: string): Promise<{ ok: boolean; status?: number; error?: string }> =>
      ipcRenderer.invoke('providers:test', baseURL),
    getDefault: (): Promise<string | null> => ipcRenderer.invoke('providers:getDefault'),
    setDefault: (id: string | null): Promise<void> =>
      ipcRenderer.invoke('providers:setDefault', id)
  },
  fs: {
    readFile: (path: string): Promise<string> => ipcRenderer.invoke('fs:readFile', path),
    writeFile: (path: string, content: string): Promise<void> =>
      ipcRenderer.invoke('fs:writeFile', path, content),
    rename: (oldPath: string, newPath: string): Promise<void> =>
      ipcRenderer.invoke('fs:rename', oldPath, newPath),
    listDir: (path: string): Promise<FileNode[]> => ipcRenderer.invoke('fs:listDir', path),
    stat: (path: string): Promise<FileStat> => ipcRenderer.invoke('fs:stat', path)
  },
  exportPdf: (args: { html: string; defaultName: string }): Promise<string | null> =>
    ipcRenderer.invoke('export:pdf', args),
  shell: {
    reveal: (path: string): Promise<void> => ipcRenderer.invoke('shell:reveal', path)
  },
  events: {
    onOpenFile(cb: (path: string) => void): () => void {
      const handler = (_: unknown, p: string): void => cb(p)
      ipcRenderer.on('quill:open-file', handler)
      return () => {
        ipcRenderer.off('quill:open-file', handler)
      }
    },
    onOpenFolder(cb: (path: string) => void): () => void {
      const handler = (_: unknown, p: string): void => cb(p)
      ipcRenderer.on('quill:open-folder', handler)
      return () => {
        ipcRenderer.off('quill:open-folder', handler)
      }
    },
    onMenuCommand(cb: (cmd: MenuCommand) => void): () => void {
      const handler = (_: unknown, cmd: MenuCommand): void => cb(cmd)
      ipcRenderer.on('quill:menu', handler)
      return () => {
        ipcRenderer.off('quill:menu', handler)
      }
    }
  }
} as const

export type QuillApi = typeof api

contextBridge.exposeInMainWorld('quill', api)
