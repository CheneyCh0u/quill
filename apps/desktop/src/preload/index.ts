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
    }): Promise<void> => ipcRenderer.invoke('app:openInNewWindow', args)
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
