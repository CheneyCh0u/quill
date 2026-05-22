import type {
  AgentEvent,
  AgentRunArgs,
  ApprovalResponse,
  FileNode,
  MenuCommand,
  PlanApprovalResponse,
  Scope
} from '../types'

export const ipc = {
  openFolderDialog: (): Promise<string | null> => window.quill.dialog.openFolder(),
  openFileDialog: (): Promise<string | null> => window.quill.dialog.openFile(),
  saveFileDialog: (
    defaultName?: string,
    filters?: Array<{ name: string; extensions: string[] }>
  ): Promise<string | null> => window.quill.dialog.saveFile(defaultName, filters),
  confirmOpenChoice: (args: {
    candidateName: string
    currentName: string
    dirty: boolean
  }): Promise<'new' | 'current' | 'cancel'> =>
    window.quill.dialog.confirmOpenChoice(args),
  openInNewWindow: (args: {
    filePath?: string
    folderPath?: string
    newFile?: boolean
  }): Promise<void> => window.quill.app.openInNewWindow(args),
  openSettingsWindow: (): Promise<void> => window.quill.app.openSettings(),
  getAppVersion: (): Promise<string> => window.quill.app.version(),
  readFile: (path: string): Promise<string> => window.quill.fs.readFile(path),
  writeFile: (path: string, content: string): Promise<void> =>
    window.quill.fs.writeFile(path, content),
  renameFile: (oldPath: string, newPath: string): Promise<void> =>
    window.quill.fs.rename(oldPath, newPath),
  listDir: (path: string): Promise<FileNode[]> => window.quill.fs.listDir(path),
  onOpenFile: (cb: (path: string) => void): (() => void) =>
    window.quill.events.onOpenFile(cb),
  onOpenFolder: (cb: (path: string) => void): (() => void) =>
    window.quill.events.onOpenFolder(cb),
  onMenu: (cb: (cmd: MenuCommand) => void): (() => void) =>
    window.quill.events.onMenuCommand(cb),
  exportPdf: (args: { html: string; defaultName: string }): Promise<string | null> =>
    window.quill.exportPdf(args),
  revealInFolder: (path: string): Promise<void> => window.quill.shell.reveal(path),
  agent: {
    run: (args: { runId: string } & AgentRunArgs): Promise<void> =>
      window.quill.agent.run(args),
    cancel: (runId: string): Promise<boolean> => window.quill.agent.cancel(runId),
    respondApproval: (args: {
      runId: string
      toolCallId: string
      response: ApprovalResponse
    }): Promise<boolean> => window.quill.agent.respondApproval(args),
    respondPlanApproval: (args: {
      runId: string
      response: PlanApprovalResponse
    }): Promise<boolean> => window.quill.agent.respondPlanApproval(args),
    onEvent: (cb: (payload: { runId: string; event: AgentEvent }) => void) =>
      window.quill.agent.onEvent(cb)
  },
  context: {
    load: (scope: Scope) => window.quill.context.load(scope),
    save: (args: { scope: Scope; items: unknown[] }) => window.quill.context.save(args),
    clear: (scope: Scope) => window.quill.context.clear(scope)
  },
  providers: {
    list: () => window.quill.providers.list(),
    upsert: (args: { id: string; key: string; model: string }) =>
      window.quill.providers.upsert(args),
    updateModel: (args: { id: string; model: string }) =>
      window.quill.providers.updateModel(args),
    remove: (id: string) => window.quill.providers.remove(id),
    test: (baseURL: string) => window.quill.providers.test(baseURL),
    getDefault: () => window.quill.providers.getDefault(),
    setDefault: (id: string | null) => window.quill.providers.setDefault(id)
  }
}
