import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentEvent,
  AgentRunArgs,
  ApprovalResponse,
  CompressionRunArgs,
  FileNode,
  FileStat,
  MenuCommand,
  PlanApprovalResponse,
  Scope,
  SyncSnapshot,
  Workspace
} from '@quill/shared-types'

// Re-export the shared types so existing consumers (`import type { ... }
// from '<preload-path>'`) keep working without a churn-rename pass.
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
    compress: (args: { runId: string } & CompressionRunArgs): Promise<void> =>
      ipcRenderer.invoke('agent:compress', args),
    respondApproval: (args: {
      runId: string
      toolCallId: string
      response: ApprovalResponse
    }): Promise<boolean> => ipcRenderer.invoke('agent:approval-respond', args),
    respondPlanApproval: (args: {
      runId: string
      response: PlanApprovalResponse
    }): Promise<boolean> => ipcRenderer.invoke('agent:plan-approval-respond', args),
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
    stat: (path: string): Promise<FileStat> => ipcRenderer.invoke('fs:stat', path),
    mkdir: (path: string): Promise<void> => ipcRenderer.invoke('fs:mkdir', path),
    delete: (path: string): Promise<void> => ipcRenderer.invoke('fs:delete', path),
    deleteDir: (path: string, recursive: boolean): Promise<void> =>
      ipcRenderer.invoke('fs:deleteDir', path, recursive)
  },
  themes: {
    list: (): Promise<Array<{ filename: string; raw: unknown }>> =>
      ipcRenderer.invoke('themes:list'),
    importDialog: (): Promise<string | null> => ipcRenderer.invoke('themes:importDialog'),
    exportDialog: (args: {
      suggestedFilename: string
      content: string
    }): Promise<string | null> => ipcRenderer.invoke('themes:exportDialog', args),
    revealFolder: (): Promise<string> => ipcRenderer.invoke('themes:revealFolder')
  },
  sync: {
    status: (root: string): Promise<SyncSnapshot> => ipcRenderer.invoke('sync:status', root),
    enable: (args: { root: string; name: string; remotePath: string }): Promise<SyncSnapshot> =>
      ipcRenderer.invoke('sync:enable', args),
    bind: (args: { root: string; space: Workspace }): Promise<SyncSnapshot> =>
      ipcRenderer.invoke('sync:bind', args),
    push: (root: string): Promise<SyncSnapshot> => ipcRenderer.invoke('sync:push', root),
    pull: (root: string): Promise<SyncSnapshot> => ipcRenderer.invoke('sync:pull', root),
    resolve: (args: {
      root: string
      path: string
      keep: 'local' | 'remote'
    }): Promise<SyncSnapshot> => ipcRenderer.invoke('sync:resolve', args),
    disable: (args: { root: string; removeSpace: boolean }): Promise<void> =>
      ipcRenderer.invoke('sync:disable', args),
    spaces: (): Promise<Workspace[]> => ipcRenderer.invoke('sync:spaces'),
    removeSpace: (id: string): Promise<void> => ipcRenderer.invoke('sync:removeSpace', id)
  },
  remote: {
    getUrl: (): Promise<string | null> => ipcRenderer.invoke('remote:getUrl'),
    setUrl: (url: string | null): Promise<void> =>
      ipcRenderer.invoke('remote:setUrl', url),
    getToken: (): Promise<string | null> => ipcRenderer.invoke('remote:getToken'),
    setToken: (token: string | null): Promise<void> =>
      ipcRenderer.invoke('remote:setToken', token),
    clear: (): Promise<void> => ipcRenderer.invoke('remote:clear')
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
