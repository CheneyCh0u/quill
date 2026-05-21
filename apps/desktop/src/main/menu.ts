import { app, BrowserWindow, Menu, MenuItemConstructorOptions } from 'electron'
import { openSettingsWindow } from './windows'

type MenuCommand =
  | 'new-file'
  | 'open-file'
  | 'open-folder'
  | 'save'
  | 'close-folder'
  | 'export-pdf'

function send(cmd: MenuCommand): void {
  BrowserWindow.getFocusedWindow()?.webContents.send('quill:menu', cmd)
}

export function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              {
                label: 'Settings…',
                accelerator: 'Cmd+,',
                click: () => openSettingsWindow()
              },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          }
        ] as MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New File',
          accelerator: 'CmdOrCtrl+N',
          click: () => send('new-file')
        },
        { type: 'separator' },
        {
          label: 'Open File…',
          accelerator: 'CmdOrCtrl+O',
          click: () => send('open-file')
        },
        {
          label: 'Open Folder…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => send('open-folder')
        },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => send('save')
        },
        { type: 'separator' },
        {
          label: 'Export',
          submenu: [
            {
              label: 'PDF…',
              accelerator: 'CmdOrCtrl+Shift+E',
              click: () => send('export-pdf')
            }
          ]
        },
        { type: 'separator' },
        {
          label: 'Close Folder',
          accelerator: 'CmdOrCtrl+Shift+W',
          click: () => send('close-folder')
        },
        ...(!isMac
          ? ([
              { type: 'separator' },
              {
                label: 'Settings…',
                accelerator: 'Ctrl+,',
                click: () => openSettingsWindow()
              }
            ] as MenuItemConstructorOptions[])
          : []),
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Developer Tools',
          accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
          role: 'toggleDevTools'
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        {
          // Free Cmd+R for in-editor "Find & Replace". Reload moves to Cmd+Alt+R.
          label: 'Reload',
          accelerator: 'CmdOrCtrl+Alt+R',
          role: 'reload'
        }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
