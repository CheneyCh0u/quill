import { app, ipcMain, dialog, shell, BrowserWindow } from 'electron'
import { promises as fs } from 'node:fs'
import { extname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createWindow, openSettingsWindow, type InitialAction } from './windows'

export type FileNode = {
  name: string
  path: string
  isDirectory: boolean
  isMarkdown: boolean
  children?: FileNode[]
}

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

const MD_EXT = new Set(['.md', '.markdown', '.mdown', '.mkd'])

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
        children: await scanDir(childPath)
      })
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase()
      nodes.push({
        name: entry.name,
        path: childPath,
        isDirectory: false,
        isMarkdown: MD_EXT.has(ext)
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
        { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd'] }
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
          { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd'] }
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
