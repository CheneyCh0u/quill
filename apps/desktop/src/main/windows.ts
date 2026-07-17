import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'

const isDev = !!process.env.ELECTRON_RENDERER_URL

export type InitialAction =
  | { type: 'open-file'; path: string }
  | { type: 'open-folder'; path: string }
  | { type: 'new-file' }

export const windows = new Set<BrowserWindow>()
const pendingActions = new WeakMap<BrowserWindow, InitialAction[]>()

// Singleton settings window — focus existing instead of creating duplicate.
let settingsWindow: BrowserWindow | null = null

function flushPendingActions(win: BrowserWindow): void {
  const actions = pendingActions.get(win)
  if (!actions || actions.length === 0) return
  for (const a of actions) {
    if (a.type === 'open-file') win.webContents.send('quill:open-file', a.path)
    else if (a.type === 'open-folder') win.webContents.send('quill:open-folder', a.path)
    else if (a.type === 'new-file') win.webContents.send('quill:menu', 'new-file')
  }
  pendingActions.delete(win)
}

export function createWindow(opts: { initial?: InitialAction } = {}): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Lets the renderer know an initial action (file association, menu
      // "new window with file") is on its way, so session restore stays
      // out of that window instead of racing the queued open.
      additionalArguments: opts.initial ? ['--quill-has-initial'] : []
    }
  })

  windows.add(win)
  if (opts.initial) {
    pendingActions.set(win, [opts.initial])
  }

  win.on('ready-to-show', () => win.show())
  win.on('closed', () => {
    windows.delete(win)
    pendingActions.delete(win)
  })

  win.webContents.on('did-finish-load', () => flushPendingActions(win))

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

export function openSettingsWindow(): BrowserWindow {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus()
    return settingsWindow
  }

  const win = new BrowserWindow({
    width: 720,
    height: 540,
    resizable: false,
    minimizable: false,
    fullscreenable: false,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  settingsWindow = win
  windows.add(win)

  win.on('ready-to-show', () => win.show())
  win.on('closed', () => {
    windows.delete(win)
    settingsWindow = null
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(`${process.env.ELECTRON_RENDERER_URL}?settings=1`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { settings: '1' }
    })
  }

  return win
}
