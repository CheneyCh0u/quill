import { LocalProvider, RemoteVault, type VaultProvider } from '@quill/vault-adapter'
import type {
  AgentEvent,
  AgentRunArgs,
  ApprovalResponse,
  CompressionRunArgs,
  MenuCommand,
  PlanApprovalResponse,
  Scope
} from '../types'

/**
 * Active vault provider. Defaults to local (LocalProvider wrapping
 * window.quill.fs). When the user connects to a remote server via the
 * Settings panel, switchToRemote() swaps in a RemoteVault configured
 * with a Bearer-token auth header.
 *
 * Lazy-constructed via a getter so module load doesn't touch `window` —
 * keeps the module importable from bun:test where DOM globals are absent.
 */
let _vault: VaultProvider | undefined
const subscribers = new Set<() => void>()

function notify(): void {
  for (const cb of subscribers) cb()
}

export type RemoteMode = { url: string; getToken: () => Promise<string | null> }

/** Subscribe to vault changes — React components can call this from a
 *  useEffect and re-render when remote/local toggles. Returns an
 *  unsubscribe function. */
export function subscribeVault(cb: () => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

export function switchToRemote(mode: RemoteMode): void {
  _vault = new RemoteVault({
    baseUrl: mode.url,
    getAuthHeaders: async (): Promise<Record<string, string>> => {
      const token = await mode.getToken()
      return token ? { Authorization: `Bearer ${token}` } : {}
    }
  })
  notify()
}

export function switchToLocal(): void {
  _vault = new LocalProvider(window.quill.fs)
  notify()
}

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
  get vault(): VaultProvider {
    if (!_vault) _vault = new LocalProvider(window.quill.fs)
    return _vault
  },
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
    compress: (args: { runId: string } & CompressionRunArgs): Promise<void> =>
      window.quill.agent.compress(args),
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
  },
  remote: {
    getUrl: (): Promise<string | null> => window.quill.remote.getUrl(),
    setUrl: (url: string | null): Promise<void> => window.quill.remote.setUrl(url),
    getToken: (): Promise<string | null> => window.quill.remote.getToken(),
    setToken: (token: string | null): Promise<void> =>
      window.quill.remote.setToken(token),
    clear: (): Promise<void> => window.quill.remote.clear()
  },
  themes: {
    list: (): Promise<Array<{ filename: string; raw: unknown }>> =>
      window.quill.themes.list(),
    importDialog: (): Promise<string | null> => window.quill.themes.importDialog(),
    exportDialog: (args: {
      suggestedFilename: string
      content: string
    }): Promise<string | null> => window.quill.themes.exportDialog(args),
    revealFolder: (): Promise<string> => window.quill.themes.revealFolder()
  }
}
