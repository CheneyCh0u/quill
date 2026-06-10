import { app, ipcMain, dialog, shell, BrowserWindow } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createWindow, openSettingsWindow, type InitialAction } from './windows'
import {
  listProviders,
  upsertProvider,
  updateProviderModel,
  removeProvider,
  testProvider,
  getDefaultProvider,
  setDefaultProvider,
  getProviderKey
} from './providers'
import {
  getRemoteUrl,
  setRemoteUrl,
  getRemoteToken,
  setRemoteToken,
  clearRemote
} from './remote-store'
import {
  checkStatus,
  enableSync,
  bindSpace,
  pushAll,
  pullAll,
  resolveConflict,
  disableSync,
  listSpaces,
  removeSpace,
  type RemoteConfig
} from './sync/engine'
import { readSyncFile } from './sync/bind-store'
import { AgentRuntime, createContextStore, type CredentialProvider } from '@quill/agent'
import {
  getFileType,
  allTextExtensions,
  type AgentEvent,
  type AgentRunArgs,
  type ApprovalResponse,
  type CompressionRunArgs,
  type FileNode,
  type PlanApprovalResponse,
  type Scope
} from '@quill/shared-types'

const CONTEXTS_DIR = join(homedir(), '.quill', 'contexts')
const contextStore = createContextStore(CONTEXTS_DIR)
const THEMES_DIR = join(homedir(), '.quill', 'themes')

async function ensureThemesDir(): Promise<string> {
  await fs.mkdir(THEMES_DIR, { recursive: true })
  return THEMES_DIR
}

// Desktop credential strategy: read from the electron safeStorage-backed
// keychain. Server will inject a config.yaml-backed implementation instead.
const credentials: CredentialProvider = {
  getKey: (providerId) => getProviderKey(providerId)
}
const agent = new AgentRuntime({ credentials })

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '__pycache__',
  'dist',
  'build',
  'target',
  '.next',
  '.cache',
  'out',
  'release'
])

async function scanDir(path: string): Promise<FileNode[]> {
  const entries = await fs.readdir(path, { withFileTypes: true })
  const nodes: FileNode[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue
    const childPath = join(path, entry.name)
    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: childPath,
        isDirectory: true,
        isMarkdown: false,
        isText: false,
        children: await scanDir(childPath)
      })
    } else if (entry.isFile()) {
      const info = getFileType(entry.name)
      nodes.push({
        name: entry.name,
        path: childPath,
        isDirectory: false,
        isMarkdown: info.isMarkdown,
        isText: info.isText
      })
    }
  }
  nodes.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return nodes
}

export function registerIpc(): void {
  ipcMain.handle('dialog:openFolder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('dialog:openFile', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd'] },
        { name: 'Text Files', extensions: allTextExtensions() },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle(
    'dialog:saveFile',
    async (
      _evt,
      defaultName?: string,
      filters?: Array<{ name: string; extensions: string[] }>
    ) => {
      const result = await dialog.showSaveDialog({
        defaultPath: defaultName ?? 'untitled.md',
        filters: filters ?? [
          { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd'] },
          { name: 'Text Files', extensions: allTextExtensions() },
          { name: 'All Files', extensions: ['*'] }
        ]
      })
      return result.canceled || !result.filePath ? null : result.filePath
    }
  )

  ipcMain.handle('shell:reveal', async (_evt, path: string) => {
    // Open Finder/Explorer and highlight the file. No-op silently if the
    // path no longer exists — Electron's showItemInFolder doesn't return,
    // so just call it.
    shell.showItemInFolder(path)
  })

  ipcMain.handle('fs:readFile', async (_evt, path: string) => {
    return await fs.readFile(path, 'utf-8')
  })

  ipcMain.handle('fs:writeFile', async (_evt, path: string, content: string) => {
    await fs.writeFile(path, content, 'utf-8')
  })

  ipcMain.handle('fs:rename', async (_evt, oldPath: string, newPath: string) => {
    if (oldPath === newPath) return
    // Reject if target already exists — fs.rename silently overwrites on POSIX.
    const exists = await fs
      .stat(newPath)
      .then(() => true)
      .catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return false
        throw err
      })
    if (exists) throw new Error('TARGET_EXISTS')
    await fs.rename(oldPath, newPath)
  })

  ipcMain.handle('fs:listDir', async (_evt, rootPath: string) => {
    return await scanDir(rootPath)
  })

  ipcMain.handle('fs:mkdir', async (_evt, path: string) => {
    // Refuse if anything already exists at the target — the tree UI surfaces
    // this as a friendly "name already used" instead of silently no-op'ing.
    const exists = await fs
      .stat(path)
      .then(() => true)
      .catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return false
        throw err
      })
    if (exists) throw new Error('TARGET_EXISTS')
    await fs.mkdir(path)
  })

  ipcMain.handle('fs:delete', async (_evt, path: string) => {
    await fs.unlink(path)
  })

  ipcMain.handle('fs:deleteDir', async (_evt, path: string, recursive: boolean) => {
    await fs.rm(path, { recursive, force: false })
  })

  ipcMain.handle('fs:stat', async (_evt, path: string) => {
    const s = await fs.stat(path)
    return {
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      size: s.size,
      mtime: s.mtimeMs
    }
  })

  ipcMain.handle(
    'app:openInNewWindow',
    async (
      _evt,
      args: { filePath?: string; folderPath?: string; newFile?: boolean }
    ) => {
      let initial: InitialAction | undefined
      if (args.filePath) initial = { type: 'open-file', path: args.filePath }
      else if (args.folderPath) initial = { type: 'open-folder', path: args.folderPath }
      else if (args.newFile) initial = { type: 'new-file' }
      createWindow({ initial })
    }
  )

  ipcMain.handle('app:openSettings', async () => {
    openSettingsWindow()
  })

  ipcMain.handle('app:version', async () => app.getVersion())

  // -------- Provider config (key storage + reachability test) ---------
  ipcMain.handle('providers:list', async () => listProviders())
  ipcMain.handle(
    'providers:upsert',
    async (_evt, args: { id: string; key: string; model: string }) =>
      upsertProvider(args.id, args.key, args.model)
  )
  ipcMain.handle(
    'providers:updateModel',
    async (_evt, args: { id: string; model: string }) =>
      updateProviderModel(args.id, args.model)
  )
  ipcMain.handle('providers:remove', async (_evt, id: string) => removeProvider(id))
  ipcMain.handle('providers:test', async (_evt, baseURL: string) => testProvider(baseURL))
  ipcMain.handle('providers:getDefault', async () => getDefaultProvider())
  ipcMain.handle('providers:setDefault', async (_evt, id: string | null) =>
    setDefaultProvider(id)
  )

  // -------- Remote server connection -----------------------------------
  // Renderer reads + writes the persisted remote URL + session token.
  // Token lives in OS keychain via safeStorage; URL is plaintext (not a
  // secret) at ~/.quill/remote.json. Login itself happens in the
  // renderer (POST /api/auth/login) — main just persists the token after.
  ipcMain.handle('remote:getUrl', async () => getRemoteUrl())
  ipcMain.handle('remote:setUrl', async (_evt, url: string | null) =>
    setRemoteUrl(url)
  )
  ipcMain.handle('remote:getToken', async () => getRemoteToken())
  ipcMain.handle('remote:setToken', async (_evt, token: string | null) =>
    setRemoteToken(token)
  )
  ipcMain.handle('remote:clear', async () => clearRemote())

  // -------- Folder-workspace cloud sync ---------------------------------
  // Engine lives in ./sync (electron-free); these handlers only add the
  // saved server credentials. A bound folder without usable credentials
  // reads as offline so the UI can point at Settings → 远程.
  const syncCfg = async (): Promise<RemoteConfig | null> => {
    const [url, token] = await Promise.all([getRemoteUrl(), getRemoteToken()])
    return url && token ? { serverUrl: url, token } : null
  }
  const NO_SERVER = '未配置远程服务器'

  ipcMain.handle('sync:status', async (_evt, root: string) => {
    const cfg = await syncCfg()
    if (cfg) return checkStatus(root, cfg)
    const bound = await readSyncFile(root)
    if (!bound) return { state: 'disabled' }
    return {
      state: 'offline',
      binding: {
        spaceId: bound.spaceId,
        serverUrl: bound.serverUrl,
        remotePath: bound.remotePath
      },
      error: NO_SERVER
    }
  })

  const requireCfg = async (): Promise<RemoteConfig> => {
    const cfg = await syncCfg()
    if (!cfg) throw new Error(NO_SERVER)
    return cfg
  }

  ipcMain.handle(
    'sync:enable',
    async (_evt, args: { root: string; name: string; remotePath: string }) =>
      enableSync(args.root, await requireCfg(), {
        name: args.name,
        remotePath: args.remotePath
      })
  )
  ipcMain.handle(
    'sync:bind',
    async (_evt, args: { root: string; space: import('@quill/shared-types').Workspace }) =>
      bindSpace(args.root, await requireCfg(), args.space)
  )
  ipcMain.handle('sync:push', async (_evt, root: string) =>
    pushAll(root, await requireCfg())
  )
  ipcMain.handle('sync:pull', async (_evt, root: string) =>
    pullAll(root, await requireCfg())
  )
  ipcMain.handle(
    'sync:resolve',
    async (_evt, args: { root: string; path: string; keep: 'local' | 'remote' }) =>
      resolveConflict(args.root, await requireCfg(), args.path, args.keep)
  )
  ipcMain.handle(
    'sync:disable',
    async (_evt, args: { root: string; removeSpace: boolean }) => {
      // Unbinding locally must work even without server credentials;
      // only dropping the registry entry needs them.
      const cfg = args.removeSpace
        ? await requireCfg()
        : ((await syncCfg()) ?? { serverUrl: '', token: '' })
      return disableSync(args.root, cfg, { removeSpace: args.removeSpace })
    }
  )
  ipcMain.handle('sync:spaces', async () => listSpaces(await requireCfg()))
  ipcMain.handle('sync:removeSpace', async (_evt, id: string) =>
    removeSpace(await requireCfg(), id)
  )

  // -------- Agent runtime ----------------------------------------------
  // Renderer fires `agent:run` with a generated runId + args; main streams
  // events back via `agent:event` on the *sender's* webContents (so other
  // windows don't see runs they didn't start).
  ipcMain.handle(
    'agent:run',
    async (evt, args: { runId: string } & AgentRunArgs) => {
      const { runId, ...runArgs } = args
      const sender = evt.sender
      // Belt-and-braces: any sync throw inside `runAgent` / `sender.send`
      // (e.g. webContents racing between `isDestroyed()` and `send`) would
      // otherwise leave the IPC reply hanging, which the renderer surfaces
      // as "Error invoking remote method 'agent:run': reply was never sent"
      // (see #87). Turning the throw into an `error` event keeps the run
      // observable in the UI and lets the handler resolve normally.
      try {
        await agent.runAgent(runId, runArgs, (event: AgentEvent) => {
          if (sender.isDestroyed()) return
          sender.send('agent:event', { runId, event })
        })
      } catch (err) {
        if (!sender.isDestroyed()) {
          sender.send('agent:event', {
            runId,
            event: {
              type: 'error',
              message: err instanceof Error ? err.message : String(err)
            }
          })
        }
      }
    }
  )
  ipcMain.handle('agent:cancel', async (_evt, runId: string) => agent.cancelRun(runId))
  ipcMain.handle(
    'agent:compress',
    async (evt, args: { runId: string } & CompressionRunArgs) => {
      const { runId, ...rest } = args
      const sender = evt.sender
      try {
        await agent.runCompression(runId, rest, (event: AgentEvent) => {
          if (sender.isDestroyed()) return
          sender.send('agent:event', { runId, event })
        })
      } catch (err) {
        if (!sender.isDestroyed()) {
          sender.send('agent:event', {
            runId,
            event: {
              type: 'compression-error',
              message: err instanceof Error ? err.message : String(err)
            }
          })
        }
      }
    }
  )

  // Conversation sessions — one scope holds many isolated sessions. The
  // store guarantees a non-empty index, so the renderer can always assume
  // an active session exists.
  ipcMain.handle('context:sessions', async (_evt, scope: Scope) =>
    contextStore.sessions(scope)
  )
  ipcMain.handle(
    'context:loadSession',
    async (_evt, args: { scope: Scope; sessionId: string }) =>
      contextStore.loadSession(args.scope, args.sessionId)
  )
  ipcMain.handle(
    'context:saveSession',
    async (
      _evt,
      args: {
        scope: Scope
        sessionId: string
        items: unknown[]
        title: string
        turnCount: number
      }
    ) =>
      contextStore.saveSession(args.scope, args.sessionId, args.items, {
        title: args.title,
        turnCount: args.turnCount
      })
  )
  ipcMain.handle('context:createSession', async (_evt, scope: Scope) =>
    contextStore.createSession(scope)
  )
  ipcMain.handle(
    'context:setActiveSession',
    async (_evt, args: { scope: Scope; sessionId: string }) =>
      contextStore.setActiveSession(args.scope, args.sessionId)
  )
  ipcMain.handle(
    'context:deleteSession',
    async (_evt, args: { scope: Scope; sessionId: string }) =>
      contextStore.deleteSession(args.scope, args.sessionId)
  )

  // -------- Themes ----------------------------------------------------
  // Custom themes live as JSON files under ~/.quill/themes/. main scans
  // the directory and ships raw JSON to renderer, which validates with
  // zod (see lib/themeSchema.ts) — keeping schema knowledge in renderer
  // means main doesn't need a zod dependency just to round-trip JSON.

  ipcMain.handle(
    'themes:list',
    async (): Promise<Array<{ filename: string; raw: unknown }>> => {
      const dir = await ensureThemesDir()
      const entries = await fs.readdir(dir, { withFileTypes: true })
      const out: Array<{ filename: string; raw: unknown }> = []
      for (const e of entries) {
        if (!e.isFile() || !e.name.toLowerCase().endsWith('.json')) continue
        try {
          const text = await fs.readFile(join(dir, e.name), 'utf-8')
          out.push({ filename: e.name, raw: JSON.parse(text) })
        } catch {
          // Skip unreadable / malformed files — the UI lists what loaded
          // and the user can fix the broken file directly via the
          // "open themes folder" button.
        }
      }
      return out
    }
  )

  ipcMain.handle('themes:importDialog', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Theme JSON', extensions: ['json'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const src = result.filePaths[0]
    const dir = await ensureThemesDir()
    const filename = src.split(/[/\\]/).pop() ?? 'imported.json'
    const dest = join(dir, filename)
    await fs.copyFile(src, dest)
    return filename
  })

  ipcMain.handle(
    'themes:exportDialog',
    async (
      _evt,
      args: { suggestedFilename: string; content: string }
    ): Promise<string | null> => {
      const result = await dialog.showSaveDialog({
        defaultPath: args.suggestedFilename,
        filters: [{ name: 'Theme JSON', extensions: ['json'] }]
      })
      if (result.canceled || !result.filePath) return null
      await fs.writeFile(result.filePath, args.content, 'utf-8')
      return result.filePath
    }
  )

  ipcMain.handle('themes:revealFolder', async (): Promise<string> => {
    const dir = await ensureThemesDir()
    await shell.openPath(dir)
    return dir
  })
  ipcMain.handle(
    'agent:approval-respond',
    async (
      _evt,
      args: { runId: string; toolCallId: string; response: ApprovalResponse }
    ) => agent.respondApproval(args.runId, args.toolCallId, args.response)
  )
  ipcMain.handle(
    'agent:plan-approval-respond',
    async (_evt, args: { runId: string; response: PlanApprovalResponse }) =>
      agent.respondPlanApproval(args.runId, args.response)
  )

  ipcMain.handle(
    'dialog:confirmOpenChoice',
    async (
      evt,
      args: { candidateName: string; currentName: string; dirty: boolean }
    ): Promise<'new' | 'current' | 'cancel'> => {
      const { candidateName, currentName, dirty } = args
      const senderWin = BrowserWindow.fromWebContents(evt.sender) ?? undefined
      const buttons = dirty
        ? ['新窗口', '替换（丢失未保存改动）', '取消']
        : ['新窗口', '在当前窗口打开', '取消']
      const detail = dirty
        ? `当前文件「${currentName}」有未保存的改动。\n选择"替换"会直接丢弃这些改动。`
        : `当前打开：${currentName}`
      const result = await dialog.showMessageBox(senderWin!, {
        type: dirty ? 'warning' : 'question',
        buttons,
        defaultId: 0,
        cancelId: 2,
        message: `在哪里打开 ${candidateName}？`,
        detail,
        noLink: true
      })
      if (result.response === 0) return 'new'
      if (result.response === 1) return 'current'
      return 'cancel'
    }
  )

  ipcMain.handle(
    'export:pdf',
    async (_evt, args: { html: string; defaultName: string }) => {
      const { html, defaultName } = args

      const saveResult = await dialog.showSaveDialog({
        defaultPath: defaultName,
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      })
      if (saveResult.canceled || !saveResult.filePath) return null

      const targetPath = saveResult.filePath
      const tmpHtml = join(tmpdir(), `quill-export-${randomUUID()}.html`)
      await fs.writeFile(tmpHtml, html, 'utf-8')

      const win = new BrowserWindow({
        show: false,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          javascript: false
        }
      })

      try {
        await win.loadFile(tmpHtml)
        // Give the layout engine a tick for fonts / late paints.
        await new Promise<void>((r) => setTimeout(r, 150))
        const pdf = await win.webContents.printToPDF({
          pageSize: 'A4',
          printBackground: true,
          margins: { marginType: 'default' }
        })
        await fs.writeFile(targetPath, pdf)
        return targetPath
      } finally {
        win.destroy()
        fs.unlink(tmpHtml).catch(() => {})
      }
    }
  )
}
